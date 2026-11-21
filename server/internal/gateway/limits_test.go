package gateway

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// unit:body-limits (§3.3 limits): every limit and its error.
func TestBodyLimits(t *testing.T) {
	series := func(i int) string {
		return fmt.Sprintf(`{"metric":{"i":"%03d"},"values":[[1767225600,"1"]]}`, i)
	}
	var bigRange strings.Builder
	bigRange.WriteString(`{"status":"success","data":{"resultType":"matrix","result":[`)
	for i := 0; bigRange.Len() < 4096; i++ {
		if i > 0 {
			bigRange.WriteString(",")
		}
		bigRange.WriteString(series(i))
	}
	bigRange.WriteString(`]}}`)
	var bigInstant strings.Builder
	bigInstant.WriteString(`{"status":"success","data":{"resultType":"vector","result":[`)
	for i := 0; bigInstant.Len() < 4096; i++ {
		if i > 0 {
			bigInstant.WriteString(",")
		}
		fmt.Fprintf(&bigInstant, `{"metric":{"i":"%03d"},"value":[1767225600,"1"]}`, i)
	}
	bigInstant.WriteString(`]}}`)
	bodies := map[string]struct {
		status int
		body   string
	}{
		"/api/v1/query_range":      {200, bigRange.String()},
		"/api/v1/query":            {200, bigInstant.String()},
		"/api/v1/labels":           {200, `{"status":"success","data":["` + strings.Repeat("a", 1024) + `"]}`},
		"/api/v1/label/job/values": {200, `{"status":"success","data":["a","b","c","d"]}`},
		"/api/v1/series":           {400, `{"status":"error","errorType":"bad_data","error":"` + strings.Repeat("e", 1024) + `"}`},
	}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b := bodies[r.URL.Path]
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(b.status)
		_, _ = io.WriteString(w, b.body)
	}))
	defer up.Close()
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{Limits: pulsusdb.Limits{DataBody: 2048, MetaBody: 512, ErrorBody: 256,
		MaxPoints: 5000000, MaxValues: 3, TextBytes: 1024, MaxMessages: 20}})
	srv := httptest.NewServer(h)
	defer srv.Close()

	resp, err := http.Post(srv.URL+rangePath, "application/json", strings.NewReader(`{"query":"up","from":1767225600000,"to":1767229200000,"width_px":1200}`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != 200 || err == nil || !strings.Contains(string(b), `"frames":[{"key":`) {
		t.Errorf("range over DataBody: %d, read err %v, body %.200q; want the first frame then a reset", resp.StatusCode, err, b)
	}

	check := func(name string, rec *httptest.ResponseRecorder) {
		t.Helper()
		e := wantError(t, name, rec, 502, "unavailable", "-", "")
		if e.Error.Hint["reason"] != "upstream_error" {
			t.Errorf("%s: hint %v, want upstream_error", name, e.Error.Hint)
		}
	}
	check("instant over DataBody", postJSON(h, instantPath, `{"query":"up","at":1767229200000}`))
	check("labels over MetaBody", do(h, http.MethodGet, "/api/dash/v1/prom/labels?tenant=demo"+window))
	check("400 over ErrorBody", do(h, http.MethodGet, "/api/dash/v1/prom/series?tenant=demo"+window+"&match=up"))

	rec := do(h, http.MethodGet, "/api/dash/v1/prom/label/job/values?tenant=demo"+window)
	m := decodeMap(t, rec)
	if v, _ := m["values"].([]any); rec.Code != 200 || len(v) != 3 || m["completeness"].(map[string]any)["truncated"] != true {
		t.Errorf("MaxValues 3: %d %s", rec.Code, rec.Body.String())
	}
	e := wantError(t, "request body", postJSON(h, rangePath, `{"query":"`+strings.Repeat("a", 2<<20)+`"}`), 413, "invalid", "-", "")
	if e.Error.Message != "body too large" {
		t.Errorf("413 message %q", e.Error.Message)
	}
}
