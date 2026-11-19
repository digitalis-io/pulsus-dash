#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Catalogue checks of the migrated schema (T11-001, T11-002, T11-003, T11-026, T11 §4.1).
//! Run by `cargo xtask ci itest`.

use std::collections::BTreeSet;
use std::time::Duration;

use dash_core::{OrgId, Secret};
use dash_store::repo::{orgs, roles};
use dash_store::testing::TestDb;
use dash_store::{Db, TENANT_TABLES};
use sqlx::{Connection, PgConnection};

async fn migrated() -> (TestDb, PgConnection) {
    let t = TestDb::create().await.unwrap();
    t.migrate().await.unwrap();
    let c = PgConnection::connect(&t.url_as("pulsus_owner"))
        .await
        .unwrap();
    (t, c)
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn rls_catalog_every_tenant_table() {
    let (t, mut c) = migrated().await;
    let rows: Vec<(String, bool, bool, bool)> = sqlx::query_as(
        "SELECT c.relname::text, c.relrowsecurity, c.relforcerowsecurity,
                EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'org_isolation')
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          ORDER BY 1",
    )
    .fetch_all(&mut c)
    .await
    .unwrap();
    let tables: BTreeSet<&str> = rows
        .iter()
        .map(|r| r.0.as_str())
        .filter(|n| *n != "_sqlx_migrations" && *n != "pulsus_schema_level")
        .collect();
    let want: BTreeSet<&str> = TENANT_TABLES.iter().map(|(t, _)| *t).collect();
    assert_eq!(tables, want);
    for (name, enabled, forced, policy) in &rows {
        if want.contains(name.as_str()) {
            assert!(*enabled, "{name}: RLS not enabled");
            assert!(*forced, "{name}: RLS not forced");
            assert!(*policy, "{name}: no org_isolation policy");
        }
    }
    drop(c);
    t.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn org_id_leads_every_key() {
    let (t, mut c) = migrated().await;
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT t.relname::text, i.relname::text, a.attname::text
           FROM pg_index x
           JOIN pg_class t ON t.oid = x.indrelid
           JOIN pg_class i ON i.oid = x.indexrelid
           JOIN pg_namespace n ON n.oid = t.relnamespace
           LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.indkey[0]
          WHERE n.nspname = 'public'
          ORDER BY 1, 2",
    )
    .fetch_all(&mut c)
    .await
    .unwrap();
    let mut checked = 0;
    for (table, index, first) in &rows {
        let Some((_, col)) = TENANT_TABLES.iter().find(|(t, _)| t == table) else {
            continue;
        };
        if index == "orgs_slug_key" || index == "sessions_pkey" {
            continue;
        }
        assert_eq!(first, col, "{table}.{index}");
        checked += 1;
    }
    assert!(checked >= 14, "{rows:?}");
    drop(c);
    t.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn app_has_no_partition_privilege() {
    let (t, mut c) = migrated().await;
    let children: Vec<(String, bool)> = sqlx::query_as(
        "SELECT inhrelid::regclass::text, has_table_privilege('pulsus_app', inhrelid, 'SELECT')
           FROM pg_inherits",
    )
    .fetch_all(&mut c)
    .await
    .unwrap();
    for (child, app_select) in &children {
        assert!(
            !app_select,
            "pulsus_app can read partition {child} (T11-026)"
        );
    }
    drop(c);
    t.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn role_attributes() {
    let (t, mut c) = migrated().await;
    let rows: Vec<(String, bool)> = sqlx::query_as(
        "SELECT rolname::text, rolbypassrls FROM pg_roles
          WHERE rolname IN ('pulsus_app', 'pulsus_owner', 'pulsus_maint') ORDER BY 1",
    )
    .fetch_all(&mut c)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            ("pulsus_app".to_string(), false),
            ("pulsus_maint".to_string(), true),
            ("pulsus_owner".to_string(), true),
        ]
    );
    drop(c);
    t.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn builtin_roles_seeded() {
    let (t, c) = migrated().await;
    drop(c);
    let db = Db::connect_lazy(
        &Secret::new(t.url_as("pulsus_app")),
        2,
        Duration::from_secs(5),
    )
    .unwrap();
    let org = OrgId::new_v7();
    let mut tx = db.tx(org).await.unwrap();
    orgs::create(&mut tx, "acme", "Acme").await.unwrap();
    tx.commit().await.unwrap();
    let mut tx = db.tx(org).await.unwrap();
    let list = roles::list(&mut tx).await.unwrap();
    let names: Vec<&str> = list.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, vec!["Admin", "Editor", "Responder", "Viewer"]);
    assert!(list.iter().all(|r| r.builtin));
    tx.rollback().await.unwrap();
    let perms = t
        .owner_i64("SELECT count(*) FROM role_permissions")
        .await
        .unwrap();
    assert_eq!(perms, 0);
    drop(db);
    t.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn no_extensions_needed() {
    let (t, mut c) = migrated().await;
    if std::env::var("DASH_ITEST_EXPECT_VANILLA").as_deref() == Ok("1") {
        let available: Vec<String> =
            sqlx::query_scalar("SELECT name::text FROM pg_available_extensions ORDER BY 1")
                .fetch_all(&mut c)
                .await
                .unwrap();
        assert_eq!(available, vec!["plpgsql".to_string()]);
    }
    let installed: Vec<String> =
        sqlx::query_scalar("SELECT extname::text FROM pg_extension ORDER BY 1")
            .fetch_all(&mut c)
            .await
            .unwrap();
    assert_eq!(installed, vec!["plpgsql".to_string()]);
    drop(c);
    t.drop().await.unwrap();
}
