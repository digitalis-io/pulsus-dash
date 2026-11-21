package pulsusdb

import "strings"

// reservedNames are the virtual metric names of T07 §0, in match order.
var reservedNames = []string{"ALERTS_FOR_STATE", "ALERTS", "pulsus_anomaly_score"}

// reservedSource is the reserved source label of T07 §0.
const reservedSource = `source="pulsus-dash"`

// reservedIn reports the first reserved selector named in text (T07 §0, T07-020 v1): a reserved
// metric name as a whole word (the bytes around it absent or not in [A-Za-z0-9_:]), or the exact
// bytes source="pulsus-dash". The match is on bytes, so a name inside a string literal is also
// refused (a documented limit of v1).
func reservedIn(text string) (name string, ok bool) {
	for _, n := range reservedNames {
		if wholeWord(text, n) {
			return n, true
		}
	}
	if strings.Contains(text, reservedSource) {
		return reservedSource, true
	}
	return "", false
}

func wholeWord(s, w string) bool {
	for i := 0; i <= len(s)-len(w); {
		j := strings.Index(s[i:], w)
		if j < 0 {
			return false
		}
		at, end := i+j, i+j+len(w)
		if (at == 0 || !wordByte(s[at-1])) && (end == len(s) || !wordByte(s[end])) {
			return true
		}
		i = at + 1
	}
	return false
}

func wordByte(b byte) bool {
	return b == '_' || b == ':' || (b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// reservedError is the KindVirtual refusal of input field naming name.
func reservedError(field, name string) *Error {
	return &Error{Kind: KindVirtual, Field: field, Reserved: name,
		Message: name + " is a reserved Pulsus Dash name and is not supported yet (it may appear only inside a string)"}
}

// ReservedError is the KindVirtual refusal of input field naming the reserved name, for a
// caller that found the name itself (the PromQL planner's Classify, plan #112 §4.4 step 4).
func ReservedError(field, name string) *Error { return reservedError(field, name) }

// CheckReserved is the guard for one input, for callers that must refuse before any I/O of
// their own (the gateway, before tenant resolution): the KindVirtual refusal, or nil.
func CheckReserved(field, text string) *Error {
	if name, ok := reservedIn(text); ok {
		return reservedError(field, name)
	}
	return nil
}

// guardInput is one text screened by the guard.
type guardInput struct{ field, text string }

// guard returns the refusal of the first input that names a reserved selector, or nil.
func guard(in []guardInput) *Error {
	for _, g := range in {
		if name, ok := reservedIn(g.text); ok {
			return reservedError(g.field, name)
		}
	}
	return nil
}
