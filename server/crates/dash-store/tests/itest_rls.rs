#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `itest:rls-isolation` (ENT-020, T11-003, T11-027): every repository function and every tenant
//! table under the wrong org sees zero rows. Run by `cargo xtask ci itest`.

use std::time::Duration;

use dash_core::{OrgId, ScopeOrgId, Secret};
use dash_store::bootstrap::{self, DatasourceSeedRef, SeedOutcome};
use dash_store::repo::tenant_bindings::NewTenantBinding;
use dash_store::repo::{orgs, roles, tenant_bindings};
use dash_store::testing::{
    TestDb, app_count_unset_org, insert_fixture, owner_insert_session, visible_orgs,
};
use dash_store::{Db, StoreError, TENANT_TABLES};

/// Every public repository and bootstrap function; `repo_registry` checks the list is complete
/// and the test below exercises each under the wrong org.
pub const REPO_FNS: &[&str] = &[
    "orgs::create",
    "orgs::get",
    "tenant_bindings::insert",
    "tenant_bindings::list",
    "tenant_bindings::get_by_slug",
    "roles::list",
    "bootstrap::seed",
];

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

fn sqlstate(r: &Result<Vec<uuid::Uuid>, StoreError>) -> Option<String> {
    r.as_ref().err().and_then(StoreError::sqlstate)
}

/// Fixture rows in every app-writable table for `org` (one committed transaction), plus a
/// session row written by the owner.
async fn fixtures(t: &TestDb, db: &Db, org: OrgId) {
    let mut tx = db.tx(org).await.unwrap();
    for (table, _) in TENANT_TABLES.iter().filter(|(t, _)| *t != "sessions") {
        insert_fixture(&mut tx, table, org).await.unwrap();
    }
    tx.commit().await.unwrap();
    owner_insert_session(t, org).await.unwrap();
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn rls_tenant_a_sees_no_tenant_b_row() {
    let (t, db) = setup().await;
    let (a, b) = (OrgId::new_v7(), OrgId::new_v7());
    fixtures(&t, &db, a).await;
    fixtures(&t, &db, b).await;
    for (table, col) in TENANT_TABLES {
        let mut tx = db.tx(a).await.unwrap();
        let r = visible_orgs(&mut tx, table, col).await;
        if *table == "sessions" {
            assert_eq!(sqlstate(&r).as_deref(), Some("42501"), "{table}: {r:?}");
        } else {
            assert_eq!(r.unwrap(), vec![a.0], "{table}");
        }
        tx.rollback().await.unwrap();
    }
    drop(db);
    t.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn rls_every_repo_fn_wrong_org_zero_rows() {
    let (t, db) = setup().await;
    let url = url::Url::parse("http://pulsusdb.invalid:9/").unwrap();
    let scope = ScopeOrgId::parse("tenant-a").unwrap();
    let binding = |slug| NewTenantBinding {
        slug,
        datasource_url: &url,
        database: None,
        scope_org_id: scope.as_ref(),
    };
    let (a, b, c) = (OrgId::new_v7(), OrgId::new_v7(), OrgId::new_v7());
    for (org, slug) in [(a, "org-a"), (b, "org-b")] {
        let mut tx = db.tx(org).await.unwrap();
        orgs::create(&mut tx, slug, slug).await.unwrap();
        tenant_bindings::insert(&mut tx, binding("default"))
            .await
            .unwrap();
        if org == a {
            tenant_bindings::insert(&mut tx, binding("a-only"))
                .await
                .unwrap();
        }
        tx.commit().await.unwrap();
    }
    // Org C was never created: every read is empty.
    let mut tx = db.tx(c).await.unwrap();
    assert!(orgs::get(&mut tx).await.unwrap().is_none());
    assert!(tenant_bindings::list(&mut tx).await.unwrap().is_empty());
    assert!(
        tenant_bindings::get_by_slug(&mut tx, "default")
            .await
            .unwrap()
            .is_none()
    );
    assert!(roles::list(&mut tx).await.unwrap().is_empty());
    tx.rollback().await.unwrap();
    // B cannot see A's binding.
    let mut tx = db.tx(b).await.unwrap();
    assert!(
        tenant_bindings::get_by_slug(&mut tx, "a-only")
            .await
            .unwrap()
            .is_none()
    );
    // A committed insert in B is invisible to A.
    tenant_bindings::insert(&mut tx, binding("b-new"))
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let mut tx = db.tx(a).await.unwrap();
    let slugs: Vec<String> = tenant_bindings::list(&mut tx)
        .await
        .unwrap()
        .into_iter()
        .map(|b| b.slug)
        .collect();
    assert_eq!(slugs, vec!["a-only".to_string(), "default".to_string()]);
    assert!(
        tenant_bindings::get_by_slug(&mut tx, "b-new")
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(orgs::get(&mut tx).await.unwrap().unwrap().id, a);
    assert_eq!(roles::list(&mut tx).await.unwrap().len(), 4);
    tx.rollback().await.unwrap();
    // A seeded org is invisible to A.
    let seeded = bootstrap::seed(
        &db,
        &DatasourceSeedRef {
            org_slug: "seeded",
            slug: "seeded-binding",
            url: &url,
            database: None,
            scope_org_id: None,
        },
    )
    .await
    .unwrap();
    assert!(matches!(seeded, SeedOutcome::Created { org } if org != a));
    let mut tx = db.tx(a).await.unwrap();
    assert!(
        tenant_bindings::get_by_slug(&mut tx, "seeded-binding")
            .await
            .unwrap()
            .is_none()
    );
    tx.rollback().await.unwrap();
    drop(db);
    t.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn rls_with_check_blocks_foreign_org() {
    let (t, db) = setup().await;
    let (a, b) = (OrgId::new_v7(), OrgId::new_v7());
    fixtures(&t, &db, a).await;
    fixtures(&t, &db, b).await;
    for (table, _) in TENANT_TABLES
        .iter()
        .filter(|(t, _)| *t != "orgs" && *t != "sessions")
    {
        let mut tx = db.tx(a).await.unwrap();
        let r = insert_fixture(&mut tx, table, b).await;
        let state = r.as_ref().err().and_then(StoreError::sqlstate);
        assert_eq!(state.as_deref(), Some("42501"), "{table}: {r:?}");
        assert!(matches!(r, Err(StoreError::Rls(_))), "{table}: {r:?}");
        tx.rollback().await.unwrap();
    }
    drop(db);
    t.drop().await.unwrap();
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn rls_unset_org_fails_closed() {
    let (t, db) = setup().await;
    let a = OrgId::new_v7();
    fixtures(&t, &db, a).await;
    for (table, _) in TENANT_TABLES.iter().filter(|(t, _)| *t != "sessions") {
        let n = app_count_unset_org(&t.url_as("pulsus_app"), table).await;
        assert_eq!(n.unwrap(), 0, "{table}");
    }
    drop(db);
    t.drop().await.unwrap();
}
