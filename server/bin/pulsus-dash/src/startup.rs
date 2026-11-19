//! The start-up task (plan §4.1): wait for Postgres, check the schema window, seed the default
//! org once, then mark the server started.

use std::sync::Arc;
use std::time::Duration;

use dash_config::DatasourceSeed;
use dash_store::bootstrap::{self, DatasourceSeedRef, SeedOutcome};
use dash_store::{Db, SCHEMA_LEVEL, SchemaStatus, StoreError, StoreHealth};
use tokio::sync::mpsc;

/// Pause between retries while Postgres is unavailable.
pub const RETRY: Duration = Duration::from_secs(2);

/// Exit code: fatal runtime error.
pub const EXIT_FATAL: u8 = 1;
/// Exit code: the schema is outside this binary's window.
pub const EXIT_SCHEMA: u8 = 3;

fn log_store_error(what: &str, e: &StoreError) {
    tracing::error!(
        kind = e.kind(),
        sqlstate = e.sqlstate().as_deref().unwrap_or(""),
        "{what}"
    );
}

/// Runs until started or a fatal condition; fatal exit codes go to `fatal`.
pub async fn run(db: Db, health: Arc<StoreHealth>, seed: DatasourceSeed, fatal: mpsc::Sender<u8>) {
    let code = match start(&db, &health, &seed).await {
        Ok(()) => return,
        Err(code) => code,
    };
    // The receiver lives as long as main; a closed channel means shutdown is under way.
    let _ = fatal.send(code).await;
}

async fn start(db: &Db, health: &StoreHealth, seed: &DatasourceSeed) -> Result<(), u8> {
    loop {
        match db.schema_status().await {
            Ok(SchemaStatus::Compatible { level }) => {
                tracing::info!(schema_level = level, "schema compatible");
                break;
            }
            Ok(SchemaStatus::TooOld { level }) => {
                tracing::error!(
                    schema_level = level,
                    required = SCHEMA_LEVEL,
                    "schema level {level} is older than this binary requires (level {SCHEMA_LEVEL}); run `pulsus-dash migrate`"
                );
                return Err(EXIT_SCHEMA);
            }
            Ok(SchemaStatus::TooNew { level }) => {
                tracing::error!(
                    schema_level = level,
                    max = SCHEMA_LEVEL + 1,
                    "schema level {level} is ahead of this binary (level {SCHEMA_LEVEL}); refusing to serve (T11-015)"
                );
                return Err(EXIT_SCHEMA);
            }
            Err(StoreError::NotMigrated) => {
                tracing::error!("schema not migrated; run `pulsus-dash migrate` first");
                return Err(EXIT_SCHEMA);
            }
            Err(e @ StoreError::Unavailable(_)) => {
                tracing::warn!(kind = e.kind(), "waiting for postgres");
                tokio::time::sleep(RETRY).await;
            }
            Err(e) => {
                log_store_error("cannot read the schema level", &e);
                return Err(EXIT_FATAL);
            }
        }
    }
    let seed_ref = DatasourceSeedRef {
        org_slug: &seed.org_slug,
        slug: &seed.slug,
        url: &seed.url,
        database: seed.database.as_deref(),
        scope_org_id: seed.scope_org_id.as_ref(),
    };
    loop {
        match bootstrap::seed(db, &seed_ref).await {
            Ok(SeedOutcome::Created { org }) => {
                tracing::info!(%org, org_slug = %seed.org_slug, "seeded the default org and its datasource binding");
                break;
            }
            Ok(SeedOutcome::AlreadySeeded {
                org,
                binding_differs,
            }) => {
                if binding_differs {
                    tracing::warn!(
                        %org,
                        "datasources_bootstrap[0] differs from the stored binding; Postgres owns the binding after the first run and the configured value is not applied (T06 §4.9)"
                    );
                }
                break;
            }
            Err(e @ StoreError::Unavailable(_)) => {
                tracing::warn!(kind = e.kind(), "waiting for postgres");
                tokio::time::sleep(RETRY).await;
            }
            Err(e) => {
                log_store_error("seeding failed", &e);
                return Err(EXIT_FATAL);
            }
        }
    }
    health.mark_started();
    tracing::info!("start-up complete");
    Ok(())
}
