//! Store errors. Logs use [`StoreError::kind`] and [`StoreError::sqlstate`], never `Display` of
//! the wrapped `sqlx::Error` (plan §3.3 output rule).

/// A failed store operation.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// I/O, TLS, pool timeout, admin shutdown (57P01) or a connection exception (08xxx).
    #[error("postgres unavailable: {0}")]
    Unavailable(sqlx::Error),
    /// A required relation is missing (42P01).
    #[error("schema not migrated")]
    NotMigrated,
    #[error("schema level {db} is ahead of this binary (level {max}); refusing (T11-015)")]
    SchemaTooNew { db: i64, max: i64 },
    /// Unique violation (23505).
    #[error("conflict: {0}")]
    Conflict(String),
    /// Insufficient privilege or a row-level security violation (42501).
    #[error("row-level security refused the write: {0}")]
    Rls(String),
    #[error("database error: {0}")]
    Other(sqlx::Error),
}

impl StoreError {
    /// Maps a `sqlx` error by SQLSTATE and kind.
    pub fn from_sqlx(e: sqlx::Error) -> Self {
        match &e {
            sqlx::Error::Database(db) => match db.code().as_deref() {
                Some("42P01") => StoreError::NotMigrated,
                Some("23505") => StoreError::Conflict(db.message().to_string()),
                Some("42501") => StoreError::Rls(db.message().to_string()),
                Some(c) if c == "57P01" || c.starts_with("08") => StoreError::Unavailable(e),
                _ => StoreError::Other(e),
            },
            sqlx::Error::Io(_)
            | sqlx::Error::Tls(_)
            | sqlx::Error::PoolTimedOut
            | sqlx::Error::PoolClosed => StoreError::Unavailable(e),
            _ => StoreError::Other(e),
        }
    }

    /// A fixed, loggable name of the variant.
    pub fn kind(&self) -> &'static str {
        match self {
            StoreError::Unavailable(_) => "unavailable",
            StoreError::NotMigrated => "not_migrated",
            StoreError::SchemaTooNew { .. } => "schema_too_new",
            StoreError::Conflict(_) => "conflict",
            StoreError::Rls(_) => "rls",
            StoreError::Other(_) => "other",
        }
    }

    /// The SQLSTATE of a database error, if any.
    pub fn sqlstate(&self) -> Option<String> {
        match self {
            StoreError::Unavailable(sqlx::Error::Database(db))
            | StoreError::Other(sqlx::Error::Database(db)) => db.code().map(|c| c.to_string()),
            StoreError::NotMigrated => Some("42P01".into()),
            StoreError::Conflict(_) => Some("23505".into()),
            StoreError::Rls(_) => Some("42501".into()),
            _ => None,
        }
    }
}
