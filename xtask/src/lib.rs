//! Workspace tooling for Pulsus Dash: the CI gates (`cargo xtask ci <gate>`) and the
//! deliberately regressing seeds that prove each gate fails (T05-002).

pub mod bundle;
pub mod dep_audit;
pub mod design;
pub mod gates;
pub mod jslex;
pub mod report;
pub mod seed;
pub mod shim;

use std::path::PathBuf;

pub use report::XtaskError;

/// Result type of every fallible xtask operation.
pub type R<T> = Result<T, XtaskError>;

/// The repository root: the parent of the `xtask` crate directory.
pub fn repo_root() -> R<PathBuf> {
    Err(XtaskError::Usage("not implemented".into()))
}
