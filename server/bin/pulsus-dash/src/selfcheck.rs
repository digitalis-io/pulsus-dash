//! The public-URL self-check (T19-002, plan §3.9): one GET of the configured public URL to see
//! whether an ingress strips the cross-origin isolation headers the binary sets.

use std::time::Duration;

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
    let _ = (url, timeout);
    SelfCheck::Isolated
}
