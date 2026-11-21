//! `cargo xtask spec-lint` (plan #68 §3.13, the `ci:spec-lint` subset; T02-001, VIZ-002, T05-004):
//!
//! - `dash-scene` has no dependency, direct or transitive, on `wgpu`, `naga` or `dash-gpu`, and its
//!   `dash-marks` edge enables no feature (the scene model stays GPU-free, T02-001);
//! - only `dash-marks` contains `.wgsl` files;
//! - the literals of `ci/lavapipe.Dockerfile` (and the toolchain channel) equal `tools.toml`.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Crates the scene model must never reach.
const GPU_CRATES: [&str; 3] = ["wgpu", "naga", "dash-gpu"];

/// `cargo metadata --format-version 1 --locked` of the workspace at `root`.
pub fn metadata(root: &Path) -> Result<Value, String> {
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let out = std::process::Command::new(cargo)
        .args(["metadata", "--format-version", "1", "--locked"])
        .current_dir(root)
        .output()
        .map_err(|e| format!("cargo metadata: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "cargo metadata: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("cargo metadata output: {e}"))
}

/// Every violation in the workspace at `root` with its metadata: the offending edge, path or
/// literal. Empty when the workspace conforms.
pub fn spec_lint(root: &Path, meta: &Value) -> Vec<String> {
    let mut out = crate_graph(meta);
    out.extend(wgsl_files(root));
    out.extend(image_literals(root));
    out
}

fn strings(v: &Value) -> BTreeSet<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// A normal or build dependency edge.
fn is_normal(kind: &Value) -> bool {
    kind.is_null() || kind == "build"
}

struct Graph<'a> {
    /// Workspace members by name.
    members: BTreeMap<&'a str, &'a Value>,
    /// Resolve graph: package id → (name, normal dependency ids).
    nodes: BTreeMap<&'a str, (&'a str, Vec<&'a str>)>,
}

impl<'a> Graph<'a> {
    fn new(meta: &'a Value) -> Self {
        let ids: BTreeSet<&str> = meta["workspace_members"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        let mut members = BTreeMap::new();
        let mut names = BTreeMap::new();
        for p in meta["packages"].as_array().into_iter().flatten() {
            let (Some(id), Some(name)) = (p["id"].as_str(), p["name"].as_str()) else {
                continue;
            };
            names.insert(id, name);
            if ids.contains(id) {
                members.insert(name, p);
            }
        }
        let mut nodes = BTreeMap::new();
        for n in meta["resolve"]["nodes"].as_array().into_iter().flatten() {
            let Some(id) = n["id"].as_str() else { continue };
            let deps = n["deps"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|d| {
                    d["dep_kinds"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|k| is_normal(&k["kind"]))
                })
                .filter_map(|d| d["pkg"].as_str())
                .collect();
            nodes.insert(id, (names.get(id).copied().unwrap_or(id), deps));
        }
        Self { members, nodes }
    }

    /// Optional dependencies enabled by `features` of member `pkg` (`dep:x`, `x/feat`, `x`, and
    /// feature names, recursively).
    fn enabled_optional(pkg: &Value, features: &BTreeSet<String>) -> BTreeSet<String> {
        let table = &pkg["features"];
        let mut on = BTreeSet::new();
        let mut todo: Vec<String> = features.iter().cloned().collect();
        let mut seen = BTreeSet::new();
        while let Some(f) = todo.pop() {
            if !seen.insert(f.clone()) {
                continue;
            }
            let Some(entries) = table[&f].as_array() else {
                on.insert(f);
                continue;
            };
            for e in entries.iter().filter_map(Value::as_str) {
                if let Some(d) = e.strip_prefix("dep:") {
                    on.insert(d.to_owned());
                } else if let Some((d, _)) = e.split_once('/') {
                    on.insert(d.trim_end_matches('?').to_owned());
                } else {
                    todo.push(e.to_owned());
                }
            }
        }
        on
    }

    /// Walks the normal dependencies of member `name` with `features`, recording every path to a
    /// GPU crate as `a → b → …`.
    fn walk(
        &self,
        name: &str,
        features: &BTreeSet<String>,
        path: &mut Vec<String>,
        out: &mut BTreeSet<String>,
    ) {
        let Some(pkg) = self.members.get(name) else {
            return;
        };
        let mut features = features.clone();
        if pkg["features"]["default"].is_array() {
            features.insert("default".into());
        }
        let optional = Self::enabled_optional(pkg, &features);
        for d in pkg["dependencies"].as_array().into_iter().flatten() {
            let Some(dep) = d["name"].as_str() else {
                continue;
            };
            if !is_normal(&d["kind"]) || (d["optional"] == true && !optional.contains(dep)) {
                continue;
            }
            path.push(dep.to_owned());
            if GPU_CRATES.contains(&dep) {
                out.insert(path.join(" → "));
            } else if self.members.contains_key(dep) {
                self.walk(dep, &strings(&d["features"]), path, out);
            } else {
                self.walk_registry(dep, path, out);
            }
            path.pop();
        }
    }

    /// A registry crate's transitive normal dependencies, from the resolve graph.
    fn walk_registry(&self, name: &str, path: &[String], out: &mut BTreeSet<String>) {
        let mut stack: Vec<&str> = self
            .nodes
            .iter()
            .filter(|(_, (n, _))| *n == name)
            .map(|(id, _)| *id)
            .collect();
        let mut seen = BTreeSet::new();
        while let Some(id) = stack.pop() {
            if !seen.insert(id) {
                continue;
            }
            for dep in self
                .nodes
                .get(id)
                .map(|(_, d)| d.as_slice())
                .unwrap_or_default()
            {
                let dep_name = self.nodes.get(dep).map_or(*dep, |(n, _)| *n);
                if GPU_CRATES.contains(&dep_name) {
                    out.insert(format!("{} → … → {dep_name}", path.join(" → ")));
                }
                stack.push(dep);
            }
        }
    }
}

fn crate_graph(meta: &Value) -> Vec<String> {
    let g = Graph::new(meta);
    let Some(scene) = g.members.get("dash-scene") else {
        return vec!["workspace: no dash-scene package".into()];
    };
    let mut out = BTreeSet::new();
    for d in scene["dependencies"].as_array().into_iter().flatten() {
        let features = strings(&d["features"]);
        if d["name"] == "dash-marks" && is_normal(&d["kind"]) && !features.is_empty() {
            out.insert(format!(
                "dash-scene → dash-marks enables features {features:?}"
            ));
        }
    }
    g.walk(
        "dash-scene",
        &BTreeSet::new(),
        &mut vec!["dash-scene".into()],
        &mut out,
    );
    out.into_iter().collect()
}

fn files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if e.file_name() != "target" {
                files(&p, out);
            }
        } else {
            out.push(p);
        }
    }
}

/// Every `.wgsl` file of the workspace outside `crates/dash-marks/`.
fn wgsl_files(root: &Path) -> Vec<String> {
    let mut all = Vec::new();
    files(root, &mut all);
    let allowed = root.join("crates").join("dash-marks");
    all.into_iter()
        .filter(|p| p.extension().is_some_and(|e| e == "wgsl") && !p.starts_with(&allowed))
        .map(|p| {
            format!(
                "{}: WGSL outside dash-marks",
                p.strip_prefix(root).unwrap_or(&p).display()
            )
        })
        .collect()
}

/// `table.key` → value of a flat TOML file (`key = "value"`; text after a closing quote ignored).
fn toml_values(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut table = String::new();
    for line in text.lines().map(str::trim).filter(|l| !l.starts_with('#')) {
        if let Some(t) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            table = t.to_owned();
        } else if let Some((k, v)) = line.split_once('=') {
            let v = v.trim();
            let v = v
                .strip_prefix('"')
                .and_then(|v| v.split_once('"'))
                .map_or(v, |(v, _)| v);
            out.insert(format!("{table}.{}", k.trim()), v.to_owned());
        }
    }
    out
}

/// The literal after `prefix` in `text`, up to whitespace or a quote (or `/` when `slash`).
fn literal_after<'a>(text: &'a str, prefix: &str, slash: bool) -> Option<&'a str> {
    let rest = &text[text.find(prefix)? + prefix.len()..];
    let stop = |c: char| c.is_whitespace() || c == '"' || c == '\'' || (slash && c == '/');
    Some(&rest[..rest.find(stop).unwrap_or(rest.len())])
}

/// The Dockerfile literals (and the toolchain channel) against `tools.toml`.
fn image_literals(root: &Path) -> Vec<String> {
    let docker = std::fs::read_to_string(root.join("ci").join("lavapipe.Dockerfile"));
    let tools = std::fs::read_to_string(root.join("tools.toml"));
    let (Ok(docker), Ok(tools)) = (docker, tools) else {
        return vec!["ci/lavapipe.Dockerfile or tools.toml missing".into()];
    };
    let tools = toml_values(&tools);
    let checks: [(&str, &str, bool); 11] = [
        ("FROM ", "golden.image", false),
        ("ARG APT_SNAPSHOT=", "golden.apt_snapshot", false),
        ("mesa-vulkan-drivers=", "golden.mesa", false),
        ("libvulkan1=", "golden.vulkan_loader", false),
        ("ca-certificates=", "golden.ca_certificates", false),
        ("libllvm20)\" = \"", "golden.llvm", false),
        ("rustup/archive/", "tools.rustup", true),
        ("echo \"", "tools.rustup_sha256", false),
        ("--default-toolchain ", "tools.rust", false),
        ("cargo-nextest@", "tools.cargo_nextest", false),
        ("cargo-deny@", "tools.cargo_deny", false),
    ];
    let mut out = Vec::new();
    for (prefix, key, slash) in checks {
        let want = tools.get(key).map(String::as_str);
        match (literal_after(&docker, prefix, slash), want) {
            (Some(got), Some(want)) if got == want => {}
            (got, want) => out.push(format!(
                "ci/lavapipe.Dockerfile: {prefix}{} but tools.toml {key} = {}",
                got.unwrap_or("(missing)"),
                want.unwrap_or("(missing)")
            )),
        }
    }
    let toolchain = std::fs::read_to_string(root.join("rust-toolchain.toml")).unwrap_or_default();
    let channel = toml_values(&toolchain).get("toolchain.channel").cloned();
    if channel.as_deref() != tools.get("tools.rust").map(String::as_str) {
        out.push(format!(
            "rust-toolchain.toml: channel {channel:?} but tools.toml tools.rust = {:?}",
            tools.get("tools.rust")
        ));
    }
    out
}
