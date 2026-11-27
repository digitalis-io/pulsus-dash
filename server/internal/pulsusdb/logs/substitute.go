package logs

import (
	"slices"
	"strconv"
	"strings"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/vars"
)

// segmentKind is how a segment maps its bytes (plan #112 §4.2, unchanged).
type segmentKind int

const (
	segCopy   segmentKind = iota + 1 // byte for byte
	segInsert                        // every byte maps to rawFrom
	segAdded                         // the volume prefix or suffix: no position
)

// segment maps [sentFrom, sentFrom+sentLen) of a map's input side to [rawFrom, rawFrom+rawLen)
// of its output side.
type segment struct {
	sentFrom, sentLen, rawFrom, rawLen int
	kind                               segmentKind
}

// at maps offset s of the input side of segs (total bytes long) to the output side, by the three
// rules of plan #112 §4.2.
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

// The macros: the step macros and the range macros of the request window (#291).
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

// lexState is the lexical state of the substitution scan (plan #116 §4.2). PulsusDB's LogQL has
// no comments (plan #121 §1): outside strings a '#' is an ordinary byte here, and row 9b refuses
// it (hashAt).
type lexState int

const (
	stNone lexState = iota // outside strings
	stDQ                   // inside a "…" string
	stBQ                   // inside a `…` string
)

// substitution is the outcome of one scan of the raw text.
type substitution struct {
	size       int            // bytes of the substituted text
	missing    []string       // referenced variables without a value: distinct, first-reference order
	refusals   []vars.Refusal // row 7b and T07-031 (plan #289 §3.4), in the order found
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

// scanOptions are what one scan does beyond substitution: run the probe guard over its regex
// strings (Prepare's count; nil skips it), and leave every macro as written (the value route).
type scanOptions struct {
	guard      *vars.Guard
	keepMacros bool
}

// isNameStart and isNameByte are the bytes of NAME = [A-Za-z_][A-Za-z0-9_]* (#61 VARIABLE_REF).
func isNameStart(b byte) bool { return b == '_' || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') }
func isNameByte(b byte) bool  { return isNameStart(b) || (b >= '0' && b <= '9') }

// reference reads a reference at raw[i] == '$': its name and its end, or ok false when the bytes
// there are not one ($ alone, ${ without a closing brace).
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

const hexDigits = "0123456789abcdef"

// dqEscape is the escape of byte b in a "…" string, or "" when b is written as itself (the
// encoding table of plan #116 §4.2).
func dqEscape(b byte) string {
	switch b {
	case '"':
		return `\"`
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

// encodeDQ writes v so that a "…" string holding it reads back as v: strconv.Unquote(`"` +
// encodeDQ(v) + `"`) == v for every valid UTF-8 v. For an ASCII-only v it is strconv.Quote(v)
// without its quotes; a non-ASCII rune is written as itself (the one recorded deviation from
// strconv.Quote, which writes \u… for a rune strconv.IsPrint rejects).
func encodeDQ(v string) string {
	n := encodedDQLen(v)
	if n == len(v) {
		return v
	}
	var b strings.Builder
	b.Grow(n)
	writeDQ(&b, v)
	return b.String()
}

func encodedDQLen(v string) int {
	n := 0
	for i := 0; i < len(v); i++ {
		if e := dqEscape(v[i]); e != "" {
			n += len(e)
		} else {
			n++
		}
	}
	return n
}

func writeDQ(b *strings.Builder, v string) {
	for i := 0; i < len(v); i++ {
		if e := dqEscape(v[i]); e != "" {
			b.WriteString(e)
		} else {
			b.WriteByte(v[i])
		}
	}
}

// substitute scans raw once (plan #116 §4.2), with the contexts of plan #289 §3.4. With build
// false it only counts the output, so a text over the cap is refused before it is built; with
// build true it builds the text and the segment map of expanded → raw. Structured values are
// rendered by their context (vars.Render); the memo is per value and context kind.
func substitute(raw string, vs map[string]vars.Value, m macroText, build bool, o scanOptions) substitution {
	var out substitution
	var b strings.Builder
	if build {
		b.Grow(len(raw))
	}
	type renderKey struct {
		name string
		kind vars.CtxKind
	}
	type rendered struct {
		text string
		ok   bool
	}
	renders := map[renderKey]rendered{}
	render := func(name string, v vars.Value, c vars.Ctx) (string, bool) {
		if v.Legacy {
			return v.Text, true
		}
		k := renderKey{name, c.Kind}
		if r, ok := renders[k]; ok {
			return r.text, r.ok
		}
		text, ok := vars.Render(v, c)
		renders[k] = rendered{text, ok}
		return text, ok
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
	t := vars.Tracker{LogQL: true}
	var sctx vars.Ctx        // the context of the open string
	var rx *vars.RegexString // the open string's regex parts (a CtxRe string only)
	open := func(st lexState, at int) {
		sctx = t.String()
		rx = nil
		if sctx.Kind == vars.CtxRe {
			q := byte('"')
			if st == stBQ {
				q = 0
			}
			rx = vars.NewRegexString(q, at+1)
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
			ctx := sctx
			if st == stNone {
				ctx = t.Ref()
			}
			text, subst, isVar := "", false, false
			var v vars.Value
			switch {
			case isMacro(name) && o.keepMacros:
			case name == macroInterval:
				text, subst = m.interval, true
			case name == macroRateInterval:
				text, subst = m.rateInterval, true
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
			if isVar {
				var ok bool
				if text, ok = render(name, v, ctx); !ok {
					out.refusals = append(out.refusals, vars.Refusal{Name: name, At: i, Where: ctx.Where})
				}
				if ok && !representable(text, st) {
					out.refusals = append(out.refusals, vars.Refusal{Name: name, At: i})
				}
				if rx != nil {
					rx.Add(raw, i, end, name, text, ok && !v.Legacy, v.Values != nil)
				}
			} else if rx != nil {
				rx.Add(raw, i, end, name, text, false, false)
			}
			flush(i)
			n := len(text)
			if st == stDQ {
				n = encodedDQLen(text)
			}
			if build {
				out.segs = append(out.segs, segment{sentFrom: out.size, sentLen: n, rawFrom: i, rawLen: end - i, kind: segInsert})
				if st == stDQ {
					writeDQ(&b, text)
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
			case '`':
				st = stBQ
				open(st, i)
			default:
				t.Byte(c)
			}
		case stDQ:
			switch c {
			case '\\':
				// The escaped byte is skipped: a $ there is not a reference.
				i += 2
				continue
			case '"', '\n':
				closeString(i)
				st = stNone
			}
		case stBQ:
			if c == '`' {
				closeString(i)
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

// representable reports whether v can be written verbatim in state st (row 7b): a backtick would
// end a `…` string and Go's raw-string unquote drops a CR. A "…" string takes any value
// (encodeDQ), and the top level takes it as query text.
func representable(v string, st lexState) bool {
	if st == stBQ {
		return !strings.ContainsAny(v, "`\r")
	}
	return true
}

// hashAt is the offset of the first '#' outside "…" and `…` in text, by the states of the
// substitution scan (plan #121 §4.1), or -1. It reads the text itself, never the raw text and the
// values apart, so a '#' a value brings in is found.
func hashAt(text string) int {
	st := stNone
	for i := 0; i < len(text); i++ {
		c := text[i]
		switch st {
		case stNone:
			switch c {
			case '"':
				st = stDQ
			case '`':
				st = stBQ
			case '#':
				return i
			}
		case stDQ:
			switch c {
			case '\\':
				i++ // the escaped byte is skipped
			case '"', '\n':
				st = stNone
			}
		case stBQ:
			if c == '`' {
				st = stNone
			}
		}
	}
	return -1
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
