// Package varquery reads a board variable's query (plan #289 §3.3): label_values(label) or
// label_values(selector, label), in PromQL or LogQL. The selector is planned by the language
// modules; nothing here reads it.
package varquery

import (
	"errors"
	"strings"
)

// Query is a variable query: the label whose values are listed and the selector, "" for the
// no-selector form.
type Query struct{ Label, Selector string }

// ErrInvalid is the refusal of a text that is not a variable query. It carries no text.
var ErrInvalid = errors.New("varquery: a variable query must be label_values(label) or label_values(selector, label)")

// maxLabelBytes bounds the label (the label values routes' name).
const maxLabelBytes = 256

// Parse reads text as a variable query of lang (promql or logql), by the grammar of plan #289
// §3.3:
//
//	query    = ws "label_values" ws "(" ws [ selector ws "," ws ] label ws ")" ws
//	label    = [A-Za-z_][A-Za-z0-9_]*          ; at most 256 bytes
//	selector = bytes up to the last top-level "," (outside "…", '…', `…` and {…})
//
// The selector is not read here: the language module plans it.
func Parse(lang, text string) (Query, error) {
	if lang != "promql" && lang != "logql" {
		return Query{}, ErrInvalid
	}
	s := trim(text)
	rest, ok := strings.CutPrefix(s, "label_values")
	if !ok {
		return Query{}, ErrInvalid
	}
	rest = trim(rest)
	if !strings.HasPrefix(rest, "(") || !strings.HasSuffix(rest, ")") || len(rest) < 2 {
		return Query{}, ErrInvalid
	}
	inner := rest[1 : len(rest)-1]
	comma, ok := lastTopComma(inner)
	if !ok {
		return Query{}, ErrInvalid
	}
	q := Query{Label: trim(inner)}
	if comma >= 0 {
		q = Query{Selector: trim(inner[:comma]), Label: trim(inner[comma+1:])}
		if q.Selector == "" {
			return Query{}, ErrInvalid
		}
	}
	if !validLabel(q.Label) {
		return Query{}, ErrInvalid
	}
	return q, nil
}

// trim drops ASCII white space at both ends.
func trim(s string) string { return strings.Trim(s, " \t\n\r\f\v") }

func validLabel(l string) bool {
	if l == "" || len(l) > maxLabelBytes {
		return false
	}
	for i := 0; i < len(l); i++ {
		c := l[i]
		letter := c == '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
		if !letter && (i == 0 || c < '0' || c > '9') {
			return false
		}
	}
	return true
}

// lastTopComma is the offset of the last "," of s outside strings and braces, -1 for none; ok
// false when a string or a brace is not closed, or a ")" is outside a string and a brace (the
// query's own parenthesis closes it).
func lastTopComma(s string) (int, bool) {
	last, braces, parens := -1, 0, 0
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '"', '\'', '`':
			j := i + 1
			for ; j < len(s) && s[j] != c; j++ {
				if s[j] == '\\' && c != '`' {
					j++
				}
			}
			if j >= len(s) {
				return 0, false
			}
			i = j
		case '{':
			braces++
		case '}':
			if braces == 0 {
				return 0, false
			}
			braces--
		case '(':
			parens++
		case ')':
			if parens == 0 {
				return 0, false
			}
			parens--
		case ',':
			if braces == 0 && parens == 0 {
				last = i
			}
		}
	}
	return last, braces == 0 && parens == 0
}
