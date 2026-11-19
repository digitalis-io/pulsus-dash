//! `tenant_bindings` (T11 §4.2, T06-025). `credentials_ref` stays NULL until the secrets store.

use dash_core::{ScopeOrgId, TenantBinding, TenantBindingId};
use url::Url;
use uuid::Uuid;

use crate::db::OrgTx;
use crate::error::StoreError;

/// A binding to insert. `Debug` redacts the URL.
#[derive(Clone, Copy)]
pub struct NewTenantBinding<'a> {
    pub slug: &'a str,
    pub datasource_url: &'a Url,
    pub database: Option<&'a str>,
    pub scope_org_id: Option<&'a ScopeOrgId>,
}

impl std::fmt::Debug for NewTenantBinding<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NewTenantBinding")
            .field("slug", &self.slug)
            .field("datasource_url", &dash_core::REDACTED)
            .field("database", &self.database)
            .field("scope_org_id", &self.scope_org_id)
            .finish()
    }
}

/// Inserts a `pulsusdb` binding for the transaction's org.
pub async fn insert(tx: &mut OrgTx, b: NewTenantBinding<'_>) -> Result<TenantBinding, StoreError> {
    let org = tx.org();
    let id = TenantBindingId::new_v7();
    sqlx::query!(
        "INSERT INTO tenant_bindings (org_id, id, slug, datasource_url, database, scope_org_id, kind)
         VALUES ($1, $2, $3, $4, $5, $6, 'pulsusdb')",
        org.0,
        id.0,
        b.slug,
        b.datasource_url.as_str(),
        b.database,
        b.scope_org_id.map(ScopeOrgId::as_str)
    )
    .execute(tx.conn())
    .await
    .map_err(StoreError::from_sqlx)?;
    Ok(TenantBinding {
        id,
        slug: b.slug.to_string(),
        datasource_url: b.datasource_url.clone(),
        database: b.database.map(str::to_string),
        scope_org_id: b.scope_org_id.cloned(),
    })
}

/// The org's bindings, by slug.
pub async fn list(tx: &mut OrgTx) -> Result<Vec<TenantBinding>, StoreError> {
    let org = tx.org();
    let rows = sqlx::query!(
        "SELECT id, slug, datasource_url, database, scope_org_id FROM tenant_bindings
          WHERE org_id = $1 ORDER BY slug",
        org.0
    )
    .fetch_all(tx.conn())
    .await
    .map_err(StoreError::from_sqlx)?;
    rows.into_iter()
        .map(|r| binding(r.id, r.slug, &r.datasource_url, r.database, r.scope_org_id))
        .collect()
}

/// One binding by slug.
pub async fn get_by_slug(tx: &mut OrgTx, slug: &str) -> Result<Option<TenantBinding>, StoreError> {
    let org = tx.org();
    let row = sqlx::query!(
        "SELECT id, slug, datasource_url, database, scope_org_id FROM tenant_bindings
          WHERE org_id = $1 AND slug = $2",
        org.0,
        slug
    )
    .fetch_optional(tx.conn())
    .await
    .map_err(StoreError::from_sqlx)?;
    row.map(|r| binding(r.id, r.slug, &r.datasource_url, r.database, r.scope_org_id))
        .transpose()
}

/// A stored row; a URL or scope that no longer parses is a decode error (never echoed).
fn binding(
    id: Uuid,
    slug: String,
    url: &str,
    database: Option<String>,
    scope: Option<String>,
) -> Result<TenantBinding, StoreError> {
    let decode = |what: &str| StoreError::Other(sqlx::Error::Decode(what.to_string().into()));
    let datasource_url =
        Url::parse(url).map_err(|_| decode("tenant_bindings.datasource_url is not a URL"))?;
    let scope_org_id = ScopeOrgId::parse(scope.as_deref().unwrap_or(""))
        .map_err(|_| decode("tenant_bindings.scope_org_id is invalid"))?;
    Ok(TenantBinding {
        id: TenantBindingId(id),
        slug,
        datasource_url,
        database,
        scope_org_id,
    })
}
