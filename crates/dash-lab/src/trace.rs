//! PRF-005 long-task detector over a Chrome trace (T05 §4.3). Stub.

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
    pub tasks: usize,
    pub over_wall: Vec<Task>,
    pub over_cpu: Vec<Task>,
    pub max_dur_us: u64,
    pub max_tdur_us: u64,
}

/// Why a trace cannot be judged (fail closed).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TraceError {
    Json(String),
    NoMainThread,
    NoInput,
    NoTasks,
    NoThreadTime,
}

/// Main-thread tasks over the limits between the first and last input event.
pub fn long_tasks(
    _trace_json: &str,
    _wall_limit_us: u64,
    _cpu_limit_us: u64,
) -> Result<LongTaskReport, TraceError> {
    Err(TraceError::NoTasks)
}
