package prom

import (
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/prometheus/prometheus/promql/parser"
	"github.com/prometheus/prometheus/util/strutil"
)

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

// valueSeeds are the seeds of both fuzz tests (plan #118 §5.1): the listed values and every
// fixture value.
func valueSeeds() []string {
	out := []string{"\n", "\r", "\x00\x7f", "\u00a0\u2028", "\ufffd", "ü€😀", "`", "'\"", `x"y\`}
	fx := fixture{}
	if b, err := os.ReadFile(fixturePath); err == nil {
		_ = json.Unmarshal(b, &fx)
	}
	for _, c := range fx.Plan {
		for _, v := range c.Inputs.Vars {
			out = append(out, v)
		}
	}
	return out
}

// quoteForm is §4.2's strconv.Quote form of an ASCII-only v for a string opened by q.
func quoteForm(v string, q byte) string {
	dq := strings.TrimSuffix(strings.TrimPrefix(strconv.Quote(v), `"`), `"`)
	if q == '"' {
		return dq
	}
	return strings.ReplaceAll(strings.ReplaceAll(dq, `\"`, `"`), `'`, `\'`)
}

// unit:plan-parity FuzzEncodeQuoted: a value written into "…" or '…' reads back as itself by the
// upstream parser's unquote (plan #118 §4.2). go test -fuzz is not in CI; the seeds run.
func FuzzEncodeQuoted(f *testing.F) {
	for _, s := range valueSeeds() {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, v string) {
		if !utf8.ValidString(v) {
			t.Skip()
		}
		for _, q := range []byte{'"', '\''} {
			e := encodeQuoted(v, q)
			lit := string(q) + e + string(q)
			if got, err := strutil.Unquote(lit); err != nil || got != v {
				t.Fatalf("strutil.Unquote(%s) = %q, %v; want %q", lit, got, err, v)
			}
			if n := quotedLen(v, q); n != len(e) {
				t.Fatalf("quotedLen(%q, %c) = %d, want %d", v, q, n, len(e))
			}
			if strings.Contains(e, replacementRune) {
				t.Fatalf("encodeQuoted(%q, %c) = %q holds a literal U+FFFD", v, q, e)
			}
			if q == '"' {
				if got, err := strconv.Unquote(lit); err != nil || got != v {
					t.Fatalf("strconv.Unquote(%s) = %q, %v; want %q", lit, got, err, v)
				}
			}
			if isASCII(v) && e != quoteForm(v, q) {
				t.Fatalf("encodeQuoted(%q, %c) = %q, want %q", v, q, e, quoteForm(v, q))
			}
		}
	})
}

// matcherValue is the value of the matcher a of a planned query parsed by the upstream parser.
func matcherValue(t *testing.T, query string) string {
	t.Helper()
	expr, err := promParser.ParseExpr(query)
	if err != nil {
		t.Fatalf("ParseExpr(%q): %v", query, err)
	}
	vs, ok := expr.(*parser.VectorSelector)
	if !ok {
		t.Fatalf("ParseExpr(%q) is %T, want a vector selector", query, expr)
	}
	for _, m := range vs.LabelMatchers {
		if m.Name == "a" {
			return m.Value
		}
	}
	t.Fatalf("ParseExpr(%q): no matcher a", query)
	return ""
}

func wantUnrepresentable(t *testing.T, query, v string, err *PlanError) {
	t.Helper()
	if err == nil || len(err.Fields) != 1 || err.Fields[0] != (FieldError{"/vars/a", "variable.unrepresentable"}) {
		t.Fatalf("%s with %q: %+v, want variable.unrepresentable", query, v, err)
	}
}

// unit:plan-parity FuzzValueRoundTrip: the planned text parses to the value, or the value is
// refused with variable.unrepresentable where it cannot be written (plan #118 §4.1, §4.3).
func FuzzValueRoundTrip(f *testing.F) {
	for _, s := range valueSeeds() {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, v string) {
		if !utf8.ValidString(v) || len(v) > MaxValueBytes {
			t.Skip()
		}
		plan := func(q string) (Planned, *PlanError) {
			return Plan(Inputs{Query: q, Vars: map[string]string{"a": v}, Kind: KindRange, StepMs: 5000}, MetricTypes{})
		}
		for _, q := range []string{`x{a="$a"}`, `x{a='$a'}`} {
			p, err := plan(q)
			if err != nil {
				t.Fatalf("%s with %q: %v", q, v, err)
			}
			if got := matcherValue(t, p.Query); got != v {
				t.Fatalf("%s with %q: matcher value %q", q, v, got)
			}
		}
		const bq = "x{a=`$a`}"
		p, err := plan(bq)
		if strings.ContainsAny(v, "`\r") || strings.Contains(v, replacementRune) {
			wantUnrepresentable(t, bq, v, err)
		} else if err != nil {
			t.Fatalf("%s with %q: %v", bq, v, err)
		} else if got := matcherValue(t, p.Query); got != v {
			t.Fatalf("%s with %q: matcher value %q", bq, v, got)
		}
		const cm = "x # $a"
		p, err = plan(cm)
		if strings.ContainsAny(v, "\n\r") {
			wantUnrepresentable(t, cm, v, err)
			return
		}
		if err != nil {
			t.Fatalf("%s with %q: %v", cm, v, err)
		}
		expr, perr := promParser.ParseExpr(p.Query)
		if perr != nil || expr.String() != "x" {
			t.Fatalf("%s with %q: ParseExpr(%q) = %v, %v; want x", cm, v, p.Query, expr, perr)
		}
	})
}
