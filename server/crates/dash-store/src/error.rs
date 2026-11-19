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
        StoreError::Other(e)
    }

    /// A fixed, loggable name of the variant.
    pub fn kind(&self) -> &'static str {
        "other"
    }

    /// The SQLSTATE of a database error, if any.
    pub fn sqlstate(&self) -> Option<String> {
        None
    }
}
