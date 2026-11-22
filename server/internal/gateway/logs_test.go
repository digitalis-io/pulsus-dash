package gateway

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake/fakeharness"
)

// unit:logs-completion (plan #65 Part B §3.2): the three GET routes over Part A's completion calls.
func TestLogsCompletion(t *testing.T) {
	fake, url := fakeharness.Start(t)
	h, _ := queryGateway(t, url, pulsusdb.Options{})

	rec := do(h, http.MethodGet, "/api/dash/v1/logs/labels?tenant=demo"+window)
	m := decodeMap(t, rec)
	if rec.Code != 200 || fmt.Sprint(m["values"]) != "[app detected_level pod]" || m["completeness"].(map[string]any)["query_id"] != "fake-logs-labels-1" {
		t.Errorf("labels: %d %s", rec.Code, rec.Body.String())
	}
	r := fake.Requests()
	if len(r) != 1 || r[0].Method != http.MethodGet || r[0].Path != "/api/logs/v1/labels" || r[0].Form.Get("start") != logLo || r[0].Form.Get("end") != logHi {
		t.Errorf("labels upstream request %+v", r)
	}
	if len(r) == 1 && r[0].Form.Has("query") {
		t.Errorf("labels without query sent query %q", r[0].Form["query"])
	}

	fake.Reset()
	rec = do(h, http.MethodGet, "/api/dash/v1/logs/label/pod/values?tenant=demo"+window+"&query=%7Bapp%3D%22x%22%7D")
	m = decodeMap(t, rec)
	if rec.Code != 200 || fmt.Sprint(m["values"]) != "[a b c]" {
		t.Errorf("label values: %d %s", rec.Code, rec.Body.String())
	}
	if r := fake.Requests(); len(r) != 1 || r[0].Path != "/api/logs/v1/label/pod/values" || r[0].Form.Get("query") != `{app="x"}` {
		t.Errorf("label values upstream %+v", r)
	}

	fake.Reset()
	rec = do(h, http.MethodGet, "/api/dash/v1/logs/series?tenant=demo"+window+"&match=%7Bapp%3D%22x%22%7D")
	m = decodeMap(t, rec)
	series, _ := m["series"].([]any)
	keyOf := func(pod string) string {
		return keyhash.Hex(keyhash.Labels([]keyhash.Label{{Name: "app", Value: "x"}, {Name: "pod", Value: pod}}))
	}
	if rec.Code != 200 || len(series) != 2 || series[0].(map[string]any)["key"] != keyOf("a") || series[1].(map[string]any)["key"] != keyOf("b") {
		t.Errorf("series: %d %s", rec.Code, rec.Body.String())
	}
	if r := fake.Requests(); len(r) != 1 || r[0].Path != "/api/logs/v1/series" || r[0].Form.Get("match[]") != `{app="x"}` {
		t.Errorf("series upstream %+v", r)
	}

	rec = do(h, http.MethodGet, "/api/dash/v1/logs/labels?tenant=demo"+window+"&limit=1")
	m = decodeMap(t, rec)
	if v, _ := m["values"].([]any); rec.Code != 200 || len(v) != 1 || m["completeness"].(map[string]any)["truncated"] != true {
		t.Errorf("limit 1: %d %s", rec.Code, rec.Body.String())
	}

	fake.Reset()
	for _, c := range []struct{ name, path, pointer, key string }{
		{"no tenant", "/api/dash/v1/logs/labels?" + window[1:], "", "tenant.invalid"},
		{"from missing", "/api/dash/v1/logs/labels?tenant=demo&to=2", "/from", "field.required"},
		{"from = to", "/api/dash/v1/logs/labels?tenant=demo&from=2&to=2", "/to", "field.range"},
		{"limit 0", "/api/dash/v1/logs/labels?tenant=demo" + window + "&limit=0", "/limit", "field.range"},
		{"limit 10001", "/api/dash/v1/logs/label/pod/values?tenant=demo" + window + "&limit=10001", "/limit", "field.range"},
		{"long query", "/api/dash/v1/logs/labels?tenant=demo" + window + "&query=" + strings.Repeat("a", 65537), "/query", "field.range"},
		{"long name", "/api/dash/v1/logs/label/" + strings.Repeat("n", 257) + "/values?tenant=demo" + window, "/name", "field.range"},
		{"series without match", "/api/dash/v1/logs/series?tenant=demo" + window, "/match", "field.required"},
		{"series long match", "/api/dash/v1/logs/series?tenant=demo" + window + "&match=" + strings.Repeat("a", 65537), "/match/0", "field.range"},
	} {
		wantError(t, c.name, do(h, http.MethodGet, c.path), 400, "invalid", c.pointer, c.key)
	}
	if n := len(fake.Requests()); n != 0 {
		t.Errorf("%d upstream requests for invalid parameters", n)
	}
	wantError(t, "unknown tenant", do(h, http.MethodGet, "/api/dash/v1/logs/labels?tenant=nope"+window), 404, "not_found", "-", "")
}

// A busy tenant answers the GET routes 429 with Retry-After; an upstream error is the default
// response with the #62 status.
func TestLogsCompletionErrors(t *testing.T) {
	_, url := fakeharness.Start(t)
	h, _ := queryGateway(t, url, pulsusdb.Options{TenantConcurrency: 1})
	srv := httptest.NewServer(h)
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+logRangePath, strings.NewReader(logBody(`{app="hang"}`, "")))
	go func() {
		if resp, err := http.DefaultClient.Do(req); err == nil {
			_ = resp.Body.Close()
		}
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		rec := do(h, http.MethodGet, "/api/dash/v1/logs/labels?tenant=demo"+window)
		if rec.Code == 429 {
			wantError(t, "busy", rec, 429, "budget_exhausted", "-", "")
			if rec.Header().Get("Retry-After") != "1" {
				t.Errorf("Retry-After %q, want 1", rec.Header().Get("Retry-After"))
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("never busy: last %d %s", rec.Code, rec.Body.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()

	up := newLogUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("overloaded"))
	})
	h2, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	for _, path := range []string{"/api/dash/v1/logs/labels?tenant=demo" + window, "/api/dash/v1/logs/label/pod/values?tenant=demo" + window,
		"/api/dash/v1/logs/series?tenant=demo" + window + "&match=%7Bapp%3D%22x%22%7D"} {
		e := wantError(t, path, do(h2, http.MethodGet, path), 502, "unavailable", "-", "")
		if e.Error.Hint["reason"] != "upstream_unavailable" {
			t.Errorf("%s: hint %v", path, e.Error.Hint)
		}
	}
}
