//! Projects: projects, tasks with dependencies, timesheets with costing and billing, project profitability.
//!
//! `Project` is core's master, extended with `proj_` overlay fields; tasks, timesheets and activity
//! rates are this package's entities. Derived figures (hours, costs, billed amounts, % complete)
//! are always recomputed from their sources under a row lock instead of being incremented, so
//! cancellations, amendments and concurrent postings cannot make them drift.
//!
//! Project gets `make_sales_invoice` and `complete` through `add_action` overlays; a timesheet and a
//! milestone task can also be invoiced on their own. Staff own the tasks assigned to them and the
//! timesheets recording their time through `owner_fields`.

mod billing;
mod logic;
mod planning;
mod project;
mod reports;
mod schedule;
mod site;
mod sprint;
mod status;
mod template;
mod timesheet;

use ferrum_domain::reports::ReportSource;
use ferrum_domain::util::{id, s};
use ferrum_kernel::{Ctx, Doc, HookRegistry, Kernel, Result, Tx};
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

/// Registers this package's document hooks.
pub fn register(hooks: &mut HookRegistry) {
    hooks
        .register("Project", Arc::new(project::ProjectHook))
        .register("Task", Arc::new(project::TaskHook))
        .register("ProjectRisk", Arc::new(planning::RiskHook))
        .register("ChangeRequest", Arc::new(planning::ChangeRequestHook))
        .register("ProjectUpdate", Arc::new(planning::UpdateHook))
        .register("Sprint", Arc::new(sprint::SprintHook))
        .register("Timesheet", Arc::new(timesheet::TimesheetHook))
        .register("ActivityCost", Arc::new(timesheet::ActivityCostHook));
    hooks.add_site("projects", Arc::new(site::ProjectsSite));
    // Invoicing time and milestones is the `projects_erp` connector's.
    hooks.scoped(&[CONNECTOR_PACKAGE.to_string()], |h| {
        h.register("SalesInvoice", Arc::new(billing::InvoiceHook));
    });
}

/// The connector with ERP's package.
pub const CONNECTOR_PACKAGE: &str = "projects_erp";

/// This package's reports.
pub fn reports() -> Vec<Arc<dyn ReportSource>> {
    vec![Arc::new(reports::Reports)]
}

/// Upkeep for one workspace, called by the platform as it comes due (idempotent and safe to run concurrently):
/// tasks in a To Do status that names a late status move to it once past their expected end, and
/// people whose week's time is short of their hours are reminded (Projects Settings).
pub async fn maintenance(k: &Kernel, tenant: Uuid) -> Result<()> {
    match mark_overdue(k, tenant).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(%tenant, tasks = n, "tasks marked overdue"),
        Err(e) => tracing::warn!(%tenant, "marking overdue tasks failed: {e}"),
    }
    match repeat_due(k, tenant).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(%tenant, tasks = n, "repeating tasks made"),
        Err(e) => tracing::warn!(%tenant, "making repeating tasks failed: {e}"),
    }
    match timesheet::remind_missing_time(k, tenant).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(%tenant, people = n, "people reminded of their week's time"),
        Err(e) => tracing::warn!(%tenant, "reminding people of their time failed: {e}"),
    }
    Ok(())
}

async fn repeat_due(k: &Kernel, tenant: Uuid) -> Result<usize> {
    let ctx = Ctx::system(tenant, k.registry.schema(tenant).await?);
    if ctx.schema.entity("Task").is_none() {
        return Ok(0);
    }
    planning::repeat_tasks(k, &ctx, ctx.today()).await
}

/// Each task moves by a save as the system, as a person's save would move it (`status::resolve`, so never to a late
/// status outside its project's workflow): a new version, a line in its history and a `Task.updated` event. Each is
/// re-read under its row lock first, so replicas running at once (or a person moving it meanwhile) move it once or
/// not at all; one that fails is logged and the others go on.
async fn mark_overdue(k: &Kernel, tenant: Uuid) -> Result<u64> {
    let ctx = Ctx::system(tenant, k.registry.schema(tenant).await?);
    if ctx.schema.entity("Task").is_none() || ctx.schema.entity("TaskStatus").is_none() {
        return Ok(0);
    }
    let today = ctx.today();
    let mut tx = k.db.tenant_tx(tenant).await?;
    let late: Vec<(Uuid, Option<Uuid>, Uuid)> = sqlx::query_as(
        "select t.id, t.project, t.task_status from e_task t join e_task_status s on s.tenant_id = t.tenant_id and s.id = t.task_status \
         where t.tenant_id = $1 and s.category = 'To Do' and s.late_status is not null and t.exp_end_date < $2 and not exists \
         (select 1 from e_project p where p.tenant_id = t.tenant_id and p.id = t.project and p.status in ('Completed', 'Cancelled')) order by t.id limit 500",
    )
    .bind(tenant)
    .bind(today)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let mut lists: HashMap<Uuid, Vec<status::Status>> = HashMap::new();
    let mut n = 0;
    for (task, project, from) in late {
        let Some(project) = project else { continue };
        match mark_late(k, &ctx, &mut lists, task, project, from, today).await {
            Ok(true) => n += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!(%task, "a late task was not marked: {e}"),
        }
    }
    Ok(n)
}

/// Moves `task` from status `from` to that status's late one, when its project's workflow holds both and, under the
/// task's lock, it is still in `from`, in `project` and past its end. `false` when nothing moved.
async fn mark_late(
    k: &Kernel,
    ctx: &Ctx,
    lists: &mut HashMap<Uuid, Vec<status::Status>>,
    task: Uuid,
    project: Uuid,
    from: Uuid,
    today: chrono::NaiveDate,
) -> Result<bool> {
    let mut tx = k.db.tenant_tx(ctx.tenant).await?;
    let list = match lists.entry(project) {
        std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
        std::collections::hash_map::Entry::Vacant(e) => {
            let doc = k.get_tx(ctx, &mut tx, "Project", project, false).await?;
            e.insert(status::statuses_for(ctx, &mut tx, &doc).await?)
        }
    };
    let Some(to) = list.iter().find(|s| s.id == from).and_then(|s| s.late).filter(|l| list.iter().any(|s| s.id == *l)) else {
        return Ok(false);
    };
    let doc = k.get_tx(ctx, &mut tx, "Task", task, true).await?;
    let end = s(&doc, "exp_end_date").and_then(|d| ferrum_kernel::value::parse_date(d).ok());
    if id(&doc, "task_status") != Some(from) || id(&doc, "project") != Some(project) || end.is_none_or(|e| e >= today) {
        return Ok(false);
    }
    let patch = Doc::from_iter([("task_status".to_string(), serde_json::json!(to.to_string()))]);
    k.update_tx(ctx, &mut tx, "Task", task, patch, None).await?;
    tx.commit().await?;
    Ok(true)
}

/// Projects Managers (and administrators and the engine) act on everyone's tasks and time.
pub(crate) fn is_manager(ctx: &Ctx) -> bool {
    ctx.is_system || ctx.has_role("Projects Manager")
}

/// The workspace's time zone, as `Ctx::today` reads it: its `timezone` setting, UTC when unset or not a zone.
pub(crate) fn zone(ctx: &Ctx) -> chrono_tz::Tz {
    ctx.schema.timezone.parse().unwrap_or(chrono_tz::Tz::UTC)
}

/// The workspace's date of a moment: the day it is where the workspace is, as `Ctx::today` is today.
pub(crate) fn day_of(ctx: &Ctx, at: chrono::DateTime<chrono::Utc>) -> chrono::NaiveDate {
    at.with_timezone(&zone(ctx)).date_naive()
}

/// Row locks taken in id order, so transactions touching the same rows queue instead of deadlocking.
pub(crate) async fn lock(tx: &mut Tx, table: &str, tenant: Uuid, ids: &[Uuid]) -> Result<()> {
    sqlx::query(sqlx::AssertSqlSafe(format!("select 1 from {table} where tenant_id = $1 and id = any($2) order by id for update")))
        .bind(tenant)
        .bind(ids)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// The emails (lower-cased) that belong to no user of the tenant.
pub(crate) async fn unknown_users(tx: &mut Tx, tenant: Uuid, emails: &[String]) -> Result<Vec<String>> {
    if emails.is_empty() {
        return Ok(vec![]);
    }
    let wanted: Vec<String> = emails.iter().map(|e| e.trim().to_lowercase()).collect();
    let known: Vec<String> = sqlx::query_scalar("select lower(email::text) from app_user where tenant_id = $1 and lower(email::text) = any($2)")
        .bind(tenant)
        .bind(&wanted)
        .fetch_all(&mut **tx)
        .await?;
    Ok(wanted.into_iter().filter(|e| !known.contains(e)).collect())
}

include!(concat!(env!("OUT_DIR"), "/packages.rs"));
include!(concat!(env!("OUT_DIR"), "/ui.rs"));

/// The notification kind app.yaml declares (`shell.notification`): tasks assigned to you, in the bar
/// and by email unless the person chose otherwise.
pub const ASSIGNED: &str = "projects.assigned";

/// This app's manifest (`app.yaml`).
pub const MANIFEST: &str = include_str!("../app.yaml");

/// The manifest of the connector app with ERP (`connectors/erp/app.yaml`, package `projects_erp`).
/// It ships with Projects.
pub const CONNECTOR_MANIFEST: &str = include_str!("../connectors/erp/app.yaml");

/// This app's metadata packages, embedded at build time.
pub fn packages() -> std::result::Result<Vec<ferrum_meta::Package>, ferrum_meta::MetaError> {
    ferrum_meta::catalog::load_embedded(EMBEDDED)
}

#[cfg(test)]
mod interface_tests {
    use super::*;

    #[test]
    fn the_interface_is_a_release_the_platform_takes() {
        let m = ferrum_apps::AppManifest::parse(MANIFEST).expect("app.yaml");
        assert_eq!(m.routes(), vec![("projects".to_string(), vec![])]);
        let files = UI.iter().map(|(p, b)| (p.to_string(), b.to_vec())).collect();
        let ui = ferrum_apps::ui::prepare("projects", files).expect("ui/dist is an interface release");
        assert!(UI.iter().any(|(p, _)| *p == "index.html") && !UI.iter().any(|(p, _)| p.starts_with('.')), "{}", ui.digest);
        ferrum_apps::AppManifest::parse(CONNECTOR_MANIFEST).expect("connectors/erp/app.yaml");
    }
}
