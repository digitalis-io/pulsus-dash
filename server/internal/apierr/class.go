// Package apierr classifies the failure of a data call once (plan #68 Part D1 §3.4): the JSON
// error envelope (gateway) and the error/1 row of a DSF body (arrowwire) are both built from the
// Class, so the two formats agree by construction. It sits below both packages.
package apierr

import (
	"context"
	"errors"
	"math"
	"net/http"
	"strconv"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// Kind is the class of a failure.
type Kind uint8

// The kinds, one per row of the mapping table.
const (
	Internal    Kind = iota // anything else
	BadQuery                // pulsusdb.KindQueryInvalid
	Virtual                 // pulsusdb.KindVirtual
	TooBroad                // pulsusdb.KindTooBroad
	ScopeDenied             // pulsusdb.KindScopeDenied
	RateLimited             // pulsusdb.KindRateLimited
	Busy                    // pulsusdb.KindBusy
	Timeout                 // pulsusdb.KindTimeout, context.DeadlineExceeded
	Unavailable             // unreachable, unavailable, unauthorised and every other pulsusdb.Error
	Config                  // pulsusdb.KindConfig
	Cancelled               // context.Canceled: the browser went away, nothing is written
)

// Code is the code of the JSON error envelope (the api.ErrorCode values).
type Code string

// The envelope codes.
const (
	CodeInvalid            Code = "invalid"
	CodeVirtualUnsupported Code = "virtual_unsupported"
	CodeTooBroad           Code = "too_broad"
	CodeScopeDenied        Code = "scope_denied"
	CodeBudgetExhausted    Code = "budget_exhausted"
	CodeUnavailable        Code = "unavailable"
	CodeInternal           Code = "internal"
)

// Suggestion is what the user can do about the failure ("" = nothing).
type Suggestion string

// SuggestNarrow: narrow the query or the range (hint action and error/1 suggestion "narrow").
const SuggestNarrow Suggestion = "narrow"

// Class is the classified failure: what the envelope and the error/1 row carry.
type Class struct {
	Kind       Kind
	Status     int    // the HTTP status of the envelope and of error/1 http_status; 0 for Cancelled
	Code       Code   // the envelope code
	Message    string // the user-facing message (PulsusDB's cleaned text, or a fixed one)
	Reason     string // the envelope's hint reason ("" = none)
	Suggestion Suggestion
	Position   *int   // BadQuery: the byte offset in the text the caller mapped (nil = none)
	RetryAfter string // the Retry-After value in seconds ("" = none)
	QueryID    string // the upstream query id the envelope carries ("" = none)
	// Field and Reserved are the input and the reserved name of a Virtual refusal.
	Field, Reserved string
}

// Classify maps err to its class (§3.4). A *pulsusdb.Error is classified by its kind, a
// context.DeadlineExceeded is a timeout and a context.Canceled a cancel; anything else is
// internal, with a fixed message.
func Classify(err error) Class {
	var e *pulsusdb.Error
	switch {
	case errors.As(err, &e):
	case errors.Is(err, context.DeadlineExceeded):
		e = &pulsusdb.Error{Kind: pulsusdb.KindTimeout}
	case errors.Is(err, context.Canceled):
		return Class{Kind: Cancelled, Code: CodeInternal, Message: "cancelled"}
	default:
		return Class{Kind: Internal, Status: http.StatusInternalServerError, Code: CodeInternal, Message: "internal error"}
	}
	unavailable := func(k Kind, status int, msg, reason string) Class {
		return Class{Kind: k, Status: status, Code: CodeUnavailable, Message: msg, Reason: reason, QueryID: e.QueryID}
	}
	switch e.Kind {
	case pulsusdb.KindQueryInvalid:
		c := Class{Kind: BadQuery, Status: http.StatusBadRequest, Code: CodeInvalid, Message: e.Message, QueryID: e.QueryID}
		if e.Position != nil {
			off := e.Position.Offset
			c.Position = &off
		}
		return c
	case pulsusdb.KindVirtual:
		return Class{Kind: Virtual, Status: http.StatusBadRequest, Code: CodeVirtualUnsupported, Message: e.Message, Field: e.Field, Reserved: e.Reserved}
	case pulsusdb.KindTooBroad:
		return Class{Kind: TooBroad, Status: http.StatusUnprocessableEntity, Code: CodeTooBroad, Message: e.Message, Suggestion: SuggestNarrow, QueryID: e.QueryID}
	case pulsusdb.KindScopeDenied:
		return Class{Kind: ScopeDenied, Status: http.StatusForbidden, Code: CodeScopeDenied, Message: "data scopes are not supported yet"}
	case pulsusdb.KindRateLimited:
		return Class{Kind: RateLimited, Status: http.StatusTooManyRequests, Code: CodeBudgetExhausted, Message: "PulsusDB is rate limiting this tenant",
			Reason: "upstream_rate_limited", RetryAfter: e.RetryAfter, QueryID: e.QueryID}
	case pulsusdb.KindBusy:
		return Class{Kind: Busy, Status: http.StatusTooManyRequests, Code: CodeBudgetExhausted, Message: "too many queries in flight for this tenant",
			Reason: "tenant_concurrency", RetryAfter: "1"}
	case pulsusdb.KindTimeout:
		c := unavailable(Timeout, http.StatusGatewayTimeout, "the query timed out", "upstream_timeout")
		c.Suggestion = SuggestNarrow
		return c
	case pulsusdb.KindUnreachable:
		return unavailable(Unavailable, http.StatusBadGateway, "PulsusDB could not be reached", "upstream_unreachable")
	case pulsusdb.KindUnavailable:
		return unavailable(Unavailable, http.StatusBadGateway, "PulsusDB is unavailable", "upstream_unavailable")
	case pulsusdb.KindUnauthorised:
		return unavailable(Unavailable, http.StatusBadGateway, "PulsusDB refused the datasource credentials", "upstream_unauthorised")
	case pulsusdb.KindConfig:
		return unavailable(Config, http.StatusServiceUnavailable, "the datasource is misconfigured", "datasource_config")
	}
	return unavailable(Unavailable, http.StatusBadGateway, "PulsusDB returned an unexpected response", "upstream_error")
}

// RetryAfterMs is RetryAfter in milliseconds (false: none or not a number of seconds that fits).
func (c Class) RetryAfterMs() (uint32, bool) {
	if c.RetryAfter == "" {
		return 0, false
	}
	s, err := strconv.ParseUint(c.RetryAfter, 10, 32)
	if err != nil || s > math.MaxUint32/1000 {
		return 0, false
	}
	return uint32(s) * 1000, true // #nosec G115 -- s ≤ MaxUint32/1000, checked above
}
