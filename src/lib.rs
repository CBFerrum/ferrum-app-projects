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
mod status;
mod template;
mod timesheet;

use ferrum_domain::reports::ReportSource;
use ferrum_kernel::{Ctx, HookRegistry, Kernel, Result, Tx};
use std::sync::Arc;
use uuid::Uuid;

/// Registers this package's document hooks.
pub fn register(hooks: &mut HookRegistry) {
    hooks
        .register("Project", Arc::new(project::ProjectHook))
        .register("Task", Arc::new(project::TaskHook))
        .register("ProjectRisk", Arc::new(planning::RiskHook))
        .register("ChangeRequest", Arc::new(planning::ChangeRequestHook))
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

/// Only tasks still in such a status change, in one statement that re-checks each row under its
/// lock, so replicas running at once (or a user starting the task meanwhile) never conflict.
async fn mark_overdue(k: &Kernel, tenant: Uuid) -> Result<u64> {
    let ctx = Ctx::system(tenant, k.registry.schema(tenant).await?);
    if ctx.schema.entity("Task").is_none() || ctx.schema.entity("TaskStatus").is_none() {
        return Ok(0);
    }
    let mut tx = k.db.tenant_tx(tenant).await?;
    let n = sqlx::query(
        "update e_task t set task_status = l.id, status = l.status_name, status_category = l.category, updated_at = now() \
         from e_task_status s join e_task_status l on l.tenant_id = s.tenant_id and l.id = s.late_status \
         where t.tenant_id = $1 and s.tenant_id = $1 and s.id = t.task_status and s.category = 'To Do' and t.exp_end_date < $2 and not exists \
         (select 1 from e_project p where p.tenant_id = t.tenant_id and p.id = t.project and p.status in ('Completed', 'Cancelled'))",
    )
    .bind(tenant)
    .bind(ctx.today())
    .execute(&mut *tx)
    .await?
    .rows_affected();
    tx.commit().await?;
    Ok(n)
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
