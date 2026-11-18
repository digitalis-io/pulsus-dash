//! `ci:design-check`: `designs/tools/check.py` on a copy of `designs/` (plan §4.5).

use std::path::Path;

use crate::report::Violation;
use crate::{R, XtaskError};

pub fn check(_root: &Path) -> R<Vec<Violation>> {
    Err(XtaskError::Usage("not implemented".into()))
}
