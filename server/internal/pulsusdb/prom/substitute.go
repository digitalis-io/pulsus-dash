package prom

import "strings"

// segmentKind is how a segment maps its bytes (plan #112 §4.2).
type segmentKind int

const (
	segCopy   segmentKind = iota + 1 // byte for byte
	segInsert                        // every byte maps to rawFrom
	segAdded                         // a rewrite prefix or suffix: no position
)

// segment maps [sentFrom, sentFrom+sentLen) of a map's input side to [rawFrom, rawFrom+rawLen)
// of its output side.
type segment struct {
	sentFrom, sentLen, rawFrom, rawLen int
	kind                               segmentKind
}

// at maps offset s of the input side of segs (total bytes long) to the output side, by the
// three rules of plan #112 §4.2.
func at(segs []segment, total, s int) (int, bool) {
	if s < 0 {
		return 0, false
	}
	for _, g := range segs {
		if g.kind == segAdded || s < g.sentFrom || s >= g.sentFrom+g.sentLen {
			continue
		}
		if g.kind == segCopy {
			return g.rawFrom + (s - g.sentFrom), true
		}
		return g.rawFrom, true
	}
	if n := len(segs); n > 0 && s == total && segs[n-1].kind != segAdded {
		return segs[n-1].rawFrom + segs[n-1].rawLen, true
	}
	return 0, false
}

// The step macros (plan #112 §4.2).
const (
	macroInterval     = "__interval"
	macroRateInterval = "__rate_interval"
	maxNameLen        = 64
)

// macroText is the text of each macro: the placeholder "1s" in Prepare, the durations at the
// resolved step in Plan.
type macroText struct{ interval, rateInterval string }

func placeholders() macroText { return macroText{interval: "1s", rateInterval: "1s"} }

func macrosAt(stepMs int64) macroText {
	return macroText{interval: FormatDuration(stepMs), rateInterval: FormatDuration(RateWindowMs(stepMs))}
}

// lexState is the lexical state of the substitution scan (plan #118 §4.1).
type lexState int

const (
	stNone    lexState = iota // outside strings and comments
	stDQ                      // inside "…"
	stSQ                      // inside '…'
	stBQ                      // inside `…`
	stComment                 // inside # …, to LF or CR
)

// substitution is the outcome of one scan of the raw text.
type substitution struct {
	size            int      // bytes of the substituted text
	missing         []string // row 7: distinct, first-reference order
	unrepresentable []string // row 7b: distinct, first-reference order
	macro           bool     // a step macro is referenced
	text            string   // built only when asked
	segs            []segment
}

// isNameStart and isNameByte are the bytes of NAME = [A-Za-z_][A-Za-z0-9_]* (#61 VARIABLE_REF).
func isNameStart(b byte) bool { return b == '_' || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') }
func isNameByte(b byte) bool  { return isNameStart(b) || (b >= '0' && b <= '9') }

// reference reads a reference at raw[i] == '$': its name and its end, or ok false when the
// bytes there are not one ($ alone, ${ without a closing brace).
func reference(raw string, i int) (name string, end int, ok bool) {
	j := i + 1
	braced := j < len(raw) && raw[j] == '{'
	if braced {
		j++
	}
	k := j
	if k >= len(raw) || !isNameStart(raw[k]) {
		return "", 0, false
	}
	for k < len(raw) && isNameByte(raw[k]) {
		k++
	}
	name = raw[j:k]
	if braced {
		if k >= len(raw) || raw[k] != '}' {
			return "", 0, false
		}
		k++
	}
	return name, k, true
}

// replacementRune is U+FFFD as UTF-8. The upstream lexer reads it as utf8.RuneError and refuses it
// in a string, so it is written \ufffd in "…"/'…' and refused in `…`.
const replacementRune = "\xef\xbf\xbd"

const hexDigits = "0123456789abcdef"

// quotedEscape is the escape of byte b in a string opened by q, or "" when b is written as itself
// (plan #118 §4.2). Only the opening quote is escaped: the upstream lexEscape accepts \ followed
// by the opening quote and refuses \ followed by the other one.
func quotedEscape(b, q byte) string {
	switch b {
	case q:
		if q == '"' {
			return `\"`
		}
		return `\'`
	case '\\':
		return `\\`
	case 0x07:
		return `\a`
	case 0x08:
		return `\b`
	case 0x0C:
		return `\f`
	case 0x0A:
		return `\n`
	case 0x0D:
		return `\r`
	case 0x09:
		return `\t`
	case 0x0B:
		return `\v`
	}
	if b < 0x20 || b == 0x7F {
		return `\x` + hexDigits[b>>4:b>>4+1] + hexDigits[b&0xF:b&0xF+1]
	}
	return ""
}

// isReplacementAt reports whether v holds U+FFFD at byte i.
func isReplacementAt(v string, i int) bool {
	return v[i] == replacementRune[0] && strings.HasPrefix(v[i:], replacementRune)
}

// quotedLen is len(encodeQuoted(v, q)) without building it; q is '"' or '\”.
func quotedLen(v string, q byte) int {
	n := 0
	for i := 0; i < len(v); {
		if isReplacementAt(v, i) {
			n += len(`\ufffd`)
			i += len(replacementRune)
			continue
		}
		if e := quotedEscape(v[i], q); e != "" {
			n += len(e)
		} else {
			n++
		}
		i++
	}
	return n
}

// writeQuoted writes v by the table of plan #118 §4.2 for a string opened by q:
// strutil.Unquote(q + encodeQuoted(v, q) + q) == v for every valid UTF-8 v. For an ASCII-only v
// in "…" it is strconv.Quote(v) without its quotes. The recorded deviations from strconv.Quote: a
// non-ASCII rune that strconv.IsPrint rejects is written as itself, and U+FFFD is written \ufffd.
func writeQuoted(b *strings.Builder, v string, q byte) {
	for i := 0; i < len(v); {
		if isReplacementAt(v, i) {
			b.WriteString(`\ufffd`)
			i += len(replacementRune)
			continue
		}
		if e := quotedEscape(v[i], q); e != "" {
			b.WriteString(e)
		} else {
			b.WriteByte(v[i])
		}
		i++
	}
}

// encodeQuoted is writeQuoted into a new string (the fuzz tests' subject).
func encodeQuoted(v string, q byte) string {
	n := quotedLen(v, q)
	if n == len(v) {
		return v
	}
	var b strings.Builder
	b.Grow(n)
	writeQuoted(&b, v, q)
	return b.String()
}

// representable reports whether v can be written in state st (row 7b, plan #118 §4.3): in `…` a
// backtick would end the string, Go's raw-string unquote drops a CR and the upstream lexer
// refuses U+FFFD; in a # comment an LF or a CR would end it. "…" and '…' take any value
// (encodeQuoted), and the top level takes it as query text.
func representable(v string, st lexState) bool {
	switch st {
	case stBQ:
		return !strings.ContainsAny(v, "`\r") && !strings.Contains(v, replacementRune)
	case stComment:
		return !strings.ContainsAny(v, "\n\r")
	}
	return true
}

// quoteOf is the opening quote of a quoted state, or 0.
func quoteOf(st lexState) byte {
	switch st {
	case stDQ:
		return '"'
	case stSQ:
		return '\''
	}
	return 0
}

// memoKey is one reference name in one lexical state.
type memoKey struct {
	name string
	st   lexState
}

// valueMemo is a scan's memo of each referenced value's length and row-7b check per state: a
// text may repeat one reference many times, so each value is read once per state (review r1).
// The maps are made on first use.
type valueMemo struct {
	lens map[memoKey]int
	reps map[memoKey]bool
}

func (m *valueMemo) length(name, v string, st lexState) int {
	q := quoteOf(st)
	if q == 0 {
		return len(v)
	}
	k := memoKey{name, st}
	if n, ok := m.lens[k]; ok {
		return n
	}
	if m.lens == nil {
		m.lens = map[memoKey]int{}
	}
	n := quotedLen(v, q)
	m.lens[k] = n
	return n
}

func (m *valueMemo) representable(name, v string, st lexState) bool {
	if st != stBQ && st != stComment {
		return true
	}
	k := memoKey{name, st}
	if r, ok := m.reps[k]; ok {
		return r
	}
	if m.reps == nil {
		m.reps = map[memoKey]bool{}
	}
	r := representable(v, st)
	m.reps[k] = r
	return r
}

// substitute scans raw once (plan #112 §4.2), by the lexical states of plan #118 §4.1. With build
// false it only counts the output, so a text over the cap is refused before it is built; with
// build true it builds the text and the segment map of expanded → raw.
func substitute(raw string, vars map[string]string, m macroText, build bool) substitution {
	var out substitution
	var memo valueMemo
	var b strings.Builder
	if build {
		b.Grow(len(raw))
	}
	copyFrom := 0 // start of the pending copy run
	flush := func(to int) {
		if to > copyFrom {
			if build {
				out.segs = appendCopy(out.segs, out.size, copyFrom, to-copyFrom)
				b.WriteString(raw[copyFrom:to])
			}
			out.size += to - copyFrom
		}
	}
	st := stNone
	for i := 0; i < len(raw); {
		c := raw[i]
		if c == '$' {
			name, end, ok := reference(raw, i)
			if !ok {
				i++
				continue
			}
			value, subst, isVar := "", false, false
			switch {
			case name == macroInterval:
				value, subst, out.macro = m.interval, true, true
			case name == macroRateInterval:
				value, subst, out.macro = m.rateInterval, true, true
			case strings.HasPrefix(name, "__") || len(name) > maxNameLen:
			default:
				if v, has := vars[name]; has {
					value, subst, isVar = v, true, true
				} else if !contains(out.missing, name) {
					out.missing = append(out.missing, name)
				}
			}
			if !subst {
				i = end
				continue
			}
			// A macro's text is a duration: only a value is checked (row 7b).
			if isVar && !memo.representable(name, value, st) && !contains(out.unrepresentable, name) {
				out.unrepresentable = append(out.unrepresentable, name)
			}
			flush(i)
			q := quoteOf(st)
			n := memo.length(name, value, st)
			if build {
				out.segs = append(out.segs, segment{sentFrom: out.size, sentLen: n, rawFrom: i, rawLen: end - i, kind: segInsert})
				if q != 0 {
					writeQuoted(&b, value, q)
				} else {
					b.WriteString(value)
				}
			}
			out.size += n
			i, copyFrom = end, end
			continue
		}
		switch st {
		case stNone:
			switch c {
			case '"':
				st = stDQ
			case '\'':
				st = stSQ
			case '`':
				st = stBQ
			case '#':
				st = stComment
			}
		case stDQ, stSQ:
			switch {
			case c == '\\':
				// The escaped byte is skipped: a $ there is not a reference.
				i += 2
				continue
			case c == quoteOf(st) || c == '\n':
				st = stNone
			}
		case stBQ:
			if c == '`' {
				st = stNone
			}
		case stComment:
			if c == '\n' || c == '\r' {
				st = stNone
			}
		}
		i++
	}
	flush(len(raw))
	if build {
		out.text = b.String()
	}
	return out
}

// appendCopy appends a copy segment, merged with a copy just before it.
func appendCopy(segs []segment, sentFrom, rawFrom, n int) []segment {
	if k := len(segs); k > 0 {
		last := &segs[k-1]
		if last.kind == segCopy && last.sentFrom+last.sentLen == sentFrom && last.rawFrom+last.rawLen == rawFrom {
			last.sentLen += n
			last.rawLen += n
			return segs
		}
	}
	return append(segs, segment{sentFrom: sentFrom, sentLen: n, rawFrom: rawFrom, rawLen: n, kind: segCopy})
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
