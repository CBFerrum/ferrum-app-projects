//! Sprints (PRJ-06): a stretch of days a project's team commits tasks to. A sprint is Planned, then Active (at most
//! one a project, guarded by the project's row lock in `start`), then Closed: closing records what was done and moves
//! every task that was not to the sprint named or back to the backlog, in one transaction. The backlog is the
//! project's open tasks without a sprint. State moves only by the two actions, each a save through the pipeline.

use crate::lock;
use crate::logic::CLOSED_PROJECT;
use crate::project::{label, try_get};
use async_trait::async_trait;
use ferrum_domain::util::{elevated, id, money, s, sys};
use ferrum_kernel::{Doc, DocHook, Error, HookCtx, Result};
use rust_decimal::Decimal;
use serde_json::{Value, json};
use uuid::Uuid;

/// The most open tasks one close moves (it is one transaction).
const MOVE_LIMIT: usize = 1000;

pub struct SprintHook;

#[async_trait]
impl DocHook for SprintHook {
    async fn validate(&self, hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        let project = id(doc, "project").ok_or_else(|| Error::field("project", "is required"))?;
        let p = try_get(hc.kernel, &sys(hc.ctx), hc.tx, "Project", project).await?.ok_or_else(|| Error::field("project", "does not exist"))?;
        if p.get("proj_is_template").and_then(Value::as_bool) == Some(true) {
            return Err(Error::field("project", "is a template: a template has no sprints"));
        }
        let old = match id(doc, "id") {
            Some(sprint) => try_get(hc.kernel, &sys(hc.ctx), hc.tx, "Sprint", sprint).await?,
            None => None,
        };
        match &old {
            None => {
                if let Some(st) = s(&p, "status").filter(|st| CLOSED_PROJECT.contains(st)) {
                    return Err(Error::field("project", format!("project {} is {}; reopen it to plan a sprint", label(&p), st.to_lowercase())));
                }
            }
            Some(old) => {
                if id(old, "project") != Some(project) {
                    return Err(Error::field("project", "a sprint stays with the project it was planned for"));
                }
                if s(old, "state") == Some("Closed") && !hc.ctx.is_system {
                    return Err(Error::invalid("a closed sprint is kept as it closed"));
                }
            }
        }
        Ok(())
    }

    async fn before_delete(&self, _hc: &mut HookCtx<'_>, doc: &Doc) -> Result<()> {
        match s(doc, "state") {
            Some("Planned") | None => Ok(()),
            Some(state) => Err(Error::invalid(format!("a sprint that is {} is not deleted", state.to_lowercase()))),
        }
    }

    async fn action(&self, hc: &mut HookCtx<'_>, name: &str, doc: &Doc, params: &Value) -> Result<Option<Value>> {
        match name {
            "start" => start(hc, doc).await.map(Some),
            "close" => close(hc, doc, params).await.map(Some),
            _ => Ok(None),
        }
    }
}

/// The points and the number of a sprint's tasks: all but the cancelled ones, or only the done ones.
async fn totals(hc: &mut HookCtx<'_>, sprint: Uuid, done_only: bool) -> Result<(Decimal, i64)> {
    let sql = if done_only {
        "select coalesce(sum(story_points), 0), count(*) from e_task where tenant_id = $1 and sprint = $2 and status_category = 'Done'"
    } else {
        "select coalesce(sum(story_points), 0), count(*) from e_task where tenant_id = $1 and sprint = $2 and status_category is distinct from 'Cancelled'"
    };
    Ok(sqlx::query_as(sql).bind(hc.ctx.tenant).bind(sprint).fetch_one(&mut **hc.tx).await?)
}

/// `start`: under the project's row lock, refused while another sprint of the project is Active; records what is
/// committed.
async fn start(hc: &mut HookCtx<'_>, doc: &Doc) -> Result<Value> {
    let sprint = id(doc, "id").ok_or_else(|| Error::internal("a sprint without an id"))?;
    let project = id(doc, "project").ok_or_else(|| Error::internal("a sprint without a project"))?;
    lock(hc.tx, "e_project", hc.ctx.tenant, &[project]).await?;
    let active: Option<Option<String>> =
        sqlx::query_scalar("select sprint_name from e_sprint where tenant_id = $1 and project = $2 and state = 'Active' and id <> $3 limit 1")
            .bind(hc.ctx.tenant)
            .bind(project)
            .bind(sprint)
            .fetch_optional(&mut **hc.tx)
            .await?;
    if let Some(other) = active {
        return Err(Error::invalid(format!("{} is the project's active sprint; close it first", other.unwrap_or_default())));
    }
    let (points, tasks) = totals(hc, sprint, false).await?;
    let values = Doc::from_iter([
        ("state".to_string(), json!("Active")),
        ("started_on".to_string(), json!(hc.ctx.today().to_string())),
        ("committed_points".to_string(), money(points)),
        ("committed_tasks".to_string(), json!(tasks)),
    ]);
    hc.kernel.update_tx(&elevated(hc.ctx), hc.tx, "Sprint", sprint, values, None).await?;
    Ok(json!({"state": "Active", "committed_points": money(points), "committed_tasks": tasks}))
}

/// `close`: each open task, under its lock in id order, to the planned sprint named or back to the backlog; then what
/// was done is recorded. One refusal undoes the whole close.
async fn close(hc: &mut HookCtx<'_>, doc: &Doc, params: &Value) -> Result<Value> {
    let sprint = id(doc, "id").ok_or_else(|| Error::internal("a sprint without an id"))?;
    let project = id(doc, "project").ok_or_else(|| Error::internal("a sprint without a project"))?;
    let tenant = hc.ctx.tenant;
    let target = match params.get("move_open_to").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()) {
        None => None,
        Some(t) => {
            let t: Uuid = t.parse().map_err(|_| Error::field("move_open_to", "is not a sprint"))?;
            let found: Option<(Option<Uuid>, Option<String>, Option<String>)> =
                sqlx::query_as("select project, state, sprint_name from e_sprint where tenant_id = $1 and id = $2")
                    .bind(tenant)
                    .bind(t)
                    .fetch_optional(&mut **hc.tx)
                    .await?;
            match found {
                None => return Err(Error::field("move_open_to", "does not exist")),
                Some(_) if t == sprint => return Err(Error::field("move_open_to", "is this sprint")),
                Some((p, _, name)) if p != Some(project) => {
                    return Err(Error::field("move_open_to", format!("{} is another project's sprint", name.unwrap_or_default())));
                }
                Some((_, state, name)) if state.as_deref() != Some("Planned") => {
                    return Err(Error::field(
                        "move_open_to",
                        format!("{} is {}, not planned", name.unwrap_or_default(), state.unwrap_or_default().to_lowercase()),
                    ));
                }
                Some(_) => Some(t),
            }
        }
    };
    let open: Vec<Uuid> = sqlx::query_scalar(
        "select id from e_task where tenant_id = $1 and sprint = $2 and coalesce(status_category, '') not in ('Done', 'Cancelled') order by id limit $3",
    )
    .bind(tenant)
    .bind(sprint)
    .bind(MOVE_LIMIT as i64 + 1)
    .fetch_all(&mut **hc.tx)
    .await?;
    if open.len() > MOVE_LIMIT {
        return Err(Error::invalid(format!("more than {MOVE_LIMIT} tasks are open in the sprint; move some first")));
    }
    let actor = elevated(hc.ctx);
    let mut moved = 0;
    for task in open {
        let t = hc.kernel.get_tx(&actor, hc.tx, "Task", task, true).await?;
        if matches!(s(&t, "status_category"), Some("Done" | "Cancelled")) || id(&t, "sprint") != Some(sprint) {
            continue;
        }
        let patch = Doc::from_iter([("sprint".to_string(), target.map_or(Value::Null, |t| json!(t.to_string())))]);
        hc.kernel.update_tx(&actor, hc.tx, "Task", task, patch, None).await.map_err(|e| Error::invalid(format!("{}: {e}", label(&t))))?;
        moved += 1;
    }
    let (points, tasks) = totals(hc, sprint, true).await?;
    let values = Doc::from_iter([
        ("state".to_string(), json!("Closed")),
        ("closed_on".to_string(), json!(hc.ctx.today().to_string())),
        ("completed_points".to_string(), money(points)),
        ("completed_tasks".to_string(), json!(tasks)),
        ("carried_over".to_string(), json!(moved)),
    ]);
    hc.kernel.update_tx(&actor, hc.tx, "Sprint", sprint, values, None).await?;
    Ok(json!({"state": "Closed", "completed_points": money(points), "completed_tasks": tasks, "carried_over": moved,
              "moved_to": target.map(|t| t.to_string())}))
}
