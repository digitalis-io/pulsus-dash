#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The `e2e` gate's PRF-005 trace check (plan §3.7, §3.12).

mod common;

use common::tree;
use serde_json::{Value, json};
use xtask::e2e::{check_bench, check_traces};
use xtask::report::Rule;

fn trace(main_task: (u64, u64, u64)) -> Vec<u8> {
    let (ts, dur, tdur) = main_task;
    let events: Vec<Value> = vec![
        json!({"ph": "M", "name": "thread_name", "pid": 1, "tid": 1, "args": {"name": "CrRendererMain"}}),
        json!({"ph": "X", "name": "EventDispatch", "pid": 1, "tid": 1, "ts": 1_000_000, "dur": 50, "args": {"data": {"type": "mousemove"}}}),
        json!({"ph": "X", "name": "EventDispatch", "pid": 1, "tid": 1, "ts": 2_000_000, "dur": 50, "args": {"data": {"type": "mousemove"}}}),
        json!({"ph": "X", "name": "RunTask", "pid": 1, "tid": 1, "ts": ts, "dur": dur, "tdur": tdur}),
    ];
    json!({ "traceEvents": events }).to_string().into_bytes()
}

#[test]
fn check_traces_cases() {
    let clean = trace((1_100_000, 3_000, 2_000));
    let slow = trace((1_500_000, 18_000, 17_000));
    let t = tree(&[
        ("long-tasks-webgpu.json", &clean),
        ("long-tasks-webgl2.json", &slow),
    ]);
    let v = check_traces(t.path()).unwrap();
    let got: Vec<(Rule, bool, bool)> = v
        .iter()
        .map(|v| {
            (
                v.rule,
                v.message.contains("webgl2"),
                v.message.contains("noiso"),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![
            (Rule::MainThreadLongTask, true, false),
            (Rule::LongTaskTraceMissing, false, true),
            (Rule::LongTaskTraceMissing, false, false),
        ],
        "{v:?}"
    );
}

fn report(intervals: usize) -> Vec<u8> {
    let iv: Vec<f64> = (0..intervals).map(|i| 16.0 + (i % 3) as f64).collect();
    json!({
        "scene": "line", "series": 1000, "points": 100000, "tier": 1, "decimation": "compute",
        "warmupMs": 5000, "loopMs": 20000, "loadMs": 12000, "intervalsMs": iv
    })
    .to_string()
    .into_bytes()
}

#[test]
fn bench_report_checks() {
    let none = tree(&[("other.json", b"{}")]);
    let v = check_bench(none.path()).unwrap();
    assert_eq!(
        v.iter().map(|v| v.rule).collect::<Vec<_>>(),
        vec![Rule::FrameReportMissing]
    );
    assert_eq!(Rule::FrameReportMissing.id(), "frame-report-missing");

    let short = tree(&[("frame-line-1e8.json", &report(5))]);
    let v = check_bench(short.path()).unwrap();
    assert_eq!(
        v.iter().map(|v| v.rule).collect::<Vec<_>>(),
        vec![Rule::FrameReportShort]
    );
    assert_eq!(Rule::FrameReportShort.id(), "frame-report-short");

    let ok = tree(&[("frame-line-1e8.json", &report(300))]);
    assert_eq!(check_bench(ok.path()).unwrap(), vec![]);

    let clean = trace((1_100_000, 3_000, 2_000));
    let t = tree(&[
        ("long-tasks-webgpu.json", &clean),
        ("long-tasks-webgl2.json", &clean),
        ("long-tasks-noiso.json", &clean),
    ]);
    let v = check_traces(t.path()).unwrap();
    assert_eq!(v.len(), 1, "{v:?}");
    assert_eq!(v[0].rule, Rule::LongTaskTraceMissing);
    assert!(v[0].message.contains("line-1e8"), "{v:?}");
}
