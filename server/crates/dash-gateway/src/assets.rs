//! Static assets from `assets_dir` with the T18-002 / T03-022 headers (plan §3.7).

use std::path::Path;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::CONTENT_TYPE;
use axum::http::{HeaderValue, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use tower_http::services::ServeDir;
use tower_http::set_status::SetStatus;

use crate::headers::{Headers, content_type, is_hashed};

/// `ServeDir` with `index.html` for directories; traversal and missing files → 404
/// `not found`; other methods than GET/HEAD → 405.
pub fn service(dir: &Path) -> ServeDir<SetStatus<axum::routing::MethodRouter>> {
    ServeDir::new(dir)
        .append_index_html_on_directories(true)
        .not_found_service(axum::routing::any(not_found))
}

async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// Sets the content type (by extension; a directory is its `index.html`) and the header set.
pub async fn headers(State(h): State<Headers>, req: Request<Body>, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let mut resp = next.run(req).await;
    let name = path.rsplit('/').next().unwrap_or("");
    let ext = if name.is_empty() {
        "html"
    } else {
        name.rsplit_once('.').map_or("", |(_, e)| e)
    };
    let ok = resp.status().is_success() || resp.status() == StatusCode::NOT_MODIFIED;
    if ok {
        resp.headers_mut()
            .insert(CONTENT_TYPE, HeaderValue::from_static(content_type(ext)));
    }
    if ok && ext == "html" {
        h.document(resp.headers_mut());
    } else {
        h.asset(resp.headers_mut(), ok && is_hashed(name));
    }
    resp
}
