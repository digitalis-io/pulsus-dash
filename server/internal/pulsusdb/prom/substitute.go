package prom

import (
	"slices"
	"strconv"
	"strings"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/vars"
)

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

// The macros: the step macros (plan #112 §4.2) and the range macros of the request window (#291).
const (
	macroInterval     = "__interval"
	macroRateInterval = "__rate_interval"
	macroRange        = "__range"
	macroRangeS       = "__range_s"
	macroRangeMs      = "__range_ms"
	maxNameLen        = 64
)

// macroText is the text of each macro: the placeholders in Prepare ("1s" for a duration, "1" for
// a number), the step durations and the window in Plan.
type macroText struct{ interval, rateInterval, rng, rngS, rngMs string }

func placeholders() macroText {
	return macroText{interval: "1s", rateInterval: "1s", rng: "1s", rngS: "1", rngMs: "1"}
}

func macrosAt(stepMs, rangeMs int64) macroText {
	s := RangeSeconds(rangeMs)
	return macroText{interval: FormatDuration(stepMs), rateInterval: FormatDuration(RateWindowMs(stepMs)),
		rng: FormatDuration(s * 1000), rngS: strconv.FormatInt(s, 10), rngMs: strconv.FormatInt(rangeMs, 10)}
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
	size       int            // bytes of the substituted text
	missing    []string       // row 7: distinct, first-reference order
	refusals   []vars.Refusal // row 7b and T07-031, in the order found
	macro      bool           // a step macro is referenced
	rangeMacro bool           // a range macro is referenced
	text       string         // built only when asked
	segs       []segment
}

// unrepresentable is the refused names, distinct, in the order of their first refused reference,
// and the place of the first refused reference ("" for row 7b).
func (s substitution) unrepresentable() (names []string, where string) {
	rs := slices.Clone(s.refusals)
	slices.SortStableFunc(rs, func(a, b vars.Refusal) int { return a.At - b.At })
	for _, r := range rs {
		if !contains(names, r.Name) {
			names = append(names, r.Name)
		}
	}
	if len(rs) > 0 {
		where = rs[0].Where
	}
	return names, where
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

// memoKey is one reference name in one lexical state and one context kind: a structured value is
// written by its context (T07-031), a legacy one the same in every context (kind CtxNone).
type memoKey struct {
	name string
	st   lexState
	kind vars.CtxKind
}

// renderKey is one reference name in one context kind.
type renderKey struct {
	name string
	kind vars.CtxKind
}

type rendered struct {
	text string
	ok   bool
}

// valueReads, when a test sets it, is called at each quotedLen or representable computation of a
// scan, so the memo is tested by count rather than by time. Nil outside tests.
var valueReads func()

func countValueRead() {
	if valueReads != nil {
		valueReads()
	}
}

// valueMemo is a scan's memo of each referenced value's rendering per context kind, and its
// length and row-7b check per state and kind: a text may repeat one reference many times, so each
// value is read once per state and kind (review r1). The maps are made on first use.
type valueMemo struct {
	renders map[renderKey]rendered
	lens    map[memoKey]int
	reps    map[memoKey]bool
}

func memoKind(v vars.Value, c vars.Ctx) vars.CtxKind {
	if v.Legacy {
		return vars.CtxNone
	}
	return c.Kind
}

// render is vars.Render(v, c), memoised by name and context kind.
func (m *valueMemo) render(name string, v vars.Value, c vars.Ctx) (string, bool) {
	if v.Legacy {
		return v.Text, true
	}
	k := renderKey{name, c.Kind}
	if r, ok := m.renders[k]; ok {
		return r.text, r.ok
	}
	if m.renders == nil {
		m.renders = map[renderKey]rendered{}
	}
	text, ok := vars.Render(v, c)
	m.renders[k] = rendered{text, ok}
	return text, ok
}

func (m *valueMemo) length(name, text string, st lexState, kind vars.CtxKind) int {
	q := quoteOf(st)
	if q == 0 {
		return len(text)
	}
	k := memoKey{name, st, kind}
	if n, ok := m.lens[k]; ok {
		return n
	}
	if m.lens == nil {
		m.lens = map[memoKey]int{}
	}
	countValueRead()
	n := quotedLen(text, q)
	m.lens[k] = n
	return n
}

func (m *valueMemo) representable(name, text string, st lexState, kind vars.CtxKind) bool {
	if st != stBQ && st != stComment {
		return true
	}
	k := memoKey{name, st, kind}
	if r, ok := m.reps[k]; ok {
		return r
	}
	if m.reps == nil {
		m.reps = map[memoKey]bool{}
	}
	countValueRead()
	r := representable(text, st)
	m.reps[k] = r
	return r
}

// scanOptions are what one scan does beyond substitution: run the probe guard over its regex
// strings (Prepare's count; nil skips it), and leave every macro as written (the value route).
type scanOptions struct {
	guard      *vars.Guard
	keepMacros bool
}

// substitute scans raw once (plan #112 §4.2), by the lexical states of plan #118 §4.1 and the
// contexts of plan #289 §3.4. With build false it only counts the output, so a text over the cap
// is refused before it is built; with build true it builds the text and the segment map of
// expanded → raw.
func substitute(raw string, vs map[string]vars.Value, m macroText, build bool, o scanOptions) substitution {
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
	var t vars.Tracker
	var sctx vars.Ctx        // the context of the open string
	var rx *vars.RegexString // the open string's regex parts (a CtxRe string only)
	open := func(st lexState, at int) {
		sctx = t.String()
		rx = nil
		if sctx.Kind == vars.CtxRe {
			rx = vars.NewRegexString(quoteOf(st), at+1)
		}
	}
	closeString := func(at int) {
		if rx != nil {
			out.refusals = append(out.refusals, rx.Close(raw, at, MaxExpandedBytes, o.guard)...)
			rx = nil
		}
		t.EndString()
	}
	st := stNone
	for i := 0; i < len(raw); {
		c := raw[i]
		if c == '$' {
			name, end, ok := reference(raw, i)
			if !ok {
				if st == stNone {
					t.Byte(c)
				}
				i++
				continue
			}
			var ctx vars.Ctx
			switch st {
			case stNone:
				ctx = t.Ref()
			case stComment:
				ctx = vars.Ctx{Kind: vars.CtxNone, Where: vars.WhereComment}
			default:
				ctx = sctx
			}
			text, subst, isVar := "", false, false
			var v vars.Value
			switch {
			case isMacro(name) && o.keepMacros:
			case name == macroInterval:
				text, subst, out.macro = m.interval, true, true
			case name == macroRateInterval:
				text, subst, out.macro = m.rateInterval, true, true
			case name == macroRange:
				text, subst, out.rangeMacro = m.rng, true, true
			case name == macroRangeS:
				text, subst, out.rangeMacro = m.rngS, true, true
			case name == macroRangeMs:
				text, subst, out.rangeMacro = m.rngMs, true, true
			case strings.HasPrefix(name, "__") || len(name) > maxNameLen:
			default:
				if val, has := vs[name]; has {
					v, subst, isVar = val, true, true
				} else if !contains(out.missing, name) {
					out.missing = append(out.missing, name)
				}
			}
			if !subst {
				i = end
				continue
			}
			kind := vars.CtxNone
			if isVar {
				kind = memoKind(v, ctx)
				var rendered bool
				if text, rendered = memo.render(name, v, ctx); !rendered {
					out.refusals = append(out.refusals, vars.Refusal{Name: name, At: i, Where: ctx.Where})
				}
				// A macro's text is a duration or a number: only a value is checked (row 7b).
				if rendered && !memo.representable(name, text, st, kind) {
					out.refusals = append(out.refusals, vars.Refusal{Name: name, At: i})
				}
				if rx != nil {
					rx.Add(raw, i, end, name, text, rendered && !v.Legacy, v.Values != nil)
				}
			} else if rx != nil {
				rx.Add(raw, i, end, name, text, false, false)
			}
			flush(i)
			q := quoteOf(st)
			n := len(text)
			if isVar {
				n = memo.length(name, text, st, kind)
			} else if q != 0 {
				n = quotedLen(text, q)
			}
			if build {
				out.segs = append(out.segs, segment{sentFrom: out.size, sentLen: n, rawFrom: i, rawLen: end - i, kind: segInsert})
				if q != 0 {
					writeQuoted(&b, text, q)
				} else {
					b.WriteString(text)
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
				open(st, i)
			case '\'':
				st = stSQ
				open(st, i)
			case '`':
				st = stBQ
				open(st, i)
			case '#':
				t.End()
				st = stComment
			default:
				t.Byte(c)
			}
		case stDQ, stSQ:
			switch {
			case c == '\\':
				// The escaped byte is skipped: a $ there is not a reference.
				i += 2
				continue
			case c == quoteOf(st) || c == '\n':
				closeString(i)
				st = stNone
			}
		case stBQ:
			if c == '`' {
				closeString(i)
				st = stNone
			}
		case stComment:
			if c == '\n' || c == '\r' {
				st = stNone
			}
		}
		i++
	}
	if rx != nil {
		closeString(len(raw))
	}
	flush(len(raw))
	if build {
		out.text = b.String()
	}
	return out
}

// isMacro reports whether name is one of the macros.
func isMacro(name string) bool {
	switch name {
	case macroInterval, macroRateInterval, macroRange, macroRangeS, macroRangeMs:
		return true
	}
	return false
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
