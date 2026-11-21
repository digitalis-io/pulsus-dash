package pulsusdb

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// seen is one request an upstream received.
type seen struct {
	Method, Path string
	Form         url.Values
	Header       http.Header
}

// upstream is an httptest PulsusDB that records requests and answers with h.
type upstream struct {
	*httptest.Server
	mu   sync.Mutex
	reqs []seen
}

func newUpstream(t *testing.T, h http.HandlerFunc) *upstream {
	t.Helper()
	u := &upstream{}
	u.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		u.mu.Lock()
		u.reqs = append(u.reqs, seen{Method: r.Method, Path: r.URL.EscapedPath(), Form: r.Form, Header: r.Header.Clone()})
		u.mu.Unlock()
		h(w, r)
	}))
	t.Cleanup(u.Close)
	return u
}

func (u *upstream) requests() []seen {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]seen(nil), u.reqs...)
}

// answer writes status, the JSON content type, the headers kv and body.
func answer(status int, body string, kv ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		for i := 0; i+1 < len(kv); i += 2 {
			w.Header().Set(kv[i], kv[i+1])
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}
}

var testBindingID = uuid.MustParse("01900000-0000-7000-8000-000000000001")

func testBinding(url string) core.TenantBinding {
	return core.TenantBinding{ID: testBindingID, Slug: "demo", DatasourceURL: url, Kind: "pulsusdb"}
}

func rcFor(b core.TenantBinding) *core.RequestCtx {
	return &core.RequestCtx{Tenant: core.TenantCtx{Org: core.OrgID(uuid.MustParse("01900000-0000-7000-8000-0000000000aa")), Binding: b},
		Principal: core.LocalPrincipal, Scope: core.FullTenantScope(), Priority: core.PriorityInteractive, RequestID: "req-1"}
}

// logBuffer collects the client's JSON log output.
type logBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *logBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *logBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func (b *logBuffer) logger() *slog.Logger {
	return slog.New(slog.NewJSONHandler(b, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

// fakeClock is a frozen clock that only Advance moves.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock { return &fakeClock{now: time.Now()} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// counterRange is the request grid of the counter transcript: 1767225600 … 1767229200 s at 5 s.
func counterRange(query string) RangeQuery {
	return RangeQuery{Query: query, Start: time.UnixMilli(1767225600000), End: time.UnixMilli(1767229200000),
		Step: 5 * time.Second, Timeout: 30 * time.Second}
}

func ctxWithin(t *testing.T, d time.Duration) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	t.Cleanup(cancel)
	return ctx
}

func kindOf(err error) ErrorKind {
	if e, ok := err.(*Error); ok {
		return e.Kind
	}
	return 0
}
