//! Dates that follow dependencies: when Projects Settings says so, a task whose predecessor moves
//! moves too, its length kept, to the earliest start its dependencies allow (finish to start: the
//! working day after the other ends, plus the lag; start to start: the other's start plus the lag;
//! finish to finish and start to finish: its end at the other's end or start plus the lag). Each move
//! is an ordinary save, so the tasks after it follow in turn; cycles are refused when saved, so this
//! ends. Done and cancelled tasks stay where they are.

use crate::logic::CLOSED;
use crate::template::{back, offset, shift};
use ferrum_domain::util::{elevated, id, rows, s};
use ferrum_kernel::value::parse_date;
use ferrum_kernel::{Doc, Error, HookCtx, Result};
use serde_json::{Value, json};
use uuid::Uuid;

fn date(doc: &Doc, field: &str) -> Option<chrono::NaiveDate> {
    s(doc, field).and_then(|v| parse_date(v).ok())
}

/// Moves the tasks that depend on `task`, which has just moved.
pub(crate) async fn follow(hc: &mut HookCtx<'_>, task: &Doc) -> Result<()> {
    let settings = crate::timesheet::settings(hc.kernel, hc.ctx, hc.tx).await?;
    if !settings.get("move_with_dependencies").and_then(Value::as_bool).unwrap_or(false) {
        return Ok(());
    }
    let calendar = match s(&settings, "schedule_calendar") {
        Some(name) => Some(
            ferrum_kernel::load_calendar(hc.tx, hc.ctx.tenant, name)
                .await?
                .ok_or_else(|| Error::invalid(format!("Projects Settings names the business calendar {name}, which is not there")))?,
        ),
        None => None,
    };
    let cal = calendar.as_ref();
    let Some(me) = id(task, "id") else { return Ok(()) };
    let after: Vec<Uuid> = sqlx::query_scalar("select distinct parent_id from e_task__depends_on where tenant_id = $1 and task = $2 order by 1")
        .bind(hc.ctx.tenant)
        .bind(me)
        .fetch_all(&mut **hc.tx)
        .await?;
    let actor = elevated(hc.ctx);
    for next in after {
        let doc = hc.kernel.get_tx(&actor, hc.tx, "Task", next, true).await?;
        if CLOSED.contains(&s(&doc, "status_category").unwrap_or_default()) {
            continue;
        }
        let (Some(start), Some(end)) = (date(&doc, "exp_start_date"), date(&doc, "exp_end_date")) else { continue };
        let length = offset(cal, start, end);
        let mut earliest = None;
        for r in rows(&doc, "depends_on") {
            let Some(other) = id(&r, "task") else { continue };
            let o = hc.kernel.get_tx(&actor, hc.tx, "Task", other, false).await?;
            let lag = r.get("lag_days").and_then(Value::as_i64).unwrap_or(0);
            let (o_start, o_end) = (date(&o, "exp_start_date"), date(&o, "exp_end_date"));
            let at = match s(&r, "kind").unwrap_or("Finish to Start") {
                "Start to Start" => o_start.map(|d| shift(cal, d, lag)),
                "Finish to Finish" => o_end.map(|d| back(cal, shift(cal, d, lag), length)),
                "Start to Finish" => o_start.map(|d| back(cal, shift(cal, d, lag), length)),
                _ => o_end.map(|d| shift(cal, d, 1 + lag)),
            };
            earliest = earliest.max(at);
        }
        let Some(new_start) = earliest.filter(|d| *d != start) else { continue };
        let new_end = shift(cal, new_start, length);
        let patch = Doc::from_iter([("exp_start_date".to_string(), json!(new_start.to_string())), ("exp_end_date".to_string(), json!(new_end.to_string()))]);
        Box::pin(hc.kernel.update_tx(&actor, hc.tx, "Task", next, patch, None)).await?;
    }
    Ok(())
}
