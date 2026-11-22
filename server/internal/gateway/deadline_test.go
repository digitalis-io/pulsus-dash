package gateway

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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
		_ = http.NewResponseController(w).Flush()
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

	// The log GET routes (plan #65 Part B): the metadata deadline, and the slot freed after it.
	logGets := []call{
		{"labels", get("/api/dash/v1/logs/labels?tenant=demo" + window)},
		{"label values", get("/api/dash/v1/logs/label/pod/values?tenant=demo" + window)},
		{"series", get("/api/dash/v1/logs/series?tenant=demo" + window + "&match=%7Bapp%3D%22x%22%7D")},
	}
	t.Run("logs_get", func(t *testing.T) {
		for _, url := range []string{noHeaders.URL, midBody.URL} {
			h, _ := queryGateway(t, url, opts)
			for _, c := range logGets {
				t.Run(c.name, func(t *testing.T) {
					for i := range 2 { // the repeat is not 429: the slot was freed
						start := time.Now()
						e := wantError(t, c.name, c.do(h), 504, "unavailable", "-", "")
						if e.Error.Hint["reason"] != "upstream_timeout" || time.Since(start) > time.Second {
							t.Errorf("call %d: hint %v after %v", i, e.Error.Hint, time.Since(start))
						}
					}
				})
			}
		}
	})
	t.Run("logql_range", func(t *testing.T) { logDeadlines(t, false) })
	t.Run("logql_volume", func(t *testing.T) { logDeadlines(t, true) })
}

// stallUpstream is the scripted upstream of unit:deadlines (B.4) for the log POST routes: it
// dispatches on the query, and every stall waits for the request's context or a 2 s timer, so a
// regression fails the elapsed bound instead of hanging.
func stallUpstream(t *testing.T) *logUpstream {
	stall := func(r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	}
	return newLogUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.Form.Get("query")
		volume := strings.HasPrefix(q, "sum by (level, detected_level)")
		flushJSON := func(s string) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, s)
			_ = http.NewResponseController(w).Flush()
		}
		switch {
		case strings.Contains(q, `{app="nohdr"}`):
			stall(r)
		case strings.Contains(q, `{app="midpage"}`):
			flushJSON(`{"status":"success","data":{"resultType":"streams","result":[{"stream":{"app":"midpage","pod":"a"},"values":[["1767229200000000000","x"]]}`)
			stall(r)
		case strings.Contains(q, `{app="second"}`) && r.Form.Get("limit") == "5000":
			stall(r)
		case strings.Contains(q, `{app="second"}`):
			writeJSONBody(w, `{"status":"success","data":{"resultType":"streams","result":[{"stream":{"pod":"a"},"values":[["1767229100000000300","x"]]},{"stream":{"pod":"b"},"values":[["1767229100000000300","y"]]}]}}`)
		case strings.Contains(q, `{app="midvol"}`):
			flushJSON(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"detected_level":"info"},"values":[[1767225600,"3"]]},`)
			stall(r)
		case strings.Contains(q, `{app="ok"}`) && volume:
			writeJSONBody(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"detected_level":"info"},"values":[[1767225600,"1"]]}]}}`)
		case strings.Contains(q, `{app="ok"}`):
			writeJSONBody(w, `{"status":"success","data":{"resultType":"streams","result":[{"stream":{"pod":"a"},"values":[["1767229200000000000","x"]]}]}}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

// logDeadlines runs the range (r1)-(r3) or the volume (v1), (v2) cases of unit:deadlines: 504 at
// the 300 ms route deadline, the error envelope only, no further request, the stalled request
// cancelled, and the tenant slot free afterwards.
func logDeadlines(t *testing.T, volume bool) {
	up := stallUpstream(t)
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{TenantConcurrency: 1})
	path, extra, cases := logRangePath, `,"limit":1,"timeout_ms":300`, []struct {
		name, app string
		requests  int
	}{{"r1_no_headers", "nohdr", 1}, {"r2_mid_page", "midpage", 1}, {"r3_second_request", "second", 2}}
	if volume {
		path, extra = logVolumePath, `,"timeout_ms":300`
		cases = cases[:0]
		cases = append(cases, struct {
			name, app string
			requests  int
		}{"v1_no_headers", "nohdr", 1}, struct {
			name, app string
			requests  int
		}{"v2_mid_matrix", "midvol", 1})
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			up.reset()
			start := time.Now()
			rec := postJSON(h, path, logBody(`{app="`+c.app+`"}`, extra))
			elapsed := time.Since(start)
			e := wantError(t, c.name, rec, 504, "unavailable", "-", "")
			if e.Error.Hint["reason"] != "upstream_timeout" {
				t.Errorf("hint %v, want reason upstream_timeout", e.Error.Hint)
			}
			if elapsed < 300*time.Millisecond || elapsed > 500*time.Millisecond {
				t.Errorf("elapsed %v, want 300 ms to 500 ms", elapsed)
			}
			if b := rec.Body.String(); strings.Contains(b, `"streams"`) || strings.Contains(b, `"frames"`) {
				t.Errorf("body %s is not the error envelope only", b)
			}
			rs := up.requests()
			if len(rs) != c.requests {
				t.Errorf("%d upstream requests, want %d", len(rs), c.requests)
			}
			if volume && len(rs) > 0 && !strings.HasPrefix(rs[0].Form.Get("query"), "sum by (level, detected_level) (count_over_time({app=\"") {
				t.Errorf("volume request query %q", rs[0].Form.Get("query"))
			}
			if len(rs) > 0 {
				select {
				case <-rs[len(rs)-1].Done:
				case <-time.After(time.Second):
					t.Error("the stalled upstream request was not cancelled within 1 s")
				}
			}
			ok := postJSON(h, path, logBody(`{app="ok"}`, strings.Replace(extra, `"timeout_ms":300`, `"timeout_ms":5000`, 1)))
			if ok.Code != 200 {
				t.Errorf("follow-up {app=\"ok\"}: %d %s (the tenant slot was not freed)", ok.Code, ok.Body.String())
			} else if volume && strings.Count(ok.Body.String(), `"labels":{"level":"info"}`) != 1 {
				t.Errorf("follow-up volume %s, want one info frame", ok.Body.String())
			}
		})
	}
}
