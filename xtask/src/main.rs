//! `cargo xtask`: CI gates and gate-proof seeds. See `docs/development/build-and-ci.md`.
//!
//! | Invocation | 0 | 1 | 2 |
//! |---|---|---|---|
//! | `ci <gate-id>` | passed | failed | error or unknown gate |
//! | `ci all` | all passed | any failed | any error (takes precedence) |
//! | `seed <gate-id>` / `unseed <gate-id>` | done | — | error or unknown gate |

use std::process::ExitCode;

use xtask::gates::{Gate, GateResult, run_all, run_gate};
use xtask::{XtaskError, repo_root, seed};

const USAGE: &str = "usage: cargo xtask ci <gate-id|all> | seed <gate-id> | unseed <gate-id>\n\
gates: fmt build clippy test wasm bundle-size design-check shim-lint dep-audit";

fn gate_arg(arg: Option<&str>) -> Result<Gate, XtaskError> {
    let a = arg.ok_or_else(|| XtaskError::Usage(USAGE.into()))?;
    Gate::parse(a).ok_or_else(|| XtaskError::Usage(format!("unknown gate `{a}`\n{USAGE}")))
}

fn report(gate: Gate, r: &Result<GateResult, XtaskError>) -> u8 {
    match r {
        Ok(GateResult::Pass { .. }) => {
            println!("ci {}: pass", gate.id());
            0
        }
        Ok(GateResult::Fail { violations, .. }) => {
            println!(
                "ci {}: FAIL ({} violation(s) or tool failure)",
                gate.id(),
                violations.len()
            );
            1
        }
        Err(e) => {
            eprintln!("error: ci {}: {e}", gate.id());
            2
        }
    }
}

fn run(args: &[String]) -> Result<u8, XtaskError> {
    let root = repo_root()?;
    let cmd = args.first().map(String::as_str);
    let arg = args.get(1).map(String::as_str);
    if args.len() > 2 {
        return Err(XtaskError::Usage(USAGE.into()));
    }
    match cmd {
        Some("ci") if arg == Some("all") => {
            let results = run_all(&root);
            let codes: Vec<u8> = results.iter().map(|(g, r)| report(*g, r)).collect();
            Ok(if codes.contains(&2) {
                2
            } else if codes.contains(&1) {
                1
            } else {
                0
            })
        }
        Some("ci") => {
            let gate = gate_arg(arg)?;
            let r = run_gate(gate, &root);
            Ok(report(gate, &r))
        }
        Some("seed") => {
            let gate = gate_arg(arg)?;
            for p in seed::seed(gate, &root)? {
                println!("{}", xtask::rel_str(&p));
            }
            Ok(0)
        }
        Some("unseed") => {
            let gate = gate_arg(arg)?;
            for p in seed::unseed(gate, &root)? {
                println!("{}", xtask::rel_str(&p));
            }
            Ok(0)
        }
        _ => Err(XtaskError::Usage(USAGE.into())),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(code) => ExitCode::from(code),
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::from(2)
        }
    }
}
