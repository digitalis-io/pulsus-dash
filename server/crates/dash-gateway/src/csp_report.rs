//! `POST /api/dash/v1/csp-report` (T18-002 reporting; plan §3.7): bounded, rate-limited, logs
//! each violation with URLs reduced to their origin.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::{Body, to_bytes};
use axum::extract::{Request, State};
use axum::http::header::{CONTENT_LENGTH, CONTENT_TYPE, RETRY_AFTER};
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use dash_core::{DashError, ErrorCode};
use serde_json::Value;

use crate::error_response;

/// Largest accepted report body.
pub const MAX_BODY: usize = 16 * 1024;
/// Token bucket: sustained rate per second and burst.
pub const RATE_PER_SEC: f64 = 10.0;
pub const BURST: f64 = 20.0;

/// The global (per-process) report budget. Never held across `.await`.
#[derive(Debug)]
pub struct Bucket {
    inner: Mutex<BucketState>,
}

#[derive(Debug)]
struct BucketState {
    tokens: f64,
    refilled: Instant,
    dropped: u64,
    last_drop_log: Option<Instant>,
}

impl Bucket {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(BucketState {
                tokens: BURST,
                refilled: Instant::now(),
                dropped: 0,
                last_drop_log: None,
            }),
        })
    }

    /// Takes one token; on an empty bucket counts the drop and logs at most once a second.
    fn take(&self) -> bool {
        let Ok(mut s) = self.inner.lock() else {
            return false;
        };
        let now = Instant::now();
        let elapsed = now.duration_since(s.refilled).as_secs_f64();
        s.tokens = (s.tokens + elapsed * RATE_PER_SEC).min(BURST);
        s.refilled = now;
        if s.tokens >= 1.0 {
            s.tokens -= 1.0;
            return true;
        }
        s.dropped += 1;
        let due = s
            .last_drop_log
            .is_none_or(|t| now.duration_since(t) >= Duration::from_secs(1));
        if due {
            tracing::warn!(target: "csp", dropped = s.dropped, "csp reports dropped (rate limit)");
            s.dropped = 0;
            s.last_drop_log = Some(now);
        }
        false
    }
}

fn invalid(status: StatusCode, message: &str) -> Response {
    let mut r = error_response(&DashError::new(ErrorCode::Invalid, message, None));
    *r.status_mut() = status;
    r
}

/// The media type without parameters, lower-cased.
fn media_type(req: &Request<Body>) -> String {
    req.headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default()
}

/// One violation, already reduced for logging.
#[derive(Debug, PartialEq, Eq)]
struct Violation {
    directive: String,
    disposition: String,
    blocked: String,
    document: String,
}

/// A URL → its origin (`scheme://host[:port]`, or `scheme:` for opaque ones); a keyword such as
/// `inline` or `eval` is kept; anything else is `invalid`.
fn reduce(s: &str) -> String {
    if let Ok(u) = url::Url::parse(s) {
        let origin = u.origin();
        return if origin.is_tuple() {
            origin.ascii_serialization()
        } else {
            format!("{}:", u.scheme())
        };
    }
    let keyword =
        !s.is_empty() && s.len() <= 32 && s.bytes().all(|b| b.is_ascii_lowercase() || b == b'-');
    if keyword {
        s.to_string()
    } else {
        "invalid".into()
    }
}

fn field(v: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

fn violation(body: &Value) -> Option<Violation> {
    if !body.is_object() {
        return None;
    }
    let directive = field(
        body,
        &[
            "effectiveDirective",
            "effective-directive",
            "violated-directive",
        ],
    );
    let disposition = field(body, &["disposition"]);
    Some(Violation {
        directive: reduce_token(&directive),
        disposition: reduce_token(&disposition),
        blocked: reduce(&field(body, &["blockedURL", "blocked-uri"])),
        document: reduce(&field(body, &["documentURL", "document-uri"])),
    })
}

/// Directive and disposition are short tokens; anything else is not logged verbatim.
fn reduce_token(s: &str) -> String {
    let ok = s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if ok { s.to_string() } else { "invalid".into() }
}

/// Parses either format; `None` = malformed.
fn parse(media: &str, bytes: &[u8]) -> Option<Vec<Violation>> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    match media {
        "application/reports+json" => v
            .as_array()?
            .iter()
            .filter(|r| r.get("type").and_then(Value::as_str) == Some("csp-violation"))
            .map(|r| r.get("body").and_then(violation))
            .collect(),
        _ => Some(vec![violation(v.get("csp-report")?)?]),
    }
}

pub async fn handle(State(bucket): State<Arc<Bucket>>, req: Request<Body>) -> Response {
    let media = media_type(&req);
    if media != "application/reports+json" && media != "application/csp-report" {
        return invalid(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported report type",
        );
    }
    let declared = req
        .headers()
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok());
    if declared.is_some_and(|n| n > MAX_BODY) {
        return invalid(StatusCode::PAYLOAD_TOO_LARGE, "report too large");
    }
    if !bucket.take() {
        let mut r = error_response(&DashError::new(
            ErrorCode::BudgetExhausted,
            "too many reports",
            None,
        ));
        r.headers_mut()
            .insert(RETRY_AFTER, HeaderValue::from_static("1"));
        return r;
    }
    let Ok(bytes) = to_bytes(req.into_body(), MAX_BODY).await else {
        return invalid(StatusCode::PAYLOAD_TOO_LARGE, "report too large");
    };
    let Some(violations) = parse(&media, &bytes) else {
        return invalid(StatusCode::BAD_REQUEST, "malformed report");
    };
    for v in violations {
        tracing::warn!(
            target: "csp",
            effective_directive = %v.directive,
            disposition = %v.disposition,
            blocked = %v.blocked,
            document = %v.document,
            "csp violation"
        );
    }
    let mut r = Response::new(Body::empty());
    *r.status_mut() = StatusCode::NO_CONTENT;
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reduce_keeps_origins_and_keywords() {
        assert_eq!(
            reduce("https://evil.example/p-x9/a.js"),
            "https://evil.example"
        );
        assert_eq!(reduce("http://h:8080/x?q"), "http://h:8080");
        assert_eq!(reduce("inline"), "inline");
        assert_eq!(reduce("data:text/javascript,1"), "data:");
        assert_eq!(reduce("some thing/with path"), "invalid");
    }
}
