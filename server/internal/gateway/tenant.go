package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// tenantPattern is the slug of a tenant binding (T06-006).
var tenantPattern = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)

// reqError is an error response of a data route: status, envelope body and Retry-After.
type reqError struct {
	status     int
	body       api.ErrorBody
	retryAfter string
}

// fieldError is a 400 invalid with one field (plan #62 §3.4).
func fieldError(pointer, key, message string) *reqError {
	return &reqError{status: http.StatusBadRequest, body: api.ErrorBody{Code: api.Invalid, Message: message,
		Fields: &[]api.FieldError{{Pointer: pointer, MessageKey: key}}}}
}

// tenantParam is the required tenant query parameter.
func tenantParam(r *http.Request) (string, *reqError) {
	t := r.URL.Query().Get("tenant")
	if !tenantPattern.MatchString(t) {
		return "", fieldError("", "tenant.invalid", "tenant is required")
	}
	return t, nil
}

// resolveTenant maps the slug to the bootstrap organisation's binding, read under RLS through
// Deps.Bootstrap (T06-006): the binding is the only source of the upstream decoration.
func resolveTenant(ctx context.Context, d Deps, slug string) (core.TenantCtx, *reqError) {
	unavailable := &reqError{status: http.StatusServiceUnavailable,
		body: api.ErrorBody{Code: api.Unavailable, Message: "configuration store unavailable"}}
	if d.Bootstrap == nil {
		return core.TenantCtx{}, unavailable
	}
	view, err := d.Bootstrap(ctx)
	if err != nil {
		d.Logger.WarnContext(ctx, "tenant_resolution", "error", err.Error())
		return core.TenantCtx{}, unavailable
	}
	for _, b := range view.Bindings {
		if b.Slug == slug {
			return core.TenantCtx{Org: view.Org.ID, Binding: b}, nil
		}
	}
	return core.TenantCtx{}, &reqError{status: http.StatusNotFound, body: api.ErrorBody{Code: api.NotFound, Message: "unknown tenant"}}
}

func hint(kv ...any) *map[string]any {
	m := map[string]any{}
	for i := 0; i+1 < len(kv); i += 2 {
		m[kv[i].(string)] = kv[i+1]
	}
	return &m
}

// upstreamError maps a PulsusDB failure to its response (plan #62 §4.4): status, body and the
// Retry-After value ("" for none).
func upstreamError(err error) (int, api.ErrorBody, string) {
	var e *pulsusdb.Error
	if !errors.As(err, &e) {
		if errors.Is(err, context.DeadlineExceeded) {
			e = &pulsusdb.Error{Kind: pulsusdb.KindTimeout}
		} else {
			return http.StatusInternalServerError, api.ErrorBody{Code: api.Internal, Message: "internal error"}, ""
		}
	}
	var qid *string
	if e.QueryID != "" {
		id := e.QueryID
		qid = &id
	}
	unavailable := func(status int, msg, reason string, extra ...any) (int, api.ErrorBody, string) {
		return status, api.ErrorBody{Code: api.Unavailable, Message: msg, Hint: hint(append([]any{"reason", reason}, extra...)...), QueryId: qid}, ""
	}
	switch e.Kind {
	case pulsusdb.KindQueryInvalid:
		b := api.ErrorBody{Code: api.Invalid, Message: e.Message, QueryId: qid,
			Fields: &[]api.FieldError{{Pointer: "/query", MessageKey: "query.invalid"}}}
		if e.Position != nil {
			b.Hint = hint("position", map[string]any{"offset": e.Position.Offset})
		}
		return http.StatusBadRequest, b, ""
	case pulsusdb.KindTooBroad:
		return http.StatusUnprocessableEntity, api.ErrorBody{Code: api.TooBroad, Message: e.Message, Hint: hint("action", "narrow"), QueryId: qid}, ""
	case pulsusdb.KindRateLimited:
		return http.StatusTooManyRequests, api.ErrorBody{Code: api.BudgetExhausted, Message: "PulsusDB is rate limiting this tenant",
			Hint: hint("reason", "upstream_rate_limited"), QueryId: qid}, e.RetryAfter
	case pulsusdb.KindBusy:
		return http.StatusTooManyRequests, api.ErrorBody{Code: api.BudgetExhausted, Message: "too many queries in flight for this tenant",
			Hint: hint("reason", "tenant_concurrency")}, "1"
	case pulsusdb.KindTimeout:
		return unavailable(http.StatusGatewayTimeout, "the query timed out", "upstream_timeout", "action", "narrow")
	case pulsusdb.KindUnreachable:
		return unavailable(http.StatusBadGateway, "PulsusDB could not be reached", "upstream_unreachable")
	case pulsusdb.KindUnavailable:
		return unavailable(http.StatusBadGateway, "PulsusDB is unavailable", "upstream_unavailable")
	case pulsusdb.KindUnauthorised:
		return unavailable(http.StatusBadGateway, "PulsusDB refused the datasource credentials", "upstream_unauthorised")
	case pulsusdb.KindConfig:
		return unavailable(http.StatusServiceUnavailable, "the datasource is misconfigured", "datasource_config")
	case pulsusdb.KindScopeDenied:
		return http.StatusForbidden, api.ErrorBody{Code: api.ScopeDenied, Message: "data scopes are not supported yet"}, ""
	case pulsusdb.KindVirtual:
		return http.StatusBadRequest, api.ErrorBody{Code: api.VirtualUnsupported, Message: e.Message, Hint: hint("reserved", e.Reserved),
			Fields: &[]api.FieldError{{Pointer: "/" + e.Field, MessageKey: "query.reserved"}}}, ""
	}
	return unavailable(http.StatusBadGateway, "PulsusDB returned an unexpected response", "upstream_error")
}

// WriteErrorBody writes the error envelope {"error":{…}} with every field of body (T06 §5.2).
func WriteErrorBody(w http.ResponseWriter, status int, body api.ErrorBody) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(api.ErrorEnvelope{Error: body})
}

func writeReqError(w http.ResponseWriter, e *reqError) {
	if e.retryAfter != "" {
		w.Header().Set("Retry-After", e.retryAfter)
	}
	WriteErrorBody(w, e.status, e.body)
}
