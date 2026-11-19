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
    let org = tx.org();
    let rows = sqlx::query!(
        r#"SELECT id, name AS "name!", builtin FROM roles WHERE org_id = $1 ORDER BY name"#,
        org.0
    )
    .fetch_all(tx.conn())
    .await
    .map_err(StoreError::from_sqlx)?;
    Ok(rows
        .into_iter()
        .map(|r| RoleRow {
            id: RoleId(r.id),
            name: r.name,
            builtin: r.builtin,
        })
        .collect())
}
