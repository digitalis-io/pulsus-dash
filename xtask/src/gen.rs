//! `cargo xtask gen`: build both core artefacts, wasm-bindgen, wasm-opt and place them under a
//! web root (plan §4.7). Stub.

use std::path::{Path, PathBuf};

use crate::report::Violation;
use crate::tools::Tools;
use crate::{R, XtaskError};

/// A core artefact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Artefact {
    Mt,
    St,
}

impl Artefact {
    pub const ALL: [Artefact; 2] = [Artefact::Mt, Artefact::St];

    pub fn name(self) -> &'static str {
        ""
    }
}

/// Where and how to generate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenOptions {
    pub probe: bool,
    pub web_root: PathBuf,
    pub mt_target: PathBuf,
    pub st_target: PathBuf,
    pub write_layout: bool,
    pub copy_web: bool,
}

impl GenOptions {
    pub fn release(root: &Path) -> Self {
        GenOptions {
            probe: false,
            web_root: root.to_path_buf(),
            mt_target: root.to_path_buf(),
            st_target: root.to_path_buf(),
            write_layout: false,
            copy_web: false,
        }
    }

    pub fn dev(root: &Path) -> Self {
        Self::release(root)
    }

    pub fn test(root: &Path) -> Self {
        Self::release(root)
    }

    pub fn check(root: &Path) -> Self {
        Self::release(root)
    }
}

/// One cargo invocation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub env_remove: Vec<String>,
}

pub fn build_command(_root: &Path, _t: &Tools, _o: &GenOptions, _a: Artefact) -> BuildCommand {
    BuildCommand {
        program: String::new(),
        args: Vec::new(),
        env: Vec::new(),
        env_remove: Vec::new(),
    }
}

pub fn generate(_root: &Path, _o: &GenOptions) -> R<()> {
    Err(XtaskError::Usage("stub".into()))
}

/// The memory a core artefact must have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryKind {
    Shared,
    Own,
}

pub fn check_memory(_wasm: &[u8], _k: MemoryKind) -> Result<(), String> {
    Ok(())
}

pub fn compare(_expected: &Path, _actual: &Path, _rel: &str) -> R<Vec<Violation>> {
    Ok(Vec::new())
}
