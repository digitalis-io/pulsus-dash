package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake/fakeharness"
)

const window = "&from=1767225600000&to=1767229200000"

func decodeMap(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("body %q: %v", rec.Body.String(), err)
	}
	return m
}

// unit:prom-routes (T06-005, T06-008).
func TestPromRoutes(t *testing.T) {
	fake, url := fakeharness.Start(t)
	h, _ := queryGateway(t, url, pulsusdb.Options{})

	rec := do(h, http.MethodGet, "/api/dash/v1/prom/labels?tenant=demo"+window+"&match=up")
	m := decodeMap(t, rec)
	if rec.Code != 200 || fmt.Sprint(m["values"]) != "[__name__ instance job]" || m["completeness"].(map[string]any)["query_id"] != "fake-labels-1" {
		t.Errorf("labels: %d %s", rec.Code, rec.Body.String())
	}
	r := fake.Requests()
	if len(r) != 1 || r[0].Path != "/api/v1/labels" || !slices.Equal(r[0].Form["match[]"], []string{"up"}) ||
		r[0].Form.Get("start") != "1767225600" || r[0].Form.Get("end") != "1767229200" || r[0].Form.Get("limit") != "1000" {
		t.Errorf("labels upstream request %+v", r)
	}

	fake.Reset()
	rec = do(h, http.MethodGet, "/api/dash/v1/prom/label/job/values?tenant=demo"+window)
	m = decodeMap(t, rec)
	if rec.Code != 200 || fmt.Sprint(m["values"]) != "[api db]" || m["completeness"].(map[string]any)["truncated"] != true {
		t.Errorf("label values: %d %s", rec.Code, rec.Body.String())
	}
	if r := fake.Requests(); len(r) != 1 || r[0].Path != "/api/v1/label/job/values" {
		t.Errorf("label values upstream %+v", r)
	}

	rec = do(h, http.MethodGet, "/api/dash/v1/prom/series?tenant=demo"+window+"&match=up")
	m = decodeMap(t, rec)
	series, _ := m["series"].([]any)
	wantKey := keyhash.Hex(keyhash.Labels([]keyhash.Label{{Name: "__name__", Value: "up"}, {Name: "job", Value: "api"}}))
	if rec.Code != 200 || len(series) != 1 || series[0].(map[string]any)["key"] != wantKey {
		t.Errorf("series: %d %s, want key %s", rec.Code, rec.Body.String(), wantKey)
	}

	fake.Reset()
	rec = do(h, http.MethodGet, "/api/dash/v1/prom/metadata?tenant=demo")
	m = decodeMap(t, rec)
	if rec.Code != 200 || m["metrics"].(map[string]any)["up"].([]any)[0].(map[string]any)["type"] != "gauge" {
		t.Errorf("metadata: %d %s", rec.Code, rec.Body.String())
	}
	if r := fake.Requests(); len(r) != 1 || r[0].Form.Get("limit") != "1000" {
		t.Errorf("metadata upstream %+v", r)
	}

	wantError(t, "from >= to", do(h, http.MethodGet, "/api/dash/v1/prom/labels?tenant=demo&from=2&to=1"), 400, "invalid", "/to", "field.range")
	wantError(t, "series without match", do(h, http.MethodGet, "/api/dash/v1/prom/series?tenant=demo"+window), 400, "invalid", "/match", "field.required")
	wantError(t, "unknown tenant", do(h, http.MethodGet, "/api/dash/v1/prom/labels?tenant=nope"+window), 404, "not_found", "-", "")
}

func TestPromValuesCut(t *testing.T) {
	vals := make([]string, 10001)
	for i := range vals {
		vals[i] = fmt.Sprintf("v%05d", i)
	}
	b, _ := json.Marshal(vals)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":` + string(b) + `}`))
	}))
	defer up.Close()
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	rec := do(h, http.MethodGet, "/api/dash/v1/prom/labels?tenant=demo"+window+"&limit=10000")
	m := decodeMap(t, rec)
	if v, _ := m["values"].([]any); rec.Code != 200 || len(v) != 10000 || m["completeness"].(map[string]any)["truncated"] != true {
		t.Errorf("%d: %d values, completeness %v", rec.Code, len(v), m["completeness"])
	}
}

func TestPromBusy(t *testing.T) {
	_, url := fakeharness.Start(t)
	h, _ := queryGateway(t, url, pulsusdb.Options{TenantConcurrency: 1})
	srv := httptest.NewServer(h)
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+rangePath,
		strings.NewReader(`{"query":"sum(hang_total)","from":1767225600000,"to":1767229200000,"width_px":1200}`))
	go func() {
		if resp, err := http.DefaultClient.Do(req); err == nil {
			_ = resp.Body.Close()
		}
	}()
	deadline := time.Now().Add(3 * time.Second)
	for {
		rec := do(h, http.MethodGet, "/api/dash/v1/prom/labels?tenant=demo"+window)
		if rec.Code == 429 {
			wantError(t, "busy", rec, 429, "budget_exhausted", "-", "")
			if rec.Header().Get("Retry-After") != "1" {
				t.Errorf("Retry-After %q, want 1", rec.Header().Get("Retry-After"))
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("never busy: last %d %s", rec.Code, rec.Body.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// unit:body-validation (T06-021, plan §3.4).
func TestBodyValidation(t *testing.T) {
	fake, url := fakeharness.Start(t)
	h, _ := queryGateway(t, url, pulsusdb.Options{})
	const ok = `"query":"up","from":1767225600000,"to":1767229200000,"width_px":1200`
	for _, c := range []struct {
		name, path, body string
		pointer, key     string
	}{
		{"not json", rangePath, `nope`, "", "body.invalid"},
		{"not an object", rangePath, `[]`, "", "body.invalid"},
		{"null", rangePath, `null`, "", "body.invalid"},
		{"trailing data", rangePath, `{` + ok + `} {}`, "", "body.invalid"},
		{"unknown field", rangePath, `{` + ok + `,"x":1}`, "/x", "field.unknown"},
		{"missing query", rangePath, `{"from":1,"to":2,"width_px":3}`, "/query", "field.required"},
		{"missing from", rangePath, `{"query":"up","to":2,"width_px":3}`, "/from", "field.required"},
		{"missing to", rangePath, `{"query":"up","from":1,"width_px":3}`, "/to", "field.required"},
		{"missing width", rangePath, `{"query":"up","from":1,"to":2}`, "/width_px", "field.required"},
		{"query type", rangePath, `{"query":1,"from":1,"to":2,"width_px":3}`, "/query", "field.type"},
		{"from not integer", rangePath, `{"query":"up","from":1.5,"to":2,"width_px":3}`, "/from", "field.type"},
		{"width string", rangePath, `{"query":"up","from":1,"to":2,"width_px":"3"}`, "/width_px", "field.type"},
		{"from negative", rangePath, `{"query":"up","from":-1,"to":2,"width_px":3}`, "/from", "field.range"},
		{"to too large", rangePath, `{"query":"up","from":1,"to":253402300800000,"width_px":3}`, "/to", "field.range"},
		{"width 0", rangePath, `{"query":"up","from":1,"to":2,"width_px":0}`, "/width_px", "field.range"},
		{"width 10001", rangePath, `{"query":"up","from":1,"to":2,"width_px":10001}`, "/width_px", "field.range"},
		{"from = to", rangePath, `{"query":"up","from":2,"to":2,"width_px":3}`, "/to", "field.range"},
		{"empty query", rangePath, `{"query":"","from":1,"to":2,"width_px":3}`, "/query", "field.range"},
		{"long query", rangePath, `{"query":"` + strings.Repeat("a", 65537) + `","from":1,"to":2,"width_px":3}`, "/query", "field.range"},
		{"query not utf-8", rangePath, "{\"query\":\"a\xffb\",\"from\":1,\"to\":2,\"width_px\":3}", "/query", "field.range"},
		{"timeout 199", rangePath, `{` + ok + `,"timeout_ms":199}`, "/timeout_ms", "field.range"},
		{"timeout 120001", rangePath, `{` + ok + `,"timeout_ms":120001}`, "/timeout_ms", "field.range"},
		{"timeout 0", rangePath, `{` + ok + `,"timeout_ms":0}`, "/timeout_ms", "field.range"},
		{"timeout negative", rangePath, `{` + ok + `,"timeout_ms":-5}`, "/timeout_ms", "field.range"},
		{"range too long", rangePath, `{"query":"up","from":0,"to":1262304000000,"width_px":1}`, "/from", "range.too_long"},
		{"no tenant", "/api/dash/v1/query/promql/range", `{` + ok + `}`, "", "tenant.invalid"},
		{"bad tenant", "/api/dash/v1/query/promql/range?tenant=BAD", `{` + ok + `}`, "", "tenant.invalid"},
		{"instant missing at", instantPath, `{"query":"up"}`, "/at", "field.required"},
		{"instant unknown", instantPath, `{"query":"up","at":1,"from":1}`, "/from", "field.unknown"},
		{"instant at range", instantPath, `{"query":"up","at":-1}`, "/at", "field.range"},
		{"instant timeout", instantPath, `{"query":"up","at":1,"timeout_ms":100}`, "/timeout_ms", "field.range"},
	} {
		e := wantError(t, c.name, postJSON(h, c.path, c.body), 400, "invalid", c.pointer, c.key)
		if c.key == "tenant.invalid" && e.Error.Message != "tenant is required" {
			t.Errorf("%s: message %q", c.name, e.Error.Message)
		}
	}
	big := `{"query":"` + strings.Repeat("a", 2<<20) + `"}`
	e := wantError(t, "2 MiB + 1", postJSON(h, rangePath, big), 413, "invalid", "-", "")
	if e.Error.Message != "body too large" {
		t.Errorf("413 message %q", e.Error.Message)
	}
	for _, c := range []struct{ name, path, pointer, key string }{
		{"labels no tenant", "/api/dash/v1/prom/labels?" + window[1:], "", "tenant.invalid"},
		{"labels from missing", "/api/dash/v1/prom/labels?tenant=demo&to=2", "/from", "field.required"},
		{"labels from type", "/api/dash/v1/prom/labels?tenant=demo&from=x&to=2", "/from", "field.type"},
		{"labels limit 0", "/api/dash/v1/prom/labels?tenant=demo" + window + "&limit=0", "/limit", "field.range"},
		{"labels limit 10001", "/api/dash/v1/prom/labels?tenant=demo" + window + "&limit=10001", "/limit", "field.range"},
		{"labels long match", "/api/dash/v1/prom/labels?tenant=demo" + window + "&match=" + strings.Repeat("a", 65537), "/match/0", "field.range"},
		{"long name", "/api/dash/v1/prom/label/" + strings.Repeat("n", 257) + "/values?tenant=demo" + window, "/name", "field.range"},
		{"metadata limit", "/api/dash/v1/prom/metadata?tenant=demo&limit=0", "/limit", "field.range"},
		{"check no tenant", "/api/dash/v1/datasource/check", "", "tenant.invalid"},
	} {
		wantError(t, c.name, do(h, http.MethodGet, c.path), 400, "invalid", c.pointer, c.key)
	}
	if n := len(fake.Requests()); n != 0 {
		t.Errorf("%d upstream requests for invalid input", n)
	}
}
