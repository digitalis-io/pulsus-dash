package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"

	"github.com/digitalis-io/pulsus-dash/server/internal/apierr"
	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
)

// tenantPattern is the slug of a tenant binding (T06-006).
var tenantPattern = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)

// reqError is an error response of a data route: status, envelope body and Retry-After.
type reqError struct {
	status     int
	body       api.ErrorBody
	retryAfter string
}

// errCancelled is the answer to a request whose browser went away: nothing is written, and the
// access log records 499.
var errCancelled = &reqError{}

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
		// The route deadline covers resolution: running out of time is a timeout, and a browser
		// that went away is a cancel, not a store failure.
		switch {
		case errors.Is(ctx.Err(), context.Canceled):
			return core.TenantCtx{}, errCancelled
		case ctx.Err() != nil:
			status, body, _ := upstreamError(context.DeadlineExceeded)
			return core.TenantCtx{}, &reqError{status: status, body: body}
		}
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
// Retry-After value ("" for none), all from apierr.Classify (plan #68 D1 §3.4), the mapping the
// DSF error/1 row shares. A cancel is answered as an internal error here; failure writes nothing
// for it.
func upstreamError(err error) (int, api.ErrorBody, string) {
	c := apierr.Classify(err)
	var qid *string
	if c.QueryID != "" {
		id := c.QueryID
		qid = &id
	}
	body := api.ErrorBody{Code: api.ErrorCode(c.Code), Message: c.Message, QueryId: qid}
	switch c.Kind {
	case apierr.BadQuery:
		body.Fields = &[]api.FieldError{{Pointer: "/query", MessageKey: "query.invalid"}}
		if c.Position != nil {
			body.Hint = hint("position", map[string]any{"offset": *c.Position})
		}
	case apierr.Virtual:
		body.Hint = hint("reserved", c.Reserved)
		body.Fields = &[]api.FieldError{{Pointer: "/" + c.Field, MessageKey: "query.reserved"}}
	case apierr.TooBroad:
		body.Hint = hint("action", string(c.Suggestion))
	case apierr.RateLimited, apierr.Busy:
		body.Hint = hint("reason", c.Reason)
		return c.Status, body, c.RetryAfter
	case apierr.Timeout:
		body.Hint = hint("reason", c.Reason, "action", string(c.Suggestion))
	case apierr.Unavailable, apierr.Config:
		body.Hint = hint("reason", c.Reason)
	case apierr.ScopeDenied:
	default: // Internal, Cancelled
		return http.StatusInternalServerError, api.ErrorBody{Code: api.Internal, Message: "internal error"}, ""
	}
	return c.Status, body, ""
}

// WriteErrorBody writes the error envelope {"error":{…}} with every field of body (T06 §5.2).
func WriteErrorBody(w http.ResponseWriter, status int, body api.ErrorBody) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(api.ErrorEnvelope{Error: body})
}

func writeReqError(w http.ResponseWriter, e *reqError) {
	if e == errCancelled {
		return
	}
	if e.retryAfter != "" {
		w.Header().Set("Retry-After", e.retryAfter)
	}
	WriteErrorBody(w, e.status, e.body)
}
