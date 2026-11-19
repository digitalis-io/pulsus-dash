//! Server core types shared by every `pulsus-dash` crate (T06 §4.1): ids, the per-request and
//! per-tenant context, the JSON error envelope (T06 §5.2), the health probe and [`Secret`].

pub mod ctx;
pub mod error;
pub mod health;
pub mod ids;
pub mod secret;

pub use ctx::{
    AuthContext, BuiltinRole, DataScope, Deadline, Principal, Priority, RequestCtx, TenantBinding,
    TenantCtx,
};
pub use error::{DashError, ErrorCode, ErrorEnvelope, FieldError};
pub use health::{HealthProbe, Readiness, ReadyCheck};
pub use ids::{InvalidScopeOrgId, OrgId, RoleId, ScopeOrgId, TeamId, TenantBindingId, UserId};
pub use secret::Secret;

/// Printed by `Debug` in place of a configured URL or secret (plan §3.3 output rule).
pub const REDACTED: Redacted = Redacted;

/// Formats (`Debug` and `Display`) as `<redacted>`.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Redacted;

impl std::fmt::Debug for Redacted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

impl std::fmt::Display for Redacted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}
