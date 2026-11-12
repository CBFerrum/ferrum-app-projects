//! Project templates (PJ-01): a project saved as a template keeps its task tree, dependencies,
//! estimates and team, each task's dates as days from the project's start and who does it as a role
//! on the team; a project made from one gets the tree back, its dates shifted from its own start
//! (on the working days of a business calendar when one is named) and its tasks given to its team's
//! people of each role.
//!
//! Tasks are records of their own, not lines, so the platform's `copy_lines` cannot copy a tree; this
//! is the small code a record-tree template in the platform would replace.

use chrono::{Duration, NaiveDate};
use ferrum_domain::flow::created;
use ferrum_domain::util::{elevated, id, rows, s};
use ferrum_kernel::value::parse_date;
use ferrum_kernel::{Action, Calendar, Doc, Error, HookCtx, Result};
use serde_json::{Value, json};
use std::collections::HashMap;
use uuid::Uuid;

/// What a copy carries of the project itself (fields the workspace's schema has).
const PROJECT_FIELDS: &[&str] = &[
    "company",
    "customer",
    "proj_priority",
    "proj_project_manager",
    "proj_project_type",
    "proj_task_workflow",
    "proj_private",
    "proj_billing_method",
    "proj_contract_value",
    "proj_billing_item",
    "proj_cost_center",
    "budget",
    "proj_estimated_cost",
    "proj_estimated_hours",
    "proj_percent_complete_method",
    "notes",
];

/// What a copy carries of each task.
const TASK_FIELDS: &[&str] = &["subject", "priority", "is_milestone", "expected_hours", "description", "billing_percent"];

/// Working days of a business calendar: not a weekend or holiday, unless a dated exception opens it;
/// a date closed all day by an exception is not one (as the platform's clock counts business days).
fn works(cal: Option<&Calendar>, d: NaiveDate) -> bool {
    let Some(cal) = cal else { return true };
    match cal.exceptions.get(&d) {
        Some(x) if x.open => true,
        Some(x) if x.hours.is_empty() => false,
        _ => {
            let name = d.format("%a").to_string().to_lowercase();
            !cal.weekends.contains(&name) && !cal.holidays.contains(&d)
        }
    }
}

fn next_working(cal: Option<&Calendar>, mut d: NaiveDate) -> NaiveDate {
    // A calendar needs a business day a week, so this ends; the bound only guards a broken one.
    for _ in 0..550 {
        if works(cal, d) {
            break;
        }
        d += Duration::days(1);
    }
    d
}

/// `days` days from `start` (working days on `cal`, counted from the first working day on or after
/// `start`); days before the start are calendar days back.
pub fn shift(cal: Option<&Calendar>, start: NaiveDate, days: i64) -> NaiveDate {
    if cal.is_none() || days < 0 {
        return start + Duration::days(days);
    }
    let mut d = next_working(cal, start);
    for _ in 0..days {
        d = next_working(cal, d + Duration::days(1));
    }
    d
}

/// `days` working days before `end` (calendar days without a calendar).
pub fn back(cal: Option<&Calendar>, end: NaiveDate, days: i64) -> NaiveDate {
    if cal.is_none() || days <= 0 {
        return end - Duration::days(days.max(0));
    }
    let mut d = end;
    for _ in 0..days {
        d -= Duration::days(1);
        for _ in 0..550 {
            if works(cal, d) {
                break;
            }
            d -= Duration::days(1);
        }
    }
    d
}

/// The days from `start` to `date`, as [`shift`] counts them (a day off counts as the next working one).
pub fn offset(cal: Option<&Calendar>, start: NaiveDate, date: NaiveDate) -> i64 {
    if cal.is_none() || date < start {
        return (date - start).num_days();
    }
    let (mut d, mut n) = (next_working(cal, start), 0);
    while d < date {
        d = next_working(cal, d + Duration::days(1));
        n += 1;
    }
    n
}

fn param<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str).map(str::trim).filter(|v| !v.is_empty())
}

fn date(doc: &Doc, field: &str) -> Option<NaiveDate> {
    s(doc, field).and_then(|v| parse_date(v).ok())
}

/// `save_as_template` and `create_from_template` on a project.
pub(crate) async fn copy(hc: &mut HookCtx<'_>, source: &Doc, to_template: bool, params: &Value) -> Result<Value> {
    hc.ctx.require("Project", Action::Create)?;
    hc.ctx.require("Task", Action::Create)?;
    let pid = id(source, "id").ok_or_else(|| Error::internal("project without id"))?;
    let calendar = match param(params, "calendar") {
        Some(name) => Some(
            ferrum_kernel::load_calendar(hc.tx, hc.ctx.tenant, name)
                .await?
                .ok_or_else(|| Error::field("calendar", format!("there is no business calendar named {name}")))?,
        ),
        None => None,
    };
    let cal = calendar.as_ref();
    let actor = elevated(hc.ctx);

    // The tasks, parents before their sub-tasks.
    let order: Vec<Uuid> = sqlx::query_scalar(
        "with recursive tree(id, depth) as ( \
           select id, 0 from e_task where tenant_id = $1 and project = $2 and parent_task is null \
           union all select t.id, r.depth + 1 from e_task t join tree r on t.parent_task = r.id where t.tenant_id = $1 and r.depth < 50) \
         select id from tree order by depth, id limit 2000",
    )
    .bind(hc.ctx.tenant)
    .bind(pid)
    .fetch_all(&mut **hc.tx)
    .await?;
    let mut tasks = Vec::with_capacity(order.len());
    for t in &order {
        tasks.push(hc.kernel.get_tx(&actor, hc.tx, "Task", *t, false).await?);
    }

    // The project.
    let mut project = Doc::new();
    for f in PROJECT_FIELDS {
        if let Some(v) = source.get(*f).filter(|v| !v.is_null()) {
            project.insert(f.to_string(), v.clone());
        }
    }
    let team: Vec<Value> = rows(source, "proj_members")
        .into_iter()
        .map(|mut r| {
            r.remove("id");
            Value::Object(r)
        })
        .collect();
    project.insert("proj_members".into(), Value::Array(team));
    project.insert("proj_is_template".into(), json!(to_template));
    let start = if to_template {
        project.insert("project_name".into(), json!(param(params, "template_name").ok_or_else(|| Error::field("template_name", "is required"))?));
        // Days count from the project's start, else its first task's.
        let first = tasks.iter().flat_map(|t| [date(t, "exp_start_date"), date(t, "exp_end_date")]).flatten().min();
        let start = date(source, "start_date").or(first).unwrap_or_else(|| hc.ctx.today());
        project.insert("start_date".into(), json!(start.to_string()));
        start
    } else {
        project.insert("project_name".into(), json!(param(params, "project_name").ok_or_else(|| Error::field("project_name", "is required"))?));
        let start = param(params, "start_date").and_then(|d| parse_date(d).ok()).ok_or_else(|| Error::field("start_date", "is required"))?;
        project.insert("start_date".into(), json!(start.to_string()));
        if let Some(customer) = param(params, "customer") {
            project.insert("customer".into(), json!(customer));
        }
        start
    };
    let made = hc.kernel.insert_tx(&actor, hc.tx, "Project", project).await?;
    let new_project = id(&made, "id").ok_or_else(|| Error::internal("a project came back without an id"))?;

    // Who holds which role on the team (a template's people, by role, for the project made from it).
    let roles: Vec<(String, String)> =
        rows(source, "proj_members").iter().filter_map(|m| Some((s(m, "person")?.trim().to_lowercase(), s(m, "project_role")?.to_string()))).collect();

    // The tasks, then what they wait for once every task has its copy.
    let mut copies: HashMap<Uuid, Uuid> = HashMap::new();
    let mut last_end: Option<NaiveDate> = None;
    for t in &tasks {
        let Some(old) = id(t, "id") else { continue };
        let mut task = Doc::new();
        for f in TASK_FIELDS {
            if let Some(v) = t.get(*f).filter(|v| !v.is_null()) {
                task.insert(f.to_string(), v.clone());
            }
        }
        task.insert("project".into(), json!(new_project.to_string()));
        if let Some(parent) = id(t, "parent_task").and_then(|p| copies.get(&p)) {
            task.insert("parent_task".into(), json!(parent.to_string()));
        }
        if to_template {
            for (from, to) in [("exp_start_date", "start_offset"), ("exp_end_date", "end_offset")] {
                if let Some(d) = date(t, from) {
                    task.insert(to.into(), json!(offset(cal, start, d)));
                }
            }
            let first = rows(t, "assigned_to").iter().find_map(|a| s(a, "user").map(|u| u.trim().to_lowercase()));
            if let Some(role) = first.and_then(|u| roles.iter().find(|(p, _)| *p == u)).map(|(_, r)| r.clone()) {
                task.insert("assignee_role".into(), json!(role));
            }
        } else {
            for (from, to) in [("start_offset", "exp_start_date"), ("end_offset", "exp_end_date")] {
                if let Some(days) = t.get(from).and_then(Value::as_i64) {
                    let d = shift(cal, start, days);
                    last_end = last_end.max(Some(d));
                    task.insert(to.into(), json!(d.to_string()));
                }
            }
            if let Some(role) = s(t, "assignee_role") {
                let people: Vec<Value> = roles.iter().filter(|(_, r)| r == role).map(|(p, _)| json!({"user": p})).collect();
                task.insert("assigned_to".into(), Value::Array(people));
            }
        }
        let copy = hc.kernel.insert_tx(&actor, hc.tx, "Task", task).await?;
        copies.insert(old, id(&copy, "id").ok_or_else(|| Error::internal("a task came back without an id"))?);
    }
    for t in &tasks {
        let deps: Vec<Value> = rows(t, "depends_on")
            .into_iter()
            .filter_map(|mut r| {
                let to = copies.get(&id(&r, "task")?)?;
                r.remove("id");
                r.remove("subject");
                r.insert("task".into(), json!(to.to_string()));
                Some(Value::Object(r))
            })
            .collect();
        if let (false, Some(copy)) = (deps.is_empty(), id(t, "id").and_then(|o| copies.get(&o))) {
            hc.kernel.update_tx(&actor, hc.tx, "Task", *copy, Doc::from_iter([("depends_on".to_string(), Value::Array(deps))]), None).await?;
        }
    }
    if let Some(end) = last_end.filter(|_| !to_template) {
        hc.kernel.update_tx(&actor, hc.tx, "Project", new_project, Doc::from_iter([("end_date".to_string(), json!(end.to_string()))]), None).await?;
    }
    let mut out = created("Project", &made);
    out["tasks"] = json!(copies.len());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    #[test]
    fn days_from_the_start_on_working_days() {
        let office = Calendar {
            name: "office".into(),
            zone: "UTC".into(),
            weekends: vec!["sat".into(), "sun".into()],
            holidays: [d("2026-11-17")].into_iter().collect(),
            revision: 1,
            hours: None,
            exceptions: Default::default(),
        };
        let cal = Some(&office);
        // From Friday 13 November: Monday 16 is one working day in, Tuesday 17 a holiday.
        assert_eq!(shift(cal, d("2026-11-13"), 0), d("2026-11-13"));
        assert_eq!(shift(cal, d("2026-11-13"), 1), d("2026-11-16"));
        assert_eq!(shift(cal, d("2026-11-13"), 2), d("2026-11-18"), "the holiday is skipped");
        assert_eq!(shift(cal, d("2026-11-14"), 0), d("2026-11-16"), "a start on a day off moves to the next working day");
        assert_eq!(shift(None, d("2026-11-13"), 3), d("2026-11-16"), "calendar days without a calendar");
        assert_eq!(shift(cal, d("2026-11-13"), -2), d("2026-11-11"), "before the start: calendar days back");
        for days in 0..10 {
            assert_eq!(offset(cal, d("2026-11-13"), shift(cal, d("2026-11-13"), days)), days, "offset undoes shift");
        }
        assert_eq!(offset(None, d("2026-11-13"), d("2026-11-10")), -3);
    }
}
