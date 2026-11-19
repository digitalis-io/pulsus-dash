//! The raw (strict) YAML schema and the validated per-subcommand configurations (plan §3.3).

use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

use dash_core::{ScopeOrgId, Secret};
use serde::{Deserialize, Deserializer};
use url::Url;

use crate::error::{ConfigError, Source};
use crate::layer::{LoadedConfig, source_of};
use crate::secret::SecretRef;

/// A string setting; numbers and booleans (as an environment value parses them) are accepted as
/// their text.
fn text<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    match Option::<serde_json::Value>::deserialize(d)? {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::String(s)) => Ok(Some(s)),
        Some(serde_json::Value::Number(n)) => Ok(Some(n.to_string())),
        Some(serde_json::Value::Bool(b)) => Ok(Some(b.to_string())),
        Some(_) => Err(serde::de::Error::custom("expected a string")),
    }
}

/// Top level of the configuration file.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawConfig {
    pub roles: Option<Vec<String>>,
    #[serde(default, deserialize_with = "text")]
    pub listen: Option<String>,
    #[serde(default, deserialize_with = "text")]
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
    #[serde(default, deserialize_with = "text")]
    pub url_ref: Option<String>,
    #[serde(default, deserialize_with = "text")]
    pub owner_url_ref: Option<String>,
    pub pool_max: Option<u32>,
    pub connect_timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawAssets {
    #[serde(default, deserialize_with = "text")]
    pub dir: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawLog {
    #[serde(default, deserialize_with = "text")]
    pub filter: Option<String>,
    #[serde(default, deserialize_with = "text")]
    pub format: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RawSeed {
    #[serde(default, deserialize_with = "text")]
    pub url: Option<String>,
    #[serde(default, deserialize_with = "text")]
    pub org_slug: Option<String>,
    #[serde(default, deserialize_with = "text")]
    pub slug: Option<String>,
    #[serde(default, deserialize_with = "text")]
    pub database: Option<String>,
    #[serde(default, deserialize_with = "text")]
    pub scope_org_id: Option<String>,
    #[serde(default, deserialize_with = "text")]
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

const ROLE_NAMES: [(&str, Role); 6] = [
    ("all", Role::All),
    ("api", Role::Api),
    ("worker", Role::Worker),
    ("evaluator", Role::Evaluator),
    ("notifier", Role::Notifier),
    ("ai", Role::Ai),
];

const URL_KEY: &str = "datasources_bootstrap[0].url";

fn hint(what: &str, var: &str) -> String {
    format!("{what}; set it in the --config file or {var}")
}

impl LoadedConfig {
    fn source(&self, key: &str) -> Option<Source> {
        source_of(&self.sources, key)
    }

    fn invalid(&self, key: &str, reason: impl Into<String>) -> ConfigError {
        ConfigError::Invalid {
            key: key.to_string(),
            source: self.source(key),
            reason: reason.into(),
        }
    }

    /// Adds the source to an `Invalid` raised below this layer.
    fn sourced(&self, e: ConfigError) -> ConfigError {
        match e {
            ConfigError::Invalid {
                key,
                source: None,
                reason,
            } => {
                let source = self.source(&key);
                ConfigError::Invalid {
                    key,
                    source,
                    reason,
                }
            }
            other => other,
        }
    }

    fn roles(&self) -> Result<Vec<Role>, ConfigError> {
        let names = self
            .raw
            .roles
            .clone()
            .unwrap_or_else(|| vec!["all".to_string()]);
        if names.is_empty() {
            return Err(self.invalid("roles", "must name at least one role"));
        }
        let mut roles = Vec::new();
        for (i, n) in names.iter().enumerate() {
            let role = ROLE_NAMES
                .iter()
                .find(|(name, _)| name == n)
                .map(|(_, r)| *r)
                .ok_or_else(|| {
                    self.invalid(
                        &format!("roles[{i}]"),
                        format!(
                            "unknown role `{n}`; expected one of all, api, worker, evaluator, notifier, ai"
                        ),
                    )
                })?;
            roles.push(role);
        }
        if let Some(i) = roles.iter().position(|r| *r != Role::All) {
            return Err(ConfigError::RoleNotImplemented {
                role: names[i].clone(),
            });
        }
        Ok(roles)
    }

    fn allow_inline(&self) -> bool {
        self.raw.allow_inline_secrets.unwrap_or(false)
    }

    fn secret_ref(
        &self,
        key: &str,
        raw: Option<&String>,
    ) -> Result<Option<SecretRef>, ConfigError> {
        raw.map(|r| SecretRef::parse(r, key, self.allow_inline()))
            .transpose()
            .map_err(|e| self.sourced(e))
    }

    fn pg(&self, url: SecretRef) -> Result<PgConnect, ConfigError> {
        let pg = self.raw.postgres.clone().unwrap_or_default();
        let pool_max = pg.pool_max.unwrap_or(32);
        if !(1..=1024).contains(&pool_max) {
            return Err(self.invalid("postgres.pool_max", "must be between 1 and 1024"));
        }
        let ms = pg.connect_timeout_ms.unwrap_or(2000);
        if !(100..=60_000).contains(&ms) {
            return Err(self.invalid(
                "postgres.connect_timeout_ms",
                "must be between 100 and 60000",
            ));
        }
        Ok(PgConnect {
            url,
            pool_max,
            connect_timeout: Duration::from_millis(ms),
        })
    }

    fn log(&self) -> Result<LogConfig, ConfigError> {
        let log = self.raw.log.clone().unwrap_or_default();
        let filter = log.filter.unwrap_or_else(|| "info".to_string());
        if filter.trim().is_empty() {
            return Err(self.invalid("log.filter", "must not be empty"));
        }
        let format = match log.format.as_deref().unwrap_or("text") {
            "text" => LogFormat::Text,
            "json" => LogFormat::Json,
            _ => return Err(self.invalid("log.format", "must be text or json")),
        };
        Ok(LogConfig { filter, format })
    }

    /// A plain http(s) URL setting; reasons never echo the value (plan §3.3).
    fn url(&self, key: &str, raw: &str) -> Result<Url, ConfigError> {
        let u = Url::parse(raw).map_err(|_| self.invalid(key, "not a valid URL"))?;
        if !matches!(u.scheme(), "http" | "https") {
            return Err(self.invalid(key, "must use http or https"));
        }
        if u.host_str().is_none_or(str::is_empty) {
            return Err(self.invalid(key, "must have a host"));
        }
        if !u.username().is_empty() || u.password().is_some() {
            return Err(self.invalid(key, "must not contain user info"));
        }
        if u.query().is_some() || u.fragment().is_some() {
            return Err(self.invalid(key, "must not contain a query or fragment"));
        }
        Ok(u)
    }

    fn slug(&self, key: &str, raw: Option<&String>) -> Result<String, ConfigError> {
        let s = raw.cloned().unwrap_or_else(|| "default".to_string());
        let ok = (1..=40).contains(&s.len())
            && s.bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
        if ok {
            Ok(s)
        } else {
            Err(self.invalid(key, "must match ^[a-z0-9-]{1,40}$"))
        }
    }

    fn seed(&self) -> Result<DatasourceSeed, ConfigError> {
        let list = self.raw.datasources_bootstrap.clone().unwrap_or_default();
        if list.len() > 1 {
            return Err(self.invalid(
                "datasources_bootstrap",
                "exactly one entry is supported in this release",
            ));
        }
        let seed = list.into_iter().next().unwrap_or_default();
        let raw_url = seed.url.as_deref().ok_or_else(|| ConfigError::Missing {
            key: URL_KEY.to_string(),
            hint: hint(
                "the PulsusDB base URL",
                "PULSUS_DASH_DATASOURCES_BOOTSTRAP__0__URL",
            ),
        })?;
        let url = self.url(URL_KEY, raw_url)?;
        let org_slug = self.slug("datasources_bootstrap[0].org_slug", seed.org_slug.as_ref())?;
        let slug = self.slug("datasources_bootstrap[0].slug", seed.slug.as_ref())?;
        let database = seed.database.filter(|d| !d.is_empty());
        if database.as_ref().is_some_and(|d| d.chars().count() > 128) {
            return Err(self.invalid(
                "datasources_bootstrap[0].database",
                "must be 1 to 128 characters",
            ));
        }
        let scope_org_id = ScopeOrgId::parse(seed.scope_org_id.as_deref().unwrap_or(""))
            .map_err(|e| self.invalid("datasources_bootstrap[0].scope_org_id", e.to_string()))?;
        let key = "datasources_bootstrap[0].credentials_ref";
        let credentials = match self.secret_ref(key, seed.credentials_ref.as_ref())? {
            None => None,
            Some(r) => {
                let secret = r.resolve_in(key, &self.env).map_err(|e| self.sourced(e))?;
                let (user, password) = secret
                    .expose()
                    .split_once(':')
                    .filter(|(u, p)| !u.is_empty() && !p.is_empty())
                    .ok_or_else(|| self.invalid(key, "must be user:password"))?;
                Some(BasicCredentials {
                    user: Secret::new(user.to_string()),
                    password: Secret::new(password.to_string()),
                })
            }
        };
        Ok(DatasourceSeed {
            org_slug,
            slug,
            url,
            database,
            scope_org_id,
            credentials,
        })
    }

    /// Validates for `serve` (roles first, then table order) and resolves `credentials_ref`.
    pub fn for_serve(&self) -> Result<ServeConfig, ConfigError> {
        let roles = self.roles()?;
        let listen = self
            .raw
            .listen
            .clone()
            .unwrap_or_else(|| "0.0.0.0:8080".to_string());
        let port_ok = listen
            .rsplit_once(':')
            .is_some_and(|(_, p)| p.parse::<u16>().is_ok());
        if !port_ok {
            return Err(self.invalid("listen", "must be host:port"));
        }
        let public_url = self
            .raw
            .public_url
            .as_deref()
            .map(|u| self.url("public_url", u))
            .transpose()?;
        let pg = self.raw.postgres.clone().unwrap_or_default();
        let url = self
            .secret_ref("postgres.url_ref", pg.url_ref.as_ref())?
            .ok_or_else(|| ConfigError::Missing {
                key: "postgres.url_ref".into(),
                hint: hint(
                    "the application Postgres connection (role pulsus_app), as a secret reference",
                    "PULSUS_DASH_POSTGRES__URL_REF",
                ),
            })?;
        let postgres = self.pg(url)?;
        let dir = self
            .raw
            .assets
            .as_ref()
            .and_then(|a| a.dir.clone())
            .unwrap_or_else(|| "web".to_string());
        let assets_dir = PathBuf::from(dir);
        if !assets_dir.is_dir() {
            return Err(self.invalid("assets.dir", "must be an existing directory"));
        }
        let log = self.log()?;
        let bootstrap = self.seed()?;
        Ok(ServeConfig {
            roles,
            listen,
            public_url,
            postgres,
            assets_dir,
            log,
            bootstrap,
        })
    }

    /// Validates for `migrate` (the owner URL reference is required; the seed is ignored).
    pub fn for_migrate(&self) -> Result<MigrateConfig, ConfigError> {
        self.roles()?;
        let pg = self.raw.postgres.clone().unwrap_or_default();
        let url = self
            .secret_ref("postgres.owner_url_ref", pg.owner_url_ref.as_ref())?
            .ok_or_else(|| ConfigError::Missing {
                key: "postgres.owner_url_ref".into(),
                hint: hint(
                    "the owner Postgres connection used by migrate (role pulsus_owner), as a secret reference",
                    "PULSUS_DASH_POSTGRES__OWNER_URL_REF",
                ),
            })?;
        let owner = self.pg(url)?;
        let log = self.log()?;
        Ok(MigrateConfig { owner, log })
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
