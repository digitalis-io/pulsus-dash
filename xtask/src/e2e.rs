//! `ci e2e`: the Playwright mode matrix (e2e:mode-matrix) and the PRF-005 trace check
//! (plan §3.7, §3.12; T05 §4.3), the PRF-008 startup report and the `dev up` flow (#39 plan
//! §4.6).

use std::path::Path;
use std::process::Command;

use crate::r#gen::{GenOptions, generate};
use crate::probe::probe_expected;
use crate::report::{Rule, Violation};
use crate::{R, XtaskError};

/// Projects whose interaction trace is checked.
pub const TRACE_PROJECTS: [&str; 3] = ["webgpu", "webgl2", "noiso"];
/// CI limits (owner decision on PRF-005 until the reference lab exists): wall and thread time.
pub const CI_WALL_LIMIT_US: u64 = 50_000;
pub const CI_CPU_LIMIT_US: u64 = 16_000;

/// Per project: no `long-tasks-<p>.json` → `long-task-trace-missing`; an undecidable trace →
/// `XtaskError::Tool`; each main-thread task over a limit → `main-thread-long-task`.
pub fn check_traces(dir: &Path) -> R<Vec<Violation>> {
    let mut out = Vec::new();
    for p in TRACE_PROJECTS {
        let file = dir.join(format!("long-tasks-{p}.json"));
        let Ok(text) = std::fs::read_to_string(&file) else {
            out.push(Violation {
                rule: Rule::LongTaskTraceMissing,
                path: file,
                line: None,
                message: format!("{p}: no interaction trace"),
            });
            continue;
        };
        let r =
            dash_lab::trace::long_tasks(&text, CI_WALL_LIMIT_US, CI_CPU_LIMIT_US).map_err(|e| {
                XtaskError::Tool {
                    command: format!("long_tasks {}", file.display()),
                    detail: format!("{e:?}"),
                }
            })?;
        let mut over: Vec<_> = r.over_wall.iter().chain(&r.over_cpu).copied().collect();
        over.sort_by_key(|t| t.ts_us);
        over.dedup();
        println!(
            "{p}: {} main-thread tasks in the interaction window; max wall {} µs, max thread {} µs",
            r.tasks, r.max_dur_us, r.max_tdur_us
        );
        for t in over {
            out.push(Violation {
                rule: Rule::MainThreadLongTask,
                path: file.clone(),
                line: None,
                message: format!(
                    "{p}: ts {} dur {} tdur {} (limits: wall {CI_WALL_LIMIT_US} µs, thread {CI_CPU_LIMIT_US} µs)",
                    t.ts_us,
                    t.dur_us,
                    t.tdur_us.map_or("-".to_string(), |v| v.to_string())
                ),
            });
        }
    }
    Ok(out)
}

/// PRF-008 budget the startup report is printed against (report only, T05-006).
pub const STARTUP_BUDGET_MS: u64 = 1000;

/// The startup report (`startup-<project>.json`: `{"runs_ms":[…],"p75_ms":n}`) as Markdown.
/// Never a violation: the blocking gate is `bench:startup` on the reference lab.
pub fn startup_report(dir: &Path) -> String {
    let mut rows = Vec::new();
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .map(|d| d.filter_map(Result::ok).map(|e| e.path()).collect())
        .unwrap_or_default();
    files.sort();
    for f in files {
        let name = f
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let Some(project) = name
            .strip_prefix("startup-")
            .and_then(|n| n.strip_suffix(".json"))
        else {
            continue;
        };
        let parsed = std::fs::read_to_string(&f)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok());
        let row = match parsed {
            Some(v) => {
                let p75 = v["p75_ms"].as_u64().unwrap_or(0);
                let runs: Vec<String> = v["runs_ms"]
                    .as_array()
                    .map(|a| a.iter().map(|x| x.to_string()).collect())
                    .unwrap_or_default();
                let note = if p75 <= STARTUP_BUDGET_MS {
                    "within"
                } else {
                    "over (report only)"
                };
                format!("| {project} | {p75} | {} | {note} |", runs.join(", "))
            }
            None => format!("| {project} | — | unreadable | — |"),
        };
        rows.push(row);
    }
    if rows.is_empty() {
        return "PRF-008 startup: no startup-<project>.json report\n".into();
    }
    format!(
        "### PRF-008 startup to T1/T2 (report only; budget {STARTUP_BUDGET_MS} ms p75, blocking on bench:startup)\n\n| project | p75 ms | runs ms | budget |\n|---|---|---|---|\n{}\n",
        rows.join("\n")
    )
}

/// Runs the gate: (1) the probe-enabled test build; (2) the probe marker check; (3) Playwright
/// in `e2e/`; (4) always the trace check; (5) the startup report; (6) the `dev up` flow test.
/// Returns (violations, Playwright and the flow test passed).
pub fn run(root: &Path) -> R<(Vec<Violation>, bool)> {
    let o = GenOptions::test(root);
    generate(root, &o)?;
    let mut v = probe_expected(&o.web_root)?;
    let results = root.join("e2e/test-results");
    match std::fs::remove_dir_all(&results) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(XtaskError::Io {
                path: results,
                source: e,
            });
        }
    }
    println!("$ npx playwright test (in e2e/)");
    let status = Command::new("npx")
        .args(["playwright", "test"])
        .current_dir(root.join("e2e"))
        .status()
        .map_err(|e| XtaskError::Tool {
            command: "npx playwright test".into(),
            detail: e.to_string(),
        })?;
    v.extend(check_traces(&results.join("traces"))?);
    for x in &mut v {
        x.path = crate::relative(root, &x.path);
    }
    let report = startup_report(&results.join("traces"));
    print!("{report}");
    if let Ok(summary) = std::env::var("GITHUB_STEP_SUMMARY") {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&summary)
            .map_err(XtaskError::io(&summary))?;
        writeln!(f, "{report}").map_err(XtaskError::io(&summary))?;
    }
    println!("$ cargo test --locked -p xtask --test dev_up_flow -- --ignored");
    let flow = Command::new("cargo")
        .args([
            "test",
            "--locked",
            "-p",
            "xtask",
            "--test",
            "dev_up_flow",
            "--",
            "--ignored",
        ])
        .current_dir(root)
        .status()
        .map_err(|e| XtaskError::Tool {
            command: "cargo test -p xtask --test dev_up_flow".into(),
            detail: e.to_string(),
        })?;
    Ok((v, status.success() && flow.success()))
}
