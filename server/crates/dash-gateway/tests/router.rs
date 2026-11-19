#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The gateway router: headers (T18-002, T03-022), CSP reports, static files and health
//! (T06-026, T19-006). Plan §3.7.

use std::io::Write;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, Response, StatusCode};
use dash_core::{HealthProbe, Readiness, ReadyCheck};
use dash_gateway::{GatewayConfig, csp, router};
use http_body_util::BodyExt;
use tower::ServiceExt;

#[derive(Default)]
struct Fake {
    state: Mutex<(bool, Option<Readiness>)>,
}

#[async_trait]
impl HealthProbe for Fake {
    fn started(&self) -> bool {
        self.state.lock().unwrap().0
    }
    async fn readiness(&self) -> Readiness {
        let s = self.state.lock().unwrap().clone();
        match (s.0, s.1) {
            (true, Some(r)) => r,
            _ => Readiness::NotReady {
                check: ReadyCheck::Startup,
                message: "starting".into(),
            },
        }
    }
}

fn assets(files: &[(&str, &[u8])]) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    for (p, b) in files {
        let path = dir.path().join(p);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b).unwrap();
    }
    dir
}

fn app(dir: &tempfile::TempDir, probe: Arc<Fake>) -> axum::Router {
    router(
        &GatewayConfig {
            assets_dir: dir.path().to_path_buf(),
            public_url: None,
        },
        probe,
    )
}

async fn send(app: &axum::Router, req: Request<Body>) -> (Response<()>, Vec<u8>) {
    let resp = app.clone().oneshot(req).await.unwrap();
    let (parts, body) = resp.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes().to_vec();
    (Response::from_parts(parts, ()), bytes)
}

async fn get(app: &axum::Router, path: &str) -> (Response<()>, Vec<u8>) {
    send(app, Request::get(path).body(Body::empty()).unwrap()).await
}

fn h<'a>(r: &'a Response<()>, name: &str) -> Option<&'a str> {
    r.headers().get(name).map(|v| v.to_str().unwrap())
}

const ISOLATION: [(&str, &str); 4] = [
    ("cross-origin-opener-policy", "same-origin"),
    ("cross-origin-embedder-policy", "require-corp"),
    ("cross-origin-resource-policy", "same-origin"),
    ("x-content-type-options", "nosniff"),
];

#[tokio::test]
async fn document_headers_exact() {
    let dir = assets(&[("index.html", b"<!doctype html><p>x</p>")]);
    let app = app(&dir, Arc::new(Fake::default()));
    let (r, body) = get(&app, "/").await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(body, b"<!doctype html><p>x</p>");
    let want = [
        ("content-type", "text/html; charset=utf-8".to_string()),
        ("content-security-policy", csp(None)),
        (
            "reporting-endpoints",
            "csp=\"/api/dash/v1/csp-report\"".to_string(),
        ),
        ("cross-origin-opener-policy", "same-origin".to_string()),
        ("cross-origin-embedder-policy", "require-corp".to_string()),
        ("cross-origin-resource-policy", "same-origin".to_string()),
        (
            "strict-transport-security",
            "max-age=63072000; includeSubDomains; preload".to_string(),
        ),
        ("x-content-type-options", "nosniff".to_string()),
        (
            "referrer-policy",
            "strict-origin-when-cross-origin".to_string(),
        ),
        (
            "permissions-policy",
            "camera=(), geolocation=(), microphone=(self), usb=(), payment=(), gamepad=(self)"
                .to_string(),
        ),
        ("cache-control", "no-cache".to_string()),
    ];
    for (k, v) in want {
        assert_eq!(h(&r, k), Some(v.as_str()), "{k}");
    }
    assert!(!csp(None).is_empty());
}

#[tokio::test]
async fn asset_headers_and_types() {
    let dir = assets(&[
        ("shim/boot.js", b"export {};"),
        ("x_bg.wasm", b"\0asm"),
        ("core.0123456789ab.wasm", b"\0asm"),
    ]);
    let app = app(&dir, Arc::new(Fake::default()));
    let cases = [
        (
            "/shim/boot.js",
            "text/javascript; charset=utf-8",
            "no-cache",
        ),
        ("/x_bg.wasm", "application/wasm", "no-cache"),
        (
            "/core.0123456789ab.wasm",
            "application/wasm",
            "public, max-age=31536000, immutable",
        ),
    ];
    for (path, ty, cache) in cases {
        let (r, _) = get(&app, path).await;
        assert_eq!(r.status(), StatusCode::OK, "{path}");
        assert_eq!(h(&r, "content-type"), Some(ty), "{path}");
        assert_eq!(h(&r, "cache-control"), Some(cache), "{path}");
        assert_eq!(
            h(&r, "content-security-policy"),
            Some(csp(None).as_str()),
            "{path}"
        );
        assert_eq!(
            h(&r, "reporting-endpoints"),
            Some("csp=\"/api/dash/v1/csp-report\""),
            "{path}"
        );
        for (k, v) in ISOLATION {
            assert_eq!(h(&r, k), Some(v), "{path} {k}");
        }
        assert_eq!(h(&r, "strict-transport-security"), None, "{path}");
    }
}

#[test]
fn csp_is_strict() {
    let https = url::Url::parse("https://dash.example/").unwrap();
    let http = url::Url::parse("http://localhost:8080/").unwrap();
    for (c, upgrade) in [
        (csp(None), false),
        (csp(Some(&http)), false),
        (csp(Some(&https)), true),
    ] {
        assert!(
            !c.contains("'unsafe-inline'") && !c.contains("'unsafe-eval'"),
            "{c}"
        );
        for want in [
            "'wasm-unsafe-eval'",
            "require-trusted-types-for 'script'",
            "trusted-types pulsus-sanitised",
            "report-to csp",
        ] {
            assert!(c.contains(want), "{want}: {c}");
        }
        assert_eq!(
            c.contains("upgrade-insecure-requests; report-to csp"),
            upgrade,
            "{c}"
        );
        assert_eq!(c.contains("upgrade-insecure-requests"), upgrade, "{c}");
    }
    assert_eq!(
        csp(None),
        "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types pulsus-sanitised; report-to csp"
    );
}

/// A `MakeWriter` capturing formatted log lines.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
    type Writer = Capture;
    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

fn report(ct: &str, body: impl Into<Vec<u8>>) -> Request<Body> {
    Request::post("/api/dash/v1/csp-report")
        .header("content-type", ct)
        .body(Body::from(body.into()))
        .unwrap()
}

const MODERN: &str = r#"[{"type":"csp-violation","age":1,"url":"https://dash.example/","body":{"documentURL":"https://dash.example/board/p-doc","blockedURL":"https://evil.example/p-x9/a.js","effectiveDirective":"script-src-elem","disposition":"enforce"}}]"#;
const LEGACY: &str = r#"{"csp-report":{"document-uri":"https://dash.example/","blocked-uri":"inline","effective-directive":"style-src-elem","disposition":"enforce"}}"#;

fn error_code(body: &[u8]) -> String {
    let v: serde_json::Value = serde_json::from_slice(body).unwrap();
    v["error"]["code"].as_str().unwrap().to_string()
}

#[tokio::test]
async fn csp_report_endpoint() {
    let cap = Capture::default();
    let sub = tracing_subscriber::fmt()
        .with_writer(cap.clone())
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(sub);
    let dir = assets(&[]);
    let app = app(&dir, Arc::new(Fake::default()));
    let (r, _) = send(&app, report("application/reports+json", MODERN)).await;
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    let (r, _) = send(&app, report("application/csp-report", LEGACY)).await;
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    let (r, b) = send(&app, report("text/plain", MODERN)).await;
    assert_eq!(r.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(error_code(&b), "invalid");
    let big = format!("[{}]", " ".repeat(17 * 1024));
    let (r, b) = send(&app, report("application/reports+json", big)).await;
    assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(error_code(&b), "invalid");
    let (r, b) = send(&app, report("application/reports+json", "{")).await;
    assert_eq!(r.status(), StatusCode::BAD_REQUEST);
    assert_eq!(error_code(&b), "invalid");
    assert_eq!(h(&r, "cache-control"), Some("no-store"));
    let logs = String::from_utf8(cap.0.lock().unwrap().clone()).unwrap();
    let line = logs
        .lines()
        .find(|l| l.contains("script-src-elem"))
        .unwrap_or_else(|| panic!("no violation logged: {logs}"));
    assert!(line.contains("https://evil.example"), "{line}");
    assert!(!logs.contains("p-x9") && !logs.contains("p-doc"), "{logs}");
    assert!(logs.contains("inline"), "{logs}");
    // Rate limit: a fresh router, 25 at once.
    let app2 = self::app(&dir, Arc::new(Fake::default()));
    let mut limited = 0;
    for _ in 0..25 {
        let (r, b) = send(&app2, report("application/reports+json", MODERN)).await;
        if r.status() == StatusCode::TOO_MANY_REQUESTS {
            assert_eq!(error_code(&b), "budget_exhausted");
            assert_eq!(h(&r, "retry-after"), Some("1"));
            limited += 1;
        } else {
            assert_eq!(r.status(), StatusCode::NO_CONTENT);
        }
    }
    assert!(limited >= 5, "{limited}");
}

#[tokio::test]
async fn traversal_and_methods() {
    let dir = assets(&[("index.html", b"<p>x</p>"), ("sub/a.txt", b"a")]);
    let app = app(&dir, Arc::new(Fake::default()));
    let (r, _) = get(&app, "/sub/../../Cargo.toml").await;
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    let (r, _) = get(&app, "/../Cargo.toml").await;
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    let (r, _) = get(&app, "/%2e%2e/x").await;
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    let (r, body) = get(&app, "/missing.js").await;
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    assert_eq!(body, b"not found");
    let (r, _) = send(&app, Request::post("/").body(Body::empty()).unwrap()).await;
    assert_eq!(r.status(), StatusCode::METHOD_NOT_ALLOWED);
}

fn json(body: &[u8]) -> serde_json::Value {
    serde_json::from_slice(body).unwrap()
}

#[tokio::test]
async fn health_routes() {
    let dir = assets(&[]);
    let probe = Arc::new(Fake::default());
    let app = app(&dir, probe.clone());
    let (r, b) = get(&app, "/healthz").await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(json(&b), serde_json::json!({"status": "ok"}));
    assert_eq!(h(&r, "cache-control"), Some("no-store"));
    assert_eq!(h(&r, "content-type"), Some("application/json"));
    assert_eq!(h(&r, "x-content-type-options"), Some("nosniff"));
    assert_eq!(h(&r, "cross-origin-resource-policy"), Some("same-origin"));
    let (r, b) = get(&app, "/startupz").await;
    assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        json(&b),
        serde_json::json!({"error": {"code": "unavailable", "message": "starting", "hint": {"check": "startup"}}})
    );
    let (r, _) = get(&app, "/readyz").await;
    assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
    *probe.state.lock().unwrap() = (true, Some(Readiness::Ready { schema_level: 1 }));
    let (r, b) = get(&app, "/startupz").await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(json(&b), serde_json::json!({"status": "started"}));
    let (r, b) = get(&app, "/readyz").await;
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(
        json(&b),
        serde_json::json!({"status": "ready", "schema_level": 1})
    );
    *probe.state.lock().unwrap() = (
        true,
        Some(Readiness::NotReady {
            check: ReadyCheck::Postgres,
            message: "postgres unreachable".into(),
        }),
    );
    let (r, b) = get(&app, "/readyz").await;
    assert_eq!(r.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        json(&b),
        serde_json::json!({"error": {"code": "unavailable", "message": "postgres unreachable", "hint": {"check": "postgres"}}})
    );
    assert_eq!(h(&r, "cache-control"), Some("no-store"));
}

#[test]
fn gateway_config_debug_redacts_url() {
    let cfg = GatewayConfig {
        assets_dir: "web".into(),
        public_url: Some(url::Url::parse("https://pub.sentinel.invalid/pp-path-s/").unwrap()),
    };
    let text = format!("{cfg:?}");
    assert!(
        !text.contains("sentinel") && !text.contains("pp-path-s"),
        "{text}"
    );
}
