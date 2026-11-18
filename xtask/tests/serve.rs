#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `cargo xtask serve`: T03 §5.7 headers, isolation switch and path safety (plan §4.9).

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use common::tree;
use xtask::serve::{ServeOptions, serve};

/// Starts a server on an ephemeral port; returns the port, or `None` if it never became ready.
fn start(root: &std::path::Path, isolation: bool) -> Option<u16> {
    let (tx, rx) = std::sync::mpsc::channel();
    let o = ServeOptions {
        root: root.to_path_buf(),
        port: 0,
        isolation,
    };
    std::thread::spawn(move || {
        let _ = serve(&o, Some(tx));
    });
    rx.recv_timeout(Duration::from_secs(10)).ok()
}

/// Raw request; returns (status, lower-cased headers).
fn get(port: u16, method: &str, path: &str) -> (u16, Vec<(String, String)>) {
    let mut s = TcpStream::connect(("localhost", port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let head = text.split("\r\n\r\n").next().unwrap_or("");
    let mut lines = head.lines();
    let status = lines
        .next()
        .and_then(|l| l.split(' ').nth(1))
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    (status, headers)
}

fn header<'a>(h: &'a [(String, String)], k: &str) -> Option<&'a str> {
    h.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
}

const CSP: &str =
    "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; font-src 'self'";

#[test]
fn serve_sets_required_headers() {
    let t = tree(&[("index.html", b"<!doctype html>\n"), ("a.wasm", b"\0asm")]);
    let port = start(t.path(), true);
    assert!(port.is_some(), "server did not report its port");
    let port = port.unwrap();
    let (st, h) = get(port, "GET", "/");
    assert_eq!(st, 200);
    assert_eq!(
        header(&h, "cross-origin-opener-policy"),
        Some("same-origin")
    );
    assert_eq!(
        header(&h, "cross-origin-embedder-policy"),
        Some("require-corp")
    );
    assert_eq!(
        header(&h, "cross-origin-resource-policy"),
        Some("same-origin")
    );
    assert_eq!(header(&h, "content-security-policy"), Some(CSP));
    assert_eq!(header(&h, "cache-control"), Some("no-cache"));
    assert_eq!(header(&h, "x-content-type-options"), Some("nosniff"));
    assert_eq!(header(&h, "content-type"), Some("text/html; charset=utf-8"));
    let (st, h) = get(port, "GET", "/a.wasm");
    assert_eq!(st, 200);
    assert_eq!(header(&h, "content-type"), Some("application/wasm"));
    assert_eq!(get(port, "HEAD", "/a.wasm").0, 200);
    assert_eq!(get(port, "GET", "/../Cargo.toml").0, 404);
    assert_eq!(get(port, "GET", "/%2e%2e/x").0, 404);
    assert_eq!(get(port, "GET", "/missing.js").0, 404);
    assert_eq!(get(port, "POST", "/").0, 405);
}

#[test]
fn serve_no_isolation_strips_coop_coep() {
    let t = tree(&[("index.html", b"<!doctype html>\n")]);
    let port = start(t.path(), false);
    assert!(port.is_some(), "server did not report its port");
    let (st, h) = get(port.unwrap(), "GET", "/");
    assert_eq!(st, 200);
    assert_eq!(header(&h, "cross-origin-opener-policy"), None);
    assert_eq!(header(&h, "cross-origin-embedder-policy"), None);
    assert_eq!(
        header(&h, "cross-origin-resource-policy"),
        Some("same-origin")
    );
    assert_eq!(header(&h, "content-security-policy"), Some(CSP));
}
