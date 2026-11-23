package logs

import "net/http"

// PlanErrorKind classifies a planning refusal (plan #116 §3.1, the rows of plan #112 §3.1).
type PlanErrorKind int

// The planning refusals.
const (
	ErrInput           PlanErrorKind = iota + 1 // a request member out of range or malformed, or a value that cannot be written (rows 1–6, 7b)
	ErrVariableMissing                          // a referenced variable without a value (row 7)
	ErrProcessingCap                            // the substituted text would exceed MaxExpandedBytes (row 9)
	ErrSentTooLarge                             // the final planned text exceeds MaxSentBytes (row 10)
)

// FieldError is one field of a refusal: a JSON pointer into the request and a message key.
type FieldError struct{ Pointer, MessageKey string }

// PlanError is a planning refusal. It never carries the query text or a variable value.
type PlanError struct {
	Kind    PlanErrorKind
	Message string
	Fields  []FieldError
	// Position is set by row 9b only: the byte offset of the '#' in the raw text (plan #121 §3.1).
	Position *int
	// Planned is set on every ErrSentTooLarge (the full plan) and nil otherwise.
	Planned *Planned
}

func (e *PlanError) Error() string { return "logs: plan: " + e.Message }

// Status is the HTTP status of the refusal: 413 for the two size refusals, else 400.
func (e *PlanError) Status() int {
	if e.Kind == ErrProcessingCap || e.Kind == ErrSentTooLarge {
		return http.StatusRequestEntityTooLarge
	}
	return http.StatusBadRequest
}
