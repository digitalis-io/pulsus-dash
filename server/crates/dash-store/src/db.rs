//! The pool and the one transaction path (T11-003, plan §4.3).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;

use dash_core::{HealthProbe, OrgId, Readiness, ReadyCheck, Secret};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{PgConnection, PgPool, Postgres};

use crate::SCHEMA_LEVEL;
use crate::error::StoreError;

/// The application pool (`pulsus_app`). Cloning shares the pool. `Debug` prints pool counters
/// only, never connection settings.
#[derive(Clone)]
pub struct Db {
    pool: PgPool,
}

impl std::fmt::Debug for Db {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Db")
            .field("size", &self.pool.size())
            .field("idle", &self.pool.num_idle())
            .finish()
    }
}

/// Schema compatibility of the connected database (T11-015, T19-007).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SchemaStatus {
    Compatible { level: i64 },
    TooOld { level: i64 },
    TooNew { level: i64 },
}

/// A transaction scoped to one org. Dropping it rolls back.
#[derive(Debug)]
pub struct OrgTx {
    inner: sqlx::Transaction<'static, Postgres>,
    org: OrgId,
}

impl Db {
    /// A lazily connecting pool: `acquire_timeout = connect_timeout`, application name
    /// `pulsus-dash`.
    pub fn connect_lazy(
        url: &Secret,
        pool_max: u32,
        connect_timeout: Duration,
    ) -> Result<Db, StoreError> {
        let opts: PgConnectOptions = url.expose().parse().map_err(StoreError::Other)?;
        let pool = PgPoolOptions::new()
            .max_connections(pool_max)
            .acquire_timeout(connect_timeout)
            .connect_lazy_with(opts.application_name("pulsus-dash"));
        Ok(Db { pool })
    }

    /// `BEGIN; SELECT set_config('pulsus.org_id', $1, true)`.
    pub async fn tx(&self, org: OrgId) -> Result<OrgTx, StoreError> {
        let mut inner = self.pool.begin().await.map_err(StoreError::from_sqlx)?;
        // One statement sets the org (and, once retention-managed tables exist, the floors:
        // T11-003, plan §3.6).
        sqlx::query!(
            r#"SELECT set_config('pulsus.org_id', $1, true) AS "org!""#,
            org.0.to_string()
        )
        .fetch_one(&mut *inner)
        .await
        .map_err(StoreError::from_sqlx)?;
        Ok(OrgTx { inner, org })
    }

    /// Reads `pulsus_schema_level` and `_sqlx_migrations` (plan §4.3): missing relation →
    /// `NotMigrated`; the newest embedded migration not applied, or a level below
    /// [`SCHEMA_LEVEL`] → `TooOld`; a level beyond the N+1 window → `TooNew`.
    pub async fn schema_status(&self) -> Result<SchemaStatus, StoreError> {
        let row = sqlx::query!(
            r#"SELECT (SELECT level FROM pulsus_schema_level) AS "level?",
                      EXISTS (SELECT 1 FROM _sqlx_migrations WHERE version = $1 AND success) AS "applied!""#,
            crate::migrate::latest_version()
        )
        .fetch_one(&self.pool)
        .await
        .map_err(StoreError::from_sqlx)?;
        let level = row.level.unwrap_or(0);
        Ok(if !row.applied || level < SCHEMA_LEVEL {
            SchemaStatus::TooOld { level }
        } else if level > SCHEMA_LEVEL + 1 {
            SchemaStatus::TooNew { level }
        } else {
            SchemaStatus::Compatible { level }
        })
    }
}

impl OrgTx {
    pub fn org(&self) -> OrgId {
        self.org
    }

    pub async fn commit(self) -> Result<(), StoreError> {
        self.inner.commit().await.map_err(StoreError::from_sqlx)
    }

    pub async fn rollback(self) -> Result<(), StoreError> {
        self.inner.rollback().await.map_err(StoreError::from_sqlx)
    }

    pub(crate) fn conn(&mut self) -> &mut PgConnection {
        &mut self.inner
    }
}

// ---- StoreHealth (plan §4.3; T19-006, T06-026) ----

/// Bound of one readiness check.
pub const READINESS_TIMEOUT: Duration = Duration::from_secs(1);

/// Start-up flag plus a bounded Postgres readiness check. Never consults PulsusDB.
#[derive(Debug)]
pub struct StoreHealth {
    db: Db,
    started: AtomicBool,
}

impl StoreHealth {
    pub fn new(db: Db) -> Arc<Self> {
        Arc::new(Self {
            db,
            started: AtomicBool::new(false),
        })
    }

    /// Start-up completed (schema compatible, bootstrap seeded).
    pub fn mark_started(&self) {
        self.started.store(true, Ordering::Release);
    }
}

#[async_trait]
impl HealthProbe for StoreHealth {
    fn started(&self) -> bool {
        self.started.load(Ordering::Acquire)
    }

    /// Not started → `Startup`; else `schema_status` bounded by [`READINESS_TIMEOUT`].
    async fn readiness(&self) -> Readiness {
        if !self.started() {
            return Readiness::NotReady {
                check: ReadyCheck::Startup,
                message: "starting".into(),
            };
        }
        let schema = |message: String| Readiness::NotReady {
            check: ReadyCheck::Schema,
            message,
        };
        match tokio::time::timeout(READINESS_TIMEOUT, self.db.schema_status()).await {
            Ok(Ok(SchemaStatus::Compatible { level })) => Readiness::Ready {
                schema_level: level,
            },
            Ok(Ok(SchemaStatus::TooOld { level })) => schema(format!(
                "schema level {level} is older than this binary requires (level {SCHEMA_LEVEL})"
            )),
            Ok(Ok(SchemaStatus::TooNew { level })) => schema(format!(
                "schema level {level} is ahead of this binary (level {SCHEMA_LEVEL})"
            )),
            Ok(Err(e @ (StoreError::NotMigrated | StoreError::SchemaTooNew { .. }))) => {
                schema(e.to_string())
            }
            Ok(Err(_)) | Err(_) => Readiness::NotReady {
                check: ReadyCheck::Postgres,
                message: "postgres unreachable".into(),
            },
        }
    }
}
