package vars

import (
	"strconv"
	"strings"
	"unicode/utf8"
)

// Refusal is one refused reference (plan #289 §3.4): row 7b (Where "") or a context of T07-031.
type Refusal struct {
	Name  string
	At    int // raw offset of the reference
	Where string
}

// RegexString is an open regex string's parts as it decodes, for CheckRegex: a module adds each
// reference as its scan reaches it and closes the string at its end.
type RegexString struct {
	quote      byte // '"' or '\'' (escapes read as the upstream lexer reads them), 0 for backticks
	from       int  // raw start of the template text not yet in parts
	parts      []RegexPart
	refs       []Refusal // per structured part: its name and offset (Where unset)
	idx        []int     // per structured part: its index in parts
	size       int       // decoded bytes so far
	bad        bool      // the template text did not decode: every structured part is refused
	structured bool
}

// NewRegexString opens a regex string whose text starts at raw offset from; quote is its quote,
// 0 for a backtick string (verbatim).
func NewRegexString(quote byte, from int) *RegexString {
	return &RegexString{quote: quote, from: from}
}

// decode appends the template text raw as the string reads it: verbatim in backticks, else each
// escape as strconv.UnquoteChar reads it with the string's quote.
func (r *RegexString) decode(raw string) {
	if raw == "" || r.bad {
		return
	}
	text := raw
	if r.quote != 0 {
		var b strings.Builder
		for s := raw; s != ""; {
			c, multi, tail, err := strconv.UnquoteChar(s, r.quote)
			if err != nil {
				r.bad = true
				return
			}
			if multi || c >= utf8.RuneSelf {
				b.WriteRune(c)
			} else {
				b.WriteByte(byte(c))
			}
			s = tail
		}
		text = b.String()
	}
	r.parts = append(r.parts, RegexPart{Text: text})
	r.size += len(text)
}

// Add is the reference at raw[at:end], written as text: structured (a VarMulti's group when
// isGroup, else All) or not (a legacy value, a macro, or a refused reference as "").
func (r *RegexString) Add(raw string, at, end int, name, text string, structured, isGroup bool) {
	r.decode(raw[r.from:at])
	r.from = end
	if structured {
		r.structured = true
		r.refs = append(r.refs, Refusal{Name: name, At: at})
		r.idx = append(r.idx, len(r.parts))
	}
	r.parts = append(r.parts, RegexPart{Text: text, Structured: structured, Group: isGroup})
	r.size += len(text)
}

// Close ends the string at raw offset to and returns its refusals: the regex rules over a string
// of at most maxSize decoded bytes (a longer one is refused by the caller's processing cap).
func (r *RegexString) Close(raw string, to, maxSize int, g *Guard) []Refusal {
	r.decode(raw[r.from:to])
	r.from = to
	if !r.structured || r.size > maxSize {
		return nil
	}
	var out []Refusal
	if r.bad {
		for _, ref := range r.refs {
			out = append(out, Refusal{Name: ref.Name, At: ref.At, Where: WhereRegex})
		}
		return out
	}
	byPart := make(map[int]Refusal, len(r.idx))
	for k, p := range r.idx {
		byPart[p] = r.refs[k]
	}
	for _, f := range CheckRegex(r.parts, g) {
		ref := byPart[f.Part]
		out = append(out, Refusal{Name: ref.Name, At: ref.At, Where: f.Where})
	}
	return out
}
