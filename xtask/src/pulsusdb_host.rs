//! `ci no-pulsusdb-host` (plan §3.11): the private PulsusDB host never enters the repository.
//!
//! Scans the relative path and the text of every file `git ls-files --cached --others
//! --exclude-standard` lists. (1) Literal: each host of `DASH_FORBIDDEN_HOSTS`, case-insensitive,
//! anywhere; fails closed in CI when the variable is unset. (2) Structural: PulsusDB URL settings
//! must name a reserved example host. No output ever contains a forbidden host: a path segment
//! containing one is replaced by `<redacted:h8>` (`h8` = first 8 hex digits of the SHA-256 of
//! the full relative path).

use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;

use regex::Regex;

use crate::dep_audit::sha256_hex;
use crate::report::{Rule, Violation};
use crate::shim::re;
use crate::{R, XtaskError, line_of};

/// Comma list of forbidden hostnames (a CI secret).
pub const FORBIDDEN_ENV: &str = "DASH_FORBIDDEN_HOSTS";
/// Bytes inspected for a NUL to decide a file is binary.
const TEXT_PROBE: usize = 8 * 1024;

const LITERAL_MESSAGE: &str = "a forbidden PulsusDB host";
const STRUCTURAL_MESSAGE: &str = "PulsusDB URL host is not a reserved example host";

static ENV_URL_RE: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r#"(?i)PULSUS_DASH_DATASOURCES_BOOTSTRAP__\d+__URL["']?\s*[:=,]\s*["']?(https?://[^\s"'<>,)]+)"#,
    )
});
static KEY_URL_RE: LazyLock<Regex> =
    LazyLock::new(|| re(r#"(?m)^\s*-?\s*(?:url|datasource_url)\s*:\s*["']?(https?://[^\s"'<>]+)"#));

/// The tracked and untracked-not-ignored files of `root` (relative, `/`-separated).
pub fn listed_files(root: &Path) -> R<Vec<String>> {
    let command = "git ls-files --cached --others --exclude-standard -z";
    let out = Command::new("git")
        .args([
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ])
        .current_dir(root)
        .output()
        .map_err(|e| XtaskError::Tool {
            command: command.into(),
            detail: e.to_string(),
        })?;
    if !out.status.success() {
        return Err(XtaskError::Tool {
            command: command.into(),
            detail: "git failed (not a repository?)".into(),
        });
    }
    let mut files: BTreeSet<String> = BTreeSet::new();
    for p in out.stdout.split(|b| *b == 0).filter(|p| !p.is_empty()) {
        files.insert(String::from_utf8_lossy(p).into_owned());
    }
    Ok(files.into_iter().collect())
}

fn parse_hosts(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or("")
        .split(',')
        .map(|h| h.trim().to_ascii_lowercase())
        .filter(|h| !h.is_empty())
        .collect()
}

fn contains_host(text: &str, forbidden: &[String]) -> bool {
    let lower = text.to_ascii_lowercase();
    forbidden.iter().any(|h| lower.contains(h.as_str()))
}

/// `rel` with every segment containing a forbidden host replaced by `<redacted:h8>`.
pub fn sanitise(rel: &str, forbidden: &[String]) -> String {
    if !contains_host(rel, forbidden) {
        return rel.to_string();
    }
    let h8 = &sha256_hex(rel.as_bytes())[..8];
    rel.split('/')
        .map(|seg| {
            if contains_host(seg, forbidden) {
                format!("<redacted:{h8}>")
            } else {
                seg.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// A reserved example host (RFC 2606 / RFC 6761) or `localhost`.
fn reserved_host(host: &str) -> bool {
    let h = host.trim_end_matches('.').to_ascii_lowercase();
    matches!(
        h.as_str(),
        "localhost" | "example.com" | "example.org" | "example.net"
    ) || [".invalid", ".example", ".test"]
        .iter()
        .any(|s| h.ends_with(s))
        || ["invalid", "example", "test"].contains(&h.as_str())
}

/// URLs whose host is not reserved; unparseable or host-less URLs are not URL settings.
fn bad_url(url: &str) -> bool {
    url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(|h| !reserved_host(h)))
        .unwrap_or(false)
}

/// Every `datasources_bootstrap[*].url` of a YAML document.
fn yaml_seed_urls(text: &str) -> Vec<String> {
    let Ok(doc) = serde_norway::from_str::<serde_norway::Value>(text) else {
        return Vec::new();
    };
    doc.get("datasources_bootstrap")
        .and_then(serde_norway::Value::as_sequence)
        .map(|seq| {
            seq.iter()
                .filter_map(|e| e.get("url").and_then(serde_norway::Value::as_str))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Structural findings of one text file: `(line, url)` of each bad URL.
fn structural(rel: &str, text: &str) -> BTreeSet<(Option<u32>, String)> {
    let mut found = BTreeSet::new();
    for re in [&*ENV_URL_RE, &*KEY_URL_RE] {
        for c in re.captures_iter(text) {
            if let Some(m) = c.get(1)
                && bad_url(m.as_str())
            {
                found.insert((Some(line_of(text, m.start())), m.as_str().to_string()));
            }
        }
    }
    if rel.ends_with(".yaml") || rel.ends_with(".yml") {
        for url in yaml_seed_urls(text) {
            if bad_url(&url) && !found.iter().any(|(_, u)| *u == url) {
                let line = text.find(url.as_str()).map(|at| line_of(text, at));
                found.insert((line, url));
            }
        }
    }
    found
}

fn violation(rule: Rule, path: &str, line: Option<u32>, message: &str) -> Violation {
    Violation {
        rule,
        path: PathBuf::from(path),
        line,
        message: message.to_string(),
    }
}

/// Checks the listed files of `root`. `forbidden` = the variable's value; `ci` = `CI=true`.
/// Informational lines and warnings go to `out`; violations are returned (sanitised).
pub fn check(
    root: &Path,
    forbidden: Option<&str>,
    ci: bool,
    out: &mut dyn Write,
) -> R<Vec<Violation>> {
    let hosts = parse_hosts(forbidden);
    let mut v = Vec::new();
    if hosts.is_empty() {
        if ci {
            v.push(violation(
                Rule::PulsusdbHostSecretMissing,
                ".github/workflows/ci.yml",
                None,
                "DASH_FORBIDDEN_HOSTS is unset or empty in CI; add the repository secret (fail closed)",
            ));
        } else {
            writeln!(
                out,
                "warning: literal host check skipped: {FORBIDDEN_ENV} unset"
            )
            .map_err(XtaskError::io("stdout"))?;
        }
    }
    let files = listed_files(root)?;
    let mut scanned = 0usize;
    for rel in &files {
        let shown = sanitise(rel, &hosts);
        if !hosts.is_empty() && contains_host(rel, &hosts) {
            v.push(violation(Rule::PulsusdbHost, &shown, None, LITERAL_MESSAGE));
        }
        let abs = root.join(rel);
        let Ok(bytes) = std::fs::read(&abs) else {
            continue; // listed but deleted in the work tree
        };
        if bytes[..bytes.len().min(TEXT_PROBE)].contains(&0) {
            continue;
        }
        scanned += 1;
        let text = String::from_utf8_lossy(&bytes);
        if !hosts.is_empty() {
            let mut lines = BTreeSet::new();
            for (n, line) in text.lines().enumerate() {
                if contains_host(line, &hosts) {
                    lines.insert(u32::try_from(n + 1).unwrap_or(u32::MAX));
                }
            }
            for l in lines {
                v.push(violation(
                    Rule::PulsusdbHost,
                    &shown,
                    Some(l),
                    LITERAL_MESSAGE,
                ));
            }
        }
        for (line, _) in structural(rel, &text) {
            v.push(violation(
                Rule::PulsusdbHost,
                &shown,
                line,
                STRUCTURAL_MESSAGE,
            ));
        }
    }
    writeln!(
        out,
        "no-pulsusdb-host: {} listed files, {scanned} text files scanned",
        files.len()
    )
    .map_err(XtaskError::io("stdout"))?;
    Ok(v)
}

/// The gate entry point: reads the environment and prints to stdout.
pub fn run(root: &Path) -> R<Vec<Violation>> {
    let forbidden = std::env::var(FORBIDDEN_ENV).ok();
    let ci = std::env::var("CI").is_ok_and(|v| v == "true");
    check(root, forbidden.as_deref(), ci, &mut std::io::stdout())
}
