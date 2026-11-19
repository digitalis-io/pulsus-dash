//! `cargo xtask`: CI gates, gate-proof seeds, build tools, artefact generation and the dev
//! server. See `docs/development/build-and-ci.md`.
//!
//! | Invocation | 0 | 1 | 2 |
//! |---|---|---|---|
//! | `ci <gate-id>` | passed | failed | error or unknown gate |
//! | `ci all` | all passed | any failed | any error (takes precedence) |
//! | `seed <gate-id>` / `unseed <gate-id>` | done | — | error or unknown gate |
//! | `tools` / `gen [--test]` | done | — | error |
//! | `serve [--root DIR] [--port N] [--no-isolation]` | (runs until stopped) | — | error |

use std::process::ExitCode;

use xtask::gates::{Gate, GateResult, run_all, run_gate};
use xtask::r#gen::{GenOptions, generate};
use xtask::serve::{ServeOptions, serve};
use xtask::{XtaskError, repo_root, seed, tools};

const USAGE: &str = "usage: cargo xtask ci <gate-id|all> | seed <gate-id> | unseed <gate-id> | tools | gen [--test]\n\
       | serve [--root DIR] [--port N] [--no-isolation]\n\
gates: fmt build clippy test wasm probe-absent bundle-size design-check shim-lint dep-audit e2e";

fn usage() -> XtaskError {
    XtaskError::Usage(USAGE.into())
}

fn gate_arg(arg: Option<&str>) -> Result<Gate, XtaskError> {
    let a = arg.ok_or_else(usage)?;
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

/// `serve [--root DIR] [--port N] [--no-isolation]`; a relative root is from the repository root.
fn serve_options(root: &std::path::Path, args: &[String]) -> Result<ServeOptions, XtaskError> {
    let mut o = ServeOptions {
        root: root.join("web"),
        port: 8080,
        isolation: true,
    };
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--root" => o.root = root.join(it.next().ok_or_else(usage)?),
            "--port" => {
                o.port = it.next().and_then(|p| p.parse().ok()).ok_or_else(usage)?;
            }
            "--no-isolation" => o.isolation = false,
            _ => return Err(usage()),
        }
    }
    Ok(o)
}

fn run(args: &[String]) -> Result<u8, XtaskError> {
    let root = repo_root()?;
    let cmd = args.first().map(String::as_str);
    let arg = args.get(1).map(String::as_str);
    if args.len() > 2 && cmd != Some("serve") {
        return Err(usage());
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
        Some("tools") if arg.is_none() => {
            tools::install(&root, &tools::load(&root)?)?;
            Ok(0)
        }
        Some("gen") => {
            let o = match arg {
                None => GenOptions::dev(&root),
                Some("--test") => GenOptions::test(&root),
                Some(_) => return Err(usage()),
            };
            generate(&root, &o)?;
            Ok(0)
        }
        Some("serve") => {
            let o = serve_options(&root, &args[1..])?;
            println!(
                "serving {} on http://localhost:{} (isolation {})",
                o.root.display(),
                o.port,
                if o.isolation { "on" } else { "off" }
            );
            serve(&o, None)?;
            Ok(0)
        }
        _ => Err(usage()),
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
