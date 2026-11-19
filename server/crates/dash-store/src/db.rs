//! The pool and the one transaction path (T11-003, plan §4.3).

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use async_trait::async_trait;

use dash_core::{HealthProbe, OrgId, Readiness, ReadyCheck, Secret};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{PgConnection, PgPool, Postgres};

use crate::error::StoreError;

/// The application pool (`pulsus_app`). Cloning shares the pool.
#[derive(Clone, Debug)]
pub struct Db {
    pool: PgPool,
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
        let _ = org;
        Err(StoreError::NotMigrated)
    }

    /// Reads `pulsus_schema_level` and `_sqlx_migrations` (plan §4.3).
    pub async fn schema_status(&self) -> Result<SchemaStatus, StoreError> {
        Err(StoreError::NotMigrated)
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

    async fn readiness(&self) -> Readiness {
        let _ = &self.db;
        Readiness::NotReady {
            check: ReadyCheck::Startup,
            message: "starting".into(),
        }
    }
}
