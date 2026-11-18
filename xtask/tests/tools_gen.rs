#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Pinned tools, build commands, memory checks and regenerate-and-compare (plan §3.7, §4.7).

mod common;

use std::path::Path;

use common::tree;
use wasm_encoder::{ExportKind, ExportSection, ImportSection, MemorySection, MemoryType, Module};
use xtask::r#gen::{
    Artefact, BuildCommand, GenOptions, MemoryKind, build_command, check_memory, compare,
};
use xtask::report::Rule;
use xtask::tools;

fn root() -> std::path::PathBuf {
    xtask::repo_root().unwrap()
}

#[test]
fn tools_config_matches_lock() {
    let t = tools::load(&root()).unwrap();
    let lock: toml::Table = std::fs::read_to_string(root().join("Cargo.lock"))
        .unwrap()
        .parse()
        .unwrap();
    let wb: Vec<&str> = lock["package"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["name"].as_str() == Some("wasm-bindgen"))
        .map(|p| p["version"].as_str().unwrap())
        .collect();
    assert_eq!(wb, vec![t.wasm_bindgen.as_str()]);
    let n = t.nightly.strip_prefix("nightly-").unwrap();
    let parts: Vec<&str> = n.split('-').collect();
    assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), [4, 2, 2]);
    assert!(n.chars().all(|c| c.is_ascii_digit() || c == '-'));
    let platforms: Vec<&str> = t.binaryen_sha256.keys().map(String::as_str).collect();
    assert_eq!(
        platforms,
        [
            "aarch64-linux",
            "arm64-macos",
            "x86_64-linux",
            "x86_64-macos"
        ]
    );
    for h in t.binaryen_sha256.values() {
        assert_eq!(h.len(), 64);
        assert!(
            h.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
    }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

#[test]
fn build_commands_exact() {
    let r = Path::new("/repo");
    let t = tools::Tools {
        nightly: "nightly-2026-11-15".into(),
        wasm_bindgen: "0.2.130".into(),
        binaryen: "version_133".into(),
        binaryen_sha256: Default::default(),
    };
    let common_remove = [
        "RUSTUP_TOOLCHAIN",
        "RUSTC",
        "RUSTC_WRAPPER",
        "CARGO_ENCODED_RUSTFLAGS",
        "CARGO_TARGET_DIR",
    ];
    let rustflags = "-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128 -C link-arg=--max-memory=2147483648";
    let base = |dir: &str| {
        s(&[
            "build",
            "--locked",
            "--profile",
            "wasm-release",
            "--target",
            "wasm32-unknown-unknown",
            "--package",
            "dash-core-mt",
            "--target-dir",
            dir,
        ])
    };
    let mt = |dir: &str, probe: bool| {
        let mut args = s(&["+nightly-2026-11-15"]);
        args.extend(base(dir));
        if probe {
            args.extend(s(&["--features", "probe"]));
        }
        args.extend(s(&["-Z", "build-std=panic_abort,std"]));
        BuildCommand {
            program: "cargo".into(),
            args,
            env: vec![("RUSTFLAGS".into(), rustflags.into())],
            env_remove: s(&common_remove),
        }
    };
    let st = |dir: &str, probe: bool| {
        let mut args = base(dir);
        if probe {
            args.extend(s(&["--features", "probe"]));
        }
        let mut env_remove = s(&common_remove);
        env_remove.push("RUSTFLAGS".into());
        BuildCommand {
            program: "cargo".into(),
            args,
            env: vec![],
            env_remove,
        }
    };
    let rel = GenOptions::release(r);
    let test = GenOptions::test(r);
    assert!(!rel.probe && test.probe);
    assert_eq!(
        build_command(r, &t, &rel, Artefact::Mt),
        mt("/repo/target/mt", false)
    );
    assert_eq!(
        build_command(r, &t, &rel, Artefact::St),
        st("/repo/target/st", false)
    );
    assert_eq!(
        build_command(r, &t, &test, Artefact::Mt),
        mt("/repo/target/mt-probe", true)
    );
    assert_eq!(
        build_command(r, &t, &test, Artefact::St),
        st("/repo/target/st-probe", true)
    );
    assert_eq!(rel.web_root, r.join("web"));
    assert!(!rel.write_layout && !rel.copy_web);
    assert!(GenOptions::dev(r).write_layout);
    assert_eq!(test.web_root, r.join("target/web-test"));
    assert!(test.copy_web);
    let check = GenOptions::check(r);
    assert_eq!(check.web_root, r.join("target/gen-check"));
    assert_eq!(check.mt_target, r.join("target/mt"));
    assert!(check.copy_web && !check.probe);
}

/// A module with one memory: imported or exported, shared or not, with `max` pages.
fn module(import: bool, shared: bool, max: u64) -> Vec<u8> {
    let ty = MemoryType {
        minimum: 17,
        maximum: Some(max),
        memory64: false,
        shared,
        page_size_log2: None,
    };
    let mut m = Module::new();
    if import {
        let mut i = ImportSection::new();
        i.import("env", "memory", ty);
        m.section(&i);
    } else {
        let mut mem = MemorySection::new();
        mem.memory(ty);
        m.section(&mem);
        let mut e = ExportSection::new();
        e.export("memory", ExportKind::Memory, 0);
        m.section(&e);
    }
    m.finish()
}

#[test]
fn memory_checks() {
    let cases = [
        module(true, true, 32_768),
        module(true, false, 32_768),
        module(true, true, 16_384),
        module(false, false, 32_768),
        module(false, true, 32_768),
    ];
    let shared: Vec<bool> = cases
        .iter()
        .map(|w| check_memory(w, MemoryKind::Shared).is_ok())
        .collect();
    let own: Vec<bool> = cases
        .iter()
        .map(|w| check_memory(w, MemoryKind::Own).is_ok())
        .collect();
    assert_eq!(shared, vec![true, false, false, false, false]);
    assert_eq!(own, vec![false, false, false, true, false]);
    assert!(check_memory(b"not wasm", MemoryKind::Own).is_err());
}

#[test]
fn gen_compare_cases() {
    let files: &[(&str, &[u8])] = &[("a.js", b"a"), ("snippets/x/b.js", b"b"), ("c.wasm", b"c")];
    let a = tree(files);
    let b = tree(files);
    assert!(
        compare(a.path(), b.path(), "web/shim/gen/dash-core-mt")
            .unwrap()
            .is_empty()
    );
    let c = tree(&[
        ("a.js", b"edited"),
        ("snippets/x/b.js", b"b"),
        ("d.js", b"extra"),
    ]);
    let v = compare(a.path(), c.path(), "web/shim/gen/dash-core-mt").unwrap();
    let mut got: Vec<(Rule, String)> = v
        .iter()
        .map(|v| (v.rule, xtask::rel_str(&v.path)))
        .collect();
    got.sort_by(|x, y| x.1.cmp(&y.1));
    assert_eq!(
        got,
        vec![
            (
                Rule::GeneratedMismatch,
                "web/shim/gen/dash-core-mt/a.js".into()
            ),
            (
                Rule::GeneratedMismatch,
                "web/shim/gen/dash-core-mt/c.wasm".into()
            ),
            (
                Rule::GeneratedMismatch,
                "web/shim/gen/dash-core-mt/d.js".into()
            ),
        ]
    );
}

#[test]
fn layout_gen_committed_is_current() {
    let bytes = std::fs::read(root().join("web/shim/layout.gen.js")).unwrap_or_default();
    assert!(!bytes.is_empty(), "web/shim/layout.gen.js is committed");
    assert_eq!(
        String::from_utf8_lossy(&bytes),
        dash_protocol::layout::render_js(),
        "run `cargo xtask gen` and commit web/shim/layout.gen.js"
    );
}
