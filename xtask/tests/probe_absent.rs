#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `ci:probe-absent` scans a fresh release build; `e2e` checks the marker is found (T03-024).

mod common;

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use common::{tree, write};
use xtask::R;
use xtask::r#gen::GenOptions;
use xtask::probe::{REQUIRED, probe_absent_with, probe_expected};
use xtask::report::Rule;

const MARKER: &[u8] = b"__dashProbe";

fn writes(web_root: &Path, marked: &[&str]) {
    for rel in REQUIRED {
        let mut bytes = b"\0asm clean bytes ".to_vec();
        if marked.contains(&rel) {
            bytes.extend_from_slice(MARKER);
        }
        write(web_root, rel, &bytes);
    }
}

#[test]
fn probe_absent_builds_fresh() {
    let t = tree(&[(
        "target/gen-check/shim/gen/dash-core-mt/stale.js",
        b"self.__dashProbe = {};\n",
    )]);
    let calls: RefCell<Vec<GenOptions>> = RefCell::new(Vec::new());
    let fake = |_: &Path, o: &GenOptions| -> R<()> {
        calls.borrow_mut().push(o.clone());
        writes(&o.web_root, &[]);
        Ok(())
    };
    let v = probe_absent_with(t.path(), &fake).unwrap();
    assert!(v.is_empty(), "{v:?}");
    assert!(
        !t.path()
            .join("target/gen-check/shim/gen/dash-core-mt/stale.js")
            .exists()
    );
    let calls = calls.into_inner();
    assert_eq!(calls, vec![GenOptions::check(t.path())]);
    assert!(!calls[0].probe);
}

#[test]
fn probe_absent_missing_and_present() {
    let t = tree(&[]);
    let nothing = |_: &Path, _: &GenOptions| -> R<()> { Ok(()) };
    let v = probe_absent_with(t.path(), &nothing).unwrap();
    assert_eq!(v.len(), 4, "{v:?}");
    assert!(v.iter().all(|v| v.rule == Rule::ProbeArtefactMissing));

    let marked = |_: &Path, o: &GenOptions| -> R<()> {
        writes(&o.web_root, &["shim/gen/dash-core-mt/dash_core_mt_bg.wasm"]);
        Ok(())
    };
    let v = probe_absent_with(t.path(), &marked).unwrap();
    let got: Vec<(Rule, PathBuf)> = v.iter().map(|v| (v.rule, v.path.clone())).collect();
    assert_eq!(
        got,
        vec![(
            Rule::ProbePresent,
            PathBuf::from("target/gen-check/shim/gen/dash-core-mt/dash_core_mt_bg.wasm")
        )]
    );
}

#[test]
fn probe_expected_in_test_build() {
    let t = tree(&[]);
    writes(
        t.path(),
        &[
            "shim/gen/dash-core-mt/dash_core_mt_bg.wasm",
            "shim/gen/dash-core-st/dash_core_st_bg.wasm",
        ],
    );
    assert!(probe_expected(t.path()).unwrap().is_empty());

    let t = tree(&[]);
    writes(t.path(), &["shim/gen/dash-core-mt/dash_core_mt_bg.wasm"]);
    let v = probe_expected(t.path()).unwrap();
    assert_eq!(v.len(), 1, "{v:?}");
    assert_eq!(v[0].rule, Rule::ProbeMarkerUndetected);
    assert!(
        v[0].path
            .ends_with("shim/gen/dash-core-st/dash_core_st_bg.wasm"),
        "{:?}",
        v[0].path
    );
}
