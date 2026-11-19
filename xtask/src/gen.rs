//! `cargo xtask gen`: builds both core artefacts, runs wasm-bindgen and wasm-opt, checks their
//! memories and places them under a web root (plan §4.7). Also regenerate-and-compare's
//! [`compare`].
//!
//! | Options | Web root | Targets | Probe | Writes `layout.gen.js` | Copies `web/` |
//! |---|---|---|---|---|---|
//! | `release` (`ci wasm`) | `web/` | `target/{mt,st}` | no | no | no |
//! | `dev` (`cargo xtask gen`) | `web/` | `target/{mt,st}` | no | yes | no |
//! | `test` (`gen --test`, `ci e2e`) | `target/web-test/` | `target/{mt,st}-probe` | yes | no | yes |
//! | `check` (`probe-absent`, `dep-audit`) | `target/gen-check/` | `target/{mt,st}` | no | no | yes |

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::report::{Rule, Violation};
use crate::tools::{self, Tools, run};
use crate::{R, XtaskError, relative, walk_files};

/// A core artefact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Artefact {
    Mt,
    St,
}

impl Artefact {
    pub const ALL: [Artefact; 2] = [Artefact::Mt, Artefact::St];

    /// `dash-core-mt` | `dash-core-st`: the directory under `shim/gen/`.
    pub fn name(self) -> &'static str {
        match self {
            Artefact::Mt => "dash-core-mt",
            Artefact::St => "dash-core-st",
        }
    }

    /// `dash_core_mt` | `dash_core_st`: wasm-bindgen's `--out-name`.
    pub fn out_name(self) -> &'static str {
        match self {
            Artefact::Mt => "dash_core_mt",
            Artefact::St => "dash_core_st",
        }
    }

    fn memory(self) -> MemoryKind {
        match self {
            Artefact::Mt => MemoryKind::Shared,
            Artefact::St => MemoryKind::Own,
        }
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
    /// `web/`, `target/mt`, `target/st`; no probe, no layout write, no copy.
    pub fn release(root: &Path) -> Self {
        GenOptions {
            probe: false,
            web_root: root.join("web"),
            mt_target: root.join("target/mt"),
            st_target: root.join("target/st"),
            write_layout: false,
            copy_web: false,
        }
    }

    /// As `release`, and writes `web/shim/layout.gen.js` when stale.
    pub fn dev(root: &Path) -> Self {
        GenOptions {
            write_layout: true,
            ..Self::release(root)
        }
    }

    /// The probe-enabled e2e build: `target/web-test`, `target/{mt,st}-probe`, copies `web/`.
    pub fn test(root: &Path) -> Self {
        GenOptions {
            probe: true,
            web_root: root.join("target/web-test"),
            mt_target: root.join("target/mt-probe"),
            st_target: root.join("target/st-probe"),
            write_layout: false,
            copy_web: true,
        }
    }

    /// A fresh release build for checks: `target/gen-check`, `target/{mt,st}`, copies `web/`.
    pub fn check(root: &Path) -> Self {
        GenOptions {
            web_root: root.join("target/gen-check"),
            copy_web: true,
            ..Self::release(root)
        }
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

/// `+atomics` build of `dash-core-mt` (T03 §5.6). The pinned nightly's rustc no longer passes
/// the shared-memory linker arguments for `+atomics` on wasm32-unknown-unknown, so they are
/// explicit: one imported shared memory (max 2 GiB) and the TLS exports wasm-bindgen's thread
/// support needs.
pub const MT_RUSTFLAGS: &str = "-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128 \
-C link-arg=--max-memory=2147483648 -C link-arg=--shared-memory -C link-arg=--import-memory \
-C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size \
-C link-arg=--export=__tls_align -C link-arg=--export=__tls_base";

/// The exact cargo build of one artefact (plan §3.7).
pub fn build_command(_root: &Path, t: &Tools, o: &GenOptions, a: Artefact) -> BuildCommand {
    let dir = match a {
        Artefact::Mt => &o.mt_target,
        Artefact::St => &o.st_target,
    };
    let mut args = Vec::new();
    if a == Artefact::Mt {
        args.push(format!("+{}", t.nightly));
    }
    args.extend(
        [
            "build",
            "--locked",
            "--profile",
            "wasm-release",
            "--target",
            "wasm32-unknown-unknown",
            "--package",
            "dash-core-mt",
            "--target-dir",
        ]
        .map(String::from),
    );
    args.push(dir.to_string_lossy().into_owned());
    if o.probe {
        args.extend(["--features", "probe"].map(String::from));
    }
    let mut env = Vec::new();
    let mut env_remove: Vec<String> = [
        "RUSTUP_TOOLCHAIN",
        "RUSTC",
        "RUSTC_WRAPPER",
        "CARGO_ENCODED_RUSTFLAGS",
        "CARGO_TARGET_DIR",
    ]
    .map(String::from)
    .into();
    match a {
        Artefact::Mt => {
            args.extend(["-Z", "build-std=panic_abort,std"].map(String::from));
            env.push(("RUSTFLAGS".to_string(), MT_RUSTFLAGS.to_string()));
        }
        Artefact::St => env_remove.push("RUSTFLAGS".to_string()),
    }
    BuildCommand {
        program: "cargo".to_string(),
        args,
        env,
        env_remove,
    }
}

fn run_build(root: &Path, b: &BuildCommand) -> R<()> {
    let mut cmd = Command::new(&b.program);
    cmd.args(&b.args).current_dir(root);
    for k in &b.env_remove {
        cmd.env_remove(k);
    }
    for (k, v) in &b.env {
        cmd.env(k, v);
    }
    run(&mut cmd)
}

fn io_rename(from: &Path, to: &Path) -> R<()> {
    std::fs::rename(from, to).map_err(XtaskError::io(to))
}

fn remove_dir_if_exists(p: &Path) -> R<()> {
    match std::fs::remove_dir_all(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(XtaskError::Io {
            path: p.to_path_buf(),
            source: e,
        }),
    }
}

/// Copies the files of `from` (except `skip`) into `to`.
fn copy_tree(from: &Path, to: &Path, skip: &Path) -> R<()> {
    for file in walk_files(from, &|_| false)? {
        if file.starts_with(skip) {
            continue;
        }
        let dest = to.join(relative(from, &file));
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(XtaskError::io(parent))?;
        }
        std::fs::copy(&file, &dest).map_err(XtaskError::io(&file))?;
    }
    Ok(())
}

/// Builds, binds, optimises and checks both artefacts, then places them (plan §4.7). A tool
/// exiting non-zero is `XtaskError::Tool`.
pub fn generate(root: &Path, o: &GenOptions) -> R<()> {
    let t = tools::load(root)?;
    let target = root.join("target");
    std::fs::create_dir_all(&target).map_err(XtaskError::io(&target))?;
    let tmp = tempfile::tempdir_in(&target).map_err(XtaskError::io(&target))?;
    for a in Artefact::ALL {
        run_build(root, &build_command(root, &t, o, a))?;
        let dir = match a {
            Artefact::Mt => &o.mt_target,
            Artefact::St => &o.st_target,
        };
        let wasm = dir.join("wasm32-unknown-unknown/wasm-release/dash_core_mt.wasm");
        let out = tmp.path().join(a.name());
        run(Command::new(tools::wasm_bindgen_bin(root))
            .args([
                "--target",
                "web",
                "--no-typescript",
                "--out-name",
                a.out_name(),
            ])
            .arg("--out-dir")
            .arg(&out)
            .arg(&wasm))?;
        let bg = out.join(format!("{}_bg.wasm", a.out_name()));
        run(Command::new(tools::wasm_opt_bin(root, &t))
            .arg("-O3")
            .arg(&bg)
            .arg("-o")
            .arg(&bg))?;
        let bytes = std::fs::read(&bg).map_err(XtaskError::io(&bg))?;
        check_memory(&bytes, a.memory()).map_err(|detail| XtaskError::Tool {
            command: format!("check memory of {}", a.name()),
            detail,
        })?;
    }
    if o.copy_web {
        remove_dir_if_exists(&o.web_root)?;
        let web = root.join("web");
        copy_tree(&web, &o.web_root, &web.join("shim/gen"))?;
    }
    let gen_dir = o.web_root.join("shim/gen");
    std::fs::create_dir_all(&gen_dir).map_err(XtaskError::io(&gen_dir))?;
    for a in Artefact::ALL {
        let dest = gen_dir.join(a.name());
        let old = gen_dir.join(format!(".{}.old", a.name()));
        remove_dir_if_exists(&old)?;
        if dest.exists() {
            io_rename(&dest, &old)?;
        }
        io_rename(&tmp.path().join(a.name()), &dest)?;
        remove_dir_if_exists(&old)?;
    }
    if o.write_layout {
        let path = root.join("web/shim/layout.gen.js");
        let js = dash_protocol::layout::render_js();
        if std::fs::read(&path).ok().as_deref() != Some(js.as_bytes()) {
            std::fs::write(&path, js).map_err(XtaskError::io(&path))?;
            println!("wrote web/shim/layout.gen.js");
        }
    }
    Ok(())
}

/// The memory a core artefact must have.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryKind {
    /// Imports a shared memory with a maximum of 32 768 pages (2 GiB).
    Shared,
    /// Imports no memory and exports an unshared one.
    Own,
}

/// 2 GiB in 64 KiB pages.
pub const SHARED_MAX_PAGES: u64 = 32_768;

/// Checks the module's memory against `k`.
pub fn check_memory(wasm: &[u8], k: MemoryKind) -> Result<(), String> {
    let mut imported = Vec::new();
    let mut defined = Vec::new();
    let mut exported = false;
    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        match payload.map_err(|e| e.to_string())? {
            wasmparser::Payload::ImportSection(r) => {
                for imp in r.into_imports() {
                    if let wasmparser::TypeRef::Memory(m) = imp.map_err(|e| e.to_string())?.ty {
                        imported.push(m);
                    }
                }
            }
            wasmparser::Payload::MemorySection(r) => {
                for m in r {
                    defined.push(m.map_err(|e| e.to_string())?);
                }
            }
            wasmparser::Payload::ExportSection(r) => {
                for e in r {
                    exported |=
                        e.map_err(|e| e.to_string())?.kind == wasmparser::ExternalKind::Memory;
                }
            }
            _ => {}
        }
    }
    match k {
        MemoryKind::Shared => match imported.as_slice() {
            [m] if m.shared && m.maximum == Some(SHARED_MAX_PAGES) && defined.is_empty() => Ok(()),
            [m] => Err(format!(
                "imported memory must be shared with maximum {SHARED_MAX_PAGES} pages: shared {}, maximum {:?}",
                m.shared, m.maximum
            )),
            _ => Err(format!(
                "expected one imported shared memory, found {} imported and {} defined",
                imported.len(),
                defined.len()
            )),
        },
        MemoryKind::Own => match (imported.as_slice(), defined.as_slice()) {
            ([], [m]) if !m.shared && exported => Ok(()),
            ([], [m]) if m.shared => Err("the defined memory is shared".into()),
            ([], [_]) => Err("the memory is not exported".into()),
            _ => Err(format!(
                "expected one own (defined, unshared, exported) memory, found {} imported and {} defined",
                imported.len(),
                defined.len()
            )),
        },
    }
}

/// Regenerate-and-compare of one directory: every file missing from `actual`, extra in it, or
/// with different bytes → `generated-mismatch` at `rel/<file>`.
pub fn compare(expected: &Path, actual: &Path, rel: &str) -> R<Vec<Violation>> {
    let list = |dir: &Path| -> R<BTreeSet<PathBuf>> {
        Ok(walk_files(dir, &|_| false)?
            .into_iter()
            .map(|p| relative(dir, &p))
            .collect())
    };
    let want = list(expected)?;
    let have = list(actual)?;
    let mut out = Vec::new();
    for f in want.union(&have) {
        let message = match (want.contains(f), have.contains(f)) {
            (true, false) => Some("missing (regenerate with `cargo xtask gen`)"),
            (false, true) => Some("not produced by a fresh build"),
            _ => {
                let a =
                    std::fs::read(expected.join(f)).map_err(XtaskError::io(expected.join(f)))?;
                let b = std::fs::read(actual.join(f)).map_err(XtaskError::io(actual.join(f)))?;
                (a != b).then_some("differs from a fresh build")
            }
        };
        if let Some(m) = message {
            out.push(Violation {
                rule: Rule::GeneratedMismatch,
                path: Path::new(rel).join(f),
                line: None,
                message: m.to_string(),
            });
        }
    }
    Ok(out)
}
