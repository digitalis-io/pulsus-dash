// Package vars is the variable values of the query routes (plan #289 §3.4, T07-031): the three
// forms a value takes on the wire, their bounds, and how a structured value is written in the
// context a reference sits in. It is shared by the language modules (prom, logs), which scan a
// query and fix each reference's context; nothing here reads a query.
package vars

import (
	"encoding/json"
	"reflect"
)

// Value is one entry of a request's vars: a legacy plain string, a multi-value pick (literal
// values) or All (a regex, by intent).
type Value struct {
	Text   string   // legacy plain string
	Values []string // VarMulti (literal); nil otherwise
	All    *string  // VarAll (regex)
	Legacy bool     // decoded from a JSON string
}

// CtxKind is the kind of context a reference sits in.
type CtxKind int

// The context kinds.
const (
	CtxNone CtxKind = iota // a context where only a legacy string may be written; Where names it
	CtxEq                  // an equality string: a matcher value or a line or label filter
	CtxRe                  // a regex string: a matcher value or a line or label filter
	CtxTop                 // a PromQL reference outside strings and comments
)

// Ctx is a reference's context.
type Ctx struct {
	Kind  CtxKind
	Where string
}

// UnmarshalJSON decodes a JSON string, {"values": [...]} or {"all": "..."}.
func (v *Value) UnmarshalJSON(b []byte) error {
	var s string
	if json.Unmarshal(b, &s) == nil { //nolint:forbidigo // a request member, not an upstream body
		*v = Value{Text: s, Legacy: true}
		return nil
	}
	if len(b) > 0 && b[0] == '{' {
		return nil
	}
	return &json.UnmarshalTypeError{Value: "value", Type: reflect.TypeFor[Value]()}
}

// Check is the bounds of v: field.range unless ok.
func Check(v Value) (key string, ok bool) { return "", true }

// SelectionBytes is the UTF-8 length of vs as a JSON array.
func SelectionBytes(vs []string) int { return 0 }

// Render is the text v is written as in c, before the string encoding.
func Render(v Value, c Ctx) (string, bool) { return v.Text, true }

// TopToken reports whether s may be written outside strings.
func TopToken(s string) bool { return false }

// Probe is the guard's stand-in for reference i.
func Probe(i int) string { return "" }

// ProbeRendering is Probe(i) as a structured value is written in a regex.
func ProbeRendering(i int) string { return "" }

// ProbeRegex is the guard over one decoded regex holding the probes of refs.
func ProbeRegex(decoded string, refs []int) (where string, ok bool) { return "", true }

// The places a reference is refused, named in the refusal's message (plan #289 §3.4).
const (
	WhereTopLevel         = "top level"
	WhereFunctionArgument = "function argument"
	WhereComment          = "comment"
	WhereOrFilter         = "or filter"
	WherePatternFilter    = "pattern filter"
	WhereRegex            = "regex"
	WhereRegexClass       = "regex class"
	WhereRegexEscape      = "regex escape"
	WhereRegexQuoted      = "regex quoted text"
)

// StageKeywords are the LogQL pipeline stages whose strings and references are refused, each
// named by its keyword.
var StageKeywords = []string{"json", "logfmt", "regexp", "pattern", "unpack", "line_format",
	"label_format", "unwrap", "drop", "keep", "decolorize", "distinct"}

// Literal is a legacy plain string value.
func Literal(s string) Value { return Value{Text: s, Legacy: true} }

// Map is a request's vars.
type Map map[string]Value

// TypeError is vars of another shape (Name "") or an entry of another shape.
type TypeError struct{ Name string }

func (e *TypeError) Error() string { return "vars: wrong type" }

// UnmarshalJSON decodes each entry by Value.UnmarshalJSON.
func (m *Map) UnmarshalJSON(b []byte) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil { //nolint:forbidigo // a request member, not an upstream body
		return &TypeError{}
	}
	out := make(Map, len(raw))
	for k, r := range raw {
		var v Value
		if err := v.UnmarshalJSON(r); err != nil {
			return &TypeError{Name: k}
		}
		out[k] = v
	}
	*m = out
	return nil
}

// MaxValueBytes bounds one value of any form.
const MaxValueBytes = 4096
