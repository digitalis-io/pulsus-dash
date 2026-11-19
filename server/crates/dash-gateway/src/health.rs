//! `/healthz`, `/startupz`, `/readyz` (T19-006, T06-026; plan §3.7).

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::Response;
use dash_core::{DashError, ErrorCode, HealthProbe, Readiness};
use serde_json::json;

use crate::json_response;

pub async fn healthz() -> Response {
    json_response(StatusCode::OK, &json!({"status": "ok"}))
}

pub async fn startupz(State(probe): State<Arc<dyn HealthProbe>>) -> Response {
    if probe.started() {
        json_response(StatusCode::OK, &json!({"status": "started"}))
    } else {
        unavailable("starting", "startup")
    }
}

pub async fn readyz(State(probe): State<Arc<dyn HealthProbe>>) -> Response {
    match probe.readiness().await {
        Readiness::Ready { schema_level } => json_response(
            StatusCode::OK,
            &json!({"status": "ready", "schema_level": schema_level}),
        ),
        Readiness::NotReady { check, message } => unavailable(&message, check.as_str()),
    }
}

fn unavailable(message: &str, check: &str) -> Response {
    crate::error_response(&DashError::new(
        ErrorCode::Unavailable,
        message,
        Some(json!({ "check": check })),
    ))
}
