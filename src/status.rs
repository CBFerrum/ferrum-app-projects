//! Task statuses (PJ-04): records with a category, chosen from the project's workflow. What a status
//! means (started, finished, cancelled) is its category, which the code reads; its name is the
//! workspace's own. A project uses its own workflow, else its type's, else the default one, else every
//! status there is.

use crate::logic::{CANCELLED, DONE, TO_DO};
use chrono::NaiveDate;
use ferrum_domain::util::{id, s, set};
use ferrum_kernel::{Ctx, Doc, Error, Result, Tx};
use serde_json::Value;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct Status {
    pub id: Uuid,
    pub name: String,
    pub category: String,
    pub late: Option<Uuid>,
}

/// The category of a status name in a workspace that holds no status records (one whose
/// administrator deleted them all): the six names the app has always had.
pub fn legacy_category(name: &str) -> &'static str {
    match name {
        "Completed" => DONE,
        "Cancelled" => CANCELLED,
        "Working" | "Pending Review" => crate::logic::IN_PROGRESS,
        _ => TO_DO,
    }
}

/// The statuses `project`'s tasks may take, in their workflow's order; empty when the workspace has
/// no status records.
pub async fn statuses_for(ctx: &Ctx, tx: &mut Tx, project: &Doc) -> Result<Vec<Status>> {
    if ctx.schema.entity("TaskStatus").is_none() {
        return Ok(vec![]);
    }
    let mut workflow = id(project, "proj_task_workflow");
    if workflow.is_none()
        && let Some(kind) = id(project, "proj_project_type")
    {
        workflow = sqlx::query_scalar("select task_workflow from e_project_type where tenant_id = $1 and id = $2")
            .bind(ctx.tenant)
            .bind(kind)
            .fetch_optional(&mut **tx)
            .await?
            .flatten();
    }
    if workflow.is_none() {
        workflow = sqlx::query_scalar("select id from e_task_workflow where tenant_id = $1 and is_default order by created_at, id limit 1")
            .bind(ctx.tenant)
            .fetch_optional(&mut **tx)
            .await?;
    }
    let rows: Vec<(Uuid, Option<String>, Option<String>, Option<Uuid>)> = match workflow {
        Some(w) => {
            sqlx::query_as(
                "select s.id, s.status_name, s.category, s.late_status from e_task_workflow__statuses r \
                 join e_task_status s on s.tenant_id = r.tenant_id and s.id = r.status where r.tenant_id = $1 and r.parent_id = $2 order by r.idx",
            )
            .bind(ctx.tenant)
            .bind(w)
            .fetch_all(&mut **tx)
            .await?
        }
        None => vec![],
    };
    let rows = if rows.is_empty() {
        sqlx::query_as("select id, status_name, category, late_status from e_task_status where tenant_id = $1 order by sort_order nulls last, status_name")
            .bind(ctx.tenant)
            .fetch_all(&mut **tx)
            .await?
    } else {
        rows
    };
    Ok(rows
        .into_iter()
        .map(|(id, name, category, late)| Status { id, name: name.unwrap_or_default(), category: category.unwrap_or_else(|| TO_DO.into()), late })
        .collect())
}

/// One status record, wherever it is used.
async fn status_by_id(ctx: &Ctx, tx: &mut Tx, status: Uuid) -> Result<Option<Status>> {
    let row: Option<(Option<String>, Option<String>, Option<Uuid>)> =
        sqlx::query_as("select status_name, category, late_status from e_task_status where tenant_id = $1 and id = $2")
            .bind(ctx.tenant)
            .bind(status)
            .fetch_optional(&mut **tx)
            .await?;
    Ok(row.map(|(name, category, late)| Status { id: status, name: name.unwrap_or_default(), category: category.unwrap_or_else(|| TO_DO.into()), late }))
}

fn names(list: &[Status]) -> String {
    list.iter().map(|s| s.name.as_str()).collect::<Vec<_>>().join(", ")
}

/// Sets a task's `task_status`, `status` (its name) and `status_category` from what was asked: a
/// status record (`task_status`) wins over a name (`status`); a new task asking for neither takes
/// the workflow's first. A status changed to one outside the project's workflow is refused; one
/// kept as it was stays even if the workflow no longer holds it. A To Do status with a late status
/// moves there once the task is past its expected end, and back once it is not.
pub async fn resolve(ctx: &Ctx, tx: &mut Tx, project: &Doc, doc: &mut Doc, old: Option<&Doc>, today: NaiveDate) -> Result<()> {
    let list = statuses_for(ctx, tx, project).await?;
    if list.is_empty() {
        let name = s(doc, "status").unwrap_or("Open").to_string();
        set(doc, "status_category", legacy_category(&name));
        set(doc, "status", name);
        return Ok(());
    }
    let asked_id = id(doc, "task_status");
    let asked_name = s(doc, "status").map(str::trim).filter(|n| !n.is_empty()).map(str::to_string);
    let (old_id, old_name) = (old.and_then(|o| id(o, "task_status")), old.and_then(|o| s(o, "status")).map(str::to_string));
    let mut chosen = if asked_id.is_some() && asked_id != old_id {
        let wanted = asked_id.unwrap_or_default();
        match list.iter().find(|s| s.id == wanted) {
            Some(s) => s.clone(),
            None => {
                let name = status_by_id(ctx, tx, wanted).await?.map(|s| s.name).ok_or_else(|| Error::field("task_status", "does not exist"))?;
                return Err(Error::field("task_status", format!("{name} is not a status of this project's workflow ({})", names(&list))));
            }
        }
    } else if let Some(name) = asked_name.filter(|n| Some(n) != old_name.as_ref()) {
        match list.iter().find(|s| s.name.eq_ignore_ascii_case(&name)) {
            Some(s) => s.clone(),
            None => return Err(Error::field("status", format!("{name} is not a status of this project's workflow ({})", names(&list)))),
        }
    } else if let Some(kept) = asked_id {
        match list.iter().find(|s| s.id == kept) {
            Some(s) => s.clone(),
            None => status_by_id(ctx, tx, kept).await?.unwrap_or_else(|| list[0].clone()),
        }
    } else {
        list[0].clone()
    };
    let late = s(doc, "exp_end_date").and_then(|e| NaiveDate::parse_from_str(e, "%Y-%m-%d").ok()).is_some_and(|e| e < today);
    if late && chosen.category == TO_DO {
        if let Some(to) = chosen.late.and_then(|l| list.iter().find(|s| s.id == l)) {
            chosen = to.clone();
        }
    } else if !late && let Some(back) = list.iter().find(|s| s.late == Some(chosen.id)) {
        chosen = back.clone();
    }
    set(doc, "task_status", chosen.id.to_string());
    set(doc, "status", chosen.name.clone());
    set(doc, "status_category", chosen.category.clone());
    Ok(())
}

/// The first status of `category` in the project's workflow, as a task patch (`status` alone where
/// the workspace has no status records).
pub async fn patch_to(ctx: &Ctx, tx: &mut Tx, project: &Doc, category: &str) -> Result<Doc> {
    let list = statuses_for(ctx, tx, project).await?;
    let mut patch = Doc::new();
    if list.is_empty() {
        patch.insert("status".into(), Value::from(if category == CANCELLED { "Cancelled" } else { "Completed" }));
        return Ok(patch);
    }
    let to = list
        .iter()
        .find(|s| s.category == category)
        .ok_or_else(|| Error::invalid(format!("this project's workflow ({}) has no status of category {category}", names(&list))))?;
    patch.insert("task_status".into(), Value::from(to.id.to_string()));
    Ok(patch)
}
