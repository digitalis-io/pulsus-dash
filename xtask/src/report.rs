//! Violations, rules, errors and their console / GitHub annotation output.

use std::fmt;
use std::path::PathBuf;

/// The rule a [`Violation`] breaks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    ShimDirMissing,
    ShimLineBudget,
    ShimImport,
    ShimForbiddenToken,
    ShimLexError,
    JsOutsideShim,
    NpmRuntimeDependency,
    NpmDisallowedDevDependency,
    BrowserCrateNotAllowed,
    WebSysFeature,
    RenderWorkerLock,
    RustLexError,
    ThirdPartyHost,
    ShimFileNotAllowed,
    ShimUnpinned,
    ShimPinMismatch,
    ShimPinStale,
    GeneratedJsPresent,
    BundleOverBudget,
    BundleArtefactAbsent,
    DesignCheckFailed,
    TraceabilityStale,
}

impl Rule {
    /// Kebab-case id of the rule, e.g. `shim-line-budget`.
    pub fn id(self) -> &'static str {
        ""
    }
}

/// Severity of a printed finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Error,
    Warning,
}

/// One finding of a gate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub rule: Rule,
    /// Root-relative path.
    pub path: PathBuf,
    pub line: Option<u32>,
    pub message: String,
}

impl Violation {
    /// The GitHub Actions workflow command for this finding.
    pub fn annotation(&self, _level: Level) -> String {
        String::new()
    }
}

impl fmt::Display for Violation {
    fn fmt(&self, _f: &mut fmt::Formatter<'_>) -> fmt::Result {
        Ok(())
    }
}

/// Prints violations as errors.
pub fn emit(_v: &[Violation]) {}

/// Prints violations as warnings.
pub fn warn(_v: &[Violation]) {}

/// Errors that stop a gate from producing a verdict (exit code 2).
#[derive(Debug)]
pub enum XtaskError {
    Usage(String),
    Config { path: PathBuf, detail: String },
    Io { path: PathBuf, source: std::io::Error },
    Tool { command: String, detail: String },
}

impl fmt::Display for XtaskError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for XtaskError {}
