//! `ci:bundle-size`: brotli sizes against the T03 §7.3 budgets (PRF-009, PRF-033; plan §4.4).

use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::report::{Rule, Violation};
use crate::{R, XtaskError, rel_str, relative, walk_files};

pub const CONFIG_PATH: &str = "ci/bundle-budgets.toml";

/// `report`: findings are warnings, the gate never fails. `enforce`: findings fail the gate.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Report,
    Enforce,
}

impl Mode {
    fn word(self) -> &'static str {
        match self {
            Mode::Report => "report",
            Mode::Enforce => "enforce",
        }
    }
}

/// `ci/bundle-budgets.toml`.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BundleConfig {
    pub mode: Mode,
    pub eager_total_bytes: u64,
    #[serde(rename = "artefact")]
    pub artefacts: Vec<ArtefactBudget>,
}

/// One T03 §7.3 row mapped to files.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ArtefactBudget {
    pub name: String,
    /// First cell of the T03 §7.3 row, verbatim.
    pub t03_row: String,
    /// Glob of dirs/files; each match is measured separately.
    #[serde(default)]
    pub instances: Option<String>,
    /// Root-relative globs; relative to each instance if `instances` is set (`.` = the instance).
    pub files: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    pub budget_bytes: u64,
    pub eager: bool,
    /// Enforce mode only: absence fails.
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArtefactStatus {
    Ok,
    OverBudget,
    Absent,
}

impl ArtefactStatus {
    fn word(&self) -> &'static str {
        match self {
            ArtefactStatus::Ok => "ok",
            ArtefactStatus::OverBudget => "over budget",
            ArtefactStatus::Absent => "absent",
        }
    }
}

/// A measured row: `"<name>"` or `"<name> [<instance path>]"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtefactSize {
    pub name: String,
    pub raw_bytes: u64,
    pub brotli_bytes: u64,
    pub budget_bytes: u64,
    pub status: ArtefactStatus,
}

/// Result of [`measure`]; the gate fails iff `violations` is non-empty.
#[derive(Debug, Clone)]
pub struct BundleReport {
    pub mode: Mode,
    pub artefacts: Vec<ArtefactSize>,
    pub eager_total_brotli: u64,
    pub eager_total_budget: u64,
    pub violations: Vec<Violation>,
    pub warnings: Vec<Violation>,
}

/// Loads `ci/bundle-budgets.toml`.
pub fn load_config(root: &Path) -> R<BundleConfig> {
    let text = std::fs::read_to_string(root.join(CONFIG_PATH))
        .map_err(|e| XtaskError::config(CONFIG_PATH, e.to_string()))?;
    toml::from_str(&text).map_err(|e| XtaskError::config(CONFIG_PATH, e.to_string()))
}

/// Brotli size at quality 11, window 24 (what a static server would serve).
pub fn brotli_len(bytes: &[u8]) -> u64 {
    let mut w = brotli::CompressorWriter::new(Vec::new(), 4096, 11, 24);
    match w.write_all(bytes) {
        Ok(()) => w.into_inner().len() as u64,
        // Writing into a Vec cannot fail; if it ever did, count the raw size (an over-estimate).
        Err(_) => bytes.len() as u64,
    }
}

/// Regular files matching `pattern` under `base`, as absolute paths. A matched directory stands
/// for every file under it (so `gen/**` covers the whole tree, as `**` alone matches directories).
fn expand(base: &Path, pattern: &str) -> R<BTreeSet<PathBuf>> {
    let mut out = BTreeSet::new();
    if pattern == "." {
        if base.is_file() {
            out.insert(base.to_path_buf());
        }
        return Ok(out);
    }
    // A trailing `/**` means "everything under": glob the directory part and walk it (the glob
    // crate yields no matches for a trailing `**`).
    let paths = match pattern.strip_suffix("**") {
        Some("") => vec![base.to_path_buf()],
        Some(dir) if dir.ends_with('/') => glob_paths(base, dir.trim_end_matches('/'))?,
        _ => glob_paths(base, pattern)?,
    };
    for p in paths {
        if p.is_file() {
            out.insert(p);
        } else if p.is_dir() {
            out.extend(walk_files(&p, &|_| false)?);
        }
    }
    Ok(out)
}

/// Every path (file or directory) matching `pattern` under `base`, sorted.
fn glob_paths(base: &Path, pattern: &str) -> R<Vec<PathBuf>> {
    let full = format!(
        "{}/{pattern}",
        glob::Pattern::escape(&base.to_string_lossy())
    );
    let paths = glob::glob(&full)
        .map_err(|e| XtaskError::config(CONFIG_PATH, format!("{pattern}: {e}")))?;
    let mut out = Vec::new();
    for p in paths {
        let p = p.map_err(|e| XtaskError::Io {
            path: e.path().to_path_buf(),
            source: std::io::Error::other(e.to_string()),
        })?;
        out.push(p);
    }
    out.sort();
    Ok(out)
}

fn finding(rule: Rule, message: String) -> Violation {
    Violation {
        rule,
        path: PathBuf::from(CONFIG_PATH),
        line: None,
        message,
    }
}

/// Measures every artefact (plan §4.4).
pub fn measure(root: &Path, cfg: &BundleConfig) -> R<BundleReport> {
    let mut rows = Vec::new();
    let mut findings = Vec::new();
    let mut violations = Vec::new();
    let mut eager_total = 0u64;
    for a in &cfg.artefacts {
        let instances: Vec<(PathBuf, String)> = match &a.instances {
            None => vec![(root.to_path_buf(), a.name.clone())],
            Some(g) => glob_paths(root, g)?
                .into_iter()
                .map(|p| {
                    let name = format!("{} [{}]", a.name, rel_str(&relative(root, &p)));
                    (p, name)
                })
                .collect(),
        };
        if instances.is_empty() {
            rows.push(absent(a, a.name.clone(), cfg.mode, &mut violations));
            continue;
        }
        for (base, name) in instances {
            let mut files = BTreeSet::new();
            for f in &a.files {
                files.extend(expand(&base, f)?);
            }
            for x in &a.exclude {
                for p in expand(&base, x)? {
                    files.remove(&p);
                }
            }
            if files.is_empty() {
                rows.push(absent(a, name, cfg.mode, &mut violations));
                continue;
            }
            let (mut raw, mut br) = (0u64, 0u64);
            for f in &files {
                let bytes = std::fs::read(f).map_err(XtaskError::io(f))?;
                raw += bytes.len() as u64;
                br += brotli_len(&bytes);
            }
            let status = if br > a.budget_bytes {
                findings.push(format!("{name}: {br} > {}", a.budget_bytes));
                ArtefactStatus::OverBudget
            } else {
                ArtefactStatus::Ok
            };
            if a.eager {
                eager_total += br;
            }
            rows.push(ArtefactSize {
                name,
                raw_bytes: raw,
                brotli_bytes: br,
                budget_bytes: a.budget_bytes,
                status,
            });
        }
    }
    if eager_total > cfg.eager_total_bytes {
        findings.push(format!(
            "eager total: {eager_total} > {}",
            cfg.eager_total_bytes
        ));
    }
    let findings: Vec<Violation> = findings
        .into_iter()
        .map(|m| finding(Rule::BundleOverBudget, m))
        .collect();
    let warnings = match cfg.mode {
        Mode::Report => findings,
        Mode::Enforce => {
            violations.extend(findings);
            Vec::new()
        }
    };
    Ok(BundleReport {
        mode: cfg.mode,
        artefacts: rows,
        eager_total_brotli: eager_total,
        eager_total_budget: cfg.eager_total_bytes,
        violations,
        warnings,
    })
}

fn absent(
    a: &ArtefactBudget,
    name: String,
    mode: Mode,
    violations: &mut Vec<Violation>,
) -> ArtefactSize {
    if mode == Mode::Enforce && a.required {
        violations.push(finding(
            Rule::BundleArtefactAbsent,
            format!("{name}: required artefact absent"),
        ));
    }
    ArtefactSize {
        name,
        raw_bytes: 0,
        brotli_bytes: 0,
        budget_bytes: a.budget_bytes,
        status: ArtefactStatus::Absent,
    }
}

/// The step-summary table.
pub fn render_markdown(r: &BundleReport) -> String {
    let mut s = format!(
        "### Bundle size (brotli) — mode: {}\n\n| Artefact | Raw (bytes) | Brotli (bytes) | Budget (bytes) | Status |\n|---|---:|---:|---:|---|\n",
        r.mode.word()
    );
    for a in &r.artefacts {
        s.push_str(&format!(
            "| {} | {} | {} | {} | {} |\n",
            a.name,
            a.raw_bytes,
            a.brotli_bytes,
            a.budget_bytes,
            a.status.word()
        ));
    }
    let total_status = if r.eager_total_brotli > r.eager_total_budget {
        "over budget"
    } else {
        "ok"
    };
    s.push_str(&format!(
        "| Eager total | — | {} | {} | {total_status} |\n",
        r.eager_total_brotli, r.eager_total_budget
    ));
    s
}
