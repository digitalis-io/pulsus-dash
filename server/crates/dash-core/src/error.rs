//! The JSON error envelope of every Dash route (T06 §5.2).

use serde::Serialize;

/// Machine-readable error code.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    ScopeDenied,
    BudgetExhausted,
    TooBroad,
    Unavailable,
    Invalid,
    Forbidden,
    VirtualUnsupported,
}

impl ErrorCode {
    /// The HTTP status the code is sent with.
    pub fn http_status(self) -> u16 {
        match self {
            ErrorCode::ScopeDenied | ErrorCode::Forbidden => 403,
            ErrorCode::BudgetExhausted => 429,
            ErrorCode::TooBroad => 422,
            ErrorCode::Unavailable => 503,
            ErrorCode::Invalid | ErrorCode::VirtualUnsupported => 400,
        }
    }
}

/// A per-field validation error (`pointer` is a JSON pointer).
#[derive(Clone, Debug, Serialize)]
pub struct FieldError {
    pub pointer: String,
    pub message_key: String,
}

/// The `error` object of the envelope.
#[derive(Clone, Debug, Serialize, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct DashError {
    pub code: ErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<FieldError>,
}

/// `{"error": {...}}`.
#[derive(Clone, Debug, Serialize)]
pub struct ErrorEnvelope<'a> {
    pub error: &'a DashError,
}

impl DashError {
    pub fn new(
        code: ErrorCode,
        message: impl Into<String>,
        hint: Option<serde_json::Value>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            hint,
            query_id: None,
            fields: Vec::new(),
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn envelope_serialises_exactly() {
        let e = DashError::new(
            ErrorCode::Unavailable,
            "postgres unreachable",
            Some(serde_json::json!({"check": "postgres"})),
        );
        let s = serde_json::to_string(&ErrorEnvelope { error: &e }).unwrap();
        assert_eq!(
            s,
            r#"{"error":{"code":"unavailable","message":"postgres unreachable","hint":{"check":"postgres"}}}"#
        );
        assert_eq!(e.code.http_status(), 503);
        let statuses: Vec<u16> = [
            ErrorCode::ScopeDenied,
            ErrorCode::BudgetExhausted,
            ErrorCode::TooBroad,
            ErrorCode::Unavailable,
            ErrorCode::Invalid,
            ErrorCode::Forbidden,
            ErrorCode::VirtualUnsupported,
        ]
        .iter()
        .map(|c| c.http_status())
        .collect();
        assert_eq!(statuses, vec![403, 429, 422, 503, 400, 403, 400]);
    }
}
