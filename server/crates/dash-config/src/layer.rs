//! Layering (plan §4.2): YAML file, then `PULSUS_DASH_*` environment variables, then CLI flags,
//! merged into one JSON value and deserialised strictly.

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::{Map, Value};

use crate::error::{ConfigError, Source};
use crate::model::RawConfig;

/// Prefix of the environment variables that set configuration keys.
pub const ENV_PREFIX: &str = "PULSUS_DASH_";

/// Everything `load` reads: the `--config` path, the process environment snapshot and `--role`.
/// `Debug` prints environment variable names only, never their values.
#[derive(Clone, Default)]
pub struct ConfigInput {
    pub file: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub cli_roles: Option<String>,
}

/// Parsed and merged configuration, not yet validated for a subcommand. `Debug` prints the set
/// keys and their sources, never values or the environment.
#[derive(Clone)]
pub struct LoadedConfig {
    pub(crate) raw: RawConfig,
    /// Leaf path → the layer that set it last.
    pub(crate) sources: BTreeMap<String, Source>,
    /// The environment snapshot, for `env:` secret references.
    pub(crate) env: Vec<(String, String)>,
}

fn env_names(env: &[(String, String)]) -> Vec<&str> {
    env.iter().map(|(k, _)| k.as_str()).collect()
}

impl std::fmt::Debug for ConfigInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConfigInput")
            .field("file", &self.file)
            .field("env", &env_names(&self.env))
            .field("cli_roles", &self.cli_roles)
            .finish()
    }
}

impl std::fmt::Debug for LoadedConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoadedConfig")
            .field("keys", &self.sources)
            .field("env", &env_names(&self.env))
            .finish()
    }
}

/// Parses and merges the layers; unknown keys and type errors fail here.
pub fn load(input: &ConfigInput) -> Result<LoadedConfig, ConfigError> {
    let mut root = Value::Object(Map::new());
    let mut sources = BTreeMap::new();
    if let Some(path) = &input.file {
        let source = Source::File(path.clone());
        let text = std::fs::read_to_string(path).map_err(|e| ConfigError::Read {
            path: path.clone(),
            reason: e.kind().to_string(),
        })?;
        let value: Value = serde_norway::from_str(&text).map_err(|e| ConfigError::Parse {
            source: source.clone(),
            reason: yaml_reason(&e),
        })?;
        root = match value {
            Value::Null => Value::Object(Map::new()),
            v @ Value::Object(_) => v,
            _ => {
                return Err(ConfigError::Parse {
                    source,
                    reason: "the top level must be a mapping".into(),
                });
            }
        };
        record_leaves(&root, "", &source, &mut sources);
    }
    let mut vars: Vec<&(String, String)> = input
        .env
        .iter()
        .filter(|(k, _)| k.starts_with(ENV_PREFIX))
        .collect();
    vars.sort();
    for (var, value) in vars {
        let source = Source::Env(var.clone());
        let segments: Vec<String> = var[ENV_PREFIX.len()..]
            .split("__")
            .map(str::to_ascii_lowercase)
            .collect();
        if segments.iter().any(String::is_empty) {
            return Err(ConfigError::UnknownKey {
                key: segments.join("."),
                source,
            });
        }
        let parsed: Value = if value.is_empty() {
            Value::Null
        } else {
            serde_norway::from_str(value).map_err(|_| ConfigError::Parse {
                source: source.clone(),
                reason: "the value is not valid YAML".into(),
            })?
        };
        let path = set_path(&mut root, &segments, parsed.clone(), &source)?;
        forget(&mut sources, &path);
        record_leaves(&parsed, &path, &source, &mut sources);
    }
    if let Some(roles) = &input.cli_roles {
        let list = Value::Array(
            roles
                .split(',')
                .map(|r| Value::String(r.trim().to_string()))
                .collect(),
        );
        forget(&mut sources, "roles");
        record_leaves(&list, "roles", &Source::Cli, &mut sources);
        if let Value::Object(m) = &mut root {
            m.insert("roles".into(), list);
        }
    }
    let raw: RawConfig = serde_path_to_error::deserialize(root).map_err(|e| {
        let path = e.path().to_string();
        let message = e.into_inner().to_string();
        let source = source_of(&sources, &path).unwrap_or(Source::Cli);
        if message.starts_with("unknown field") {
            ConfigError::UnknownKey { key: path, source }
        } else {
            ConfigError::Invalid {
                key: path,
                source: Some(source),
                reason: redact_quoted(&message),
            }
        }
    })?;
    Ok(LoadedConfig {
        raw,
        sources,
        env: input.env.clone(),
    })
}

/// A YAML syntax error without any quoted input.
fn yaml_reason(e: &serde_norway::Error) -> String {
    let at = e
        .location()
        .map(|l| format!(" at line {} column {}", l.line(), l.column()))
        .unwrap_or_default();
    format!("invalid YAML{at}")
}

/// `serde` messages quote the offending input (`` `x` `` or `"x"`); configuration values may be
/// secrets, so quoted parts are replaced.
pub(crate) fn redact_quoted(message: &str) -> String {
    let mut out = String::new();
    let mut quote: Option<char> = None;
    for c in message.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '`' || c == '"' => {
                quote = Some(c);
                out.push_str("<value>");
            }
            None => out.push(c),
        }
    }
    out
}

fn child(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

/// Records every leaf path of `v` under `path` (an empty mapping or list counts as a leaf).
fn record_leaves(v: &Value, path: &str, source: &Source, out: &mut BTreeMap<String, Source>) {
    match v {
        Value::Object(m) if !m.is_empty() => {
            for (k, x) in m {
                record_leaves(x, &child(path, k), source, out);
            }
        }
        Value::Array(a) if !a.is_empty() => {
            for (i, x) in a.iter().enumerate() {
                record_leaves(x, &format!("{path}[{i}]"), source, out);
            }
        }
        _ if !path.is_empty() => {
            out.insert(path.to_string(), source.clone());
        }
        _ => {}
    }
}

/// Removes the recorded sources at or below `path`.
fn forget(sources: &mut BTreeMap<String, Source>, path: &str) {
    sources.retain(|k, _| !is_at_or_below(k, path));
}

fn is_at_or_below(k: &str, path: &str) -> bool {
    k == path
        || k.strip_prefix(path)
            .is_some_and(|rest| rest.starts_with('.') || rest.starts_with('['))
}

/// The source of `key`: exact, else the first recorded path below it, else the nearest ancestor.
pub(crate) fn source_of(sources: &BTreeMap<String, Source>, key: &str) -> Option<Source> {
    if let Some(s) = sources.get(key) {
        return Some(s.clone());
    }
    if let Some((_, s)) = sources.iter().find(|(k, _)| is_at_or_below(k, key)) {
        return Some(s.clone());
    }
    let mut cur = key;
    while let Some(i) = cur.rfind(['.', '[']) {
        cur = &cur[..i];
        if let Some(s) = sources.get(cur) {
            return Some(s.clone());
        }
    }
    None
}

/// Sets `segments` (lower-cased env segments; digits = list index) to `value` in `root`; returns
/// the display path (`a.b[0].c`).
fn set_path(
    root: &mut Value,
    segments: &[String],
    value: Value,
    source: &Source,
) -> Result<String, ConfigError> {
    let mut cur = root;
    let mut path = String::new();
    for seg in segments {
        if seg.bytes().all(|b| b.is_ascii_digit()) {
            let idx: usize = seg.parse().map_err(|_| ConfigError::Invalid {
                key: path.clone(),
                source: Some(source.clone()),
                reason: "list index out of range".into(),
            })?;
            path.push_str(&format!("[{idx}]"));
            if !cur.is_array() {
                *cur = Value::Array(Vec::new());
            }
            let Some(list) = cur.as_array_mut() else {
                return Err(ConfigError::Invalid {
                    key: path,
                    source: Some(source.clone()),
                    reason: "not a list".into(),
                });
            };
            if idx > list.len() {
                return Err(ConfigError::Invalid {
                    key: path,
                    source: Some(source.clone()),
                    reason: format!("list index {idx} skips entries"),
                });
            }
            if idx == list.len() {
                list.push(Value::Null);
            }
            cur = &mut list[idx];
        } else {
            path = child(&path, seg);
            if !cur.is_object() {
                *cur = Value::Object(Map::new());
            }
            let Some(map) = cur.as_object_mut() else {
                return Err(ConfigError::Invalid {
                    key: path,
                    source: Some(source.clone()),
                    reason: "not a mapping".into(),
                });
            };
            cur = map.entry(seg.clone()).or_insert(Value::Null);
        }
    }
    *cur = value;
    Ok(path)
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
