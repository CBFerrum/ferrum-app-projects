//! Projects' endpoints for signed-in people (`/api/app/projects/…`): the open tasks assigned to the
//! caller, for Home's My work (Ferrum docs/plan/apps-ui.md §12.8); a project's tasks with the people
//! on each and what each waits for, for the board and the timeline; and the time logged on a task,
//! for its page.

use async_trait::async_trait;
use ferrum_domain::util::s;
use ferrum_kernel::{Ctx, Error, Filter, Kernel, ListQuery, Op, Result, Site, SiteRequest, SiteResponse};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use uuid::Uuid;

/// Status categories that are no longer anyone's work.
const DONE: &[&str] = crate::logic::CLOSED;

pub struct ProjectsSite;

#[async_trait]
impl Site for ProjectsSite {
    async fn handle(&self, k: &Kernel, req: SiteRequest) -> Result<SiteResponse> {
        let user = req.user.as_ref().ok_or_else(|| Error::Unauthorized("sign in first".into()))?;
        let out = match (req.method.as_str(), req.path.trim_matches('/')) {
            ("GET", "work") => work(k, user).await?,
            ("GET", "tasks") => tasks(k, user, &req.query).await?,
            ("GET", "time") => time(k, user, &req.query).await?,
            _ => return Err(Error::NotFound(format!("projects endpoint {} {}", req.method, req.path))),
        };
        let mut r = SiteResponse::json(200, &out);
        r.headers.push(("cache-control".into(), "no-store".into()));
        Ok(r)
    }
}

/// What the interface draws of a task. A list gives these; the people on a task and what it waits
/// for are child rows, which a list leaves out and only a single record carries.
const TASK_FIELDS: [&str; 16] = [
    "number",
    "subject",
    "project",
    "status",
    "task_status",
    "status_category",
    "priority",
    "exp_start_date",
    "exp_end_date",
    "expected_hours",
    "actual_hours",
    "progress",
    "is_milestone",
    "parent_task",
    "rank",
    "version",
];

/// The most tasks one request returns, the API's own limit for a list.
const TASK_LIMIT: u32 = 500;

/// `GET tasks?project=<id>`: the project's tasks, oldest first, as a list gives them (read with the
/// caller's own rights, so someone who may read only their own tasks gets only those) and, with
/// each, `assigned_to` and `depends_on`: one query each for all of them, not one record at a time.
/// `total` counts every task, so a screen can say when it shows the first of more.
async fn tasks(k: &Kernel, user: &Ctx, query: &Map<String, Value>) -> Result<Value> {
    let project =
        query.get("project").and_then(Value::as_str).and_then(|p| p.parse::<Uuid>().ok()).ok_or_else(|| Error::invalid("project: give the id of a project"))?;
    let q = ListQuery {
        filters: vec![Filter::eq("project", project.to_string())],
        fields: Some(TASK_FIELDS.iter().map(|f| f.to_string()).collect()),
        sort: Some("created_at asc".into()),
        limit: Some(TASK_LIMIT),
        with_count: true,
        ..Default::default()
    };
    let mut page = k.list(user, "Task", &q).await?;
    let ids: Vec<Uuid> = page.rows.iter().filter_map(|r| s(r, "id")?.parse().ok()).collect();
    let mut tx = k.db.tenant_tx(user.tenant).await?;
    let people: Vec<(Uuid, Uuid, Option<String>)> =
        sqlx::query_as("select parent_id, id, \"user\" from e_task__assigned_to where tenant_id = $1 and parent_id = any($2) order by parent_id, idx")
            .bind(user.tenant)
            .bind(&ids)
            .fetch_all(&mut *tx)
            .await?;
    let waits: Vec<(Uuid, Uuid, Option<Uuid>)> =
        sqlx::query_as("select parent_id, id, task from e_task__depends_on where tenant_id = $1 and parent_id = any($2) order by parent_id, idx")
            .bind(user.tenant)
            .bind(&ids)
            .fetch_all(&mut *tx)
            .await?;
    tx.commit().await?;
    let mut rows: HashMap<Uuid, (Vec<Value>, Vec<Value>)> = HashMap::new();
    for (parent, id, who) in people {
        rows.entry(parent).or_default().0.push(json!({"id": id, "user": who}));
    }
    for (parent, id, task) in waits {
        rows.entry(parent).or_default().1.push(json!({"id": id, "task": task}));
    }
    for row in page.rows.iter_mut() {
        let (people, waits) = s(row, "id").and_then(|i| i.parse::<Uuid>().ok()).and_then(|i| rows.remove(&i)).unwrap_or_default();
        row.insert("assigned_to".into(), Value::Array(people));
        row.insert("depends_on".into(), Value::Array(waits));
    }
    Ok(json!({"rows": page.rows, "total": page.total}))
}

/// `GET time?task=<id>`: the time logged on a task, line by line, newest first: whose, when, how long
/// and what for. The lines are child rows of timesheets, which a list leaves out. Read with the
/// caller's own rights (someone who may read only their own timesheets gets only the lines in
/// those) and without costs; `docstatus` says whether the timesheet is submitted, which is when
/// the hours count toward the task's.
async fn time(k: &Kernel, user: &Ctx, query: &Map<String, Value>) -> Result<Value> {
    let task = query.get("task").and_then(Value::as_str).and_then(|p| p.parse::<Uuid>().ok()).ok_or_else(|| Error::invalid("task: give the id of a task"))?;
    let q = ListQuery {
        filters: vec![Filter::eq("time_logs.task", task.to_string())],
        fields: Some(vec!["user".into(), "docstatus".into()]),
        limit: Some(TASK_LIMIT),
        ..Default::default()
    };
    let page = k.list(user, "Timesheet", &q).await?;
    let sheets: HashMap<Uuid, (Option<String>, i64)> = page
        .rows
        .iter()
        .filter_map(|r| Some((s(r, "id")?.parse().ok()?, (s(r, "user").map(str::to_string), r.get("docstatus").and_then(Value::as_i64).unwrap_or(0)))))
        .collect();
    let ids: Vec<Uuid> = sheets.keys().copied().collect();
    let mut tx = k.db.tenant_tx(user.tenant).await?;
    let lines: Vec<(Uuid, Option<chrono::DateTime<chrono::Utc>>, Option<String>, Option<String>)> = sqlx::query_as(
        "select parent_id, coalesce(from_time, day::timestamp at time zone 'UTC'), hours::text, description from e_timesheet__time_logs \
         where tenant_id = $1 and parent_id = any($2) and task = $3 order by 2 desc nulls last, idx limit 200",
    )
    .bind(user.tenant)
    .bind(&ids)
    .bind(task)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let logs: Vec<Value> = lines
        .into_iter()
        .filter_map(|(sheet, at, hours, what)| {
            let (who, docstatus) = sheets.get(&sheet)?;
            Some(json!({"timesheet": sheet, "user": who, "docstatus": docstatus, "at": at.map(|t| t.to_rfc3339()), "hours": hours, "what": what}))
        })
        .collect();
    Ok(json!({"logs": logs}))
}

/// `GET work`: the caller's open tasks, due on their expected end, High and Urgent ones marked;
/// read with the caller's own rights, so someone who may not read tasks gets none.
async fn work(k: &Kernel, user: &Ctx) -> Result<Value> {
    if user.email.is_empty() {
        return Ok(json!({"items": []}));
    }
    let q = ListQuery {
        filters: vec![Filter::eq("assigned_to.user", user.email.to_lowercase()), Filter { field: "status_category".into(), op: Op::NotIn, value: json!(DONE) }],
        sort: Some("exp_end_date asc".into()),
        limit: Some(50),
        with_titles: true,
        ..Default::default()
    };
    let page = match k.list(user, "Task", &q).await {
        Ok(p) => p,
        Err(Error::Forbidden(_)) => return Ok(json!({"items": []})),
        Err(e) => return Err(e),
    };
    let items: Vec<Value> = page
        .rows
        .iter()
        .map(|t| {
            let project = t.get("_titles").and_then(|x| x.get("project")).and_then(Value::as_str).or(s(t, "project"));
            let subtitle = [project, s(t, "status").filter(|st| *st != "Open")].into_iter().flatten().collect::<Vec<_>>().join(" · ");
            json!({
                "title": s(t, "subject").unwrap_or("Task"),
                "subtitle": subtitle,
                "url": format!("/open/Task/{}", s(t, "id").unwrap_or_default()),
                "due": s(t, "exp_end_date"),
                "priority": matches!(s(t, "priority"), Some("High" | "Urgent")).then_some("High"),
                "updated_at": s(t, "updated_at"),
            })
        })
        .collect();
    Ok(json!({"items": items}))
}
