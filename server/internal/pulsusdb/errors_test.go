package pulsusdb

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
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

// textUpstream answers status with a text/plain body.
func textUpstream(t *testing.T, status int, ctype, text string) *upstream {
	t.Helper()
	return newUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", ctype)
		w.WriteHeader(status)
		_, _ = io.WriteString(w, text)
	})
}

// unit:text-errors (§4.5, T09-009, PRF-031).
func TestTextErrors(t *testing.T) {
	const query = `{app="x"` // 8 bytes
	logQuery := func(u *upstream, c *Client, b core.TenantBinding) error {
		q := a1Query(10, Backward)
		q.Query = query
		_, err := c.LogQueryRange(ctxWithin(t, 5*time.Second), rcFor(b), q)
		return err
	}
	for _, c := range []struct {
		name, ctype, text string
		status            int
		kind              ErrorKind
		pos               int // -1 = none
		msg               string
	}{
		{"at byte 8", "text/plain; charset=utf-8", "unexpected end of query at byte 8: expected '}'", 400, KindQueryInvalid, 8,
			"unexpected end of query at byte 8: expected '}'"},
		{"no charset", "text/plain", "unexpected end of query at byte 3: x", 400, KindQueryInvalid, 3, "unexpected end of query at byte 3: x"},
		{"at byte 99", "text/plain", "bad at byte 99", 400, KindQueryInvalid, -1, "bad at byte 99"},
		{"prefix wins", "text/plain", "1:4: bad at byte 7", 400, KindQueryInvalid, 3, "1:4: bad at byte 7"},
		{"422", "text/plain", "query too broad: 9000 streams", 422, KindTooBroad, -1, "query too broad: 9000 streams"},
		{"control and invalid UTF-8", "text/plain", "a\x01b\xffc", 400, KindQueryInvalid, -1, "a b�c"},
	} {
		u := textUpstream(t, c.status, c.ctype, c.text)
		err := logQuery(u, New(Options{}), testBinding(u.URL))
		e, ok := err.(*Error)
		switch {
		case !ok || e.Kind != c.kind:
			t.Errorf("%s: %v, want %v", c.name, err, c.kind)
		case e.Message != c.msg:
			t.Errorf("%s: message %q, want %q", c.name, e.Message, c.msg)
		case c.pos < 0 && e.Position != nil, c.pos >= 0 && (e.Position == nil || e.Position.Offset != c.pos):
			t.Errorf("%s: position %v, want %d", c.name, e.Position, c.pos)
		}
	}

	// Both route families: a PromQL range query with a text 400.
	u := textUpstream(t, 400, "text/plain", "1:3: parse error")
	_, err := New(Options{}).QueryRange(ctxWithin(t, 5*time.Second), rcFor(testBinding(u.URL)), counterRange("up{"))
	if e, ok := err.(*Error); !ok || e.Kind != KindQueryInvalid || e.Message != "1:3: parse error" || e.Position == nil || e.Position.Offset != 2 {
		t.Errorf("PromQL text 400: %v", err)
	}

	// A text holding the password is redacted.
	u = textUpstream(t, 400, "text/plain", "bad credentials pw-secret-1 at byte 2")
	b := testBinding(u.URL)
	b.CredentialsRef = "env:C"
	err = logQuery(u, New(Options{Secrets: secretsOf(map[string]string{"env:C": "user:pw-secret-1"})}), b)
	if e, ok := err.(*Error); !ok || e.Kind != KindQueryInvalid || e.Message != "bad credentials <redacted> at byte 2" {
		t.Errorf("redacted text: %v", err)
	}

	// A text body over ErrorBody is refused.
	u = textUpstream(t, 400, "text/plain", strings.Repeat("x", 65537))
	wantProtocol(t, "65 537-byte text", logQuery(u, New(Options{}), testBinding(u.URL)))

	// positionOf reads "at byte N" (0-based) when there is no prefix.
	for _, c := range []struct {
		msg  string
		want int
	}{{"x at byte 0", 0}, {"x at byte 8: y", 8}, {"x at byte 9", -1}, {"x at bytes 3", -1}, {"at byte 2 and at byte 5", 2}} {
		p := positionOf(c.msg, query)
		if (c.want < 0) != (p == nil) || (p != nil && p.Offset != c.want) {
			t.Errorf("positionOf(%q) = %v, want %d", c.msg, p, c.want)
		}
	}
}
