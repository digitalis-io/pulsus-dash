//! The shim file set and `ci:shim-lint` (T03-001).

use std::path::{Path, PathBuf};

use crate::R;
use crate::report::Violation;

pub const SHIM_DIR: &str = "web/shim";
pub const GEN_DIR: &str = "web/shim/gen";
pub const LINE_BUDGET: u32 = 300;
pub const JS_EXT: [&str; 3] = ["js", "mjs", "cjs"];
/// The T03 §5.1 file column, in table order.
pub const SHIM_PATHS: [&str; 5] = [
    "web/shim/boot.js",
    "web/shim/worker.js",
    "web/shim/net.js",
    "web/shim/input.js",
    "web/shim/sw.js",
];

/// Files under `web/shim/` that git tracks or does not ignore (root-relative, sorted).
#[derive(Debug, Clone, Default)]
pub struct ShimFiles {
    pub candidates: Vec<PathBuf>,
}

pub fn candidates(_root: &Path) -> R<ShimFiles> {
    Ok(ShimFiles::default())
}

pub fn js_files(_files: &ShimFiles) -> Vec<PathBuf> {
    Vec::new()
}

#[derive(Debug, Clone)]
pub struct ShimFile {
    pub path: PathBuf,
    pub code_lines: u32,
}

#[derive(Debug, Clone)]
pub struct ShimReport {
    pub files: Vec<ShimFile>,
    pub total: u32,
    pub violations: Vec<Violation>,
}

pub fn lint_files(_root: &Path, _files: &ShimFiles) -> R<ShimReport> {
    Err(crate::XtaskError::Usage("not implemented".into()))
}

pub fn lint(root: &Path) -> R<ShimReport> {
    lint_files(root, &candidates(root)?)
}
