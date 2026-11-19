//! The gate registry and runner (T05-001, plan §3.5). Every gate runs identically locally and in
//! CI as `cargo xtask ci <gate-id>`.

use std::io::Write;
use std::path::Path;
use std::process::Command;

use crate::report::{Violation, emit, warn};
use crate::{R, XtaskError, bundle, dep_audit, design, shim};

/// A CI gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    Fmt,
    Build,
    Clippy,
    Test,
    Wasm,
    ProbeAbsent,
    BundleSize,
    DesignCheck,
    ShimLint,
    DepAudit,
    E2e,
    Migrations,
    NoPulsusdbHost,
    Itest,
}

impl Gate {
    pub const ALL: [Gate; 14] = [
        Gate::Fmt,
        Gate::Build,
        Gate::Clippy,
        Gate::Test,
        Gate::Wasm,
        Gate::ProbeAbsent,
        Gate::BundleSize,
        Gate::DesignCheck,
        Gate::ShimLint,
        Gate::DepAudit,
        Gate::E2e,
        Gate::Migrations,
        Gate::NoPulsusdbHost,
        Gate::Itest,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Gate::Fmt => "fmt",
            Gate::Build => "build",
            Gate::Clippy => "clippy",
            Gate::Test => "test",
            Gate::Wasm => "wasm",
            Gate::BundleSize => "bundle-size",
            Gate::DesignCheck => "design-check",
            Gate::ShimLint => "shim-lint",
            Gate::DepAudit => "dep-audit",
            Gate::ProbeAbsent => "probe-absent",
            Gate::E2e => "e2e",
            Gate::Migrations => "migrations",
            Gate::NoPulsusdbHost => "no-pulsusdb-host",
            Gate::Itest => "itest",
        }
    }

    pub fn parse(s: &str) -> Option<Gate> {
        Gate::ALL.into_iter().find(|g| g.id() == s)
    }

    /// The cargo invocations of the five cargo gates (run in order; the first failure stops).
    /// `wasm` then generates both core artefacts into `web/shim/gen/` (plan §3.7).
    fn cargo_commands(self) -> &'static [&'static [&'static str]] {
        match self {
            Gate::Fmt => &[&["fmt", "--all", "--check"]],
            Gate::Build => &[&["build", "--workspace", "--locked"]],
            Gate::Clippy => &[
                &[
                    "clippy",
                    "--workspace",
                    "--all-targets",
                    "--locked",
                    "--",
                    "-D",
                    "warnings",
                ],
                &[
                    "clippy",
                    "--locked",
                    "--target",
                    "wasm32-unknown-unknown",
                    "--package",
                    "dash-core-mt",
                    "--",
                    "-D",
                    "warnings",
                ],
            ],
            Gate::Test => &[&["test", "--workspace", "--locked"]],
            Gate::Wasm => &[&["build-wasm"]],
            Gate::BundleSize
            | Gate::DesignCheck
            | Gate::ShimLint
            | Gate::DepAudit
            | Gate::ProbeAbsent
            | Gate::E2e
            | Gate::Migrations
            | Gate::NoPulsusdbHost
            | Gate::Itest => &[],
        }
    }
}

/// Outcome of one gate run.
#[derive(Debug)]
pub enum GateResult {
    Pass {
        output: String,
    },
    Fail {
        violations: Vec<Violation>,
        output: String,
    },
}

/// Runs `cargo <args>` in `root`, captures stdout/stderr, then echoes them.
fn run_cargo(root: &Path, args: &[&str], output: &mut String) -> R<bool> {
    let command = format!("cargo {}", args.join(" "));
    println!("$ {command}");
    let out = Command::new("cargo")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| XtaskError::Tool {
            command: command.clone(),
            detail: e.to_string(),
        })?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    print!("{stdout}");
    eprint!("{stderr}");
    // Best effort: interleaving of the two streams is cosmetic.
    let _ = std::io::stdout().flush();
    output.push_str(&format!("$ {command}\n{stdout}{stderr}"));
    Ok(out.status.success())
}

fn verdict(violations: Vec<Violation>, output: String) -> GateResult {
    emit(&violations);
    if violations.is_empty() {
        GateResult::Pass { output }
    } else {
        GateResult::Fail { violations, output }
    }
}

/// Runs one gate with `current_dir(root)`.
pub fn run_gate(gate: Gate, root: &Path) -> R<GateResult> {
    match gate {
        Gate::Fmt | Gate::Build | Gate::Clippy | Gate::Test | Gate::Wasm => {
            let mut output = String::new();
            for args in gate.cargo_commands() {
                if !run_cargo(root, args, &mut output)? {
                    return Ok(GateResult::Fail {
                        violations: Vec::new(),
                        output,
                    });
                }
            }
            if gate == Gate::Wasm {
                crate::r#gen::generate(root, &crate::r#gen::GenOptions::release(root))?;
            }
            Ok(GateResult::Pass { output })
        }
        Gate::BundleSize => {
            let cfg = bundle::load_config(root)?;
            let report = bundle::measure(root, &cfg)?;
            let md = bundle::render_markdown(&report);
            println!("{md}");
            if let Ok(summary) = std::env::var("GITHUB_STEP_SUMMARY") {
                let mut f = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&summary)
                    .map_err(XtaskError::io(&summary))?;
                writeln!(f, "{md}").map_err(XtaskError::io(&summary))?;
            }
            warn(&report.warnings);
            Ok(verdict(report.violations, md))
        }
        Gate::DesignCheck => Ok(verdict(design::check(root)?, String::new())),
        Gate::ShimLint => {
            let report = shim::lint(root)?;
            let mut output = String::new();
            for f in &report.files {
                output.push_str(&format!(
                    "{:>5}  {}\n",
                    f.code_lines,
                    crate::rel_str(&f.path)
                ));
            }
            output.push_str(&format!(
                "shim: {} / {} lines\n",
                report.total,
                shim::LINE_BUDGET
            ));
            print!("{output}");
            Ok(verdict(report.violations, output))
        }
        Gate::DepAudit => Ok(verdict(dep_audit::audit(root)?, String::new())),
        Gate::ProbeAbsent => Ok(verdict(crate::probe::probe_absent(root)?, String::new())),
        Gate::Migrations => Ok(verdict(crate::migrations::check(root)?, String::new())),
        Gate::NoPulsusdbHost => Ok(verdict(crate::pulsusdb_host::run(root)?, String::new())),
        Gate::Itest => {
            let (violations, passed) = crate::itest::run(root)?;
            emit(&violations);
            if passed && violations.is_empty() {
                Ok(GateResult::Pass {
                    output: String::new(),
                })
            } else {
                Ok(GateResult::Fail {
                    violations,
                    output: "an itest step failed".into(),
                })
            }
        }
        Gate::E2e => {
            let (violations, playwright_passed) = crate::e2e::run(root)?;
            emit(&violations);
            if playwright_passed && violations.is_empty() {
                Ok(GateResult::Pass {
                    output: String::new(),
                })
            } else {
                Ok(GateResult::Fail {
                    violations,
                    output: "playwright, the trace check or the dev up flow failed".into(),
                })
            }
        }
    }
}

/// Runs all fourteen gates in [`Gate::ALL`] order; never stops early.
pub fn run_all(root: &Path) -> Vec<(Gate, R<GateResult>)> {
    Gate::ALL
        .into_iter()
        .map(|g| {
            println!("==> ci {}", g.id());
            (g, run_gate(g, root))
        })
        .collect()
}
