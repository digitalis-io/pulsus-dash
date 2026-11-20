package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

// fakeProbe is a scripted Probe. A nil func means "succeed" (SchemaVersion returns version).
type fakeProbe struct {
	ping    func(ctx context.Context) error
	schema  func(ctx context.Context) (int64, error)
	version int64

	mu    sync.Mutex
	calls int
}

func (p *fakeProbe) Ping(ctx context.Context) error {
	p.mu.Lock()
	p.calls++
	p.mu.Unlock()
	if p.ping != nil {
		return p.ping(ctx)
	}
	return nil
}

func (p *fakeProbe) SchemaVersion(ctx context.Context) (int64, error) {
	p.mu.Lock()
	p.calls++
	p.mu.Unlock()
	if p.schema != nil {
		return p.schema(ctx)
	}
	return p.version, nil
}

// syncBuffer is an io.Writer safe for the logger's concurrent use.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) records(t *testing.T) []map[string]any {
	t.Helper()
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(b.buf.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("log line %q is not JSON: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

func newHandler(p Probe) (http.Handler, *syncBuffer) {
	logs := &syncBuffer{}
	logger := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	return New(Deps{Logger: logger, Probe: p, SchemaLatest: 1}), logs
}

func do(h http.Handler, method, path string, hdr ...string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func wantJSON(t *testing.T, rec *httptest.ResponseRecorder, status int, body string) {
	t.Helper()
	if rec.Code != status {
		t.Errorf("status = %d, want %d (body %s)", rec.Code, status, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", ct)
	}
	var got, want any
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("body %q is not JSON: %v", rec.Body.String(), err)
	}
	if err := json.Unmarshal([]byte(body), &want); err != nil {
		t.Fatal(err)
	}
	g, _ := json.Marshal(got)
	w, _ := json.Marshal(want)
	if !bytes.Equal(g, w) {
		t.Errorf("body = %s, want %s", g, w)
	}
}

const (
	readyBody       = `{"status":"ready","checks":{"postgres":"ok","schema":"ok","audit_partitions":"unknown"}}`
	unreachableBody = `{"status":"not_ready","checks":{"postgres":"unreachable","schema":"unknown","audit_partitions":"unknown"}}`
)

func TestNotFoundEnvelope(t *testing.T) {
	h, _ := newHandler(&fakeProbe{version: 1})
	for _, p := range []string{"/api/nope", "/nope"} {
		wantJSON(t, do(h, http.MethodGet, p), 404, `{"error":{"code":"not_found","message":"not found"}}`)
	}
}

func TestReadyz(t *testing.T) {
	cases := []struct {
		name   string
		probe  *fakeProbe
		status int
		body   string
	}{
		{"ok", &fakeProbe{version: 1}, 200, readyBody},
		{"ping error", &fakeProbe{ping: func(context.Context) error { return errors.New("down") }}, 503, unreachableBody},
		{"behind", &fakeProbe{version: 0}, 503, `{"status":"not_ready","checks":{"postgres":"ok","schema":"behind","audit_partitions":"unknown"}}`},
		{"ahead", &fakeProbe{version: 3}, 503, `{"status":"not_ready","checks":{"postgres":"ok","schema":"ahead","audit_partitions":"unknown"}}`},
		{"n+1", &fakeProbe{version: 2}, 200, readyBody},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, _ := newHandler(tc.probe)
			wantJSON(t, do(h, http.MethodGet, "/readyz"), tc.status, tc.body)
		})
	}
}

func blockUntilDone(ctx context.Context) error {
	<-ctx.Done()
	return ctx.Err()
}

func TestReadyzTimeout(t *testing.T) {
	h, _ := newHandler(&fakeProbe{ping: blockUntilDone})
	start := time.Now()
	rec := do(h, http.MethodGet, "/readyz")
	elapsed := time.Since(start)
	wantJSON(t, rec, 503, unreachableBody)
	if elapsed >= 2*time.Second {
		t.Errorf("elapsed %v, want < 2s", elapsed)
	}
}

func warnRecords(t *testing.T, logs *syncBuffer, check string) int {
	n := 0
	for _, r := range logs.records(t) {
		if r["level"] == "WARN" && r["msg"] == "readyz" && r["check"] == check {
			n++
		}
	}
	return n
}

func TestReadyzSchemaError(t *testing.T) {
	h, logs := newHandler(&fakeProbe{schema: func(context.Context) (int64, error) { return 0, errors.New("boom") }})
	wantJSON(t, do(h, http.MethodGet, "/readyz"), 503, `{"status":"not_ready","checks":{"postgres":"ok","schema":"error","audit_partitions":"unknown"}}`)
	if n := warnRecords(t, logs, "schema"); n != 1 {
		t.Errorf("%d warn records with check=schema, want 1", n)
	}
}

func TestReadyzSchemaTimeout(t *testing.T) {
	h, logs := newHandler(&fakeProbe{schema: func(ctx context.Context) (int64, error) { return 0, blockUntilDone(ctx) }})
	start := time.Now()
	rec := do(h, http.MethodGet, "/readyz")
	elapsed := time.Since(start)
	wantJSON(t, rec, 503, `{"status":"not_ready","checks":{"postgres":"ok","schema":"timeout","audit_partitions":"unknown"}}`)
	if elapsed < time.Second || elapsed >= 2*time.Second {
		t.Errorf("elapsed %v, want >= 1s and < 2s", elapsed)
	}
	if n := warnRecords(t, logs, "schema"); n != 1 {
		t.Errorf("%d warn records with check=schema, want 1", n)
	}
}

func TestHealthStartup(t *testing.T) {
	p := &fakeProbe{version: 1}
	h, _ := newHandler(p)
	for _, path := range []string{"/healthz", "/startupz"} {
		wantJSON(t, do(h, http.MethodGet, path), 200, `{"status":"ok"}`)
	}
	if p.calls != 0 {
		t.Errorf("probe called %d times, want 0", p.calls)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	h, _ := newHandler(&fakeProbe{version: 1})
	wantJSON(t, do(h, http.MethodPost, "/healthz"), 405, `{"error":{"code":"invalid","message":"method not allowed"}}`)
}

func TestPanicEnvelope(t *testing.T) {
	h, logs := newHandler(&fakeProbe{ping: func(context.Context) error { panic("kaboom") }})
	wantJSON(t, do(h, http.MethodGet, "/readyz"), 500, `{"error":{"code":"internal","message":"internal error"}}`)
	found := false
	for _, r := range logs.records(t) {
		if r["level"] == "ERROR" {
			found = true
		}
	}
	if !found {
		t.Error("no log record at error level")
	}
}

func TestCommonHeaders(t *testing.T) {
	h, _ := newHandler(&fakeProbe{version: 1})
	check := func(rec *httptest.ResponseRecorder) {
		t.Helper()
		if v := rec.Header().Get("Cache-Control"); v != "no-store" {
			t.Errorf("Cache-Control = %q, want no-store", v)
		}
		if v := rec.Header().Get("X-Content-Type-Options"); v != "nosniff" {
			t.Errorf("X-Content-Type-Options = %q, want nosniff", v)
		}
	}
	rec := do(h, http.MethodGet, "/healthz", "X-Request-Id", "abc-1")
	check(rec)
	if v := rec.Header().Get("X-Request-Id"); v != "abc-1" {
		t.Errorf("X-Request-Id = %q, want abc-1 (echoed)", v)
	}
	for _, hdr := range [][]string{nil, {"X-Request-Id", "<script>"}} {
		rec := do(h, http.MethodGet, "/healthz", hdr...)
		check(rec)
		id, err := uuid.Parse(rec.Header().Get("X-Request-Id"))
		if err != nil || id.Version() != 7 {
			t.Errorf("X-Request-Id = %q, want a new UUIDv7", rec.Header().Get("X-Request-Id"))
		}
	}
}

// R8: the access-log wrapper lets ResponseController reach the connection.
func TestStatusWriterUnwrap(t *testing.T) {
	got := make(chan error, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		got <- http.NewResponseController(&statusWriter{ResponseWriter: w}).SetReadDeadline(time.Now().Add(time.Second))
	}))
	defer srv.Close()
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if err := <-got; err != nil {
		t.Errorf("SetReadDeadline through statusWriter = %v, want nil", err)
	}
}

type fixedCheck string

func (c fixedCheck) Check() string { return string(c) }

func TestReadyzAuditPartitions(t *testing.T) {
	for _, state := range []string{"ok", "low", "unknown"} {
		h := New(Deps{Probe: &fakeProbe{version: 1}, SchemaLatest: 1, AuditPartitions: fixedCheck(state)})
		wantJSON(t, do(h, http.MethodGet, "/readyz"), 200,
			`{"status":"ready","checks":{"postgres":"ok","schema":"ok","audit_partitions":"`+state+`"}}`)
	}
	h := New(Deps{Probe: &fakeProbe{version: 1}, SchemaLatest: 1, AuditPartitions: fixedCheck("error")})
	wantJSON(t, do(h, http.MethodGet, "/readyz"), 503, `{"status":"not_ready","checks":{"postgres":"ok","schema":"ok","audit_partitions":"error"}}`)
	h = New(Deps{Probe: &fakeProbe{ping: func(context.Context) error { return errors.New("down") }}, SchemaLatest: 1, AuditPartitions: fixedCheck("ok")})
	wantJSON(t, do(h, http.MethodGet, "/readyz"), 503, `{"status":"not_ready","checks":{"postgres":"unreachable","schema":"unknown","audit_partitions":"ok"}}`)
}
