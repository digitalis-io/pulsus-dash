#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The dev stack's IdP answers OIDC discovery (itest; `cargo xtask ci itest` step 4).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

#[test]
#[ignore = "itest: run by cargo xtask ci itest"]
fn dev_stack_idp_discovery() {
    let issuer = std::env::var("DASH_ITEST_IDP_ISSUER").unwrap();
    let u = url::Url::parse(&issuer).unwrap();
    let port = u.port_or_known_default().unwrap();
    let host = u.host_str().unwrap();
    let mut s = TcpStream::connect((host, port)).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    write!(
        s,
        "GET {}/.well-known/openid-configuration HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n",
        u.path().trim_end_matches('/')
    )
    .unwrap();
    let mut raw = String::new();
    s.read_to_string(&mut raw).unwrap();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap();
    assert!(head.starts_with("HTTP/1.1 200"), "{head}");
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        dechunk(body)
    } else {
        body.to_string()
    };
    let v: serde_json::Value = serde_json::from_str(body.trim()).unwrap();
    assert_eq!(v["issuer"].as_str(), Some(issuer.as_str()));
    assert!(
        v["authorization_endpoint"]
            .as_str()
            .unwrap()
            .starts_with(&issuer)
    );
}

/// Decodes an HTTP/1.1 chunked body.
fn dechunk(mut body: &str) -> String {
    let mut out = String::new();
    while let Some((size, rest)) = body.split_once("\r\n") {
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 {
            break;
        }
        out.push_str(&rest[..n]);
        body = &rest[n..].trim_start_matches("\r\n");
    }
    out
}
