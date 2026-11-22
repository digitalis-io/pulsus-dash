package logs

import (
	"strconv"
	"strings"
)

// Source is the data source a query reads (T07 §4.1 step 1a).
type Source string

// The sources.
const (
	SourcePulsusDB Source = "pulsus_db"
	SourceVirtual  Source = "virtual"
	SourceMixed    Source = "mixed"
)

// Selector is one stream selector {…} of a text: its byte span (To is after its '}', or the end
// of the text when it is not closed) and whether it holds the reserved matcher.
type Selector struct {
	From, To int
	Reserved bool
}

// Class is the classification of a text: its source, the reserved names it reads ([] or
// [ReservedMatcher]) and its selectors in text order. There is no step floor: T07 §4.3 gives the
// LogQL virtual source none, so Resolve is the identity.
type Class struct {
	Source    Source
	Reserved  []string
	Selectors []Selector
}

// Classify reads every stream selector of text outside strings and comments (the selector reader
// of plan #116 §4.3): a selector is reserved when one of its matchers has the name source, the op
// = and the value pulsus-dash, names and values decoded as Go string literals. It never fails and
// never panics; anything it cannot read fails closed or is left to the byte guard (T07-020).
func Classify(text string) Class {
	c := Class{Source: SourcePulsusDB, Reserved: []string{}, Selectors: []Selector{}}
	reserved := 0
	for i := 0; i < len(text); {
		switch text[i] {
		case '"', '`':
			_, _, i = readString(text, i)
		case '#':
			i = skipComment(text, i)
		case '{':
			var s Selector
			s, i = readSelector(text, i)
			c.Selectors = append(c.Selectors, s)
			if s.Reserved {
				reserved++
			}
		default:
			i++
		}
	}
	switch {
	case reserved == 0:
	case reserved == len(c.Selectors):
		c.Source = SourceVirtual
	default:
		c.Source = SourceMixed
	}
	if reserved > 0 {
		c.Reserved = []string{ReservedMatcher}
	}
	return c
}

// skipComment returns the offset of the LF that ends the # comment at text[i], or the end.
func skipComment(text string, i int) int {
	if j := strings.IndexByte(text[i:], '\n'); j >= 0 {
		return i + j
	}
	return len(text)
}

// readString reads the string at text[i] ('"' or '`') and returns its decoded value, whether it
// has one, and its end. A "…" string ends at its closing quote, or before an LF or the end
// (unterminated, no value); a backslash escapes the byte after it. It is decoded by
// strconv.Unquote: an invalid escape gives no value. A `…` string ends at its closing backtick, or
// at the end (unterminated, no value); its value is its bytes with every CR removed, as
// strconv.Unquote gives.
func readString(text string, i int) (value string, ok bool, end int) {
	if text[i] == '`' {
		j := strings.IndexByte(text[i+1:], '`')
		if j < 0 {
			return "", false, len(text)
		}
		end = i + 1 + j + 1
		return strings.ReplaceAll(text[i+1:end-1], "\r", ""), true, end
	}
	for j := i + 1; j < len(text); {
		switch text[j] {
		case '\\':
			j += 2
			continue
		case '\n':
			return "", false, j
		case '"':
			v, err := strconv.Unquote(text[i : j+1])
			return v, err == nil, j + 1
		}
		j++
	}
	return "", false, len(text)
}

// The tokens and states of the selector reader (plan #116 §4.3).
type selState int

const (
	selS0 selState = iota // no name
	selS1                 // a name
	selS2                 // a name and an op
)

// readOp reads an op at text[j]: =~, !~, != or =, longest first; "" when there is none.
func readOp(text string, j int) string {
	next := byte(0)
	if j+1 < len(text) {
		next = text[j+1]
	}
	switch {
	case text[j] == '=' && next == '~':
		return "=~"
	case text[j] == '!' && (next == '~' || next == '='):
		return text[j : j+2]
	case text[j] == '=':
		return "="
	}
	return ""
}

// readSelector reads the selector whose '{' is at text[i] and returns it and its end.
func readSelector(text string, i int) (Selector, int) {
	s := Selector{From: i}
	st, name, op := selS0, "", ""
	for j := i + 1; j < len(text); {
		c := text[j]
		switch {
		case c == ' ' || c == '\t' || c == '\r' || c == '\n':
			j++
		case c == '#':
			j = skipComment(text, j)
		case c == '}':
			s.To = j + 1
			return s, s.To
		case c == '"' || c == '`':
			v, ok, end := readString(text, j)
			j = end
			if st == selS2 {
				if ok && name == "source" && op == "=" && v == "pulsus-dash" {
					s.Reserved = true
				}
				st = selS0
				continue
			}
			// A string where a name goes is a quoted label name; one without a value names
			// nothing.
			st, name = selS1, ""
			if ok {
				name = v
			}
		case isNameStart(c):
			k := j + 1
			for k < len(text) && isNameByte(text[k]) {
				k++
			}
			st, name, j = selS1, text[j:k], k
		default:
			if o := readOp(text, j); o != "" {
				if st == selS1 {
					st, op = selS2, o
				} else {
					st = selS0
				}
				j += len(o)
				continue
			}
			st = selS0
			j++
		}
	}
	s.To = len(text)
	return s, s.To
}
