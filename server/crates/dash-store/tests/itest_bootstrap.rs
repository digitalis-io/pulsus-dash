#![allow(clippy::unwrap_used, clippy::expect_used)]
//! First-run seeding (issue scope, T06 §4.9). Run by `cargo xtask ci itest`.

use std::time::Duration;

use dash_core::{ScopeOrgId, Secret};
use dash_store::Db;
use dash_store::bootstrap::{DatasourceSeedRef, SeedOutcome, seed};
use dash_store::testing::TestDb;

async fn setup() -> (TestDb, Db) {
    let t = TestDb::create().await.unwrap();
    t.migrate().await.unwrap();
    let db = Db::connect_lazy(
        &Secret::new(t.url_as("pulsus_app")),
        4,
        Duration::from_secs(5),
    )
    .unwrap();
    (t, db)
}

fn seed_ref<'a>(url: &'a url::Url, scope: Option<&'a ScopeOrgId>) -> DatasourceSeedRef<'a> {
    DatasourceSeedRef {
        org_slug: "default",
        slug: "default",
        url,
        database: None,
        scope_org_id: scope,
    }
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn bootstrap_seeds_once() {
    let (t, db) = setup().await;
    let url = url::Url::parse("http://pulsusdb.invalid:9/").unwrap();
    let scope = ScopeOrgId::parse("").unwrap();
    let first = seed(&db, &seed_ref(&url, scope.as_ref())).await.unwrap();
    let SeedOutcome::Created { org } = first else {
        panic!("{first:?}")
    };
    let second = seed(&db, &seed_ref(&url, scope.as_ref())).await.unwrap();
    assert_eq!(
        second,
        SeedOutcome::AlreadySeeded {
            org,
            binding_differs: false
        }
    );
    assert_eq!(t.owner_i64("SELECT count(*) FROM orgs").await.unwrap(), 1);
    assert_eq!(
        t.owner_i64("SELECT count(*) FROM tenant_bindings")
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        t.owner_i64(
            "SELECT count(*) FROM tenant_bindings WHERE scope_org_id IS NULL AND kind = 'pulsusdb' AND credentials_ref IS NULL"
        )
        .await
        .unwrap(),
        1
    );
    drop(db);
    t.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn bootstrap_concurrent_single_org() {
    let (t, db) = setup().await;
    let url = url::Url::parse("http://pulsusdb.invalid:9/").unwrap();
    let s = seed_ref(&url, None);
    let (a, b) = tokio::join!(seed(&db, &s), seed(&db, &s));
    let outcomes = [a.unwrap(), b.unwrap()];
    let created = outcomes
        .iter()
        .filter(|o| matches!(o, SeedOutcome::Created { .. }))
        .count();
    assert_eq!(created, 1, "{outcomes:?}");
    assert_eq!(t.owner_i64("SELECT count(*) FROM orgs").await.unwrap(), 1);
    drop(db);
    t.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn bootstrap_reports_drift() {
    let (t, db) = setup().await;
    let url = url::Url::parse("http://pulsusdb.invalid:9/").unwrap();
    let other = url::Url::parse("http://other.invalid:9/").unwrap();
    seed(&db, &seed_ref(&url, None)).await.unwrap();
    let r = seed(&db, &seed_ref(&other, None)).await.unwrap();
    assert!(
        matches!(
            r,
            SeedOutcome::AlreadySeeded {
                binding_differs: true,
                ..
            }
        ),
        "{r:?}"
    );
    assert_eq!(
        t.owner_i64(
            "SELECT count(*) FROM tenant_bindings WHERE datasource_url = 'http://pulsusdb.invalid:9/'"
        )
        .await
        .unwrap(),
        1
    );
    drop(db);
    t.drop().await.unwrap();
}
