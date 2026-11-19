//! `orgs` (T11 §4.2).

use dash_core::{BuiltinRole, OrgId, RoleId};
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
    let id = tx.org();
    let created_at = sqlx::query_scalar!(
        "INSERT INTO orgs (id, slug, name) VALUES ($1, $2, $3) RETURNING created_at",
        id.0,
        slug,
        name
    )
    .fetch_one(tx.conn())
    .await
    .map_err(StoreError::from_sqlx)?;
    for role in BuiltinRole::ALL {
        sqlx::query!(
            "INSERT INTO roles (org_id, id, name, builtin) VALUES ($1, $2, $3, true)",
            id.0,
            RoleId::new_v7().0,
            role.as_str()
        )
        .execute(tx.conn())
        .await
        .map_err(StoreError::from_sqlx)?;
    }
    Ok(Org {
        id,
        slug: slug.to_string(),
        name: name.to_string(),
        created_at,
    })
}

/// The transaction's org, unless deleted.
pub async fn get(tx: &mut OrgTx) -> Result<Option<Org>, StoreError> {
    let org = tx.org();
    let row = sqlx::query!(
        "SELECT id, slug, name, created_at FROM orgs WHERE id = $1 AND deleted_at IS NULL",
        org.0
    )
    .fetch_optional(tx.conn())
    .await
    .map_err(StoreError::from_sqlx)?;
    Ok(row.map(|r| Org {
        id: OrgId(r.id),
        slug: r.slug,
        name: r.name,
        created_at: r.created_at,
    }))
}
