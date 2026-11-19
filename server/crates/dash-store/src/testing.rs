//! Test support (feature `test-support`, debug builds only): per-test databases on the itest
//! stack and RLS fixtures (plan §3.4). Uses dynamic SQL for generated names; never in releases.

use dash_core::{OrgId, Secret};
use sqlx::{AssertSqlSafe, Connection, PgConnection};
use uuid::Uuid;

use crate::db::OrgTx;
use crate::error::StoreError;
use crate::migrate::{self, MigrateReport};

/// Admin (superuser) URL of the itest Postgres.
pub const ADMIN_URL_ENV: &str = "DASH_ITEST_PG_ADMIN_URL";
/// Serialises `roles.sql` across concurrently starting tests.
const ROLES_LOCK_KEY: i64 = 0x5055_4C53_524F_4C45; // "PULSROLE"

const ROLES_SQL: &str = include_str!("../sql/roles.sql");

/// A throwaway database `itest_<uuid>` owned by `pulsus_owner`. `Debug` redacts the admin URL.
pub struct TestDb {
    pub name: String,
    admin: String,
}

fn other(detail: String) -> StoreError {
    StoreError::Other(sqlx::Error::Configuration(detail.into()))
}

impl std::fmt::Debug for TestDb {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TestDb")
            .field("name", &self.name)
            .field("admin", &dash_core::REDACTED)
            .finish()
    }
}

impl TestDb {
    /// Creates the roles (advisory-locked) and a fresh database.
    pub async fn create() -> Result<TestDb, StoreError> {
        let admin = std::env::var(ADMIN_URL_ENV)
            .map_err(|_| other(format!("{ADMIN_URL_ENV} is not set")))?;
        let mut conn = PgConnection::connect(&admin)
            .await
            .map_err(StoreError::from_sqlx)?;
        sqlx::query("SELECT pg_advisory_lock($1)::text")
            .bind(ROLES_LOCK_KEY)
            .execute(&mut conn)
            .await
            .map_err(StoreError::from_sqlx)?;
        let roles = sqlx::raw_sql(ROLES_SQL).execute(&mut conn).await;
        sqlx::query("SELECT pg_advisory_unlock($1)")
            .bind(ROLES_LOCK_KEY)
            .execute(&mut conn)
            .await
            .map_err(StoreError::from_sqlx)?;
        roles.map_err(StoreError::from_sqlx)?;
        let name = format!("itest_{}", Uuid::now_v7().simple());
        // Separate statements: CREATE DATABASE cannot run in the implicit multi-statement
        // transaction.
        for sql in [
            format!("CREATE DATABASE {name} OWNER pulsus_owner"),
            format!("GRANT CONNECT ON DATABASE {name} TO pulsus_app, pulsus_maint"),
        ] {
            sqlx::raw_sql(AssertSqlSafe(sql))
                .execute(&mut conn)
                .await
                .map_err(StoreError::from_sqlx)?;
        }
        Ok(TestDb { name, admin })
    }

    /// The URL of this database as `role` (no password: the itest stack trusts loopback).
    pub fn url_as(&self, role: &str) -> String {
        match url::Url::parse(&self.admin) {
            Ok(mut u) => {
                // Infallible for a URL with a host, which a Postgres admin URL has.
                let _ = u.set_username(role);
                let _ = u.set_password(None);
                u.set_path(&format!("/{}", self.name));
                u.to_string()
            }
            Err(_) => String::new(),
        }
    }

    /// `migrate::run` as `pulsus_owner`.
    pub async fn migrate(&self) -> Result<MigrateReport, StoreError> {
        migrate::run(&Secret::new(self.url_as("pulsus_owner"))).await
    }

    async fn owner(&self) -> Result<PgConnection, StoreError> {
        PgConnection::connect(&self.url_as("pulsus_owner"))
            .await
            .map_err(StoreError::from_sqlx)
    }

    /// Runs `sql` (one or more statements) as `pulsus_owner`.
    pub async fn owner_exec(&self, sql: &str) -> Result<(), StoreError> {
        let mut c = self.owner().await?;
        sqlx::raw_sql(AssertSqlSafe(sql.to_string()))
            .execute(&mut c)
            .await
            .map_err(StoreError::from_sqlx)?;
        Ok(())
    }

    /// The `bigint` result of `sql` as `pulsus_owner`.
    pub async fn owner_i64(&self, sql: &str) -> Result<i64, StoreError> {
        let mut c = self.owner().await?;
        sqlx::query_scalar(AssertSqlSafe(sql.to_string()))
            .fetch_one(&mut c)
            .await
            .map_err(StoreError::from_sqlx)
    }

    /// `DROP DATABASE … WITH (FORCE)`.
    pub async fn drop(self) -> Result<(), StoreError> {
        let mut conn = PgConnection::connect(&self.admin)
            .await
            .map_err(StoreError::from_sqlx)?;
        sqlx::raw_sql(AssertSqlSafe(format!(
            "DROP DATABASE IF EXISTS {} WITH (FORCE)",
            self.name
        )))
        .execute(&mut conn)
        .await
        .map_err(StoreError::from_sqlx)?;
        Ok(())
    }
}

/// The distinct org ids of `table` visible in `tx`.
pub async fn visible_orgs(
    tx: &mut OrgTx,
    table: &str,
    org_col: &str,
) -> Result<Vec<Uuid>, StoreError> {
    sqlx::query_scalar(AssertSqlSafe(format!(
        "SELECT DISTINCT {org_col} FROM {table} ORDER BY 1"
    )))
    .fetch_all(tx.conn())
    .await
    .map_err(StoreError::from_sqlx)
}

/// The fixture INSERT of each tenant table: key and NOT NULL columns, `$1` = the org, `$2`/`$3`
/// = fresh UUIDv7s.
pub const FIXTURES: &[(&str, &str)] = &[
    (
        "orgs",
        "INSERT INTO orgs (id, slug, name) VALUES ($1, 'fx-' || $2::text, 'fixture')",
    ),
    (
        "tenant_bindings",
        "INSERT INTO tenant_bindings (org_id, id, slug, datasource_url) VALUES ($1, $2, 'fixture', 'http://pulsusdb.invalid:9/')",
    ),
    (
        "users",
        "INSERT INTO users (org_id, id, email) VALUES ($1, $2, 'fixture@example.com')",
    ),
    (
        "teams",
        "INSERT INTO teams (org_id, id, name) VALUES ($1, $2, 'fixture')",
    ),
    (
        "memberships",
        "INSERT INTO memberships (org_id, team_id, user_id, source) VALUES ($1, $2, $3, 'ui')",
    ),
    (
        "roles",
        "INSERT INTO roles (org_id, id, name, builtin) VALUES ($1, $2, 'fixture', false)",
    ),
    (
        "role_permissions",
        "INSERT INTO role_permissions (org_id, role_id, permission) VALUES ($1, $2, 'fixture')",
    ),
    (
        "grants",
        "INSERT INTO grants (org_id, id, resource_kind, source) VALUES ($1, $2, 'org', 'ui')",
    ),
    ("idps", "INSERT INTO idps (org_id, id) VALUES ($1, $2)"),
    (
        "sessions",
        "INSERT INTO sessions (sid_hash, org_id, user_id, idle_expires_at, absolute_expires_at, perms_epoch) VALUES (decode(replace($2::text, '-', ''), 'hex'), $1, $3, now(), now(), 0)",
    ),
];

fn fixture_sql(table: &str) -> Result<&'static str, StoreError> {
    FIXTURES
        .iter()
        .find(|(t, _)| *t == table)
        .map(|(_, sql)| *sql)
        .ok_or_else(|| other(format!("no fixture for {table}")))
}

async fn insert_with(conn: &mut PgConnection, table: &str, org: OrgId) -> Result<(), StoreError> {
    let sql = fixture_sql(table)?;
    let mut q = sqlx::query(sql).bind(org.0).bind(Uuid::now_v7());
    if sql.contains("$3") {
        q = q.bind(Uuid::now_v7());
    }
    q.execute(conn).await.map_err(StoreError::from_sqlx)?;
    Ok(())
}

/// Inserts one fixture row of `table` for `org` inside `tx`.
pub async fn insert_fixture(tx: &mut OrgTx, table: &str, org: OrgId) -> Result<(), StoreError> {
    insert_with(tx.conn(), table, org).await
}

/// `count(*)` of `table` as `pulsus_app` without any org set (must be 0: fail closed).
pub async fn app_count_unset_org(app_url: &str, table: &str) -> Result<i64, StoreError> {
    let mut c = PgConnection::connect(app_url)
        .await
        .map_err(StoreError::from_sqlx)?;
    sqlx::query_scalar(AssertSqlSafe(format!("SELECT count(*) FROM {table}")))
        .fetch_one(&mut c)
        .await
        .map_err(StoreError::from_sqlx)
}

/// Inserts a `sessions` row for `org` as `pulsus_owner` (the app has no privilege, T11-027).
pub async fn owner_insert_session(db: &TestDb, org: OrgId) -> Result<(), StoreError> {
    let mut c = db.owner().await?;
    insert_with(&mut c, "sessions", org).await
}
