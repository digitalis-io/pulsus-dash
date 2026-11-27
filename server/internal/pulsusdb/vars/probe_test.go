package vars

import "testing"

// unit:regex-probe-guard (T07-031, plan #289 §3.4): ProbeRegex on decoded regexes, the scanner
// bypassed: each template a scanner miss would let through is refused (in regex); the rest pass.
func TestProbeRegex(t *testing.T) {
	p := ProbeRendering(0)
	if want := "(?-i:(?:pulsusvarprobe0z))"; p != want || Probe(0) != "pulsusvarprobe0z" || Probe(12) != "pulsusvarprobe12z" {
		t.Fatalf("ProbeRendering(0) = %q, Probe(0) = %q, want %q", p, Probe(0), want)
	}
	for _, c := range []struct {
		name, template string
		ok             bool
	}{
		{"[$n]", "[" + p + "]", false},
		{"[[:alpha:]$n]", "[[:alpha:]" + p + "]", false},
		{`\Q$n\E`, `\Q` + p + `\E`, false},
		{"(?i)$n without the wrapper", "(?i)" + Probe(0), false},
		{`\$n`, `\` + p, false},
		{"x{$n}", "x{" + p + "}", false},
		{"x{2,$n}", "x{2," + p + "}", false},
		{"a template holding the probe text", "pulsusvarprobe" + p, false},
		{"a parse error", "(" + p, false},
		{"no probe", "abc", false},
		{"x$n", "x" + p, true},
		{"^$n$", "^" + p + "$", true},
		{"$n+", p + "+", true},
		{"(?i)a$n", "(?i)a" + p, true},
		{"$n|y", p + "|y", true},
		{"a(b|$n)c", "a(b|" + p + ")c", true},
	} {
		where, ok := ProbeRegex(c.template, []int{0})
		if ok != c.ok || (!ok && where != WhereRegex) || (ok && where != "") {
			t.Errorf("%s: ProbeRegex(%q) = %q, %v; want ok %v", c.name, c.template, where, ok, c.ok)
		}
	}
	// Two probes: each is checked; one in a class refuses the regex.
	two := "a" + ProbeRendering(0) + "[" + ProbeRendering(1) + "]"
	if _, ok := ProbeRegex(two, []int{0, 1}); ok {
		t.Errorf("%q: accepted", two)
	}
	if _, ok := ProbeRegex("a"+ProbeRendering(0)+"|"+ProbeRendering(1), []int{0, 1}); !ok {
		t.Errorf("two literals: refused")
	}
}
