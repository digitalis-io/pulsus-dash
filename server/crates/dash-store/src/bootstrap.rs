//! First-run seeding of the default org and its binding (T06 §4.9, plan §4.3).

use dash_core::{OrgId, ScopeOrgId};
use url::Url;

use crate::db::Db;
use crate::error::StoreError;

/// What [`seed`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeedOutcome {
    Created {
        org: OrgId,
    },
    /// The org exists; Postgres owns the binding now. `binding_differs` = the configured seed no
    /// longer matches the stored binding (warned, never applied).
    AlreadySeeded {
        org: OrgId,
        binding_differs: bool,
    },
}

/// `datasources_bootstrap[0]` without credentials.
#[derive(Clone, Copy, Debug)]
pub struct DatasourceSeedRef<'a> {
    pub org_slug: &'a str,
    pub slug: &'a str,
    pub url: &'a Url,
    pub database: Option<&'a str>,
    pub scope_org_id: Option<&'a ScopeOrgId>,
}

/// Seeds once under `pg_advisory_xact_lock(BOOTSTRAP_LOCK_KEY)`.
pub async fn seed(db: &Db, seed: &DatasourceSeedRef<'_>) -> Result<SeedOutcome, StoreError> {
    let _ = (db, seed);
    Err(StoreError::NotMigrated)
}
