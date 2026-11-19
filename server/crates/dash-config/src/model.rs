//! The raw (strict) YAML schema and the validated per-subcommand configurations (plan §3.3).

use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

use dash_core::{ScopeOrgId, Secret};
use serde::Deserialize;
use url::Url;

use crate::error::ConfigError;
use crate::layer::LoadedConfig;
use crate::secret::SecretRef;

/// Top level of the configuration file.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawConfig {
    pub roles: Option<Vec<String>>,
    pub listen: Option<String>,
    pub public_url: Option<String>,
    pub allow_inline_secrets: Option<bool>,
    pub postgres: Option<RawPostgres>,
    pub assets: Option<RawAssets>,
    pub log: Option<RawLog>,
    pub datasources_bootstrap: Option<Vec<RawSeed>>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawPostgres {
    pub url_ref: Option<String>,
    pub owner_url_ref: Option<String>,
    pub pool_max: Option<u32>,
    pub connect_timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawAssets {
    pub dir: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawLog {
    pub filter: Option<String>,
    pub format: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawSeed {
    pub url: Option<String>,
    pub org_slug: Option<String>,
    pub slug: Option<String>,
    pub database: Option<String>,
    pub scope_org_id: Option<String>,
    pub credentials_ref: Option<String>,
}

/// A process role (T06-003). Only `All` is implemented in this build.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    All,
    Api,
    Worker,
    Evaluator,
    Notifier,
    Ai,
}

/// Log output format.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogFormat {
    Text,
    Json,
}

/// `log.*`.
#[derive(Clone, Debug)]
pub struct LogConfig {
    pub filter: String,
    pub format: LogFormat,
}

/// A Postgres connection: the URL reference and pool settings.
#[derive(Clone, Debug)]
pub struct PgConnect {
    pub url: SecretRef,
    pub pool_max: u32,
    pub connect_timeout: Duration,
}

/// Basic credentials for the PulsusDB datasource, held in memory only.
#[derive(Clone)]
pub struct BasicCredentials {
    pub user: Secret,
    pub password: Secret,
}

impl fmt::Debug for BasicCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("BasicCredentials { *** }")
    }
}

/// `datasources_bootstrap[0]`: the first-run seed of the default org's binding (T06 §4.9).
#[derive(Clone, Debug)]
pub struct DatasourceSeed {
    pub org_slug: String,
    pub slug: String,
    pub url: Url,
    pub database: Option<String>,
    pub scope_org_id: Option<ScopeOrgId>,
    /// `None` = no auth header (first-class mode).
    pub credentials: Option<BasicCredentials>,
}

/// Validated configuration of `pulsus-dash` (serve).
#[derive(Clone, Debug)]
pub struct ServeConfig {
    pub roles: Vec<Role>,
    pub listen: String,
    pub public_url: Option<Url>,
    pub postgres: PgConnect,
    pub assets_dir: PathBuf,
    pub log: LogConfig,
    pub bootstrap: DatasourceSeed,
}

/// Validated configuration of `pulsus-dash migrate`.
#[derive(Clone, Debug)]
pub struct MigrateConfig {
    pub owner: PgConnect,
    pub log: LogConfig,
}

impl LoadedConfig {
    /// Validates for `serve` (roles first, then table order) and resolves `credentials_ref`.
    pub fn for_serve(&self) -> Result<ServeConfig, ConfigError> {
        Err(ConfigError::Missing {
            key: String::new(),
            hint: "not implemented".into(),
        })
    }

    /// Validates for `migrate` (the owner URL reference is required; the seed is ignored).
    pub fn for_migrate(&self) -> Result<MigrateConfig, ConfigError> {
        Err(ConfigError::Missing {
            key: String::new(),
            hint: "not implemented".into(),
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use crate::layer::{ConfigInput, load};

    const SEED_KEY: &str = "datasources_bootstrap[0].credentials_ref";

    struct Fixture {
        dir: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                dir: tempfile::tempdir().unwrap(),
            }
        }

        /// The valid base YAML (plan §5) plus `extra` top-level YAML and `seed` lines under the
        /// bootstrap entry; `url` = None omits the seed URL.
        fn yaml(&self, extra: &str, url: Option<&str>, seed: &str) -> PathBuf {
            let assets = self.dir.path().join("assets");
            std::fs::create_dir_all(&assets).unwrap();
            let url_line = url
                .map(|u| format!("    url: \"{u}\"\n"))
                .unwrap_or_default();
            let text = format!(
                "allow_inline_secrets: true\npostgres:\n  url_ref: \"postgres://pulsus_app@localhost:1/x\"\nassets:\n  dir: \"{}\"\n{extra}datasources_bootstrap:\n  - slug: default\n{url_line}{seed}",
                assets.display()
            );
            let path = self.dir.path().join("cfg.yaml");
            std::fs::write(&path, text).unwrap();
            path
        }

        fn serve(
            &self,
            extra: &str,
            url: Option<&str>,
            seed: &str,
            env: &[(&str, &str)],
            roles: Option<&str>,
        ) -> Result<ServeConfig, ConfigError> {
            let input = ConfigInput {
                file: Some(self.yaml(extra, url, seed)),
                env: env
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_string()))
                    .collect(),
                cli_roles: roles.map(str::to_string),
            };
            load(&input)?.for_serve()
        }
    }

    const URL: Option<&str> = Some("http://pulsusdb.invalid:9");

    #[test]
    fn missing_url_names_setting() {
        let f = Fixture::new();
        let e = f.serve("", None, "", &[], None).unwrap_err();
        assert_eq!(
            e.to_string(),
            "missing required setting `datasources_bootstrap[0].url`: the PulsusDB base URL; set it in the --config file or PULSUS_DASH_DATASOURCES_BOOTSTRAP__0__URL"
        );
    }

    #[test]
    fn role_values() {
        let f = Fixture::new();
        let e = f.serve("", URL, "", &[], Some("api")).unwrap_err();
        assert_eq!(e, ConfigError::RoleNotImplemented { role: "api".into() });
        let e = f.serve("", URL, "", &[], Some("foo")).unwrap_err();
        assert!(
            matches!(&e, ConfigError::Invalid { key, .. } if key == "roles[0]"),
            "{e:?}"
        );
        assert!(e.to_string().contains("foo"), "{e}");
        let ok = f.serve("", URL, "", &[], None);
        assert!(ok.is_ok(), "{ok:?}");
        assert_eq!(ok.unwrap().roles, vec![Role::All]);
    }

    fn invalid_key(r: &Result<ServeConfig, ConfigError>, want: &str) -> String {
        match r {
            Err(e @ ConfigError::Invalid { key, reason, .. }) if key == want => {
                assert!(!e.to_string().contains("s3cr3t"), "{e}");
                reason.clone()
            }
            other => panic!("expected Invalid {{ key: {want} }}, got {other:?}"),
        }
    }

    #[test]
    fn credentials_ref_modes() {
        let f = Fixture::new();
        // (a) absent: no auth header.
        let a = f.serve("", URL, "", &[], None);
        assert!(a.is_ok(), "{a:?}");
        assert!(a.unwrap().bootstrap.credentials.is_none());
        // (b) env:
        let env = [("PDB_CRED", "reader:s3cr3t-pw"), ("PDB_NOCOLON", "abc")];
        let b = f.serve(
            "",
            URL,
            "    credentials_ref: \"env:PDB_CRED\"\n",
            &env,
            None,
        );
        assert!(b.is_ok(), "{b:?}");
        let b = b.unwrap();
        let c = b.bootstrap.credentials.as_ref().unwrap();
        assert_eq!(
            (c.user.expose(), c.password.expose()),
            ("reader", "s3cr3t-pw")
        );
        let dbg = format!("{b:?}");
        assert!(!dbg.contains("reader") && !dbg.contains("s3cr3t"), "{dbg}");
        // (c) file: one trailing newline trimmed.
        let file = f.dir.path().join("cred.txt");
        std::fs::write(&file, "reader:s3cr3t-pw\n").unwrap();
        let seed = format!("    credentials_ref: \"file:{}\"\n", file.display());
        let c = f.serve("", URL, &seed, &env, None).unwrap();
        let c = c.bootstrap.credentials.unwrap();
        assert_eq!(
            (c.user.expose(), c.password.expose()),
            ("reader", "s3cr3t-pw")
        );
        // (d)–(g)
        let d = f.serve(
            "",
            URL,
            "    credentials_ref: \"env:PDB_UNSET\"\n",
            &env,
            None,
        );
        assert_eq!(
            invalid_key(&d, SEED_KEY),
            "environment variable PDB_UNSET is not set"
        );
        let missing = f.dir.path().join("missing.txt");
        let seed = format!("    credentials_ref: \"file:{}\"\n", missing.display());
        let e = f.serve("", URL, &seed, &env, None);
        assert_eq!(invalid_key(&e, SEED_KEY), "cannot read the referenced file");
        let g = f.serve(
            "",
            URL,
            "    credentials_ref: \"vault://kv/p#k\"\n",
            &env,
            None,
        );
        assert_eq!(
            invalid_key(&g, SEED_KEY),
            "reference scheme `vault` is not supported in this release; use env: or file:"
        );
        let h = f.serve(
            "",
            URL,
            "    credentials_ref: \"env:PDB_NOCOLON\"\n",
            &env,
            None,
        );
        assert_eq!(invalid_key(&h, SEED_KEY), "must be user:password");
    }

    #[test]
    fn url_validation() {
        let f = Fixture::new();
        let bad = [
            ("https://u:pw-123@h/", "must not contain user info"),
            ("ftp://h/", "must use http or https"),
            (
                "https://h/?token=tok-456",
                "must not contain a query or fragment",
            ),
            (
                "https://h/#frag-789",
                "must not contain a query or fragment",
            ),
            ("ht!tp://sec ret", "not a valid URL"),
        ];
        for (u, want) in bad {
            // The seed URL.
            let r = f.serve("", Some(u), "", &[], None);
            let e = r.as_ref().unwrap_err().to_string();
            assert_eq!(invalid_key(&r, "datasources_bootstrap[0].url"), want, "{u}");
            // The public URL.
            let r = f.serve(&format!("public_url: \"{u}\"\n"), URL, "", &[], None);
            let e2 = r.as_ref().unwrap_err().to_string();
            assert_eq!(invalid_key(&r, "public_url"), want, "{u}");
            for leak in ["pw-123", "tok-456", "frag-789", "sec ret"] {
                assert!(!e.contains(leak) && !e2.contains(leak), "{e} / {e2}");
            }
        }
        let ok = f.serve(
            "public_url: \"https://pulsusdb.example:8080/base\"\n",
            Some("https://pulsusdb.example:8080/base"),
            "",
            &[],
            None,
        );
        assert!(ok.is_ok(), "{ok:?}");
    }
}
