//! `ci e2e`: the Playwright mode matrix and the PRF-005 trace check (plan §3.7). Stub.

use std::path::Path;

use crate::R;
use crate::report::Violation;

pub const TRACE_PROJECTS: [&str; 3] = ["webgpu", "webgl2", "noiso"];
pub const CI_WALL_LIMIT_US: u64 = 50_000;
pub const CI_CPU_LIMIT_US: u64 = 16_000;

pub fn check_traces(_dir: &Path) -> R<Vec<Violation>> {
    Ok(Vec::new())
}
