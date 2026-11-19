#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `ci:dep-audit` (T01-002, T03-008, ADR-0001/0007): plan §4.3.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use common::tree;
use xtask::XtaskError;
use xtask::dep_audit::{
    CrateAllow, DepAuditConfig, LockAllow, Package, ShimPin, ShimPins, Workspace, audit,
    check_crate_graph, check_generated_with, check_npm, check_render_worker_locks,
    check_shipped_js, check_web_assets, check_web_sys, load_config, load_pins, sha256_hex,
};
use xtask::report::{Rule, Violation};
use xtask::shim::{SHIM_PATHS, ShimFiles};

fn cfg() -> DepAuditConfig {
    DepAuditConfig {
        browser_roots: vec!["dash-core-mt".into()],
        npm_dev_allow: vec!["@playwright/test".into(), "playwright".into()],
        render_worker_crates: vec!["dash-scene".into(), "dash-gpu".into(), "dash-marks".into()],
        web_dir: "web".into(),
        allowed_url_prefixes: vec!["http://www.w3.org/".into()],
        web_sys: BTreeMap::new(),
        lock_allow: vec![],
        browser_crates: vec![],
        server: None,
    }
}

fn pkg(name: &str, dir: &Path, member: bool, ws: Option<&[&str]>) -> (String, Package) {
    (
        name.to_string(),
        Package {
            name: name.to_string(),
            dir: dir.to_path_buf(),
            is_member: member,
            web_sys_features: ws.map(|f| f.iter().map(|s| s.to_string()).collect()),
        },
    )
}

fn rules(v: &[Violation]) -> Vec<Rule> {
    v.iter().map(|v| v.rule).collect()
}

fn shim_files(paths: &[&str]) -> ShimFiles {
    ShimFiles {
        candidates: paths.iter().map(PathBuf::from).collect(),
    }
}

/// 13 small exported functions, as a vendored helper library would look.
fn lib_js() -> Vec<u8> {
    (1..=13)
        .map(|n| {
            format!("export function clamp{n}(v, lo, hi) {{\n  return Math.min(Math.max(v, lo), hi);\n}}\n")
        })
        .collect::<String>()
        .into_bytes()
}

#[test]
fn npm_runtime_dependency_rejected() {
    let t = tree(&[(
        "web/package.json",
        br#"{"dependencies":{"left-pad":"1.3.0"},"peerDependencies":{"x":"1"}}"#,
    )]);
    let v = check_npm(t.path(), &cfg()).unwrap();
    assert_eq!(
        rules(&v),
        vec![Rule::NpmRuntimeDependency, Rule::NpmRuntimeDependency]
    );
}

#[test]
fn npm_dev_tooling_allowed() {
    let t = tree(&[(
        "e2e/package.json",
        br#"{"devDependencies":{"@playwright/test":"1.50.0"}}"#,
    )]);
    assert!(check_npm(t.path(), &cfg()).unwrap().is_empty());
}

#[test]
fn npm_dev_other_rejected() {
    let t = tree(&[(
        "e2e/package.json",
        br#"{"devDependencies":{"left-pad":"1.3.0"}}"#,
    )]);
    let v = check_npm(t.path(), &cfg()).unwrap();
    assert_eq!(rules(&v), vec![Rule::NpmDisallowedDevDependency]);
}

#[test]
fn npm_skips_ignored_dirs() {
    let bad: &[u8] = br#"{"dependencies":{"left-pad":"1.3.0"}}"#;
    let t = tree(&[
        ("node_modules/a/package.json", bad),
        ("target/b/package.json", bad),
        ("plans/c/package.json", bad),
    ]);
    assert!(check_npm(t.path(), &cfg()).unwrap().is_empty());
}

#[test]
fn browser_crate_allowlist() {
    let d = Path::new("/nonexistent");
    let mut edges: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    edges.insert(
        "dash-core-mt".into(),
        ["dash-marks", "okcrate"]
            .iter()
            .map(|s| s.to_string())
            .collect(),
    );
    edges.insert(
        "dash-marks".into(),
        ["extlib"].iter().map(|s| s.to_string()).collect(),
    );
    edges.insert(
        "dash-lab".into(),
        ["devlib"].iter().map(|s| s.to_string()).collect(),
    );
    let ws = Workspace {
        roots: vec!["dash-core-mt".into()],
        normal_edges: edges,
        packages: [
            pkg("dash-core-mt", d, true, None),
            pkg("dash-marks", d, true, None),
            pkg("dash-lab", d, true, None),
            pkg("extlib", d, false, None),
            pkg("okcrate", d, false, None),
            pkg("devlib", d, false, None),
        ]
        .into_iter()
        .collect(),
    };
    let mut c = cfg();
    c.browser_crates = vec![CrateAllow {
        name: "okcrate".into(),
        reason: "audited".into(),
    }];
    let v = check_crate_graph(&ws, &c);
    assert_eq!(rules(&v), vec![Rule::BrowserCrateNotAllowed]);
    assert_eq!(v[0].message, "dash-core-mt -> dash-marks -> extlib");
}

#[test]
fn web_sys_allowlist() {
    let d = Path::new("/nonexistent");
    let ws = Workspace {
        roots: vec!["dash-core-mt".into()],
        normal_edges: BTreeMap::new(),
        packages: [
            pkg("dash-gpu", d, true, Some(&["GpuAdapter", "Window"])),
            pkg("dash-wire", d, true, Some(&["Performance"])),
        ]
        .into_iter()
        .collect(),
    };
    let mut c = cfg();
    c.web_sys.insert("dash-gpu".into(), vec!["Gpu*".into()]);
    let v = check_web_sys(&ws, &c);
    assert_eq!(rules(&v), vec![Rule::WebSysFeature, Rule::WebSysFeature]);
    assert!(v[0].message.contains("dash-gpu") && v[0].message.contains("Window"));
    assert!(v[1].message.contains("dash-wire") && v[1].message.contains("Performance"));
}

const LOCK_SRC: &[u8] = b"// Mutex\nuse std::sync::Mutex;\nconst S: &str = \"RwLock\";\nmacro_rules! m { () => { std::sync::RwLock::new(0) } }\n";

fn lock_ws(root: &Path) -> Workspace {
    Workspace {
        roots: vec!["dash-core-mt".into()],
        normal_edges: BTreeMap::new(),
        packages: [
            pkg("dash-gpu", &root.join("crates/dash-gpu"), true, None),
            pkg("dash-wire", &root.join("crates/dash-wire"), true, None),
        ]
        .into_iter()
        .collect(),
    }
}

#[test]
fn render_worker_lock_rejected() {
    let t = tree(&[
        ("crates/dash-gpu/src/lib.rs", LOCK_SRC),
        ("crates/dash-wire/src/lib.rs", b"use std::sync::Mutex;\n"),
    ]);
    let v = check_render_worker_locks(t.path(), &lock_ws(t.path()), &cfg()).unwrap();
    let got: Vec<(Rule, PathBuf, Option<u32>)> =
        v.iter().map(|v| (v.rule, v.path.clone(), v.line)).collect();
    let p = PathBuf::from("crates/dash-gpu/src/lib.rs");
    assert_eq!(
        got,
        vec![
            (Rule::RenderWorkerLock, p.clone(), Some(2)),
            (Rule::RenderWorkerLock, p, Some(4)),
        ]
    );
}

#[test]
fn render_worker_lock_allowlisted() {
    let t = tree(&[("crates/dash-gpu/src/lib.rs", LOCK_SRC)]);
    let mut c = cfg();
    for ident in ["Mutex", "RwLock"] {
        c.lock_allow.push(LockAllow {
            krate: "dash-gpu".into(),
            file: "src/lib.rs".into(),
            ident: ident.into(),
            reason: "test fixture".into(),
        });
    }
    let v = check_render_worker_locks(t.path(), &lock_ws(t.path()), &c).unwrap();
    assert!(v.is_empty(), "{v:?}");
}

const BASE_CFG: &str = "browser_roots = [\"dash-core-mt\"]\nnpm_dev_allow = []\nrender_worker_crates = []\nweb_dir = \"web\"\nallowed_url_prefixes = []\n";

#[test]
fn allow_entries_require_reason() {
    let lock = format!(
        "{BASE_CFG}\n[[lock_allow]]\ncrate = \"dash-gpu\"\nfile = \"src/lib.rs\"\nident = \"Mutex\"\nreason = \"\"\n"
    );
    let krate = format!("{BASE_CFG}\n[[browser_crate]]\nname = \"x\"\nreason = \"\"\n");
    for text in [lock, krate] {
        let t = tree(&[("ci/dep-audit.toml", text.as_bytes())]);
        assert!(matches!(
            load_config(t.path()),
            Err(XtaskError::Config { .. })
        ));
    }
}

#[test]
fn third_party_host_rejected() {
    let t = tree(&[
        (
            "web/index.html",
            b"<link href=\"https://fonts.example.com/a.css\">\n<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>\n",
        ),
        ("web/a.css", b"@font-face{src:url(//cdn.example.net/f.woff2)}"),
    ]);
    let v = check_web_assets(t.path(), &cfg()).unwrap();
    let mut got: Vec<(Rule, PathBuf, Option<u32>)> =
        v.iter().map(|v| (v.rule, v.path.clone(), v.line)).collect();
    got.sort_by(|a, b| a.1.cmp(&b.1));
    assert_eq!(
        got,
        vec![
            (Rule::ThirdPartyHost, PathBuf::from("web/a.css"), Some(1)),
            (
                Rule::ThirdPartyHost,
                PathBuf::from("web/index.html"),
                Some(1)
            ),
        ]
    );
}

#[test]
fn js_outside_shim_rejected() {
    let t = tree(&[("web/app.js", b"x();\n"), ("web/shim/boot.js", b"x();\n")]);
    let v = check_web_assets(t.path(), &cfg()).unwrap();
    let got: Vec<(Rule, PathBuf)> = v.iter().map(|v| (v.rule, v.path.clone())).collect();
    assert_eq!(
        got,
        vec![(Rule::JsOutsideShim, PathBuf::from("web/app.js"))]
    );
}

fn pins(p: &[(&str, &[u8])]) -> ShimPins {
    ShimPins {
        files: p
            .iter()
            .map(|(path, bytes)| ShimPin {
                path: path.to_string(),
                sha256: sha256_hex(bytes),
            })
            .collect(),
    }
}

#[test]
fn vendored_library_new_file_rejected() {
    let lib = lib_js();
    let t = tree(&[
        ("web/shim/boot.js", b"x();\n"),
        ("web/shim/x.wasm", b"\0asm"),
        ("web/shim/lib.js", &lib),
    ]);
    let files = shim_files(&["web/shim/boot.js", "web/shim/lib.js", "web/shim/x.wasm"]);
    let v = check_shipped_js(t.path(), &files, &pins(&[("web/shim/boot.js", b"x();\n")])).unwrap();
    let mut got: Vec<(Rule, PathBuf)> = v.iter().map(|v| (v.rule, v.path.clone())).collect();
    got.sort_by(|a, b| a.1.cmp(&b.1));
    assert_eq!(
        got,
        vec![
            (Rule::ShimFileNotAllowed, PathBuf::from("web/shim/lib.js")),
            (Rule::ShimFileNotAllowed, PathBuf::from("web/shim/x.wasm")),
        ]
    );
}

#[test]
fn vendored_library_in_listed_file_rejected() {
    let lib = lib_js();
    let t = tree(&[("web/shim/boot.js", &lib)]);
    let v = check_shipped_js(
        t.path(),
        &shim_files(&["web/shim/boot.js"]),
        &pins(&[("web/shim/boot.js", b"x();\n")]),
    )
    .unwrap();
    assert_eq!(rules(&v), vec![Rule::ShimPinMismatch]);
    assert_eq!(v[0].path, PathBuf::from("web/shim/boot.js"));
    assert!(v[0].message.contains(&sha256_hex(b"x();\n")));
    assert!(v[0].message.contains(&sha256_hex(&lib)));
}

#[test]
fn shim_unpinned_and_stale_pins() {
    let t = tree(&[("web/shim/net.js", b"x();\n")]);
    let v = check_shipped_js(
        t.path(),
        &shim_files(&["web/shim/net.js"]),
        &pins(&[("web/shim/sw.js", b"y();\n")]),
    )
    .unwrap();
    let got: Vec<(Rule, PathBuf)> = v.iter().map(|v| (v.rule, v.path.clone())).collect();
    assert_eq!(
        got,
        vec![
            (Rule::ShimUnpinned, PathBuf::from("web/shim/net.js")),
            (Rule::ShimPinStale, PathBuf::from("web/shim/sw.js")),
        ]
    );
    assert!(v[0].message.contains(&sha256_hex(b"x();\n")));
}

#[test]
fn shim_pins_config_rejected() {
    let h = "a".repeat(64);
    let texts = [
        format!("[[file]]\npath = \"web/shim/lib.js\"\nsha256 = \"{h}\"\n"),
        format!(
            "[[file]]\npath = \"web/shim/boot.js\"\nsha256 = \"{h}\"\n[[file]]\npath = \"web/shim/boot.js\"\nsha256 = \"{h}\"\n"
        ),
        "[[file]]\npath = \"web/shim/boot.js\"\nsha256 = \"ABC\"\n".to_string(),
    ];
    for text in texts {
        let t = tree(&[("ci/shim-pins.toml", text.as_bytes())]);
        assert!(
            matches!(load_pins(t.path()), Err(XtaskError::Config { .. })),
            "{text}"
        );
    }
}

#[test]
fn gen_unknown_dir_rejected() {
    let t = tree(&[
        ("web/shim/gen/evil/x.js", b"fetch(\"x\");\n"),
        ("web/shim/gen/dash-core-st/dash_core_st.js", b"x();\n"),
    ]);
    let calls = std::cell::Cell::new(0);
    let fake = |_: &Path, _: &xtask::r#gen::GenOptions| -> xtask::R<()> {
        calls.set(calls.get() + 1);
        Ok(())
    };
    let v = check_generated_with(t.path(), &fake).unwrap();
    let got: Vec<(Rule, PathBuf)> = v.iter().map(|v| (v.rule, v.path.clone())).collect();
    assert_eq!(
        got,
        vec![(Rule::GeneratedUnknown, PathBuf::from("web/shim/gen/evil"))]
    );
    assert_eq!(
        calls.get(),
        0,
        "no regenerate when gen/ holds an unknown entry"
    );
}

#[test]
fn gen_regenerated_and_compared() {
    let t = tree(&[
        ("web/shim/gen/dash-core-mt/dash_core_mt.js", b"glue\n"),
        (
            "web/shim/gen/dash-core-mt/dash_core_mt_bg.wasm",
            b"\0asm-old",
        ),
    ]);
    let calls = std::cell::Cell::new(0);
    let fake = |root: &Path, o: &xtask::r#gen::GenOptions| -> xtask::R<()> {
        calls.set(calls.get() + 1);
        assert_eq!(*o, xtask::r#gen::GenOptions::check(root));
        let d = o.web_root.join("shim/gen/dash-core-mt");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("dash_core_mt.js"), b"glue\n").unwrap();
        fs::write(d.join("dash_core_mt_bg.wasm"), b"\0asm-new").unwrap();
        Ok(())
    };
    let v = check_generated_with(t.path(), &fake).unwrap();
    assert_eq!(calls.get(), 1);
    let got: Vec<(Rule, PathBuf)> = v.iter().map(|v| (v.rule, v.path.clone())).collect();
    assert_eq!(
        got,
        vec![(
            Rule::GeneratedMismatch,
            PathBuf::from("web/shim/gen/dash-core-mt/dash_core_mt_bg.wasm")
        )]
    );
    let empty = tree(&[("web/index.html", b"<html></html>\n")]);
    assert!(
        check_generated_with(empty.path(), &fake)
            .unwrap()
            .is_empty()
    );
    assert_eq!(calls.get(), 1, "no gen/ means nothing to accept");
}

#[test]
fn dep_audit_layout_gen_admitted() {
    let current = dash_protocol::layout::render_js();
    let files = shim_files(&["web/shim/layout.gen.js"]);
    let t = tree(&[("web/shim/layout.gen.js", current.as_bytes())]);
    let v = check_shipped_js(t.path(), &files, &ShimPins { files: vec![] }).unwrap();
    assert!(v.is_empty(), "{v:?}");
    let stale = format!("{current}x();\n");
    let t = tree(&[("web/shim/layout.gen.js", stale.as_bytes())]);
    let v = check_shipped_js(t.path(), &files, &ShimPins { files: vec![] }).unwrap();
    assert_eq!(rules(&v), vec![Rule::LayoutGenStale]);
}

#[test]
fn sha256_known_vector() {
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

/// The first backticked cell of each row of the first table after `heading`.
fn table_rows(doc: &str, heading: &str) -> Vec<Vec<String>> {
    let start = doc.find(heading).unwrap();
    doc[start..]
        .lines()
        .skip_while(|l| !l.starts_with('|'))
        .take_while(|l| l.starts_with('|'))
        .skip(2)
        .map(|l| {
            l.trim_matches('|')
                .split('|')
                .map(|c| c.trim().to_string())
                .collect()
        })
        .collect()
}

#[test]
fn shim_paths_match_t03() {
    let root = xtask::repo_root().unwrap();
    let doc = fs::read_to_string(root.join("designs/technical/T03-browser-runtime.md")).unwrap();
    let files: Vec<String> = table_rows(&doc, "### 5.1")
        .into_iter()
        .filter(|r| r[0] != "**Total**")
        .map(|r| r[0].trim_matches('`').to_string())
        .collect();
    let want: Vec<String> = SHIM_PATHS.iter().map(|s| s.to_string()).collect();
    assert_eq!(files, want);
}

#[test]
fn dep_audit_repo_passes() {
    let v = audit(&xtask::repo_root().unwrap()).unwrap();
    assert!(v.is_empty(), "{v:?}");
}

#[test]
fn dep_audit_config_matches_t03() {
    let root = xtask::repo_root().unwrap();
    let c = load_config(&root).unwrap();
    assert_eq!(
        c.render_worker_crates,
        vec!["dash-scene", "dash-gpu", "dash-marks", "dash-state"]
    );
    assert_eq!(c.browser_roots, vec!["dash-core-mt"]);
    for b in &c.browser_crates {
        assert!(b.reason.contains("T01-002"), "{}: {}", b.name, b.reason);
        assert!(
            b.reason
                .contains("not a UI, component, charting, mapping or diagram library"),
            "{}: {}",
            b.name,
            b.reason
        );
    }
    assert!(!c.browser_crates.is_empty());
    let pinned: Vec<String> = load_pins(&root)
        .unwrap()
        .files
        .into_iter()
        .map(|p| p.path)
        .collect();
    assert_eq!(
        pinned,
        vec![
            "web/shim/boot.js",
            "web/shim/worker.js",
            "web/shim/input.js"
        ]
    );
    let want: BTreeMap<String, Vec<String>> = [
        ("dash-gpu", vec!["OffscreenCanvas"]),
        ("dash-core-mt", vec!["OffscreenCanvas", "Performance"]),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v.into_iter().map(String::from).collect()))
    .collect();
    assert_eq!(c.web_sys, want);
}

/// A directory symlinked into an audited tree is refused (fail closed), never silently skipped: a
/// web server following the link would serve files the audit did not inspect (review r1 #1).
#[cfg(unix)]
#[test]
fn symlinked_web_dir_fails_closed() {
    let t = tree(&[
        ("web/index.html", b"<html></html>\n"),
        ("outside/app.js", b"x();\n"),
    ]);
    std::os::unix::fs::symlink(t.path().join("outside"), t.path().join("web/assets")).unwrap();
    match check_web_assets(t.path(), &cfg()) {
        Err(XtaskError::Config { path, .. }) => assert_eq!(path, t.path().join("web/assets")),
        other => panic!("expected Config error for the symlinked directory, got {other:?}"),
    }
}

#[cfg(unix)]
#[test]
fn symlinked_generated_dir_fails_closed() {
    let t = tree(&[
        ("pkg/dash_core_mt.js", b"fetch(\"x\");\n"),
        ("web/shim/gen/.keep", b""),
    ]);
    std::os::unix::fs::symlink(
        t.path().join("pkg"),
        t.path().join("web/shim/gen/dash-core-mt"),
    )
    .unwrap();
    match check_shipped_js(t.path(), &shim_files(&[]), &ShimPins { files: vec![] }) {
        Err(XtaskError::Config { path, .. }) => {
            assert_eq!(path, t.path().join("web/shim/gen/dash-core-mt"));
        }
        other => panic!("expected Config error for the symlinked directory, got {other:?}"),
    }
}

/// A symlinked file is audited through the link (its target's content and its in-tree name).
#[cfg(unix)]
#[test]
fn symlinked_web_file_is_audited() {
    let t = tree(&[
        ("outside/app.js", b"x();\n"),
        ("web/index.html", b"<html></html>\n"),
    ]);
    std::os::unix::fs::symlink(t.path().join("outside/app.js"), t.path().join("web/app.js"))
        .unwrap();
    let v = check_web_assets(t.path(), &cfg()).unwrap();
    let got: Vec<(Rule, PathBuf)> = v.iter().map(|v| (v.rule, v.path.clone())).collect();
    assert_eq!(
        got,
        vec![(Rule::JsOutsideShim, PathBuf::from("web/app.js"))]
    );
}

fn server_cfg() -> xtask::dep_audit::ServerConfig {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    xtask::dep_audit::ServerConfig {
        dirs: s(&["server"]),
        http_server_crates: s(&[
            "axum",
            "axum-core",
            "axum-extra",
            "tower-http",
            "actix-web",
            "warp",
            "poem",
            "rocket",
            "salvo",
            "tide",
        ]),
        http_server_allow: s(&["dash-gateway"]),
        http_client_crates: s(&[
            "hyper",
            "hyper-util",
            "hyper-rustls",
            "reqwest",
            "ureq",
            "isahc",
        ]),
        http_client_allow: s(&[
            "pulsusdb-client",
            "dash-notify",
            "dash-ai",
            "dash-telemetry",
            "pulsus-dash",
        ]),
        sql_crates: s(&[
            "sqlx",
            "sqlx-core",
            "sqlx-postgres",
            "sqlx-macros",
            "tokio-postgres",
            "postgres",
            "diesel",
            "sea-orm",
        ]),
        sql_allow: s(&["dash-store"]),
    }
}

#[test]
fn dep_audit_server_bans() {
    use xtask::dep_audit::{ServerGraph, ServerMember, check_server_graph};
    let member = |dir: &str, deps: &[&str]| ServerMember {
        manifest: PathBuf::from(format!("server/{dir}/Cargo.toml")),
        deps: deps.iter().map(|d| d.to_string()).collect(),
    };
    let mut g = ServerGraph::default();
    g.members.insert(
        "dash-store".into(),
        member("crates/dash-store", &["axum", "sqlx"]),
    );
    g.members.insert(
        "dash-gateway".into(),
        member("crates/dash-gateway", &["axum", "tower-http", "sqlx"]),
    );
    g.members.insert(
        "dash-config".into(),
        member("crates/dash-config", &["reqwest"]),
    );
    g.members.insert(
        "pulsus-dash".into(),
        member("bin/pulsus-dash", &["hyper-util", "hyper"]),
    );
    let v = check_server_graph(&g, &server_cfg());
    let got: Vec<(Rule, String)> = v.iter().map(|v| (v.rule, rel_str_of(&v.path))).collect();
    assert_eq!(
        got,
        vec![
            (
                Rule::ServerFrameworkOutsideGateway,
                "server/crates/dash-store/Cargo.toml".to_string()
            ),
            (
                Rule::SqlCrateOutsideStore,
                "server/crates/dash-gateway/Cargo.toml".to_string()
            ),
            (
                Rule::HttpClientOutsideAllowed,
                "server/crates/dash-config/Cargo.toml".to_string()
            ),
        ]
    );
    assert!(v[0].message.contains("dash-store") && v[0].message.contains("axum"));
    assert!(v[2].message.contains("reqwest"));
}

fn rel_str_of(p: &Path) -> String {
    xtask::rel_str(p)
}

#[test]
fn sql_outside_store_grep() {
    use xtask::dep_audit::check_sql_outside_store;
    let t = tree(&[
        (
            "server/crates/dash-gateway/src/x.rs",
            b"let q = sqlx::query(\"SELECT 1\");\n",
        ),
        (
            "server/crates/dash-store/src/y.rs",
            b"let q = sqlx::query(\"SELECT 1\");\n",
        ),
        (
            "server/crates/dash-gateway/src/ok.rs",
            b"use dash_store::Db;\n",
        ),
    ]);
    let v = check_sql_outside_store(t.path()).unwrap();
    assert_eq!(v.len(), 1, "{v:?}");
    assert_eq!(v[0].rule, Rule::SqlOutsideStore);
    assert_eq!(
        rel_str_of(&v[0].path),
        "server/crates/dash-gateway/src/x.rs"
    );
    assert_eq!(v[0].line, Some(1));
}

#[test]
fn server_bans_configured() {
    let cfg = load_config(&xtask::repo_root().unwrap()).unwrap();
    let s = cfg.server.expect("[server] in ci/dep-audit.toml");
    let want = server_cfg();
    assert_eq!(s.dirs, want.dirs);
    assert_eq!(s.http_server_allow, want.http_server_allow);
    assert_eq!(s.http_client_allow, want.http_client_allow);
    assert_eq!(s.sql_allow, want.sql_allow);
    assert_eq!(s.http_server_crates, want.http_server_crates);
    assert_eq!(s.http_client_crates, want.http_client_crates);
    assert_eq!(s.sql_crates, want.sql_crates);
}
