//! `ci:bundle-size`: brotli sizes against the T03 §7.3 budgets (plan §4.4).

use std::path::Path;

use serde::Deserialize;

use crate::report::Violation;
use crate::{R, XtaskError};

#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Report,
    Enforce,
}

/// `ci/bundle-budgets.toml`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BundleConfig {
    pub mode: Mode,
    pub eager_total_bytes: u64,
    #[serde(rename = "artefact")]
    pub artefacts: Vec<ArtefactBudget>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtefactBudget {
    pub name: String,
    /// First cell of the T03 §7.3 row, verbatim.
    pub t03_row: String,
    #[serde(default)]
    pub instances: Option<String>,
    pub files: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    pub budget_bytes: u64,
    pub eager: bool,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtefactStatus {
    Ok,
    OverBudget,
    Absent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtefactSize {
    pub name: String,
    pub raw_bytes: u64,
    pub brotli_bytes: u64,
    pub budget_bytes: u64,
    pub status: ArtefactStatus,
}

#[derive(Debug, Clone)]
pub struct BundleReport {
    pub mode: Mode,
    pub artefacts: Vec<ArtefactSize>,
    pub eager_total_brotli: u64,
    pub eager_total_budget: u64,
    pub violations: Vec<Violation>,
    pub warnings: Vec<Violation>,
}

pub fn load_config(_root: &Path) -> R<BundleConfig> {
    Err(XtaskError::Usage("not implemented".into()))
}

pub fn brotli_len(_bytes: &[u8]) -> u64 {
    0
}

pub fn measure(_root: &Path, _cfg: &BundleConfig) -> R<BundleReport> {
    Err(XtaskError::Usage("not implemented".into()))
}

pub fn render_markdown(_r: &BundleReport) -> String {
    String::new()
}
