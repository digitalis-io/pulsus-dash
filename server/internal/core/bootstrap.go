package core

// Org is a row of orgs: the tenant boundary of every Postgres row (T11-002).
type Org struct {
	ID         OrgID
	Slug, Name string
}

// BootstrapView is what the client's bootstrap call needs from Postgres: the organisation and its
// tenant bindings, ordered by slug.
type BootstrapView struct {
	Org      Org
	Bindings []TenantBinding
}
