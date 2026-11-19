//! Lab agent. Design: T05 §4.6. #23 adds the PRF-005 long-task detector ([`trace`]); #24 adds the
//! frame-time summary and the lab verdicts of `bench:frame-line-1e8` ([`frames`], T05-007). The
//! agent itself is dependent work (the benchmark lab).

pub mod frames;
pub mod trace;
