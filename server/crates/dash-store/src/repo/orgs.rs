//! `orgs` (T11 §4.2).

use dash_core::OrgId;
use time::OffsetDateTime;

use crate::db::OrgTx;
use crate::error::StoreError;

/// An organisation row.
#[derive(Clone, Debug)]
pub struct Org {
    pub id: OrgId,
    pub slug: String,
    pub name: String,
    pub created_at: OffsetDateTime,
}

/// Creates the transaction's org and its four built-in roles (`builtin = true`).
pub async fn create(tx: &mut OrgTx, slug: &str, name: &str) -> Result<Org, StoreError> {
    let _ = (tx, slug, name);
    Err(StoreError::NotMigrated)
}

/// The transaction's org, unless deleted.
pub async fn get(tx: &mut OrgTx) -> Result<Option<Org>, StoreError> {
    let _ = tx;
    Err(StoreError::NotMigrated)
}
