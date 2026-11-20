package gateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// unit:deadlines (T06-010, review r1 #3): every route is bounded by its deadline, and the tenant
// slot is released afterwards.
func TestDeadlines(t *testing.T) {
	stop := make(chan struct{})
	defer close(stop)
	// Like PulsusDB, the stalls read the form first: net/http notices a client that went away
	// only once the request body was read.
	block := func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		select {
		case <-r.Context().Done():
		case <-stop:
		}
	}
	noHeaders := httptest.NewServer(http.HandlerFunc(block))
	defer noHeaders.Close()
	midBody := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		data := `[` // labels: an array; metadata: an object
		if r.URL.Path == "/api/v1/metadata" {
			data = `{`
		}
		_, _ = io.WriteString(w, `{"status":"success","data":`+data)
		http.NewResponseController(w).Flush()
		block(w, r)
	}))
	defer midBody.Close()
	opts := pulsusdb.Options{TenantConcurrency: 1, Timeouts: pulsusdb.Timeouts{Metadata: 200 * time.Millisecond, Check: 200 * time.Millisecond}}

	type call struct {
		name string
		do   func(h http.Handler) *httptest.ResponseRecorder
	}
	get := func(path string) func(h http.Handler) *httptest.ResponseRecorder {
		return func(h http.Handler) *httptest.ResponseRecorder { return do(h, http.MethodGet, path) }
	}
	calls := []call{
		{"range", func(h http.Handler) *httptest.ResponseRecorder {
			return postJSON(h, rangePath, `{"query":"up","from":1767225600000,"to":1767229200000,"width_px":1200,"timeout_ms":300}`)
		}},
		{"instant", func(h http.Handler) *httptest.ResponseRecorder {
			return postJSON(h, instantPath, `{"query":"up","at":1767229200000,"timeout_ms":300}`)
		}},
		{"labels", get("/api/dash/v1/prom/labels?tenant=demo" + window)},
		{"label values", get("/api/dash/v1/prom/label/job/values?tenant=demo" + window)},
		{"series", get("/api/dash/v1/prom/series?tenant=demo" + window + "&match=up")},
		{"metadata", get("/api/dash/v1/prom/metadata?tenant=demo")},
	}
	h, _ := queryGateway(t, noHeaders.URL, opts)
	for _, c := range calls {
		start := time.Now()
		rec := c.do(h)
		e := wantError(t, "headers never sent: "+c.name, rec, 504, "unavailable", "-", "")
		if e.Error.Hint["reason"] != "upstream_timeout" || time.Since(start) > time.Second {
			t.Errorf("%s: hint %v after %v", c.name, e.Error.Hint, time.Since(start))
		}
	}
	start := time.Now()
	rec := do(h, http.MethodGet, "/api/dash/v1/datasource/check?tenant=demo")
	if rec.Code != 200 || decodeMap(t, rec)["state"] != "unreachable" || time.Since(start) > time.Second {
		t.Errorf("check: %d %s after %v", rec.Code, rec.Body.String(), time.Since(start))
	}

	h, _ = queryGateway(t, midBody.URL, opts)
	for _, c := range []call{calls[2], calls[5], calls[2]} {
		start := time.Now()
		rec := c.do(h)
		wantError(t, "stalled body: "+c.name, rec, 504, "unavailable", "-", "")
		if time.Since(start) > time.Second {
			t.Errorf("%s took %v", c.name, time.Since(start))
		}
	}
}
