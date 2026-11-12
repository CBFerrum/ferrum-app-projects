//! Project teams, statuses, weekly time, templates, rates and the client's view, against a real
//! PostgreSQL (`FERRUM_PROJECTS2_TEST_DATABASE_URL`, default
//! `postgres://ferrum:ferrum@localhost:5432/ferrum_projects2_test`). The database is reset first.

use chrono::{Datelike, Duration, Utc};
use ferrum_kernel::tenant::NewTenant;
use ferrum_kernel::{Ctx, Db, DbConfig, Doc, Error, HookRegistry, Kernel, KernelSettings, ListQuery, Result};
use ferrum_meta::Catalog;
use rust_decimal::Decimal;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use uuid::Uuid;

fn obj(v: Value) -> Doc {
    v.as_object().cloned().unwrap()
}

fn dec(v: &Value) -> Decimal {
    match v {
        Value::String(s) => Decimal::from_str(s).unwrap_or_else(|_| panic!("not a decimal: {s}")),
        Value::Number(n) => Decimal::from_str(&n.to_string()).unwrap(),
        Value::Null => Decimal::ZERO,
        other => panic!("not a decimal: {other}"),
    }
}

fn n(s: &str) -> Decimal {
    Decimal::from_str(s).unwrap()
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
    async fn try_action(&self, entity: &str, id: Uuid, action: &str, params: Value) -> Result<Value> {
        self.k.run_action(&self.ctx, entity, id, action, params).await
    }
    async fn action(&self, entity: &str, id: Uuid, action: &str, params: Value) -> Value {
        self.try_action(entity, id, action, params).await.unwrap_or_else(|e| panic!("{entity}.{action}: {e:?}"))
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
    statuses(&w).await;
    weekly_time(&w).await;
    templates(&w).await;
    rates(&w).await;
    dependencies(&w).await;
    client_portal(&w).await;
    // Last: it rewinds the workspace to before this release.
    upgrade(&w).await;
}

/// PJ-02, PJ-03: a project's members read it and all its tasks and write by their role on it; a
/// private project is its members' alone, an open one every Projects User's to read.
async fn teams(w: &World) {
    let (pm, lead, mia, vic, nora) = (&w.users["pm"], &w.users["lead"], &w.users["mia"], &w.users["vic"], &w.users["nora"]);
    // The package's own rules: no workspace customization applied.
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

/// PJ-04: statuses are records with a category, chosen from the project's workflow (its own, else
/// its type's, else the default); the code reads the category. % complete counts tasks without
/// sub-tasks only.
async fn statuses(w: &World) {
    let pm = &w.users["pm"];
    let yesterday = (Utc::now().date_naive() - Duration::days(1)).to_string();
    let plain = uid(&pm.insert("Project", json!({"project_name": "Plain", "company": w.cid})).await);
    let first = pm.insert("Task", json!({"subject": "First", "project": plain.to_string()})).await;
    let open = pm.find_one("TaskStatus", json!({"status_name": "Open"})).await;
    assert_eq!((first["status"].clone(), first["status_category"].clone(), first["task_status"].clone()), (json!("Open"), json!("To Do"), open["id"].clone()));
    let late = pm.insert("Task", json!({"subject": "Late", "project": plain.to_string(), "exp_end_date": yesterday})).await;
    assert_eq!((late["status"].clone(), late["status_category"].clone()), (json!("Overdue"), json!("To Do")), "Open's late status");

    // A workflow in the workspace's own words, for a type of project.
    let status = |name: &'static str, category: &'static str| async move {
        pm.insert("TaskStatus", json!({"status_name": name, "category": category})).await["id"].clone()
    };
    let (backlog, qa, shipped, dropped) =
        (status("Backlog", "To Do").await, status("In QA", "In Progress").await, status("Shipped", "Done").await, status("Dropped", "Cancelled").await);
    let rows = json!([{"status": backlog}, {"status": qa}, {"status": shipped}, {"status": dropped}]);
    let software = pm.insert("TaskWorkflow", json!({"workflow_name": "Software", "statuses": rows})).await;
    let kind = pm.insert("ProjectType", json!({"type_name": "Software", "task_workflow": software["id"]})).await;
    let app = uid(&pm.insert("Project", json!({"project_name": "App", "company": w.cid, "proj_project_type": kind["id"]})).await);
    let spec = pm.insert("Task", json!({"subject": "Spec", "project": app.to_string(), "expected_hours": "10", "exp_end_date": yesterday})).await;
    assert_eq!((spec["status"].clone(), spec["status_category"].clone()), (json!("Backlog"), json!("To Do")), "its type's workflow; no late status here");
    let spec = uid(&spec);
    let r = pm.try_update("Task", spec, json!({"status": "Working"})).await;
    assert!(field_error(&r, "status", "not a status of this project's workflow (Backlog, In QA, Shipped, Dropped)"), "{r:?}");
    let r = pm.try_update("Task", spec, json!({"task_status": open["id"]})).await;
    assert!(field_error(&r, "task_status", "Open is not a status"), "{r:?}");
    let code = uid(&pm
        .insert("Task", json!({"subject": "Code", "project": app.to_string(), "expected_hours": "30", "depends_on": [{"task": spec.to_string()}]}))
        .await);
    let r = pm.try_update("Task", code, json!({"task_status": qa})).await;
    assert!(field_error(&r, "status", "until these tasks are completed: TASK-"), "In QA is started, by its category: {r:?}");
    let done = pm.update("Task", spec, json!({"task_status": shipped})).await;
    assert_eq!((done["status_category"].clone(), dec(&done["progress"]), done["completed_on"].is_string()), (json!("Done"), n("100"), true));
    let coded = pm.update("Task", code, json!({"status": "in qa"})).await;
    assert_eq!((coded["status"].clone(), coded["task_status"].clone()), (json!("In QA"), qa.clone()), "a name chooses its status");
    // % complete: (100 × 10 + 0 × 30) / 40; then Code's sub-task stands for it.
    assert_eq!(dec(&pm.get("Project", app).await["proj_percent_complete"]), n("25"));
    pm.insert("Task", json!({"subject": "Unit tests", "project": app.to_string(), "expected_hours": "10", "parent_task": code.to_string()})).await;
    assert_eq!(dec(&pm.get("Project", app).await["proj_percent_complete"]), n("50"), "Spec and Unit tests, not Code as well");
    // A project's own workflow wins over its type's.
    let standard = pm.find_one("TaskWorkflow", json!({"workflow_name": "Standard"})).await;
    let own = uid(&pm
        .insert("Project", json!({"project_name": "Own", "company": w.cid, "proj_project_type": kind["id"], "proj_task_workflow": standard["id"]}))
        .await);
    assert_eq!(pm.insert("Task", json!({"subject": "Mine", "project": own.to_string()})).await["status"], json!("Open"));
    // Completing with force cancels into the workflow's cancelled status.
    pm.action("Project", app, "complete", json!({"force": "Yes"})).await;
    let code = pm.get("Task", code).await;
    assert_eq!((code["status"].clone(), code["status_category"].clone()), (json!("Dropped"), json!("Cancelled")));
}

/// A workspace from before statuses were records: the release's SQL gives it the six it had, the
/// Standard workflow, and each task its status record and category.
async fn upgrade(w: &World) {
    let k = &w.admin.k;
    let mut tx = k.db.system_tx().await.unwrap();
    sqlx::raw_sql(
        "select set_config('ferrum.system', 'on', true); \
         update e_task set task_status = null, status_category = null; \
         delete from e_task_workflow__statuses; delete from e_project_type; delete from e_task_workflow; \
         update e_task_status set late_status = null; delete from e_task_status;",
    )
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!("../packages/projects/sql/001_task_statuses.sql")).execute(&mut *tx).await.unwrap();
    sqlx::raw_sql(include_str!("../packages/projects/sql/001_task_statuses.sql")).execute(&mut *tx).await.expect("twice changes nothing");
    tx.commit().await.unwrap();
    let pm = &w.users["pm"];
    let names: Vec<String> = pm.list("TaskStatus", json!({})).await.iter().map(|s| s["status_name"].as_str().unwrap().to_string()).collect();
    assert_eq!(names.len(), 6, "{names:?}");
    let standard = pm.find_one("TaskWorkflow", json!({"is_default": true})).await;
    assert_eq!(pm.get("TaskWorkflow", uid(&standard)).await["statuses"].as_array().unwrap().len(), 6);
    let late = pm.find_one("Task", json!({"subject": "Late"})).await;
    let overdue = pm.find_one("TaskStatus", json!({"status_name": "Overdue"})).await;
    assert_eq!((late["task_status"].clone(), late["status_category"].clone()), (overdue["id"].clone(), json!("To Do")));
    let first = pm.find_one("Task", json!({"subject": "First"})).await;
    assert_eq!(first["status_category"], json!("To Do"));
    let moved = pm.update("Task", uid(&late), json!({"exp_end_date": (Utc::now().date_naive() + Duration::days(2)).to_string()})).await;
    assert_eq!(moved["status"], json!("Open"), "Open's late status, found again");
}

/// PJ-42, PJ-43: a week of days and hours (clock times still work beside them), a timer, approval
/// before submitting by the workspace's policy with the approvers the app names, and reminders.
async fn weekly_time(w: &World) {
    let (admin, pm) = (&w.admin, &w.users["pm"]);
    let (mia, boss, nora) = (&reload(&w.users["mia"]).await, &reload(&w.users["boss"]).await, &reload(&w.users["nora"]).await);
    let today = Utc::now().date_naive();
    let monday = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let day = |n: i64| (monday + Duration::days(n)).to_string();
    let services = admin.find_one("ItemGroup", json!({"group_name": "Services"})).await;
    let hour = admin.find_one("Uom", json!({"uom_name": "Hour"})).await;
    let item = admin
        .insert("Item", json!({"item_code": "SVC-WEEK", "item_name": "Week", "item_group": services["id"], "stock_uom": hour["id"], "is_stock_item": false}))
        .await;
    let build =
        pm.insert("ActivityType", json!({"activity_type": "Build", "billing_rate": "100", "costing_rate": "60", "item": item["id"]})).await["id"].clone();
    let proj = uid(&pm
        .insert(
            "Project",
            json!({"project_name": "Billable", "company": w.cid, "customer": w.globex, "proj_billing_method": "Time and Materials", "proj_project_manager": "boss@acme.test"}),
        )
        .await);
    let wiring = pm.insert("Task", json!({"subject": "Wiring", "project": proj.to_string()})).await["id"].clone();
    let line = |d: String, hours: &str| json!({"activity_type": build, "project": proj.to_string(), "day": d, "hours": hours});
    let sheet = mia
        .insert(
            "Timesheet",
            json!({"company": w.cid, "week_start": day(0), "time_logs": [line(day(0), "3"), line(day(1), "4.5"),
                {"activity_type": build, "project": proj.to_string(), "from_time": format!("{}T09:00:00Z", day(2)), "to_time": format!("{}T10:00:00Z", day(2))}]}),
        )
        .await;
    assert_eq!((dec(&sheet["total_hours"]), dec(&sheet["total_billable_amount"])), (n("8.5"), n("850")));
    assert_eq!((sheet["start_date"].clone(), sheet["end_date"].clone(), sheet["time_logs"][2]["day"].clone()), (json!(day(0)), json!(day(2)), json!(day(2))));
    assert_eq!(sheet["approvers"], json!(["boss@acme.test"]), "the project's manager");
    let sheet = uid(&sheet);
    let bad = |logs: Value| json!({"company": w.cid, "week_start": day(0), "time_logs": logs});
    let r = mia.try_insert("Timesheet", bad(json!([line(day(7), "1")]))).await;
    assert!(field_error(&r, "day", "outside the week"), "{r:?}");
    let r = mia.try_insert("Timesheet", bad(json!([{"activity_type": build, "project": proj.to_string(), "hours": "1"}]))).await;
    assert!(field_error(&r, "day", "set the day and the hours"), "{r:?}");
    let r = mia.try_insert("Timesheet", bad(json!([line(day(1), "0")]))).await;
    assert!(field_error(&r, "hours", "set the hours"), "{r:?}");

    // A timer runs on today's line for the task, and stops into its hours.
    mia.action("Timesheet", sheet, "start_timer", json!({"activity_type": build, "project": proj.to_string(), "task": wiring})).await;
    let running = mia.get("Timesheet", sheet).await;
    let timed = running["time_logs"].as_array().unwrap().iter().find(|r| r["timer_started"].is_string()).cloned().expect("a running line");
    assert_eq!((timed["day"].clone(), timed["task"].clone()), (json!(today.to_string()), wiring.clone()));
    let mut tx = admin.k.db.tenant_tx(admin.ctx.tenant).await.unwrap();
    sqlx::query("update e_timesheet__time_logs set timer_started = now() - interval '2 hours' where parent_id = $1 and timer_started is not null")
        .bind(sheet)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let stopped = mia.action("Timesheet", sheet, "stop_timer", json!({})).await;
    let added = dec(&stopped["hours_added"]);
    assert!(added >= n("2") && added < n("2.1"), "{stopped}");
    let after = mia.get("Timesheet", sheet).await;
    assert!(after["time_logs"].as_array().unwrap().iter().all(|r| r["timer_started"].is_null()));
    assert_eq!(dec(&after["total_hours"]), n("8.5") + added);

    // The package asks for approval before a timesheet is submitted, of the approvers the app names.
    let (mia, boss) = (&reload(mia).await, &reload(boss).await);
    let asked = mia.k.submit(&mia.ctx, "Timesheet", sheet, None).await.expect("asked");
    assert_eq!((asked["docstatus"].as_i64(), asked["_approval"]["status"].as_str()), (Some(0), Some("pending")), "{asked:?}");
    assert!(mia.try_update("Timesheet", sheet, json!({"note": "more"})).await.is_err(), "locked while it waits");
    let no = boss.k.decide_approval(&boss.ctx, "Timesheet", sheet, false, Some("Tuesday looks long")).await.expect("rejected");
    assert_eq!(no["status"].as_str(), Some("rejected"), "{no}");
    mia.update("Timesheet", sheet, json!({"note": "Tuesday was the launch"})).await;
    mia.k.submit(&mia.ctx, "Timesheet", sheet, None).await.expect("asked again");
    boss.k.decide_approval(&boss.ctx, "Timesheet", sheet, true, Some("fine")).await.expect("approved");
    let done = pm.get("Timesheet", sheet).await;
    assert_eq!((done["docstatus"].as_i64(), done["status"].clone()), (Some(1), json!("Submitted")), "approved is submitted, and locked");
    assert_eq!(dec(&pm.get("Project", proj).await["proj_actual_hours"]), n("8.5") + added);
    // Days without clock times are billed like any time.
    let si = pm.action("Project", proj, "make_sales_invoice", json!({"to_date": day(1)})).await;
    assert_eq!(si["logs"], json!(if today <= monday + Duration::days(1) { 3 } else { 2 }), "{si}");

    // The person's manager instead, from their Person record.
    admin.insert("ProjectsSettings", json!({"timesheet_approver": "Person's Manager"})).await;
    pm.insert("ProjectPerson", json!({"user": "nora@acme.test", "manager": "lead@acme.test", "weekly_hours": "1"})).await;
    let hers = nora.insert("Timesheet", json!({"company": w.cid, "time_logs": [line(today.to_string(), "2")]})).await;
    assert_eq!(hers["approvers"], json!(["lead@acme.test"]));

    // Reminders: from the reminder day on, once a week, to each person short of their hours.
    let settings = admin.find_one("ProjectsSettings", json!({})).await;
    admin.update("ProjectsSettings", uid(&settings), json!({"reminder_weekday": today.weekday().number_from_monday()})).await;
    pm.insert("ProjectPerson", json!({"user": "mia@acme.test", "weekly_hours": "40"})).await;
    pm.insert("ProjectPerson", json!({"user": "vic@acme.test", "weekly_hours": "8"})).await;
    let told = || async {
        let mut tx = admin.k.db.system_tx().await.unwrap();
        let who: Vec<String> = sqlx::query_scalar("select recipient from message_send where template = 'projects.time_missing' order by recipient")
            .fetch_all(&mut *tx)
            .await
            .unwrap();
        tx.commit().await.unwrap();
        who
    };
    ferrum_app_projects::maintenance(&admin.k).await.expect("upkeep");
    assert_eq!(told().await, ["mia@acme.test", "vic@acme.test"], "Mia has 10.5 of 40, Vic nothing of 8; Nora has her hour");
    ferrum_app_projects::maintenance(&admin.k).await.expect("upkeep again");
    assert_eq!(told().await.len(), 2, "once a week");
}

/// PJ-01: a project saved as a template keeps its tree, dependencies, estimates and team, dates as
/// days from its start and people as roles; a project made from it gets them back, dates shifted on
/// a business calendar's working days.
async fn templates(w: &World) {
    let (pm, mia) = (&w.users["pm"], &reload(&w.users["mia"]).await);
    let members = json!([{"person": "lead@acme.test", "project_role": "Manager"}, {"person": "mia@acme.test", "project_role": "Member"}]);
    let kit = uid(&pm
        .insert(
            "Project",
            json!({"project_name": "Launch kit", "company": w.cid, "start_date": "2027-03-01", "proj_billing_method": "Non-billable", "proj_members": members}),
        )
        .await);
    let task = |v: Value| async move { pm.insert("Task", v).await["id"].clone() };
    let phase = task(json!({"subject": "Phase", "project": kit.to_string(), "exp_start_date": "2027-03-01", "exp_end_date": "2027-03-08"})).await;
    let design =
        task(json!({"subject": "Design", "project": kit.to_string(), "parent_task": phase, "exp_start_date": "2027-03-02", "exp_end_date": "2027-03-04",
        "expected_hours": "12", "assigned_to": [{"user": "mia@acme.test"}]}))
        .await;
    let build =
        task(json!({"subject": "Build", "project": kit.to_string(), "parent_task": phase, "exp_start_date": "2027-03-05", "exp_end_date": "2027-03-08",
        "depends_on": [{"task": design}], "assigned_to": [{"user": "lead@acme.test"}]}))
        .await;
    task(json!({"subject": "Go live", "project": kit.to_string(), "is_milestone": true, "exp_start_date": "2027-03-09", "exp_end_date": "2027-03-09", "depends_on": [{"task": build}]}))
        .await;

    let saved = pm.action("Project", kit, "save_as_template", json!({"template_name": "Launch template"})).await;
    assert_eq!(saved["tasks"], json!(4));
    let tpl = saved["id"].as_str().unwrap().parse::<Uuid>().unwrap();
    let t = pm.get("Project", tpl).await;
    assert_eq!((t["proj_is_template"].clone(), t["proj_members"].as_array().unwrap().len()), (json!(true), 2));
    let in_tpl =
        |name: &'static str| async move { pm.get("Task", uid(&pm.find_one("Task", json!({"project": tpl.to_string(), "subject": name})).await)).await };
    let (tdesign, tbuild) = (in_tpl("Design").await, in_tpl("Build").await);
    assert_eq!((tdesign["start_offset"].clone(), tdesign["end_offset"].clone(), tdesign["assignee_role"].clone()), (json!(1), json!(3), json!("Member")));
    assert!(tdesign["exp_start_date"].is_null() && tdesign["assigned_to"].as_array().unwrap().is_empty(), "days, not dates; roles, not people");
    assert_eq!(tdesign["parent_task"], in_tpl("Phase").await["id"], "the tree is kept");
    assert_eq!(tbuild["depends_on"][0]["task"], tdesign["id"], "and what waits for what");
    let r = mia
        .try_insert(
            "Timesheet",
            json!({"company": w.cid, "time_logs": [{"activity_type": pm.find_one("ActivityType", json!({"activity_type": "Build"})).await["id"],
            "project": tpl.to_string(), "day": "2027-03-01", "hours": "1"}]}),
        )
        .await;
    assert!(field_error(&r, "project", "is a template"), "{r:?}");

    // A project from it, starting on a Friday, on the office's working days.
    let mut tx = w.admin.k.db.tenant_tx(w.admin.ctx.tenant).await.unwrap();
    sqlx::query("insert into logic_calendar (tenant_id, name, zone, weekends, holidays) values ($1, 'office', 'UTC', '{sat,sun}', '{}')")
        .bind(w.admin.ctx.tenant)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let made =
        pm.action("Project", tpl, "create_from_template", json!({"project_name": "Launch June", "start_date": "2027-06-04", "calendar": "office"})).await;
    let june = made["id"].as_str().unwrap().parse::<Uuid>().unwrap();
    let in_june =
        |name: &'static str| async move { pm.get("Task", uid(&pm.find_one("Task", json!({"project": june.to_string(), "subject": name})).await)).await };
    let (jdesign, jbuild) = (in_june("Design").await, in_june("Build").await);
    assert_eq!((jdesign["exp_start_date"].clone(), jdesign["exp_end_date"].clone()), (json!("2027-06-07"), json!("2027-06-09")), "working days from Friday");
    assert_eq!((jbuild["exp_start_date"].clone(), jbuild["exp_end_date"].clone()), (json!("2027-06-10"), json!("2027-06-15")));
    assert_eq!(jdesign["assigned_to"][0]["user"], json!("mia@acme.test"), "the team's member");
    assert_eq!(jbuild["assigned_to"][0]["user"], json!("lead@acme.test"), "the team's manager");
    assert_eq!(jbuild["depends_on"][0]["task"], jdesign["id"]);
    let p = pm.get("Project", june).await;
    assert_eq!((p["proj_is_template"].clone(), p["start_date"].clone(), p["end_date"].clone()), (json!(false), json!("2027-06-04"), json!("2027-06-16")));
    assert_eq!(jdesign["status"], json!("Open"), "its workflow's first status");
    // Without a calendar, calendar days.
    let plain = pm.action("Project", tpl, "create_from_template", json!({"project_name": "Launch plain", "start_date": "2027-06-04"})).await;
    let d = pm.find_one("Task", json!({"project": plain["id"], "subject": "Design"})).await;
    assert_eq!(d["exp_start_date"], json!("2027-06-05"));
    let r = pm.try_action("Project", tpl, "create_from_template", json!({"project_name": "X", "start_date": "2027-06-04", "calendar": "nowhere"})).await;
    assert!(field_error(&r, "calendar", "no business calendar"), "{r:?}");
}

/// PJ-46: rate cards by project, customer, role on the project, person and activity, with dates and
/// a stated order; costs on their own; an invoice in the customer's currency at the day's rate.
/// The billing and costing rates an hour of `advice` today on `project` takes for `who` (a draft
/// made, read back and dropped).
async fn rate_today(w: &World, who: &U, advice: &Value, project: Uuid, today: chrono::NaiveDate) -> (Decimal, Decimal) {
    let sheet = who
        .insert(
            "Timesheet",
            json!({"company": w.cid, "time_logs": [{"activity_type": advice, "project": project.to_string(), "day": today.to_string(), "hours": "1"}]}),
        )
        .await;
    let row = w.users["pm"].get("Timesheet", uid(&sheet)).await["time_logs"][0].clone();
    who.k.delete(&who.ctx, "Timesheet", uid(&sheet), None).await.unwrap();
    (dec(&row["billing_rate"]), dec(&row["costing_rate"]))
}

async fn rates(w: &World) {
    let (admin, pm) = (&w.admin, &w.users["pm"]);
    let (mia, lead) = (&reload(&w.users["mia"]).await, &reload(&w.users["lead"]).await);
    let today = Utc::now().date_naive();
    let services = admin.find_one("ItemGroup", json!({"group_name": "Services"})).await;
    let hour = admin.find_one("Uom", json!({"uom_name": "Hour"})).await;
    let item = admin
        .insert(
            "Item",
            json!({"item_code": "SVC-ADVICE", "item_name": "Advice", "item_group": services["id"], "stock_uom": hour["id"], "is_stock_item": false}),
        )
        .await;
    let advice =
        pm.insert("ActivityType", json!({"activity_type": "Advice", "billing_rate": "100", "costing_rate": "50", "item": item["id"]})).await["id"].clone();
    let usd = admin.find_one("Currency", json!({"code": "USD"})).await;
    let rated = uid(&pm
        .insert(
            "Project",
            json!({"project_name": "Rated", "company": w.cid, "customer": w.globex, "proj_billing_method": "Time and Materials",
                   "proj_members": [{"person": "lead@acme.test", "project_role": "Manager"}, {"person": "mia@acme.test", "project_role": "Member"}]}),
        )
        .await);
    assert_eq!(rate_today(w, mia, &advice, rated, today).await, (n("100"), n("50")), "the activity type's");
    let card = |v: Value| async move { pm.insert("RateCard", v).await };
    card(json!({"label": "Advice", "activity_type": advice, "billing_rate": "110"})).await;
    assert_eq!(rate_today(w, mia, &advice, rated, today).await.0, n("110"));
    card(json!({"label": "Mia", "user": "mia@acme.test", "billing_rate": "120", "costing_rate": "70"})).await;
    assert_eq!(rate_today(w, mia, &advice, rated, today).await, (n("120"), n("70")), "a person beats an activity");
    card(json!({"label": "Members", "project_role": "Member", "billing_rate": "125"})).await;
    assert_eq!(rate_today(w, mia, &advice, rated, today).await, (n("125"), n("70")), "a role beats a person; her cost stays hers");
    card(json!({"label": "Globex", "customer": w.globex, "billing_rate": "135"})).await;
    assert_eq!(rate_today(w, mia, &advice, rated, today).await.0, n("135"), "a customer beats a role");
    card(json!({"label": "Old deal", "project": rated.to_string(), "billing_rate": "160", "valid_to": (today - Duration::days(1)).to_string()})).await;
    assert_eq!(rate_today(w, mia, &advice, rated, today).await.0, n("135"), "a rate that has ended does not count");
    card(json!({"label": "Deal", "project": rated.to_string(), "billing_rate": "150", "valid_from": today.to_string()})).await;
    assert_eq!(rate_today(w, mia, &advice, rated, today).await, (n("150"), n("70")), "the project beats all");
    assert_eq!(rate_today(w, lead, &advice, rated, today).await, (n("150"), n("50")));
    let r = pm.try_insert("RateCard", json!({"label": "Bad", "valid_from": "2027-01-02", "valid_to": "2027-01-01"})).await;
    assert!(field_error(&r, "valid_to", "before it starts"), "{r:?}");

    // Invoiced in the customer's currency at the day's rate; the project's figures stay the company's.
    admin.insert("ExchangeRate", json!({"from_currency": usd["id"], "to_currency": w.admin.find_one("Currency", json!({"code": "INR"})).await["id"], "rate": "80", "valid_from": "2026-01-01"})).await;
    pm.update("Project", rated, json!({"proj_invoice_currency": usd["id"]})).await;
    let sheet = mia
        .insert(
            "Timesheet",
            json!({"company": w.cid, "time_logs": [{"activity_type": advice, "project": rated.to_string(), "day": today.to_string(), "hours": "2"}]}),
        )
        .await;
    // The workspace's approval from the step before, by project managers again: this project names
    // none, so its team's manager approves.
    let settings = admin.find_one("ProjectsSettings", json!({})).await;
    admin.update("ProjectsSettings", uid(&settings), json!({"timesheet_approver": "Project Manager"})).await;
    mia.update("Timesheet", uid(&sheet), json!({"note": "approvers again"})).await;
    mia.k.submit(&mia.ctx, "Timesheet", uid(&sheet), None).await.expect("asked");
    lead.k.decide_approval(&lead.ctx, "Timesheet", uid(&sheet), true, Some("ok")).await.expect("approved by the team's manager");
    assert_eq!(pm.get("Timesheet", uid(&sheet)).await["docstatus"], json!(1));
    let si = pm.action("Project", rated, "make_sales_invoice", json!({})).await;
    let inv = pm.get("SalesInvoice", si["id"].as_str().unwrap().parse().unwrap()).await;
    assert_eq!((inv["currency"].clone(), dec(&inv["conversion_rate"])), (usd["id"].clone(), n("80")));
    assert_eq!(dec(&inv["items"][0]["price_list_rate"]), n("1.875"), "150 rupees an hour at 80 to the dollar");
    assert_eq!(dec(&pm.get("Project", rated).await["proj_billable_amount"]), n("300"), "in the company's currency");
}

/// The four kinds of dependency with lags, cycles refused by name, and dates that follow.
async fn dependencies(w: &World) {
    let (admin, pm) = (&w.admin, &w.users["pm"]);
    let settings = admin.find_one("ProjectsSettings", json!({})).await;
    admin.update("ProjectsSettings", uid(&settings), json!({"move_with_dependencies": true, "schedule_calendar": "office"})).await;
    let p = uid(&pm.insert("Project", json!({"project_name": "Sched", "company": w.cid, "proj_billing_method": "Non-billable"})).await).to_string();
    let task = |subject: &'static str, start: &'static str, end: &'static str, deps: Value| {
        let p = p.clone();
        async move {
            pm.insert("Task", json!({"subject": subject, "project": p, "exp_start_date": start, "exp_end_date": end, "depends_on": deps})).await["id"].clone()
        }
    };
    let a = task("Pour", "2027-03-01", "2027-03-03", json!([])).await;
    let b = task("Cure", "2027-03-01", "2027-03-02", json!([{"task": a, "kind": "Finish to Start", "lag_days": 1}])).await;
    let c = task("Inspect", "2027-03-01", "2027-03-01", json!([{"task": b, "kind": "Start to Start"}])).await;
    let d = task("Clean up", "2027-03-01", "2027-03-01", json!([{"task": a, "kind": "Finish to Finish"}])).await;
    let id = |t: &Value| t.as_str().unwrap().parse::<Uuid>().unwrap();
    let r = pm.try_update("Task", id(&a), json!({"depends_on": [{"task": c}]})).await;
    assert!(field_error(&r, "depends_on", "Pour → TASK-") && field_error(&r, "depends_on", "Inspect"), "named: {r:?}");

    // Pour ends a day later (Thursday): Cure starts the working day after plus a day's lag (Monday),
    // its two days kept; Inspect starts with it; Clean up ends with Pour.
    pm.update("Task", id(&a), json!({"exp_end_date": "2027-03-04"})).await;
    let at = |t: &Value| {
        let t = t.clone();
        async move {
            let doc = pm.get("Task", t.as_str().unwrap().parse().unwrap()).await;
            (doc["exp_start_date"].as_str().unwrap().to_string(), doc["exp_end_date"].as_str().unwrap().to_string())
        }
    };
    assert_eq!(at(&b).await, ("2027-03-08".to_string(), "2027-03-09".to_string()));
    assert_eq!(at(&c).await, ("2027-03-08".to_string(), "2027-03-08".to_string()), "and the task after it in turn");
    assert_eq!(at(&d).await, ("2027-03-04".to_string(), "2027-03-04".to_string()));

    // What each kind holds back.
    let r = pm.try_update("Task", id(&c), json!({"status": "Working"})).await;
    assert!(field_error(&r, "status", "until these tasks have started"), "start to start: {r:?}");
    let r = pm.try_update("Task", id(&b), json!({"status": "Working"})).await;
    assert!(field_error(&r, "status", "until these tasks are completed"), "finish to start: {r:?}");
    pm.update("Task", id(&d), json!({"status": "Working"})).await;
    let r = pm.try_update("Task", id(&d), json!({"status": "Completed"})).await;
    assert!(field_error(&r, "status", "until these tasks are completed"), "finish to finish: {r:?}");
    pm.update("Task", id(&a), json!({"status": "Completed"})).await;
    pm.update("Task", id(&b), json!({"status": "Working"})).await;
    pm.update("Task", id(&c), json!({"status": "Working"})).await;
    pm.update("Task", id(&d), json!({"status": "Completed"})).await;
}

/// A portal person of the customer, holding the Project Client role.
async fn client(w: &World, email: &str) -> U {
    let k = &w.admin.k;
    let id = k.create_user(&w.admin.ctx, email, email, None, &["Project Client".to_string()], false).await.expect("user");
    k.set_user_kind(&w.admin.ctx, id, "portal").await.expect("a portal person");
    let version = k.token_version(w.admin.ctx.tenant, id).await.expect("token version");
    U { k: k.clone(), ctx: k.load_ctx(w.admin.ctx.tenant, id, Some(version), "it".into()).await.expect("ctx") }
}

fn names(rows: &[Doc], field: &str) -> Vec<String> {
    let mut v: Vec<String> = rows.iter().map(|r| r[field].as_str().unwrap().to_string()).collect();
    v.sort();
    v
}

/// The client portal: a customer's people read the projects of theirs that are shared, the tasks and milestones marked
/// visible, and the approved timesheets and invoices of a shared project; nothing of another customer's or of an internal
/// project. Also what the package asks of timesheets, and what erasure takes.
async fn client_portal(w: &World) {
    let (admin, pm, mia) = (&w.admin, &w.users["pm"], &reload(&w.users["mia"]).await);
    let globex: Uuid = w.globex.parse().unwrap();
    let initech = uid(&admin.insert("Customer", json!({"customer_name": "Initech"})).await);
    admin.update("Customer", globex, json!({"proj_portal_people": [{"email": "cleo@globex.test"}, {"email": "dan@globex.test"}]})).await;
    admin.update("Customer", initech, json!({"proj_portal_people": [{"email": "ian@initech.test"}]})).await;
    let (cleo, ian) = (&client(w, "cleo@globex.test").await, &client(w, "ian@initech.test").await);
    let project = |name: &str, customer: &str, shared: bool| json!({"project_name": name, "company": w.cid, "customer": customer, "proj_shared": shared, "proj_billing_method": "Non-billable"});
    let shared = uid(&pm.insert("Project", project("Shared Build", &w.globex, true)).await);
    let internal = uid(&pm.insert("Project", project("Internal Review", &w.globex, false)).await);
    let theirs = uid(&pm.insert("Project", project("Initech Rollout", &initech.to_string(), true)).await);
    let task = |subject: &str, project: Uuid, visible: bool, milestone: bool| json!({"subject": subject, "project": project.to_string(), "client_visible": visible, "is_milestone": milestone});
    pm.insert("Task", task("Kickoff", shared, true, true)).await;
    pm.insert("Task", task("Hidden chores", shared, false, false)).await;
    pm.insert("Task", task("Visible but internal", internal, true, false)).await;
    pm.insert("Task", task("Initech go-live", theirs, true, true)).await;

    // Their customer's shared project, its marked tasks and milestones: read, and nothing more.
    assert_eq!(names(&cleo.list("Project", json!({})).await, "project_name"), ["Shared Build"]);
    assert_eq!(names(&cleo.list("Task", json!({})).await, "subject"), ["Kickoff"], "marked visible, on a shared project");
    assert_eq!(names(&ian.list("Project", json!({})).await, "project_name"), ["Initech Rollout"]);
    assert!(denied(&cleo.try_get("Project", internal).await) && denied(&cleo.try_get("Project", theirs).await));
    assert!(denied(&cleo.try_update("Project", shared, json!({"notes": "mine"})).await), "read only");
    for internal_records in ["ProjectRisk", "ProjectIssue", "ChangeRequest", "ResourceAllocation"] {
        assert!(cleo.k.list(&cleo.ctx, internal_records, &Default::default()).await.is_err(), "no {internal_records}s for the client");
    }
    assert!(denied(&cleo.try_insert("Task", task("Gatecrash", shared, true, false)).await));

    // Approved timesheets of the shared project's time alone: not a draft, not time on several projects.
    let consult = pm.insert("ActivityType", json!({"activity_type": "Consult", "billing_rate": "100", "costing_rate": "50"})).await["id"].clone();
    let today = Utc::now().date_naive();
    let monday = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let line = |project: Uuid| json!({"activity_type": consult, "project": project.to_string(), "day": monday.to_string(), "hours": "2"});
    let sheet = |logs: Vec<Value>| json!({"company": w.cid, "week_start": monday.to_string(), "time_logs": logs});
    let draft = uid(&mia.insert("Timesheet", sheet(vec![line(shared)])).await);
    assert!(cleo.list("Timesheet", json!({})).await.is_empty(), "a draft is not approved");
    let own = mia.k.submit(&mia.ctx, "Timesheet", draft, None).await.expect("no approver named: it goes through");
    assert_eq!(own["status"], json!("Submitted"));
    let mixed = uid(&mia.insert("Timesheet", sheet(vec![line(shared), line(internal)])).await);
    mia.k.submit(&mia.ctx, "Timesheet", mixed, None).await.expect("submitted");
    assert_eq!(cleo.list("Timesheet", json!({})).await.iter().map(uid).collect::<Vec<_>>(), [draft], "only the sheet whose time is all on the shared project");
    assert!(denied(&cleo.try_get("Timesheet", mixed).await));
    assert!(ian.list("Timesheet", json!({})).await.is_empty());

    // Invoices of the shared project, once submitted.
    let billable = pm
        .insert(
            "Project",
            json!({"project_name": "Billed Build", "company": w.cid, "customer": w.globex, "proj_shared": true, "proj_billing_method": "Time and Materials"}),
        )
        .await;
    let billable = uid(&billable);
    let services = admin.find_one("ItemGroup", json!({"group_name": "Services"})).await;
    let hour = admin.find_one("Uom", json!({"uom_name": "Hour"})).await;
    let item = admin
        .insert(
            "Item",
            json!({"item_code": "SVC-CLIENT", "item_name": "Client work", "item_group": services["id"], "stock_uom": hour["id"], "is_stock_item": false}),
        )
        .await;
    let billed =
        pm.insert("ActivityType", json!({"activity_type": "Billed", "billing_rate": "80", "costing_rate": "40", "item": item["id"]})).await["id"].clone();
    let bl = json!({"activity_type": billed, "project": billable.to_string(), "day": monday.to_string(), "hours": "3"});
    let ts = uid(&mia.insert("Timesheet", sheet(vec![bl])).await);
    mia.k.submit(&mia.ctx, "Timesheet", ts, None).await.expect("submitted");
    pm.action("Project", billable, "make_sales_invoice", json!({})).await;
    let invoice = uid(&admin.find_one("SalesInvoice", json!({"project": billable.to_string()})).await);
    assert!(cleo.list("SalesInvoice", json!({})).await.is_empty(), "a draft invoice is not theirs yet");
    admin.k.submit(&admin.ctx, "SalesInvoice", invoice, None).await.expect("the invoice is submitted");
    assert_eq!(cleo.list("SalesInvoice", json!({})).await.iter().map(uid).collect::<Vec<_>>(), [invoice]);
    assert!(ian.list("SalesInvoice", json!({})).await.is_empty());

    // Unsharing takes everything back at once; sharing again gives it back.
    pm.update("Project", shared, json!({"proj_shared": false})).await;
    pm.update("Project", billable, json!({"proj_shared": false})).await;
    assert!(cleo.list("Project", json!({})).await.is_empty() && cleo.list("Task", json!({})).await.is_empty());
    assert!(cleo.list("Timesheet", json!({})).await.is_empty() && cleo.list("SalesInvoice", json!({})).await.is_empty());
    pm.update("Project", shared, json!({"proj_shared": true})).await;
    assert_eq!(names(&cleo.list("Task", json!({})).await, "subject"), ["Kickoff"]);
    assert_eq!(cleo.list("Timesheet", json!({})).await.len(), 1);

    // Erasure takes a person off the customer's list and off a project's team.
    admin.k.erase_personal_data(&admin.ctx, "dan@globex.test", "asked").await.expect("a client person erased");
    let people = admin.get("Customer", globex).await["proj_portal_people"].as_array().unwrap().iter().map(|p| p["email"].clone()).collect::<Vec<_>>();
    assert_eq!(people, [json!("cleo@globex.test")]);
    admin.k.erase_personal_data(&admin.ctx, "vic@acme.test", "asked").await.expect("a team member erased");
    let secret = admin.find_one("Project", json!({"project_name": "Secret"})).await;
    let secret = Value::Object(admin.get("Project", uid(&secret)).await);
    assert!(!secret.to_string().contains("vic@acme.test"), "{secret}");
    assert!(secret.to_string().contains("lead@acme.test"), "the others stay");
}
