#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The public-URL self-check outcomes (T19-002, plan §3.9).

#[path = "../src/selfcheck.rs"]
mod selfcheck;
mod support;

use std::time::{Duration, Instant};

use selfcheck::{SelfCheck, check_public_url};
use support::{Script, free_port, scripted_server};

const BOTH: &str = "HTTP/1.1 200 OK\r\nCross-Origin-Opener-Policy: same-origin\r\nCross-Origin-Embedder-Policy: require-corp\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";
const NO_COOP: &str = "HTTP/1.1 200 OK\r\nCross-Origin-Embedder-Policy: require-corp\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";
const NEITHER: &str = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";
const FOUND: &str =
    "HTTP/1.1 302 Found\r\nLocation: /elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

fn url(port: u16) -> url::Url {
    url::Url::parse(&format!("http://localhost:{port}/tok/")).unwrap()
}

async fn check(port: u16, timeout: Duration) -> SelfCheck {
    check_public_url(&url(port), timeout).await
}

#[tokio::test]
async fn selfcheck_outcomes() {
    let t = Duration::from_secs(5);
    assert_eq!(
        check(scripted_server(Script::Respond(BOTH)), t).await,
        SelfCheck::Isolated
    );
    assert_eq!(
        check(scripted_server(Script::Respond(NO_COOP)), t).await,
        SelfCheck::Stripped {
            missing: vec!["Cross-Origin-Opener-Policy"]
        }
    );
    assert_eq!(
        check(scripted_server(Script::Respond(NEITHER)), t).await,
        SelfCheck::Stripped {
            missing: vec!["Cross-Origin-Opener-Policy", "Cross-Origin-Embedder-Policy"]
        }
    );
    assert_eq!(
        check(scripted_server(Script::Respond(FOUND)), t).await,
        SelfCheck::Status(302)
    );
    let hang = scripted_server(Script::Hang);
    let started = Instant::now();
    let r = check(hang, Duration::from_millis(300)).await;
    assert!(matches!(r, SelfCheck::Unreachable(_)), "{r:?}");
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(
        check(free_port(), t).await,
        SelfCheck::Unreachable("connect")
    );
}
