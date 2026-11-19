//! The public-URL self-check (T19-002, plan §3.9): one GET of the configured public URL to see
//! whether an ingress strips the cross-origin isolation headers the binary sets.

use std::time::Duration;

use http_body_util::Empty;
use hyper::body::Bytes;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use url::Url;

/// Outcome of the self-check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SelfCheck {
    /// 2xx with both isolation headers.
    Isolated,
    /// 2xx without (or with different) `Cross-Origin-Opener-Policy` /
    /// `Cross-Origin-Embedder-Policy`, in that order.
    Stripped { missing: Vec<&'static str> },
    /// A non-2xx status (redirects are not followed).
    Status(u16),
    /// `connect`, `tls`, `timeout` or `protocol`.
    Unreachable(&'static str),
}

/// `GET url` under `timeout`; the body is discarded.
pub async fn check_public_url(url: &Url, timeout: Duration) -> SelfCheck {
    let Ok(uri) = url.as_str().parse::<hyper::Uri>() else {
        return SelfCheck::Unreachable("protocol");
    };
    let https = hyper_rustls::HttpsConnectorBuilder::new()
        .with_webpki_roots()
        .https_or_http()
        .enable_http1()
        .build();
    let client: Client<_, Empty<Bytes>> = Client::builder(TokioExecutor::new()).build(https);
    let exchange = async {
        let req = hyper::Request::get(uri)
            .body(Empty::new())
            .map_err(|_| "protocol")?;
        // The body is dropped unread.
        client.request(req).await.map_err(classify)
    };
    let resp = match tokio::time::timeout(timeout, exchange).await {
        Err(_) => return SelfCheck::Unreachable("timeout"),
        Ok(Err(reason)) => return SelfCheck::Unreachable(reason),
        Ok(Ok(r)) => r,
    };
    let status = resp.status();
    if !status.is_success() {
        return SelfCheck::Status(status.as_u16());
    }
    let has = |name: &str, want: &str| {
        resp.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.trim().eq_ignore_ascii_case(want))
    };
    let mut missing = Vec::new();
    if !has("cross-origin-opener-policy", "same-origin") {
        missing.push("Cross-Origin-Opener-Policy");
    }
    if !has("cross-origin-embedder-policy", "require-corp") {
        missing.push("Cross-Origin-Embedder-Policy");
    }
    if missing.is_empty() {
        SelfCheck::Isolated
    } else {
        SelfCheck::Stripped { missing }
    }
}

/// The error kind only: a connector error is `tls` when an invalid-data I/O error (how the TLS
/// layer reports handshake failures) is in its chain, else `connect`.
fn classify(e: hyper_util::client::legacy::Error) -> &'static str {
    if !e.is_connect() {
        return "protocol";
    }
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(&e);
    while let Some(s) = source {
        if s.downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::InvalidData)
        {
            return "tls";
        }
        source = s.source();
    }
    "connect"
}

/// `scheme://host:port` of `url` (the path is never logged, plan §3.3).
pub fn origin(url: &Url) -> String {
    format!(
        "{}://{}:{}",
        url.scheme(),
        url.host_str().unwrap_or(""),
        url.port_or_known_default().unwrap_or(0)
    )
}

/// Runs the check once and logs the outcome; never fatal.
pub async fn run_and_log(url: Url) {
    let origin = origin(&url);
    match check_public_url(&url, CHECK_TIMEOUT).await {
        SelfCheck::Isolated => {
            tracing::info!("public URL self-check: cross-origin isolation headers present");
        }
        SelfCheck::Stripped { missing } => tracing::warn!(
            "public URL self-check: {origin} strips {}; an ingress is removing headers the binary sets (T19-002)",
            missing.join(", ")
        ),
        SelfCheck::Status(code) => {
            tracing::warn!("public URL self-check: {origin} answered {code}");
        }
        SelfCheck::Unreachable(reason) => {
            tracing::warn!("public URL self-check skipped: {origin} unreachable ({reason})");
        }
    }
}

/// The whole-exchange bound used by the binary.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(5);
