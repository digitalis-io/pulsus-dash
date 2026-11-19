#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `Debug` of store types holding URLs or connection settings redacts them (review r3 #4).

use std::time::Duration;

use dash_core::Secret;
use dash_store::Db;
use dash_store::bootstrap::DatasourceSeedRef;
use dash_store::repo::tenant_bindings::NewTenantBinding;

const LEAKS: [&str; 3] = ["sentinel", "p-tok-s", "pgpw-s"];

fn assert_clean(what: &str, text: &str) {
    for l in LEAKS {
        assert!(!text.contains(l), "{what} Debug contains {l}: {text}");
    }
}

#[tokio::test]
async fn store_debug_redacts_urls() {
    let url = url::Url::parse("http://pulsusdb.sentinel.invalid:9/p-tok-s/").unwrap();
    let seed = DatasourceSeedRef {
        org_slug: "default",
        slug: "default",
        url: &url,
        database: None,
        scope_org_id: None,
    };
    assert_clean("DatasourceSeedRef", &format!("{seed:?}"));
    let b = NewTenantBinding {
        slug: "default",
        datasource_url: &url,
        database: None,
        scope_org_id: None,
    };
    assert_clean("NewTenantBinding", &format!("{b:?}"));
    let db = Db::connect_lazy(
        &Secret::new("postgres://u:pgpw-s@pg.sentinel.invalid:1/x".into()),
        1,
        Duration::from_secs(1),
    )
    .unwrap();
    assert_clean("Db", &format!("{db:?}"));
}
