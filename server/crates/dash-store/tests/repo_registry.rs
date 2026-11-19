#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Every public repository function is registered in `itest_rls::REPO_FNS` (T11 §10), so the
//! wrong-org itest covers it.

use std::path::Path;

fn pub_async_fns(file: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(file).unwrap();
    text.lines()
        .filter_map(|l| l.trim_start().strip_prefix("pub async fn "))
        .map(|rest| rest.split(['(', '<']).next().unwrap().trim().to_string())
        .collect()
}

/// The string literals of `pub const REPO_FNS` in `tests/itest_rls.rs`.
fn registered(crate_dir: &Path) -> Vec<String> {
    let text = std::fs::read_to_string(crate_dir.join("tests/itest_rls.rs")).unwrap();
    let start = text.find("pub const REPO_FNS").unwrap();
    let end = start + text[start..].find("];").unwrap();
    text[start..end]
        .split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_string)
        .collect()
}

#[test]
fn repo_fns_all_registered() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let reg = registered(dir);
    let mut files: Vec<_> = std::fs::read_dir(dir.join("src/repo"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|e| e == "rs"))
        .collect();
    files.push(dir.join("src/bootstrap.rs"));
    files.sort();
    let mut found = Vec::new();
    for f in &files {
        let module = f.file_stem().unwrap().to_string_lossy().to_string();
        for name in pub_async_fns(f) {
            found.push(format!("{module}::{name}"));
        }
    }
    assert!(found.len() >= 7, "{found:?}");
    for f in &found {
        assert!(reg.contains(f), "{f} is not in itest_rls::REPO_FNS");
    }
}
