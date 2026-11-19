//! Pinned build tools (T03 §5.6): `ci/tools.toml` and `cargo xtask tools` (plan §4.8).
//!
//! Installs, idempotently: the pinned nightly (with `rust-src` and the wasm32 target) for
//! `dash-core-mt`; `wasm-bindgen-cli` at the `Cargo.lock` version into `target/tools/`; binaryen's
//! `wasm-opt` from its release tarball, verified against the pinned SHA-256; `squawk` (the
//! migration lint, T11-013) from its release binary, verified the same way; `sqlx-cli` (the
//! `.sqlx` offline cache, T11 §4.8). `cargo xtask tools squawk|sqlx-cli` installs only that one.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Deserialize;

use crate::dep_audit::sha256_hex;
use crate::{R, XtaskError};

pub const CONFIG_PATH: &str = "ci/tools.toml";
/// Root-relative install directory.
pub const TOOLS_DIR: &str = "target/tools";

/// `ci/tools.toml`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tools {
    pub nightly: String,
    pub wasm_bindgen: String,
    pub binaryen: String,
    /// `<platform>` → SHA-256 of `binaryen-<v>-<platform>.tar.gz`.
    pub binaryen_sha256: BTreeMap<String, String>,
    /// squawk release (migration lint).
    pub squawk: String,
    /// `<platform>` → SHA-256 of the `squawk-<platform>` release binary.
    pub squawk_sha256: BTreeMap<String, String>,
    /// sqlx-cli version (== the `sqlx` dependency).
    pub sqlx_cli: String,
}

/// What `cargo xtask tools [<one>]` installs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Selection {
    All,
    Squawk,
    SqlxCli,
}

impl Selection {
    pub fn parse(arg: Option<&str>) -> Option<Selection> {
        match arg {
            None => Some(Selection::All),
            Some("squawk") => Some(Selection::Squawk),
            Some("sqlx-cli") => Some(Selection::SqlxCli),
            Some(_) => None,
        }
    }
}

/// `target/tools/bin/cargo-sqlx` (run as `cargo sqlx` with `target/tools/bin` on `PATH`).
pub fn cargo_sqlx_bin(root: &Path) -> PathBuf {
    root.join(TOOLS_DIR).join("bin/cargo-sqlx")
}

/// Loads `ci/tools.toml`.
pub fn load(root: &Path) -> R<Tools> {
    let text = std::fs::read_to_string(root.join(CONFIG_PATH))
        .map_err(|e| XtaskError::config(CONFIG_PATH, e.to_string()))?;
    toml::from_str(&text).map_err(|e| XtaskError::config(CONFIG_PATH, e.to_string()))
}

/// `target/tools/bin/wasm-bindgen`.
pub fn wasm_bindgen_bin(root: &Path) -> PathBuf {
    root.join(TOOLS_DIR).join("bin/wasm-bindgen")
}

/// `target/tools/binaryen-<v>/bin/wasm-opt`.
pub fn wasm_opt_bin(root: &Path, t: &Tools) -> PathBuf {
    root.join(TOOLS_DIR)
        .join(format!("binaryen-{}", t.binaryen))
        .join("bin/wasm-opt")
}

/// The binaryen release platform of this machine.
fn platform() -> R<&'static str> {
    match (std::env::consts::ARCH, std::env::consts::OS) {
        ("x86_64", "linux") => Ok("x86_64-linux"),
        ("aarch64", "linux") => Ok("aarch64-linux"),
        ("aarch64", "macos") => Ok("arm64-macos"),
        ("x86_64", "macos") => Ok("x86_64-macos"),
        (arch, os) => Err(XtaskError::config(
            CONFIG_PATH,
            format!("no binaryen release for {arch}-{os}"),
        )),
    }
}

/// Runs a tool to completion (output inherited); non-zero exit → `XtaskError::Tool`.
pub(crate) fn run(cmd: &mut Command) -> R<()> {
    let command = format!("{cmd:?}");
    println!("$ {command}");
    let status = cmd.status().map_err(|e| XtaskError::Tool {
        command: command.clone(),
        detail: e.to_string(),
    })?;
    if status.success() {
        Ok(())
    } else {
        Err(XtaskError::Tool {
            command,
            detail: format!("exited with {status}"),
        })
    }
}

/// `<bin> --version` output, if the binary runs.
fn version_of(bin: &Path) -> Option<String> {
    let out = Command::new(bin).arg("--version").output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Installs the selected pinned tools; a tool already at its pinned version is kept.
pub fn install_selected(root: &Path, t: &Tools, which: Selection) -> R<()> {
    match which {
        Selection::All => {
            install(root, t)?;
            install_squawk(root, t)?;
            install_sqlx_cli(root, t)
        }
        Selection::Squawk => install_squawk(root, t),
        Selection::SqlxCli => install_sqlx_cli(root, t),
    }
}

/// The squawk release platform of this machine.
fn squawk_platform() -> R<&'static str> {
    match (std::env::consts::ARCH, std::env::consts::OS) {
        ("x86_64", "linux") => Ok("linux-x64"),
        ("aarch64", "linux") => Ok("linux-arm64"),
        ("aarch64", "macos") => Ok("darwin-arm64"),
        ("x86_64", "macos") => Ok("darwin-x64"),
        (arch, os) => Err(XtaskError::config(
            CONFIG_PATH,
            format!("no squawk release for {arch}-{os}"),
        )),
    }
}

/// `squawk-<platform>` → `target/tools/bin/squawk` (0755), verified against the pin.
pub fn install_squawk(root: &Path, t: &Tools) -> R<()> {
    let bin = crate::migrations::squawk_bin(root);
    let want = format!("squawk {}", t.squawk);
    if version_of(&bin).is_some_and(|v| v.contains(&want)) {
        return Ok(());
    }
    let platform = squawk_platform()?;
    let expected = t.squawk_sha256.get(platform).ok_or_else(|| {
        XtaskError::config(CONFIG_PATH, format!("no squawk_sha256 for {platform}"))
    })?;
    let file = format!("squawk-{platform}");
    let dl = root.join(TOOLS_DIR).join("dl");
    std::fs::create_dir_all(&dl).map_err(XtaskError::io(&dl))?;
    let download = dl.join(&file);
    let url = format!(
        "https://github.com/sbdchd/squawk/releases/download/v{}/{file}",
        t.squawk
    );
    run(Command::new("curl")
        .args(["-sSfL", "-o"])
        .arg(&download)
        .arg(&url))?;
    let bytes = std::fs::read(&download).map_err(XtaskError::io(&download))?;
    let found = sha256_hex(&bytes);
    if &found != expected {
        std::fs::remove_file(&download).map_err(XtaskError::io(&download))?;
        return Err(XtaskError::config(
            CONFIG_PATH,
            format!("{file}: sha256 {found}, pinned {expected}; download deleted"),
        ));
    }
    if let Some(parent) = bin.parent() {
        std::fs::create_dir_all(parent).map_err(XtaskError::io(parent))?;
    }
    std::fs::rename(&download, &bin).map_err(XtaskError::io(&bin))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755))
            .map_err(XtaskError::io(&bin))?;
    }
    Ok(())
}

/// `cargo install sqlx-cli --version <v> --no-default-features --features rustls,postgres`.
pub fn install_sqlx_cli(root: &Path, t: &Tools) -> R<()> {
    let want = format!("sqlx-cli {}", t.sqlx_cli);
    let current = Command::new(cargo_sqlx_bin(root))
        .args(["sqlx", "--version"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    if current.as_deref() == Some(want.as_str()) {
        return Ok(());
    }
    run(Command::new("cargo")
        .args([
            "install",
            "sqlx-cli",
            "--version",
            &t.sqlx_cli,
            "--no-default-features",
            "--features",
            "rustls,postgres",
            "--locked",
        ])
        .arg("--root")
        .arg(root.join(TOOLS_DIR)))
}

/// Installs the pinned build tools of #22 (plan §4.8); a tool already at its pinned version is
/// kept.
pub fn install(root: &Path, t: &Tools) -> R<()> {
    run(Command::new("rustup").args([
        "toolchain",
        "install",
        &t.nightly,
        "--profile",
        "minimal",
        "--component",
        "rust-src",
        "--target",
        "wasm32-unknown-unknown",
    ]))?;

    let want = format!("wasm-bindgen {}", t.wasm_bindgen);
    if version_of(&wasm_bindgen_bin(root)).as_deref() != Some(want.as_str()) {
        run(Command::new("cargo")
            .args([
                "install",
                "wasm-bindgen-cli",
                "--version",
                &t.wasm_bindgen,
                "--locked",
            ])
            .arg("--root")
            .arg(root.join(TOOLS_DIR)))?;
    }

    if !wasm_opt_bin(root, t).is_file() {
        let platform = platform()?;
        let expected = t.binaryen_sha256.get(platform).ok_or_else(|| {
            XtaskError::config(CONFIG_PATH, format!("no binaryen_sha256 for {platform}"))
        })?;
        let file = format!("binaryen-{0}-{platform}.tar.gz", t.binaryen);
        let dl = root.join(TOOLS_DIR).join("dl");
        std::fs::create_dir_all(&dl).map_err(XtaskError::io(&dl))?;
        let tarball = dl.join(&file);
        let url = format!(
            "https://github.com/WebAssembly/binaryen/releases/download/{}/{file}",
            t.binaryen
        );
        run(Command::new("curl")
            .args(["-sSfL", "-o"])
            .arg(&tarball)
            .arg(&url))?;
        let bytes = std::fs::read(&tarball).map_err(XtaskError::io(&tarball))?;
        let found = sha256_hex(&bytes);
        if &found != expected {
            std::fs::remove_file(&tarball).map_err(XtaskError::io(&tarball))?;
            return Err(XtaskError::config(
                CONFIG_PATH,
                format!("{file}: sha256 {found}, pinned {expected}; download deleted"),
            ));
        }
        run(Command::new("tar")
            .arg("-xzf")
            .arg(&tarball)
            .arg("-C")
            .arg(root.join(TOOLS_DIR)))?;
        if !wasm_opt_bin(root, t).is_file() {
            return Err(XtaskError::Tool {
                command: format!("tar -xzf {file}"),
                detail: "the archive has no bin/wasm-opt".into(),
            });
        }
    }
    Ok(())
}
