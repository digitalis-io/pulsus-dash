//! `pulsus-dash`: serve (`--role all`) and `migrate` (T06-003, T19). See
//! `docs/server/architecture.md`.

mod cli;
mod selfcheck;
mod startup;

use std::process::ExitCode;
use std::time::Duration;

use clap::Parser;
use dash_config::{
    ConfigError, ConfigInput, LoadedConfig, LogConfig, LogFormat, resolve_postgres_url,
};
use dash_gateway::GatewayConfig;
use dash_store::{Db, StoreError, StoreHealth};
use tokio::sync::{mpsc, oneshot};
use tracing_subscriber::EnvFilter;

use crate::cli::{Cli, Command};

/// Exit code: usage or configuration error.
const EXIT_CONFIG: u8 = 2;
/// Graceful shutdown cap after SIGINT/SIGTERM.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(30);

fn config_error(e: &ConfigError) -> ExitCode {
    eprintln!("pulsus-dash: configuration error: {e}");
    ExitCode::from(EXIT_CONFIG)
}

/// The process environment as UTF-8 pairs (others cannot be configuration).
fn environment() -> Vec<(String, String)> {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect()
}

/// Logs go to stderr; an unparseable filter is a configuration error for `log.filter`.
fn init_tracing(log: &LogConfig) -> Result<(), ConfigError> {
    let filter = EnvFilter::try_new(&log.filter).map_err(|_| ConfigError::Invalid {
        key: "log.filter".into(),
        source: None,
        reason: "not a valid log filter".into(),
    })?;
    let builder = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_writer(std::io::stderr);
    let result = match log.format {
        LogFormat::Text => builder.with_ansi(false).try_init(),
        LogFormat::Json => builder.json().try_init(),
    };
    // A second initialisation cannot happen: main initialises once.
    let _ = result;
    Ok(())
}

fn runtime() -> Result<tokio::runtime::Runtime, ExitCode> {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| {
            eprintln!("pulsus-dash: cannot start the runtime: {}", e.kind());
            ExitCode::from(startup::EXIT_FATAL)
        })
}

fn main() -> ExitCode {
    let cli = match Cli::try_parse() {
        Ok(c) => c,
        Err(e) => {
            let code = e.exit_code();
            let _ = e.print();
            return ExitCode::from(u8::try_from(code).unwrap_or(EXIT_CONFIG));
        }
    };
    let env = environment();
    match cli.command {
        Some(Command::Migrate { config }) => migrate(config, env),
        None => serve(cli.config, cli.role, env),
    }
}

fn load(
    file: Option<std::path::PathBuf>,
    env: &[(String, String)],
    roles: Option<String>,
) -> Result<LoadedConfig, ConfigError> {
    dash_config::load(&ConfigInput {
        file,
        env: env.to_vec(),
        cli_roles: roles,
    })
}

fn migrate(file: Option<std::path::PathBuf>, env: Vec<(String, String)>) -> ExitCode {
    let setup = || -> Result<_, ConfigError> {
        let loaded = load(file, &env, None)?;
        let cfg = loaded.for_migrate()?;
        let url = resolve_postgres_url(&cfg.owner.url, "postgres.owner_url_ref", &env)?;
        init_tracing(&cfg.log)?;
        Ok(url)
    };
    let url = match setup() {
        Ok(u) => u,
        Err(e) => return config_error(&e),
    };
    let rt = match runtime() {
        Ok(rt) => rt,
        Err(code) => return code,
    };
    match rt.block_on(dash_store::migrate::run(&url)) {
        Ok(report) => {
            tracing::info!(applied = ?report.applied, schema_level = report.level, "migrate done");
            ExitCode::SUCCESS
        }
        Err(e @ StoreError::SchemaTooNew { .. }) => {
            tracing::error!("{e}");
            ExitCode::from(startup::EXIT_SCHEMA)
        }
        Err(e) => {
            tracing::error!(
                kind = e.kind(),
                sqlstate = e.sqlstate().as_deref().unwrap_or(""),
                "migrate failed"
            );
            ExitCode::from(startup::EXIT_FATAL)
        }
    }
}

fn serve(
    file: Option<std::path::PathBuf>,
    roles: Option<String>,
    env: Vec<(String, String)>,
) -> ExitCode {
    let setup = || -> Result<_, ConfigError> {
        let loaded = load(file, &env, roles)?;
        let cfg = loaded.for_serve()?;
        let url = resolve_postgres_url(&cfg.postgres.url, "postgres.url_ref", &env)?;
        init_tracing(&cfg.log)?;
        Ok((cfg, url))
    };
    let (cfg, url) = match setup() {
        Ok(x) => x,
        Err(e) => return config_error(&e),
    };
    let rt = match runtime() {
        Ok(rt) => rt,
        Err(code) => return code,
    };
    // The lazy pool needs the runtime context; nothing connects yet.
    let db = {
        let _enter = rt.enter();
        Db::connect_lazy(&url, cfg.postgres.pool_max, cfg.postgres.connect_timeout)
    };
    let Ok(db) = db else {
        return config_error(&ConfigError::Invalid {
            key: "postgres.url_ref".into(),
            source: None,
            reason: "not a valid Postgres connection URL".into(),
        });
    };
    ExitCode::from(rt.block_on(serve_async(cfg, db)))
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = term.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn serve_async(cfg: dash_config::ServeConfig, db: Db) -> u8 {
    let listener = match tokio::net::TcpListener::bind(&cfg.listen).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(kind = %e.kind(), "cannot bind the listen address");
            return startup::EXIT_FATAL;
        }
    };
    match listener.local_addr() {
        Ok(addr) => tracing::info!("pulsus-dash listening on http://{addr}"),
        Err(e) => tracing::warn!(kind = %e.kind(), "listening (address unknown)"),
    }
    let health = StoreHealth::new(db.clone());
    let router = dash_gateway::router(
        &GatewayConfig {
            assets_dir: cfg.assets_dir.clone(),
            public_url: cfg.public_url.clone(),
        },
        health.clone(),
    );
    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    let mut server = tokio::spawn(dash_gateway::serve(listener, router, async {
        let _ = stop_rx.await;
    }));
    if let Some(url) = cfg.public_url.clone() {
        tokio::spawn(selfcheck::run_and_log(url));
    }
    let (fatal_tx, mut fatal_rx) = mpsc::channel::<u8>(1);
    let startup = tokio::spawn(startup::run(db, health, cfg.bootstrap.clone(), fatal_tx));
    let code = tokio::select! {
        r = &mut server => {
            match r {
                Ok(Ok(())) => 0,
                Ok(Err(e)) => {
                    tracing::error!(kind = %e.kind(), "server failed");
                    startup::EXIT_FATAL
                }
                Err(_) => startup::EXIT_FATAL,
            }
        }
        () = shutdown_signal() => {
            tracing::info!("shutting down");
            let _ = stop_tx.send(());
            if tokio::time::timeout(SHUTDOWN_GRACE, &mut server).await.is_err() {
                tracing::warn!("graceful shutdown timed out");
            }
            0
        }
        Some(code) = fatal_rx.recv() => {
            let _ = stop_tx.send(());
            let _ = tokio::time::timeout(Duration::from_secs(5), &mut server).await;
            code
        }
    };
    startup.abort();
    code
}
