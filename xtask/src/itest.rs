//! `cargo xtask ci itest` (plan §4.5): the RLS and migration itests on the compose stack.

use std::path::Path;

use crate::report::Violation;
use crate::{R, XtaskError};

/// Runs the gate; returns (violations, every step passed).
pub fn run(root: &Path) -> R<(Vec<Violation>, bool)> {
    let _ = root;
    Err(XtaskError::Usage("itest is not implemented".into()))
}
