#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Gate registry (T05-001), workflow wiring, report format and design text: plan §3.4–§3.6, §7.

use std::fs;
use std::path::PathBuf;

use xtask::gates::Gate;
use xtask::report::{Level, Rule, Violation};

fn read(rel: &str) -> String {
    fs::read_to_string(xtask::repo_root().unwrap().join(rel)).unwrap()
}

/// `(id, t05, owner, job)` rows of `ci/gates.toml`.
fn registry() -> Vec<(String, String, String, String)> {
    let t: toml::Table = read("ci/gates.toml").parse().unwrap();
    t["gate"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| {
            let s = |k: &str| g[k].as_str().unwrap().to_string();
            (s("id"), s("t05"), s("owner"), s("job"))
        })
        .collect()
}

#[test]
fn gate_ids_round_trip() {
    let ids: Vec<&str> = Gate::ALL.iter().map(|g| g.id()).collect();
    assert_eq!(
        ids,
        vec![
            "fmt",
            "build",
            "clippy",
            "test",
            "wasm",
            "bundle-size",
            "design-check",
            "shim-lint",
            "dep-audit"
        ]
    );
    for g in Gate::ALL {
        assert_eq!(Gate::parse(g.id()), Some(g));
    }
}

#[test]
fn gates_registry_complete() {
    let reg = registry();
    let ids: Vec<&str> = reg.iter().map(|r| r.0.as_str()).collect();
    let want: Vec<&str> = Gate::ALL.iter().map(|g| g.id()).collect();
    assert_eq!(ids, want);
    let jobs = [
        ("fmt", "rust"),
        ("build", "rust"),
        ("clippy", "rust"),
        ("test", "rust"),
        ("wasm", "wasm"),
        ("bundle-size", "wasm"),
        ("dep-audit", "wasm"),
        ("design-check", "static"),
        ("shim-lint", "static"),
    ];
    let t05 = read("designs/technical/T05-testing-and-performance.md");
    let start = t05.find("### 7.1").unwrap();
    let end = start + t05[start..].find("\n## 8.").unwrap();
    let section = &t05[start..end];
    for (id, gate_t05, owner, job) in &reg {
        assert!(owner.starts_with("area:"), "{id}: {owner}");
        let want_job = jobs.iter().find(|(g, _)| g == id).unwrap().1;
        assert_eq!(job, want_job, "{id}");
        if !gate_t05.is_empty() {
            assert!(section.contains(gate_t05.as_str()), "{id}: {gate_t05}");
        }
    }
}

/// Job blocks of the workflow: `(job id, lines)`.
fn job_blocks(wf: &str) -> Vec<(String, Vec<String>)> {
    let mut blocks: Vec<(String, Vec<String>)> = Vec::new();
    let mut in_jobs = false;
    for line in wf.lines() {
        if line == "jobs:" {
            in_jobs = true;
            continue;
        }
        if !in_jobs {
            continue;
        }
        let is_job = line.len() > 3
            && line.starts_with("  ")
            && !line.starts_with("   ")
            && line.ends_with(':')
            && line[2..line.len() - 1]
                .chars()
                .all(|c| c.is_ascii_lowercase() || c == '-');
        if is_job {
            blocks.push((line[2..line.len() - 1].to_string(), Vec::new()));
        } else if let Some(b) = blocks.last_mut() {
            b.1.push(line.to_string());
        }
    }
    blocks
}

#[test]
fn ci_workflow_runs_every_gate() {
    let wf = read(".github/workflows/ci.yml");
    let blocks = job_blocks(&wf);
    for (id, _, _, job) in registry() {
        let block = &blocks.iter().find(|b| b.0 == job).unwrap().1;
        let text = block.join("\n");
        assert!(text.contains(&format!("name: ci {id},")), "{job}: {id}");
        assert!(
            text.contains(&format!("run: cargo xtask ci {id} }}")),
            "{job}: {id}"
        );
    }
    let st = &blocks.iter().find(|b| b.0 == "static").unwrap().1;
    let last = st.iter().rev().find(|l| !l.trim().is_empty()).unwrap();
    assert_eq!(
        last,
        "      - { name: design check.py, if: \"!cancelled()\", run: python3 -I designs/tools/check.py }"
    );
    let lines: Vec<&str> = wf.lines().collect();
    let pr = lines
        .iter()
        .position(|l| l.trim_start().starts_with("pull_request:"))
        .unwrap();
    let indent = lines[pr].len() - lines[pr].trim_start().len();
    for l in &lines[pr + 1..] {
        let li = l.len() - l.trim_start().len();
        if l.trim().is_empty() || li <= indent {
            break;
        }
        assert!(!l.trim_start().starts_with("branches"), "{l}");
    }
}

#[test]
fn violation_display_and_annotation() {
    let v = Violation {
        rule: Rule::ShimImport,
        path: PathBuf::from("web/shim/a.js"),
        line: Some(3),
        message: "bare specifier".into(),
    };
    assert_eq!(
        v.to_string(),
        "error[shim-import] web/shim/a.js:3: bare specifier"
    );
    assert_eq!(
        v.annotation(Level::Error),
        "::error file=web/shim/a.js,line=3::shim-import: bare specifier"
    );
    assert_eq!(
        v.annotation(Level::Warning),
        "::warning file=web/shim/a.js,line=3::shim-import: bare specifier"
    );
}

/// The table row of `gate` in T05 §7.1.
fn t05_row(gate: &str) -> String {
    let doc = read("designs/technical/T05-testing-and-performance.md");
    let prefix = format!("| `{gate}` |");
    doc.lines()
        .find(|l| l.starts_with(&prefix))
        .unwrap()
        .to_string()
}

#[test]
fn design_text_states_interim_gates() {
    let bundle = t05_row("ci:bundle-size");
    for want in [
        "mode = report",
        "mode = enforce",
        "dash-core-mt/",
        "adds per-crate (`twiggy`)",
    ] {
        assert!(bundle.contains(want), "missing {want:?}: {bundle}");
    }
    assert!(bundle.ends_with("| PR | once enforced |"), "{bundle}");
    assert!(!bundle.contains("and per crate"), "{bundle}");
    let shim = t05_row("ci:shim-lint");
    assert!(
        shim.contains("Interim") && shim.contains("T03-005"),
        "{shim}"
    );
    let t03 = read("designs/technical/T03-browser-runtime.md");
    let s = t03.find("### 7.3").unwrap();
    let e = s + t03[s..].find("\n## 8.").unwrap();
    assert!(!t03[s..e].contains("enforced per PR"));
}

#[test]
fn docs_name_the_build_commands() {
    let doc = read("docs/development/build-and-ci.md");
    for want in [
        "cargo build --workspace --locked",
        "cargo build-wasm",
        "cargo xtask ci all",
        "cargo xtask seed",
        "cargo xtask unseed",
    ] {
        assert!(doc.contains(want), "missing {want:?}");
    }
}
