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
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    manifest
        .parent()
        .map(std::path::Path::to_path_buf)
        .ok_or_else(|| XtaskError::Config {
            path: manifest.to_path_buf(),
            detail: "the xtask crate directory has no parent".into(),
        })
}

/// Root-relative path of `path` with `/` separators, for messages and manifests.
pub fn rel_str(path: &std::path::Path) -> String {
    path.components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// 1-based line number of byte offset `at` in `text`.
pub fn line_of(text: &str, at: usize) -> u32 {
    let n = text.as_bytes()[..at.min(text.len())]
        .iter()
        .filter(|&&b| b == b'\n')
        .count();
    u32::try_from(n + 1).unwrap_or(u32::MAX)
}

/// Every regular file under `dir` (recursively, sorted), as absolute paths. Directories for which
/// `skip_dir(name)` is true are not entered. Symlinked files are listed (reads follow the link).
/// A symlinked directory that is not skipped fails closed with `XtaskError::Config`: it is neither
/// followed (no cycle or out-of-tree traversal) nor silently ignored (a server following the link
/// would serve files no gate inspected). A missing `dir` yields no files.
pub fn walk_files(dir: &std::path::Path, skip_dir: &dyn Fn(&str) -> bool) -> R<Vec<PathBuf>> {
    let mut out = Vec::new();
    if dir.is_dir() {
        walk_into(dir, skip_dir, &mut out)?;
    }
    out.sort();
    Ok(out)
}

fn walk_into(
    dir: &std::path::Path,
    skip_dir: &dyn Fn(&str) -> bool,
    out: &mut Vec<PathBuf>,
) -> R<()> {
    let entries = std::fs::read_dir(dir).map_err(XtaskError::io(dir))?;
    for entry in entries {
        let entry = entry.map_err(XtaskError::io(dir))?;
        let path = entry.path();
        let ft = entry.file_type().map_err(XtaskError::io(&path))?;
        let skipped = || skip_dir(&entry.file_name().to_string_lossy());
        if ft.is_dir() {
            if !skipped() {
                walk_into(&path, skip_dir, out)?;
            }
        } else if ft.is_symlink() && path.is_dir() {
            if !skipped() {
                return Err(XtaskError::config(
                    &path,
                    "symlinked directory in an audited tree; replace it with a real directory",
                ));
            }
        } else if ft.is_file() || (ft.is_symlink() && path.is_file()) {
            out.push(path);
        }
    }
    Ok(())
}

/// `path` relative to `root` (or `path` itself when it is not under `root`).
pub fn relative(root: &std::path::Path, path: &std::path::Path) -> PathBuf {
    path.strip_prefix(root).unwrap_or(path).to_path_buf()
}
