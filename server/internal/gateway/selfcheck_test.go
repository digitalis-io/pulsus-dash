package gateway

import (
	"context"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// selfCheckClient is the client serve passes to SelfCheck (plan #59 §3.9).
func selfCheckClient() *http.Client {
	return &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

// target is an httptest server that records its requests.
type target struct {
	*httptest.Server
	mu       sync.Mutex
	requests []*http.Request
}

func newTarget(t *testing.T, h http.HandlerFunc) *target {
	t.Helper()
	tg := &target{}
	tg.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tg.mu.Lock()
		tg.requests = append(tg.requests, r.Clone(context.Background()))
		tg.mu.Unlock()
		h(w, r)
	}))
	t.Cleanup(tg.Close)
	return tg
}

func (tg *target) reqs() []*http.Request {
	tg.mu.Lock()
	defer tg.mu.Unlock()
	return append([]*http.Request(nil), tg.requests...)
}

func documentHeadersHandler(skip string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		for _, h := range wantDocumentHeaders {
			if h[0] != skip {
				w.Header().Set(h[0], h[1])
			}
		}
		_, _ = w.Write([]byte("<!doctype html>"))
	}
}

// selfCheck runs SelfCheck and returns its log records.
func selfCheck(t *testing.T, url string, assets bool) []map[string]any {
	t.Helper()
	logs := &syncBuffer{}
	SelfCheck(context.Background(), url, assets, selfCheckClient(), slog.New(slog.NewJSONHandler(logs, nil)))
	if strings.Contains(logs.buf.String(), strings.TrimPrefix(url, "http://")) {
		t.Errorf("a record contains the URL: %s", logs.buf.String())
	}
	return logs.records(t)
}

func wantRecord(t *testing.T, recs []map[string]any, level, result string, attrs ...string) {
	t.Helper()
	if len(recs) != 1 {
		t.Fatalf("%d records, want 1: %v", len(recs), recs)
	}
	r := recs[0]
	if r["level"] != level || r["msg"] != "public_url_self_check" || r["result"] != result {
		t.Errorf("record = %v, want %s msg=public_url_self_check result=%s", r, level, result)
	}
	for i := 0; i+1 < len(attrs); i += 2 {
		if got := r[attrs[i]]; got != attrs[i+1] && got != toFloat(attrs[i+1]) {
			t.Errorf("%s = %v, want %s", attrs[i], got, attrs[i+1])
		}
	}
}

func toFloat(s string) any {
	var f float64
	for _, c := range s {
		if c < '0' || c > '9' {
			return nil
		}
		f = f*10 + float64(c-'0')
	}
	return f
}

// SC1
func TestSelfCheckOK(t *testing.T) {
	tg := newTarget(t, documentHeadersHandler(""))
	wantRecord(t, selfCheck(t, tg.URL, true), "INFO", "ok")
	reqs := tg.reqs()
	if len(reqs) != 1 || reqs[0].URL.Path != "/" || reqs[0].Header.Get("Accept") != "text/html" {
		t.Errorf("requests = %v, want exactly one GET / with Accept: text/html", reqs)
	}
}

// SC2
func TestSelfCheckHeadersStripped(t *testing.T) {
	tg := newTarget(t, documentHeadersHandler("Cross-Origin-Opener-Policy"))
	wantRecord(t, selfCheck(t, tg.URL, true), "WARN", "headers_stripped", "header", "Cross-Origin-Opener-Policy")
}

// SC3
func TestSelfCheckUnreachableAndStatus(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed := "http://" + ln.Addr().String()
	_ = ln.Close()
	wantRecord(t, selfCheck(t, closed, true), "WARN", "unreachable")

	hang := newTarget(t, func(_ http.ResponseWriter, r *http.Request) { <-r.Context().Done() })
	start := time.Now()
	wantRecord(t, selfCheck(t, hang.URL, true), "WARN", "unreachable")
	if d := time.Since(start); d > 2500*time.Millisecond {
		t.Errorf("hanging target took %v, want <= 2.5s", d)
	}

	bad := newTarget(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusBadGateway) })
	wantRecord(t, selfCheck(t, bad.URL, true), "WARN", "status", "status", "502")

	health := newTarget(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	wantRecord(t, selfCheck(t, health.URL, false), "INFO", "ok")
	if reqs := health.reqs(); len(reqs) != 1 || reqs[0].URL.Path != "/healthz" {
		t.Errorf("API-only requests = %v, want one GET /healthz", reqs)
	}
}
