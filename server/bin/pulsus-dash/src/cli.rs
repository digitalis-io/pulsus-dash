//! Command line (plan §3.9).

use std::path::PathBuf;

use clap::{Parser, Subcommand};

/// `pulsus-dash [--config PATH] [--role ROLES]` serves; `pulsus-dash migrate [--config PATH]`
/// migrates. Exit codes: 0 done, 1 fatal runtime error, 2 usage or configuration, 3 schema
/// incompatible.
#[derive(Debug, Parser)]
#[command(name = "pulsus-dash", version, about = "Pulsus Dash server")]
pub struct Cli {
    /// YAML configuration file (environment variables PULSUS_DASH_* override it).
    #[arg(long, value_name = "PATH")]
    pub config: Option<PathBuf>,
    /// Comma-separated process roles; only `all` is implemented in this build (T06-003).
    #[arg(long, value_name = "ROLES")]
    pub role: Option<String>,
    #[command(subcommand)]
    pub command: Option<Command>,
}

#[derive(Debug, Subcommand)]
pub enum Command {
    /// Apply the embedded Postgres migrations as the owner role, then exit (T11-015).
    Migrate {
        /// YAML configuration file.
        #[arg(long, value_name = "PATH")]
        config: Option<PathBuf>,
    },
}
