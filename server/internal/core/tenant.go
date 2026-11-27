package core

import "github.com/google/uuid"

// BootstrapSeed is the first organisation and tenant binding that migrate writes on an empty
// database. It comes from the seed keys of the configuration (datasource.*, bootstrap.*).
type BootstrapSeed struct {
	OrgSlug, OrgName string
	Binding          BindingSeed
}

// BindingSeed is the seeded tenant binding. An empty string is stored as NULL. CredentialsRef is a
// secret reference (env:NAME or file:/path), never a resolved value (T19-010).
type BindingSeed struct {
	Slug, DatasourceURL, Database, ScopeOrgID, CredentialsRef string
}

// TenantBinding is a row of tenant_bindings: the authoritative PulsusDB binding of an organisation
// (T19-010). An empty string means NULL. CredentialsRef is the reference string, never a value.
type TenantBinding struct {
	OrgID                                                           OrgID
	ID                                                              uuid.UUID
	Slug, DatasourceURL, Database, ScopeOrgID, CredentialsRef, Kind string
	// ScopeSeq orders the binding's access-determining versions (#304 §A.2, ADR-0038).
	ScopeSeq int64
}

// ScopeEpoch is a stub (tests first, #304).
func ScopeEpoch(principal string, b TenantBinding, s DataScope) string { return "" }

// Canonical is a stub (tests first, #304).
func (s DataScope) Canonical() string { return "" }
