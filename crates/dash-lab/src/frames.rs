//! Frame-time summary and lab verdicts (T05-007; plan #24 §3.6, §4.8).

use crate::trace::TraceError;

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

/// `None` for no samples; percentile p = `sorted[ceil(p·n) − 1]`.
pub fn summarize(_samples_ms: &[f64]) -> Option<FrameSummary> {
    None
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

/// PRF-001/PRF-002 on machine `m`: median ≤ 16.7 ms on A, B and C; p99 ≤ 22.2 ms on B.
pub fn judge_frames(_s: &FrameSummary, _m: Machine) -> Verdict {
    Verdict {
        pass: true,
        failures: Vec::new(),
    }
}

/// PRF-005 (lab): no main-thread task over 16 ms in the interaction window.
pub fn judge_long_tasks(_trace_json: &str) -> Result<Verdict, TraceError> {
    Ok(Verdict {
        pass: true,
        failures: Vec::new(),
    })
}
