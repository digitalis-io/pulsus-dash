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
    GeneratedUnknown,
    GeneratedMismatch,
    LayoutGenStale,
    ProbePresent,
    ProbeArtefactMissing,
    ProbeMarkerUndetected,
    LongTaskTraceMissing,
    MainThreadLongTask,
    BundleOverBudget,
    BundleArtefactAbsent,
    DesignCheckFailed,
    TraceabilityStale,
    PulsusdbHost,
    PulsusdbHostSecretMissing,
    MigrationLint,
    MigrationExtension,
    SqlxCacheStale,
    ServerFrameworkOutsideGateway,
    HttpClientOutsideAllowed,
    SqlCrateOutsideStore,
    SqlOutsideStore,
}

impl Rule {
    /// Kebab-case id of the rule, e.g. `shim-line-budget`.
    pub fn id(self) -> &'static str {
        match self {
            Rule::ShimDirMissing => "shim-dir-missing",
            Rule::ShimLineBudget => "shim-line-budget",
            Rule::ShimImport => "shim-import",
            Rule::ShimForbiddenToken => "shim-forbidden-token",
            Rule::ShimLexError => "shim-lex-error",
            Rule::JsOutsideShim => "js-outside-shim",
            Rule::NpmRuntimeDependency => "npm-runtime-dependency",
            Rule::NpmDisallowedDevDependency => "npm-disallowed-dev-dependency",
            Rule::BrowserCrateNotAllowed => "browser-crate-not-allowed",
            Rule::WebSysFeature => "web-sys-feature",
            Rule::RenderWorkerLock => "render-worker-lock",
            Rule::RustLexError => "rust-lex-error",
            Rule::ThirdPartyHost => "third-party-host",
            Rule::ShimFileNotAllowed => "shim-file-not-allowed",
            Rule::ShimUnpinned => "shim-unpinned",
            Rule::ShimPinMismatch => "shim-pin-mismatch",
            Rule::ShimPinStale => "shim-pin-stale",
            Rule::GeneratedUnknown => "generated-unknown",
            Rule::GeneratedMismatch => "generated-mismatch",
            Rule::LayoutGenStale => "layout-gen-stale",
            Rule::ProbePresent => "probe-present",
            Rule::ProbeArtefactMissing => "probe-artefact-missing",
            Rule::ProbeMarkerUndetected => "probe-marker-undetected",
            Rule::LongTaskTraceMissing => "long-task-trace-missing",
            Rule::MainThreadLongTask => "main-thread-long-task",
            Rule::BundleOverBudget => "bundle-over-budget",
            Rule::BundleArtefactAbsent => "bundle-artefact-absent",
            Rule::DesignCheckFailed => "design-check-failed",
            Rule::TraceabilityStale => "traceability-stale",
            Rule::PulsusdbHost => "pulsusdb-host",
            Rule::PulsusdbHostSecretMissing => "pulsusdb-host-secret-missing",
            Rule::MigrationLint => "migration-lint",
            Rule::MigrationExtension => "migration-extension",
            Rule::SqlxCacheStale => "sqlx-cache-stale",
            Rule::ServerFrameworkOutsideGateway => "server-framework-outside-gateway",
            Rule::HttpClientOutsideAllowed => "http-client-outside-allowed",
            Rule::SqlCrateOutsideStore => "sql-crate-outside-store",
            Rule::SqlOutsideStore => "sql-outside-store",
        }
    }
}

/// Severity of a printed finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Error,
    Warning,
}

impl Level {
    fn word(self) -> &'static str {
        match self {
            Level::Error => "error",
            Level::Warning => "warning",
        }
    }
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
    /// `<level>[<rule-id>] <path>[:<line>]: <message>`.
    pub fn render(&self, level: Level) -> String {
        let path = crate::rel_str(&self.path);
        match self.line {
            Some(l) => format!(
                "{}[{}] {path}:{l}: {}",
                level.word(),
                self.rule.id(),
                self.message
            ),
            None => format!(
                "{}[{}] {path}: {}",
                level.word(),
                self.rule.id(),
                self.message
            ),
        }
    }

    /// The GitHub Actions workflow command for this finding.
    pub fn annotation(&self, level: Level) -> String {
        let path = crate::rel_str(&self.path);
        let at = match self.line {
            Some(l) => format!("file={path},line={l}"),
            None => format!("file={path}"),
        };
        // Workflow commands end at a newline; keep multi-line messages on one line.
        let msg = self.message.replace('\n', " ");
        format!("::{} {at}::{}: {msg}", level.word(), self.rule.id())
    }
}

impl fmt::Display for Violation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.render(Level::Error))
    }
}

fn print_all(v: &[Violation], level: Level) {
    let gha = std::env::var("GITHUB_ACTIONS").is_ok_and(|s| s == "true");
    for x in v {
        println!("{}", x.render(level));
        if gha {
            println!("{}", x.annotation(level));
        }
    }
}

/// Prints violations as errors (plus `::error` annotations under GitHub Actions).
pub fn emit(v: &[Violation]) {
    print_all(v, Level::Error);
}

/// Prints violations as warnings (plus `::warning` annotations under GitHub Actions).
pub fn warn(v: &[Violation]) {
    print_all(v, Level::Warning);
}

/// Errors that stop a gate from producing a verdict (exit code 2).
#[derive(Debug)]
pub enum XtaskError {
    /// Bad command line.
    Usage(String),
    /// Missing or invalid configuration, or a refused seed operation.
    Config { path: PathBuf, detail: String },
    /// I/O error on a file the gate reads or writes.
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    /// An external tool is missing, cannot start, or produced unusable output.
    Tool { command: String, detail: String },
}

impl XtaskError {
    pub(crate) fn config(path: impl Into<PathBuf>, detail: impl Into<String>) -> Self {
        XtaskError::Config {
            path: path.into(),
            detail: detail.into(),
        }
    }

    pub(crate) fn io(path: impl Into<PathBuf>) -> impl FnOnce(std::io::Error) -> Self {
        let path = path.into();
        move |source| XtaskError::Io { path, source }
    }
}

impl fmt::Display for XtaskError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            XtaskError::Usage(m) => write!(f, "usage: {m}"),
            XtaskError::Config { path, detail } => {
                write!(f, "config {}: {detail}", path.display())
            }
            XtaskError::Io { path, source } => write!(f, "io {}: {source}", path.display()),
            XtaskError::Tool { command, detail } => write!(f, "tool `{command}`: {detail}"),
        }
    }
}

impl std::error::Error for XtaskError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            XtaskError::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}
