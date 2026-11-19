//! `ci migrations` (T11-013, T11-001; plan §3.8): squawk over every migration plus two
//! file-level rules squawk does not cover.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;

use regex::Regex;

use crate::report::{Rule, Violation};
use crate::shim::re;
use crate::{R, XtaskError, line_of};

/// Root-relative migrations directory of `dash-store`.
pub const MIGRATIONS_DIR: &str = "server/crates/dash-store/migrations";
/// Root-relative squawk configuration.
pub const SQUAWK_CONFIG: &str = ".squawk.toml";

static EXTENSION_RE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\bcreate\s+extension\b"));
static ATTACH_RE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\battach\s+partition\b"));
static VALIDATE_RE: LazyLock<Regex> = LazyLock::new(|| re(r"(?i)\bvalidate\s+constraint\b"));

/// `text` with every `--` comment blanked (offsets and lines kept).
fn strip_line_comments(text: &str) -> String {
    text.lines()
        .map(|l| match l.find("--") {
            Some(i) => format!("{}{}", &l[..i], " ".repeat(l.len() - i)),
            None => l.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `CREATE EXTENSION` outside `--` comments → `migration-extension`; `ATTACH PARTITION` without
/// `VALIDATE CONSTRAINT` in the same file → `migration-lint`.
pub fn lint_text(rel: &Path, text: &str) -> Vec<Violation> {
    let code = strip_line_comments(text);
    let mut out = Vec::new();
    for m in EXTENSION_RE.find_iter(&code) {
        out.push(Violation {
            rule: Rule::MigrationExtension,
            path: rel.to_path_buf(),
            line: Some(line_of(&code, m.start())),
            message:
                "CREATE EXTENSION in a migration; the schema must run without extensions (T11-001)"
                    .into(),
        });
    }
    if !VALIDATE_RE.is_match(&code) {
        for m in ATTACH_RE.find_iter(&code) {
            out.push(Violation {
                rule: Rule::MigrationLint,
                path: rel.to_path_buf(),
                line: Some(line_of(&code, m.start())),
                message: "ATTACH PARTITION without a pre-validated CHECK (VALIDATE CONSTRAINT) in the same migration (T11-013)".into(),
            });
        }
    }
    out
}

/// `target/tools/bin/squawk`.
pub fn squawk_bin(root: &Path) -> PathBuf {
    root.join(crate::tools::TOOLS_DIR).join("bin/squawk")
}

/// The migration files, sorted.
fn migration_files(root: &Path) -> R<Vec<PathBuf>> {
    Ok(crate::walk_files(&root.join(MIGRATIONS_DIR), &|_| false)?
        .into_iter()
        .filter(|p| p.extension().is_some_and(|e| e == "sql"))
        .collect())
}

/// Runs the gate: squawk (non-zero → `migration-lint`, its output echoed), then [`lint_text`].
pub fn check(root: &Path) -> R<Vec<Violation>> {
    let files = migration_files(root)?;
    let mut out = Vec::new();
    if files.is_empty() {
        return Ok(out);
    }
    let bin = squawk_bin(root);
    if !bin.is_file() {
        return Err(XtaskError::Tool {
            command: "squawk".into(),
            detail: "not installed; run `cargo xtask tools squawk`".into(),
        });
    }
    let rels: Vec<PathBuf> = files.iter().map(|f| crate::relative(root, f)).collect();
    let command = format!(
        "squawk --config {SQUAWK_CONFIG} <{} migrations>",
        rels.len()
    );
    println!("$ {command}");
    let result = Command::new(&bin)
        .arg("--config")
        .arg(SQUAWK_CONFIG)
        .args(&rels)
        .current_dir(root)
        .output()
        .map_err(|e| XtaskError::Tool {
            command: command.clone(),
            detail: e.to_string(),
        })?;
    print!("{}", String::from_utf8_lossy(&result.stdout));
    eprint!("{}", String::from_utf8_lossy(&result.stderr));
    if !result.status.success() {
        out.push(Violation {
            rule: Rule::MigrationLint,
            path: PathBuf::from(MIGRATIONS_DIR),
            line: None,
            message: "squawk rejected a migration (output above; T11-013)".into(),
        });
    }
    for (abs, rel) in files.iter().zip(&rels) {
        let text = std::fs::read_to_string(abs).map_err(XtaskError::io(abs))?;
        out.extend(lint_text(rel, &text));
    }
    Ok(out)
}
