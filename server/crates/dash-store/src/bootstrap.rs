//! First-run seeding of the default org and its binding (T06 §4.9, plan §4.3).

use dash_core::{OrgId, ScopeOrgId};
use url::Url;

use crate::BOOTSTRAP_LOCK_KEY;
use crate::db::Db;
use crate::error::StoreError;
use crate::repo::orgs;
use crate::repo::tenant_bindings::{self, NewTenantBinding};

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
///
/// No org with `org_slug` → the org (with its built-in roles) and the binding are created in one
/// transaction. Otherwise nothing is written; the stored binding is compared with the seed.
pub async fn seed(db: &Db, seed: &DatasourceSeedRef<'_>) -> Result<SeedOutcome, StoreError> {
    let mut tx = db.tx(OrgId::new_v7()).await?;
    sqlx::query!(
        r#"SELECT pg_advisory_xact_lock($1)::text AS "locked""#,
        BOOTSTRAP_LOCK_KEY
    )
    .fetch_one(tx.conn())
    .await
    .map_err(StoreError::from_sqlx)?;
    let found = sqlx::query_scalar!("SELECT bootstrap_find_org($1)", seed.org_slug)
        .fetch_one(tx.conn())
        .await
        .map_err(StoreError::from_sqlx)?;
    let Some(existing) = found else {
        let org = tx.org();
        orgs::create(&mut tx, seed.org_slug, seed.org_slug).await?;
        tenant_bindings::insert(
            &mut tx,
            NewTenantBinding {
                slug: seed.slug,
                datasource_url: seed.url,
                database: seed.database,
                scope_org_id: seed.scope_org_id,
            },
        )
        .await?;
        tx.commit().await?;
        return Ok(SeedOutcome::Created { org });
    };
    tx.rollback().await?;
    let org = OrgId(existing);
    let mut tx = db.tx(org).await?;
    let stored = tenant_bindings::get_by_slug(&mut tx, seed.slug).await?;
    tx.rollback().await?;
    let binding_differs = stored.is_none_or(|b| {
        b.datasource_url != *seed.url
            || b.database.as_deref() != seed.database
            || b.scope_org_id.as_ref() != seed.scope_org_id
    });
    Ok(SeedOutcome::AlreadySeeded {
        org,
        binding_differs,
    })
}
