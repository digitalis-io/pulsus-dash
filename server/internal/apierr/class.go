// Package apierr classifies the failure of a data call once (plan #68 Part D1 §3.4): the JSON
// error envelope (gateway) and the error/1 row of a DSF body (arrowwire) are both built from the
// Class, so the two formats agree by construction. It sits below both packages.
package apierr

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

// Classify maps err to its class.
func Classify(err error) Class {
	_ = err
	return Class{}
}

// RetryAfterMs is RetryAfter in milliseconds (false: none).
func (c Class) RetryAfterMs() (uint32, bool) {
	return 0, false
}
