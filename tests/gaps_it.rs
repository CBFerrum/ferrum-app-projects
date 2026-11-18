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
    health(&w).await;
    sprints(&w).await;
    repeating(&w).await;
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

/// PRJ-11: status updates with a health rating. The project shows its latest update's rating and day, worked out
/// again under its lock whenever an update is saved or deleted; its managers post them.
async fn health(w: &World) {
    let (pm, lead, mia, nora, boss) =
        (&w.users["pm"], &reload(&w.users["lead"]).await, &reload(&w.users["mia"]).await, &reload(&w.users["nora"]).await, &reload(&w.users["boss"]).await);
    let k = &pm.k;
    let today = Utc::now().date_naive();
    let day = |n: i64| (today + Duration::days(n)).to_string();
    let project = uid(&pm
        .insert(
            "Project",
            json!({"project_name": "Health", "company": w.cid, "proj_private": true, "proj_project_manager": "boss@acme.test",
                   "proj_members": [{"person": "lead@acme.test", "project_role": "Manager"}, {"person": "mia@acme.test", "project_role": "Member"}]}),
        )
        .await);
    let post = |who: &U, health: &str, on: String| {
        let body = json!({"project": project.to_string(), "health": health, "on_date": on, "summary": "How it goes"});
        let (k, ctx) = (who.k.clone(), who.ctx.clone());
        async move { k.insert(&ctx, "ProjectUpdate", obj(body)).await }
    };
    let state = || async {
        let p = pm.get("Project", project).await;
        (p["proj_health"].clone(), p["proj_health_on"].clone())
    };

    // the_latest_update_is_the_projects_health
    let yesterday = uid(&post(lead, "At Risk", day(-1)).await.expect("the team's manager posts"));
    let latest = uid(&post(boss, "On Track", day(0)).await.expect("the project's manager posts"));
    assert_eq!(state().await, (json!("On Track"), json!(day(0))));
    // an_older_update_does_not_win
    let older = uid(&post(lead, "Off Track", day(-2)).await.expect("posted"));
    assert_eq!(state().await, (json!("On Track"), json!(day(0))));
    // editing_and_deleting_follow
    boss.update("ProjectUpdate", latest, json!({"health": "Off Track"})).await;
    assert_eq!(state().await, (json!("Off Track"), json!(day(0))));
    k.delete(&boss.ctx, "ProjectUpdate", latest, None).await.expect("deleted");
    assert_eq!(state().await, (json!("At Risk"), json!(day(-1))));
    for u in [yesterday, older] {
        k.delete(&pm.ctx, "ProjectUpdate", u, None).await.expect("deleted");
    }
    assert_eq!(state().await, (Value::Null, Value::Null), "none left");

    // two_at_once
    let (a, b) = tokio::join!(post(lead, "At Risk", day(0)), post(boss, "On Track", day(0)));
    let both = [uid(&a.expect("one")), uid(&b.expect("other"))];
    // The later of the two as the database orders them (to the microsecond; a record shows milliseconds).
    let mut tx = k.db.tenant_tx(w.admin.ctx.tenant).await.unwrap();
    let later: String =
        sqlx::query_scalar("select health from e_project_update where tenant_id = $1 and id = any($2) order by created_at desc, id desc limit 1")
            .bind(w.admin.ctx.tenant)
            .bind(&both[..])
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(state().await.0, json!(later));

    // who_may_post
    for who in [mia, nora] {
        let r = post(who, "On Track", day(0)).await;
        assert!(matches!(r, Err(Error::Forbidden(_))), "{r:?}");
    }
    assert_eq!(mia.list("ProjectUpdate", json!({"project": project.to_string()})).await.len(), 2, "a member reads them");
    assert!(nora.list("ProjectUpdate", json!({"project": project.to_string()})).await.is_empty(), "an outsider reads none of a private project's");

    // the_author_is_the_poster
    let mut body = json!({"project": project.to_string(), "health": "On Track", "on_date": day(0), "summary": "Mine"});
    body["author"] = json!("boss@acme.test");
    let mine = lead.insert("ProjectUpdate", body).await;
    assert_eq!(mine["author"], json!("lead@acme.test"));

    // an_update_stays_with_its_project, not_on_a_template, not_in_the_future
    let other = uid(&pm.insert("Project", json!({"project_name": "Elsewhere", "company": w.cid})).await);
    let r = pm.try_update("ProjectUpdate", uid(&mine), json!({"project": other.to_string()})).await;
    assert!(field_error(&r, "project", ""), "{r:?}");
    let kit = pm.action("Project", other, "save_as_template", json!({"template_name": "Elsewhere Kit"})).await;
    let r = pm.try_insert("ProjectUpdate", json!({"project": kit["id"], "health": "On Track", "summary": "A plan"})).await;
    assert!(field_error(&r, "project", ""), "{r:?}");
    let r = post(lead, "On Track", day(1)).await;
    assert!(matches!(r, Err(Error::Validation(_))), "{r:?}");
}

/// PRJ-06 (server): sprints of a project, planned, started (one active a project) and closed; closing records what was
/// done and moves what was not to the sprint named or back to the backlog.
async fn sprints(w: &World) {
    let (pm, lead, mia, nora) = (&w.users["pm"], &reload(&w.users["lead"]).await, &reload(&w.users["mia"]).await, &reload(&w.users["nora"]).await);
    let k = &pm.k;
    let today = Utc::now().date_naive();
    let day = |n: i64| (today + Duration::days(n)).to_string();
    let project = |name: &str, private: bool| {
        let body = json!({"project_name": name, "company": w.cid, "proj_private": private,
                          "proj_members": [{"person": "lead@acme.test", "project_role": "Manager"}, {"person": "mia@acme.test", "project_role": "Member"}]});
        async move { uid(&pm.insert("Project", body).await) }
    };
    let sprint = |who: &U, name: &str, project: Uuid| {
        let body = json!({"sprint_name": name, "project": project.to_string(), "start_date": day(0), "end_date": day(13)});
        let (k, ctx) = (who.k.clone(), who.ctx.clone());
        async move { k.insert(&ctx, "Sprint", obj(body)).await }
    };
    let p = project("Sprinting", true).await;
    let s1 = uid(&sprint(lead, "Sprint 1", p).await.expect("a team manager plans a sprint"));
    let s2 = uid(&sprint(lead, "Sprint 2", p).await.expect("and another"));
    assert!(matches!(sprint(mia, "Mia's", p).await, Err(Error::Forbidden(_))), "a member plans none");
    let task = |subject: &str, points: &str, sprint: Uuid| {
        lead.insert("Task", json!({"subject": subject, "project": p.to_string(), "story_points": points, "sprint": sprint.to_string()}))
    };
    let (small, medium, large) = (uid(&task("Small", "3", s1).await), uid(&task("Medium", "5", s1).await), uid(&task("Large", "8", s1).await));
    let state = |s: Uuid| async move { pm.get("Sprint", s).await["state"].clone() };
    let sprint_of = |t: Uuid| async move { pm.get("Task", t).await["sprint"].clone() };

    // a_sprint_is_planned_started_and_closed (with who_may and one_active_sprint on the way)
    assert!(denied(&mia.try_action("Sprint", s1, "start", json!({})).await), "a member starts none");
    let started = lead.action("Sprint", s1, "start", json!({})).await;
    assert_eq!(
        (started["state"].clone(), dec(&started["committed_points"]), started["committed_tasks"].clone()),
        (json!("Active"), n("16"), json!(3)),
        "{started}"
    );
    let r = lead.try_action("Sprint", s2, "start", json!({})).await;
    assert!(matches!(&r, Err(Error::Invalid(m)) if m.contains("Sprint 1")), "one active sprint a project: {r:?}");
    // the_target_is_checked
    let elsewhere = project("Elsewhere", false).await;
    let theirs = uid(&sprint(pm, "Theirs", elsewhere).await.expect("another project's sprint"));
    for target in [s1, theirs] {
        let r = lead.try_action("Sprint", s1, "close", json!({"move_open_to": target.to_string()})).await;
        assert!(field_error(&r, "move_open_to", ""), "{r:?}");
    }
    assert_eq!(state(s1).await, json!("Active"), "nothing changed");
    assert!(denied(&mia.try_action("Sprint", s1, "close", json!({})).await), "a member closes none");
    for t in [small, medium] {
        lead.update("Task", t, json!({"status": "Completed"})).await;
    }
    let closed = lead.action("Sprint", s1, "close", json!({"move_open_to": s2.to_string()})).await;
    assert_eq!(
        (
            closed["state"].clone(),
            dec(&closed["completed_points"]),
            closed["completed_tasks"].clone(),
            closed["carried_over"].clone(),
            closed["moved_to"].clone()
        ),
        (json!("Closed"), n("8"), json!(2), json!(1), json!(s2.to_string())),
        "{closed}"
    );
    assert_eq!(sprint_of(large).await, json!(s2.to_string()));
    assert_eq!(sprint_of(small).await, json!(s1.to_string()), "done work stays where it was done");

    // a_task_keeps_to_its_project
    let r = lead.try_update("Task", large, json!({"sprint": theirs.to_string()})).await;
    assert!(field_error(&r, "sprint", "another project"), "{r:?}");
    let r = lead.try_update("Task", large, json!({"sprint": s1.to_string()})).await;
    assert!(field_error(&r, "sprint", "closed"), "{r:?}");
    lead.update("Task", small, json!({"sprint": null})).await;

    // a_closed_sprint_is_kept
    assert!(matches!(lead.try_update("Sprint", s1, json!({"sprint_name": "Renamed"})).await, Err(Error::Invalid(_))));
    assert!(matches!(k.delete(&lead.ctx, "Sprint", s1, None).await, Err(Error::Invalid(_))));

    // open_tasks_go_back_to_the_backlog (and a closed target is refused first)
    lead.action("Sprint", s2, "start", json!({})).await;
    let r = lead.try_action("Sprint", s2, "close", json!({"move_open_to": s1.to_string()})).await;
    assert!(field_error(&r, "move_open_to", ""), "a closed sprint takes nothing: {r:?}");
    assert_eq!((state(s2).await, sprint_of(large).await), (json!("Active"), json!(s2.to_string())));
    assert!(matches!(k.delete(&lead.ctx, "Sprint", s2, None).await, Err(Error::Invalid(_))), "an active sprint is not deleted");
    let closed = lead.action("Sprint", s2, "close", json!({})).await;
    assert_eq!((closed["carried_over"].clone(), closed["moved_to"].clone()), (json!(1), Value::Null));
    assert_eq!(sprint_of(large).await, Value::Null, "back to the backlog");

    // A planned sprint is deleted, by its project's manager only, and its tasks go back to the backlog.
    let s3 = uid(&sprint(lead, "Sprint 3", p).await.expect("planned"));
    lead.update("Task", large, json!({"sprint": s3.to_string()})).await;
    assert!(denied(&k.delete(&mia.ctx, "Sprint", s3, None).await), "a member deletes none");
    k.delete(&lead.ctx, "Sprint", s3, None).await.expect("a planned sprint is deleted");
    assert_eq!(sprint_of(large).await, Value::Null);
    assert!(nora.list("Sprint", json!({"project": p.to_string()})).await.is_empty(), "an outsider reads no sprint of a private project");

    // two_starts_at_once
    let racing = project("Racing", false).await;
    let (r1, r2) = (uid(&sprint(pm, "One", racing).await.unwrap()), uid(&sprint(pm, "Two", racing).await.unwrap()));
    let (a, b) = tokio::join!(k.run_action(&pm.ctx, "Sprint", r1, "start", json!({})), k.run_action(&pm.ctx, "Sprint", r2, "start", json!({})));
    assert_eq!([a.is_ok(), b.is_ok()].iter().filter(|x| **x).count(), 1, "{a:?} {b:?}");
    assert!(matches!(a.as_ref().err().or(b.as_ref().err()), Some(Error::Invalid(_))), "{a:?} {b:?}");
    let active = pm.list("Sprint", json!({"project": racing.to_string(), "state": "Active"})).await;
    assert_eq!(active.len(), 1);

    // started_once
    let keyed = project("Keyed", false).await;
    let ks = uid(&sprint(pm, "Keyed", keyed).await.unwrap());
    let ask = || invocation("projects.sprint.start", json!({"id": ks.to_string()}), "s:1");
    let first = k.invoke(&pm.ctx, ask()).await.expect("started");
    let again = k.invoke(&pm.ctx, ask()).await.expect("answered");
    assert!(!first.repeated && again.repeated);
    assert!(pm.try_action("Sprint", ks, "start", json!({})).await.is_err(), "without a key, a started sprint is not started again");

    // the_board_carries_them
    lead.update("Task", large, json!({"backlog_rank": "1000"})).await;
    let site = k.hooks.site("projects").expect("projects' endpoints").clone();
    let req = ferrum_kernel::SiteRequest {
        tenant: lead.ctx.tenant,
        user: Some(lead.ctx.clone()),
        method: "GET".into(),
        path: "/tasks".into(),
        query: json!({"project": p.to_string()}).as_object().cloned().unwrap(),
        headers: Default::default(),
        body: vec![],
        client_ip: "203.0.113.9".into(),
    };
    let body: Value = serde_json::from_slice(&site.handle(k, req).await.expect("board").body).unwrap();
    let row = body["rows"].as_array().unwrap().iter().find(|r| r["id"] == json!(large.to_string())).cloned().expect("the task");
    for f in ["sprint", "story_points", "backlog_rank"] {
        assert!(row.as_object().unwrap().contains_key(f), "{f}: {row}");
    }
    assert_eq!(dec(&row["story_points"]), n("8"));
}

/// PRJ-03: a task repeats every N days, weeks or months, on chosen weekdays, counted from its due date (upkeep) or from
/// its completion (the completing save); the next carries every field that is not one occurrence's own, its people
/// still here, and its sub-tasks with the links among them.
async fn repeating(w: &World) {
    let (admin, pm) = (&w.admin, &w.users["pm"]);
    let k = &pm.k;
    let tenant = admin.ctx.tenant;
    // A field the workspace added to tasks.
    let area: ferrum_kernel::customize::NewCustomization =
        serde_json::from_value(json!({"entity": "Task", "op": {"op": "add_field", "field": {"name": "x_area", "type": "data", "label": "Area"}}})).unwrap();
    k.batch_customizations(&admin.ctx, vec![area], false).await.map_err(|(_, e)| e).expect("an added field");
    let pm = &reload(pm).await;
    let today = Utc::now().date_naive();
    let day = |n: i64| (today + Duration::days(n)).to_string();
    let p = uid(&pm.insert("Project", json!({"project_name": "Repeats", "company": w.cid})).await);
    let next_of = |t: Uuid| async move { pm.list("Task", json!({"repeated_from": t.to_string()})).await };
    let upkeep = || ferrum_app_projects::maintenance(k, tenant);

    // after_completion
    let weekly = uid(&pm
        .insert("Task", json!({"subject": "Weekly check", "project": p.to_string(), "repeat": "Weekly", "repeat_from": "Completion", "exp_end_date": day(-7)}))
        .await);
    pm.update("Task", weekly, json!({"status": "Completed"})).await;
    let made = next_of(weekly).await;
    assert_eq!(made.len(), 1, "made by the completing save");
    assert_eq!(made[0]["exp_end_date"], json!(day(7)), "a week from the day it was completed");
    upkeep().await.expect("upkeep");
    assert_eq!(next_of(weekly).await.len(), 1, "upkeep makes no other");
    // reopened_and_completed_again_makes_no_second
    pm.update("Task", weekly, json!({"status": "Open"})).await;
    pm.update("Task", weekly, json!({"status": "Completed"})).await;
    assert_eq!(next_of(weekly).await.len(), 1);
    // upkeep_leaves_completion_tasks_alone
    let waiting = uid(&pm
        .insert("Task", json!({"subject": "When done", "project": p.to_string(), "repeat": "Daily", "repeat_from": "Completion", "exp_end_date": day(-3)}))
        .await);
    upkeep().await.expect("upkeep");
    assert!(next_of(waiting).await.is_empty(), "made only on completion");

    // the_copy_carries_sub_tasks_and_their_links, added_fields_are_copied, one_occurrence_only_fields_are_not
    let fixed = uid(&pm
        .insert(
            "Project",
            json!({"project_name": "Retainer", "company": w.cid, "customer": w.globex, "proj_billing_method": "Fixed Price", "proj_contract_value": "1000"}),
        )
        .await);
    let sprint = pm.insert("Sprint", json!({"sprint_name": "Now", "project": fixed.to_string(), "start_date": day(0), "end_date": day(13)})).await;
    let outside = uid(&pm.insert("Task", json!({"subject": "Outside", "project": fixed.to_string()})).await);
    let parent = uid(&pm
        .insert(
            "Task",
            json!({"subject": "Monthly report", "project": fixed.to_string(), "repeat": "Weekly", "exp_start_date": day(-2), "exp_end_date": day(0),
                   "x_area": "North", "story_points": "3", "progress": "40", "is_milestone": true, "billing_percent": "10", "sprint": sprint["id"],
                   "assigned_to": [{"user": "lead@acme.test"}]}),
        )
        .await);
    let sub = |subject: &str| json!({"subject": subject, "project": fixed.to_string(), "parent_task": parent.to_string(), "exp_start_date": day(-1), "exp_end_date": day(0)});
    let a = uid(&pm.insert("Task", sub("Gather")).await);
    let mut b = sub("Write");
    b["depends_on"] = json!([{"task": a.to_string()}, {"task": outside.to_string()}]);
    let b = uid(&pm.insert("Task", b).await);
    let c = uid(&pm.insert("Task", sub("Dropped")).await);
    pm.update("Task", c, json!({"status": "Cancelled"})).await;
    // a_person_who_left_is_left_off: an address that is no user any more, written as the engine would have kept it.
    let sys = Ctx::system(tenant, k.registry.schema(tenant).await.unwrap());
    let mut tx = k.db.tenant_tx(tenant).await.unwrap();
    k.set_child_rows_tx(&sys, &mut tx, "Task", "assigned_to", parent, vec![obj(json!({"user": "lead@acme.test"})), obj(json!({"user": "gone@acme.test"}))])
        .await
        .expect("people");
    tx.commit().await.unwrap();
    upkeep().await.expect("upkeep");
    let made = next_of(parent).await;
    assert_eq!(made.len(), 1, "the next occurrence");
    let next = pm.get("Task", uid(&made[0])).await;
    assert_eq!((next["exp_start_date"].clone(), next["exp_end_date"].clone()), (json!(day(5)), json!(day(7))));
    assert_eq!(next["x_area"], json!("North"), "a field the workspace added is copied");
    assert_eq!(dec(&next["story_points"]), n("3"));
    assert!(next["billing_percent"].is_null() && next["sprint"].is_null(), "no billing share, no sprint: {next:?}");
    assert_eq!((next["status"].clone(), dec(&next["progress"])), (json!("Open"), n("0")));
    let people: Vec<Value> = next["assigned_to"].as_array().unwrap().iter().map(|r| r["user"].clone()).collect();
    assert_eq!(people, [json!("lead@acme.test")], "who left is left off");
    let kids = pm.list("Task", json!({"parent_task": uid(&next).to_string()})).await;
    let mut names: Vec<String> = kids.iter().map(|t| t["subject"].as_str().unwrap().to_string()).collect();
    names.sort();
    assert_eq!(names, ["Gather", "Write"], "its sub-tasks, not the cancelled one");
    let (a2, b2) = (kids.iter().find(|t| t["subject"] == json!("Gather")).unwrap(), kids.iter().find(|t| t["subject"] == json!("Write")).unwrap());
    assert_eq!(a2["exp_end_date"], json!(day(7)), "moved by the same days");
    let b2 = pm.get("Task", uid(b2)).await;
    let waits: Vec<Value> = b2["depends_on"].as_array().unwrap().iter().map(|r| r["task"].clone()).collect();
    assert_eq!(waits, [a2["id"].clone()], "it waits for the copy of its link, not for the task outside");
    let _ = b;

    // rules
    let mut twice = json!({"subject": "Twice", "project": p.to_string(), "repeat": "Weekly", "exp_end_date": day(3)});
    twice["repeat_weekdays"] = json!([{"weekday": "Monday"}, {"weekday": "Monday"}]);
    let r = pm.try_insert("Task", twice).await;
    assert!(field_error(&r, "weekday", "twice"), "{r:?}");
    let r = pm.try_insert("Task", json!({"subject": "Undated", "project": p.to_string(), "repeat": "Daily"})).await;
    assert!(field_error(&r, "exp_end_date", ""), "{r:?}");
}

