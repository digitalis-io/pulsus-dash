#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `ci:design-check`: plan §4.5.

mod common;

use std::fs;
use std::io::Write;

use common::{copy_dir, tree};
use xtask::design::check;
use xtask::report::Rule;

/// A temp root holding a copy of the repository's `designs/`.
fn designs_copy() -> tempfile::TempDir {
    let t = tree(&[]);
    copy_dir(
        &xtask::repo_root().unwrap().join("designs"),
        &t.path().join("designs"),
    );
    t
}

fn append(path: &std::path::Path, text: &str) {
    let mut f = fs::OpenOptions::new().append(true).open(path).unwrap();
    f.write_all(text.as_bytes()).unwrap();
}

#[test]
fn design_check_passes_on_repo() {
    let root = xtask::repo_root().unwrap();
    let before = fs::read(root.join("designs/traceability.md")).unwrap();
    assert_eq!(check(&root).unwrap(), vec![]);
    let after = fs::read(root.join("designs/traceability.md")).unwrap();
    assert_eq!(before, after);
}

#[test]
fn design_check_broken_link() {
    let t = designs_copy();
    append(
        &t.path()
            .join("designs/technical/T01-frontend-architecture.md"),
        "\nSeeded violation: [missing](seeded-missing.md).\n",
    );
    let v = check(t.path()).unwrap();
    assert_eq!(v.len(), 1, "{v:?}");
    assert_eq!(v[0].rule, Rule::DesignCheckFailed);
    assert!(
        v[0].message.contains("seeded-missing.md"),
        "{}",
        v[0].message
    );
}

#[test]
fn design_check_stale_traceability() {
    let t = designs_copy();
    append(&t.path().join("designs/traceability.md"), "| X |\n");
    let v = check(t.path()).unwrap();
    assert_eq!(v.len(), 1, "{v:?}");
    assert_eq!(v[0].rule, Rule::TraceabilityStale);
}
