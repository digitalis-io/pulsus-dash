//! `cargo xtask build-wasm [--out DIR]` (plan #68 C1 §2, T03 §5.6): the threaded engine. The
//! pinned nightly builds `dash-core` for wasm32 with `+atomics` and `build-std`, linked to one
//! imported shared memory of at most 2 GiB with the TLS exports wasm-bindgen's threads need;
//! wasm-bindgen (`--target web`, no default module path: the adapter passes the compiled
//! `Module`) writes `dash_core_mt.js`, `dash_core_mt.d.ts` and `dash_core_mt_bg.wasm`; wasm-opt
//! `-O3` optimises the module in place. The default output is the git-ignored
//! `client/src/engine/wasm/gen/`.
//!
//! `--st` (plan #68 C2d2 §3.1) builds `dash-core-st`: the same crate with `--no-default-features
//! --features st` and no `+atomics` (no shared memory, no TLS, no `build-std`: the prebuilt std),
//! as `dash_core_st*` into `gen-st/` (`gen-st-probe/` with `--probe`).
//!
//! `--probe` (plan #68 C2a1 §3.5) builds the same engine with the `probe` feature
//! (`engine_probe_input`, `engine_probe_ring_start`) into the git-ignored
//! `client/src/engine/wasm/gen-probe/`, for the probe build of `e2e:shim-fuzz` only.

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

/// The wasm-bindgen `--out-name` of the single-thread engine (plan #68 C2d2 §3.1).
pub const ST_OUT_NAME: &str = "dash_core_st";

/// `dash-core-st` (plan #68 C2d2 §3.1): no `+atomics`, no shared or imported memory, no TLS
/// exports; the module's own memory of at most 2 GiB.
pub const ST_RUSTFLAGS: &str = "-C target-feature=+bulk-memory,+mutable-globals,+simd128 \
-C link-arg=--max-memory=2147483648";

/// The arguments of one engine build (plan #68 C2d2 §3.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuildArgs {
    /// `cargo +nightly` arguments after the toolchain, before `--target-dir`.
    pub cargo: Vec<String>,
    pub rustflags: String,
    /// wasm-opt's feature flags.
    pub wasm_opt: Vec<&'static str>,
    pub out_name: &'static str,
}

/// The build of the threaded engine (`st` false: `build-std`, the MT flags, default features) or
/// of `dash-core-st` (the prebuilt std, `--no-default-features --features st`, no threads in
/// wasm-opt); `probe` adds the `probe` feature to either.
pub fn build_args(st: bool, probe: bool) -> BuildArgs {
    let mut cargo: Vec<String> = [
        "build",
        "--locked",
        "--profile",
        "wasm-release",
        "--target",
        "wasm32-unknown-unknown",
        "--package",
        "dash-core",
    ]
    .map(String::from)
    .to_vec();
    if st {
        let features = if probe { "st,probe" } else { "st" };
        cargo.extend(["--no-default-features", "--features", features].map(String::from));
        BuildArgs {
            cargo,
            rustflags: ST_RUSTFLAGS.to_owned(),
            wasm_opt: WASM_OPT_FEATURES
                .into_iter()
                .filter(|f| *f != "--enable-threads")
                .collect(),
            out_name: ST_OUT_NAME,
        }
    } else {
        cargo.extend(["-Z", "build-std=panic_abort,std"].map(String::from));
        if probe {
            cargo.extend(["--features", "probe"].map(String::from));
        }
        BuildArgs {
            cargo,
            rustflags: MT_RUSTFLAGS.to_owned(),
            wasm_opt: WASM_OPT_FEATURES.to_vec(),
            out_name: OUT_NAME,
        }
    }
}

/// The default output directory: `gen/`, `gen-probe/`, `gen-st/` or `gen-st-probe/`.
pub fn default_out(root: &Path, st: bool, probe: bool) -> PathBuf {
    root.join(match (st, probe) {
        (false, false) => "../client/src/engine/wasm/gen",
        (false, true) => "../client/src/engine/wasm/gen-probe",
        (true, false) => "../client/src/engine/wasm/gen-st",
        (true, true) => "../client/src/engine/wasm/gen-st-probe",
    })
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
/// target directory; `st` the single-thread engine; `probe` adds the `probe` feature.
pub fn build(root: &Path, out: &Path, target: &Path, st: bool, probe: bool) -> Result<(), String> {
    let nightly = tool(root, "nightly")?;
    let a = build_args(st, probe);
    let mut cargo = Command::new("cargo");
    cargo
        .current_dir(root)
        .arg(format!("+{nightly}"))
        .args(&a.cargo)
        .arg("--target-dir")
        .arg(target)
        .env("RUSTFLAGS", &a.rustflags);
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
            a.out_name,
        ])
        .arg("--out-dir")
        .arg(out)
        .arg(&wasm))?;
    let bg = out.join(format!("{}_bg.wasm", a.out_name));
    run(Command::new("wasm-opt")
        .arg("-O3")
        .args(&a.wasm_opt)
        .arg(&bg)
        .arg("-o")
        .arg(&bg))
}
