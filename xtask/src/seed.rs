//! Deliberately regressing seeds for the gate proofs (T05-002, plan §4.6).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::gates::Gate;
use crate::{R, XtaskError};

#[derive(Debug, Clone, Copy)]
pub enum SeedWrite {
    Create { path: &'static str, contents: &'static str },
    Append { path: &'static str, text: &'static str },
    Replace { path: &'static str, from: &'static str, to: &'static str },
    CreateNoise { path: &'static str, random_bytes: usize },
}

#[derive(Debug, Clone)]
pub struct Seed {
    pub gate: Gate,
    pub writes: Vec<SeedWrite>,
    pub expect: &'static str,
}

pub fn seed_for(gate: Gate) -> Seed {
    Seed { gate, writes: vec![], expect: "" }
}

pub const SEED_MANIFEST_DIR: &str = "target/xtask-seed";

#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
pub enum SeedEntry {
    Created { path: String, seeded: String },
    Modified { path: String, original: String, seeded: String },
    CreatedDir { path: String },
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SeedManifest {
    pub gate: String,
    pub entries: Vec<SeedEntry>,
}

pub fn seed(_gate: Gate, _root: &Path) -> R<Vec<PathBuf>> {
    Err(XtaskError::Usage("not implemented".into()))
}

pub fn unseed(_gate: Gate, _root: &Path) -> R<Vec<PathBuf>> {
    Err(XtaskError::Usage("not implemented".into()))
}
