package logs

import (
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
)

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			return false
		}
	}
	return true
}

// unit:plan-parity (logs) FuzzEncodeDQ: a value written into a "…" string reads back as itself,
// and an ASCII-only value is written as strconv.Quote writes it (plan #116 §4.2).
func FuzzEncodeDQ(f *testing.F) {
	for _, s := range []string{"\n", "\x00\x7f", "  ", "ü€😀", "`", `x"y\`, "x\ty", "x\x01y"} {
		f.Add(s)
	}
	if fx, err := readFixture(); err == nil {
		for _, c := range fx.Plan {
			for _, v := range c.Inputs.Vars {
				f.Add(v)
			}
		}
	}
	f.Fuzz(func(t *testing.T, v string) {
		if !utf8.ValidString(v) {
			t.Skip()
		}
		e := encodeDQ(v)
		if got, err := strconv.Unquote(`"` + e + `"`); err != nil || got != v {
			t.Fatalf("Unquote(encodeDQ(%q)) = %q, %v", v, got, err)
		}
		if len(e) != encodedDQLen(v) {
			t.Fatalf("encodedDQLen(%q) = %d, want %d", v, encodedDQLen(v), len(e))
		}
		if isASCII(v) {
			if q := strconv.Quote(v); e != strings.TrimSuffix(strings.TrimPrefix(q, `"`), `"`) {
				t.Fatalf("encodeDQ(%q) = %q, strconv.Quote gives %s", v, e, q)
			}
		}
	})
}
