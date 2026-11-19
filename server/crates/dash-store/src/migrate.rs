//! `pulsus-dash migrate` (T11-015, plan §4.3): advisory-locked, expand-only, N+1 window.

use dash_core::Secret;

use crate::error::StoreError;

/// What a run applied.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MigrateReport {
    /// Versions applied by this run, ascending.
    pub applied: Vec<i64>,
    /// `pulsus_schema_level.level` afterwards.
    pub level: i64,
}

/// Runs the embedded migrations as the owner role.
pub async fn run(owner_url: &Secret) -> Result<MigrateReport, StoreError> {
    let _ = owner_url;
    Err(StoreError::NotMigrated)
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
