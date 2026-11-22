package pulsusdb

import (
	"net/http"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

func bindingAt(url string) core.TenantBinding {
	return core.TenantBinding{Slug: "demo", DatasourceURL: url, Kind: "pulsusdb"}
}

// unit:sanitise (pulsusdb half; review r1 #7, T06-024): every needle of §4.9 is redacted.
func TestRedactNeedles(t *testing.T) {
	r := newRedactor(bindingAt("http://localhost:9091/prefix"), "user:pw-secret")
	in := "bad user:pw-secret at http://localhost:9091/prefix/x host localhost:9091 dXNlcjpwdy1zZWNyZXQ= end"
	got := r.redact(in)
	if n := strings.Count(got, "<redacted>"); n != 4 {
		t.Errorf("redact = %q: %d redactions, want 4", got, n)
	}
	for _, s := range []string{"user:pw-secret", "pw-secret", "localhost:9091", "dXNlcjpwdy1zZWNyZXQ="} {
		if strings.Contains(got, s) {
			t.Errorf("redact = %q still contains %q", got, s)
		}
	}
	if r.redact("nothing to see") != "nothing to see" {
		t.Error("redact changed a clean string")
	}
	// Without credentials only the URL forms are needles.
	plain := newRedactor(bindingAt("http://localhost:9091"), "")
	if len(plain.needles) > 3 || len(plain.needles) == 0 {
		t.Errorf("needles without credentials = %q, want the URL forms only", plain.needles)
	}
	if got := plain.redact("at localhost:9091 now"); got != "at <redacted> now" {
		t.Errorf("redact = %q", got)
	}
}

// Short passwords are redacted at every length (review r2 #1). The client refuses them since r5-1,
// so they are checked here on the redactor itself.
func TestRedactShortPasswords(t *testing.T) {
	for _, c := range []struct{ cred, pw string }{{"u:x", "x"}, {"u:pw", "pw"}} {
		r := newRedactor(bindingAt("http://localhost:9091"), c.cred)
		got := r.redact("x pw u:x u:pw")
		if strings.Contains(got, c.cred) || strings.Contains(got, c.pw) {
			t.Errorf("%s: redact = %q still contains the password", c.cred, got)
		}
	}
}

func TestCleanText(t *testing.T) {
	if got := cleanText("a\x07b\nc\x7fd", 1024); got != "a b c d" {
		t.Errorf("cleanText = %q", got)
	}
	long := strings.Repeat("é", 1000) // 2 000 bytes
	got := cleanText(long, 1024)
	if !strings.HasSuffix(got, "…") || len(got) > 1024+len("…") || !utf8.ValidString(got) {
		t.Errorf("cleanText cut: %d bytes, valid %v", len(got), utf8.ValidString(got))
	}
	if cleanText("short", 1024) != "short" {
		t.Error("cleanText changed a short text")
	}
}

// Accepted headers are redacted and treated as absent when redaction changed them or they fail
// their pattern (§4.9); numeric headers are checked against a numeric password.
func TestReadHeaders(t *testing.T) {
	h := func(kv ...string) http.Header {
		out := http.Header{}
		for i := 0; i+1 < len(kv); i += 2 {
			out.Set(kv[i], kv[i+1])
		}
		return out
	}
	r := newRedactor(bindingAt("http://localhost:9091"), "u:pw-secret")
	num := newRedactor(bindingAt("http://localhost:9091"), "u:123")
	for _, c := range []struct {
		name string
		red  redactor
		hdr  http.Header
		want upstreamHeaders
	}{
		{"ok", r, h("X-Pulsus-Query-Id", "fake-1", "X-Pulsus-Read-Cache", "hit", "X-Pulsus-Read-Cache-Through", "1767229", "Retry-After", "5"),
			upstreamHeaders{QueryID: "fake-1", ReadCache: "hit", ReadCacheThroughMs: 1767229, RetryAfter: "5"}},
		{"absent", r, h(), upstreamHeaders{ReadCacheThroughMs: -1}},
		{"secret id", r, h("X-Pulsus-Query-Id", "pw-secret"), upstreamHeaders{ReadCacheThroughMs: -1}},
		{"embedded secret id", r, h("X-Pulsus-Query-Id", "aapw-secretbb"), upstreamHeaders{ReadCacheThroughMs: -1}},
		{"bad id", r, h("X-Pulsus-Query-Id", "bad id!"), upstreamHeaders{ReadCacheThroughMs: -1}},
		{"long id", r, h("X-Pulsus-Query-Id", strings.Repeat("a", 65)), upstreamHeaders{ReadCacheThroughMs: -1}},
		{"secret cache", r, h("X-Pulsus-Read-Cache", "pw-secret"), upstreamHeaders{ReadCache: "other", ReadCacheThroughMs: -1}},
		{"bypass", r, h("X-Pulsus-Read-Cache", "bypass"), upstreamHeaders{ReadCache: "bypass", ReadCacheThroughMs: -1}},
		{"numeric through", num, h("X-Pulsus-Read-Cache-Through", "123"), upstreamHeaders{ReadCacheThroughMs: -1}},
		{"through not numeric", r, h("X-Pulsus-Read-Cache-Through", "abc"), upstreamHeaders{ReadCacheThroughMs: -1}},
		{"numeric retry", num, h("Retry-After", "123"), upstreamHeaders{ReadCacheThroughMs: -1}},
		{"retry too long", r, h("Retry-After", "1234567"), upstreamHeaders{ReadCacheThroughMs: -1}},
	} {
		if got := readHeaders(c.hdr, c.red); got != c.want {
			t.Errorf("%s: %+v, want %+v", c.name, got, c.want)
		}
	}
}

// readTextBody (§4.5): capped, valid UTF-8, redacted.
func TestReadTextBody(t *testing.T) {
	red := needleRedactor("pw-secret-1")
	if s, err := readTextBody(strings.NewReader("a pw-secret-1 \xff b"), 64, red); err != nil || s != "a <redacted> � b" {
		t.Errorf("readTextBody = %q %v", s, err)
	}
	if _, err := readTextBody(strings.NewReader(strings.Repeat("x", 65)), 64, red); err == nil {
		t.Error("readTextBody accepted 65 bytes over a 64-byte cap")
	}
	if s, err := readTextBody(strings.NewReader(strings.Repeat("x", 64)), 64, red); err != nil || len(s) != 64 {
		t.Errorf("readTextBody at the cap = %d bytes %v", len(s), err)
	}
}
