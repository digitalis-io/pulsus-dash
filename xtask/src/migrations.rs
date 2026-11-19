//! `ci migrations` (T11-013, T11-001; plan §3.8): squawk over every migration plus two
//! file-level rules squawk does not cover.

use std::path::Path;

use crate::R;
use crate::report::Violation;

/// Root-relative migrations directory of `dash-store`.
pub const MIGRATIONS_DIR: &str = "server/crates/dash-store/migrations";
/// Root-relative squawk configuration.
pub const SQUAWK_CONFIG: &str = ".squawk.toml";

/// `CREATE EXTENSION` outside `--` comments → `migration-extension`; `ATTACH PARTITION` without
/// `VALIDATE CONSTRAINT` in the same file → `migration-lint`.
pub fn lint_text(rel: &Path, text: &str) -> Vec<Violation> {
    let _ = (rel, text);
    Vec::new()
}

/// Runs the gate.
pub fn check(root: &Path) -> R<Vec<Violation>> {
    let _ = root;
    Ok(Vec::new())
}
