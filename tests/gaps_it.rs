//! The rows Projects closes in the gap program, one section per slice, against a real PostgreSQL
//! (`FERRUM_PROJECTS6_TEST_DATABASE_URL`, default `postgres://ferrum:ferrum@localhost:5432/ferrum_projects6_test`).
//! The database is reset first.

use chrono::{Duration, Utc};
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
    let url = std::env::var("FERRUM_PROJECTS6_TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://ferrum:ferrum@localhost:5432/ferrum_projects6_test".into());
    let db = Db::connect(DbConfig { url, max_connections: 10, ..Default::default() }).await.expect("connect");
    sqlx::raw_sql("drop schema if exists public cascade; create schema public;").execute(&db.pool).await.expect("reset");
    let mut packages = ferrum_domain::packages().expect("platform packages");
    packages.extend(ferrum_app_erp::packages().expect("ERP's packages"));
    packages.extend(ferrum_app_projects::packages().expect("app packages"));
    let catalog = Catalog::from_packages(packages).expect("catalog");
    let mut hooks = HookRegistry::default();
    ferrum_domain::register(&mut hooks);
    hooks.app("erp", &[], ferrum_app_erp::register);
    ferrum_app_projects::register(&mut hooks);
    for source in ferrum_app_projects::reports() {
        ferrum_domain::reports::add_source(source);
    }
    let k = Kernel::boot(db, catalog, hooks, KernelSettings::default(), None).await.expect("boot");
    ferrum_domain::maintenance(&k).await.expect("domain maintenance");
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
    async fn report(&self, name: &str, params: &[(&str, String)]) -> Result<Value> {
        let p: HashMap<String, String> = params.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
        ferrum_domain::reports::run(&self.k, &self.ctx, name, &p).await
    }
    async fn find_one(&self, entity: &str, filters: Value) -> Doc {
        let rows = self.list(entity, filters.clone()).await;
        assert_eq!(rows.len(), 1, "{entity} {filters}");
        rows[0].clone()
    }
}

/// The user signed in again, with their roles' rules as they are now.
async fn reload(u: &U) -> U {
    U { k: u.k.clone(), ctx: u.k.load_ctx(u.ctx.tenant, u.ctx.user, None, "it".into()).await.unwrap() }
}

#[test]
fn gaps() {
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
    baselines(&w).await;
    earned_value(&w).await;
}

/// A key for one effect, through the gate as an agent asks.
fn invocation(capability: &str, input: Value, key: &str) -> ferrum_kernel::capability::Invocation {
    ferrum_kernel::capability::Invocation::new(capability, input).key(key)
}

/// PRJ-01: a baseline, set when someone who may change the project wants one, keeps the plan's figures and each
/// task's dates and hours as they stood; it never moves and is never edited.
async fn baselines(w: &World) {
    let (pm, lead, vic, nora) = (&w.users["pm"], &reload(&w.users["lead"]).await, &reload(&w.users["vic"]).await, &reload(&w.users["nora"]).await);
    let k = &pm.k;
    let start = chrono::NaiveDate::from_ymd_opt(2027, 1, 4).unwrap();
    let day = |n: i64| (start + Duration::days(n)).to_string();
    let launch = uid(&pm
        .insert(
            "Project",
            json!({"project_name": "Launch", "company": w.cid, "customer": w.globex, "start_date": day(0), "end_date": day(30), "proj_estimated_hours": "100",
                   "proj_estimated_cost": "5000", "budget": "6000",
                   "proj_members": [{"person": "lead@acme.test", "project_role": "Manager"}, {"person": "vic@acme.test", "project_role": "Viewer"}]}),
        )
        .await);
    let task = |subject: &str, from: i64, to: i64, more: Value| {
        let mut t = json!({"subject": subject, "project": launch.to_string(), "exp_start_date": day(from), "exp_end_date": day(to), "expected_hours": "8"});
        t.as_object_mut().unwrap().extend(more.as_object().unwrap().clone());
        t
    };
    let plan = uid(&pm.insert("Task", task("Plan", 0, 4, json!({}))).await);
    let build = uid(&pm.insert("Task", task("Build", 5, 20, json!({}))).await);
    let wire = uid(&pm.insert("Task", task("Wire", 5, 10, json!({"parent_task": build.to_string()}))).await);
    let dropped = uid(&pm.insert("Task", task("Dropped", 0, 2, json!({}))).await);
    pm.update("Task", dropped, json!({"status": "Cancelled"})).await;

    // a_baseline_keeps_the_plan
    let set = lead.action("Project", launch, "set_baseline", json!({"name": "Kick-off"})).await;
    assert_eq!((set["entity"].clone(), set["tasks"].clone()), (json!("ProjectBaseline"), json!(3)), "{set}");
    let kickoff: Uuid = set["id"].as_str().unwrap().parse().unwrap();
    let b = pm.get("ProjectBaseline", kickoff).await;
    assert_eq!(
        (b["baseline_name"].clone(), b["project"].clone(), b["taken_by"].clone(), b["taken_on"].clone(), b["start_date"].clone(), b["end_date"].clone()),
        (json!("Kick-off"), json!(launch.to_string()), json!("lead@acme.test"), json!(Utc::now().date_naive().to_string()), json!(day(0)), json!(day(30)))
    );
    assert_eq!(
        (dec(&b["estimated_hours"]), dec(&b["estimated_cost"]), dec(&b["budget"]), b["contract_value"].clone()),
        (n("100"), n("5000"), n("6000"), Value::Null)
    );
    let line = |b: &Doc, t: Uuid| b["tasks"].as_array().unwrap().iter().find(|l| l["task"] == json!(t.to_string())).cloned();
    assert!(line(&b, dropped).is_none(), "a cancelled task is not planned");
    for (t, from, to) in [(plan, 0, 4), (build, 5, 20), (wire, 5, 10)] {
        let l = line(&b, t).unwrap_or_else(|| panic!("a line for {t}: {b:?}"));
        assert_eq!((l["exp_start_date"].clone(), l["exp_end_date"].clone(), dec(&l["expected_hours"])), (json!(day(from)), json!(day(to)), n("8")));
        assert_eq!(l["has_subtasks"], json!(t == build), "{l}");
    }

    // a_baseline_does_not_move
    pm.update("Task", plan, json!({"exp_start_date": day(2), "exp_end_date": day(8)})).await;
    let b = pm.get("ProjectBaseline", kickoff).await;
    assert_eq!(line(&b, plan).unwrap()["exp_end_date"], json!(day(4)), "the plan as it stood");

    // a_name_is_used_once
    let r = lead.try_action("Project", launch, "set_baseline", json!({"name": "Kick-off"})).await;
    assert!(matches!(r, Err(Error::Conflict(_))), "{r:?}");
    let r = lead.try_action("Project", launch, "set_baseline", json!({"name": "   "})).await;
    assert!(field_error(&r, "name", ""), "a name is asked for: {r:?}");
    lead.action("Project", launch, "set_baseline", json!({"name": "Week 2"})).await;

    // the_same_key_makes_one
    let ask = || invocation("projects.project.set_baseline", json!({"id": launch.to_string(), "params": {"name": "Agent"}}), "b:1");
    let first = k.invoke(&lead.ctx, ask()).await.expect("set");
    let again = k.invoke(&lead.ctx, ask()).await.expect("answered");
    assert!(!first.repeated && again.repeated);
    assert_eq!(pm.list("ProjectBaseline", json!({"baseline_name": "Agent"})).await.len(), 1);

    // only_who_may_change_the_project
    assert!(denied(&vic.try_action("Project", launch, "set_baseline", json!({"name": "Viewer's"})).await), "a viewer changes nothing");
    for who in [pm, lead] {
        let r = who.try_insert("ProjectBaseline", json!({"baseline_name": "By hand", "project": launch.to_string()})).await;
        assert!(matches!(r, Err(Error::Forbidden(_))), "nobody makes one by hand: {r:?}");
        let r = who.try_update("ProjectBaseline", kickoff, json!({"baseline_name": "Renamed"})).await;
        assert!(matches!(r, Err(Error::Forbidden(_))), "nor edits one: {r:?}");
    }

    // privacy_follows
    assert_eq!(nora.list("ProjectBaseline", json!({"project": launch.to_string()})).await.len(), 3, "an open project's baselines");
    pm.update("Project", launch, json!({"proj_private": true})).await;
    assert!(nora.list("ProjectBaseline", json!({"project": launch.to_string()})).await.is_empty(), "made private, it takes its baselines");
    assert!(denied(&nora.try_get("ProjectBaseline", kickoff).await));
    assert_eq!(vic.list("ProjectBaseline", json!({"project": launch.to_string()})).await.len(), 3, "its team still reads them");

    // a_deleted_task_stays_on_the_baseline
    k.delete(&pm.ctx, "Task", plan, None).await.expect("delete the task");
    let b = pm.get("ProjectBaseline", kickoff).await;
    let gone = b["tasks"].as_array().unwrap().iter().find(|l| l["subject"] == json!("Plan")).cloned().expect("its line stays");
    assert_eq!((gone["task"].clone(), gone["exp_end_date"].clone()), (Value::Null, json!(day(4))));

    // the_first_approved_change_takes_one
    let changed = uid(&pm.insert("Project", json!({"project_name": "Changed", "company": w.cid, "start_date": day(0), "end_date": day(30)})).await);
    let t = uid(&pm.insert("Task", json!({"subject": "Survey", "project": changed.to_string(), "exp_start_date": day(1), "exp_end_date": day(3)})).await);
    let raise = |title: &str| {
        let title = title.to_string();
        async move {
            let cr = uid(&pm.insert("ChangeRequest", json!({"title": title, "project": changed.to_string(), "reason": "Asked", "days_impact": 5})).await);
            pm.k.submit(&pm.ctx, "ChangeRequest", cr, None).await.expect("submit");
            w.admin.action("ChangeRequest", cr, "approve", json!({})).await;
            pm.get("ChangeRequest", cr).await
        }
    };
    let cr = raise("More rooms").await;
    let all = pm.list("ProjectBaseline", json!({"project": changed.to_string()})).await;
    assert_eq!(all.len(), 1, "{all:?}");
    let name = format!("{} More rooms", cr["number"].as_str().unwrap());
    assert_eq!(all[0]["baseline_name"], json!(name));
    let b = pm.get("ProjectBaseline", uid(&all[0])).await;
    assert_eq!((b["end_date"].clone(), line(&b, t).unwrap()["exp_end_date"].clone()), (json!(day(30)), json!(day(3))), "as it was before the change");
    let p = pm.get("Project", changed).await;
    assert_eq!((p["proj_baseline_end_date"].clone(), p["end_date"].clone()), (json!(day(30)), json!(day(35))), "the five figures as before");
    raise("Fewer rooms").await;
    assert_eq!(pm.list("ProjectBaseline", json!({"project": changed.to_string()})).await.len(), 1, "a second change adds none");
}

/// PRJ-08: earned value as of today, per project the caller may read, for those who may see costs: planned value from
/// the latest baseline's tasks, earned value from % complete, actual cost from submitted time and the ledger.
async fn earned_value(w: &World) {
    let (admin, pm, mia) = (&w.admin, &w.users["pm"], &reload(&w.users["mia"]).await);
    let k = &pm.k;
    let today = Utc::now().date_naive();
    let day = |n: i64| (today + Duration::days(n)).to_string();
    let co = ("company", w.cid.clone());
    let row = |r: &Value, name: &str| r["rows"].as_array().unwrap().iter().find(|x| x["project"].as_str().is_some_and(|p| p.ends_with(name))).cloned();
    // Time is submitted straight away here.
    let off: ferrum_kernel::customize::NewCustomization =
        serde_json::from_value(json!({"entity": "Timesheet", "op": {"op": "set_approval", "on": "submit", "approval": null}})).unwrap();
    k.batch_customizations(&admin.ctx, vec![off], false).await.map_err(|(_, e)| e).expect("approval off");
    let survey = pm.insert("ActivityType", json!({"activity_type": "Survey", "costing_rate": "600"})).await["id"].clone();

    // earned_value_adds_up: 10,000 to spend; half the plan due and done; 6,000 spent.
    let ev = uid(&pm
        .insert("Project", json!({"project_name": "Earned", "company": w.cid, "proj_estimated_cost": "10000", "start_date": day(-5), "end_date": day(6)}))
        .await);
    let first = uid(&pm
        .insert("Task", json!({"subject": "Dig", "project": ev.to_string(), "expected_hours": "10", "exp_start_date": day(-5), "exp_end_date": day(-1)}))
        .await);
    pm.insert("Task", json!({"subject": "Pour", "project": ev.to_string(), "expected_hours": "10", "exp_start_date": day(1), "exp_end_date": day(6)})).await;
    pm.action("Project", ev, "set_baseline", json!({"name": "Plan"})).await;
    pm.update("Task", first, json!({"status": "Completed"})).await;
    let sheet = pm
        .insert("Timesheet", json!({"company": w.cid, "time_logs": [{"activity_type": survey, "project": ev.to_string(), "day": day(-1), "hours": "10"}]}))
        .await;
    pm.k.submit(&pm.ctx, "Timesheet", uid(&sheet), None).await.expect("time submitted");
    let r = pm.report("earned_value", std::slice::from_ref(&co)).await.expect("earned value");
    let e = row(&r, "Earned").unwrap_or_else(|| panic!("{r}"));
    let figures: Vec<Decimal> = [
        "budget_at_completion",
        "planned_value",
        "earned_value",
        "actual_cost",
        "schedule_variance",
        "cost_variance",
        "schedule_index",
        "cost_index",
        "estimate_at_completion",
    ]
    .iter()
    .map(|f| dec(&e[*f]))
    .collect();
    assert_eq!(figures, [n("10000"), n("5000"), n("5000"), n("6000"), n("0"), n("-1000"), n("1"), n("0.83"), n("12000")], "{e}");
    assert_eq!((e["baseline"].clone(), r["meta"]["as_of"].clone()), (json!("Plan"), json!(today.to_string())));

    // without_a_baseline_the_cost_side_is_there
    let plain = uid(&pm.insert("Project", json!({"project_name": "Unplanned", "company": w.cid, "proj_estimated_cost": "8000"})).await);
    let done = uid(&pm.insert("Task", json!({"subject": "Half", "project": plain.to_string(), "expected_hours": "5"})).await);
    pm.insert("Task", json!({"subject": "Other half", "project": plain.to_string(), "expected_hours": "5"})).await;
    pm.update("Task", done, json!({"status": "Completed"})).await;
    let r = pm.report("earned_value", std::slice::from_ref(&co)).await.expect("earned value");
    let u = row(&r, "Unplanned").unwrap_or_else(|| panic!("{r}"));
    for f in ["baseline", "planned_value", "schedule_variance", "schedule_index"] {
        assert!(u[f].is_null(), "{f}: {u}");
    }
    assert_eq!(
        (dec(&u["budget_at_completion"]), dec(&u["earned_value"]), dec(&u["actual_cost"]), dec(&u["cost_variance"])),
        (n("8000"), n("4000"), n("0"), n("4000")),
        "{u}"
    );

    // without_cost_or_progress_cells_are_empty
    pm.insert("Project", json!({"project_name": "Idle", "company": w.cid, "proj_estimated_cost": "3000"})).await;
    let r = pm.report("earned_value", std::slice::from_ref(&co)).await.expect("earned value");
    let i = row(&r, "Idle").unwrap_or_else(|| panic!("{r}"));
    assert!(i["cost_index"].is_null() && i["estimate_at_completion"].is_null(), "{i}");
    assert!(u["cost_index"].is_null() && u["estimate_at_completion"].is_null(), "nothing spent: {u}");

    // costs_are_gated
    let r = mia.report("earned_value", std::slice::from_ref(&co)).await;
    assert!(matches!(r, Err(Error::Forbidden(_))), "{r:?}");

    // only_readable_projects: a role that sees costs and reads open projects only.
    let rule = |v: Value| serde_json::from_value::<ferrum_meta::PermissionDef>(v).unwrap();
    for r in [
        json!({"entity": "Project", "read": true, "where": {"proj_private": false}}),
        json!({"entity": "TimesheetDetail", "read": true, "read_groups": ["costing"]}),
        json!({"entity": "Timesheet", "read": true}),
    ] {
        k.set_role_permission(&admin.ctx, "Cost Reader", &rule(r)).await.expect("rule");
    }
    let reader = k.create_user(&admin.ctx, "costs@acme.test", "costs", Some("Correct-Horse-9"), &["Cost Reader".into()], false).await.expect("user");
    let reader = U { k: k.clone(), ctx: k.load_ctx(admin.ctx.tenant, reader, None, "it".into()).await.expect("ctx") };
    pm.update("Project", plain, json!({"proj_private": true})).await;
    let r = reader.report("earned_value", std::slice::from_ref(&co)).await.expect("the reader's earned value");
    assert!(row(&r, "Earned").is_some() && row(&r, "Unplanned").is_none(), "only what they may read: {r}");

    // templates_are_left_out
    pm.action("Project", ev, "save_as_template", json!({"template_name": "Earned Kit"})).await;
    let r = pm.report("earned_value", std::slice::from_ref(&co)).await.expect("earned value");
    assert!(row(&r, "Earned Kit").is_none(), "{r}");
}
