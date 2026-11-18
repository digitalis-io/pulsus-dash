#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Gate-proof seeds (T05-002): plan §4.6.

mod common;

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use common::{tree, write};
use xtask::XtaskError;
use xtask::bundle::brotli_len;
use xtask::gates::Gate;
use xtask::seed::{SeedEntry, SeedManifest, SeedWrite, seed, seed_for, unseed};

const LIB: &str = "crates/dash-tokens/src/lib.rs";
const BUDGETS: &str = "ci/bundle-budgets.toml";

fn base_tree() -> tempfile::TempDir {
    tree(&[(LIB, b"//! x\n"), (BUDGETS, b"mode = \"report\"\n")])
}

fn read(root: &Path, rel: &str) -> String {
    fs::read_to_string(root.join(rel)).unwrap()
}

/// Every file outside `target/` (path → bytes).
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for e in fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            let rel = p.strip_prefix(root).unwrap().to_path_buf();
            if rel.starts_with("target") {
                continue;
            }
            if p.is_dir() {
                walk(root, &p, out);
            } else {
                out.insert(rel, fs::read(&p).unwrap());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

#[test]
fn seed_writes_exact_files() {
    let t = base_tree();
    let r = t.path();
    let build = seed(Gate::Build, r).unwrap();
    let shim = seed(Gate::ShimLint, r).unwrap();
    let size = seed(Gate::BundleSize, r).unwrap();
    assert_eq!(
        read(r, LIB),
        "//! x\n\ncompile_error!(\"seeded violation\");\n"
    );
    assert_eq!(read(r, "web/shim/seeded.js"), "eval(\"1\");\n");
    assert_eq!(read(r, BUDGETS), "mode = \"enforce\"\n");
    assert!(r.join("web/shim/seeded-size.js").is_file());
    assert_eq!(build, vec![PathBuf::from(LIB)]);
    assert_eq!(shim, vec![PathBuf::from("web/shim/seeded.js")]);
    assert_eq!(
        size,
        vec![
            PathBuf::from(BUDGETS),
            PathBuf::from("web/shim/seeded-size.js")
        ]
    );
    let m: SeedManifest = serde_json::from_str(&read(r, "target/xtask-seed/build.json")).unwrap();
    assert_eq!(m.gate, "build");
    assert!(m.entries.iter().any(|e| matches!(
        e,
        SeedEntry::Modified { path, original, .. } if path == LIB && original == "//! x\n"
    )));
}

#[test]
fn unseed_keeps_unrelated_files() {
    let t = base_tree();
    let r = t.path();
    write(r, "crates/dash-tokens/tests/mine.rs", b"// mine\n");
    write(r, "web/shim/notes.txt", b"notes\n");
    write(r, "designs/draft.md", b"# draft\n");
    let before = snapshot(r);
    for g in [Gate::Build, Gate::Clippy, Gate::BundleSize, Gate::ShimLint] {
        seed(g, r).unwrap();
        unseed(g, r).unwrap();
    }
    assert_eq!(snapshot(r), before);
    let left: Vec<_> = fs::read_dir(r.join("target/xtask-seed"))
        .map(|d| {
            d.map(|e| e.unwrap().path())
                .filter(|p| p.extension().is_some_and(|x| x == "json"))
                .collect()
        })
        .unwrap_or_default();
    assert!(left.is_empty(), "{left:?}");
}

#[test]
fn unseed_removes_only_empty_created_dirs() {
    let t = base_tree();
    let r = t.path();
    assert!(!r.join("crates/dash-tokens/tests").exists());
    seed(Gate::Fmt, r).unwrap();
    write(r, "crates/dash-tokens/tests/mine.rs", b"// mine\n");
    unseed(Gate::Fmt, r).unwrap();
    assert!(!r.join("crates/dash-tokens/tests/seeded_fmt.rs").exists());
    assert!(r.join("crates/dash-tokens/tests/mine.rs").is_file());
}

#[test]
fn unseed_refuses_changed_or_missing() {
    let t = base_tree();
    let r = t.path();
    seed(Gate::Build, r).unwrap();
    let mut f = fs::OpenOptions::new()
        .append(true)
        .open(r.join(LIB))
        .unwrap();
    f.write_all(b"//y\n").unwrap();
    drop(f);
    assert!(matches!(
        unseed(Gate::Build, r),
        Err(XtaskError::Config { .. })
    ));
    assert!(read(r, LIB).ends_with("//y\n"));
    assert!(r.join("target/xtask-seed/build.json").is_file());
    assert!(matches!(
        unseed(Gate::Test, r),
        Err(XtaskError::Config { .. })
    ));
    assert!(matches!(
        seed(Gate::Build, r),
        Err(XtaskError::Config { .. })
    ));
}

#[test]
fn seed_replace_requires_single_match() {
    let t = tree(&[(BUDGETS, b"# none\n")]);
    assert!(matches!(
        seed(Gate::BundleSize, t.path()),
        Err(XtaskError::Config { .. })
    ));
    assert!(!t.path().join("web/shim/seeded-size.js").exists());
}

#[test]
fn seed_noise_is_deterministic_and_oversized() {
    let a = tree(&[(BUDGETS, b"mode = \"report\"\n")]);
    let b = tree(&[(BUDGETS, b"mode = \"report\"\n")]);
    seed(Gate::BundleSize, a.path()).unwrap();
    seed(Gate::BundleSize, b.path()).unwrap();
    let x = fs::read(a.path().join("web/shim/seeded-size.js")).unwrap();
    let y = fs::read(b.path().join("web/shim/seeded-size.js")).unwrap();
    assert_eq!(x, y);
    assert_eq!(x.iter().filter(|&&c| c == b'\n').count(), 1);
    assert!(x.ends_with(b"\n"));
    assert!(brotli_len(&x) > 8_000);
}

#[test]
fn every_gate_has_a_committable_seed() {
    for g in Gate::ALL {
        let s = seed_for(g);
        assert_eq!(s.gate, g);
        assert!(!s.writes.is_empty(), "{g:?}");
        assert!(!s.expect.is_empty(), "{g:?}");
        for w in &s.writes {
            let path = match w {
                SeedWrite::Create { path, .. }
                | SeedWrite::Append { path, .. }
                | SeedWrite::Replace { path, .. }
                | SeedWrite::CreateNoise { path, .. } => *path,
            };
            for bad in ["target/", "xtask/", ".cargo/"] {
                assert!(!path.starts_with(bad), "{g:?}: {path}");
            }
            assert_ne!(path, "Cargo.toml", "{g:?}");
        }
    }
}
