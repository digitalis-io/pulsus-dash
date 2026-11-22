package core

// Priority is the scheduling class of a request (T06 §4.10). Only Interactive exists until the
// planner (T07).
type Priority uint8

// PriorityInteractive is the class of every request until the planner.
const PriorityInteractive Priority = 1

// DataScope is the principal's data scope (T06-002). The zero value is "unset" and is refused by
// every data call (fail closed); FullTenantScope is the only other value until T10 (M-UI6).
type DataScope struct{ full bool }

// FullTenantScope is the scope that sees the whole tenant.
func FullTenantScope() DataScope { return DataScope{full: true} }

// IsFullTenant reports whether the scope is the full tenant.
func (s DataScope) IsFullTenant() bool { return s.full }

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
