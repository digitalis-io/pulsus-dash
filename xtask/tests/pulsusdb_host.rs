#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `ci no-pulsusdb-host` (plan §3.11): the literal and structural checks, sanitised output and
//! the seed workflow.

mod common;

use std::path::Path;
use std::process::Command;

use common::write;
use sha2::{Digest, Sha256};
use xtask::gates::Gate;
use xtask::pulsusdb_host::check;
use xtask::report::{Level, Rule, Violation};

fn git(dir: &Path, args: &[&str]) {
    let st = Command::new("git")
        .args(["-c", "user.name=t", "-c", "user.email=t@example.com"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(st.status.success(), "{:?}", st);
}

/// A temporary git repository with `files` committed.
fn repo(files: &[(&str, &[u8])]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    git(dir.path(), &["init", "-q"]);
    for (p, b) in files {
        write(dir.path(), p, b);
    }
    git(dir.path(), &["add", "-A"]);
    git(dir.path(), &["commit", "-q", "--allow-empty", "-m", "init"]);
    dir
}

fn h8(rel: &str) -> String {
    Sha256::digest(rel.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()[..8]
        .to_string()
}

fn at(v: &Violation) -> String {
    match v.line {
        Some(l) => format!("{}:{l}", xtask::rel_str(&v.path)),
        None => xtask::rel_str(&v.path),
    }
}

fn literal_tree() -> tempfile::TempDir {
    let t = repo(&[
        ("notes.md", b"line one\nwe reach Secret-Host.LAN daily\n"),
        ("docs/secret-host.lan.md", b""),
        (".gitignore", b"ignored.txt\n"),
    ]);
    write(t.path(), "x.rs", b"// secret-host.lan\n");
    write(t.path(), "ignored.txt", b"secret-host.lan\n");
    t
}

#[test]
fn host_literal_anywhere() {
    let t = literal_tree();
    let mut out = Vec::new();
    let v = check(t.path(), Some("secret-host.lan"), true, &mut out).unwrap();
    assert!(v.iter().all(|v| v.rule == Rule::PulsusdbHost), "{v:?}");
    let mut got: Vec<String> = v.iter().map(at).collect();
    got.sort();
    let mut want = vec![
        "notes.md:2".to_string(),
        "x.rs:1".to_string(),
        format!("docs/<redacted:{}>", h8("docs/secret-host.lan.md")),
    ];
    want.sort();
    assert_eq!(got, want);
    assert!(v.iter().all(|v| v.message == "a forbidden PulsusDB host"));
}

#[test]
fn host_output_never_contains_host() {
    let t = literal_tree();
    write(
        t.path(),
        "secret-host.lan/a.yaml",
        b"datasources_bootstrap:\n  - url: http://pulsusdb.corp.net:1\n",
    );
    let mut out = Vec::new();
    let v = check(t.path(), Some("secret-host.lan,other.lan"), true, &mut out).unwrap();
    let mut captured = String::from_utf8(out).unwrap();
    for x in &v {
        captured.push_str(&x.render(Level::Error));
        captured.push('\n');
        captured.push_str(&x.annotation(Level::Error));
        captured.push('\n');
    }
    assert!(
        !captured.to_ascii_lowercase().contains("secret-host"),
        "{captured}"
    );
    assert!(!captured.contains("other.lan"), "{captured}");
    let want = format!("<redacted:{}>/a.yaml", h8("secret-host.lan/a.yaml"));
    assert!(
        v.iter().any(|x| xtask::rel_str(&x.path) == want
            && x.message == "PulsusDB URL host is not a reserved example host"),
        "{v:?}"
    );
}

#[test]
fn host_secret_missing_fails_closed_in_ci() {
    let t = repo(&[("a.md", b"nothing here\n")]);
    let mut out = Vec::new();
    let v = check(t.path(), None, true, &mut out).unwrap();
    assert_eq!(
        v.iter().map(|v| v.rule).collect::<Vec<_>>(),
        vec![Rule::PulsusdbHostSecretMissing]
    );
    let mut out = Vec::new();
    let v = check(t.path(), Some(""), false, &mut out).unwrap();
    assert!(v.is_empty(), "{v:?}");
    let text = String::from_utf8(out).unwrap();
    assert!(
        text.contains("literal host check skipped: DASH_FORBIDDEN_HOSTS unset"),
        "{text}"
    );
}

#[test]
fn host_structural() {
    let t = repo(&[
        (
            "a.yaml",
            b"datasources_bootstrap: [{url: http://pulsusdb.corp.net:1}]\n",
        ),
        ("b.yaml", b"url: http://pulsusdb.invalid:9\n"),
        (
            "c.rs",
            b"cmd.env(\"PULSUS_DASH_DATASOURCES_BOOTSTRAP__0__URL\", \"https://x.example\");\n",
        ),
    ]);
    let mut out = Vec::new();
    let v = check(t.path(), Some("unrelated.lan"), true, &mut out).unwrap();
    assert_eq!(v.len(), 1, "{v:?}");
    assert_eq!(v[0].rule, Rule::PulsusdbHost);
    assert_eq!(xtask::rel_str(&v[0].path), "a.yaml");
    assert!(!v[0].message.contains("corp.net"));
    assert!(!v[0].render(Level::Error).contains("corp.net"));
}

#[test]
fn host_seed_workflow() {
    let t = repo(&[("dev/README.md", b"dev\n")]);
    xtask::seed::seed(Gate::NoPulsusdbHost, t.path()).unwrap();
    let mut out = Vec::new();
    let v = check(t.path(), Some("unrelated.lan"), true, &mut out).unwrap();
    assert!(
        v.iter()
            .any(|x| x.rule == Rule::PulsusdbHost
                && xtask::rel_str(&x.path) == "dev/seeded-host.yaml"),
        "{v:?}"
    );
    xtask::seed::unseed(Gate::NoPulsusdbHost, t.path()).unwrap();
    let v = check(t.path(), Some("unrelated.lan"), true, &mut out).unwrap();
    assert!(v.is_empty(), "{v:?}");
}
