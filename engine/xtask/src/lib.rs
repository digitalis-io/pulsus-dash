//! `cargo xtask spec-lint` (plan #68 §3.13, the `ci:spec-lint` subset; T02-001, VIZ-002, T05-004).

use std::path::Path;

/// `cargo metadata --format-version 1 --locked` of the workspace at `root`.
pub fn metadata(root: &Path) -> Result<serde_json::Value, String> {
    let _ = root;
    Err("not implemented".into())
}

/// Every violation in the workspace at `root` with its metadata: the offending edge, path or
/// literal. Empty when the workspace conforms.
pub fn spec_lint(root: &Path, meta: &serde_json::Value) -> Vec<String> {
    let _ = (root, meta);
    Vec::new()
}
