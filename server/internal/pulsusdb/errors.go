package pulsusdb

import (
	"regexp"
	"strconv"
	"strings"
)

// ErrorKind classifies a failure of a PulsusDB call (plan #62 §3.3).
type ErrorKind int

// The error kinds.
const (
	KindUnreachable  ErrorKind = iota + 1 // transport error before headers, retries exhausted
	KindTimeout                           // ctx deadline before headers; upstream 504; 503 errorType timeout
	KindUnavailable                       // 503 errorType unavailable after retries (or another errorType, not retried)
	KindQueryInvalid                      // 400
	KindTooBroad                          // 422
	KindRateLimited                       // 429
	KindUnauthorised                      // 401, 403
	KindProtocol                          // other status, non-JSON, wrong resultType, off-grid timestamp, body > limit
	KindScopeDenied                       // rc.Scope not full tenant: no request is sent
	KindBusy                              // no tenant slot within 50 ms
	KindConfig                            // Kind != "pulsusdb", credentials unresolvable, malformed or weak
	KindVirtual                           // reserved selector in the text (§4.8): no request is sent
)

var kindNames = [...]string{
	KindUnreachable: "unreachable", KindTimeout: "timeout", KindUnavailable: "unavailable",
	KindQueryInvalid: "query_invalid", KindTooBroad: "too_broad", KindRateLimited: "rate_limited",
	KindUnauthorised: "unauthorised", KindProtocol: "protocol", KindScopeDenied: "scope_denied",
	KindBusy: "busy", KindConfig: "config", KindVirtual: "virtual",
}

// String is the kind's name, also the log's kind=.
func (k ErrorKind) String() string {
	if k > 0 && int(k) < len(kindNames) {
		return kindNames[k]
	}
	return "unknown"
}

// fixedMessages are the messages of the kinds that never carry upstream text (§4.4).
var fixedMessages = map[ErrorKind]string{
	KindUnreachable:  "PulsusDB could not be reached",
	KindTimeout:      "the query timed out",
	KindUnavailable:  "PulsusDB is unavailable",
	KindQueryInvalid: "PulsusDB rejected the query",
	KindTooBroad:     "the query is too broad",
	KindRateLimited:  "PulsusDB is rate limiting this tenant",
	KindUnauthorised: "PulsusDB refused the datasource credentials",
	KindProtocol:     "PulsusDB returned an unexpected response",
	KindScopeDenied:  "data scopes are not supported yet",
	KindBusy:         "too many queries in flight for this tenant",
	KindConfig:       "the datasource is misconfigured",
}

// Position is a byte offset into the query text.
type Position struct{ Offset int }

// Error is every failure of a call, except context.Canceled from the caller's ctx (the browser
// went away). Its text never contains a URL, host or secret.
type Error struct {
	Kind       ErrorKind
	Status     int       // upstream HTTP status; 0 if none
	Message    string    // QueryInvalid, TooBroad: PulsusDB's text, redacted and cleaned; fixed text otherwise
	Position   *Position // QueryInvalid only
	QueryID    string
	RetryAfter string // RateLimited only; kept only if ^[0-9]{1,6}$
	// Field and Reserved are set for KindVirtual only: the input that named a reserved selector
	// ("query", "match/<i>" or "metric") and the reserved name.
	Field, Reserved string
}

func (e *Error) Error() string { return "pulsusdb: " + e.Kind.String() + ": " + e.Message }

// newError is an error of kind k with its fixed message.
func newError(k ErrorKind) *Error { return &Error{Kind: k, Message: fixedMessages[k]} }

func protocolError() *Error { return newError(KindProtocol) }

// positionPrefix is the PromQL-compatible "<line>:<column>: " prefix (1-based, byte column).
var positionPrefix = regexp.MustCompile(`^(\d{1,9}):(\d{1,9}): `)

// atByte is PulsusDB's LogQL position, "at byte N" with N a 0-based byte offset (#65 §4.5).
var atByte = regexp.MustCompile(`\bat byte (\d{1,9})\b`)

// positionOf extracts the byte offset of an error in query (T09-009): a "<line>:<col>: "
// message prefix gives the start of that line plus column − 1; without one, the first
// "at byte N" gives N. Either is kept only if it lies within the text.
func positionOf(msg, query string) *Position {
	m := positionPrefix.FindStringSubmatch(msg)
	if m == nil {
		b := atByte.FindStringSubmatch(msg)
		if b == nil {
			return nil
		}
		n, _ := strconv.Atoi(b[1])
		if n > len(query) {
			return nil
		}
		return &Position{Offset: n}
	}
	line, _ := strconv.Atoi(m[1])
	col, _ := strconv.Atoi(m[2])
	if line < 1 || col < 1 {
		return nil
	}
	start := 0
	for range line - 1 {
		i := strings.IndexByte(query[start:], '\n')
		if i < 0 {
			return nil
		}
		start += i + 1
	}
	off := start + col - 1
	if off > len(query) {
		return nil
	}
	return &Position{Offset: off}
}
