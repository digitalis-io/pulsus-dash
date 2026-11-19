//! `dash-store`: the only Postgres path of Dash (T06-016, T11-023). Every application transaction
//! is opened by [`Db::tx`], which sets the org for row-level security (T11-003); repositories take
//! the org only from [`OrgTx::org`]. See `docs/server/architecture.md`.

#[cfg(all(feature = "test-support", not(debug_assertions)))]
compile_error!("test-support is for tests only");

pub mod bootstrap;
mod db;
mod error;
pub mod migrate;
pub mod repo;
#[cfg(feature = "test-support")]
pub mod testing;

pub use db::{Db, OrgTx, SchemaStatus, StoreHealth};
pub use error::StoreError;

/// The schema level this binary is built for (`pulsus_schema_level.level`, T11-015).
pub const SCHEMA_LEVEL: i64 = 1;
/// `pg_advisory_lock` key of the migration runner: "PULSMIGR" (T11-015).
pub const MIGRATION_LOCK_KEY: i64 = 0x5055_4C53_4D49_4752;
/// `pg_advisory_xact_lock` key of first-run seeding: "PULSBOOT".
pub const BOOTSTRAP_LOCK_KEY: i64 = 0x5055_4C53_424F_4F54;
/// Every tenant table and its org column (T11-003); the catalogue itest asserts this is complete.
pub const TENANT_TABLES: &[(&str, &str)] = &[
    ("orgs", "id"),
    ("tenant_bindings", "org_id"),
    ("users", "org_id"),
    ("teams", "org_id"),
    ("memberships", "org_id"),
    ("roles", "org_id"),
    ("role_permissions", "org_id"),
    ("grants", "org_id"),
    ("idps", "org_id"),
    ("sessions", "org_id"),
];
