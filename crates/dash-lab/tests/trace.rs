#![allow(clippy::unwrap_used, clippy::expect_used)]
//! PRF-005 long-task detector (`dash-lab::trace`, plan §3.12).

use dash_lab::trace::{Task, TraceError, long_tasks};
use serde_json::{Value, json};

const MAIN: (u64, u64) = (10, 1);
const WORKER: (u64, u64) = (10, 2);

fn thread(t: (u64, u64), name: &str) -> Value {
    json!({"ph": "M", "name": "thread_name", "pid": t.0, "tid": t.1, "args": {"name": name}})
}

fn input(ts: u64, kind: &str) -> Value {
    json!({"ph": "X", "name": "EventDispatch", "cat": "devtools.timeline", "pid": MAIN.0,
        "tid": MAIN.1, "ts": ts, "dur": 100, "args": {"data": {"type": kind}}})
}

fn task(t: (u64, u64), ts: u64, dur: u64, tdur: Option<u64>) -> Value {
    let mut v = json!({"ph": "X", "name": "ThreadControllerImpl::RunTask", "cat": "toplevel",
        "pid": t.0, "tid": t.1, "ts": ts, "dur": dur});
    if let Some(td) = tdur {
        v["tdur"] = json!(td);
    }
    v
}

fn wrap(events: Vec<Value>) -> String {
    json!({ "traceEvents": events }).to_string()
}

/// Test 24's trace events.
fn events() -> Vec<Value> {
    vec![
        thread(MAIN, "CrRendererMain"),
        thread(WORKER, "DedicatedWorker thread"),
        input(1_000_000, "mousemove"),
        input(2_000_000, "mousemove"),
        task(MAIN, 1_100_000, 17_000, Some(17_000)),
        task(MAIN, 1_200_000, 60_000, Some(5_000)),
        task(MAIN, 1_210_000, 30_000, Some(4_000)),
        task(MAIN, 3_000_000, 90_000, None),
        task(WORKER, 1_500_000, 40_000, Some(40_000)),
    ]
}

#[test]
fn long_tasks_main_thread_window() {
    let json = wrap(events());
    let r = long_tasks(&json, 50_000, 16_000).unwrap();
    assert_eq!(r.first_input_us, 1_000_000);
    assert_eq!(r.last_input_us, 2_000_000);
    assert_eq!(r.tasks, 2);
    let ts = |v: &[Task]| v.iter().map(|t| t.ts_us).collect::<Vec<_>>();
    assert_eq!(ts(&r.over_wall), vec![1_200_000]);
    assert_eq!(ts(&r.over_cpu), vec![1_100_000]);
    assert_eq!(r.max_dur_us, 60_000);
    assert_eq!(r.max_tdur_us, 17_000);
    let lab = long_tasks(&json, 16_000, u64::MAX).unwrap();
    assert_eq!(ts(&lab.over_wall), vec![1_100_000, 1_200_000]);
    assert!(lab.over_cpu.is_empty());
    let bare = Value::Array(events()).to_string();
    assert_eq!(long_tasks(&bare, 50_000, 16_000).unwrap(), r);
}

#[test]
fn long_tasks_errors() {
    let no_names = wrap(vec![
        input(1_000_000, "mousemove"),
        task(MAIN, 1_000_000, 10, Some(10)),
    ]);
    assert_eq!(
        long_tasks(&no_names, 50_000, 16_000),
        Err(TraceError::NoMainThread)
    );

    let no_input = wrap(vec![
        thread(MAIN, "CrRendererMain"),
        task(MAIN, 1_000_000, 10, Some(10)),
    ]);
    assert_eq!(
        long_tasks(&no_input, 50_000, 16_000),
        Err(TraceError::NoInput)
    );

    let no_tasks = wrap(vec![
        thread(MAIN, "CrRendererMain"),
        thread(WORKER, "DedicatedWorker thread"),
        input(1_000_000, "pointermove"),
        input(2_000_000, "wheel"),
        task(MAIN, 5_000_000, 10, Some(10)),
        task(WORKER, 1_500_000, 10, Some(10)),
    ]);
    assert_eq!(
        long_tasks(&no_tasks, 50_000, 16_000),
        Err(TraceError::NoTasks)
    );
    assert_eq!(
        long_tasks(&no_tasks, 16_000, u64::MAX),
        Err(TraceError::NoTasks)
    );

    let no_tdur = wrap(vec![
        thread(MAIN, "CrRendererMain"),
        input(1_000_000, "mousemove"),
        input(2_000_000, "mousemove"),
        task(MAIN, 1_100_000, 17_000, Some(17_000)),
        task(MAIN, 1_200_000, 5_000, None),
    ]);
    assert_eq!(
        long_tasks(&no_tdur, 50_000, 16_000),
        Err(TraceError::NoThreadTime)
    );
    let ok = long_tasks(&no_tdur, 16_000, u64::MAX).unwrap();
    assert_eq!(ok.tasks, 2);

    assert!(matches!(
        long_tasks("{", 50_000, 16_000),
        Err(TraceError::Json(_))
    ));
}
