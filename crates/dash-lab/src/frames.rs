//! Frame-time summary and lab verdicts (T05-007; plan #24 §3.6, §4.8): the
//! `bench:frame-line-1e8` intervals reduce to nearest-rank percentiles, judged against PRF-001
//! (median ≤ 16.7 ms) and PRF-002 (p99 ≤ 22.2 ms on machine B); the lab's interaction trace is
//! judged against PRF-005 (no main-thread task over 16 ms).

use crate::trace::{TraceError, long_tasks};

/// PRF-001: the median frame interval (60 fps).
pub const MEDIAN_LIMIT_MS: f64 = 16.7;
/// PRF-002: the p99 frame interval on machine B (45 fps).
pub const P99_LIMIT_MS: f64 = 22.2;
/// PRF-005: the longest main-thread task (µs).
pub const LONG_TASK_LIMIT_US: u64 = 16_000;
/// A frame over this is counted in `over_50ms`.
const LONG_FRAME_MS: f64 = 50.0;

/// Percentiles of frame intervals (nearest rank).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameSummary {
    pub frames: usize,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
    pub over_50ms: usize,
}

/// `None` for no samples; percentile p = `sorted[ceil(p·n) − 1]`. NaN samples are dropped.
pub fn summarize(samples_ms: &[f64]) -> Option<FrameSummary> {
    let mut s: Vec<f64> = samples_ms.iter().copied().filter(|v| !v.is_nan()).collect();
    if s.is_empty() {
        return None;
    }
    s.sort_by(f64::total_cmp);
    let n = s.len();
    let rank = |p: f64| s[((p * n as f64).ceil() as usize).clamp(1, n) - 1];
    Some(FrameSummary {
        frames: n,
        p50_ms: rank(0.50),
        p95_ms: rank(0.95),
        p99_ms: rank(0.99),
        max_ms: s[n - 1],
        over_50ms: s.iter().filter(|v| **v > LONG_FRAME_MS).count(),
    })
}

/// The reference machines of T05 §4.6.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Machine {
    A,
    B,
    C,
}

/// A gate verdict with the failed clauses.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub pass: bool,
    pub failures: Vec<String>,
}

impl Verdict {
    fn of(failures: Vec<String>) -> Verdict {
        Verdict {
            pass: failures.is_empty(),
            failures,
        }
    }
}

/// PRF-001/PRF-002 on machine `m`: median ≤ 16.7 ms on A, B and C; p99 ≤ 22.2 ms on B.
pub fn judge_frames(s: &FrameSummary, m: Machine) -> Verdict {
    let mut failures = Vec::new();
    if s.p50_ms > MEDIAN_LIMIT_MS {
        failures.push(format!(
            "{m:?}: median frame {:.2} ms > {MEDIAN_LIMIT_MS} ms (PRF-001)",
            s.p50_ms
        ));
    }
    if m == Machine::B && s.p99_ms > P99_LIMIT_MS {
        failures.push(format!(
            "{m:?}: p99 frame {:.2} ms > {P99_LIMIT_MS} ms (PRF-002)",
            s.p99_ms
        ));
    }
    Verdict::of(failures)
}

/// PRF-005 (lab): `long_tasks(json, 16 000, u64::MAX)`; passes iff no counted task is over the
/// wall limit. A trace that cannot be judged is an error.
pub fn judge_long_tasks(trace_json: &str) -> Result<Verdict, TraceError> {
    let r = long_tasks(trace_json, LONG_TASK_LIMIT_US, u64::MAX)?;
    Ok(Verdict::of(
        r.over_wall
            .iter()
            .map(|t| {
                format!(
                    "main-thread task at {} µs took {} µs > {LONG_TASK_LIMIT_US} µs (PRF-005)",
                    t.ts_us, t.dur_us
                )
            })
            .collect(),
    ))
}
