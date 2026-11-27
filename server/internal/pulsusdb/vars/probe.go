package vars

import (
	"regexp/syntax"
	"slices"
	"strconv"
	"strings"
)

// probePrefix starts every probe; a template that already holds it is refused.
const probePrefix = "pulsusvarprobe"

// Probe is the guard's stand-in for structured reference i of a regex string (plan #289 §3.4):
// letters and digits only, so QuoteMeta leaves it as it is, and the final "z" keeps Probe(1) out
// of Probe(12).
func Probe(i int) string { return probePrefix + strconv.Itoa(i) + "z" }

// ProbeRendering is Probe(i) written as a structured value is written in a regex.
func ProbeRendering(i int) string { return group([]string{Probe(i)}) }

// probeVariants are Probe(i) with three different first runes. The parser factors a common
// literal prefix out of adjacent alternatives (prod|$n gives p(?:rod|ulsus…)), which splits a
// probe without moving it; a probe has two neighbours, so one of three variants is never split.
// Each variant holds Probe(i) whole.
func probeVariants(i int) []string {
	p := Probe(i)
	return []string{p, "q" + p, "x" + p}
}

// ProbeRegex is the guard over one decoded regex holding the probes of refs, each once (plan #289
// §3.4; fails closed). It parses the regex (Perl flags) and accepts only if, for every probe, a
// literal node outside any class and without case folding holds it as one contiguous run, with
// neither the wrapper's own text nor a brace next to it (the wrapper read as text, as in \Q…\E, or a
// quantifier brace read as text). A parse error, a probe missing from the tree, or any other
// occurrence of the probe text refuses it (in regex).
func ProbeRegex(decoded string, refs []int) (where string, ok bool) {
	probes := make([]string, len(refs))
	for k, i := range refs {
		probes[k] = Probe(i)
	}
	return probeRegex(decoded, probes)
}

func probeRegex(decoded string, probes []string) (string, bool) {
	if strings.Count(decoded, probePrefix) != len(probes) {
		return WhereRegex, false
	}
	re, err := syntax.Parse(decoded, syntax.Perl)
	if err != nil {
		return WhereRegex, false
	}
	for _, p := range probes {
		if strings.Count(decoded, p) != 1 || !literalHolds(re, p) {
			return WhereRegex, false
		}
	}
	return "", true
}

// literalHolds reports whether a literal node of re, without FoldCase, holds p cleanly. A class
// node has no literal below it, so a probe inside a class is never found.
func literalHolds(re *syntax.Regexp, p string) bool {
	if re.Op == syntax.OpLiteral && re.Flags&syntax.FoldCase == 0 {
		s := string(re.Rune)
		if at := strings.Index(s, p); at >= 0 {
			before, after := s[:at], s[at+len(p):]
			return !strings.HasSuffix(before, "(?-i:(?:") && !strings.HasPrefix(after, "))") &&
				!strings.HasSuffix(before, "{") && !strings.HasPrefix(after, "}")
		}
	}
	for _, sub := range re.Sub {
		if literalHolds(sub, p) {
			return true
		}
	}
	return false
}

// RegexPart is one part of a regex string as the string decodes it: the template's own text, a
// legacy value or a macro (Structured false), or a structured reference's rendering; Group marks
// a VarMulti's rendering (a group of quoted literals), whose structure any other group shares.
type RegexPart struct {
	Text       string
	Structured bool
	Group      bool
}

// RegexRefusal is a refused structured part of a regex string and where it sits.
type RegexRefusal struct {
	Part  int
	Where string
}

// MaxGuardBytes bounds the regex text the guard parses for one query: a query whose regex strings
// would need more is refused (in regex) for the references left, so the guard's work is bounded
// whatever the number of references.
const MaxGuardBytes = 8 << 20

// Guard is the probe guard's budget over one query (MaxGuardBytes); the zero value is fresh.
type Guard struct{ parsed int }

// take reserves n bytes of parsing; false once the budget is spent.
func (g *Guard) take(n int) bool {
	if g.parsed+n > MaxGuardBytes {
		g.parsed = MaxGuardBytes
		return false
	}
	g.parsed += n
	return true
}

// regexScan is the position state of a regex as it decodes (plan #289 §3.4).
type regexScan struct {
	esc       bool // an unconsumed regex backslash
	quoted    bool // inside \Q…\E
	qSlash    bool // quoted: the previous byte was a backslash
	class     bool // inside […]
	classItem bool // class: an item was read, so ] closes it (] first, after [ or [^, is literal)
	classNeg  bool // class: the ^ after [ was read
	brace     bool // inside a quantifier brace {…}
}

// where is the place of a structured reference at the scan's position, or "" when allowed.
func (s *regexScan) where() string {
	switch {
	case s.esc:
		return WhereRegexEscape
	case s.quoted:
		return WhereRegexQuoted
	case s.class, s.brace:
		return WhereRegexClass
	}
	return ""
}

// feed reads text: only ASCII bytes change the state, so bytes are read one by one.
func (s *regexScan) feed(text string) {
	for i := 0; i < len(text); i++ {
		c := text[i]
		switch {
		case s.quoted:
			if s.qSlash && c == 'E' {
				s.quoted = false
			}
			s.qSlash = c == '\\'
		case s.esc:
			s.esc = false
			if c == 'Q' && !s.class {
				s.quoted, s.qSlash = true, false
			}
			if s.class {
				s.classItem = true
			}
		case c == '\\':
			s.esc = true
		case s.class:
			switch {
			case c == '^' && !s.classItem && !s.classNeg:
				s.classNeg = true
			case c == ']' && s.classItem:
				s.class = false
			case c == '[' && i+1 < len(text) && text[i+1] == ':':
				// A POSIX class [:name:] is one item; without its :] the [ is an item.
				if end := strings.Index(text[i+2:], ":]"); end >= 0 {
					i += 2 + end + 1
				}
				s.classItem = true
			default:
				s.classItem = true
			}
		case s.brace:
			if c == '}' {
				s.brace = false
			}
		case c == '[':
			s.class, s.classItem, s.classNeg = true, false, false
		case c == '{':
			s.brace = true
		}
	}
}

// CheckRegex is the regex position rules over the parts of one regex string, in order (plan #289
// §3.4): a structured reference is refused inside a class or a quantifier brace (regex class),
// right after an unconsumed backslash (regex escape) or inside \Q…\E (regex quoted text). With a
// guard, every structured part the rules allow is then probed (ProbeRegex; in regex): each in
// turn as its probe, the others as their renderings. Every VarMulti part is first probed in one
// parse, the other VarMulti parts as their own probes (a group of quoted literals has the
// structure of any other, so the position of each is the same); a part that parse does not clear
// is probed alone. It returns the refused parts in part order.
func CheckRegex(parts []RegexPart, g *Guard) []RegexRefusal {
	var s regexScan
	refused := make(map[int]string)
	for k, p := range parts {
		if p.Structured {
			if w := s.where(); w != "" {
				refused[k] = w
			}
		}
		s.feed(p.Text)
	}
	if g != nil {
		probeParts(parts, refused, g)
	}
	out := make([]RegexRefusal, 0, len(refused))
	for k := range parts {
		if w, ok := refused[k]; ok {
			out = append(out, RegexRefusal{Part: k, Where: w})
		}
	}
	return out
}

// probeParts runs the guard over the structured parts not refused yet, adding its refusals.
func probeParts(parts []RegexPart, refused map[int]string, g *Guard) {
	render := func(probes map[int]string) (string, []string) {
		var b strings.Builder
		var ps []string
		for j, q := range parts {
			if p, ok := probes[j]; ok {
				b.WriteString(group([]string{p}))
				ps = append(ps, p)
			} else {
				b.WriteString(q.Text)
			}
		}
		return b.String(), ps
	}
	var alone []int
	groups := map[int]string{}
	for k, p := range parts {
		if _, no := refused[k]; !no && p.Structured {
			if p.Group {
				groups[k] = probeVariants(k)[len(groups)%3]
			} else {
				alone = append(alone, k)
			}
		}
	}
	if len(groups) > 0 {
		decoded, _ := render(groups)
		var re *syntax.Regexp
		clean := g.take(len(decoded)) && strings.Count(decoded, probePrefix) == len(groups)
		if clean {
			var err error
			re, err = syntax.Parse(decoded, syntax.Perl)
			clean = err == nil
		}
		for k, p := range groups {
			if !clean || strings.Count(decoded, p) != 1 || !literalHolds(re, p) {
				alone = append(alone, k)
			}
		}
		slices.Sort(alone)
	}
	for _, k := range alone {
		ok := false
		for _, probe := range probeVariants(k) {
			decoded, ps := render(map[int]string{k: probe})
			if !g.take(len(decoded)) {
				break
			}
			if _, ok = probeRegex(decoded, ps); ok {
				break
			}
		}
		if !ok {
			refused[k] = WhereRegex
		}
	}
}
