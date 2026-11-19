//! `dash-gateway`: the HTTP surface of `pulsus-dash` and the only axum crate (T06-001, T06 §5.1).
//! Health routes, the CSP report endpoint and static assets with the T18-002 headers. See
//! `docs/server/architecture.md`.

mod assets;
mod csp_report;
mod headers;
mod health;

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use dash_core::{DashError, ErrorEnvelope, HealthProbe};
use url::Url;

pub use headers::{REPORT_PATH, csp};

/// What the router serves. `Debug` redacts the public URL.
#[derive(Clone)]
pub struct GatewayConfig {
    pub assets_dir: PathBuf,
    /// The externally visible URL; `https` adds `upgrade-insecure-requests`.
    pub public_url: Option<Url>,
}

impl std::fmt::Debug for GatewayConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GatewayConfig")
            .field("assets_dir", &self.assets_dir)
            .field(
                "public_url",
                &self.public_url.as_ref().map(|_| dash_core::REDACTED),
            )
            .finish()
    }
}

/// The full router (plan §3.7).
pub fn router(cfg: &GatewayConfig, health: Arc<dyn HealthProbe>) -> Router {
    let headers = headers::Headers::new(cfg.public_url.as_ref());
    let statics = Router::new()
        .fallback_service(assets::service(&cfg.assets_dir))
        .layer(axum::middleware::from_fn_with_state(
            headers,
            assets::headers,
        ));
    let reports = Router::new()
        .route(REPORT_PATH, post(csp_report::handle))
        .with_state(csp_report::Bucket::new());
    Router::new()
        .route("/healthz", get(health::healthz))
        .route("/startupz", get(health::startupz))
        .route("/readyz", get(health::readyz))
        .with_state(health)
        .merge(reports)
        .fallback_service(statics)
}

/// Serves `router` on `listener` until `shutdown` resolves, then drains in-flight requests.
pub async fn serve(
    listener: tokio::net::TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown)
        .await
}

/// A JSON body with the JSON header set.
pub(crate) fn json_response(status: StatusCode, body: &serde_json::Value) -> Response {
    let mut r = Response::new(Body::from(body.to_string()));
    *r.status_mut() = status;
    headers::json(r.headers_mut());
    r
}

/// The T06 §5.2 envelope with the code's status.
pub(crate) fn error_response(e: &DashError) -> Response {
    let status =
        StatusCode::from_u16(e.code.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let body = serde_json::to_value(ErrorEnvelope { error: e }).unwrap_or_default();
    json_response(status, &body)
}
