//! Pinned build tools (T03 §5.6): `ci/tools.toml` and `cargo xtask tools`. Stub.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::{R, XtaskError};

pub const CONFIG_PATH: &str = "ci/tools.toml";

/// `ci/tools.toml`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tools {
    pub nightly: String,
    pub wasm_bindgen: String,
    pub binaryen: String,
    pub binaryen_sha256: BTreeMap<String, String>,
}

pub fn load(_root: &Path) -> R<Tools> {
    Err(XtaskError::config(CONFIG_PATH, "stub"))
}

pub fn install(_root: &Path, _t: &Tools) -> R<()> {
    Ok(())
}

pub fn wasm_bindgen_bin(root: &Path) -> PathBuf {
    root.to_path_buf()
}

pub fn wasm_opt_bin(root: &Path, _t: &Tools) -> PathBuf {
    root.to_path_buf()
}
