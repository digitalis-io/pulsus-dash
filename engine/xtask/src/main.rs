//! Workspace tasks. `spec-lint [--root <engine dir>]`: exit 0 when the workspace conforms, 1 with
//! each violation on stderr, 2 when it cannot be checked.

use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = match args.iter().position(|a| a == "--root") {
        Some(i) => args.get(i + 1).map(PathBuf::from),
        None => Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")),
    };
    match (args.first().map(String::as_str), root) {
        (Some("spec-lint"), Some(root)) => match xtask::metadata(&root) {
            Ok(meta) => {
                let v = xtask::spec_lint(&root, &meta);
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
        },
        _ => {
            eprintln!("usage: cargo xtask spec-lint [--root <engine dir>]");
            ExitCode::from(2)
        }
    }
}
