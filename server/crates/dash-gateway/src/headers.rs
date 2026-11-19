//! Response header sets (T18-002, T03-022; plan §3.7).

use axum::http::header::{
    CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue,
    REFERRER_POLICY, STRICT_TRANSPORT_SECURITY, X_CONTENT_TYPE_OPTIONS,
};
use url::Url;

/// The CSP report endpoint (`report-to csp`).
pub const REPORT_PATH: &str = "/api/dash/v1/csp-report";

const COOP: HeaderName = HeaderName::from_static("cross-origin-opener-policy");
const COEP: HeaderName = HeaderName::from_static("cross-origin-embedder-policy");
const CORP: HeaderName = HeaderName::from_static("cross-origin-resource-policy");
const REPORTING_ENDPOINTS: HeaderName = HeaderName::from_static("reporting-endpoints");
const PERMISSIONS_POLICY: HeaderName = HeaderName::from_static("permissions-policy");

const HSTS: &str = "max-age=63072000; includeSubDomains; preload";
const PERMISSIONS: &str =
    "camera=(), geolocation=(), microphone=(self), usb=(), payment=(), gamepad=(self)";
const IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// The Content-Security-Policy (T18-002 order). `[ASSET_ORIGIN]` is empty: no CDN mode yet.
/// `upgrade-insecure-requests` only for an https public URL (it would break plain-http dev).
pub fn csp(public_url: Option<&Url>) -> String {
    let upgrade = if public_url.is_some_and(|u| u.scheme() == "https") {
        "upgrade-insecure-requests; "
    } else {
        ""
    };
    format!(
        "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; \
         connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; \
         manifest-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'; \
         frame-ancestors 'none'; require-trusted-types-for 'script'; \
         trusted-types pulsus-sanitised; {upgrade}report-to csp"
    )
}

/// Precomputed header values for one router.
#[derive(Clone, Debug)]
pub struct Headers {
    csp: HeaderValue,
    reporting: HeaderValue,
}

fn hv(s: &'static str) -> HeaderValue {
    HeaderValue::from_static(s)
}

impl Headers {
    pub fn new(public_url: Option<&Url>) -> Self {
        let csp = HeaderValue::from_str(&csp(public_url))
            .unwrap_or_else(|_| HeaderValue::from_static("default-src 'none'"));
        let reporting = HeaderValue::from_str(&format!("csp=\"{REPORT_PATH}\""))
            .unwrap_or_else(|_| HeaderValue::from_static("csp=\"/\""));
        Self { csp, reporting }
    }

    /// Headers every static response carries (workers take CSP and COEP from their own
    /// response, T03-022).
    fn isolation(&self, h: &mut HeaderMap) {
        h.insert(CONTENT_SECURITY_POLICY, self.csp.clone());
        h.insert(REPORTING_ENDPOINTS, self.reporting.clone());
        h.insert(COOP, hv("same-origin"));
        h.insert(COEP, hv("require-corp"));
        h.insert(CORP, hv("same-origin"));
        h.insert(X_CONTENT_TYPE_OPTIONS, hv("nosniff"));
    }

    /// An HTML document.
    pub fn document(&self, h: &mut HeaderMap) {
        self.isolation(h);
        h.insert(STRICT_TRANSPORT_SECURITY, hv(HSTS));
        h.insert(REFERRER_POLICY, hv("strict-origin-when-cross-origin"));
        h.insert(PERMISSIONS_POLICY, hv(PERMISSIONS));
        h.insert(CACHE_CONTROL, hv("no-cache"));
    }

    /// Any other static file; `immutable` when the name carries a content hash.
    pub fn asset(&self, h: &mut HeaderMap, immutable: bool) {
        self.isolation(h);
        h.insert(
            CACHE_CONTROL,
            hv(if immutable { IMMUTABLE } else { "no-cache" }),
        );
    }
}

/// Headers of every JSON response (health, report errors).
pub fn json(h: &mut HeaderMap) {
    h.insert(X_CONTENT_TYPE_OPTIONS, hv("nosniff"));
    h.insert(CORP, hv("same-origin"));
    h.insert(CACHE_CONTROL, hv("no-store"));
    h.insert(CONTENT_TYPE, hv("application/json"));
}

/// The content type of a static file by extension (plan §3.7).
pub fn content_type(ext: &str) -> &'static str {
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "wasm" => "application/wasm",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "woff2" => "font/woff2",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// A content-hashed name: `\.[0-9a-f]{12,}\.` somewhere in the file name.
pub fn is_hashed(name: &str) -> bool {
    name.split('.')
        .collect::<Vec<_>>()
        .windows(3)
        .any(|w| w[1].len() >= 12 && w[1].bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
}
