//! `ci:design-check`: `designs/tools/check.py --write` on a copy of `designs/`, then a
//! traceability diff (plan §4.5). The working tree is never modified.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::report::{Rule, Violation};
use crate::{R, XtaskError, relative, walk_files};

/// Runs the design check against a temporary copy of `root/designs`.
pub fn check(root: &Path) -> R<Vec<Violation>> {
    let src = root.join("designs");
    if !src.is_dir() {
        return Err(XtaskError::Io {
            path: src,
            source: std::io::Error::new(std::io::ErrorKind::NotFound, "designs/ is missing"),
        });
    }
    let tmp = tempfile::tempdir().map_err(XtaskError::io(std::env::temp_dir()))?;
    let copy = tmp.path().join("designs");
    for file in walk_files(&src, &|_| false)? {
        let to = copy.join(relative(&src, &file));
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(XtaskError::io(parent))?;
        }
        std::fs::copy(&file, &to).map_err(XtaskError::io(&file))?;
    }
    let script = copy.join("tools/check.py");
    let command = "python3 -I designs/tools/check.py --write".to_string();
    let out = Command::new("python3")
        .arg("-I")
        .arg(&script)
        .arg("--write")
        .current_dir(tmp.path())
        .output()
        .map_err(|e| XtaskError::Tool {
            command: command.clone(),
            detail: e.to_string(),
        })?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    print!("{stdout}");
    let mut violations = Vec::new();
    if !out.status.success() {
        let errors: Vec<&str> = stdout.lines().filter(|l| l.starts_with("error:")).collect();
        let message = if errors.is_empty() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            format!("check.py exited with {}: {}", out.status, stderr.trim())
        } else {
            errors.join("; ")
        };
        violations.push(Violation {
            rule: Rule::DesignCheckFailed,
            path: PathBuf::from("designs"),
            line: None,
            message,
        });
    }
    let generated = std::fs::read(copy.join("traceability.md")).ok();
    let committed = std::fs::read(src.join("traceability.md")).ok();
    if generated.is_none() || generated != committed {
        violations.push(Violation {
            rule: Rule::TraceabilityStale,
            path: PathBuf::from("designs/traceability.md"),
            line: None,
            message: "run python3 -I designs/tools/check.py --write and commit".into(),
        });
    }
    Ok(violations)
}
