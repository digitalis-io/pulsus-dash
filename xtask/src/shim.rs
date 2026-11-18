//! The shim file set and `ci:shim-lint` (T03-001, plan §4.2).

use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;

use regex::Regex;

use crate::jslex::{LexError, count_code_lines, strip_comments};
use crate::report::{Rule, Violation};
use crate::{R, XtaskError, line_of, rel_str};

pub const SHIM_DIR: &str = "web/shim";
pub const GEN_DIR: &str = "web/shim/gen";
pub const LINE_BUDGET: u32 = 300;
pub const JS_EXT: [&str; 3] = ["js", "mjs", "cjs"];
/// The T03 §5.1 file column, in table order.
pub const SHIM_PATHS: [&str; 5] = [
    "web/shim/boot.js",
    "web/shim/worker.js",
    "web/shim/net.js",
    "web/shim/input.js",
    "web/shim/sw.js",
];

/// Files under `web/shim/` that git tracks or does not ignore (root-relative, sorted).
#[derive(Debug, Clone, Default)]
pub struct ShimFiles {
    pub candidates: Vec<PathBuf>,
}

/// `git ls-files -z --cached --others --exclude-standard -- web/shim`, sorted.
/// Fails closed with [`XtaskError::Tool`] when git is missing or `root` is not a checkout.
pub fn candidates(root: &Path) -> R<ShimFiles> {
    let args = [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        SHIM_DIR,
    ];
    let command = format!("git {}", args.join(" "));
    let out = Command::new("git")
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
    let text = String::from_utf8(out.stdout).map_err(|e| XtaskError::Tool {
        command,
        detail: format!("non-UTF-8 path: {e}"),
    })?;
    let mut candidates: Vec<PathBuf> = text
        .split('\0')
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect();
    candidates.sort();
    candidates.dedup();
    Ok(ShimFiles { candidates })
}

/// Every candidate with a [`JS_EXT`] extension, including any under [`GEN_DIR`].
pub fn js_files(files: &ShimFiles) -> Vec<PathBuf> {
    files
        .candidates
        .iter()
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| JS_EXT.contains(&e))
        })
        .cloned()
        .collect()
}

/// Code-line count of one shim file.
#[derive(Debug, Clone)]
pub struct ShimFile {
    pub path: PathBuf,
    pub code_lines: u32,
}

/// Result of the shim lint.
#[derive(Debug, Clone)]
pub struct ShimReport {
    pub files: Vec<ShimFile>,
    pub total: u32,
    pub violations: Vec<Violation>,
}

fn violation(rule: Rule, path: &Path, line: Option<u32>, message: impl Into<String>) -> Violation {
    Violation {
        rule,
        path: path.to_path_buf(),
        line,
        message: message.into(),
    }
}

/// Lints the JS among `files`, reading their contents from `root` (plan §4.2 steps 1–6).
pub fn lint_files(root: &Path, files: &ShimFiles) -> R<ShimReport> {
    let mut report = ShimReport {
        files: Vec::new(),
        total: 0,
        violations: Vec::new(),
    };
    if !root.join(SHIM_DIR).is_dir() {
        report.violations.push(violation(
            Rule::ShimDirMissing,
            Path::new(SHIM_DIR),
            None,
            "web/shim/ does not exist",
        ));
        return Ok(report);
    }
    let mut checks = Vec::new();
    for path in js_files(files) {
        let abs = root.join(&path);
        let bytes = std::fs::read(&abs).map_err(XtaskError::io(&abs))?;
        let lexed = match String::from_utf8(bytes) {
            Ok(src) => {
                strip_comments(&src).map_err(|e| (Some(lex_error_line(&e)), format!("{e:?}")))
            }
            Err(_) => Err((None, "not valid UTF-8".to_string())),
        };
        match lexed {
            Err((line, why)) => {
                report.violations.push(violation(
                    Rule::ShimLexError,
                    &path,
                    line,
                    format!("{why} (see docs/development/build-and-ci.md, shim-lint)"),
                ));
                report.files.push(ShimFile {
                    path,
                    code_lines: 0,
                });
            }
            Ok(stripped) => {
                let code_lines = count_code_lines(&stripped);
                report.total = report.total.saturating_add(code_lines);
                report.files.push(ShimFile {
                    path: path.clone(),
                    code_lines,
                });
                checks.push((path, stripped));
            }
        }
    }
    if report.total > LINE_BUDGET {
        report.violations.push(violation(
            Rule::ShimLineBudget,
            Path::new(SHIM_DIR),
            None,
            format!("{} > {LINE_BUDGET}", report.total),
        ));
    }
    for (path, stripped) in &checks {
        report.violations.extend(forbidden_tokens(path, stripped));
    }
    for (path, stripped) in &checks {
        report.violations.extend(imports(path, stripped, files));
    }
    Ok(report)
}

/// [`candidates`] + [`lint_files`].
pub fn lint(root: &Path) -> R<ShimReport> {
    lint_files(root, &candidates(root)?)
}

fn lex_error_line(e: &LexError) -> u32 {
    match e {
        LexError::UnterminatedBlockComment { line }
        | LexError::UnterminatedString { line }
        | LexError::UnterminatedTemplate { line }
        | LexError::AmbiguousSlash { line }
        | LexError::LineTerminator { line }
        | LexError::UnsupportedComment { line }
        | LexError::UnsupportedChar { line }
        | LexError::UnbalancedParen { line } => *line,
    }
}

/// Compiles a built-in pattern. The patterns are constants exercised by the tests, so a
/// failure is a programming error (documented infallible invariant).
pub(crate) fn re(pattern: &str) -> Regex {
    match Regex::new(pattern) {
        Ok(r) => r,
        Err(e) => panic!("invalid built-in regex {pattern:?}: {e}"),
    }
}

static FORBIDDEN: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    ["eval", "Function", "innerHTML"]
        .into_iter()
        .map(|t| (t, re(&format!(r"\b{t}\b"))))
        .collect()
});

fn forbidden_tokens(path: &Path, stripped: &str) -> Vec<Violation> {
    let mut out: Vec<(usize, Violation)> = Vec::new();
    for (token, r) in FORBIDDEN.iter() {
        for m in r.find_iter(stripped) {
            out.push((
                m.start(),
                violation(
                    Rule::ShimForbiddenToken,
                    path,
                    Some(line_of(stripped, m.start())),
                    format!("`{token}` is forbidden in the shim (T03-001)"),
                ),
            ));
        }
    }
    out.sort_by_key(|(at, _)| *at);
    out.into_iter().map(|(_, v)| v).collect()
}

/// An import construct: its literal form (specifier in group 2) and, where a non-literal form
/// exists, the trigger that matches any use of the construct.
struct ImportRule {
    what: &'static str,
    literal: Option<Regex>,
    trigger: Option<Regex>,
}

static IMPORT_RULES: LazyLock<Vec<ImportRule>> = LazyLock::new(|| {
    vec![
        ImportRule {
            what: "import",
            literal: Some(re(
                r#"\b(?:import|export)\b[^;'"]*?\bfrom\s*(["'])([^"']*)["']"#,
            )),
            trigger: None,
        },
        ImportRule {
            what: "side-effect import",
            literal: Some(re(r#"\bimport\s*(["'])([^"']*)["']"#)),
            trigger: None,
        },
        ImportRule {
            what: "dynamic import",
            literal: Some(re(r#"\bimport\s*\(\s*(["'])([^"']*)["']\s*\)"#)),
            trigger: Some(re(r"\bimport\s*\(")),
        },
        ImportRule {
            what: "worker",
            literal: Some(re(
                r#"\bnew\s+(?:Shared)?Worker\s*\(\s*(?:new\s+URL\s*\(\s*)?(["'])([^"']*)["']"#,
            )),
            trigger: Some(re(r"\bnew\s+(?:Shared)?Worker\s*\(")),
        },
        ImportRule {
            what: "service worker",
            literal: Some(re(
                r#"\bserviceWorker\s*\.\s*register\s*\(\s*(["'])([^"']*)["']"#,
            )),
            trigger: Some(re(r"\bserviceWorker\s*\.\s*register\s*\(")),
        },
        ImportRule {
            what: "importScripts",
            literal: None,
            trigger: Some(re(r"\bimportScripts\b")),
        },
    ]
});

fn imports(path: &Path, stripped: &str, files: &ShimFiles) -> Vec<Violation> {
    let mut out: Vec<(usize, Violation)> = Vec::new();
    for rule in IMPORT_RULES.iter() {
        let mut literal_starts = Vec::new();
        if let Some(lit) = &rule.literal {
            for c in lit.captures_iter(stripped) {
                let (Some(all), Some(spec)) = (c.get(0), c.get(2)) else {
                    continue;
                };
                literal_starts.push(all.start());
                if let Err(why) = check_specifier(path, spec.as_str(), files) {
                    out.push((
                        all.start(),
                        violation(
                            Rule::ShimImport,
                            path,
                            Some(line_of(stripped, all.start())),
                            format!("{} `{}`: {why}", rule.what, spec.as_str()),
                        ),
                    ));
                }
            }
        }
        if let Some(trigger) = &rule.trigger {
            for m in trigger.find_iter(stripped) {
                if literal_starts.contains(&m.start()) {
                    continue;
                }
                let why = match rule.literal {
                    Some(_) => format!("non-literal {}", rule.what),
                    None => "importScripts is not allowed (module workers only)".to_string(),
                };
                out.push((
                    m.start(),
                    violation(
                        Rule::ShimImport,
                        path,
                        Some(line_of(stripped, m.start())),
                        why,
                    ),
                ));
            }
        }
    }
    out.sort_by_key(|(at, _)| *at);
    out.into_iter().map(|(_, v)| v).collect()
}

/// A specifier is allowed only if it is relative (`./`, `../`), resolves lexically inside
/// `web/shim/`, and is either generated glue (`web/shim/gen/<crate>/<crate_>.js`) or a candidate.
fn check_specifier(importer: &Path, spec: &str, files: &ShimFiles) -> Result<(), String> {
    if !(spec.starts_with("./") || spec.starts_with("../")) {
        return Err("only ./ or ../ specifiers are allowed".into());
    }
    let mut parts: Vec<String> = importer
        .parent()
        .unwrap_or(Path::new(""))
        .components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    for seg in spec.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err("resolves outside the repository".into());
                }
            }
            s => parts.push(s.to_string()),
        }
    }
    if parts.len() < 3 || parts[0] != "web" || parts[1] != "shim" {
        return Err("resolves outside web/shim/".into());
    }
    let is_glue = parts.len() == 5
        && parts[2] == "gen"
        && !parts[3].is_empty()
        && parts[4] == format!("{}.js", parts[3].replace('-', "_"));
    let resolved = PathBuf::from(parts.join("/"));
    if is_glue || files.candidates.contains(&resolved) {
        Ok(())
    } else {
        Err(format!("{} is not a shim file", rel_str(&resolved)))
    }
}
