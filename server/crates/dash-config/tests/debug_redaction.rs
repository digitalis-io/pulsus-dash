#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `Debug` of every configuration type redacts environment values, secrets and configured URLs
//! (review r3 #4; plan §3.3 output rule).

use dash_config::{ConfigInput, load};

/// Fragments of the sentinel values; none may appear in any `Debug` output.
const LEAKS: [&str; 6] = [
    "sentinel-pw",
    "pulsusdb.sentinel",
    "p-tok-s",
    "pgpw-s",
    "pub.sentinel",
    "pp-path-s",
];

fn assert_clean(what: &str, text: &str) {
    for l in LEAKS {
        assert!(!text.contains(l), "{what} Debug contains {l}: {text}");
    }
}

#[test]
fn config_debug_redacts_values() {
    let dir = tempfile::tempdir().unwrap();
    let yaml = format!(
        "allow_inline_secrets: true\npublic_url: \"https://pub.sentinel.invalid/pp-path-s/\"\npostgres:\n  url_ref: \"postgres://u:pgpw-s@h/d\"\n  owner_url_ref: \"postgres://o:pgpw-s@h/d\"\nassets:\n  dir: \"{}\"\ndatasources_bootstrap:\n  - credentials_ref: \"env:PDB_CRED\"\n",
        dir.path().display()
    );
    let file = dir.path().join("cfg.yaml");
    std::fs::write(&file, yaml).unwrap();
    let input = ConfigInput {
        file: Some(file),
        env: vec![
            ("PDB_CRED".into(), "reader:sentinel-pw".into()),
            (
                "PULSUS_DASH_DATASOURCES_BOOTSTRAP__0__URL".into(),
                "http://pulsusdb.sentinel.invalid:9/p-tok-s/".into(),
            ),
        ],
        cli_roles: None,
    };
    assert_clean("ConfigInput", &format!("{input:?}"));
    let loaded = load(&input).unwrap();
    assert_clean("LoadedConfig", &format!("{loaded:?}"));
    let serve = loaded.for_serve().unwrap();
    assert_clean("ServeConfig", &format!("{serve:?}"));
    assert_clean("DatasourceSeed", &format!("{:?}", serve.bootstrap));
    assert_clean("PgConnect", &format!("{:?}", serve.postgres));
    let migrate = loaded.for_migrate().unwrap();
    assert_clean("MigrateConfig", &format!("{migrate:?}"));
    // Still useful: names, not values.
    assert!(format!("{input:?}").contains("PDB_CRED"));
    assert!(format!("{serve:?}").contains("<redacted>"));
}
