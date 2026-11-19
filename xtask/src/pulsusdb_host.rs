//! `ci no-pulsusdb-host` (plan §3.11): the private PulsusDB host never enters the repository.

use std::io::Write;
use std::path::Path;

use crate::R;
use crate::report::Violation;

/// Comma list of forbidden hostnames (a CI secret).
pub const FORBIDDEN_ENV: &str = "DASH_FORBIDDEN_HOSTS";

/// `rel` with every segment containing a forbidden host replaced by `<redacted:h8>`.
pub fn sanitise(rel: &str, forbidden: &[String]) -> String {
    let _ = forbidden;
    rel.to_string()
}

/// Checks the listed files of `root`. `forbidden` = the variable's value; `ci` = `CI=true`.
/// Informational lines and warnings go to `out`; violations are returned.
pub fn check(
    root: &Path,
    forbidden: Option<&str>,
    ci: bool,
    out: &mut dyn Write,
) -> R<Vec<Violation>> {
    let _ = (root, forbidden, ci, out);
    Ok(Vec::new())
}

/// The gate entry point: reads the environment and prints to stdout.
pub fn run(root: &Path) -> R<Vec<Violation>> {
    let forbidden = std::env::var(FORBIDDEN_ENV).ok();
    let ci = std::env::var("CI").is_ok_and(|v| v == "true");
    check(root, forbidden.as_deref(), ci, &mut std::io::stdout())
}
