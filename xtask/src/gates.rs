//! The gate registry and runner (T05-001).

use std::path::Path;

use crate::R;
use crate::report::Violation;

/// A CI gate, run identically locally and in CI as `cargo xtask ci <id>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Fmt,
    Build,
    Clippy,
    Test,
    Wasm,
    BundleSize,
    DesignCheck,
    ShimLint,
    DepAudit,
}

impl Gate {
    pub const ALL: [Gate; 9] = [
        Gate::Fmt,
        Gate::Build,
        Gate::Clippy,
        Gate::Test,
        Gate::Wasm,
        Gate::BundleSize,
        Gate::DesignCheck,
        Gate::ShimLint,
        Gate::DepAudit,
    ];

    pub fn id(self) -> &'static str {
        ""
    }

    pub fn parse(_s: &str) -> Option<Gate> {
        None
    }
}

/// Outcome of one gate run.
#[derive(Debug)]
pub enum GateResult {
    Pass { output: String },
    Fail { violations: Vec<Violation>, output: String },
}

pub fn run_gate(_gate: Gate, _root: &Path) -> R<GateResult> {
    Err(crate::XtaskError::Usage("not implemented".into()))
}

pub fn run_all(_root: &Path) -> Vec<(Gate, R<GateResult>)> {
    Vec::new()
}
