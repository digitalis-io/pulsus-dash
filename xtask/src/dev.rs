//! `cargo xtask dev up|down|reset|sqlx-prepare` (plan §3.10, §4.4): the local compose stack.

use std::path::Path;

use crate::{R, XtaskError};

/// `dev/local.env` merged under `env`: `KEY=VALUE` lines, `#` comments and blanks ignored, one
/// pair of surrounding `"` stripped; variables already in `env` win. Returns `env` plus the new
/// pairs.
pub fn merge_local_env(text: &str, env: &[(String, String)]) -> Vec<(String, String)> {
    let _ = text;
    env.to_vec()
}

/// Renders `dev/dex.yaml.tmpl` for `idp_port` with a bcrypt (cost 10) hash of `password`.
pub fn render_dex(template: &str, idp_port: u16, password: &str) -> R<String> {
    let _ = (idp_port, password);
    Ok(template.to_string())
}

/// `cargo xtask dev <args>`.
pub fn run(root: &Path, args: &[String]) -> R<u8> {
    let _ = (root, args);
    Err(XtaskError::Usage("dev is not implemented".into()))
}
