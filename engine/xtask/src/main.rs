//! Workspace tasks (exit 0 success, 1 a violation or difference on stderr, 2 when the task
//! cannot run):
//!
//! - `spec-lint [--root <engine dir>]`;
//! - `gen-layout [--check] [--root <engine dir>]`: `client/src/engine/wasm/layout.gen.ts`;
//! - `build-wasm [--probe] [--out DIR]`: the threaded engine (`xtask::wasm`); `--probe` the probe
//!   build's engine (plan #68 C2a1).

use std::path::PathBuf;
use std::process::ExitCode;

fn spec_lint(root: &std::path::Path) -> ExitCode {
    match xtask::metadata(root) {
        Ok(meta) => {
            let v = xtask::spec_lint(root, &meta);
            for line in &v {
                eprintln!("error[spec-lint] {line}");
            }
            if v.is_empty() {
                ExitCode::SUCCESS
            } else {
                ExitCode::from(1)
            }
        }
        Err(e) => {
            eprintln!("error[spec-lint] {e}");
            ExitCode::from(2)
        }
    }
}

fn gen_layout(root: &std::path::Path, check: bool) -> ExitCode {
    match xtask::layout::run(root, check) {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => {
            eprintln!(
                "error[gen-layout] {} differs from dash-protocol: run cargo xtask gen-layout",
                xtask::layout::path(root).display()
            );
            ExitCode::from(1)
        }
        Err(e) => {
            eprintln!("error[gen-layout] {e}");
            ExitCode::from(2)
        }
    }
}

fn build_wasm(root: &std::path::Path, out: Option<PathBuf>, probe: bool) -> ExitCode {
    let out = out.unwrap_or_else(|| xtask::wasm::default_out(root, probe));
    let target = std::env::var_os("CARGO_TARGET_DIR")
        .map_or_else(|| root.join("target"), PathBuf::from)
        .join(if probe { "wasm-mt-probe" } else { "wasm-mt" });
    match xtask::wasm::build(root, &out, &target, probe) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error[build-wasm] {e}");
            ExitCode::from(1)
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |name: &str| {
        args.iter()
            .position(|a| a == name)
            .and_then(|i| args.get(i + 1))
            .map(PathBuf::from)
    };
    let root =
        value("--root").unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(".."));
    match args.first().map(String::as_str) {
        Some("spec-lint") => spec_lint(&root),
        Some("gen-layout") => gen_layout(&root, args.iter().any(|a| a == "--check")),
        Some("build-wasm") => {
            build_wasm(&root, value("--out"), args.iter().any(|a| a == "--probe"))
        }
        _ => {
            eprintln!(
                "usage: cargo xtask spec-lint | gen-layout [--check] | build-wasm [--probe] [--out DIR] [--root <engine dir>]"
            );
            ExitCode::from(2)
        }
    }
}
