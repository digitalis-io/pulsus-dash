//! PRF-005 long-task detector over a Chrome trace (T05 §4.3, plan §3.12).
//!
//! The main thread is the `CrRendererMain` thread with the most input `EventDispatch` events.
//! The interaction window runs from the first input event's start to the last one's end. Every
//! top-level `RunTask` on the main thread that overlaps the window is counted (tasks nested
//! inside a counted task are not), and judged on wall time (`dur`) and thread time (`tdur`).
//! The check fails closed: a trace it cannot judge is an error, never a pass.

use std::collections::BTreeMap;

use serde_json::Value;

/// One counted main-thread task.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Task {
    pub ts_us: u64,
    pub dur_us: u64,
    pub tdur_us: Option<u64>,
}

/// Result of [`long_tasks`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LongTaskReport {
    pub first_input_us: u64,
    pub last_input_us: u64,
    /// Top-level tasks counted in the window.
    pub tasks: usize,
    /// Tasks with `dur` over the wall limit.
    pub over_wall: Vec<Task>,
    /// Tasks with `tdur` over the thread-time limit.
    pub over_cpu: Vec<Task>,
    pub max_dur_us: u64,
    pub max_tdur_us: u64,
}

/// Why a trace cannot be judged (fail closed).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TraceError {
    /// Not JSON, or not a trace.
    Json(String),
    /// No `CrRendererMain` thread name.
    NoMainThread,
    /// No input `EventDispatch` on any renderer main thread.
    NoInput,
    /// No main-thread task overlaps the interaction window.
    NoTasks,
    /// A thread-time limit was given but a counted task has no `tdur`.
    NoThreadTime,
}

const INPUT_TYPES: [&str; 7] = [
    "mousemove",
    "mousedown",
    "mouseup",
    "pointermove",
    "pointerdown",
    "pointerup",
    "wheel",
];
const TASK_NAMES: [&str; 2] = ["RunTask", "ThreadControllerImpl::RunTask"];

type Thread = (u64, u64);

fn thread(e: &Value) -> Option<Thread> {
    Some((e.get("pid")?.as_u64()?, e.get("tid")?.as_u64()?))
}

/// A microsecond field (Chrome writes integers, sometimes floats).
fn us(e: &Value, key: &str) -> Option<u64> {
    let v = e.get(key)?;
    v.as_u64().or_else(|| v.as_f64().map(|f| f.max(0.0) as u64))
}

fn is_input(e: &Value) -> bool {
    e.get("name").and_then(Value::as_str) == Some("EventDispatch")
        && e.pointer("/args/data/type")
            .and_then(Value::as_str)
            .is_some_and(|t| INPUT_TYPES.contains(&t))
}

/// Main-thread tasks over the limits between the first and last input event. Use
/// `cpu_limit_us = u64::MAX` for wall-time only (the lab gate, PRF-005 as written).
pub fn long_tasks(
    trace_json: &str,
    wall_limit_us: u64,
    cpu_limit_us: u64,
) -> Result<LongTaskReport, TraceError> {
    let root: Value =
        serde_json::from_str(trace_json).map_err(|e| TraceError::Json(e.to_string()))?;
    let events = match &root {
        Value::Array(a) => a,
        Value::Object(o) => o
            .get("traceEvents")
            .and_then(Value::as_array)
            .ok_or_else(|| TraceError::Json("no traceEvents array".into()))?,
        _ => return Err(TraceError::Json("not a trace".into())),
    };

    let renderers: Vec<Thread> = events
        .iter()
        .filter(|e| {
            e.get("ph").and_then(Value::as_str) == Some("M")
                && e.get("name").and_then(Value::as_str) == Some("thread_name")
                && e.pointer("/args/name").and_then(Value::as_str) == Some("CrRendererMain")
        })
        .filter_map(thread)
        .collect();
    if renderers.is_empty() {
        return Err(TraceError::NoMainThread);
    }
    let mut inputs: BTreeMap<Thread, Vec<(u64, u64)>> = BTreeMap::new();
    for e in events.iter().filter(|e| is_input(e)) {
        if let (Some(t), Some(ts)) = (thread(e), us(e, "ts"))
            && renderers.contains(&t)
        {
            inputs
                .entry(t)
                .or_default()
                .push((ts, us(e, "dur").unwrap_or(0)));
        }
    }
    let Some((main, input)) = inputs.into_iter().max_by_key(|(_, v)| v.len()) else {
        return Err(TraceError::NoInput);
    };
    let first = input.iter().map(|(ts, _)| *ts).min().unwrap_or(0);
    let last = input.iter().map(|(ts, _)| *ts).max().unwrap_or(0);
    let window_end = input
        .iter()
        .map(|(ts, dur)| ts.saturating_add(*dur))
        .max()
        .unwrap_or(last);

    let mut candidates: Vec<Task> = events
        .iter()
        .filter(|e| {
            e.get("ph").and_then(Value::as_str) == Some("X")
                && e.get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|n| TASK_NAMES.contains(&n))
                && thread(e) == Some(main)
        })
        .filter_map(|e| {
            Some(Task {
                ts_us: us(e, "ts")?,
                dur_us: us(e, "dur").unwrap_or(0),
                tdur_us: us(e, "tdur"),
            })
        })
        .collect();
    candidates.sort_by_key(|t| (t.ts_us, std::cmp::Reverse(t.dur_us)));

    let mut counted: Vec<Task> = Vec::new();
    let mut outer_end = 0u64;
    for t in candidates {
        let end = t.ts_us.saturating_add(t.dur_us);
        if t.ts_us < outer_end {
            continue; // nested in an earlier top-level task
        }
        outer_end = end;
        if end >= first && t.ts_us <= window_end {
            counted.push(t);
        }
    }
    if counted.is_empty() {
        return Err(TraceError::NoTasks);
    }
    if cpu_limit_us != u64::MAX && counted.iter().any(|t| t.tdur_us.is_none()) {
        return Err(TraceError::NoThreadTime);
    }
    Ok(LongTaskReport {
        first_input_us: first,
        last_input_us: last,
        tasks: counted.len(),
        over_wall: counted
            .iter()
            .filter(|t| t.dur_us > wall_limit_us)
            .copied()
            .collect(),
        over_cpu: counted
            .iter()
            .filter(|t| t.tdur_us.is_some_and(|c| c > cpu_limit_us))
            .copied()
            .collect(),
        max_dur_us: counted.iter().map(|t| t.dur_us).max().unwrap_or(0),
        max_tdur_us: counted.iter().filter_map(|t| t.tdur_us).max().unwrap_or(0),
    })
}
