//! `ci:dep-audit`: npm, browser crate graph, web-sys features, render-worker locks (T03-008),
//! web assets and shipped JS (plan §4.3).

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::report::Violation;
use crate::shim::ShimFiles;
use crate::{R, XtaskError};

fn nyi<T>() -> R<T> {
    Err(XtaskError::Usage("not implemented".into()))
}

/// `ci/dep-audit.toml`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DepAuditConfig {
    pub browser_roots: Vec<String>,
    pub npm_dev_allow: Vec<String>,
    pub render_worker_crates: Vec<String>,
    pub web_dir: String,
    pub allowed_url_prefixes: Vec<String>,
    /// member → allowed features; `"Gpu*"` = prefix.
    #[serde(default)]
    pub web_sys: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub lock_allow: Vec<LockAllow>,
    #[serde(default, rename = "browser_crate")]
    pub browser_crates: Vec<CrateAllow>,
}

/// An audited exception to T03-008.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LockAllow {
    #[serde(rename = "crate")]
    pub krate: String,
    pub file: String,
    pub ident: String,
    pub reason: String,
}

/// A non-member crate allowed in the browser graph.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CrateAllow {
    pub name: String,
    pub reason: String,
}

/// `ci/shim-pins.toml`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShimPins {
    #[serde(default, rename = "file")]
    pub files: Vec<ShimPin>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShimPin {
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct Package {
    pub name: String,
    /// Absolute crate directory.
    pub dir: PathBuf,
    pub is_member: bool,
    pub web_sys_features: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct Workspace {
    pub roots: Vec<String>,
    pub normal_edges: BTreeMap<String, BTreeSet<String>>,
    /// Every package in the wasm32-filtered metadata.
    pub packages: BTreeMap<String, Package>,
}

impl Workspace {
    pub fn browser_reachable(&self) -> Vec<String> {
        Vec::new()
    }
}

pub fn load_config(_root: &Path) -> R<DepAuditConfig> {
    nyi()
}

pub fn load_pins(_root: &Path) -> R<ShimPins> {
    nyi()
}

pub fn sha256_hex(_bytes: &[u8]) -> String {
    String::new()
}

pub fn workspace_from_metadata(_root: &Path, _cfg: &DepAuditConfig) -> R<Workspace> {
    nyi()
}

pub fn check_npm(_root: &Path, _cfg: &DepAuditConfig) -> R<Vec<Violation>> {
    nyi()
}

pub fn check_crate_graph(_ws: &Workspace, _cfg: &DepAuditConfig) -> Vec<Violation> {
    Vec::new()
}

pub fn check_web_sys(_ws: &Workspace, _cfg: &DepAuditConfig) -> Vec<Violation> {
    Vec::new()
}

pub fn check_render_worker_locks(
    _root: &Path,
    _ws: &Workspace,
    _cfg: &DepAuditConfig,
) -> R<Vec<Violation>> {
    nyi()
}

pub fn check_web_assets(_root: &Path, _cfg: &DepAuditConfig) -> R<Vec<Violation>> {
    nyi()
}

pub fn check_shipped_js(_root: &Path, _files: &ShimFiles, _pins: &ShimPins) -> R<Vec<Violation>> {
    nyi()
}

pub fn audit(_root: &Path) -> R<Vec<Violation>> {
    nyi()
}
