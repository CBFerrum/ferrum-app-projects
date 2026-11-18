//! Planning around tasks: risks, change requests, allocations, and tasks that repeat.
//!
//! A change request is decided by someone other than whoever raised it, and once approved moves its
//! project's plan by its effects, the plan as it was first kept as the project's baseline. A repeating task makes its
//! next occurrence when it falls due: the source task's lock, a re-check under it and the unique key on
//! `repeated_from` keep replicas running at once, or a run repeated, from making it twice.

use crate::project::try_get;
use async_trait::async_trait;
use chrono::{Datelike, Months, NaiveDate, Utc};
use ferrum_domain::flow::created;
use ferrum_domain::util::{d, elevated, id, money, rows, s, sys};
use ferrum_kernel::value::parse_date;
use ferrum_kernel::{Ctx, Doc, DocHook, Error, HookCtx, Kernel, Result};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use uuid::Uuid;

/// How bad a level is, for working out a risk's exposure.
fn weight(level: Option<&str>) -> i64 {
    match level {
        Some("High") => 3,
        Some("Medium") => 2,
        _ => 1,
    }
}

pub fn exposure(probability: Option<&str>, impact: Option<&str>) -> i64 {
    weight(probability) * weight(impact)
}

pub struct RiskHook;

#[async_trait]
impl DocHook for RiskHook {
    async fn before_validate(&self, _hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        let e = exposure(s(doc, "probability"), s(doc, "impact"));
        doc.insert("exposure".into(), json!(e));
        Ok(())
    }
}

pub struct ChangeRequestHook;

#[async_trait]
impl DocHook for ChangeRequestHook {
    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, params: &Value) -> Result<Option<Value>> {
        let decision = match name {
            "approve" => "Approved",
            "reject" => "Rejected",
            _ => return Ok(None),
        };
        if s(doc, "decision").unwrap_or("Pending") != "Pending" {
            return Err(Error::invalid("this change request has been decided"));
        }
        // Maker and checker: not even an administrator decides what they raised.
        if doc.get("created_by").and_then(Value::as_str) == Some(hc.ctx.user.to_string().as_str()) {
            return Err(Error::Forbidden("someone else has to decide a change request you raised".into()));
        }
        let mut v = Doc::new();
        v.insert("decision".into(), json!(decision));
        v.insert("decided_by".into(), json!(hc.ctx.email));
        v.insert("decided_at".into(), json!(Utc::now().to_rfc3339()));
        v.insert("decision_note".into(), params.get("note").cloned().unwrap_or(Value::Null));
        let cr = id(doc, "id").unwrap_or_default();
        hc.kernel.set_values_tx(&sys(hc.ctx), hc.tx, "ChangeRequest", cr, v).await?;
        if decision == "Approved" {
            apply(hc, doc).await?;
        }
        Ok(Some(json!({"decision": decision})))
    }
}

/// What an approved change does to its project (FEO-029): the expected end date moves by its days,
/// the estimated hours by its hours, the estimated cost and a budget that is set by its cost, and a
/// fixed price's contract value by its price. Before the first approved change the plan as it was
/// is kept as the project's baseline. The project's own rules still hold: a change that would make
/// it end before it starts, or cost less than nothing, is not approved.
async fn apply(hc: &mut HookCtx<'_>, cr: &Doc) -> Result<()> {
    let project = id(cr, "project").ok_or_else(|| Error::invalid("the change request has no project"))?;
    let sctx = sys(hc.ctx);
    let p = hc.kernel.get_tx(&sctx, hc.tx, "Project", project, true).await?;
    let mut v = Doc::new();
    if s(&p, "proj_baselined_on").is_none() {
        // The plan as it was, task by task, named after the change; a name a person already used gets the change's id.
        let label: String = [s(cr, "number"), s(cr, "title")].into_iter().flatten().collect::<Vec<_>>().join(" ").chars().take(140).collect();
        let taken: bool = sqlx::query_scalar("select exists (select 1 from e_project_baseline where tenant_id = $1 and project = $2 and baseline_name = $3)")
            .bind(hc.ctx.tenant)
            .bind(project)
            .bind(&label)
            .fetch_one(&mut **hc.tx)
            .await?;
        let label = if taken {
            let id = id(cr, "id").unwrap_or_default().simple().to_string();
            format!("{} {}", label.chars().take(131).collect::<String>(), &id[..8])
        } else {
            label
        };
        take_baseline(hc, &p, &label).await?;
        for (baseline, from) in [
            ("proj_baseline_end_date", "end_date"),
            ("proj_baseline_hours", "proj_estimated_hours"),
            ("proj_baseline_cost", "proj_estimated_cost"),
            ("proj_baseline_budget", "budget"),
            ("proj_baseline_value", "proj_contract_value"),
        ] {
            v.insert(baseline.into(), p.get(from).cloned().unwrap_or(Value::Null));
        }
        v.insert("proj_baselined_on".into(), json!(hc.ctx.today().to_string()));
    }
    let days = cr.get("days_impact").and_then(Value::as_i64).unwrap_or(0);
    if let Some(end) = s(&p, "end_date").and_then(|e| parse_date(e).ok())
        && days != 0
    {
        v.insert("end_date".into(), json!((end + chrono::Duration::days(days)).to_string()));
    }
    let moved = |field: &str, by: Decimal| money(d(&p, field) + by);
    let (hours, cost, price) = (d(cr, "hours_impact"), d(cr, "cost_impact"), d(cr, "price_impact"));
    if !hours.is_zero() {
        v.insert("proj_estimated_hours".into(), moved("proj_estimated_hours", hours));
    }
    if !cost.is_zero() {
        v.insert("proj_estimated_cost".into(), moved("proj_estimated_cost", cost));
        if p.get("budget").is_some_and(|b| !b.is_null()) {
            v.insert("budget".into(), moved("budget", cost));
        }
    }
    if !price.is_zero() {
        if s(&p, "proj_billing_method") != Some("Fixed Price") {
            return Err(Error::field("price_impact", "changes a contract value, which only a fixed price project has"));
        }
        v.insert("proj_contract_value".into(), moved("proj_contract_value", price));
    }
    let approved = p.get("proj_approved_changes").and_then(Value::as_i64).unwrap_or(0);
    v.insert("proj_approved_changes".into(), json!(approved + 1));
    hc.kernel.update_tx(&sctx, hc.tx, "Project", project, v, None).await?;
    Ok(())
}

/// A project's status update: its author is whoever posts it, it stays with its project, never on a template, and
/// the project's health is its latest update's after every save or delete.
pub struct UpdateHook;

#[async_trait]
impl DocHook for UpdateHook {
    async fn before_validate(&self, hc: &mut HookCtx<'_>, doc: &mut Doc) -> Result<()> {
        let new = match id(doc, "id") {
            Some(u) => try_get(hc.kernel, &sys(hc.ctx), hc.tx, "ProjectUpdate", u).await?.is_none(),
            None => true,
        };
        if new {
            doc.insert("author".into(), json!(hc.ctx.email));
        }
        Ok(())
    }

    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let project = id(doc, "project").ok_or_else(|| Error::field("project", "is required"))?;
        let p = try_get(hc.kernel, &sys(hc.ctx), hc.tx, "Project", project).await?.ok_or_else(|| Error::field("project", "does not exist"))?;
        if p.get("proj_is_template").and_then(Value::as_bool) == Some(true) {
            return Err(Error::field("project", "is a template: a template has no status updates"));
        }
        if let Some(u) = id(doc, "id")
            && let Some(old) = try_get(hc.kernel, &sys(hc.ctx), hc.tx, "ProjectUpdate", u).await?
            && id(&old, "project") != Some(project)
        {
            return Err(Error::field("project", "an update stays with the project it was written for"));
        }
        Ok(())
    }

    async fn after_save(&self, hc: &mut HookCtx<'_>, doc: &Doc, _old: Option<&Doc>) -> Result<()> {
        if let Some(project) = id(doc, "project") {
            refresh_health(hc.kernel, hc.ctx, hc.tx, project, None).await?;
        }
        Ok(())
    }

    async fn before_delete(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        if let Some(project) = id(doc, "project") {
            refresh_health(hc.kernel, hc.ctx, hc.tx, project, id(doc, "id")).await?;
        }
        Ok(())
    }
}

/// A project's health and its day: those of its latest status update (by day, then as posted), leaving out
/// `without` (one being deleted), or none. Worked out again under the project's row lock, so updates saved at
/// once queue and the last to commit reads the others.
async fn refresh_health(k: &Kernel, ctx: &Ctx, tx: &mut ferrum_kernel::Tx, project: Uuid, without: Option<Uuid>) -> Result<()> {
    let sctx = sys(ctx);
    k.get_tx(&sctx, tx, "Project", project, true).await?;
    let latest: Option<(Option<String>, Option<NaiveDate>)> = sqlx::query_as(
        "select health, on_date from e_project_update where tenant_id = $1 and project = $2 and ($3::uuid is null or id <> $3) \
         order by on_date desc, created_at desc, id desc limit 1",
    )
    .bind(ctx.tenant)
    .bind(project)
    .bind(without)
    .fetch_optional(&mut **tx)
    .await?;
    let (health, on) = latest.unwrap_or_default();
    let values = Doc::from_iter([
        ("proj_health".to_string(), health.map_or(Value::Null, Value::from)),
        ("proj_health_on".to_string(), on.map_or(Value::Null, |d| json!(d.to_string()))),
    ]);
    k.set_values_tx(&sctx, tx, "Project", project, values).await
}

/// The most tasks a baseline holds (a record's lines are capped above it).
const BASELINE_TASKS: usize = 5000;

/// A new baseline of `project`: its plan figures and each task that is not cancelled, with its dates and hours, as
/// they stand now. Taken under the project's row lock, which every task save's roll-up takes, so no task moves
/// between reading and writing; inserted with the engine's rights (nobody may make one by hand), named once in its
/// project (a unique key).
pub(crate) async fn take_baseline(hc: &mut HookCtx<'_>, project: &Doc, name: &str) -> Result<Value> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 140 {
        return Err(Error::field("name", "give the baseline a name of up to 140 characters"));
    }
    let pid = id(project, "id").ok_or_else(|| Error::internal("a project without an id"))?;
    crate::lock(hc.tx, "e_project", hc.ctx.tenant, &[pid]).await?;
    let rows: Vec<(Uuid, Option<String>, Option<NaiveDate>, Option<NaiveDate>, Option<Decimal>, bool, bool)> = sqlx::query_as(
        "select t.id, t.subject, t.exp_start_date, t.exp_end_date, t.expected_hours, coalesce(t.is_milestone, false), \
         exists (select 1 from e_task c where c.tenant_id = t.tenant_id and c.parent_task = t.id and c.status_category is distinct from 'Cancelled') \
         from e_task t where t.tenant_id = $1 and t.project = $2 and t.status_category is distinct from 'Cancelled' order by t.number, t.id limit $3",
    )
    .bind(hc.ctx.tenant)
    .bind(pid)
    .bind(BASELINE_TASKS as i64 + 1)
    .fetch_all(&mut **hc.tx)
    .await?;
    if rows.len() > BASELINE_TASKS {
        return Err(Error::invalid(format!("a baseline holds at most {BASELINE_TASKS} tasks")));
    }
    let date = |d: Option<NaiveDate>| d.map_or(Value::Null, |d| json!(d.to_string()));
    let tasks: Vec<Value> = rows
        .iter()
        .map(|(task, subject, start, end, hours, milestone, kids)| {
            json!({"task": task.to_string(), "subject": subject, "exp_start_date": date(*start), "exp_end_date": date(*end),
                   "expected_hours": hours.map_or(Value::Null, money), "is_milestone": milestone, "has_subtasks": kids})
        })
        .collect();
    let field = |f: &str| project.get(f).cloned().unwrap_or(Value::Null);
    let input = Doc::from_iter([
        ("baseline_name".to_string(), json!(name)),
        ("project".to_string(), json!(pid.to_string())),
        ("taken_on".to_string(), json!(hc.ctx.today().to_string())),
        ("taken_by".to_string(), json!(hc.ctx.email)),
        ("start_date".to_string(), field("start_date")),
        ("end_date".to_string(), field("end_date")),
        ("estimated_hours".to_string(), field("proj_estimated_hours")),
        ("estimated_cost".to_string(), field("proj_estimated_cost")),
        ("budget".to_string(), field("budget")),
        ("contract_value".to_string(), field("proj_contract_value")),
        ("tasks".to_string(), Value::Array(tasks)),
    ]);
    let made = hc.kernel.insert_tx(&elevated(hc.ctx), hc.tx, "ProjectBaseline", input).await?;
    let mut out = created("ProjectBaseline", &made);
    out["tasks"] = json!(rows.len());
    Ok(out)
}

/// The day after `from` that a repetition lands on. A month's end stays within its month.
pub fn next_day(from: NaiveDate, repeat: &str) -> Option<NaiveDate> {
    match repeat {
        "Daily" => from.succ_opt(),
        "Weekly" => from.checked_add_days(chrono::Days::new(7)),
        "Monthly" => from.checked_add_months(Months::new(1)),
        _ => None,
    }
}

/// Makes the next occurrence of repeating tasks that have fallen due. Returns how many it made.
pub async fn repeat_tasks(k: &Kernel, ctx: &Ctx, today: NaiveDate) -> Result<usize> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    // Only the latest of a chain carries it on.
    let due: Vec<Uuid> = sqlx::query_scalar(
        "select t.id from e_task t where t.tenant_id = $1 and t.repeat is not null and t.exp_end_date <= $2 and t.status_category is distinct from 'Cancelled' \
         and not exists (select 1 from e_task n where n.tenant_id = t.tenant_id and n.repeated_from = t.id) order by t.id limit 500",
    )
    .bind(ctx.tenant)
    .bind(today)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let mut made = 0;
    for task in due {
        // One task that cannot go on (a rule it no longer meets) does not stop the others.
        match repeat_task(k, ctx, task).await {
            Ok(true) => made += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!(%task, "a repeating task was not carried on: {e}"),
        }
    }
    Ok(made)
}

/// The next occurrence of `task`, over the same span of days; `false` when its run has ended.
async fn repeat_task(k: &Kernel, ctx: &Ctx, task: Uuid) -> Result<bool> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let doc = k.get_tx(ctx, &mut tx, "Task", task, true).await?;
    // Under the source's lock: another run that made its occurrence meanwhile has committed it.
    let made: bool = sqlx::query_scalar("select exists (select 1 from e_task where tenant_id = $1 and repeated_from = $2)")
        .bind(ctx.tenant)
        .bind(task)
        .fetch_one(&mut *tx)
        .await?;
    if made {
        return Ok(false);
    }
    let (Some(repeat), Some(end)) = (s(&doc, "repeat"), s(&doc, "exp_end_date").and_then(|d| parse_date(d).ok())) else { return Ok(false) };
    let Some(next_end) = next_day(end, repeat) else { return Ok(false) };
    if s(&doc, "repeat_until").and_then(|d| parse_date(d).ok()).is_some_and(|until| next_end > until) {
        return Ok(false);
    }
    let span = s(&doc, "exp_start_date").and_then(|d| parse_date(d).ok()).map(|start| end - start);
    let mut next = Doc::new();
    for field in ["subject", "project", "priority", "is_milestone", "expected_hours", "repeat", "repeat_until", "description"] {
        next.insert(field.into(), doc.get(field).cloned().unwrap_or(Value::Null));
    }
    next.insert("exp_end_date".into(), json!(next_end.to_string()));
    next.insert("exp_start_date".into(), span.map_or(Value::Null, |days| json!((next_end - days).to_string())));
    let people: Vec<Value> = rows(&doc, "assigned_to")
        .into_iter()
        .map(|mut r| {
            r.remove("id");
            Value::Object(r)
        })
        .collect();
    next.insert("assigned_to".into(), Value::Array(people));
    let made = k.insert_tx(ctx, &mut tx, "Task", next).await?;
    let new_id = id(&made, "id").ok_or_else(|| Error::internal("a task came back without an id"))?;
    // Read-only to people: the engine sets it, and it is what makes this happen once.
    k.set_values_tx(ctx, &mut tx, "Task", new_id, Doc::from_iter([("repeated_from".to_string(), json!(task.to_string()))])).await?;
    tx.commit().await?;
    Ok(true)
}

pub(crate) fn week_of(day: NaiveDate) -> NaiveDate {
    day - chrono::Duration::days(day.weekday().num_days_from_monday() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    #[test]
    fn exposure_is_probability_times_impact() {
        assert_eq!(exposure(Some("High"), Some("High")), 9);
        assert_eq!(exposure(Some("Low"), Some("High")), 3);
        assert_eq!(exposure(None, None), 1);
    }

    #[test]
    fn repetitions_land_where_they_should() {
        assert_eq!(next_day(d("2026-03-31"), "Daily"), Some(d("2026-04-01")));
        assert_eq!(next_day(d("2026-03-31"), "Weekly"), Some(d("2026-04-07")));
        assert_eq!(next_day(d("2026-01-31"), "Monthly"), Some(d("2026-02-28")), "a month's end stays in its month");
        assert_eq!(next_day(d("2026-03-31"), "Never"), None);
    }

    #[test]
    fn weeks_start_on_monday() {
        assert_eq!(week_of(d("2026-11-01")), d("2026-10-26"), "a Sunday");
        assert_eq!(week_of(d("2026-11-02")), d("2026-11-02"), "a Monday");
    }
}
