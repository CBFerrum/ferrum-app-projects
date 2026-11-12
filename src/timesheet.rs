//! Timesheets: derived spans, rates and amounts, per-user overlap checks, and the roll-ups into
//! tasks and projects when time is submitted or cancelled.

use crate::logic::{CANCELLED, CLOSED_PROJECT, Span, add_hours, first_overlap, hours_between, percent, timesheet_status};
use crate::project::{label, refresh_project, refresh_task, try_get};
use crate::{is_manager, unknown_users};
use async_trait::async_trait;
use chrono::{DateTime, Datelike, NaiveDate, SecondsFormat, Utc};
use ferrum_domain::util::{b, d, find, id, money, round, rows, s, set, sys};
use ferrum_kernel::value::parse_datetime;
use ferrum_kernel::{Ctx, Doc, DocHook, Error, FieldError, Filter, HookCtx, Kernel, Result, Tx};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

fn time(row: &Doc, field: &str) -> Option<DateTime<Utc>> {
    s(row, field).and_then(|v| parse_datetime(v).ok())
}

fn date(row: &Doc, field: &str) -> Option<NaiveDate> {
    s(row, field).and_then(|v| NaiveDate::parse_from_str(v.get(..10)?, "%Y-%m-%d").ok())
}

/// The workspace's Projects Settings (empty until first saved: each field then reads as its default).
pub(crate) async fn settings(k: &Kernel, ctx: &Ctx, tx: &mut Tx) -> Result<Doc> {
    if ctx.schema.entity("ProjectsSettings").is_none() {
        return Ok(Doc::new());
    }
    Ok(k.find_tx(&sys(ctx), tx, "ProjectsSettings", &[], None, 1).await?.into_iter().next().unwrap_or_default())
}

fn row_err(field: &str, message: impl Into<String>, row: usize) -> FieldError {
    FieldError::new(field, message).in_row("time_logs", row)
}

async fn cached(hc: &mut HookCtx<'_>, cache: &mut HashMap<Uuid, Option<Doc>>, entity: &str, record: Uuid) -> Result<Option<Doc>> {
    if let Some(v) = cache.get(&record) {
        return Ok(v.clone());
    }
    let v = try_get(hc.kernel, hc.ctx, hc.tx, entity, record).await?;
    cache.insert(record, v.clone());
    Ok(v)
}

pub struct TimesheetHook;

#[async_trait]
impl DocHook for TimesheetHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        derive(hc, doc).await
    }

    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        check(hc, doc).await
    }

    async fn before_submit(&self, _hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        if rows(doc, "time_logs").iter().any(|r| time(r, "timer_started").is_some()) {
            return Err(Error::invalid("a timer is running on this timesheet; stop it before submitting"));
        }
        Ok(())
    }

    async fn on_submit(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        roll_up(hc, doc).await
    }

    async fn before_cancel(&self, _hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let billed: Vec<String> = rows(doc, "time_logs").iter().enumerate().filter(|(_, r)| b(r, "billed")).map(|(i, _)| (i + 1).to_string()).collect();
        if !billed.is_empty() {
            return Err(Error::invalid(format!("time log(s) {} are billed; cancel their sales invoice first", billed.join(", "))));
        }
        Ok(())
    }

    async fn on_cancel(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        roll_up(hc, doc).await
    }

    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, params: &Value) -> Result<Option<Value>> {
        match name {
            "make_sales_invoice" => crate::billing::invoice_timesheet(hc, doc, params).await.map(Some),
            "start_timer" => timer(hc, doc, Some(params)).await.map(Some),
            "stop_timer" => timer(hc, doc, None).await.map(Some),
            _ => Ok(None),
        }
    }
}

/// Amounts round to the company currency's precision.
async fn precision(hc: &mut HookCtx<'_>, company: Option<Uuid>) -> Result<u32> {
    let Some(c) = company else { return Ok(2) };
    let currency = try_get(hc.kernel, hc.ctx, hc.tx, "Company", c).await?.and_then(|co| id(&co, "default_currency"));
    match currency {
        Some(cur) => Ok(ferrum_domain::util::currency(hc.kernel, hc.ctx, hc.tx, cur).await?.1),
        None => Ok(2),
    }
}

type RateKey = (Uuid, Option<Uuid>, NaiveDate);

/// `(billing, costing)` hourly rates of `user` for an activity on a project and day (PJ-46): the
/// most specific rate card that matches and is in force that day (one naming the project, then the
/// customer, the person's role on the project's team, the person, the activity; among equals the
/// latest start), each rate on its own; else the user's activity cost where it sets one; else the
/// activity type's default.
async fn rates_for(
    hc: &mut HookCtx<'_>,
    cache: &mut HashMap<RateKey, (Decimal, Decimal)>,
    user: &str,
    activity: Uuid,
    project: Option<&Doc>,
    day: NaiveDate,
) -> Result<(Decimal, Decimal)> {
    let key = (activity, project.and_then(|p| id(p, "id")), day);
    if let Some(r) = cache.get(&key) {
        return Ok(*r);
    }
    let Some(at) = try_get(hc.kernel, hc.ctx, hc.tx, "ActivityType", activity).await? else { return Ok((Decimal::ZERO, Decimal::ZERO)) };
    let cost = if user.is_empty() {
        vec![]
    } else {
        find(hc.kernel, hc.ctx, hc.tx, "ActivityCost", vec![Filter::eq("user", user), Filter::eq("activity_type", activity.to_string())], None, 1).await?
    };
    let pick = |f: &str| cost.first().map(|c| d(c, f)).filter(|v| *v > Decimal::ZERO).unwrap_or_else(|| d(&at, f));
    let cards: Vec<(Option<Decimal>, Option<Decimal>)> = if hc.ctx.schema.entity("RateCard").is_some() {
        let role = project.and_then(|p| rows(p, "proj_members").into_iter().find(|m| s(m, "person").is_some_and(|e| e.trim().eq_ignore_ascii_case(user))));
        sqlx::query_as(
            "select billing_rate, costing_rate from e_rate_card where tenant_id = $1 \
             and (project is null or project = $2) and (customer is null or customer = $3) and (project_role is null or project_role = $4) \
             and (\"user\" is null or lower(trim(\"user\")) = $5) and (activity_type is null or activity_type = $6) \
             and (valid_from is null or valid_from <= $7) and (valid_to is null or valid_to >= $7) \
             order by project is not null desc, customer is not null desc, project_role is not null desc, \"user\" is not null desc, \
             activity_type is not null desc, valid_from desc nulls last, id",
        )
        .bind(hc.ctx.tenant)
        .bind(key.1)
        .bind(project.and_then(|p| id(p, "customer")))
        .bind(role.as_ref().and_then(|m| s(m, "project_role")))
        .bind(user)
        .bind(activity)
        .bind(day)
        .fetch_all(&mut **hc.tx)
        .await?
    } else {
        vec![]
    };
    let r = (cards.iter().find_map(|c| c.0).unwrap_or_else(|| pick("billing_rate")), cards.iter().find_map(|c| c.1).unwrap_or_else(|| pick("costing_rate")));
    cache.insert(key, r);
    Ok(r)
}

/// Fills each log's project (from its task, else the timesheet's), span, rates and amounts, then
/// the totals. Only time on Time and Materials projects is billable.
async fn derive(hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
    let precision = precision(hc, id(doc, "company")).await?;
    let user = s(doc, "user").unwrap_or_default().to_lowercase();
    let old_rows: HashMap<String, Doc> = match id(doc, "id") {
        Some(tid) => try_get(hc.kernel, hc.ctx, hc.tx, "Timesheet", tid)
            .await?
            .map(|o| rows(&o, "time_logs"))
            .unwrap_or_default()
            .into_iter()
            .filter_map(|r| Some((s(&r, "id")?.to_string(), r)))
            .collect(),
        None => HashMap::new(),
    };
    let header_project = id(doc, "project");
    let mut projects = HashMap::new();
    let mut tasks = HashMap::new();
    let mut rates = HashMap::new();
    let mut logs = rows(doc, "time_logs");
    for r in logs.iter_mut() {
        if id(r, "project").is_none() {
            let from_task = match id(r, "task") {
                Some(t) => cached(hc, &mut tasks, "Task", t).await?.and_then(|t| id(&t, "project")),
                None => None,
            };
            if let Some(p) = from_task.or(header_project) {
                set(r, "project", p.to_string());
            }
        }
        // The hours follow the span; without an end time, the end follows the hours.
        let from = time(r, "from_time");
        let mut to = time(r, "to_time");
        if let (Some(f), None) = (from, to)
            && d(r, "hours") > Decimal::ZERO
        {
            to = add_hours(f, d(r, "hours"));
            if let Some(t) = to {
                set(r, "to_time", t.to_rfc3339_opts(SecondsFormat::Millis, true));
            }
        }
        if let Some(f) = from {
            set(r, "day", f.date_naive().to_string());
        }
        let hours = match (from, to) {
            (Some(f), Some(t)) => hours_between(f, t),
            _ => d(r, "hours"),
        };
        set(r, "hours", money(hours));
        let project = match id(r, "project") {
            Some(p) => cached(hc, &mut projects, "Project", p).await?,
            None => None,
        };
        let on = date(r, "day").unwrap_or_else(|| hc.ctx.today());
        let (default_billing, costing_rate) = match id(r, "activity_type") {
            Some(a) => rates_for(hc, &mut rates, &user, a, project.as_ref(), on).await?,
            None => (Decimal::ZERO, Decimal::ZERO),
        };
        let time_and_materials = project.is_some_and(|p| s(&p, "proj_billing_method") == Some("Time and Materials"));
        let billable = b(r, "is_billable") && time_and_materials;
        set(r, "is_billable", billable);
        if billable {
            // Billing hours follow the hours, and the rate follows the activity, until the user
            // changes them (the client-side rule of other ERPs, enforced on the server). Zero is
            // not a change: a page's preview fills both with 0 before the row has its activity
            // and times, and sends them back; billing none of the time is unticking Billable.
            let old = s(r, "id").and_then(|i| old_rows.get(i));
            let unset = |r: &Doc, f: &str| r.get(f).is_none_or(Value::is_null) || d(r, f).is_zero();
            let hours_followed = old.is_some_and(|o| r.get("billing_hours") == o.get("billing_hours") && d(o, "billing_hours") == d(o, "hours"));
            if unset(r, "billing_hours") || hours_followed {
                set(r, "billing_hours", money(hours));
            }
            let activity_changed = old.is_some_and(|o| id(o, "activity_type") != id(r, "activity_type") && r.get("billing_rate") == o.get("billing_rate"));
            if unset(r, "billing_rate") || activity_changed {
                set(r, "billing_rate", money(default_billing));
            }
        } else {
            set(r, "billing_hours", Value::Null);
            set(r, "billing_rate", Value::Null);
        }
        set(r, "billing_amount", money(round(d(r, "billing_hours") * d(r, "billing_rate"), precision)));
        set(r, "costing_rate", money(costing_rate));
        set(r, "costing_amount", money(round(hours * costing_rate, precision)));
    }
    // hours, billable hours, billed hours, billable amount, billed amount, cost
    let mut totals = [Decimal::ZERO; 6];
    for r in &logs {
        totals[0] += d(r, "hours");
        if b(r, "is_billable") {
            totals[1] += d(r, "billing_hours");
            totals[3] += d(r, "billing_amount");
        }
        if b(r, "billed") {
            totals[2] += d(r, "billing_hours");
            totals[4] += d(r, "billing_amount");
        }
        totals[5] += d(r, "costing_amount");
    }
    let names = ["total_hours", "total_billable_hours", "total_billed_hours", "total_billable_amount", "total_billed_amount", "total_costing_amount"];
    for (f, v) in names.into_iter().zip(totals) {
        set(doc, f, money(v));
    }
    set(doc, "per_billed", money(percent(totals[4], totals[3])));
    let day = |t: Option<NaiveDate>| t.map(|t| json!(t.to_string())).unwrap_or(Value::Null);
    set(doc, "start_date", day(logs.iter().filter_map(|r| date(r, "day")).min()));
    set(doc, "end_date", day(logs.iter().filter_map(|r| time(r, "to_time").map(|t| t.date_naive()).or_else(|| date(r, "day"))).max()));
    if d(doc, "docstatus").is_zero() {
        set(doc, "status", "Draft");
        let approvers = approvers(hc, &user, &logs, &mut projects).await?;
        set(doc, "approvers", json!(approvers));
        // The one project all its time is on, for the customer's portal people (a timesheet of several is nobody's but staff's).
        let mut on = logs.iter().map(|r| id(r, "project"));
        let single = on.next().flatten().filter(|p| on.all(|q| q == Some(*p)));
        let shared = match single {
            Some(p) => cached(hc, &mut projects, "Project", p).await?.is_some_and(|pr| b(&pr, "proj_shared")),
            None => false,
        };
        set(doc, "portal_project", json!(single));
        set(doc, "portal_shared", json!(shared));
    }
    set(doc, "time_logs", Value::Array(logs.into_iter().map(Value::Object).collect()));
    Ok(())
}

async fn check(hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
    let tid = id(doc, "id").ok_or_else(|| Error::internal("timesheet without id"))?;
    let tenant = hc.ctx.tenant;
    let user = s(doc, "user").unwrap_or_default().to_lowercase();
    if !is_manager(hc.ctx) && user != hc.ctx.email.to_lowercase() {
        return Err(Error::Forbidden("you can only record your own time".into()));
    }
    if !unknown_users(hc.tx, tenant, std::slice::from_ref(&user)).await?.is_empty() {
        return Err(Error::field("user", "no user has this email"));
    }
    let company = id(doc, "company");
    let mut errors = Vec::new();
    let mut spans: Vec<Span> = Vec::new();
    let mut at: Vec<usize> = Vec::new();
    let mut projects = HashMap::new();
    let mut tasks = HashMap::new();
    let week = date(doc, "week_start");
    for (i, r) in rows(doc, "time_logs").iter().enumerate() {
        // A span of clock time, or a day and its hours (or a timer running on it).
        let span = match (time(r, "from_time"), time(r, "to_time")) {
            (Some(from), Some(to)) if to > from => Some((from, to)),
            (Some(_), Some(_)) => {
                errors.push(row_err("to_time", "must be after the start time", i));
                continue;
            }
            (Some(_), None) => {
                errors.push(row_err("to_time", "set the end time or the hours", i));
                continue;
            }
            (None, _) if date(r, "day").is_none() => {
                errors.push(row_err("day", "set the day and the hours, or the start time", i));
                continue;
            }
            (None, _) if d(r, "hours") <= Decimal::ZERO && time(r, "timer_started").is_none() => {
                errors.push(row_err("hours", "set the hours", i));
                continue;
            }
            (None, _) => None,
        };
        if let (Some(start), Some(day)) = (week, date(r, "day"))
            && (day < start || (day - start).num_days() > 6)
        {
            errors.push(row_err("day", format!("{day} is outside the week of {start}"), i));
        }
        let project = id(r, "project");
        if let Some(t) = id(r, "task") {
            match cached(hc, &mut tasks, "Task", t).await? {
                None => errors.push(row_err("task", "does not exist", i)),
                Some(task) if id(&task, "project") != project => errors.push(row_err("task", format!("{} belongs to another project", label(&task)), i)),
                Some(task) if s(&task, "status_category") == Some(CANCELLED) => errors.push(row_err("task", format!("{} is cancelled", label(&task)), i)),
                _ => {}
            }
        }
        if let Some(p) = project {
            match cached(hc, &mut projects, "Project", p).await? {
                None => errors.push(row_err("project", "does not exist", i)),
                Some(pd) => {
                    if let Some(st) = s(&pd, "status").filter(|st| CLOSED_PROJECT.contains(st)) {
                        errors.push(row_err("project", format!("project {} is {}; no more time can be booked on it", label(&pd), st.to_lowercase()), i));
                    } else if b(&pd, "proj_is_template") {
                        errors.push(row_err("project", format!("{} is a template; time is booked on projects made from it", label(&pd)), i));
                    } else if id(&pd, "company") != company {
                        errors.push(row_err("project", "belongs to another company", i));
                    }
                }
            }
        }
        if let Some(span) = span {
            spans.push(span);
            at.push(i);
        }
    }
    if errors.is_empty()
        && let Some((a, z)) = first_overlap(&spans)
    {
        errors.push(row_err("from_time", format!("overlaps time log {}", at[a] + 1), at[z]));
    }
    if !errors.is_empty() {
        return Err(Error::Validation(errors));
    }
    // Against the user's submitted time. The lock makes one user's saves take turns, so two
    // timesheets submitted at the same moment cannot both pass this check.
    sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 0))").bind(format!("ferrum:timesheet:{tenant}:{user}")).execute(&mut **hc.tx).await?;
    let (froms, tos): (Vec<DateTime<Utc>>, Vec<DateTime<Utc>>) = spans.iter().copied().unzip();
    let clashes: Vec<(i64, Option<String>, DateTime<Utc>, DateTime<Utc>)> = sqlx::query_as(
        "select r.i, t.number, l.from_time, l.to_time \
         from unnest($3::timestamptz[], $4::timestamptz[]) with ordinality as r(f, e, i) \
         join e_timesheet t on t.tenant_id = $1 and t.\"user\" = $2 and t.docstatus = 1 and t.id <> $5 \
         join e_timesheet__time_logs l on l.tenant_id = t.tenant_id and l.parent_id = t.id and l.from_time < r.e and r.f < l.to_time \
         order by r.i, l.from_time limit 20",
    )
    .bind(tenant)
    .bind(&user)
    .bind(&froms)
    .bind(&tos)
    .bind(tid)
    .fetch_all(&mut **hc.tx)
    .await?;
    for (i, number, f, t) in clashes {
        let message =
            format!("overlaps time already submitted on {} ({} – {})", number.unwrap_or_default(), f.format("%Y-%m-%d %H:%M"), t.format("%Y-%m-%d %H:%M"));
        errors.push(row_err("from_time", message, at[(i - 1) as usize]));
    }
    if errors.is_empty() { Ok(()) } else { Err(Error::Validation(errors)) }
}

/// Submitting or cancelling time re-derives every task and project it touches.
async fn roll_up(hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
    let tid = id(doc, "id").ok_or_else(|| Error::internal("timesheet without id"))?;
    refresh_timesheet(hc.kernel, hc.ctx, hc.tx, tid).await?;
    let logs = rows(doc, "time_logs");
    let mut tasks: Vec<Uuid> = logs.iter().filter_map(|r| id(r, "task")).collect();
    let mut projects: Vec<Uuid> = logs.iter().filter_map(|r| id(r, "project")).collect();
    tasks.sort();
    tasks.dedup();
    projects.sort();
    projects.dedup();
    for t in tasks {
        refresh_task(hc.kernel, hc.ctx, hc.tx, t).await?;
    }
    for p in projects {
        refresh_project(hc.kernel, hc.ctx, hc.tx, p, None).await?;
    }
    Ok(())
}

/// Billing totals and status of a timesheet, from its logs.
pub(crate) async fn refresh_timesheet(k: &Kernel, ctx: &Ctx, tx: &mut Tx, timesheet: Uuid) -> Result<()> {
    let (docstatus, billed_hours, billable, billed): (i16, Decimal, Decimal, Decimal) = sqlx::query_as(
        "select t.docstatus, coalesce(sum(l.billing_hours) filter (where l.billed), 0), \
         coalesce(sum(l.billing_amount) filter (where l.is_billable), 0), coalesce(sum(l.billing_amount) filter (where l.billed), 0) \
         from e_timesheet t left join e_timesheet__time_logs l on l.tenant_id = t.tenant_id and l.parent_id = t.id \
         where t.tenant_id = $1 and t.id = $2 group by t.docstatus",
    )
    .bind(ctx.tenant)
    .bind(timesheet)
    .fetch_one(&mut **tx)
    .await?;
    let mut v = Doc::new();
    v.insert("total_billed_hours".into(), money(billed_hours));
    v.insert("total_billed_amount".into(), money(billed));
    v.insert("per_billed".into(), money(percent(billed, billable)));
    v.insert("status".into(), json!(timesheet_status(docstatus, billable, billed)));
    k.set_values_tx(&sys(ctx), tx, "Timesheet", timesheet, v).await
}

/// Rates are per user: the user must exist.
pub struct ActivityCostHook;

#[async_trait]
impl DocHook for ActivityCostHook {
    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        if let Some(u) = s(doc, "user")
            && !unknown_users(hc.tx, hc.ctx.tenant, &[u.to_string()]).await?.is_empty()
        {
            return Err(Error::field("user", "no user has this email"));
        }
        Ok(())
    }
}

/// Who approves a timesheet where the workspace asks for approval before it is submitted (Projects
/// Settings): each of its projects' managers (the project's manager, else its team's managers), or
/// the person's manager on their Person record. Lower-cased, each once.
async fn approvers(hc: &mut HookCtx<'_>, user: &str, logs: &[Doc], projects: &mut HashMap<Uuid, Option<Doc>>) -> Result<Vec<String>> {
    let settings = settings(hc.kernel, hc.ctx, hc.tx).await?;
    let mut out: Vec<String> = Vec::new();
    if s(&settings, "timesheet_approver") == Some("Person's Manager") {
        let manager: Option<Option<String>> = sqlx::query_scalar("select manager from e_project_person where tenant_id = $1 and lower(\"user\") = $2")
            .bind(hc.ctx.tenant)
            .bind(user)
            .fetch_optional(&mut **hc.tx)
            .await?;
        out.extend(manager.flatten());
    } else {
        for p in logs.iter().filter_map(|r| id(r, "project")) {
            let Some(project) = cached(hc, projects, "Project", p).await? else { continue };
            match s(&project, "proj_project_manager") {
                Some(pm) => out.push(pm.to_string()),
                // The team's managers, as the team's `manager` field names them.
                None => out.extend(rows(&project, "proj_members").iter().filter_map(|m| s(m, "manager").map(str::to_string))),
            }
        }
    }
    let mut out: Vec<String> = out.into_iter().map(|e| e.trim().to_lowercase()).filter(|e| !e.is_empty()).collect();
    out.retain(|e| e != user);
    out.sort();
    out.dedup();
    Ok(out)
}

/// `start_timer` (with its parameters) and `stop_timer` (without): a running timer's time since it
/// started goes into its line's hours; a new one runs on today's line for the project, task and
/// activity, made when there is none.
async fn timer(hc: &mut HookCtx<'_>, doc: &Doc, start: Option<&Value>) -> Result<Value> {
    let tid = id(doc, "id").ok_or_else(|| Error::internal("timesheet without id"))?;
    let now = Utc::now();
    let today = hc.ctx.today();
    let mut logs = rows(doc, "time_logs");
    let mut stopped = Decimal::ZERO;
    for r in logs.iter_mut() {
        if let Some(started) = time(r, "timer_started") {
            let add = hours_between(started, now).max(Decimal::ZERO);
            stopped += add;
            set(r, "hours", money(d(r, "hours") + add));
            set(r, "timer_started", Value::Null);
        }
    }
    if let Some(params) = start {
        if let Some(week) = date(doc, "week_start")
            && (today < week || (today - week).num_days() > 6)
        {
            return Err(Error::invalid(format!("today is outside this timesheet's week of {week}")));
        }
        let param = |k: &str| params.get(k).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string);
        let activity = param("activity_type").ok_or_else(|| Error::field("activity_type", "is required"))?;
        let (project, task) = (param("project"), param("task"));
        let same = |r: &Doc| {
            time(r, "from_time").is_none()
                && date(r, "day") == Some(today)
                && s(r, "activity_type") == Some(activity.as_str())
                && s(r, "project").map(str::to_string) == project
                && s(r, "task").map(str::to_string) == task
        };
        let started = json!(now.to_rfc3339_opts(SecondsFormat::Millis, true));
        match logs.iter_mut().find(|r| same(r)) {
            Some(r) => set(r, "timer_started", started),
            None => {
                let mut r = Doc::new();
                r.insert("activity_type".into(), json!(activity));
                r.insert("project".into(), json!(project));
                r.insert("task".into(), json!(task));
                r.insert("day".into(), json!(today.to_string()));
                r.insert("hours".into(), json!("0"));
                r.insert("timer_started".into(), started);
                r.insert("description".into(), json!(param("description")));
                logs.push(r);
            }
        }
    }
    let mut patch = Doc::new();
    patch.insert("time_logs".into(), Value::Array(logs.into_iter().map(Value::Object).collect()));
    hc.kernel.update_tx(&ferrum_domain::util::elevated(hc.ctx), hc.tx, "Timesheet", tid, patch, None).await?;
    Ok(json!({"running": start.is_some(), "hours_added": money(stopped)}))
}

/// The first day of the week holding `day`, for weeks starting on `starts_on` (1 Monday ... 7 Sunday).
pub(crate) fn week_start(day: NaiveDate, starts_on: u32) -> NaiveDate {
    let back = (day.weekday().number_from_monday() + 7 - starts_on.clamp(1, 7)) % 7;
    day - chrono::Duration::days(back.into())
}

/// Upkeep: from the reminder day of a week on (Projects Settings), each person with hours a week on
/// their Person record whose time that week (on timesheets not cancelled) is short of them is told,
/// once a week. The mark and the message are one transaction, and the mark is taken by an update
/// that only one run can make, so replicas running at once never tell anyone twice. Who has recorded
/// nothing at all is found here, by a query: an automation cannot ask for people with no record.
pub(crate) async fn remind_missing_time(k: &Kernel, tenant: Uuid) -> Result<usize> {
    let ctx = Ctx::system(tenant, k.registry.schema(tenant).await?);
    if ctx.schema.entity("ProjectPerson").is_none() {
        return Ok(0);
    }
    let mut tx = k.db.tenant_tx(tenant).await?;
    let settings = settings(k, &ctx, &mut tx).await?;
    let int = |f: &str, default: i64| settings.get(f).and_then(Value::as_i64).unwrap_or(default);
    let remind_on = int("reminder_weekday", 0);
    let today = ctx.today();
    let week = week_start(today, int("week_starts_on", 1) as u32);
    let due = (1..=7).contains(&remind_on)
        && (0..7).map(|i| week + chrono::Duration::days(i)).any(|d| d <= today && d.weekday().number_from_monday() as i64 == remind_on);
    if !due {
        return Ok(0);
    }
    let short: Vec<(Uuid, String, Decimal, Decimal)> = sqlx::query_as(
        "select p.id, lower(p.\"user\"), p.weekly_hours, coalesce((select sum(l.hours) from e_timesheet t \
           join e_timesheet__time_logs l on l.tenant_id = t.tenant_id and l.parent_id = t.id \
           where t.tenant_id = p.tenant_id and lower(t.\"user\") = lower(p.\"user\") and t.docstatus < 2 \
             and coalesce(l.day, (l.from_time at time zone 'UTC')::date) between $2 and $2 + 6), 0) \
         from e_project_person p join app_user u on u.tenant_id = p.tenant_id and lower(u.email) = lower(p.\"user\") and u.is_active \
         where p.tenant_id = $1 and p.weekly_hours > 0 and p.reminded_week is distinct from $2",
    )
    .bind(tenant)
    .bind(week)
    .fetch_all(&mut *tx)
    .await?;
    let mut told = 0;
    for (person, email, expected, hours) in short.into_iter().filter(|(_, _, expected, hours)| hours < expected) {
        let marked = sqlx::query("update e_project_person set reminded_week = $3 where tenant_id = $1 and id = $2 and reminded_week is distinct from $3")
            .bind(tenant)
            .bind(person)
            .bind(week)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if marked == 0 {
            continue;
        }
        let mut values = serde_json::Map::new();
        values.insert("week_start".into(), json!(week.to_string()));
        values.insert("hours".into(), json!(hours.normalize().to_string()));
        values.insert("expected".into(), json!(expected.normalize().to_string()));
        let m = ferrum_kernel::messages::Message {
            template: "projects.time_missing".into(),
            to: vec![ferrum_kernel::messages::Recipient::address(&email)],
            values,
            ..Default::default()
        };
        ferrum_kernel::messages::send(k, &mut tx, &ctx, &m).await?;
        told += 1;
    }
    tx.commit().await?;
    Ok(told)
}

#[cfg(test)]
mod tests {
    use super::week_start;
    use chrono::NaiveDate;

    #[test]
    fn weeks_start_where_the_workspace_says() {
        let d = |s: &str| s.parse::<NaiveDate>().unwrap();
        assert_eq!(week_start(d("2026-11-12"), 1), d("2026-11-09"), "a Thursday, weeks from Monday");
        assert_eq!(week_start(d("2026-11-12"), 7), d("2026-11-08"), "weeks from Sunday");
        assert_eq!(week_start(d("2026-11-08"), 7), d("2026-11-08"), "a Sunday starts its own");
        assert_eq!(week_start(d("2026-11-08"), 1), d("2026-11-02"), "a Sunday ends a Monday week");
        assert_eq!(week_start(d("2026-11-12"), 6), d("2026-11-07"), "weeks from Saturday");
    }
}
