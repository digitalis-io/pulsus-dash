//! `cargo xtask gen-layout [--check]` (plan #68 C1 §3.2, T03-005): writes
//! `client/src/engine/wasm/layout.gen.ts` from `dash-protocol`, or with `--check` compares it.

use std::path::{Path, PathBuf};

/// The generated file, for the engine directory `root`.
pub fn path(root: &Path) -> PathBuf {
    root.join("..").join(dash_protocol::GEN_TS_PATH)
}

/// `Ok(true)` when the file equals `gen_ts()` (check) or was written (write); `Ok(false)` when the
/// check found a difference.
pub fn run(root: &Path, check: bool) -> Result<bool, String> {
    let p = path(root);
    let want = dash_protocol::gen_ts();
    let have = std::fs::read_to_string(&p).ok();
    if check {
        return Ok(have.as_deref() == Some(want.as_str()));
    }
    if have.as_deref() != Some(want.as_str()) {
        std::fs::write(&p, want).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    Ok(true)
}
