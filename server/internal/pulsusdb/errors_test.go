package pulsusdb

import (
	"strings"
	"testing"
)

// unit:error-position (T09-009).
func TestErrorPosition(t *testing.T) {
	for _, c := range []struct {
		msg, query string
		want       int // -1 = none
	}{
		{"1:4: parse error: x", "up{", 3},
		{"2:3: x", "a\nbcd", 4},
		{"9:9: x", "up{", -1},
		{"unclosed left parenthesis", "sum(", -1},
		{"1:9: x", "up{", -1},
		{"0:1: x", "up{", -1},
		{"1:0: x", "up{", -1},
	} {
		p := positionOf(c.msg, c.query)
		switch {
		case c.want < 0 && p != nil:
			t.Errorf("positionOf(%q, %q) = %d, want none", c.msg, c.query, p.Offset)
		case c.want >= 0 && (p == nil || p.Offset != c.want):
			t.Errorf("positionOf(%q, %q) = %v, want %d", c.msg, c.query, p, c.want)
		}
	}
}

func TestErrorKindNames(t *testing.T) {
	want := "unreachable timeout unavailable query_invalid too_broad rate_limited unauthorised protocol scope_denied busy config virtual"
	var got []string
	for k := KindUnreachable; k <= KindVirtual; k++ {
		got = append(got, k.String())
	}
	if strings.Join(got, " ") != want {
		t.Errorf("kind names %q, want %q", strings.Join(got, " "), want)
	}
	e := &Error{Kind: KindTooBroad, Message: "m"}
	if e.Error() != "pulsusdb: too_broad: m" {
		t.Errorf("Error() = %q", e.Error())
	}
}
