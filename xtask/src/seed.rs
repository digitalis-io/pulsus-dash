//! Deliberately regressing seeds for the gate proofs (T05-002, plan §4.6).
//!
//! `seed` writes a committable violation for one gate and records exactly what it wrote in a
//! manifest under `target/xtask-seed/`; `unseed` undoes exactly that manifest and nothing else.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::gates::Gate;
use crate::{R, XtaskError};

/// One file operation of a seed. Paths are root-relative with `/` separators.
#[derive(Debug, Clone, Copy)]
pub enum SeedWrite {
    Create {
        path: &'static str,
        contents: &'static str,
    },
    Append {
        path: &'static str,
        text: &'static str,
    },
    /// `from` must occur exactly once, else a Config error.
    Replace {
        path: &'static str,
        from: &'static str,
        to: &'static str,
    },
    /// `"/* " + lowercase hex of xorshift64 bytes + " */\n"`.
    CreateNoise {
        path: &'static str,
        random_bytes: usize,
    },
}

impl SeedWrite {
    fn path(&self) -> &'static str {
        match self {
            SeedWrite::Create { path, .. }
            | SeedWrite::Append { path, .. }
            | SeedWrite::Replace { path, .. }
            | SeedWrite::CreateNoise { path, .. } => path,
        }
    }
}

/// The seeded violation for a gate and the marker its failing CI log must contain.
#[derive(Debug, Clone)]
pub struct Seed {
    pub gate: Gate,
    pub writes: Vec<SeedWrite>,
    pub expect: &'static str,
}

/// The seed table (#22 plan §4.6; `probe-absent`, `e2e` and the enforced `bundle-size`: #23;
/// `migrations`, `no-pulsusdb-host`, `itest`: #39 plan §3.13).
pub fn seed_for(gate: Gate) -> Seed {
    let (writes, expect) = match gate {
        Gate::Fmt => (
            vec![SeedWrite::Create {
                path: "crates/dash-tokens/tests/seeded_fmt.rs",
                contents: "pub fn seeded_fmt( ){}\n",
            }],
            "seeded_fmt",
        ),
        Gate::Build => (
            vec![SeedWrite::Append {
                path: "crates/dash-tokens/src/lib.rs",
                text: "\ncompile_error!(\"seeded violation\");\n",
            }],
            "seeded violation",
        ),
        Gate::Clippy => (
            vec![SeedWrite::Create {
                path: "crates/dash-tokens/tests/seeded_clippy.rs",
                contents: "fn seeded_clippy() -> u8 {\n    return 1;\n}\n\n#[test]\nfn seeded_clippy_runs() {\n    assert_eq!(seeded_clippy(), 1);\n}\n",
            }],
            "needless_return",
        ),
        Gate::Test => (
            vec![SeedWrite::Create {
                path: "crates/dash-tokens/tests/seeded_test.rs",
                contents: "#[test]\nfn seeded_failure() {\n    assert_eq!(1 + 1, 3, \"seeded violation\");\n}\n",
            }],
            "seeded violation",
        ),
        Gate::Wasm => (
            vec![SeedWrite::Append {
                path: "crates/dash-core-mt/src/lib.rs",
                text: "\npub use std::os::unix::ffi::OsStrExt as SeededUnixOnly;\n",
            }],
            "unix",
        ),
        Gate::BundleSize => (
            vec![SeedWrite::CreateNoise {
                path: "web/shim/seeded-size.js",
                random_bytes: 16_000,
            }],
            "bundle-over-budget",
        ),
        Gate::ProbeAbsent => (
            vec![SeedWrite::Replace {
                path: "crates/dash-core-mt/Cargo.toml",
                from: "default = []",
                to: "default = [\"probe\"]",
            }],
            "probe-present",
        ),
        Gate::DesignCheck => (
            vec![SeedWrite::Append {
                path: "designs/technical/T01-frontend-architecture.md",
                text: "\nSeeded violation: [missing](seeded-missing.md).\n",
            }],
            "seeded-missing.md",
        ),
        Gate::ShimLint => (
            vec![SeedWrite::Create {
                path: "web/shim/seeded.js",
                contents: "eval(\"1\");\n",
            }],
            "shim-forbidden-token",
        ),
        Gate::DepAudit => (
            vec![SeedWrite::Create {
                path: "web/package.json",
                contents: "{\"name\":\"seeded\",\"private\":true,\"dependencies\":{\"left-pad\":\"1.3.0\"}}\n",
            }],
            "npm-runtime-dependency",
        ),
        Gate::E2e => (
            vec![SeedWrite::Replace {
                path: "web/index.html",
                from: "Interactive charts unavailable on this browser</p>",
                to: "seeded</p>",
            }],
            "gpu_disabled_shows_fallback",
        ),
        Gate::Migrations => (
            vec![SeedWrite::Create {
                path: "server/crates/dash-store/migrations/29991231000000_seeded.sql",
                contents: "ALTER TABLE users ALTER COLUMN display_name SET NOT NULL;\n",
            }],
            "adding-not-nullable-field",
        ),
        Gate::NoPulsusdbHost => (
            vec![SeedWrite::Create {
                path: "dev/seeded-host.yaml",
                contents: "datasources_bootstrap:\n  - url: http://pulsusdb.seeded.net:8080\n",
            }],
            "pulsusdb-host",
        ),
        Gate::Itest => (
            vec![SeedWrite::Replace {
                path: "server/crates/dash-store/migrations/20261119000001_foundation.sql",
                from: "EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);",
                to: "NULL;",
            }],
            "rls_catalog_every_tenant_table",
        ),
    };
    Seed {
        gate,
        writes,
        expect,
    }
}

/// Git-ignored directory of seed manifests; manifest = `<dir>/<gate-id>.json`.
pub const SEED_MANIFEST_DIR: &str = "target/xtask-seed";

/// One undo record. File contents are UTF-8 strings (seed outputs are ASCII).
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
pub enum SeedEntry {
    /// The file did not exist.
    Created { path: String, seeded: String },
    /// An Append / Replace target.
    Modified {
        path: String,
        original: String,
        seeded: String,
    },
    /// A parent directory that did not exist; recorded deepest first.
    CreatedDir { path: String },
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SeedManifest {
    pub gate: String,
    pub entries: Vec<SeedEntry>,
}

fn manifest_path(root: &Path, gate: Gate) -> PathBuf {
    root.join(SEED_MANIFEST_DIR)
        .join(format!("{}.json", gate.id()))
}

const NOISE_SEED: u64 = 0x9E37_79B9_7F4A_7C15;

/// `n` xorshift64 bytes (little-endian words) from the fixed seed.
fn xorshift_bytes(n: usize) -> Vec<u8> {
    let mut x = NOISE_SEED;
    let mut out = Vec::with_capacity(n + 8);
    while out.len() < n {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.truncate(n);
    out
}

fn noise(n: usize) -> String {
    let hex: String = xorshift_bytes(n)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("/* {hex} */\n")
}

fn read_utf8(root: &Path, rel: &str) -> R<String> {
    let path = root.join(rel);
    let bytes =
        std::fs::read(&path).map_err(|e| XtaskError::config(rel, format!("cannot read: {e}")))?;
    String::from_utf8(bytes).map_err(|_| XtaskError::config(rel, "not UTF-8"))
}

/// Validates all writes, writes the manifest, then the files (creating parent dirs).
/// Returns the written file paths (root-relative).
pub fn seed(gate: Gate, root: &Path) -> R<Vec<PathBuf>> {
    let manifest = manifest_path(root, gate);
    if manifest.exists() {
        return Err(XtaskError::config(
            &manifest,
            format!(
                "a seed for {} is already recorded; run `cargo xtask unseed {}`",
                gate.id(),
                gate.id()
            ),
        ));
    }
    let mut entries = Vec::new();
    let mut new_dirs: BTreeSet<PathBuf> = BTreeSet::new();
    let mut plan: Vec<(&'static str, String)> = Vec::new();
    for w in seed_for(gate).writes {
        let rel = w.path();
        let path = root.join(rel);
        let (seeded, entry) = match w {
            SeedWrite::Create { contents, .. } => (contents.to_string(), None),
            SeedWrite::CreateNoise { random_bytes, .. } => (noise(random_bytes), None),
            SeedWrite::Append { text, .. } => {
                let original = read_utf8(root, rel)?;
                (format!("{original}{text}"), Some(original))
            }
            SeedWrite::Replace { from, to, .. } => {
                let original = read_utf8(root, rel)?;
                let n = original.matches(from).count();
                if n != 1 {
                    return Err(XtaskError::config(
                        rel,
                        format!("expected exactly one `{from}`, found {n}"),
                    ));
                }
                (original.replacen(from, to, 1), Some(original))
            }
        };
        match entry {
            None => {
                if path.exists() {
                    return Err(XtaskError::config(rel, "seed target already exists"));
                }
                let mut dir = Path::new(rel).parent();
                while let Some(d) = dir.filter(|d| !d.as_os_str().is_empty()) {
                    if !root.join(d).exists() {
                        new_dirs.insert(d.to_path_buf());
                    }
                    dir = d.parent();
                }
                entries.push(SeedEntry::Created {
                    path: rel.to_string(),
                    seeded: seeded.clone(),
                });
            }
            Some(original) => entries.push(SeedEntry::Modified {
                path: rel.to_string(),
                original,
                seeded: seeded.clone(),
            }),
        }
        plan.push((rel, seeded));
    }
    let mut dirs: Vec<PathBuf> = new_dirs.into_iter().collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    entries.extend(dirs.into_iter().map(|d| SeedEntry::CreatedDir {
        path: crate::rel_str(&d),
    }));
    let record = SeedManifest {
        gate: gate.id().to_string(),
        entries,
    };
    let json = serde_json::to_string_pretty(&record)
        .map_err(|e| XtaskError::config(&manifest, e.to_string()))?;
    if let Some(parent) = manifest.parent() {
        std::fs::create_dir_all(parent).map_err(XtaskError::io(parent))?;
    }
    std::fs::write(&manifest, json).map_err(XtaskError::io(&manifest))?;
    let mut written = Vec::new();
    for (rel, contents) in plan {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(XtaskError::io(parent))?;
        }
        std::fs::write(&path, contents).map_err(XtaskError::io(&path))?;
        written.push(PathBuf::from(rel));
    }
    Ok(written)
}

/// Undoes exactly the manifest; touches no other path. Returns the restored/removed file paths.
pub fn unseed(gate: Gate, root: &Path) -> R<Vec<PathBuf>> {
    let manifest = manifest_path(root, gate);
    let text = std::fs::read_to_string(&manifest).map_err(|_| {
        XtaskError::config(&manifest, format!("no seed recorded for {}", gate.id()))
    })?;
    let record: SeedManifest =
        serde_json::from_str(&text).map_err(|e| XtaskError::config(&manifest, e.to_string()))?;
    for e in &record.entries {
        if let SeedEntry::Created { path, seeded } | SeedEntry::Modified { path, seeded, .. } = e {
            let current = std::fs::read(root.join(path)).ok();
            if current.as_deref() != Some(seeded.as_bytes()) {
                return Err(XtaskError::config(
                    path,
                    format!("{path} changed since seeding"),
                ));
            }
        }
    }
    let mut done = Vec::new();
    for e in &record.entries {
        match e {
            SeedEntry::Created { path, .. } => {
                let p = root.join(path);
                std::fs::remove_file(&p).map_err(XtaskError::io(&p))?;
                done.push(PathBuf::from(path));
            }
            SeedEntry::Modified { path, original, .. } => {
                let p = root.join(path);
                std::fs::write(&p, original).map_err(XtaskError::io(&p))?;
                done.push(PathBuf::from(path));
            }
            SeedEntry::CreatedDir { .. } => {}
        }
    }
    for e in &record.entries {
        if let SeedEntry::CreatedDir { path } = e {
            let p = root.join(path);
            let empty = std::fs::read_dir(&p)
                .map(|mut d| d.next().is_none())
                .unwrap_or(false);
            if empty {
                std::fs::remove_dir(&p).map_err(XtaskError::io(&p))?;
            } else if p.exists() {
                println!("kept {path} (not empty)");
            }
        }
    }
    std::fs::remove_file(&manifest).map_err(XtaskError::io(&manifest))?;
    Ok(done)
}
