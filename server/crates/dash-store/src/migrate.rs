//! `pulsus-dash migrate` (T11-015, plan §4.3): advisory-locked, expand-only, N+1 window.

use std::time::Duration;

use dash_core::Secret;
use sqlx::migrate::{MigrateError, Migrator};
use sqlx::postgres::PgConnectOptions;
use sqlx::{Connection, PgConnection};

use crate::error::StoreError;
use crate::{MIGRATION_LOCK_KEY, SCHEMA_LEVEL};

/// The embedded migrations (`server/crates/dash-store/migrations`).
fn migrator() -> Migrator {
    sqlx::migrate!("./migrations")
}

/// Bound of the owner connection attempt.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The newest embedded migration version.
pub fn latest_version() -> i64 {
    migrator().iter().map(|m| m.version).max().unwrap_or(0)
}

/// What a run applied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MigrateReport {
    /// Versions applied by this run, ascending.
    pub applied: Vec<i64>,
    /// `pulsus_schema_level.level` afterwards.
    pub level: i64,
}

/// Runs the embedded migrations as the owner role.
///
/// Own owner connection; `lock_timeout = 5s`; `pg_advisory_lock(MIGRATION_LOCK_KEY)`; refuses a
/// database more than one level ahead (T11-015); applies missing migrations, ignoring applied
/// versions this binary does not know (N+1 window).
pub async fn run(owner_url: &Secret) -> Result<MigrateReport, StoreError> {
    let opts: PgConnectOptions = owner_url.expose().parse().map_err(StoreError::Other)?;
    let opts = opts.application_name("pulsus-dash-migrate");
    let mut conn =
        match tokio::time::timeout(CONNECT_TIMEOUT, PgConnection::connect_with(&opts)).await {
            Ok(Ok(c)) => c,
            Ok(Err(e)) => return Err(StoreError::Unavailable(e)),
            Err(_) => return Err(StoreError::Unavailable(sqlx::Error::PoolTimedOut)),
        };
    sqlx::query!(r#"SELECT set_config('lock_timeout', '5s', false) AS "v!""#)
        .fetch_one(&mut conn)
        .await
        .map_err(StoreError::from_sqlx)?;
    sqlx::query!(
        r#"SELECT pg_advisory_lock($1)::text AS "locked""#,
        MIGRATION_LOCK_KEY
    )
    .fetch_one(&mut conn)
    .await
    .map_err(StoreError::from_sqlx)?;
    let result = locked(&mut conn).await;
    let unlock = sqlx::query!(
        r#"SELECT pg_advisory_unlock($1) AS "unlocked!""#,
        MIGRATION_LOCK_KEY
    )
    .fetch_one(&mut conn)
    .await;
    let report = result?;
    unlock.map_err(StoreError::from_sqlx)?;
    tracing::info!(applied = ?report.applied, level = report.level, "migrations complete");
    Ok(report)
}

/// The work done under the migration lock.
async fn locked(conn: &mut PgConnection) -> Result<MigrateReport, StoreError> {
    let exists = sqlx::query!(
        r#"SELECT to_regclass('public.pulsus_schema_level') IS NOT NULL AS "exists!""#
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(StoreError::from_sqlx)?
    .exists;
    if exists {
        // Any failure here (wrong shape, decode error) stops before anything is applied.
        let level = sqlx::query_scalar!("SELECT level FROM pulsus_schema_level")
            .fetch_one(&mut *conn)
            .await
            .map_err(StoreError::Other)?;
        if level > SCHEMA_LEVEL + 1 {
            return Err(StoreError::SchemaTooNew {
                db: level,
                max: SCHEMA_LEVEL,
            });
        }
    }
    let before = applied_versions(conn).await?;
    let mut migrator = migrator();
    migrator.set_locking(false).set_ignore_missing(true);
    migrator.run(&mut *conn).await.map_err(|e| match e {
        MigrateError::Execute(e) | MigrateError::ExecuteMigration(e, _) => StoreError::from_sqlx(e),
        other => StoreError::Other(sqlx::Error::Migrate(Box::new(other))),
    })?;
    let after = applied_versions(conn).await?;
    let level = sqlx::query_scalar!("SELECT level FROM pulsus_schema_level")
        .fetch_one(&mut *conn)
        .await
        .map_err(StoreError::from_sqlx)?;
    let mut applied: Vec<i64> = after.into_iter().filter(|v| !before.contains(v)).collect();
    applied.sort_unstable();
    Ok(MigrateReport { applied, level })
}

/// Successfully applied versions (none before the first run).
async fn applied_versions(conn: &mut PgConnection) -> Result<Vec<i64>, StoreError> {
    let exists =
        sqlx::query!(r#"SELECT to_regclass('public._sqlx_migrations') IS NOT NULL AS "exists!""#)
            .fetch_one(&mut *conn)
            .await
            .map_err(StoreError::from_sqlx)?
            .exists;
    if !exists {
        return Ok(Vec::new());
    }
    sqlx::query_scalar!("SELECT version FROM _sqlx_migrations WHERE success ORDER BY version")
        .fetch_all(&mut *conn)
        .await
        .map_err(StoreError::from_sqlx)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn migrate_unreachable() {
        let url = Secret::new("postgres://pulsus_owner@localhost:1/x".into());
        let r = tokio::time::timeout(Duration::from_secs(5), run(&url)).await;
        assert!(matches!(r, Ok(Err(StoreError::Unavailable(_)))), "{r:?}");
    }
}
