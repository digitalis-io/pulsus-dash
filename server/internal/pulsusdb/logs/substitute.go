package logs

import "strings"

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

// The step macros.
const (
	macroInterval     = "__interval"
	macroRateInterval = "__rate_interval"
	maxNameLen        = 64
)

// macroText is the text of each macro: the placeholder "1s" in Prepare, the durations at the step
// in Plan.
type macroText struct{ interval, rateInterval string }

func placeholders() macroText { return macroText{interval: "1s", rateInterval: "1s"} }

func macrosAt(stepMs int64) macroText {
	return macroText{interval: FormatDuration(stepMs), rateInterval: FormatDuration(RateWindowMs(stepMs))}
}

// lexState is the lexical state of the substitution scan (plan #116 §4.2).
type lexState int

const (
	stNone    lexState = iota // outside strings and comments
	stDQ                      // inside a "…" string
	stBQ                      // inside a `…` string
	stComment                 // inside a # comment
)

// substitution is the outcome of one scan of the raw text.
type substitution struct {
	size            int      // bytes of the substituted text
	missing         []string // referenced variables without a value: distinct, first-reference order
	unrepresentable []string // referenced values that cannot be written where they are (row 7b)
	text            string   // built only when asked
	segs            []segment
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

// substitute scans raw once (plan #116 §4.2). With build false it only counts the output, so a
// text over the cap is refused before it is built; with build true it builds the text and the
// segment map of expanded → raw.
func substitute(raw string, vars map[string]string, m macroText, build bool) substitution {
	var out substitution
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
				value, subst = m.interval, true
			case name == macroRateInterval:
				value, subst = m.rateInterval, true
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
			if isVar && !representable(value, st) && !contains(out.unrepresentable, name) {
				out.unrepresentable = append(out.unrepresentable, name)
			}
			flush(i)
			n := len(value)
			if st == stDQ {
				n = encodedDQLen(value)
			}
			if build {
				out.segs = append(out.segs, segment{sentFrom: out.size, sentLen: n, rawFrom: i, rawLen: end - i, kind: segInsert})
				if st == stDQ {
					writeDQ(&b, value)
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
			case '`':
				st = stBQ
			case '#':
				st = stComment
			}
		case stDQ:
			switch c {
			case '\\':
				// The escaped byte is skipped: a $ there is not a reference.
				i += 2
				continue
			case '"', '\n':
				st = stNone
			}
		case stBQ:
			if c == '`' {
				st = stNone
			}
		case stComment:
			if c == '\n' {
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

// representable reports whether v can be written verbatim in state st (row 7b): a backtick would
// end a `…` string and Go's raw-string unquote drops a CR; an LF would end a # comment. A "…"
// string takes any value (encodeDQ), and the top level takes it as query text.
func representable(v string, st lexState) bool {
	switch st {
	case stBQ:
		return !strings.ContainsAny(v, "`\r")
	case stComment:
		return !strings.ContainsRune(v, '\n')
	}
	return true
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
