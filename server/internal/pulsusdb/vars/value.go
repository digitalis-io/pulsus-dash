// Package vars is the variable values of the query routes (plan #289 §3.4, T07-031): the three
// forms a value takes on the wire, their bounds, and how a structured value is written in the
// context its reference sits in. The language modules (prom, logs) scan a query and fix each
// reference's context; this package never reads a query. Nothing here logs or returns a value in
// an error.
package vars

import (
	"bytes"
	"encoding/json"
	"reflect"
	"regexp"
	"strings"
	"unicode/utf8"
)

// The bounds of a value (OpenAPI QueryVars, VarMulti, VarAll).
const (
	MaxValueBytes     = 4096   // one string of any form
	MaxValues         = 200    // the values of a VarMulti
	MaxSelectionBytes = 65_536 // SelectionBytes of a VarMulti
)

// Value is one entry of a request's vars: a legacy plain string, the literal values a defined
// variable picked, or All, its regex.
type Value struct {
	Text   string   // legacy plain string
	Values []string // VarMulti (literal); nil otherwise
	All    *string  // VarAll (regex)
	Legacy bool     // decoded from a JSON string
}

// Literal is a legacy plain string value.
func Literal(s string) Value { return Value{Text: s, Legacy: true} }

// CtxKind is the kind of context a reference sits in.
type CtxKind int

// The context kinds (plan #289 §3.4).
const (
	CtxNone CtxKind = iota // only a legacy string may be written; Where names the place
	CtxEq                  // an equality string: a matcher value, a line or a label filter
	CtxRe                  // a regex string: a matcher value, a line or a label filter
	CtxTop                 // a PromQL reference outside strings and comments
)

// Ctx is a reference's context: its kind and, for a refusal, the place named in the message.
type Ctx struct {
	Kind  CtxKind
	Where string
}

// The places a structured reference is refused, named in the refusal's message as
// "(in <where>)" (plan #289 §3.4). The LogQL pipeline stages are named by their keyword.
const (
	WhereTopLevel         = "top level"
	WhereFunctionArgument = "function argument"
	WhereComment          = "comment"
	WhereOrFilter         = "or filter"
	WherePatternFilter    = "pattern filter"
	WhereEquality         = "equality match"
	WhereRegex            = "regex"
	WhereRegexClass       = "regex class"
	WhereRegexEscape      = "regex escape"
	WhereRegexQuoted      = "regex quoted text"
)

// StageKeywords are the LogQL pipeline stages whose strings and references are refused, each
// named by its keyword (plan #289 §3.4): a stage identifier not in the list is a label name.
var StageKeywords = []string{"json", "logfmt", "regexp", "pattern", "unpack", "line_format",
	"label_format", "unwrap", "drop", "keep", "decolorize", "distinct"}

// TypeError is vars of another shape (Name "") or an entry of another shape: the gateway answers
// field.type at /vars or /vars/<name>.
type TypeError struct{ Name string }

func (e *TypeError) Error() string { return "vars: wrong type" }

// Map is a request's vars, each entry decoded by Value.UnmarshalJSON.
type Map map[string]Value

// UnmarshalJSON decodes an object of values; any other shape, or an entry of another shape, is a
// *TypeError.
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

// typeError is the decoding error of a value of another shape.
func typeError(what string) error {
	return &json.UnmarshalTypeError{Value: what, Type: reflect.TypeFor[Value]()}
}

// UnmarshalJSON decodes a JSON string (legacy), {"values": [string, …]} or {"all": string}. An
// object with another member or with both, a member of another type, or any other JSON value is a
// *json.UnmarshalTypeError.
func (v *Value) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) > 0 && b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil { //nolint:forbidigo // a request member, not an upstream body
			return typeError("string")
		}
		*v = Value{Text: s, Legacy: true}
		return nil
	}
	if len(b) == 0 || b[0] != '{' {
		return typeError("value")
	}
	var o map[string]json.RawMessage
	if err := json.Unmarshal(b, &o); err != nil || len(o) != 1 { //nolint:forbidigo // a request member, not an upstream body
		return typeError("object")
	}
	if r, ok := o["values"]; ok {
		if t := bytes.TrimSpace(r); len(t) == 0 || t[0] != '[' {
			return typeError("object")
		}
		var vs []string
		if err := json.Unmarshal(r, &vs); err != nil { //nolint:forbidigo // a request member, not an upstream body
			return typeError("object")
		}
		if vs == nil {
			vs = []string{}
		}
		*v = Value{Values: vs}
		return nil
	}
	if r, ok := o["all"]; ok {
		if t := bytes.TrimSpace(r); len(t) == 0 || t[0] != '"' {
			return typeError("object")
		}
		var s string
		if err := json.Unmarshal(r, &s); err != nil { //nolint:forbidigo // a request member, not an upstream body
			return typeError("object")
		}
		*v = Value{All: &s}
		return nil
	}
	return typeError("object")
}

// keyRange is the refusal key of a value out of its bounds.
const keyRange = "field.range"

// Check is the bounds of v (plan #289 §3.4): a legacy string is UTF-8 and at most 4096 bytes; a
// VarMulti has 1 to 200 values, each UTF-8 and at most 4096 bytes, with SelectionBytes at most
// 65 536; a VarAll is UTF-8, 1 to 4096 bytes. ok false gives field.range.
func Check(v Value) (key string, ok bool) {
	valid := func(s string, minLen int) bool {
		return utf8.ValidString(s) && len(s) >= minLen && len(s) <= MaxValueBytes
	}
	switch {
	case v.Legacy:
		ok = valid(v.Text, 0)
	case v.All != nil:
		ok = valid(*v.All, 1)
	default:
		ok = len(v.Values) >= 1 && len(v.Values) <= MaxValues
		for _, s := range v.Values {
			ok = ok && valid(s, 0)
		}
		ok = ok && SelectionBytes(v.Values) <= MaxSelectionBytes
	}
	if !ok {
		return keyRange, false
	}
	return "", true
}

// RangeMessage is the message of Check's refusal of v.
func RangeMessage(v Value) string {
	switch {
	case v.Legacy:
		return "a variable value must be UTF-8 and at most 4096 bytes"
	case v.All != nil:
		return "a variable's all value must be UTF-8 and 1 to 4096 bytes"
	}
	return "a variable must have 1 to 200 values, each UTF-8 and at most 4096 bytes, and at most 65536 bytes in all"
}

// jsonEscapedLen is the length of r as JSON.stringify writes it in a string: a quote, a backslash
// and the controls with a short escape take 2 bytes, the other C0 controls 6 (\u00XX), every
// other rune its UTF-8 length (U+2028 and U+2029 too: JSON.stringify writes them as themselves).
func jsonEscapedLen(r rune) int {
	switch r {
	case '"', '\\', '\b', '\f', '\n', '\r', '\t':
		return 2
	}
	if r < 0x20 {
		return 6
	}
	return utf8.RuneLen(r)
}

// SelectionBytes is the UTF-8 length of vs as a JSON array of strings in JSON.stringify's form
// (no spaces, no HTML escaping); the client's selectionBytes is the same. vs is UTF-8 (Check).
func SelectionBytes(vs []string) int {
	n := 2
	if len(vs) > 1 {
		n += len(vs) - 1
	}
	for _, s := range vs {
		n += 2
		for _, r := range s {
			n += jsonEscapedLen(r)
		}
	}
	return n
}

// group is a structured value as one case-sensitive non-capturing group of quoted literals, in
// order (plan #289 §3.4): a following quantifier, alternation or anchor cannot broaden it, and the
// template's (?i) does not reach it.
func group(vs []string) string {
	var b strings.Builder
	b.WriteString("(?-i:(?:")
	for i, s := range vs {
		if i > 0 {
			b.WriteByte('|')
		}
		b.WriteString(regexp.QuoteMeta(s))
	}
	b.WriteString("))")
	return b.String()
}

// Render is the text v is written as in c, before the string encoding and the row-7b checks
// (plan #289 §3.4): a legacy string as itself everywhere; a VarMulti as one group in a regex, its
// single value in an equality string or, if TopToken, at the PromQL top level; All verbatim in a
// regex. ok false refuses the reference (variable.unrepresentable).
func Render(v Value, c Ctx) (string, bool) {
	if v.Legacy {
		return v.Text, true
	}
	if v.All != nil {
		if c.Kind == CtxRe {
			return *v.All, true
		}
		return "", false
	}
	switch c.Kind {
	case CtxRe:
		if len(v.Values) > 0 {
			return group(v.Values), true
		}
	case CtxEq:
		if len(v.Values) == 1 {
			return v.Values[0], true
		}
	case CtxTop:
		if len(v.Values) == 1 && TopToken(v.Values[0]) {
			return v.Values[0], true
		}
	}
	return "", false
}

var (
	hexNumber = regexp.MustCompile(`^0[xX][0-9a-fA-F]+$`)
	decNumber = regexp.MustCompile(`^([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$`)
	duration  = regexp.MustCompile(`^([0-9]+(ms|s|m|h|d|w|y))+$`)
)

// TopToken reports whether s may be written outside strings (plan #289 §3.4): an unsigned number
// (hexadecimal or decimal, no Inf, NaN or sign) or a duration. Neither can form an operator,
// function or keyword, so every identifier is refused.
func TopToken(s string) bool {
	return hexNumber.MatchString(s) || decNumber.MatchString(s) || duration.MatchString(s)
}
