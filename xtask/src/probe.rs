//! `ci:probe-absent` (T03-024) and the e2e build's probe check (T05-002).
//!
//! `probe-absent` scans a **fresh** release build of both artefacts (default features) in
//! `target/gen-check/`, never files already on disk; `e2e` checks the marker is found in the
//! probe-enabled test build, which proves the scanner detects it.

use std::path::{Path, PathBuf};

use crate::r#gen::GenOptions;
use crate::report::{Rule, Violation};
use crate::{R, XtaskError, relative, walk_files};

/// The core artefact files, relative to a web root.
pub const REQUIRED: [&str; 4] = [
    "shim/gen/dash-core-mt/dash_core_mt.js",
    "shim/gen/dash-core-mt/dash_core_mt_bg.wasm",
    "shim/gen/dash-core-st/dash_core_st.js",
    "shim/gen/dash-core-st/dash_core_st_bg.wasm",
];

/// The probe's global name (`dash_core_mt::probe::PROBE_GLOBAL`), stored in the `.wasm` data
/// of probe builds.
pub const MARKER: &[u8] = b"__dashProbe";

fn contains_marker(bytes: &[u8]) -> bool {
    bytes.windows(MARKER.len()).any(|w| w == MARKER)
}

/// Every file under `dir` whose bytes contain [`MARKER`].
pub fn scan(dir: &Path) -> R<Vec<PathBuf>> {
    let mut out = Vec::new();
    for f in walk_files(dir, &|_| false)? {
        let bytes = std::fs::read(&f).map_err(XtaskError::io(&f))?;
        if contains_marker(&bytes) {
            out.push(f);
        }
    }
    Ok(out)
}

fn violation(rule: Rule, path: PathBuf, message: &str) -> Violation {
    Violation {
        rule,
        path,
        line: None,
        message: message.to_string(),
    }
}

/// (1) deletes `target/gen-check/`; (2) builds it fresh with `generator(root,
/// GenOptions::check(root))`; (3) each [`REQUIRED`] file absent or empty →
/// `probe-artefact-missing`; (4) each file under its `shim/` holding the marker →
/// `probe-present`.
pub fn probe_absent_with(
    root: &Path,
    generator: &dyn Fn(&Path, &GenOptions) -> R<()>,
) -> R<Vec<Violation>> {
    let o = GenOptions::check(root);
    match std::fs::remove_dir_all(&o.web_root) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(XtaskError::Io {
                path: o.web_root.clone(),
                source: e,
            });
        }
    }
    generator(root, &o)?;
    let mut out = Vec::new();
    for rel in REQUIRED {
        let p = o.web_root.join(rel);
        if std::fs::metadata(&p).map_or(true, |m| m.len() == 0) {
            out.push(violation(
                Rule::ProbeArtefactMissing,
                relative(root, &p),
                "release artefact absent or empty",
            ));
        }
    }
    for p in scan(&o.web_root.join("shim"))? {
        out.push(violation(
            Rule::ProbePresent,
            relative(root, &p),
            "release artefact contains the test probe (T03-024)",
        ));
    }
    Ok(out)
}

/// [`probe_absent_with`] the real generator.
pub fn probe_absent(root: &Path) -> R<Vec<Violation>> {
    probe_absent_with(root, &crate::r#gen::generate)
}

/// Each `_bg.wasm` of [`REQUIRED`] under the test web root must hold the marker, else
/// `probe-marker-undetected` (the scanner would not catch a probe).
pub fn probe_expected(test_web_root: &Path) -> R<Vec<Violation>> {
    let found = scan(&test_web_root.join("shim"))?;
    Ok(REQUIRED
        .iter()
        .filter(|rel| rel.ends_with("_bg.wasm"))
        .map(|rel| test_web_root.join(rel))
        .filter(|p| !found.contains(p))
        .map(|p| {
            violation(
                Rule::ProbeMarkerUndetected,
                p,
                "the probe marker is not found in the probe build",
            )
        })
        .collect())
}
