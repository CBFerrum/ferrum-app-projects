//! Projects' endpoints for signed-in people (`/api/app/projects/…`): the open tasks assigned to the
//! caller, for Home's My work (Ferrum docs/plan/apps-ui.md §12.8).

use async_trait::async_trait;
use ferrum_domain::util::s;
use ferrum_kernel::{Ctx, Error, Filter, Kernel, ListQuery, Op, Result, Site, SiteRequest, SiteResponse};
use serde_json::{Value, json};

/// Statuses that are no longer anyone's work.
const DONE: [&str; 2] = ["Completed", "Cancelled"];

pub struct ProjectsSite;

#[async_trait]
impl Site for ProjectsSite {
    async fn handle(&self, k: &Kernel, req: SiteRequest) -> Result<SiteResponse> {
        let user = req.user.as_ref().ok_or_else(|| Error::Unauthorized("sign in first".into()))?;
        let out = match (req.method.as_str(), req.path.trim_matches('/')) {
            ("GET", "work") => work(k, user).await?,
            _ => return Err(Error::NotFound(format!("projects endpoint {} {}", req.method, req.path))),
        };
        let mut r = SiteResponse::json(200, &out);
        r.headers.push(("cache-control".into(), "no-store".into()));
        Ok(r)
    }
}

/// `GET work`: the caller's open tasks, due on their expected end, High and Urgent ones marked;
/// read with the caller's own rights, so someone who may not read tasks gets none.
async fn work(k: &Kernel, user: &Ctx) -> Result<Value> {
    if user.email.is_empty() {
        return Ok(json!({"items": []}));
    }
    let q = ListQuery {
        filters: vec![Filter::eq("assigned_to.user", user.email.to_lowercase()), Filter { field: "status".into(), op: Op::NotIn, value: json!(DONE) }],
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
