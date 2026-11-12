//! A workspace built in Projects 0.8.0's state (the project team's rules added by hand, as its README asked) is
//! upgraded to the release that ships them: nothing doubled, nothing lost. Against a real PostgreSQL
//! (`FERRUM_PROJECTS3_TEST_DATABASE_URL`, default `postgres://ferrum:ferrum@localhost:5432/ferrum_projects3_test`),
//! reset first. The old package is kept as it was in `tests/fixtures/v0_8_0`.

use ferrum_kernel::tenant::NewTenant;
use ferrum_kernel::{Db, DbConfig, HookRegistry, Kernel, KernelSettings, ListQuery};
use ferrum_meta::Catalog;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::Arc;
use uuid::Uuid;

const OLD_PACKAGE: &str = include_str!("fixtures/v0_8_0/package.yaml");
const OLD_PROJECTS: &str = include_str!("fixtures/v0_8_0/entities/projects.yaml");
const OLD_PLANNING: &str = include_str!("fixtures/v0_8_0/entities/planning.yaml");
const OLD_ERP: &str = include_str!("fixtures/v0_8_0/projects_erp.yaml");
const SQL: &str = include_str!("../packages/projects/sql/001_task_statuses.sql");

async fn boot(old: bool, reset: bool) -> Arc<Kernel> {
    let url = std::env::var("FERRUM_PROJECTS3_TEST_DATABASE_URL").unwrap_or_else(|_| "postgres://ferrum:ferrum@localhost:5432/ferrum_projects3_test".into());
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
            ("sql/001_task_statuses.sql", SQL),
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

fn obj(v: Value) -> ferrum_kernel::Doc {
    v.as_object().cloned().unwrap()
}

#[test]
fn a_workspace_that_added_the_rules_by_hand_is_upgraded() {
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().thread_stack_size(16 << 20).build().unwrap();
    rt.block_on(async { tokio::spawn(scenario()).await.unwrap() });
}

async fn rules(k: &Kernel, tenant: Uuid) -> Vec<Value> {
    let mut tx = k.db.tenant_tx(tenant).await.unwrap();
    let rows: Vec<Value> = sqlx::query_scalar(
        "select to_jsonb(r) - 'tenant_id' from role_permission r where tenant_id = $1 and role = 'Projects User' \
         and entity in ('Project', 'Task', 'ProjectRisk', 'ProjectIssue', 'ChangeRequest') order by entity, if_owner, rule_key",
    )
    .bind(tenant)
    .fetch_all(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    rows
}

async fn scenario() {
    // ───────────── the workspace as 0.8.0 left it, with the rules its README asked for ─────────────
    let k = boot(true, true).await;
    let tenant = k
        .create_tenant(NewTenant {
            slug: "acme".into(),
            name: "Acme".into(),
            admin_email: "admin@acme.test".into(),
            admin_password: "Correct-Horse-9".into(),
            admin_name: None,
            packages: vec!["projects".into(), "projects_erp".into()],
            settings: None,
        })
        .await
        .expect("tenant");
    let session = k.login("acme", "admin@acme.test", "Correct-Horse-9").await.unwrap();
    let admin = k.load_ctx(tenant, session.user, None, "it".into()).await.unwrap();
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
        k.set_role_permission(&admin, "Projects User", &rule(r)).await.expect("rule");
    }
    let mut users = BTreeMap::new();
    for email in ["lead", "mia", "nora"] {
        let id = k.create_user(&admin, &format!("{email}@acme.test"), email, Some("Correct-Horse-9"), &["Projects User".into()], false).await.unwrap();
        users.insert(email, id);
    }
    let pm = k.create_user(&admin, "pm@acme.test", "pm", Some("Correct-Horse-9"), &["Projects Manager".into()], false).await.unwrap();
    let pm = k.load_ctx(tenant, pm, None, "it".into()).await.unwrap();
    let inr = k.list(&admin, "Currency", &Default::default()).await.unwrap().rows[0]["id"].clone();
    let company = k.insert(&admin, "Company", obj(json!({"company_name": "Acme", "abbr": "AC", "default_currency": inr}))).await.unwrap()["id"].clone();
    let secret = k
        .insert(
            &pm,
            "Project",
            obj(json!({"project_name": "Secret", "company": company, "proj_private": true,
                "proj_members": [{"person": "lead@acme.test", "project_role": "Manager"}, {"person": "mia@acme.test", "project_role": "Member"}]})),
        )
        .await
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();
    k.insert(&pm, "Task", obj(json!({"subject": "Plan", "project": secret.to_string()}))).await.unwrap();
    let before = rules(&k, tenant).await;
    drop(k);

    // ───────────── the release: its own rules arrive on an update, beside what the workspace added ─────────────
    let k2 = boot(false, false).await;
    k2.install_packages(tenant, &["projects".into(), "projects_erp".into()]).await.expect("upgraded");
    let after = rules(&k2, tenant).await;
    let key = |r: &Value| format!("{} {} {} {} {} {}", r["entity"], r["if_owner"], r["match_rule"], r["via"], r["can_write"], r["can_create"]);
    let mut seen = std::collections::BTreeSet::new();
    for r in &after {
        assert!(seen.insert(key(r)), "a rule twice: {} in {after:#?}", key(r));
    }
    for r in &before {
        assert!(seen.contains(&key(r)) || r["can_read"] == json!(false), "a hand-added rule lost: {} (before {before:#?}, after {after:#?})", key(r));
    }
    let count = |entity: &str| after.iter().filter(|r| r["entity"] == json!(entity) && r["can_read"] == json!(true)).count();
    assert_eq!((count("Project"), count("ProjectRisk")), (3, 2), "{after:#?}");

    // The behaviour is the one the workspace had: a team reads its private project, an outsider nothing.
    let mia = k2.load_ctx(tenant, users["mia"], None, "it".into()).await.unwrap();
    let nora = k2.load_ctx(tenant, users["nora"], None, "it".into()).await.unwrap();
    let lead = k2.load_ctx(tenant, users["lead"], None, "it".into()).await.unwrap();
    assert!(k2.get(&mia, "Project", secret, false).await.is_ok());
    assert!(k2.get(&nora, "Project", secret, false).await.is_err());
    assert_eq!(k2.list(&mia, "Task", &ListQuery::default()).await.unwrap().rows.len(), 1);
    assert!(k2.list(&nora, "Task", &ListQuery::default()).await.unwrap().rows.is_empty());
    k2.update(&lead, "Project", secret, obj(json!({"notes": "by the manager"})), None).await.expect("a manager changes it");
    assert!(k2.update(&mia, "Project", secret, obj(json!({"notes": "by a member"})), None).await.is_err());
}
