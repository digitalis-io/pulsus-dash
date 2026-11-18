//! Shared fixtures for the xtask integration tests.
#![allow(dead_code)]

use std::fs;
use std::path::Path;

/// Creates a temporary tree holding `files` (root-relative path, bytes).
pub fn tree(files: &[(&str, &[u8])]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (path, bytes) in files {
        write(dir.path(), path, bytes);
    }
    dir
}

/// Writes `bytes` to `root/path`, creating parent directories.
pub fn write(root: &Path, path: &str, bytes: &[u8]) {
    let p = root.join(path);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, bytes).unwrap();
}

/// `n` deterministic, incompressible bytes (xorshift64).
pub fn noise(n: usize) -> Vec<u8> {
    let mut x: u64 = 0x2545_F491_4F6C_DD1D;
    let mut out = Vec::with_capacity(n);
    while out.len() < n {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.truncate(n);
    out
}

/// `n` lines of `x();`.
pub fn lines(n: usize) -> Vec<u8> {
    "x();\n".repeat(n).into_bytes()
}

/// Copies directory `from` into `to` recursively.
pub fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap() {
        let e = e.unwrap();
        let t = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &t);
        } else {
            fs::copy(e.path(), t).unwrap();
        }
    }
}
