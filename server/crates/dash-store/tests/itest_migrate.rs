#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The migration runner and the N+1 window (T11-015, T19-007). Run by `cargo xtask ci itest`.

use std::time::Duration;

use dash_core::Secret;
use dash_store::testing::TestDb;
use dash_store::{Db, SchemaStatus, StoreError, migrate};

const V1: i64 = 20261119000001;
const V2: i64 = 20261119000002;

fn app(t: &TestDb) -> Db {
    Db::connect_lazy(
        &Secret::new(t.url_as("pulsus_app")),
        2,
        Duration::from_secs(5),
    )
    .unwrap()
}

const HAS_LEVEL_TABLE: &str = "SELECT count(*) FROM pg_class WHERE relname = 'pulsus_schema_level'";
const HAS_MIGRATIONS_TABLE: &str =
    "SELECT count(*) FROM pg_class WHERE relname = '_sqlx_migrations'";

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn migrate_fresh_and_idempotent() {
    let t = TestDb::create().await.unwrap();
    assert_eq!(t.owner_i64(HAS_LEVEL_TABLE).await.unwrap(), 0);
    let first = t.migrate().await.unwrap();
    assert_eq!(first.applied, vec![V1, V2]);
    assert_eq!(first.level, 1);
    let second = t.migrate().await.unwrap();
    assert!(second.applied.is_empty(), "{second:?}");
    assert_eq!(second.level, 1);
    let db = app(&t);
    assert_eq!(
        db.schema_status().await.unwrap(),
        SchemaStatus::Compatible { level: 1 }
    );
    drop(db);
    t.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn migrate_level_read_error_propagates() {
    let t = TestDb::create().await.unwrap();
    t.owner_exec(
        "CREATE TABLE pulsus_schema_level (level text); INSERT INTO pulsus_schema_level VALUES ('x');",
    )
    .await
    .unwrap();
    let r = t.migrate().await;
    assert!(matches!(r, Err(StoreError::Other(_))), "{r:?}");
    assert_eq!(t.owner_i64(HAS_MIGRATIONS_TABLE).await.unwrap(), 0);
    t.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn migrate_window() {
    let t = TestDb::create().await.unwrap();
    t.migrate().await.unwrap();
    let db = app(&t);
    t.owner_exec("UPDATE pulsus_schema_level SET level = 3")
        .await
        .unwrap();
    let r = t.migrate().await;
    assert!(
        matches!(r, Err(StoreError::SchemaTooNew { db: 3, max: 1 })),
        "{r:?}"
    );
    assert_eq!(
        db.schema_status().await.unwrap(),
        SchemaStatus::TooNew { level: 3 }
    );
    t.owner_exec("UPDATE pulsus_schema_level SET level = 2")
        .await
        .unwrap();
    assert_eq!(
        db.schema_status().await.unwrap(),
        SchemaStatus::Compatible { level: 2 }
    );
    let again = t.migrate().await.unwrap();
    assert!(again.applied.is_empty());
    drop(db);
    t.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn schema_status_unmigrated() {
    let t = TestDb::create().await.unwrap();
    let db = app(&t);
    let r = db.schema_status().await;
    assert!(matches!(r, Err(StoreError::NotMigrated)), "{r:?}");
    drop(db);
    t.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn migrate_concurrent_runs_serialise() {
    let t = TestDb::create().await.unwrap();
    let owner = Secret::new(t.url_as("pulsus_owner"));
    let (a, b) = tokio::join!(migrate::run(&owner), migrate::run(&owner));
    assert!(a.is_ok(), "{a:?}");
    assert!(b.is_ok(), "{b:?}");
    let mut applied = a.unwrap().applied;
    applied.extend(b.unwrap().applied);
    applied.sort();
    assert_eq!(applied, vec![V1, V2]);
    assert_eq!(
        t.owner_i64("SELECT count(*) FROM _sqlx_migrations")
            .await
            .unwrap(),
        2
    );
    t.drop().await.unwrap();
}
