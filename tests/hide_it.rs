//! What staff write for staff stays with staff (Projects 0.9.1): the portal role Project Client's rules hide a shared
//! project's notes, budget, team, manager and costs, a task's assignees, a timesheet's person, approvers and note and a
//! time log's billing rate (platform BD-40); nobody else's rule changes. Against a real PostgreSQL
//! (`FERRUM_PROJECTS5_TEST_DATABASE_URL`, default `postgres://ferrum:ferrum@localhost:5432/ferrum_projects5_test`), reset
//! first. Projects 0.9.0 is kept as it was in `tests/fixtures/v0_9_0`.

use chrono::{Datelike, Duration, Utc};
use ferrum_kernel::tenant::NewTenant;
use ferrum_kernel::{Ctx, Db, DbConfig, Doc, Error, HookRegistry, Kernel, KernelSettings, ListQuery, SiteRequest};
use ferrum_meta::Catalog;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use uuid::Uuid;

const OLD_PACKAGE: &str = include_str!("fixtures/v0_9_0/package.yaml");
const OLD_PROJECTS: &str = include_str!("fixtures/v0_9_0/entities/projects.yaml");
const OLD_PLANNING: &str = include_str!("fixtures/v0_9_0/entities/planning.yaml");
const OLD_ERP: &str = include_str!("fixtures/v0_9_0/projects_erp.yaml");
const SQL1: &str = include_str!("../packages/projects/sql/001_task_statuses.sql");

async fn boot(old: bool, reset: bool) -> Arc<Kernel> {
    let url = std::env::var("FERRUM_PROJECTS5_TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://ferrum:ferrum@localhost:5432/ferrum_projects5_test".into());
    let db = Db::connect(DbConfig { url, max_connections: 10, ..Default::default() }).await.expect("connect");
    if reset {
        sqlx::raw_sql("drop schema if exists public cascade; create schema public;").execute(&db.pool).await.expect("reset");
    }
    let mut packages = ferrum_domain::packages().expect("platform packages");
    packages.extend(ferrum_app_erp::packages().expect("ERP's packages"));
    if old {
        let files: BTreeMap<String, String> = [
            ("package.yaml", OLD_PACKAGE),
            ("entities/projects.yaml", OLD_PROJECTS),
            ("entities/planning.yaml", OLD_PLANNING),
            ("sql/001_task_statuses.sql", SQL1),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        packages.push(ferrum_meta::catalog::load_package_files(&files).expect("Projects as it was"));
        let erp: BTreeMap<String, String> = [("package.yaml".to_string(), OLD_ERP.to_string())].into();
        packages.push(ferrum_meta::catalog::load_package_files(&erp).expect("Projects and ERP as it was"));
    } else {
        packages.extend(ferrum_app_projects::packages().expect("app packages"));
    }
    let mut hooks = HookRegistry::default();
    ferrum_domain::register(&mut hooks);
    ferrum_app_erp::register(&mut hooks);
    ferrum_app_projects::register(&mut hooks);
    let k = Kernel::boot(db, Catalog::from_packages(packages).expect("catalog"), hooks, KernelSettings::default(), None).await.expect("boot");
    ferrum_domain::maintenance(&k).await.expect("domain maintenance");
    ferrum_app_erp::maintenance(&k).await.expect("ERP maintenance");
    k
}

fn obj(v: Value) -> Doc {
    v.as_object().cloned().unwrap()
}

fn uid(d: &Doc) -> Uuid {
    d["id"].as_str().unwrap().parse().unwrap()
}

fn rule(v: Value) -> ferrum_meta::PermissionDef {
    serde_json::from_value(v).unwrap()
}

#[test]
fn clients_do_not_read_what_staff_write_for_staff() {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(16 << 20).build().unwrap();
    rt.block_on(async { tokio::spawn(scenario()).await.unwrap() });
}

async fn ctx_of(k: &Kernel, tenant: Uuid, user: Uuid) -> Ctx {
    k.load_ctx(tenant, user, None, "it".into()).await.unwrap()
}

/// The records of one project the checks read.
struct Built {
    project: Uuid,
    task: Uuid,
    sheet: Uuid,
}

/// A workspace with its staff, its records and a customer's portal person, `cleo@<slug>.test`.
struct Ws {
    tenant: Uuid,
    admin: Ctx,
    users: BTreeMap<&'static str, Uuid>,
    b: Built,
}

async fn workspace(k: &Kernel, slug: &str) -> Ws {
    let tenant = k
        .create_tenant(NewTenant {
            slug: slug.into(),
            name: slug.into(),
            admin_email: format!("admin@{slug}.test"),
            admin_password: "Correct-Horse-9".into(),
            admin_name: None,
            packages: vec!["projects".into(), "projects_erp".into()],
            settings: None,
        })
        .await
        .expect("tenant");
    let session = k.login(slug, &format!("admin@{slug}.test"), "Correct-Horse-9").await.unwrap();
    let admin = ctx_of(k, tenant, session.user).await;
    // Roles the workspace made: one that reads and writes projects and timesheets, one for every entity, one for a project only.
    for r in [
        json!({"entity": "Project", "read": true, "write": true, "create": true}),
        json!({"entity": "Task", "read": true}),
        json!({"entity": "Timesheet", "read": true, "write": true, "create": true}),
    ] {
        k.set_role_permission(&admin, "Auditor", &rule(r)).await.expect("rule");
    }
    k.set_role_permission(&admin, "Everything", &rule(json!({"entity": "*", "read": true}))).await.expect("rule");
    let mut users = BTreeMap::new();
    for (email, role) in [
        ("pm", "Projects Manager"),
        ("lead", "Projects User"),
        ("mia", "Projects User"),
        ("vic", "Projects User"),
        ("aud", "Auditor"),
        ("all", "Everything"),
        ("sales", "Sales User"),
    ] {
        let id = k.create_user(&admin, &format!("{email}@{slug}.test"), email, Some("Correct-Horse-9"), &[role.into()], false).await.unwrap();
        users.insert(email, id);
    }
    let pm = ctx_of(k, tenant, users["pm"]).await;
    let inr = k.list(&admin, "Currency", &Default::default()).await.unwrap().rows[0]["id"].clone();
    let company = k.insert(&admin, "Company", obj(json!({"company_name": "Acme", "abbr": "AC", "default_currency": inr}))).await.unwrap()["id"].clone();
    let globex = k.insert(&admin, "Customer", obj(json!({"customer_name": "Globex"}))).await.unwrap()["id"].clone();
    let b = build(k, &pm, &company, &globex, slug).await;
    k.update(&admin, "Customer", globex.as_str().unwrap().parse().unwrap(), obj(json!({"proj_portal_people": [{"email": format!("cleo@{slug}.test")}]})), None)
        .await
        .unwrap();
    let id = k.create_user(&admin, &format!("cleo@{slug}.test"), "cleo", None, &["Project Client".to_string()], false).await.expect("user");
    k.set_user_kind(&admin, id, "portal").await.expect("a portal person");
    users.insert("cleo", id);
    Ws { tenant, admin, users, b }
}

async fn cleo(k: &Kernel, w: &Ws) -> Ctx {
    let version = k.token_version(w.tenant, w.users["cleo"]).await.unwrap();
    k.load_ctx(w.tenant, w.users["cleo"], Some(version), "it".into()).await.unwrap()
}

async fn hide_rows(k: &Kernel, tenant: Uuid) -> Vec<(String, String, Vec<String>)> {
    let mut tx = k.db.tenant_tx(tenant).await.unwrap();
    sqlx::query_as("select role, entity, hide from role_permission where tenant_id = $1 and role = 'Project Client' order by entity")
        .bind(tenant)
        .fetch_all(&mut *tx)
        .await
        .unwrap()
}

const HIDDEN_PROJECT: [&str; 8] =
    ["notes", "budget", "proj_members", "proj_project_manager", "proj_estimated_cost", "proj_costing_amount", "proj_baseline_cost", "proj_baseline_budget"];

/// Every way the portal person could reach a hidden field, and what staff still read.
async fn client_sees_none(k: &Arc<Kernel>, w: &Ws, cleo: &Ctx, slug: &str) {
    let b = &w.b;
    let staff = [format!("lead@{slug}.test"), format!("mia@{slug}.test"), format!("vic@{slug}.test"), format!("aud@{slug}.test")];
    let leaks =
        |v: &Value| staff.iter().any(|e| v.to_string().contains(e.as_str())) || v.to_string().contains("staff only") || v.to_string().contains("internal chat");
    // On the record.
    let p = k.get(cleo, "Project", b.project, false).await.expect("the shared project");
    assert_eq!(p["project_name"], json!("Shared Build"));
    for f in HIDDEN_PROJECT {
        assert!(!p.contains_key(f), "{f} is not the client's: {p:?}");
    }
    for f in ["proj_contract_value", "proj_percent_complete", "proj_billed_amount", "proj_billing_method", "customer"] {
        assert!(p.contains_key(f), "{f} stays shared: {p:?}");
    }
    assert!(!leaks(&Value::Object(p)));
    // In lists, whatever fields are asked for.
    for fields in [None, Some(vec!["project_name".to_string(), "proj_members".into(), "notes".into(), "budget".into()])] {
        match k.list(cleo, "Project", &ListQuery { fields, ..Default::default() }).await {
            Ok(page) => {
                assert_eq!(page.rows.len(), 1);
                assert!(page.rows.iter().all(|r| HIDDEN_PROJECT.iter().all(|f| !r.contains_key(*f))) && !leaks(&json!(page.rows)), "{:?}", page.rows);
            }
            Err(e) => assert!(matches!(e, Error::Forbidden(_) | Error::Invalid(_)), "{e:?}"),
        }
    }
    // Filters and sorts on a hidden field are refused, so matching tells nothing.
    let lead = ctx_of(k, w.tenant, w.users["lead"]).await;
    for f in [
        json!({"proj_members.person": format!("lead@{slug}.test")}),
        json!({"proj_members.person": "nobody@x.test"}),
        json!({"proj_project_manager": format!("lead@{slug}.test")}),
        json!({"notes": "staff only"}),
        json!({"budget": "9000"}),
        json!({"proj_estimated_cost": "5000"}),
    ] {
        let r = k.list(cleo, "Project", &ListQuery { filters: ferrum_kernel::query::parse_filters(&f).unwrap(), ..Default::default() }).await;
        assert!(matches!(r, Err(Error::Forbidden(_))), "a filter {f} on a hidden field is refused, not answered: {r:?}");
        let staff_hit = k.list(&lead, "Project", &ListQuery { filters: ferrum_kernel::query::parse_filters(&f).unwrap(), ..Default::default() }).await;
        assert!(staff_hit.is_ok(), "{f} filters for staff");
    }
    for sort in ["proj_project_manager asc", "notes desc", "budget asc"] {
        let r = k.list(cleo, "Project", &ListQuery { sort: Some(sort.into()), ..Default::default() }).await;
        assert!(matches!(r, Err(Error::Forbidden(_))), "sorting by {sort} is refused: {r:?}");
    }
    // History and writes.
    let trail = k.audit_trail(cleo, "Project", b.project).await;
    assert!(trail.is_err() || !leaks(&json!(format!("{:?}", trail.unwrap()))), "history");
    assert!(k.update(cleo, "Project", b.project, obj(json!({"notes": "x"})), None).await.is_err(), "a portal person changes nothing");
    // Tasks and their assignees.
    let t = k.get(cleo, "Task", b.task, false).await.expect("the client-visible task");
    assert!(!t.contains_key("assigned_to") && !leaks(&Value::Object(t)));
    let page = k.list(cleo, "Task", &ListQuery::default()).await.unwrap();
    assert!(!leaks(&json!(page.rows)));
    for (field, value) in [("assigned_to.user", format!("mia@{slug}.test"))] {
        let r = k.list(cleo, "Task", &ListQuery { filters: ferrum_kernel::query::parse_filters(&json!({field: value})).unwrap(), ..Default::default() }).await;
        assert!(matches!(r, Err(Error::Forbidden(_))), "{r:?}");
    }
    // Timesheets: whose, the note, the approvers, the rate.
    let ts = k.get(cleo, "Timesheet", b.sheet, false).await.expect("an approved timesheet of the shared project");
    for f in ["user", "note", "approvers"] {
        assert!(!ts.contains_key(f), "{f}: {ts:?}");
    }
    let log = ts["time_logs"][0].as_object().unwrap();
    assert!(
        !log.contains_key("billing_rate") && !log.contains_key("costing_rate") && log["description"] == json!("design"),
        "the rates stay with staff, the description is shared: {log:?}"
    );
    assert!(!leaks(&Value::Object(ts)));
    for f in [json!({"user": format!("mia@{slug}.test")}), json!({"note": "internal chat"})] {
        let r = k.list(cleo, "Timesheet", &ListQuery { filters: ferrum_kernel::query::parse_filters(&f).unwrap(), ..Default::default() }).await;
        assert!(matches!(r, Err(Error::Forbidden(_))), "{f}: {r:?}");
    }
    let r = k
        .list(
            cleo,
            "Timesheet",
            &ListQuery { filters: ferrum_kernel::query::parse_filters(&json!({"time_logs.billing_rate": "120"})).unwrap(), ..Default::default() },
        )
        .await;
    assert!(matches!(r, Err(Error::Forbidden(_))), "a log's rate is not matched on either: {r:?}");
    // Projects' own endpoints.
    let site = k.hooks.site("projects").expect("projects' endpoints").clone();
    let call = |who: Ctx, path: &str, query: Value| {
        let (k, site, path, tenant) = (k.clone(), site.clone(), path.to_string(), w.tenant);
        async move {
            let req = SiteRequest {
                tenant,
                user: Some(who),
                method: "GET".into(),
                path,
                query: query.as_object().cloned().unwrap(),
                headers: Default::default(),
                body: vec![],
                client_ip: "203.0.113.9".into(),
            };
            String::from_utf8(site.handle(k.as_ref(), req).await.expect("route").body).unwrap()
        }
    };
    let board = call(cleo.clone(), "/tasks", json!({"project": b.project.to_string()})).await;
    assert!(board.contains("Kickoff") && !staff.iter().any(|e| board.contains(e.as_str())), "the board route: {board}");
    let time = call(cleo.clone(), "/time", json!({"task": b.task.to_string()})).await;
    assert!(time.contains("design") && !staff.iter().any(|e| time.contains(e.as_str())), "the time route: {time}");
    let mia = ctx_of(k, w.tenant, w.users["mia"]).await;
    let staff_board = call(mia.clone(), "/tasks", json!({"project": b.project.to_string()})).await;
    assert!(staff_board.contains(&format!("mia@{slug}.test")), "staff still get the people on a task: {staff_board}");
    let staff_time = call(mia, "/time", json!({"task": b.task.to_string()})).await;
    assert!(staff_time.contains(&format!("mia@{slug}.test")), "and whose time it is: {staff_time}");
}

/// What every role but the portal one reads and writes: everything, as before.
async fn staff_read_all(k: &Arc<Kernel>, w: &Ws, slug: &str) {
    let b = &w.b;
    for who in ["aud", "all", "sales", "pm", "lead", "mia"] {
        let c = ctx_of(k, w.tenant, w.users[who]).await;
        let p = k.get(&c, "Project", b.project, false).await.unwrap_or_else(|e| panic!("{who} reads the project: {e:?}"));
        for f in HIDDEN_PROJECT {
            assert!(p.contains_key(f), "{who} reads {f}: {p:?}");
        }
        assert!(!p["proj_members"].as_array().unwrap().is_empty());
        if who != "all" && who != "sales" {
            let t = k.get(&c, "Task", b.task, false).await.unwrap_or_else(|e| panic!("{who}: {e:?}"));
            assert!(t["assigned_to"].as_array().is_some_and(|a| !a.is_empty()), "{who} reads the assignees");
        }
        let r = k
            .list(
                &c,
                "Project",
                &ListQuery {
                    filters: ferrum_kernel::query::parse_filters(&json!({"proj_members.person": format!("lead@{slug}.test")})).unwrap(),
                    ..Default::default()
                },
            )
            .await;
        assert!(r.is_ok_and(|p| p.rows.len() == 1), "{who} filters by the team");
    }
    for who in ["aud", "all", "pm"] {
        let c = ctx_of(k, w.tenant, w.users[who]).await;
        let ts = k.get(&c, "Timesheet", b.sheet, false).await.unwrap();
        assert!(
            ts.contains_key("user") && ts.contains_key("note") && ts["time_logs"][0].as_object().unwrap().contains_key("billing_rate"),
            "{who} reads the timesheet whole: {ts:?}"
        );
    }
    let aud = ctx_of(k, w.tenant, w.users["aud"]).await;
    k.update(&aud, "Project", b.project, obj(json!({"proj_project_manager": format!("aud@{slug}.test")})), None)
        .await
        .expect("a custom role still writes the manager");
    k.update(&aud, "Timesheet", b.sheet, obj(json!({"note": "by the auditor"})), None).await.ok();
    let lead = ctx_of(k, w.tenant, w.users["lead"]).await;
    k.update(&lead, "Project", b.project, obj(json!({"proj_members": [{"person": format!("lead@{slug}.test"), "project_role": "Manager"}, {"person": format!("mia@{slug}.test"), "project_role": "Member"}, {"person": format!("vic@{slug}.test"), "project_role": "Viewer"}]})), None)
        .await
        .expect("a manager on the team still writes it");
}

async fn scenario() {
    // A workspace as 0.9.0 left it (one whose administrator then edits the Project Client rule), and a fresh install.
    let k = boot(true, true).await;
    let w = workspace(&k, "acme").await;
    let e = workspace(&k, "edited").await;
    let rows = hide_rows(&k, w.tenant).await;
    assert!(rows.len() == 4 && rows.iter().all(|r| r.2.is_empty()), "0.9.0 hid nothing: {rows:?}");
    let cleo_before = cleo(&k, &w).await;
    assert!(k.get(&cleo_before, "Project", w.b.project, false).await.unwrap().contains_key("proj_members"), "the fault, as 0.9.0 had it");
    // The administrator of `edited` hides only the notes, in the role editor: the row is theirs from then on.
    k.set_role_permission(
        &e.admin,
        "Project Client",
        &rule(json!({"entity": "Project", "read": true, "via": "customer.proj_portal_people.email", "where": {"proj_shared": true}, "hide": ["notes"]})),
    )
    .await
    .expect("an edited rule");
    drop(k);

    // The release arrives.
    let k = boot(false, false).await;
    k.install_packages(w.tenant, &["projects".into(), "projects_erp".into()]).await.expect("upgraded");
    k.install_packages(e.tenant, &["projects".into(), "projects_erp".into()]).await.expect("upgraded");
    let rows = hide_rows(&k, w.tenant).await;
    let hide_of = |rows: &[(String, String, Vec<String>)], entity: &str| rows.iter().find(|r| r.1 == entity).map(|r| r.2.clone()).unwrap_or_default();
    let mut project = hide_of(&rows, "Project");
    project.sort();
    let mut want: Vec<String> = HIDDEN_PROJECT.iter().map(|s| s.to_string()).collect();
    want.sort();
    assert_eq!(project, want, "the corrected rule reached the workspace: {rows:?}");
    assert_eq!(hide_of(&rows, "Task"), vec!["assigned_to".to_string()]);
    assert_eq!(hide_of(&rows, "TimesheetDetail"), vec!["billing_rate".to_string()], "and the new rule for the time logs");
    assert_eq!(hide_of(&rows, "Timesheet").len(), 3);
    let cleo_w = cleo(&k, &w).await;
    client_sees_none(&k, &w, &cleo_w, "acme").await;
    staff_read_all(&k, &w, "acme").await;
    erase_and_unshare(&k, &w, &cleo_w, "acme").await;

    // The edited rule stays the administrator's: the platform rewrites no row they changed (BD-40), so the project's team
    // is read again by their client; the rules they did not edit took the release's `hide`.
    let rows = hide_rows(&k, e.tenant).await;
    assert_eq!(hide_of(&rows, "Project"), vec!["notes".to_string()], "the administrator's edit is kept: {rows:?}");
    assert_eq!(hide_of(&rows, "Task"), vec!["assigned_to".to_string()]);
    let cleo_e = cleo(&k, &e).await;
    let p = k.get(&cleo_e, "Project", e.b.project, false).await.unwrap();
    assert!(!p.contains_key("notes") && p.contains_key("proj_members"), "only what the administrator hides is hidden: {p:?}");
    drop(k);

    // A workspace installed from now on.
    let k = boot(false, true).await;
    let f = workspace(&k, "fresh").await;
    let rows = hide_rows(&k, f.tenant).await;
    assert_eq!(hide_of(&rows, "Task"), vec!["assigned_to".to_string()]);
    let cleo_f = cleo(&k, &f).await;
    client_sees_none(&k, &f, &cleo_f, "fresh").await;
    staff_read_all(&k, &f, "fresh").await;
    erase_and_unshare(&k, &f, &cleo_f, "fresh").await;
}

async fn erase_and_unshare(k: &Arc<Kernel>, w: &Ws, cleo: &Ctx, slug: &str) {
    k.erase_personal_data(&w.admin, &format!("vic@{slug}.test"), "asked").await.expect("a team member erased");
    let p = k.get(&w.admin, "Project", w.b.project, false).await.unwrap();
    let members = p["proj_members"].as_array().unwrap();
    assert!(!members.iter().any(|m| m["person"].as_str().is_some_and(|s| s.starts_with("vic@"))), "the erased member's row is emptied: {members:?}");
    let pm = ctx_of(k, w.tenant, w.users["pm"]).await;
    k.update(&pm, "Project", w.b.project, obj(json!({"proj_shared": false})), None).await.unwrap();
    assert!(k.get(cleo, "Project", w.b.project, false).await.is_err(), "unsharing takes the project back from the client at once");
}

async fn build(k: &Kernel, pm: &Ctx, company: &Value, globex: &Value, slug: &str) -> Built {
    let project = uid(&k
        .insert(
            pm,
            "Project",
            obj(json!({"project_name": "Shared Build", "company": company, "customer": globex, "proj_shared": true, "proj_billing_method": "Non-billable",
                "notes": "staff only", "budget": "9000"})),
        )
        .await
        .unwrap());
    let task = uid(&k
        .insert(
            pm,
            "Task",
            obj(json!({"subject": "Kickoff", "project": project.to_string(), "client_visible": true, "assigned_to": [{"user": format!("mia@{slug}.test")}]})),
        )
        .await
        .unwrap());
    let consult =
        k.insert(pm, "ActivityType", obj(json!({"activity_type": "Consult", "billing_rate": "100", "costing_rate": "50"}))).await.unwrap()["id"].clone();
    let today = Utc::now().date_naive();
    let monday = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let sheet = uid(
        &k.insert(
            pm,
            "Timesheet",
            obj(json!({"company": company, "user": format!("mia@{slug}.test"), "week_start": monday.to_string(), "note": "internal chat",
                "time_logs": [{"activity_type": consult.clone(), "project": project.to_string(), "task": task.to_string(), "day": monday.to_string(), "hours": "2", "billing_rate": "120", "description": "design"}]})),
        )
        .await
        .unwrap(),
    );
    k.submit(pm, "Timesheet", sheet, None).await.expect("submitted");
    // The team and costs come after: a project with a manager would ask that manager to approve the time.
    k.update(
        pm,
        "Project",
        project,
        obj(json!({"proj_project_manager": format!("lead@{slug}.test"), "proj_estimated_cost": "5000", "proj_baseline_cost": "4000", "proj_baseline_budget": "8000",
            "proj_members": [{"person": format!("lead@{slug}.test"), "project_role": "Manager"}, {"person": format!("mia@{slug}.test"), "project_role": "Member"}, {"person": format!("vic@{slug}.test"), "project_role": "Viewer"}]})),
        None,
    )
    .await
    .unwrap();
    Built { project, task, sheet }
}
