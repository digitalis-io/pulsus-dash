//! The tenant and request context every data call carries (T06-002, T06 §4.1, §4.7).

use std::sync::Arc;
use std::time::Duration;

use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

use crate::ids::{OrgId, ScopeOrgId, TeamId, TenantBindingId, UserId};

/// The PulsusDB tenant header (T06 §4.3).
pub const SCOPE_HEADER: &str = "X-Scope-OrgID";

/// An org's binding to a PulsusDB datasource (T06-025). Credentials are never part of it.
#[derive(Clone, Debug)]
pub struct TenantBinding {
    pub id: TenantBindingId,
    pub slug: String,
    pub datasource_url: Url,
    pub database: Option<String>,
    pub scope_org_id: Option<ScopeOrgId>,
}

impl TenantBinding {
    /// `("X-Scope-OrgID", value)` when the binding has a scope; `None` omits the header.
    pub fn scope_header(&self) -> Option<(&'static str, &str)> {
        None
    }
}

/// The resolved tenant of a request.
#[derive(Clone, Debug)]
pub struct TenantCtx {
    pub org: OrgId,
    pub binding: TenantBinding,
}

/// The built-in roles seeded per org (ENT-003).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuiltinRole {
    Viewer,
    Responder,
    Editor,
    Admin,
}

impl BuiltinRole {
    pub const ALL: [BuiltinRole; 4] = [
        BuiltinRole::Viewer,
        BuiltinRole::Responder,
        BuiltinRole::Editor,
        BuiltinRole::Admin,
    ];

    /// The stored role name.
    pub fn as_str(self) -> &'static str {
        match self {
            BuiltinRole::Viewer => "Viewer",
            BuiltinRole::Responder => "Responder",
            BuiltinRole::Editor => "Editor",
            BuiltinRole::Admin => "Admin",
        }
    }
}

/// How the principal authenticated (T06 §4.11).
#[derive(Clone, Debug)]
pub struct AuthContext {
    pub idp: Option<Uuid>,
    pub acr: Option<String>,
    pub amr: Vec<String>,
}

/// Who is calling.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub enum Principal {
    User {
        org: OrgId,
        user: UserId,
        teams: Vec<TeamId>,
        roles: Vec<BuiltinRole>,
        auth: AuthContext,
    },
    /// A per-tenant service principal (T06-002).
    Service { org: OrgId, name: String },
}

/// The data scope applied to every query (T06 §4.11; M-UI1 default: the whole tenant).
#[derive(Clone, Debug)]
#[non_exhaustive]
pub enum DataScope {
    FullTenant,
}

/// Admission priority class (T06 §4.10).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Priority {
    Interactive,
    Alerting,
    Refine,
    Prefetch,
    Agent,
    ExternalAgent,
    Background,
}

/// An absolute deadline on the tokio clock.
#[derive(Clone, Copy, Debug)]
pub struct Deadline(tokio::time::Instant);

impl Deadline {
    /// The deadline `d` from now.
    pub fn after(d: Duration) -> Self {
        Self(tokio::time::Instant::now() + d)
    }

    /// Time left; zero once expired.
    pub fn remaining(&self) -> Duration {
        Duration::from_secs(1)
    }

    pub fn is_expired(&self) -> bool {
        false
    }
}

/// The context of one request (T06-002). Budget and trace fields are added by later crates.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct RequestCtx {
    pub tenant: TenantCtx,
    pub principal: Principal,
    pub scope: Arc<DataScope>,
    pub deadline: Deadline,
    pub priority: Priority,
    pub cancel: CancellationToken,
}

impl RequestCtx {
    pub fn new(
        tenant: TenantCtx,
        principal: Principal,
        scope: Arc<DataScope>,
        deadline: Deadline,
        priority: Priority,
        cancel: CancellationToken,
    ) -> Self {
        Self {
            tenant,
            principal,
            scope,
            deadline,
            priority,
            cancel,
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn binding(scope: &str) -> TenantBinding {
        TenantBinding {
            id: TenantBindingId::new_v7(),
            slug: "default".into(),
            datasource_url: Url::parse("http://pulsusdb.invalid:9/").unwrap(),
            database: None,
            scope_org_id: ScopeOrgId::parse(scope).unwrap(),
        }
    }

    #[test]
    fn scope_header_omitted_when_unset() {
        assert_eq!(binding("").scope_header(), None);
        assert_eq!(
            binding("tenant-a").scope_header(),
            Some(("X-Scope-OrgID", "tenant-a"))
        );
    }

    #[test]
    fn deadline_remaining_saturates() {
        let d = Deadline::after(Duration::ZERO);
        assert_eq!(d.remaining(), Duration::ZERO);
        assert!(d.is_expired());
    }
}
