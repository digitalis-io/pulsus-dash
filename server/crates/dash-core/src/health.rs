//! Start-up and readiness probes (T19-006, T06-026).

use async_trait::async_trait;

/// The check that made the server not ready.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadyCheck {
    Startup,
    Postgres,
    Schema,
}

impl ReadyCheck {
    pub fn as_str(self) -> &'static str {
        match self {
            ReadyCheck::Startup => "startup",
            ReadyCheck::Postgres => "postgres",
            ReadyCheck::Schema => "schema",
        }
    }
}

/// Outcome of a readiness check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Readiness {
    Ready { schema_level: i64 },
    NotReady { check: ReadyCheck, message: String },
}

/// Health state the gateway reports on `/startupz` and `/readyz`. Never depends on PulsusDB
/// (T06-026).
#[async_trait]
pub trait HealthProbe: Send + Sync {
    /// Start-up (migrations checked, bootstrap seeded) has completed.
    fn started(&self) -> bool;
    /// Bounded readiness check (Postgres reachable, schema compatible).
    async fn readiness(&self) -> Readiness;
}
