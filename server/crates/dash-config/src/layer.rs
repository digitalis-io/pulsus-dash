//! Layering (plan §4.2): YAML file, then `PULSUS_DASH_*` environment variables, then CLI flags,
//! merged into one JSON value and deserialised strictly.

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::error::{ConfigError, Source};
use crate::model::RawConfig;

/// Everything `load` reads: the `--config` path, the process environment snapshot and `--role`.
#[derive(Clone, Debug, Default)]
pub struct ConfigInput {
    pub file: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub cli_roles: Option<String>,
}

/// Parsed and merged configuration, not yet validated for a subcommand.
#[derive(Clone, Debug)]
pub struct LoadedConfig {
    pub(crate) raw: RawConfig,
    /// Leaf path → the layer that set it last.
    pub(crate) sources: BTreeMap<String, Source>,
    /// The environment snapshot, for `env:` secret references.
    pub(crate) env: Vec<(String, String)>,
}

/// Parses and merges the layers; unknown keys and type errors fail here.
pub fn load(input: &ConfigInput) -> Result<LoadedConfig, ConfigError> {
    let _ = input;
    Err(ConfigError::Missing {
        key: String::new(),
        hint: "not implemented".into(),
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn yaml(text: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.yaml");
        std::fs::write(&path, text).unwrap();
        (dir, path)
    }

    fn input(file: Option<PathBuf>, env: &[(&str, &str)]) -> ConfigInput {
        ConfigInput {
            file,
            env: env
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            cli_roles: None,
        }
    }

    #[test]
    fn yaml_unknown_keys() {
        let (_d, p) = yaml("listen_port: 1\n");
        let e = load(&input(Some(p.clone()), &[])).unwrap_err();
        assert_eq!(
            e,
            ConfigError::UnknownKey {
                key: "listen_port".into(),
                source: Source::File(p.clone())
            }
        );
        let (_d, p) = yaml("postgres: {url_ref: \"env:X\", pool_size: 3}\n");
        let e = load(&input(Some(p.clone()), &[])).unwrap_err();
        assert_eq!(
            e,
            ConfigError::UnknownKey {
                key: "postgres.pool_size".into(),
                source: Source::File(p.clone())
            }
        );
        assert!(
            e.to_string()
                .starts_with("unknown configuration key `postgres.pool_size` (in "),
            "{e}"
        );
    }

    #[test]
    fn env_unknown_variable() {
        let e = load(&input(None, &[("PULSUS_DASH_LISTEN_PORT", "1")])).unwrap_err();
        assert_eq!(
            e,
            ConfigError::UnknownKey {
                key: "listen_port".into(),
                source: Source::Env("PULSUS_DASH_LISTEN_PORT".into())
            }
        );
        assert_eq!(
            e.to_string(),
            "unknown configuration key `listen_port` (from environment variable PULSUS_DASH_LISTEN_PORT)"
        );
    }

    #[test]
    fn env_overrides_and_indexes() {
        let (_d, p) = yaml("listen: a:1\n");
        let l = load(&input(
            Some(p.clone()),
            &[
                ("PULSUS_DASH_LISTEN", "b:2"),
                (
                    "PULSUS_DASH_DATASOURCES_BOOTSTRAP__0__URL",
                    "http://pulsusdb.invalid:9",
                ),
                ("UNRELATED", "x"),
            ],
        ));
        assert!(l.is_ok(), "{l:?}");
        let l = l.unwrap();
        assert_eq!(l.raw.listen.as_deref(), Some("b:2"));
        let seeds = l.raw.datasources_bootstrap.as_ref().unwrap();
        let url = url::Url::parse(seeds[0].url.as_deref().unwrap()).unwrap();
        assert_eq!(url.host_str(), Some("pulsusdb.invalid"));
        assert_eq!(
            l.sources.get("listen"),
            Some(&Source::Env("PULSUS_DASH_LISTEN".into()))
        );
        let e = load(&input(
            Some(p),
            &[(
                "PULSUS_DASH_DATASOURCES_BOOTSTRAP__2__URL",
                "http://pulsusdb.invalid:9",
            )],
        ))
        .unwrap_err();
        assert!(
            matches!(&e, ConfigError::Invalid { key, .. } if key == "datasources_bootstrap[2]"),
            "{e:?}"
        );
    }
}
