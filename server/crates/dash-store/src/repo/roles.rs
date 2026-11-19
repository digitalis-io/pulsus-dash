//! `roles` (T11 §4.2).

use dash_core::RoleId;

use crate::db::OrgTx;
use crate::error::StoreError;

/// A role row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoleRow {
    pub id: RoleId,
    pub name: String,
    pub builtin: bool,
}

/// The org's roles, by name.
pub async fn list(tx: &mut OrgTx) -> Result<Vec<RoleRow>, StoreError> {
    let _ = tx;
    Err(StoreError::NotMigrated)
}
