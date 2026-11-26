//! `cargo xtask build-wasm [--out DIR]` (plan #68 C1 §2, T03 §5.6): the threaded engine. The
//! pinned nightly builds `dash-core` for wasm32 with `+atomics` and `build-std`, linked to one
//! imported shared memory of at most 2 GiB with the TLS exports wasm-bindgen's threads need;
//! wasm-bindgen (`--target web`, no default module path: the adapter passes the compiled
//! `Module`) writes `dash_core_mt.js`, `dash_core_mt.d.ts` and `dash_core_mt_bg.wasm`; wasm-opt
//! `-O3` optimises the module in place. The default output is the git-ignored
//! `client/src/engine/wasm/gen/`.

use std::path::{Path, PathBuf};
use std::process::Command;

/// The wasm-bindgen `--out-name`.
pub const OUT_NAME: &str = "dash_core_mt";

/// The `+atomics` flags (T03 §5.6): the pinned nightly does not add the shared-memory linker
/// arguments itself, so they are explicit.
pub const MT_RUSTFLAGS: &str = "-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128 \
-C link-arg=--max-memory=2147483648 -C link-arg=--shared-memory -C link-arg=--import-memory \
-C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size \
-C link-arg=--export=__tls_align -C link-arg=--export=__tls_base";

/// The features wasm-opt may use: those the build enables.
const WASM_OPT_FEATURES: [&str; 7] = [
    "--enable-threads",
    "--enable-bulk-memory",
    "--enable-mutable-globals",
    "--enable-simd",
    "--enable-sign-ext",
    "--enable-nontrapping-float-to-int",
    "--enable-reference-types",
];

/// The default output directory.
pub fn default_out(root: &Path) -> PathBuf {
    root.join("../client/src/engine/wasm/gen")
}

fn tool(root: &Path, key: &str) -> Result<String, String> {
    let text =
        std::fs::read_to_string(root.join("tools.toml")).map_err(|e| format!("tools.toml: {e}"))?;
    let mut table = String::new();
    for line in text.lines().map(str::trim) {
        if let Some(t) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            table = t.to_owned();
        } else if table == "web"
            && let Some((k, v)) = line.split_once('=')
            && k.trim() == key
        {
            let v = v.trim();
            let v = v
                .strip_prefix('"')
                .and_then(|v| v.split_once('"'))
                .map_or(v, |(v, _)| v);
            return Ok(v.to_owned());
        }
    }
    Err(format!("tools.toml has no [web] {key}"))
}

fn run(cmd: &mut Command) -> Result<(), String> {
    let what = format!("{cmd:?}");
    let status = cmd.status().map_err(|e| format!("{what}: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{what}: {status}"))
    }
}

/// Builds the engine into `out` (created; existing files replaced). `target` is the cargo
/// target directory.
pub fn build(root: &Path, out: &Path, target: &Path) -> Result<(), String> {
    let nightly = tool(root, "nightly")?;
    let mut cargo = Command::new("cargo");
    cargo
        .current_dir(root)
        .arg(format!("+{nightly}"))
        .args([
            "build",
            "--locked",
            "--profile",
            "wasm-release",
            "--target",
            "wasm32-unknown-unknown",
            "--package",
            "dash-core",
            "-Z",
            "build-std=panic_abort,std",
            "--target-dir",
        ])
        .arg(target)
        .env("RUSTFLAGS", MT_RUSTFLAGS);
    for k in [
        "RUSTUP_TOOLCHAIN",
        "RUSTC",
        "RUSTC_WRAPPER",
        "CARGO_ENCODED_RUSTFLAGS",
    ] {
        cargo.env_remove(k);
    }
    run(&mut cargo)?;
    std::fs::create_dir_all(out).map_err(|e| format!("{}: {e}", out.display()))?;
    let wasm = target.join("wasm32-unknown-unknown/wasm-release/dash_core.wasm");
    run(Command::new("wasm-bindgen")
        .args([
            "--target",
            "web",
            "--omit-default-module-path",
            "--out-name",
            OUT_NAME,
        ])
        .arg("--out-dir")
        .arg(out)
        .arg(&wasm))?;
    let bg = out.join(format!("{OUT_NAME}_bg.wasm"));
    run(Command::new("wasm-opt")
        .arg("-O3")
        .args(WASM_OPT_FEATURES)
        .arg(&bg)
        .arg("-o")
        .arg(&bg))
}
