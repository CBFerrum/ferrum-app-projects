//! Project teams, statuses, weekly time, templates, rates and the client's view, against a real
//! PostgreSQL (`FERRUM_PROJECTS2_TEST_DATABASE_URL`, default
//! `postgres://ferrum:ferrum@localhost:5432/ferrum_projects2_test`). The database is reset first.

use ferrum_kernel::tenant::NewTenant;
use ferrum_kernel::{Ctx, Db, DbConfig, Doc, Error, HookRegistry, Kernel, KernelSettings, ListQuery, Result};
use ferrum_meta::Catalog;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

fn obj(v: Value) -> Doc {
    v.as_object().cloned().unwrap()
}

fn uid(doc: &Doc) -> Uuid {
    doc["id"].as_str().unwrap().parse().unwrap()
}

fn field_error<T: std::fmt::Debug>(r: &Result<T>, field: &str, needle: &str) -> bool {
    matches!(r, Err(Error::Validation(e)) if e.iter().any(|f| f.field == field && f.message.contains(needle)))
}

fn denied<T: std::fmt::Debug>(r: &Result<T>) -> bool {
    matches!(r, Err(Error::Forbidden(_)) | Err(Error::NotFound(_)))
}

async fn fresh_kernel() -> Arc<Kernel> {
    let url = std::env::var("FERRUM_PROJECTS2_TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://ferrum:ferrum@localhost:5432/ferrum_projects2_test".into());
    let db = Db::connect(DbConfig { url, max_connections: 10, ..Default::default() }).await.expect("connect");
    sqlx::raw_sql("drop schema if exists public cascade; create schema public;").execute(&db.pool).await.expect("reset");
    let mut packages = ferrum_domain::packages().expect("platform packages");
    packages.extend(ferrum_app_erp::packages().expect("ERP's packages"));
    packages.extend(ferrum_app_projects::packages().expect("app packages"));
    let catalog = Catalog::from_packages(packages).expect("catalog");
    let mut hooks = HookRegistry::default();
    ferrum_domain::register(&mut hooks);
    ferrum_app_erp::register(&mut hooks);
    ferrum_app_projects::register(&mut hooks);
    for source in ferrum_app_projects::reports() {
        ferrum_domain::reports::add_source(source);
    }
    let k = Kernel::boot(db, catalog, hooks, KernelSettings::default(), None).await.expect("boot");
    ferrum_domain::maintenance(&k).await.expect("domain maintenance");
    ferrum_app_erp::maintenance(&k).await.expect("ERP maintenance");
    k
}

/// One signed-in user driving the kernel API.
struct U {
    k: Arc<Kernel>,
    ctx: Ctx,
}

impl U {
    async fn try_insert(&self, entity: &str, v: Value) -> Result<Doc> {
        self.k.insert(&self.ctx, entity, obj(v)).await
    }
    async fn insert(&self, entity: &str, v: Value) -> Doc {
        self.try_insert(entity, v).await.unwrap_or_else(|e| panic!("insert {entity}: {e:?}"))
    }
    async fn try_update(&self, entity: &str, id: Uuid, v: Value) -> Result<Doc> {
        self.k.update(&self.ctx, entity, id, obj(v), None).await
    }
    async fn update(&self, entity: &str, id: Uuid, v: Value) -> Doc {
        self.try_update(entity, id, v).await.unwrap_or_else(|e| panic!("update {entity}: {e:?}"))
    }
    async fn try_get(&self, entity: &str, id: Uuid) -> Result<Doc> {
        self.k.get(&self.ctx, entity, id, false).await
    }
    async fn get(&self, entity: &str, id: Uuid) -> Doc {
        self.try_get(entity, id).await.unwrap_or_else(|e| panic!("get {entity}: {e:?}"))
    }
    async fn list(&self, entity: &str, filters: Value) -> Vec<Doc> {
        let q = ListQuery { filters: ferrum_kernel::query::parse_filters(&filters).unwrap(), limit: Some(500), ..Default::default() };
        self.k.list(&self.ctx, entity, &q).await.unwrap_or_else(|e| panic!("list {entity}: {e:?}")).rows
    }
    async fn find_one(&self, entity: &str, filters: Value) -> Doc {
        let rows = self.list(entity, filters.clone()).await;
        assert_eq!(rows.len(), 1, "{entity} {filters}");
        rows[0].clone()
    }
    /// A board's tasks through the app's endpoint, read with the caller's rights.
    async fn board(&self, project: Uuid) -> Vec<String> {
        let site = self.k.hooks.site("projects").expect("projects' endpoints").clone();
        let req = ferrum_kernel::SiteRequest {
            tenant: self.ctx.tenant,
            user: Some(self.ctx.clone()),
            method: "GET".into(),
            path: "/tasks".into(),
            query: json!({"project": project.to_string()}).as_object().cloned().unwrap(),
            headers: Default::default(),
            body: vec![],
            client_ip: "203.0.113.9".into(),
        };
        let body: Value = serde_json::from_slice(&site.handle(&self.k, req).await.expect("board").body).unwrap();
        let mut names: Vec<String> = body["rows"].as_array().unwrap().iter().map(|r| r["subject"].as_str().unwrap().to_string()).collect();
        names.sort();
        names
    }
}

/// The user signed in again, with their roles' rules as they are now.
async fn reload(u: &U) -> U {
    U { k: u.k.clone(), ctx: u.k.load_ctx(u.ctx.tenant, u.ctx.user, None, "it".into()).await.unwrap() }
}

#[test]
fn teams_statuses_time_templates_rates_clients() {
    // Same runtime shape as the server: unoptimized async hook chains need more than 2 MiB.
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(16 << 20).build().unwrap();
    rt.block_on(async { tokio::spawn(scenario()).await.unwrap() });
}

struct World {
    admin: U,
    users: HashMap<&'static str, U>,
    cid: String,
    globex: String,
}

async fn world() -> World {
    let k = fresh_kernel().await;
    let tenant = k
        .create_tenant(NewTenant {
            slug: "acme".into(),
            name: "Acme Consulting".into(),
            admin_email: "admin@acme.test".into(),
            admin_password: "Correct-Horse-9".into(),
            admin_name: None,
            packages: vec!["projects".into(), "projects_erp".into()],
            settings: Some(json!({"fiscal_year_start_month": 4})),
        })
        .await
        .expect("tenant");
    let session = k.login("acme", "admin@acme.test", "Correct-Horse-9").await.expect("login");
    let admin = U { k: k.clone(), ctx: k.load_ctx(tenant, session.user, Some(session.token_version), "it".into()).await.expect("ctx") };
    let mut users = HashMap::new();
    for (email, role) in [
        ("pm", "Projects Manager"),
        ("lead", "Projects User"),
        ("mia", "Projects User"),
        ("vic", "Projects User"),
        ("nora", "Projects User"),
        ("boss", "Projects User"),
    ] {
        let id = k.create_user(&admin.ctx, &format!("{email}@acme.test"), email, Some("Correct-Horse-9"), &[role.into()], false).await.expect("user");
        users.insert(email, U { k: k.clone(), ctx: k.load_ctx(tenant, id, None, "it".into()).await.expect("user ctx") });
    }
    let inr = admin.find_one("Currency", json!({"code": "INR"})).await;
    let company = admin.insert("Company", json!({"company_name": "Acme Consulting Pvt Ltd", "abbr": "AC", "default_currency": inr["id"]})).await;
    let cid = uid(&company).to_string();
    let globex = uid(&admin.insert("Customer", json!({"customer_name": "Globex"})).await).to_string();
    World { admin, users, cid, globex }
}

async fn scenario() {
    let w = world().await;
    teams(&w).await;
}

/// PJ-02, PJ-03: a project's members read it and all its tasks and write by their role on it; a
/// private project is its members' alone, an open one every Projects User's to read.
async fn teams(w: &World) {
    let (pm, lead, mia, vic, nora) = (&w.users["pm"], &w.users["lead"], &w.users["mia"], &w.users["vic"], &w.users["nora"]);
    // The rules a package cannot ship yet (its role rules may not name fields its overlays add to
    // core's Project), set as a workspace administrator would.
    let rule = |v: Value| serde_json::from_value::<ferrum_meta::PermissionDef>(v).unwrap();
    for r in [
        json!({"entity": "Project", "read": false}),
        json!({"entity": "ProjectRisk", "read": false}),
        json!({"entity": "Task", "read": true, "write": true, "if_owner": true}),
        json!({"entity": "Project", "read": true, "where": {"proj_private": false}}),
        json!({"entity": "Project", "read": true, "via": "proj_members.person"}),
        json!({"entity": "Project", "read": true, "write": true, "via": "proj_members.manager"}),
        json!({"entity": "Task", "read": true, "where": {"project_private": false}}),
        json!({"entity": "Task", "read": true, "via": "project.proj_members.person"}),
        json!({"entity": "Task", "read": true, "write": true, "create": true, "via": "project.proj_members.editor"}),
        json!({"entity": "Task", "create": true, "if_owner": true, "where": {"project_private": false}}),
        json!({"entity": "ProjectRisk", "read": true, "where": {"project_private": false}}),
        json!({"entity": "ProjectRisk", "read": true, "via": "project.proj_members.person"}),
    ] {
        w.admin.k.set_role_permission(&w.admin.ctx, "Projects User", &rule(r)).await.expect("rule");
    }
    let (lead, mia, vic, nora) = (&reload(lead).await, &reload(mia).await, &reload(vic).await, &reload(nora).await);
    let members = json!([
        {"person": "lead@acme.test", "project_role": "Manager"},
        {"person": "Mia@Acme.test", "project_role": "Member"},
        {"person": "vic@acme.test", "project_role": "Viewer"}]);
    let r = pm
        .try_insert("Project", json!({"project_name": "Ghosts", "company": w.cid, "proj_members": [{"person": "ghost@acme.test", "project_role": "Member"}]}))
        .await;
    assert!(field_error(&r, "person", "no user"), "a member is a user: {r:?}");
    let r = pm
        .try_insert("Project", json!({"project_name": "Twice", "company": w.cid, "proj_members": [{"person": "mia@acme.test"}, {"person": "MIA@acme.test"}]}))
        .await;
    assert!(field_error(&r, "person", "twice"), "once each: {r:?}");
    let secret = uid(&pm
        .insert("Project", json!({"project_name": "Secret", "company": w.cid, "customer": w.globex, "proj_private": true, "proj_members": members}))
        .await);
    let open = uid(&pm.insert("Project", json!({"project_name": "Open House", "company": w.cid})).await);
    let t1 = uid(&pm.insert("Task", json!({"subject": "Plan the launch", "project": secret.to_string()})).await);
    let t2 = uid(&pm.insert("Task", json!({"subject": "Paint the hall", "project": open.to_string()})).await);
    assert_eq!(pm.get("Task", t1).await["project_private"], json!(true), "a task knows its project is private");

    // A member reads the project and its whole board, and works on its tasks.
    assert_eq!(mia.get("Project", secret).await["project_name"], json!("Secret"));
    assert_eq!(mia.board(secret).await, ["Plan the launch"]);
    mia.update("Task", t1, json!({"description": "Venue booked"})).await;
    let mine = mia.insert("Task", json!({"subject": "Invite the press", "project": secret.to_string()})).await;
    assert_eq!(mia.board(secret).await, ["Invite the press", "Plan the launch"]);
    let r = mia.try_update("Project", secret, json!({"notes": "mine now"})).await;
    assert!(denied(&r), "a member does not change the project itself: {r:?}");
    // The project's manager does.
    lead.update("Project", secret, json!({"notes": "Launch on Friday"})).await;
    // A viewer reads, and changes nothing.
    assert_eq!(vic.board(secret).await, ["Invite the press", "Plan the launch"]);
    let r = vic.try_update("Task", t1, json!({"description": "viewer was here"})).await;
    assert!(denied(&r), "a viewer reads only: {r:?}");
    let r = vic.try_insert("Task", json!({"subject": "Viewer's own", "project": secret.to_string()})).await;
    assert!(denied(&r), "nor adds tasks to a private project: {r:?}");
    // Someone else reads nothing of a private project.
    assert!(denied(&nora.try_get("Project", secret).await));
    assert!(denied(&nora.try_get("Task", t1).await));
    assert!(nora.list("Task", json!({})).await.iter().all(|t| t["project"] != json!(secret.to_string())), "no private task in her lists");
    let r = nora.try_insert("Task", json!({"subject": "Gatecrash", "project": secret.to_string()})).await;
    assert!(denied(&r) || field_error(&r, "project", ""), "nor adds a task to it: {r:?}");
    // An open project's board is every Projects User's to read; changing a task stays its people's.
    assert_eq!(nora.board(open).await, ["Paint the hall"]);
    assert!(denied(&nora.try_update("Task", t2, json!({"description": "nora was here"})).await));

    // Opening the project opens its tasks at once; closing it again closes them.
    pm.update("Project", secret, json!({"proj_private": false})).await;
    assert_eq!(nora.get("Task", t1).await["subject"], json!("Plan the launch"));
    pm.update("Project", secret, json!({"proj_private": true})).await;
    assert!(denied(&nora.try_get("Task", t1).await));
    // Taken off the team, a member loses it at once.
    pm.update(
        "Project",
        secret,
        json!({"proj_members": [{"person": "lead@acme.test", "project_role": "Manager"}, {"person": "vic@acme.test", "project_role": "Viewer"}]}),
    )
    .await;
    assert!(denied(&mia.try_get("Task", t1).await));
    assert!(denied(&mia.try_get("Project", secret).await));
    // What she made is still hers (she is its creator).
    assert_eq!(mia.get("Task", uid(&mine)).await["subject"], json!("Invite the press"));
}
