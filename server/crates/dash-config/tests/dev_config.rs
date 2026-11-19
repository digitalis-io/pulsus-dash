#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The tracked dev configuration loads for both subcommands (plan §3.10, review r3 #2).

use dash_config::{ConfigError, ConfigInput, SecretRef, load, resolve_postgres_url};

const DEV_YAML: &str = include_str!("../../../../dev/pulsus-dash.dev.yaml");

fn input(dir: &tempfile::TempDir, extra_env: &[(&str, &str)]) -> ConfigInput {
    let file = dir.path().join("pulsus-dash.dev.yaml");
    std::fs::write(&file, DEV_YAML).unwrap();
    let mut env = vec![
        (
            "PULSUS_DASH_DATASOURCES_BOOTSTRAP__0__URL".to_string(),
            "http://pulsusdb.invalid:9".to_string(),
        ),
        (
            "PULSUS_DASH_ASSETS__DIR".to_string(),
            dir.path().display().to_string(),
        ),
    ];
    env.extend(
        extra_env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string())),
    );
    ConfigInput {
        file: Some(file),
        env,
        cli_roles: None,
    }
}

#[test]
fn dev_config_loads() {
    let dir = tempfile::tempdir().unwrap();
    let loaded = load(&input(&dir, &[]));
    assert!(loaded.is_ok(), "{loaded:?}");
    let loaded = loaded.unwrap();
    let serve = loaded.for_serve();
    assert!(serve.is_ok(), "{serve:?}");
    let migrate = loaded.for_migrate();
    assert!(migrate.is_ok(), "{migrate:?}");
    let (serve, migrate) = (serve.unwrap(), migrate.unwrap());
    for (r, key) in [
        (&serve.postgres.url, "postgres.url_ref"),
        (&migrate.owner.url, "postgres.owner_url_ref"),
    ] {
        assert!(matches!(r, SecretRef::Inline(_)), "{key}: {r:?}");
        let url = resolve_postgres_url(r, key, &[]).unwrap();
        assert!(url.expose().starts_with("postgres://"), "{key}");
    }
    let refused = load(&input(
        &dir,
        &[("PULSUS_DASH_ALLOW_INLINE_SECRETS", "false")],
    ))
    .unwrap()
    .for_serve();
    assert!(
        matches!(&refused, Err(ConfigError::Invalid { key, .. }) if key == "postgres.url_ref"),
        "{refused:?}"
    );
}
