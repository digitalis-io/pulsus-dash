#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Frame summary and lab verdicts (T05-007, PRF-005): plan #24 test 45.

use dash_lab::frames::{FrameSummary, Machine, judge_frames, judge_long_tasks, summarize};
use serde_json::{Value, json};

fn summary(p50: f64, p99: f64) -> FrameSummary {
    FrameSummary {
        frames: 100,
        p50_ms: p50,
        p95_ms: p50,
        p99_ms: p99,
        max_ms: p99,
        over_50ms: 0,
    }
}

fn trace(tasks_us: &[u64]) -> String {
    let mut events: Vec<Value> = vec![
        json!({"ph": "M", "name": "thread_name", "pid": 1, "tid": 1, "args": {"name": "CrRendererMain"}}),
        json!({"ph": "X", "name": "EventDispatch", "pid": 1, "tid": 1, "ts": 1_000_000, "dur": 50, "args": {"data": {"type": "wheel"}}}),
        json!({"ph": "X", "name": "EventDispatch", "pid": 1, "tid": 1, "ts": 3_000_000, "dur": 50, "args": {"data": {"type": "mousemove"}}}),
    ];
    for (i, dur) in tasks_us.iter().enumerate() {
        events.push(json!({"ph": "X", "name": "RunTask", "pid": 1, "tid": 1, "ts": 1_100_000 + 100_000 * i as u64, "dur": dur, "tdur": dur}));
    }
    json!({ "traceEvents": events }).to_string()
}

#[test]
fn summarize_and_judge() {
    let samples: Vec<f64> = (1..=100).map(f64::from).collect();
    let s = summarize(&samples).unwrap();
    assert_eq!(s.frames, 100);
    assert_eq!(
        (s.p50_ms, s.p95_ms, s.p99_ms, s.max_ms),
        (50.0, 95.0, 99.0, 100.0)
    );
    assert_eq!(s.over_50ms, 50);
    assert_eq!(summarize(&[]), None);

    for m in [Machine::A, Machine::C] {
        assert!(judge_frames(&summary(16.7, 40.0), m).pass, "{m:?}");
        let v = judge_frames(&summary(16.8, 16.8), m);
        assert!(!v.pass, "{m:?}");
        assert!(v.failures.iter().any(|f| f.contains("median")), "{v:?}");
    }
    assert!(judge_frames(&summary(10.0, 22.2), Machine::B).pass);
    let v = judge_frames(&summary(10.0, 22.3), Machine::B);
    assert!(!v.pass);
    assert!(v.failures.iter().any(|f| f.contains("p99")), "{v:?}");

    let v = judge_long_tasks(&trace(&[17_000, 15_000])).unwrap();
    assert!(!v.pass);
    assert!(v.failures.iter().any(|f| f.contains("17000")), "{v:?}");
    assert!(judge_long_tasks(&trace(&[15_000])).unwrap().pass);
    assert!(judge_long_tasks("[]").is_err());
}
