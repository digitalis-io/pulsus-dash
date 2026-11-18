#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `ci:bundle-size` (T03 §7.3, PRF-009, PRF-033): plan §4.4.

mod common;

use std::fs;

use common::{noise, tree};
use xtask::bundle::{
    ArtefactBudget, ArtefactSize, ArtefactStatus, BundleConfig, BundleReport, Mode, brotli_len,
    load_config, measure, render_markdown,
};
use xtask::report::Rule;

fn art(name: &str, files: &[&str], budget: u64, eager: bool) -> ArtefactBudget {
    ArtefactBudget {
        name: name.into(),
        t03_row: name.into(),
        instances: None,
        files: files.iter().map(|s| s.to_string()).collect(),
        exclude: vec![],
        budget_bytes: budget,
        eager,
        required: false,
    }
}

fn config(mode: Mode, artefacts: Vec<ArtefactBudget>) -> BundleConfig {
    BundleConfig {
        mode,
        eager_total_bytes: 100_000_000,
        artefacts,
    }
}

#[test]
fn brotli_len_compresses() {
    let n = brotli_len(&[0u8; 1000]);
    assert!(n > 0 && n < 100, "{n}");
}

#[test]
fn bundle_under_budget_passes() {
    let t = tree(&[("a/a.bin", &[0u8; 1000])]);
    let r = measure(
        t.path(),
        &config(Mode::Enforce, vec![art("a", &["a/*"], 1000, true)]),
    )
    .unwrap();
    assert_eq!(r.artefacts.len(), 1);
    assert_eq!(r.artefacts[0].status, ArtefactStatus::Ok);
    assert!(r.violations.is_empty(), "{:?}", r.violations);
}

#[test]
fn bundle_enforce_over_budget_fails() {
    let t = tree(&[("a/a.bin", &noise(20_000))]);
    let r = measure(
        t.path(),
        &config(Mode::Enforce, vec![art("a", &["a/*"], 10_000, true)]),
    )
    .unwrap();
    assert_eq!(r.artefacts[0].status, ArtefactStatus::OverBudget);
    assert!(r.artefacts[0].brotli_bytes >= 19_000);
    assert_eq!(r.violations.len(), 1);
    assert_eq!(r.violations[0].rule, Rule::BundleOverBudget);
}

#[test]
fn bundle_report_mode_never_fails() {
    let t = tree(&[("a/a.bin", &noise(20_000))]);
    let mut absent = art("b", &["b/*"], 10_000, false);
    absent.required = true;
    let mut c = config(
        Mode::Report,
        vec![art("a", &["a/*"], 10_000, true), absent],
    );
    c.eager_total_bytes = 10_000;
    let r = measure(t.path(), &c).unwrap();
    assert!(r.violations.is_empty(), "{:?}", r.violations);
    assert_eq!(r.warnings.len(), 2, "{:?}", r.warnings);
    assert!(r.warnings.iter().all(|w| w.rule == Rule::BundleOverBudget));
    let statuses: Vec<&ArtefactStatus> = r.artefacts.iter().map(|a| &a.status).collect();
    assert_eq!(
        statuses,
        vec![&ArtefactStatus::OverBudget, &ArtefactStatus::Absent]
    );
}

#[test]
fn bundle_mode_transition() {
    let t = tree(&[("a/a.bin", &noise(20_000))]);
    let arts = vec![art("a", &["a/*"], 10_000, false)];
    let report = measure(t.path(), &config(Mode::Report, arts.clone())).unwrap();
    let enforce = measure(t.path(), &config(Mode::Enforce, arts)).unwrap();
    assert_eq!((report.violations.len(), report.warnings.len()), (0, 1));
    assert_eq!((enforce.violations.len(), enforce.warnings.len()), (1, 0));
    assert_eq!(report.artefacts, enforce.artefacts);
}

#[test]
fn bundle_required_absent_fails_when_enforced() {
    let t = tree(&[]);
    let mut req = art("req", &["x/*"], 10_000, false);
    req.required = true;
    let opt = art("opt", &["y/*"], 10_000, false);
    let r = measure(t.path(), &config(Mode::Enforce, vec![req, opt])).unwrap();
    assert_eq!(r.violations.len(), 1, "{:?}", r.violations);
    assert_eq!(r.violations[0].rule, Rule::BundleArtefactAbsent);
    assert!(r.violations[0].message.contains("req"));
}

#[test]
fn bundle_glue_counted_with_module() {
    let t = tree(&[
        ("web/shim/gen/m/m_bg.wasm", &[0u8; 1000]),
        ("web/shim/gen/m/m.js", &noise(20_000)),
    ]);
    let r = measure(
        t.path(),
        &config(
            Mode::Enforce,
            vec![art("m", &["web/shim/gen/m/**/*"], 10_000, true)],
        ),
    )
    .unwrap();
    assert_eq!(r.artefacts[0].status, ArtefactStatus::OverBudget);
    assert_eq!(r.artefacts[0].raw_bytes, 21_000);
}

#[test]
fn bundle_lazy_instances() {
    let t = tree(&[
        ("web/shim/gen/dash-wb-logs/x.wasm", &[0u8; 1000]),
        ("web/shim/gen/dash-wb-traces/x.wasm", &noise(20_000)),
    ]);
    let mut a = art("workbench-satellite", &["**/*"], 10_000, false);
    a.instances = Some("web/shim/gen/dash-wb-*".into());
    let r = measure(t.path(), &config(Mode::Enforce, vec![a])).unwrap();
    let rows: Vec<(&str, &ArtefactStatus)> = r
        .artefacts
        .iter()
        .map(|a| (a.name.as_str(), &a.status))
        .collect();
    assert_eq!(
        rows,
        vec![
            (
                "workbench-satellite [web/shim/gen/dash-wb-logs]",
                &ArtefactStatus::Ok
            ),
            (
                "workbench-satellite [web/shim/gen/dash-wb-traces]",
                &ArtefactStatus::OverBudget
            ),
        ]
    );
    assert_eq!(r.violations.len(), 1);
    assert_eq!(r.eager_total_brotli, 0);
}

#[test]
fn bundle_eager_total() {
    let t = tree(&[("a/a.bin", &noise(6_000)), ("b/b.bin", &noise(6_000))]);
    let mut c = config(
        Mode::Enforce,
        vec![
            art("a", &["a/*"], 10_000, true),
            art("b", &["b/*"], 10_000, true),
        ],
    );
    c.eager_total_bytes = 10_000;
    let r = measure(t.path(), &c).unwrap();
    assert!(r.artefacts.iter().all(|a| a.status == ArtefactStatus::Ok));
    assert_eq!(r.violations.len(), 1, "{:?}", r.violations);
    assert!(r.violations[0].message.starts_with("eager total"));
}

#[test]
fn bundle_glob_and_exclude() {
    let a = b"a();\n".as_slice();
    let b = b"bb();\n".as_slice();
    let t = tree(&[
        ("web/shim/a.js", a),
        ("web/shim/sub/b.js", b),
        ("web/shim/gen/g.js", b"generated();\n"),
    ]);
    let repo = load_config(&xtask::repo_root().unwrap()).unwrap();
    let shim = repo
        .artefacts
        .into_iter()
        .find(|a| a.name == "shim")
        .unwrap();
    let r = measure(t.path(), &config(Mode::Enforce, vec![shim])).unwrap();
    assert_eq!(r.artefacts[0].raw_bytes, (a.len() + b.len()) as u64);
}

#[test]
fn bundle_markdown() {
    let row = |name: &str, status| ArtefactSize {
        name: name.into(),
        raw_bytes: 10,
        brotli_bytes: 5,
        budget_bytes: 8,
        status,
    };
    let r = BundleReport {
        mode: Mode::Report,
        artefacts: vec![
            row("a", ArtefactStatus::Ok),
            row("b", ArtefactStatus::OverBudget),
            row("c", ArtefactStatus::Absent),
        ],
        eager_total_brotli: 5,
        eager_total_budget: 10,
        violations: vec![],
        warnings: vec![],
    };
    let md = render_markdown(&r);
    for want in [
        "mode: report",
        "| Artefact | Raw (bytes) | Brotli (bytes) | Budget (bytes) | Status |",
        "ok",
        "over budget",
        "absent",
        "Eager total",
    ] {
        assert!(md.contains(want), "missing {want:?} in\n{md}");
    }
}

/// `(first cell, budget KB)` of each row of T03 §7.3 except the eager total.
fn t03_budget_rows() -> Vec<(String, u64)> {
    let root = xtask::repo_root().unwrap();
    let doc = fs::read_to_string(root.join("designs/technical/T03-browser-runtime.md")).unwrap();
    let start = doc.find("### 7.3").unwrap();
    doc[start..]
        .lines()
        .skip_while(|l| !l.starts_with('|'))
        .take_while(|l| l.starts_with('|'))
        .skip(2)
        .map(|l| {
            let cells: Vec<&str> = l.trim_matches('|').split('|').map(str::trim).collect();
            (cells[0].to_string(), cells[1].to_string())
        })
        .filter(|(row, _)| row != "**Eager total**")
        .map(|(row, budget)| {
            let kb = budget.split("KB").next().unwrap();
            let digits: String = kb.chars().filter(char::is_ascii_digit).collect();
            (row, digits.parse().unwrap())
        })
        .collect()
}

#[test]
fn bundle_config_matches_t03() {
    let c = load_config(&xtask::repo_root().unwrap()).unwrap();
    let rows = t03_budget_rows();
    assert!(!rows.is_empty());
    for (row, kb) in &rows {
        let m: Vec<&ArtefactBudget> = c.artefacts.iter().filter(|a| &a.t03_row == row).collect();
        assert_eq!(m.len(), 1, "row {row}");
        assert_eq!(m[0].budget_bytes, kb * 1000, "row {row}");
    }
    assert_eq!(c.eager_total_bytes, 2_600_000);
    let mut eager: Vec<&str> = c
        .artefacts
        .iter()
        .filter(|a| a.eager)
        .map(|a| a.name.as_str())
        .collect();
    eager.sort_unstable();
    assert_eq!(eager, vec!["dash-core-mt", "dash-shell", "shim"]);
    assert!(c.artefacts.iter().all(|a| !a.required));
}

#[test]
fn bundle_repo_is_report_mode() {
    let c = load_config(&xtask::repo_root().unwrap()).unwrap();
    assert_eq!(c.mode, Mode::Report);
}
