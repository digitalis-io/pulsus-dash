//! UUIDv7 id newtypes (T11 §4.0) and the PulsusDB tenant header value.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

macro_rules! id_newtype {
    ($(#[$m:meta])* $name:ident) => {
        $(#[$m])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            /// A new time-ordered UUIDv7 id.
            pub fn new_v7() -> Self {
                Self(Uuid::now_v7())
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                self.0.fmt(f)
            }
        }
    };
}

id_newtype!(
    /// An organisation (the Dash tenant).
    OrgId
);
id_newtype!(
    /// A user of one org.
    UserId
);
id_newtype!(
    /// A team of one org.
    TeamId
);
id_newtype!(
    /// A role of one org.
    RoleId
);
id_newtype!(
    /// A tenant binding (org → PulsusDB datasource, T06-025).
    TenantBindingId
);

/// Maximum length of an `X-Scope-OrgID` value.
pub const SCOPE_ORG_ID_MAX: usize = 150;

/// An `X-Scope-OrgID` value: `^[A-Za-z0-9_.-]{1,150}$` (T06 §4.3).
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
#[serde(transparent)]
pub struct ScopeOrgId(String);

/// The value is not a valid `X-Scope-OrgID`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error, Serialize)]
#[error("must match ^[A-Za-z0-9_.-]{{1,150}}$")]
pub struct InvalidScopeOrgId;

impl ScopeOrgId {
    /// Parses a header value; empty → `Ok(None)` (the header is omitted).
    pub fn parse(s: &str) -> Result<Option<Self>, InvalidScopeOrgId> {
        let _ = s;
        Ok(None)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn scope_org_id_parse() {
        assert_eq!(ScopeOrgId::parse(""), Ok(None));
        assert_eq!(
            ScopeOrgId::parse("tenant-a")
                .unwrap()
                .map(|s| s.as_str().to_string()),
            Some("tenant-a".to_string())
        );
        assert_eq!(ScopeOrgId::parse("a b"), Err(InvalidScopeOrgId));
        assert_eq!(ScopeOrgId::parse(&"a".repeat(151)), Err(InvalidScopeOrgId));
        assert!(ScopeOrgId::parse(&"a".repeat(150)).unwrap().is_some());
    }
}
