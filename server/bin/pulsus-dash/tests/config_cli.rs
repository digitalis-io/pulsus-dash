#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The binary's configuration handling: exit codes, messages and the output rule (T06-019,
//! T18-030, T19-002). No Postgres is needed: the configured host does not resolve.

mod support;

use std::time::Duration;

use support::{Running, Script, free_port, http_get, scripted_server, valid_yaml, write};

const PG_UNREACHABLE: &str = "postgres://pulsus_app@pulsusdb.invalid:1/x";
const URL: Option<&str> = Some("http://pulsusdb.invalid:9");

struct Case {
    dir: tempfile::TempDir,
    written: std::cell::Cell<usize>,
}

impl Case {
    fn new() -> Case {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("assets/index.html"), "<p>x</p>").unwrap();
        Case {
            dir,
            written: std::cell::Cell::new(0),
        }
    }

    fn config(&self, pg: &str, url: Option<&str>, extra: &str, seed: &str) -> String {
        let text = valid_yaml(&self.dir.path().join("assets"), pg, url, extra, seed);
        let n = self.written.get() + 1;
        self.written.set(n);
        write(self.dir.path(), &format!("cfg-{n}.yaml"), &text)
            .display()
            .to_string()
    }
}

#[test]
fn cli_secrets_never_logged() {
    let c = Case::new();
    let cfg = c.config(
        "postgres://pulsus_app:pg-pw-77@pulsusdb.invalid:1/x",
        Some("http://pulsusdb.invalid:9/p-tok-31/"),
        "log: {filter: trace, format: json}\n",
        "    credentials_ref: \"env:PDB_CRED\"\n",
    );
    let mut r = Running::spawn(&["--config", &cfg], &[("PDB_CRED", "reader:s3cr3t-pw")]);
    assert!(
        r.listening_port(Duration::from_secs(10)).is_some(),
        "{}",
        r.output()
    );
    std::thread::sleep(Duration::from_secs(3));
    r.terminate();
    let status = r.wait_exit(Duration::from_secs(35));
    let out = r.output();
    assert_eq!(status.and_then(|s| s.code()), Some(0), "{out}");
    for leak in ["s3cr3t", "reader:", "pg-pw-77", "p-tok-31"] {
        assert!(!out.contains(leak), "output contains {leak}: {out}");
    }
    assert!(out.contains("waiting for postgres"), "{out}");
}

#[test]
fn cli_config_errors_exit_2() {
    let c = Case::new();
    /// (config path, extra args, env, wanted output fragments)
    type ErrorCase<'a> = (String, Vec<&'a str>, Vec<(&'a str, &'a str)>, Vec<&'a str>);
    let cases: Vec<ErrorCase> = vec![
        (
            c.config(PG_UNREACHABLE, URL, "listen_port: 1\n", ""),
            vec![],
            vec![],
            vec!["unknown configuration key `listen_port` (in"],
        ),
        (
            c.config(PG_UNREACHABLE, URL, "", ""),
            vec![],
            vec![("PULSUS_DASH_LISTEN_PORT", "1")],
            vec!["PULSUS_DASH_LISTEN_PORT"],
        ),
        (
            c.config(PG_UNREACHABLE, None, "", ""),
            vec![],
            vec![],
            vec!["datasources_bootstrap[0].url"],
        ),
        (
            c.config(PG_UNREACHABLE, URL, "", ""),
            vec!["--role", "api"],
            vec![],
            vec!["role `api` is not implemented"],
        ),
        (
            c.config(
                PG_UNREACHABLE,
                URL,
                "",
                "    credentials_ref: \"env:PDB_UNSET\"\n",
            ),
            vec![],
            vec![],
            vec!["credentials_ref", "PDB_UNSET"],
        ),
    ];
    for (i, (cfg, extra_args, env, wants)) in cases.into_iter().enumerate() {
        let mut args = vec!["--config", cfg.as_str()];
        args.extend(extra_args);
        let mut r = Running::spawn(&args, &env);
        let status = r.wait_exit(Duration::from_secs(10));
        let out = r.output();
        assert_eq!(status.and_then(|s| s.code()), Some(2), "case {i}: {out}");
        for w in wants {
            assert!(out.contains(w), "case {i}: missing {w:?} in {out}");
        }
        assert!(
            out.contains("pulsus-dash: configuration error: "),
            "case {i}: {out}"
        );
    }
}

#[test]
fn cli_validates_before_connecting() {
    let c = Case::new();
    let cfg = c.config("postgres://x@pulsusdb.invalid:1/x", None, "", "");
    let mut r = Running::spawn(&["--config", &cfg], &[]);
    let status = r.wait_exit(Duration::from_secs(5));
    let out = r.output();
    assert_eq!(status.and_then(|s| s.code()), Some(2), "{out}");
    assert!(!out.contains("listening"), "{out}");
}

const NEITHER: &str = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";

#[test]
fn selfcheck_warns_not_fails() {
    let c = Case::new();
    let stripped = scripted_server(Script::Respond(NEITHER));
    let closed = free_port();
    for (port, want) in [
        (
            stripped,
            format!(
                "http://localhost:{stripped} strips Cross-Origin-Opener-Policy, Cross-Origin-Embedder-Policy"
            ),
        ),
        (
            closed,
            format!("self-check skipped: http://localhost:{closed} unreachable (connect)"),
        ),
    ] {
        let cfg = c.config(
            PG_UNREACHABLE,
            URL,
            &format!("public_url: \"http://localhost:{port}/tok-9f3a7c/\"\n"),
            "",
        );
        let mut r = Running::spawn(&["--config", &cfg], &[]);
        let listen = r.listening_port(Duration::from_secs(10));
        assert!(listen.is_some(), "{}", r.output());
        assert!(
            r.wait_for(Duration::from_secs(10), |o| o.contains(&want)),
            "missing {want:?}: {}",
            r.output()
        );
        let health = http_get(listen.unwrap(), "/healthz");
        assert_eq!(health.map(|h| h.0), Some(200));
        r.terminate();
        let _ = r.wait_exit(Duration::from_secs(35));
        assert!(!r.output().contains("tok-9f3a7c"), "{}", r.output());
    }
}
