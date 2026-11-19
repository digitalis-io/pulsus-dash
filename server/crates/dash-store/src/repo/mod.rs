//! Repositories. Every function takes an [`OrgTx`](crate::OrgTx) and reads the org only from
//! [`OrgTx::org`](crate::OrgTx::org) (T11-023); `itest_rls::REPO_FNS` must list each one.

pub mod orgs;
pub mod roles;
pub mod tenant_bindings;
