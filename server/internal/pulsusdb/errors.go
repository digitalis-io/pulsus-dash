package pulsusdb

// ErrorKind classifies a failure of a PulsusDB call (plan #62 §3.3).
type ErrorKind int

// The error kinds.
const (
	KindUnreachable  ErrorKind = iota + 1 // transport error before headers, retries exhausted
	KindTimeout                           // ctx deadline before headers; upstream 504; 503 errorType timeout
	KindUnavailable                       // 503 errorType unavailable after retries
	KindQueryInvalid                      // 400
	KindTooBroad                          // 422
	KindRateLimited                       // 429
	KindUnauthorised                      // 401, 403
	KindProtocol                          // other status, non-JSON, wrong resultType, off-grid timestamp, body > limit
	KindScopeDenied                       // rc.Scope not full tenant: no request is sent
	KindBusy                              // no tenant slot within 50 ms
	KindConfig                            // Kind != "pulsusdb", credentials unresolvable or weak
	KindVirtual                           // reserved selector in the text: no request is sent
)

// String is the kind's name, also the log's kind=.
func (k ErrorKind) String() string { return "" }

// Position is a byte offset into the query text.
type Position struct{ Offset int }

// Error is every failure of a call, except context.Canceled from the caller's ctx.
type Error struct {
	Kind       ErrorKind
	Status     int
	Message    string
	Position   *Position
	QueryID    string
	RetryAfter string
	// Field and Reserved are set for KindVirtual only: the input that named a reserved selector
	// ("query", "match/<i>" or "metric") and the reserved name.
	Field, Reserved string
}

func (e *Error) Error() string { return "pulsusdb: " + e.Kind.String() + ": " + e.Message }

// positionOf extracts the byte offset of a "<line>:<col>: " message prefix in query (T09-009).
func positionOf(msg, query string) *Position {
	_, _ = msg, query
	return nil
}
