#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The `e2e` gate's PRF-005 trace check (plan §3.7, §3.12).

mod common;

use common::tree;
use serde_json::{Value, json};
use xtask::e2e::check_traces;
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
        ],
        "{v:?}"
    );
}
