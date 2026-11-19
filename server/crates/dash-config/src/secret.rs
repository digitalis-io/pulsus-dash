//! Secret references (T19-010, T18-030): `env:NAME`, `file:PATH` or, with
//! `allow_inline_secrets`, an inline literal.

use std::path::PathBuf;

use dash_core::Secret;

use crate::error::ConfigError;

/// A reference to a secret. Resolution happens in memory only; the value is never stored or
/// logged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SecretRef {
    /// `env:NAME`.
    Env(String),
    /// `file:PATH`.
    File(PathBuf),
    /// A literal (dev only).
    Inline(Secret),
}

impl SecretRef {
    /// Classifies `raw` (plan §3.3); `key` names the setting in errors.
    pub fn parse(raw: &str, key: &str, allow_inline: bool) -> Result<SecretRef, ConfigError> {
        let _ = (raw, allow_inline);
        Err(invalid(key, "not implemented"))
    }

    /// Resolves against the process environment and file system.
    pub fn resolve(&self, key: &str) -> Result<Secret, ConfigError> {
        let env: Vec<(String, String)> = std::env::vars_os()
            .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
            .collect();
        self.resolve_in(key, &env)
    }

    /// Resolves `env:` against `env` (a snapshot of the process environment); a `file:` path
    /// has one trailing `\n` trimmed.
    pub fn resolve_in(&self, key: &str, env: &[(String, String)]) -> Result<Secret, ConfigError> {
        let _ = env;
        Err(invalid(key, "not implemented"))
    }
}

/// Resolves a Postgres reference and checks it is a `postgres://` / `postgresql://` URL.
pub fn resolve_postgres_url(
    r: &SecretRef,
    key: &str,
    env: &[(String, String)],
) -> Result<Secret, ConfigError> {
    let _ = (r, env);
    Err(invalid(key, "not implemented"))
}

fn invalid(key: &str, reason: &str) -> ConfigError {
    ConfigError::Invalid {
        key: key.to_string(),
        source: None,
        reason: reason.to_string(),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const KEY: &str = "postgres.url_ref";

    fn reason(e: &ConfigError) -> String {
        match e {
            ConfigError::Invalid { reason, .. } => reason.clone(),
            other => panic!("not Invalid: {other:?}"),
        }
    }

    #[test]
    fn secret_refs() {
        // Inline literal: refused without the flag, accepted with it.
        let refused = SecretRef::parse("postgres://u@h/d", KEY, false);
        assert!(
            matches!(&refused, Err(ConfigError::Invalid { key, .. }) if key == KEY),
            "{refused:?}"
        );
        assert!(!refused.unwrap_err().to_string().contains("u@h"));
        let inline = SecretRef::parse("postgres://u@h/d", KEY, true);
        assert_eq!(
            inline,
            Ok(SecretRef::Inline(Secret::new("postgres://u@h/d".into())))
        );
        // env:
        let env = vec![("DASH_T_X".to_string(), "v".to_string())];
        let r = SecretRef::parse("env:DASH_T_X", KEY, false);
        assert_eq!(r, Ok(SecretRef::Env("DASH_T_X".into())));
        assert_eq!(r.unwrap().resolve_in(KEY, &env).unwrap().expose(), "v");
        // file: one trailing newline trimmed.
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("s.txt");
        std::fs::write(&f, "s\n").unwrap();
        let r = SecretRef::parse(&format!("file:{}", f.display()), KEY, false);
        assert_eq!(r, Ok(SecretRef::File(f.clone())));
        assert_eq!(r.unwrap().resolve_in(KEY, &env).unwrap().expose(), "s");
        // Unsupported stores.
        for raw in ["vault://a", "aws-sm://x"] {
            let e = SecretRef::parse(raw, KEY, true);
            assert!(e.is_err(), "{raw}: {e:?}");
            assert!(
                reason(&e.unwrap_err()).contains("is not supported in this release"),
                "{raw}"
            );
        }
        // A non-Postgres URL behind a Postgres reference.
        let env = vec![("DASH_T_Y".to_string(), "mysql://h/d".to_string())];
        let r = SecretRef::parse("env:DASH_T_Y", KEY, false);
        assert_eq!(r, Ok(SecretRef::Env("DASH_T_Y".into())));
        let e = resolve_postgres_url(&r.unwrap(), KEY, &env).unwrap_err();
        assert_eq!(reason(&e), "must be a postgres:// URL");
        assert!(!e.to_string().contains("mysql"));
        // Debug never prints the value.
        assert_eq!(format!("{:?}", Secret::new("x".into())), "***");
        let dbg = format!("{:?}", SecretRef::Inline(Secret::new("pw".into())));
        assert!(dbg.contains("***") && !dbg.contains("pw"), "{dbg}");
    }
}
