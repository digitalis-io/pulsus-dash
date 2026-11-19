//! `tenant_bindings` (T11 §4.2, T06-025). `credentials_ref` stays NULL until the secrets store.

use dash_core::{ScopeOrgId, TenantBinding};
use url::Url;

use crate::db::OrgTx;
use crate::error::StoreError;

/// A binding to insert.
#[derive(Clone, Copy, Debug)]
pub struct NewTenantBinding<'a> {
    pub slug: &'a str,
    pub datasource_url: &'a Url,
    pub database: Option<&'a str>,
    pub scope_org_id: Option<&'a ScopeOrgId>,
}

/// Inserts a `pulsusdb` binding for the transaction's org.
pub async fn insert(tx: &mut OrgTx, b: NewTenantBinding<'_>) -> Result<TenantBinding, StoreError> {
    let _ = (tx, b);
    Err(StoreError::NotMigrated)
}

/// The org's bindings, by slug.
pub async fn list(tx: &mut OrgTx) -> Result<Vec<TenantBinding>, StoreError> {
    let _ = tx;
    Err(StoreError::NotMigrated)
}

/// One binding by slug.
pub async fn get_by_slug(tx: &mut OrgTx, slug: &str) -> Result<Option<TenantBinding>, StoreError> {
    let _ = (tx, slug);
    Err(StoreError::NotMigrated)
}
