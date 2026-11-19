//! Configuration errors (plan §3.3). No variant ever carries a secret value, a Postgres URL, the
//! PulsusDB base URL or a configured URL path.

use std::fmt;
use std::path::PathBuf;

/// Where a setting came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    /// The `--config` file.
    File(PathBuf),
    /// A `PULSUS_DASH_*` environment variable (its name).
    Env(String),
    /// A command-line flag.
    Cli,
}

impl fmt::Display for Source {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Source::File(p) => write!(f, "in {}", p.display()),
            Source::Env(v) => write!(f, "from environment variable {v}"),
            Source::Cli => f.write_str("from the command line"),
        }
    }
}

/// A configuration error; the binary prints it and exits 2.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConfigError {
    Read {
        path: PathBuf,
        reason: String,
    },
    Parse {
        source: Source,
        reason: String,
    },
    UnknownKey {
        key: String,
        source: Source,
    },
    Missing {
        key: String,
        hint: String,
    },
    Invalid {
        key: String,
        source: Option<Source>,
        reason: String,
    },
    RoleNotImplemented {
        role: String,
    },
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfigError::Read { path, reason } => {
                write!(
                    f,
                    "cannot read configuration file {}: {reason}",
                    path.display()
                )
            }
            ConfigError::Parse { source, reason } => {
                write!(f, "cannot parse configuration ({source}): {reason}")
            }
            ConfigError::UnknownKey { key, source } => {
                write!(f, "unknown configuration key `{key}` ({source})")
            }
            ConfigError::Missing { key, hint } => {
                write!(f, "missing required setting `{key}`: {hint}")
            }
            ConfigError::Invalid {
                key,
                source: Some(s),
                reason,
            } => write!(f, "invalid value for `{key}` ({s}): {reason}"),
            ConfigError::Invalid {
                key,
                source: None,
                reason,
            } => write!(f, "invalid value for `{key}`: {reason}"),
            ConfigError::RoleNotImplemented { role } => write!(
                f,
                "role `{role}` is not implemented in this build; only `all` is supported (T06-003)"
            ),
        }
    }
}

impl std::error::Error for ConfigError {}
