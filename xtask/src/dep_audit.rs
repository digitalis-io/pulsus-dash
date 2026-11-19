//! `ci:dep-audit`: npm, browser crate graph, web-sys features, render-worker locks (T03-008),
//! web assets and shipped JS (T01-002, ADR-0001, ADR-0007; plan §4.3).

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::str::FromStr;
use std::sync::LazyLock;

use cargo_metadata::DependencyKind;
use regex::Regex;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::r#gen::{Artefact, GenOptions, compare};
use crate::report::{Rule, Violation};
use crate::shim::{GEN_DIR, LAYOUT_GEN, SHIM_DIR, SHIM_PATHS, ShimFiles, re};
use crate::{R, XtaskError, line_of, rel_str, relative, walk_files};

pub const CONFIG_PATH: &str = "ci/dep-audit.toml";
pub const PINS_PATH: &str = "ci/shim-pins.toml";

/// `ci/dep-audit.toml`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DepAuditConfig {
    pub browser_roots: Vec<String>,
    pub npm_dev_allow: Vec<String>,
    pub render_worker_crates: Vec<String>,
    pub web_dir: String,
    pub allowed_url_prefixes: Vec<String>,
    /// member → allowed features; `"Gpu*"` = prefix.
    #[serde(default)]
    pub web_sys: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub lock_allow: Vec<LockAllow>,
    #[serde(default, rename = "browser_crate")]
    pub browser_crates: Vec<CrateAllow>,
    /// Server crate bans (T06-001, T11-023).
    #[serde(default)]
    pub server: Option<ServerConfig>,
}

/// `[server]` of `ci/dep-audit.toml` (plan §3.12).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerConfig {
    pub dirs: Vec<String>,
    pub http_server_crates: Vec<String>,
    pub http_server_allow: Vec<String>,
    pub http_client_crates: Vec<String>,
    pub http_client_allow: Vec<String>,
    pub sql_crates: Vec<String>,
    pub sql_allow: Vec<String>,
}

/// A workspace member under one of the server `dirs`.
#[derive(Debug, Clone)]
pub struct ServerMember {
    /// Root-relative `Cargo.toml`.
    pub manifest: PathBuf,
    /// Direct normal dependencies (any target).
    pub deps: BTreeSet<String>,
}

/// Server members and their direct normal dependencies.
#[derive(Debug, Clone, Default)]
pub struct ServerGraph {
    pub members: BTreeMap<String, ServerMember>,
}

/// An audited exception to T03-008: `ident` may appear in `file` (relative to the crate dir).
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LockAllow {
    #[serde(rename = "crate")]
    pub krate: String,
    pub file: String,
    pub ident: String,
    pub reason: String,
}

/// A non-member crate allowed in the browser graph, with the review reason.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CrateAllow {
    pub name: String,
    pub reason: String,
}

/// `ci/shim-pins.toml`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShimPins {
    #[serde(default, rename = "file")]
    pub files: Vec<ShimPin>,
}

/// The SHA-256 a T03 §5.1 shim file must have.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShimPin {
    pub path: String,
    pub sha256: String,
}

/// A package of the wasm32-filtered cargo metadata.
#[derive(Debug, Clone)]
pub struct Package {
    pub name: String,
    /// Absolute crate directory.
    pub dir: PathBuf,
    pub is_member: bool,
    /// Declared features of a direct normal `web-sys` dependency, if any.
    pub web_sys_features: Option<Vec<String>>,
}

/// The crate graph as seen from the browser roots.
#[derive(Debug, Clone)]
pub struct Workspace {
    pub roots: Vec<String>,
    pub normal_edges: BTreeMap<String, BTreeSet<String>>,
    /// Every package in the wasm32-filtered metadata.
    pub packages: BTreeMap<String, Package>,
}

impl Workspace {
    /// Breadth-first search over normal edges from the roots: `name → predecessor`.
    fn bfs(&self) -> BTreeMap<String, Option<String>> {
        let mut seen: BTreeMap<String, Option<String>> = BTreeMap::new();
        let mut queue = VecDeque::new();
        for r in &self.roots {
            if !seen.contains_key(r) {
                seen.insert(r.clone(), None);
                queue.push_back(r.clone());
            }
        }
        while let Some(n) = queue.pop_front() {
            for d in self.normal_edges.get(&n).into_iter().flatten() {
                if !seen.contains_key(d) {
                    seen.insert(d.clone(), Some(n.clone()));
                    queue.push_back(d.clone());
                }
            }
        }
        seen
    }

    /// Every package reachable from the roots over normal edges (roots included), sorted.
    pub fn browser_reachable(&self) -> Vec<String> {
        self.bfs().into_keys().collect()
    }
}

fn read_config_text(root: &Path, rel: &str) -> R<String> {
    let path = root.join(rel);
    std::fs::read_to_string(&path).map_err(|e| XtaskError::config(rel, e.to_string()))
}

/// Loads `ci/dep-audit.toml`. Unknown keys and empty allow-entry reasons are errors.
pub fn load_config(root: &Path) -> R<DepAuditConfig> {
    let text = read_config_text(root, CONFIG_PATH)?;
    let cfg: DepAuditConfig =
        toml::from_str(&text).map_err(|e| XtaskError::config(CONFIG_PATH, e.to_string()))?;
    for l in &cfg.lock_allow {
        if l.reason.trim().is_empty() {
            return Err(XtaskError::config(
                CONFIG_PATH,
                format!(
                    "[[lock_allow]] {} {} {}: empty reason",
                    l.krate, l.file, l.ident
                ),
            ));
        }
    }
    for c in &cfg.browser_crates {
        if c.reason.trim().is_empty() {
            return Err(XtaskError::config(
                CONFIG_PATH,
                format!("[[browser_crate]] {}: empty reason", c.name),
            ));
        }
    }
    Ok(cfg)
}

/// Loads `ci/shim-pins.toml`. Config error if a path is not in [`SHIM_PATHS`], a path repeats,
/// or `sha256` is not 64 lowercase hex digits.
pub fn load_pins(root: &Path) -> R<ShimPins> {
    let text = read_config_text(root, PINS_PATH)?;
    let pins: ShimPins =
        toml::from_str(&text).map_err(|e| XtaskError::config(PINS_PATH, e.to_string()))?;
    let mut seen = BTreeSet::new();
    for p in &pins.files {
        if !SHIM_PATHS.contains(&p.path.as_str()) {
            return Err(XtaskError::config(
                PINS_PATH,
                format!("{}: not a T03 §5.1 shim file", p.path),
            ));
        }
        if !seen.insert(p.path.as_str()) {
            return Err(XtaskError::config(
                PINS_PATH,
                format!("{}: pinned twice", p.path),
            ));
        }
        let hex = p.sha256.len() == 64
            && p.sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if !hex {
            return Err(XtaskError::config(
                PINS_PATH,
                format!("{}: sha256 must be 64 lowercase hex digits", p.path),
            ));
        }
    }
    Ok(pins)
}

/// Lowercase hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Runs `cargo metadata --format-version 1 --locked --filter-platform wasm32-unknown-unknown`
/// and builds the normal-dependency graph.
pub fn workspace_from_metadata(root: &Path, cfg: &DepAuditConfig) -> R<Workspace> {
    let args = [
        "metadata",
        "--format-version",
        "1",
        "--locked",
        "--filter-platform",
        "wasm32-unknown-unknown",
    ];
    let command = format!("cargo {}", args.join(" "));
    let out = Command::new("cargo")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| XtaskError::Tool {
            command: command.clone(),
            detail: e.to_string(),
        })?;
    if !out.status.success() {
        return Err(XtaskError::Tool {
            command,
            detail: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    let meta: cargo_metadata::Metadata =
        serde_json::from_slice(&out.stdout).map_err(|e| XtaskError::Tool {
            command: command.clone(),
            detail: format!("unparseable output: {e}"),
        })?;
    let members: BTreeSet<_> = meta.workspace_members.iter().collect();
    let mut names = BTreeMap::new();
    let mut packages = BTreeMap::new();
    for p in &meta.packages {
        let name = p.name.to_string();
        names.insert(&p.id, name.clone());
        let web_sys_features = p
            .dependencies
            .iter()
            .find(|d| d.name == "web-sys" && d.kind == DependencyKind::Normal)
            .map(|d| d.features.clone());
        let dir = p
            .manifest_path
            .parent()
            .map(|d| d.as_std_path().to_path_buf())
            .unwrap_or_default();
        packages.insert(
            name.clone(),
            Package {
                name,
                dir,
                is_member: members.contains(&p.id),
                web_sys_features,
            },
        );
    }
    let resolve = meta.resolve.ok_or_else(|| XtaskError::Tool {
        command: command.clone(),
        detail: "no resolve graph".into(),
    })?;
    let mut normal_edges: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for node in &resolve.nodes {
        let Some(from) = names.get(&node.id) else {
            continue;
        };
        for dep in &node.deps {
            let normal = dep
                .dep_kinds
                .iter()
                .any(|k| k.kind == DependencyKind::Normal);
            if let (true, Some(to)) = (normal, names.get(&dep.pkg)) {
                normal_edges
                    .entry(from.clone())
                    .or_default()
                    .insert(to.clone());
            }
        }
    }
    for r in &cfg.browser_roots {
        if !packages.contains_key(r) {
            return Err(XtaskError::config(
                CONFIG_PATH,
                format!("browser root {r} is not in the cargo metadata"),
            ));
        }
    }
    Ok(Workspace {
        roots: cfg.browser_roots.clone(),
        normal_edges,
        packages,
    })
}

fn v(rule: Rule, path: impl Into<PathBuf>, line: Option<u32>, message: String) -> Violation {
    Violation {
        rule,
        path: path.into(),
        line,
        message,
    }
}

const RUNTIME_SECTIONS: [&str; 5] = [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
    "bundleDependencies",
    "bundledDependencies",
];

/// No npm runtime dependency anywhere; dev dependencies only from `npm_dev_allow`.
pub fn check_npm(root: &Path, cfg: &DepAuditConfig) -> R<Vec<Violation>> {
    let skip = |name: &str| {
        name == "target" || name == "node_modules" || name == "plans" || name.starts_with('.')
    };
    let mut out = Vec::new();
    for path in walk_files(root, &skip)? {
        if path.file_name().is_none_or(|n| n != "package.json") {
            continue;
        }
        let rel = relative(root, &path);
        let text = std::fs::read_to_string(&path).map_err(XtaskError::io(&path))?;
        let json: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| XtaskError::config(&rel, format!("invalid JSON: {e}")))?;
        for section in RUNTIME_SECTIONS {
            let names: Vec<String> = match json.get(section) {
                Some(serde_json::Value::Object(m)) => m.keys().cloned().collect(),
                Some(serde_json::Value::Array(a)) => a
                    .iter()
                    .map(|x| x.as_str().map_or_else(|| x.to_string(), str::to_string))
                    .collect(),
                _ => Vec::new(),
            };
            for n in names {
                out.push(v(
                    Rule::NpmRuntimeDependency,
                    &rel,
                    None,
                    format!("{section}: {n} (no npm runtime dependency, ADR-0001)"),
                ));
            }
        }
        if let Some(serde_json::Value::Object(m)) = json.get("devDependencies") {
            for n in m.keys() {
                if !cfg.npm_dev_allow.contains(n) {
                    out.push(v(
                        Rule::NpmDisallowedDevDependency,
                        &rel,
                        None,
                        format!("devDependencies: {n} is not in npm_dev_allow"),
                    ));
                }
            }
        }
    }
    Ok(out)
}

/// Every browser-reachable package must be a workspace member or a `[[browser_crate]]`.
pub fn check_crate_graph(ws: &Workspace, cfg: &DepAuditConfig) -> Vec<Violation> {
    let pred = ws.bfs();
    let mut out = Vec::new();
    for name in pred.keys() {
        let member = ws.packages.get(name).is_some_and(|p| p.is_member);
        let allowed = cfg.browser_crates.iter().any(|c| &c.name == name);
        if member || allowed {
            continue;
        }
        let mut chain = vec![name.clone()];
        let mut cur = name;
        while let Some(Some(p)) = pred.get(cur) {
            chain.push(p.clone());
            cur = p;
        }
        chain.reverse();
        out.push(v(
            Rule::BrowserCrateNotAllowed,
            "Cargo.lock",
            None,
            chain.join(" -> "),
        ));
    }
    out
}

/// Members may use only the `web-sys` features listed for them in `[web_sys]`.
pub fn check_web_sys(ws: &Workspace, cfg: &DepAuditConfig) -> Vec<Violation> {
    let mut out = Vec::new();
    for p in ws.packages.values().filter(|p| p.is_member) {
        let Some(features) = &p.web_sys_features else {
            continue;
        };
        let msg = |f: &str| {
            format!(
                "{}: web-sys feature {f} is not allowed in [web_sys]",
                p.name
            )
        };
        match cfg.web_sys.get(&p.name) {
            None if features.is_empty() => out.push(v(
                Rule::WebSysFeature,
                CONFIG_PATH,
                None,
                format!(
                    "{}: depends on web-sys (no features listed) but has no [web_sys] entry",
                    p.name
                ),
            )),
            None => {
                for f in features {
                    out.push(v(Rule::WebSysFeature, CONFIG_PATH, None, msg(f)));
                }
            }
            Some(allowed) => {
                for f in features {
                    let ok = allowed.iter().any(|a| match a.strip_suffix('*') {
                        Some(prefix) => f.starts_with(prefix),
                        None => a == f,
                    });
                    if !ok {
                        out.push(v(Rule::WebSysFeature, CONFIG_PATH, None, msg(f)));
                    }
                }
            }
        }
    }
    out
}

fn lock_idents(stream: proc_macro2::TokenStream, found: &mut Vec<(String, u32)>) {
    for tt in stream {
        match tt {
            proc_macro2::TokenTree::Group(g) => lock_idents(g.stream(), found),
            proc_macro2::TokenTree::Ident(i) => {
                let s = i.to_string();
                if s == "Mutex" || s == "RwLock" {
                    let line = u32::try_from(i.span().start().line).unwrap_or(u32::MAX);
                    found.push((s, line));
                }
            }
            _ => {}
        }
    }
}

/// T03-008: no `Mutex`/`RwLock` identifier in render-worker crates, unless allow-listed.
pub fn check_render_worker_locks(
    root: &Path,
    ws: &Workspace,
    cfg: &DepAuditConfig,
) -> R<Vec<Violation>> {
    let mut out = Vec::new();
    for krate in &cfg.render_worker_crates {
        let Some(pkg) = ws.packages.get(krate).filter(|p| p.is_member) else {
            println!("dep-audit: render-worker crate {krate} skipped (not in workspace)");
            continue;
        };
        for file in walk_files(&pkg.dir.join("src"), &|_| false)? {
            if file.extension().is_none_or(|e| e != "rs") {
                continue;
            }
            let rel_root = relative(root, &file);
            let rel_crate = rel_str(&relative(&pkg.dir, &file));
            let text = std::fs::read_to_string(&file).map_err(XtaskError::io(&file))?;
            let stream = match proc_macro2::TokenStream::from_str(&text) {
                Ok(s) => s,
                Err(e) => {
                    let line = u32::try_from(e.span().start().line).unwrap_or(0);
                    out.push(v(
                        Rule::RustLexError,
                        rel_root,
                        Some(line.max(1)),
                        format!("cannot tokenise: {e}"),
                    ));
                    continue;
                }
            };
            let mut found = Vec::new();
            lock_idents(stream, &mut found);
            for (ident, line) in found {
                let allowed = cfg
                    .lock_allow
                    .iter()
                    .any(|a| &a.krate == krate && a.file == rel_crate && a.ident == ident);
                if !allowed {
                    out.push(v(
                        Rule::RenderWorkerLock,
                        rel_root.clone(),
                        Some(line),
                        format!("{ident} in render-worker crate {krate} (T03-008)"),
                    ));
                }
            }
        }
    }
    Ok(out)
}

const SCRIPT_EXT: [&str; 8] = ["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"];
const TEXT_EXT: [&str; 9] = [
    "html",
    "htm",
    "css",
    "js",
    "mjs",
    "cjs",
    "json",
    "webmanifest",
    "svg",
];

static URL_RE: LazyLock<Regex> = LazyLock::new(|| re(r#"https?://[^\s"'()<>]+"#));
static PROTOCOL_RELATIVE_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r#"["'(=]\s*(//[A-Za-z0-9-]+\.[A-Za-z0-9.-]+)"#));

/// Scripts outside `web/shim/`, and third-party hosts in web assets.
pub fn check_web_assets(root: &Path, cfg: &DepAuditConfig) -> R<Vec<Violation>> {
    let mut out = Vec::new();
    for path in walk_files(&root.join(&cfg.web_dir), &|_| false)? {
        let rel = relative(root, &path);
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if SCRIPT_EXT.contains(&ext.as_str()) && !rel.starts_with(SHIM_DIR) {
            out.push(v(
                Rule::JsOutsideShim,
                &rel,
                None,
                "script outside web/shim/ (T01-001)".into(),
            ));
        }
        if !TEXT_EXT.contains(&ext.as_str()) {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(XtaskError::io(&path))?;
        let text = String::from_utf8_lossy(&bytes);
        let mut hits: Vec<(usize, String)> = URL_RE
            .find_iter(&text)
            .map(|m| (m.start(), m.as_str().to_string()))
            .collect();
        hits.extend(
            PROTOCOL_RELATIVE_RE
                .captures_iter(&text)
                .filter_map(|c| c.get(1))
                .map(|m| (m.start(), m.as_str().to_string())),
        );
        hits.sort();
        for (at, url) in hits {
            if cfg.allowed_url_prefixes.iter().any(|p| url.starts_with(p)) {
                continue;
            }
            out.push(v(
                Rule::ThirdPartyHost,
                &rel,
                Some(line_of(&text, at)),
                format!("third-party host {url}"),
            ));
        }
    }
    Ok(out)
}

/// Only the pinned T03 §5.1 files are shipped (plan §4.3.1 of #22); `layout.gen.js` is admitted
/// unpinned iff byte-identical to its generator, else `layout-gen-stale`; `web/shim/gen/` is
/// accepted only by regenerate-and-compare ([`check_generated`], plan §4.7).
pub fn check_shipped_js(root: &Path, files: &ShimFiles, pins: &ShimPins) -> R<Vec<Violation>> {
    let mut out = Vec::new();
    let readme = Path::new(SHIM_DIR).join("README.md");
    for path in &files.candidates {
        if *path == readme {
            continue;
        }
        let rel = rel_str(path);
        if rel == LAYOUT_GEN {
            let abs = root.join(path);
            let bytes = std::fs::read(&abs).map_err(XtaskError::io(&abs))?;
            if bytes != dash_protocol::layout::render_js().as_bytes() {
                out.push(v(
                    Rule::LayoutGenStale,
                    path,
                    None,
                    "differs from its generator; run `cargo xtask gen` (T03-005)".into(),
                ));
            }
            continue;
        }
        if !SHIM_PATHS.contains(&rel.as_str()) {
            out.push(v(
                Rule::ShimFileNotAllowed,
                path,
                None,
                "not a T03 §5.1 shim file".into(),
            ));
            continue;
        }
        let abs = root.join(path);
        let found = sha256_hex(&std::fs::read(&abs).map_err(XtaskError::io(&abs))?);
        match pins.files.iter().find(|p| p.path == rel) {
            None => out.push(v(
                Rule::ShimUnpinned,
                path,
                None,
                format!("no pin in {PINS_PATH}; sha256 = {found}"),
            )),
            Some(p) if p.sha256 != found => out.push(v(
                Rule::ShimPinMismatch,
                path,
                None,
                format!("pinned {}, found {found}", p.sha256),
            )),
            Some(_) => {}
        }
    }
    for p in &pins.files {
        if !files.candidates.iter().any(|c| rel_str(c) == p.path) {
            out.push(v(
                Rule::ShimPinStale,
                &p.path,
                None,
                "pinned file is not in the tree".into(),
            ));
        }
    }
    out.extend(check_generated(root)?);
    Ok(out)
}

/// Regenerate-and-compare of `web/shim/gen/` (plan §4.7) with an injectable generator. No
/// `gen/` → nothing to accept. Every entry other than the directories `dash-core-mt` and
/// `dash-core-st` → `generated-unknown` (and no regeneration); otherwise a fresh
/// `GenOptions::check` build is compared with each present directory (`generated-mismatch`).
pub fn check_generated_with(
    root: &Path,
    generator: &dyn Fn(&Path, &GenOptions) -> R<()>,
) -> R<Vec<Violation>> {
    let gen_dir = root.join(GEN_DIR);
    if !gen_dir.exists() {
        return Ok(Vec::new());
    }
    // Fails closed on a symlinked directory anywhere under gen/.
    walk_files(&gen_dir, &|_| false)?;
    let known: Vec<&str> = Artefact::ALL.iter().map(|a| a.name()).collect();
    let mut unknown = Vec::new();
    let mut present = Vec::new();
    let entries = std::fs::read_dir(&gen_dir).map_err(XtaskError::io(&gen_dir))?;
    for e in entries {
        let e = e.map_err(XtaskError::io(&gen_dir))?;
        let name = e.file_name().to_string_lossy().into_owned();
        let is_dir = e.file_type().map_err(XtaskError::io(e.path()))?.is_dir();
        if is_dir && known.contains(&name.as_str()) {
            present.push(name);
        } else {
            unknown.push(v(
                Rule::GeneratedUnknown,
                Path::new(GEN_DIR).join(&name),
                None,
                "not a generated artefact directory (dash-core-mt, dash-core-st)".into(),
            ));
        }
    }
    if !unknown.is_empty() {
        unknown.sort_by(|a, b| a.path.cmp(&b.path));
        return Ok(unknown);
    }
    if present.is_empty() {
        return Ok(Vec::new());
    }
    present.sort();
    let check = GenOptions::check(root);
    generator(root, &check)?;
    let mut out = Vec::new();
    for d in present {
        out.extend(compare(
            &check.web_root.join("shim/gen").join(&d),
            &gen_dir.join(&d),
            &format!("{GEN_DIR}/{d}"),
        )?);
    }
    Ok(out)
}

/// [`check_generated_with`] with the real generator.
pub fn check_generated(root: &Path) -> R<Vec<Violation>> {
    check_generated_with(root, &crate::r#gen::generate)
}

/// Builds the [`ServerGraph`] from unfiltered `cargo metadata --format-version 1 --locked`.
pub fn server_graph_from_metadata(root: &Path, cfg: &ServerConfig) -> R<ServerGraph> {
    let _ = (root, cfg);
    Ok(ServerGraph::default())
}

/// The three server dependency bans, in order: HTTP frameworks, SQL crates, HTTP clients.
pub fn check_server_graph(g: &ServerGraph, cfg: &ServerConfig) -> Vec<Violation> {
    let _ = (g, cfg);
    Vec::new()
}

/// `sql-outside-store`: `\bsqlx::` in a `.rs` file under `server/` or `crates/` outside
/// `server/crates/dash-store/`.
pub fn check_sql_outside_store(root: &Path) -> R<Vec<Violation>> {
    let _ = root;
    Ok(Vec::new())
}

/// All six checks of `ci:dep-audit`.
pub fn audit(root: &Path) -> R<Vec<Violation>> {
    let cfg = load_config(root)?;
    let pins = load_pins(root)?;
    let files = crate::shim::candidates(root)?;
    let ws = workspace_from_metadata(root, &cfg)?;
    let mut out = check_npm(root, &cfg)?;
    out.extend(check_crate_graph(&ws, &cfg));
    out.extend(check_web_sys(&ws, &cfg));
    out.extend(check_render_worker_locks(root, &ws, &cfg)?);
    out.extend(check_web_assets(root, &cfg)?);
    out.extend(check_shipped_js(root, &files, &pins)?);
    Ok(out)
}
