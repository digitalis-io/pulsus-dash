//! `dash-gateway`: the HTTP surface of `pulsus-dash` and the only axum crate (T06-001, T06 §5.1).
//! Health routes, the CSP report endpoint and static assets with the T18-002 headers. See
//! `docs/server/architecture.md`.

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;

use dash_core::HealthProbe;
use url::Url;

/// What the router serves.
#[derive(Clone, Debug)]
pub struct GatewayConfig {
    pub assets_dir: PathBuf,
    /// The externally visible URL; `https` adds `upgrade-insecure-requests`.
    pub public_url: Option<Url>,
}

/// The full router.
pub fn router(cfg: &GatewayConfig, health: Arc<dyn HealthProbe>) -> axum::Router {
    let _ = (cfg, health);
    axum::Router::new()
}

/// The Content-Security-Policy (T18-002).
pub fn csp(public_url: Option<&Url>) -> String {
    let _ = public_url;
    String::new()
}

/// Serves `router` on `listener` until `shutdown` resolves, then drains in-flight requests.
pub async fn serve(
    listener: tokio::net::TcpListener,
    router: axum::Router,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown)
        .await
}
