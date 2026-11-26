package core

import (
	"errors"

	"github.com/google/uuid"
)

// Priority is the scheduling class of a request (T06 §4.10). Only Interactive exists until the
// planner (T07).
type Priority uint8

// PriorityInteractive is the class of every request until the planner.
const PriorityInteractive Priority = 1

// ErrScopeDenied is returned, before any statement, for an unset or uncompilable data scope
// (T12-018, fail closed; 403 scope_denied).
var ErrScopeDenied = errors.New("data scope denied")

// ScopeClause is one clause of a data scope (T24 §5.9); the clauses of a scope are OR-ed.
// Bindings nil allows any binding, and a non-nil empty Bindings allows none; Attrs maps an
// attribute key to its allowed values.
type ScopeClause struct {
	Bindings []uuid.UUID
	Attrs    map[string][]string
}

// DataScope is the principal's data scope (T06-002). The zero value is "unset" and is refused by
// every data call (fail closed); FullTenantScope is the only value the gateway sets until T10
// (M-UI6). ScopedTenant builds a scope of clauses (tests, T10).
type DataScope struct {
	full, set bool
	clauses   []ScopeClause
}

// FullTenantScope is the scope that sees the whole tenant.
func FullTenantScope() DataScope { return DataScope{full: true, set: true} }

// ScopedTenant is the scope of the given clauses, OR-ed; it is never the full tenant.
func ScopedTenant(clauses ...ScopeClause) DataScope {
	return DataScope{set: true, clauses: clauses}
}

// IsFullTenant reports whether the scope is the full tenant.
func (s DataScope) IsFullTenant() bool { return s.full }

// AnnotationScope returns the scope for the annotations paths: full, or the clauses. An unset
// scope is ErrScopeDenied.
func (s DataScope) AnnotationScope() (full bool, clauses []ScopeClause, err error) {
	if !s.set {
		return false, nil, ErrScopeDenied
	}
	return s.full, s.clauses, nil
}

// Principal is the caller. Until authentication (D12) it is always LocalPrincipal.
type Principal struct{ ID, Name, Role string }

// LocalPrincipal is the fixed principal of every request until authentication lands (D12, M-UI6).
var LocalPrincipal = Principal{ID: "local", Name: "Local user", Role: "admin"}

// TenantCtx is the organisation and the tenant binding resolved for the request (T06 §4.7).
type TenantCtx struct {
	Org     OrgID
	Binding TenantBinding
}

// RequestCtx is carried, by pointer, by every service and data call (T06-002): the organisation
// and the actor of writes (#61), and for PulsusDB calls the resolved tenant binding, the principal,
// a non-optional data scope and the priority (#62).
type RequestCtx struct {
	Org       OrgID
	Actor     Actor
	Tenant    TenantCtx
	Principal Principal
	Scope     DataScope
	Priority  Priority
	RequestID string // the gateway's X-Request-Id
}
