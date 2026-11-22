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

// substitution is the outcome of one scan of the raw text.
type substitution struct {
	size    int      // bytes of the substituted text
	missing []string // referenced variables without a value: distinct, first-reference order
	macro   bool     // a step macro is referenced
	text    string   // built only when asked
	segs    []segment
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

// escapedLen is the length of v written inside a string quoted by q (0 outside strings).
func escapedLen(v string, q byte) int {
	if q != '"' && q != '\'' {
		return len(v)
	}
	n := len(v)
	for i := 0; i < len(v); i++ {
		if v[i] == '\\' || v[i] == q {
			n++
		}
	}
	return n
}

func writeEscaped(b *strings.Builder, v string, q byte) {
	if q != '"' && q != '\'' {
		b.WriteString(v)
		return
	}
	for i := 0; i < len(v); i++ {
		if v[i] == '\\' || v[i] == q {
			b.WriteByte('\\')
		}
		b.WriteByte(v[i])
	}
}

// substitute scans raw once (plan #112 §4.2). With build false it only counts the output, so a
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
	var quote byte // 0, '"', '\'' or '`'
	for i := 0; i < len(raw); {
		c := raw[i]
		switch {
		case c == '$':
			name, end, ok := reference(raw, i)
			if !ok {
				i++
				continue
			}
			value, subst := "", false
			switch {
			case name == macroInterval:
				value, subst, out.macro = m.interval, true, true
			case name == macroRateInterval:
				value, subst, out.macro = m.rateInterval, true, true
			case strings.HasPrefix(name, "__") || len(name) > maxNameLen:
			default:
				if v, has := vars[name]; has {
					value, subst = v, true
				} else if !contains(out.missing, name) {
					out.missing = append(out.missing, name)
				}
			}
			if !subst {
				i = end
				continue
			}
			flush(i)
			n := escapedLen(value, quote)
			if build {
				out.segs = append(out.segs, segment{sentFrom: out.size, sentLen: n, rawFrom: i, rawLen: end - i, kind: segInsert})
				writeEscaped(&b, value, quote)
			}
			out.size += n
			i, copyFrom = end, end
			continue
		case quote == 0:
			if c == '"' || c == '\'' || c == '`' {
				quote = c
			}
		case quote == '`':
			if c == '`' {
				quote = 0
			}
		case c == '\\':
			i += 2
			continue
		case c == quote:
			quote = 0
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

// replacementRune is U+FFFD as UTF-8 (plan #118 §3.1).
const replacementRune = "\xef\xbf\xbd"

// quotedLen is len(encodeQuoted(v, q)). Stub (plan #118 §5: tests first).
func quotedLen(v string, _ byte) int { return len(v) }

// encodeQuoted is v written in a string opened by q. Stub (plan #118 §5: tests first).
func encodeQuoted(v string, _ byte) string { return v }
