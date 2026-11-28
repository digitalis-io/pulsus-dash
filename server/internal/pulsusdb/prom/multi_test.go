package prom

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/prometheus/prometheus/model/labels"
	"github.com/prometheus/prometheus/promql/parser"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/vars"
)

// regexOf plans query with $n as vs and reads the regex the upstream parser gives label x.
func regexOf(t *testing.T, query string, vs []string) *labels.FastRegexMatcher {
	t.Helper()
	p, err := Plan(Inputs{Query: query, Vars: map[string]vars.Value{"n": {Values: vs}}, Kind: KindRange, StepMs: 5000}, MetricTypes{})
	if err != nil {
		t.Fatalf("Plan(%q, %q): %v", query, vs, err.Message)
	}
	expr, perr := promParser.ParseExpr(p.Query)
	if perr != nil {
		t.Fatalf("ParseExpr(%q): %v", p.Query, perr)
	}
	var m *labels.Matcher
	parser.Inspect(expr, func(n parser.Node, _ []parser.Node) error {
		if vs, ok := n.(*parser.VectorSelector); ok {
			for _, lm := range vs.LabelMatchers {
				if lm.Name == "x" {
					m = lm
				}
			}
		}
		return nil
	})
	if m == nil || (m.Type != labels.MatchRegexp && m.Type != labels.MatchNotRegexp) {
		t.Fatalf("%q: no regex matcher on x", p.Query)
	}
	r, rerr := labels.NewFastRegexMatcher(m.Value)
	if rerr != nil {
		t.Fatalf("%q: %v", m.Value, rerr)
	}
	return r
}

// unit:plan-parity R02–R04, R06 (plan #289 §5): the anchored RE2 of each planned regex matches
// exactly the selected values with the template's own text, never more.
func TestStructuredRegexMatchSets(t *testing.T) {
	for _, c := range []struct {
		name, query string
		vs          []string
		match, not  []string
	}{
		{"R02", `sum(up{x=~"$n+"})`, []string{"ab"}, []string{"ab", "abab"}, []string{"abb", "a", "", "AB"}},
		{"R03a", `sum(up{x=~"x$n"})`, []string{"a", "b"}, []string{"xa", "xb"}, []string{"a", "b", "x", "xab", "xc"}},
		{"R03b", `sum(up{x=~"$n|y"})`, []string{"a", "b"}, []string{"a", "b", "y"}, []string{"ab", "ay", "x"}},
		{"R04", `sum(up{x=~"^$n$"})`, []string{"a", "b.c"}, []string{"a", "b.c"}, []string{"bxc", "ab.c", "b.ca"}},
		{"R06a", `sum(up{x=~"(?i)$n"})`, []string{"node"}, []string{"node"}, []string{"NODE", "Node"}},
		{"R06b", `sum(up{x=~"(?i)$n"})`, []string{"node", "db"}, []string{"node", "db"}, []string{"NODE", "DB", "Db"}},
		{"R06c", `sum(up{x=~"(?i)a$n"})`, []string{"node"}, []string{"anode", "Anode"}, []string{"aNODE"}},
		{"M12", `sum(up{x=~"$n"})`, []string{"node.1"}, []string{"node.1"}, []string{"nodeX1"}},
	} {
		r := regexOf(t, c.query, c.vs)
		for _, s := range c.match {
			if !r.MatchString(s) {
				t.Errorf("%s: %q does not match %q", c.name, r.GetRegexString(), s)
			}
		}
		for _, s := range c.not {
			if r.MatchString(s) {
				t.Errorf("%s: %q matches %q", c.name, r.GetRegexString(), s)
			}
		}
	}
}

// candidates are strings near the values that a broadened regex would also match.
func candidates(vs []string) []string {
	var out []string
	for _, v := range vs {
		out = append(out, v+"x", "x"+v, v+v, strings.ToUpper(v), strings.ToLower(v))
		if len(v) > 0 {
			_, n := utf8.DecodeLastRuneInString(v)
			out = append(out, v[:len(v)-n])
		}
		var b strings.Builder
		for _, r := range v {
			if strings.ContainsRune(`\.+*?()|[]{}^$`, r) {
				b.WriteByte('X')
			} else {
				b.WriteRune(r)
			}
		}
		out = append(out, b.String())
	}
	if len(vs) > 1 {
		out = append(out, strings.Join(vs, ""), strings.Join(vs, "|"))
	}
	return out
}

// FuzzMultiRegexRoundTrip (T07-031, plan #289 §5; here, not in vars, because only this package
// may import the upstream parser): a set of values with RE2 metacharacters,
// backslashes, quotes and LF, planned in x=~"$v" and read by the upstream parser, gives a
// matcher whose anchored RE2 matches each value and none of the nearby strings that are not in
// the set.
func FuzzMultiRegexRoundTrip(f *testing.F) {
	for _, s := range []string{"node.1", "a\x00b", `a\b` + "\x00" + `c"d`, "x)|(.*\x00y", "[a-z]+\x00{1,2}", "a\nb\x00'q'",
		"^$\x00.", `\Q\E` + "\x00" + `\`, "é\x00(?i)A", "`x`\x00#"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, joined string) {
		if !utf8.ValidString(joined) {
			t.Skip()
		}
		var vs []string
		seen := map[string]bool{}
		for _, v := range strings.Split(joined, "\x00") {
			if v == "" || seen[v] || len(v) > vars.MaxValueBytes || strings.ContainsRune(v, utf8.RuneError) {
				continue
			}
			seen[v] = true
			vs = append(vs, v)
		}
		if len(vs) == 0 || len(vs) > 200 {
			t.Skip()
		}
		r := regexOf(t, `up{x=~"$n"}`, vs)
		for _, v := range vs {
			if !r.MatchString(v) {
				t.Fatalf("%q does not match %q", r.GetRegexString(), v)
			}
		}
		for _, c := range candidates(vs) {
			if !seen[c] && r.MatchString(c) {
				t.Fatalf("%q matches %q, not in %q", r.GetRegexString(), c, vs)
			}
		}
	})
}
