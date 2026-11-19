//! `ci e2e`: the Playwright mode matrix (e2e:mode-matrix) and the PRF-005 trace check
//! (plan §3.7, §3.12; T05 §4.3).

use std::path::Path;
use std::process::Command;

use crate::r#gen::{GenOptions, generate};
use crate::probe::probe_expected;
use crate::report::{Rule, Violation};
use crate::{R, XtaskError};

/// Projects whose interaction trace is checked; `line-1e8` is the bench's pan/zoom loop (#24).
pub const TRACE_PROJECTS: [&str; 4] = ["webgpu", "webgl2", "noiso", "line-1e8"];
/// The bench report of `bench:frame-line-1e8` (plan #24 §4.8).
pub const BENCH_REPORT: &str = "frame-line-1e8.json";
/// Fewer intervals than this cannot be summarised.
pub const BENCH_MIN_INTERVALS: usize = 10;
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

/// The `bench:frame-line-1e8` report (plan #24 §4.8): no `frame-line-1e8.json` →
/// `frame-report-missing`; fewer than 10 intervals → `frame-report-short`; else the summary and
/// the machine-B verdict are printed (report only until the reference lab exists).
pub fn check_bench(dir: &Path) -> R<Vec<Violation>> {
    let file = dir.join(BENCH_REPORT);
    let Ok(text) = std::fs::read_to_string(&file) else {
        return Ok(vec![Violation {
            rule: Rule::FrameReportMissing,
            path: file,
            line: None,
            message: "bench:frame-line-1e8: no frame report".into(),
        }]);
    };
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| XtaskError::Tool {
        command: format!("read {}", file.display()),
        detail: e.to_string(),
    })?;
    let intervals: Vec<f64> = json
        .get("intervalsMs")
        .and_then(serde_json::Value::as_array)
        .map(|a| a.iter().filter_map(serde_json::Value::as_f64).collect())
        .unwrap_or_default();
    if intervals.len() < BENCH_MIN_INTERVALS {
        return Ok(vec![Violation {
            rule: Rule::FrameReportShort,
            path: file,
            line: None,
            message: format!(
                "bench:frame-line-1e8: {} frame intervals (< {BENCH_MIN_INTERVALS})",
                intervals.len()
            ),
        }]);
    }
    if let Some(s) = dash_lab::frames::summarize(&intervals) {
        let v = dash_lab::frames::judge_frames(&s, dash_lab::frames::Machine::B);
        println!(
            "bench:frame-line-1e8 (report only until the reference lab exists): {} frames, p50 {:.2} ms, p95 {:.2} ms, p99 {:.2} ms, max {:.2} ms, {} over 50 ms; machine-B verdict: {}",
            s.frames,
            s.p50_ms,
            s.p95_ms,
            s.p99_ms,
            s.max_ms,
            s.over_50ms,
            if v.pass {
                "pass".to_string()
            } else {
                v.failures.join("; ")
            }
        );
    }
    Ok(Vec::new())
}

/// Runs the gate: (1) the probe-enabled test build; (2) the probe marker check; (3) Playwright
/// in `e2e/`; (4) always the trace check, then the bench report check. Returns (violations, Playwright passed).
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
    v.extend(check_bench(&results.join("traces"))?);
    for x in &mut v {
        x.path = crate::relative(root, &x.path);
    }
    Ok((v, status.success()))
}
