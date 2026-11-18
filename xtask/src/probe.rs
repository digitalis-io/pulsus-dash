//! `ci:probe-absent` and the e2e probe check (T03-024, plan §3.7). Stub.

use std::path::{Path, PathBuf};

use crate::R;
use crate::r#gen::GenOptions;
use crate::report::Violation;

/// The core artefact files, relative to a web root.
pub const REQUIRED: [&str; 4] = [
    "shim/gen/dash-core-mt/dash_core_mt.js",
    "shim/gen/dash-core-mt/dash_core_mt_bg.wasm",
    "shim/gen/dash-core-st/dash_core_st.js",
    "shim/gen/dash-core-st/dash_core_st_bg.wasm",
];

pub fn scan(_dir: &Path) -> R<Vec<PathBuf>> {
    Ok(Vec::new())
}

pub fn probe_absent_with(
    _root: &Path,
    _generator: &dyn Fn(&Path, &GenOptions) -> R<()>,
) -> R<Vec<Violation>> {
    Ok(Vec::new())
}

pub fn probe_absent(root: &Path) -> R<Vec<Violation>> {
    probe_absent_with(root, &crate::r#gen::generate)
}

pub fn probe_expected(_test_web_root: &Path) -> R<Vec<Violation>> {
    Ok(Vec::new())
}
