package gateway

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake/fakeharness"
)

// a1Upstream answers the backward page-1 request of A.1 (limit 5 on the grid) with the
// logs-page-backward-1 answer, a metric query with the logs-metric matrix and anything else with
// an empty answer, in member order reverse or not.
func a1Upstream(t *testing.T, reverse bool) *logUpstream {
	return newLogUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		f := r.Form
		switch {
		case r.URL.Path == "/api/v1/query_range":
			writeJSONBody(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
		case strings.HasPrefix(f.Get("query"), "sum by (level) "):
			writeJSONBody(w, a1Answer(reverse, "matrix", a1Metric()))
		case f.Get("limit") == "5" && f.Get("end") == logHi:
			writeJSONBody(w, a1Answer(reverse, "streams", a1BackwardPage1()))
		default:
			writeJSONBody(w, emptyStreams)
		}
	})
}

// unit:logql-routes (plan #65 Part B §3.3, §4.1, T06-011).
func TestLogqlRoutes(t *testing.T) {
	up := a1Upstream(t, false)
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})

	// A page 1 cursor of the A.1 request, for the cursor rows.
	rec := postJSON(h, logRangePath, logBody(`{app="x"}`, `,"limit":4`))
	p := decodePage(t, rec.Body.Bytes())
	if rec.Code != 200 || p.Cursor == nil || len(*p.Cursor) != 48 {
		t.Fatalf("page 1: %d %s", rec.Code, rec.Body.String())
	}
	cursor := *p.Cursor
	img, _ := base64.RawURLEncoding.DecodeString(cursor)
	if len(img) == 36 {
		img[0] = 2
	}
	v2 := base64.RawURLEncoding.EncodeToString(img)
	// A different width_px keeps the cursor valid: it does not change which entries a page holds.
	if rec := postJSON(h, logRangePath, `{"query":"{app=\"x\"}","from":1767225600000,"to":1767229200000,"width_px":600,"limit":4,"cursor":"`+cursor+`"}`); rec.Code != 200 {
		t.Errorf("page 2 at another width: %d %s", rec.Code, rec.Body.String())
	}
	up.reset()

	const q = `"query":"{app=\"x\"}"`
	const ok = q + `,` + logWin
	for _, c := range []struct {
		name, path, body string
		pointer, key     string
		message          string
	}{
		{"not an object", logRangePath, `[]`, "", "body.invalid", ""},
		{"trailing data", logRangePath, `{` + ok + `} {}`, "", "body.invalid", ""},
		{"unknown field", logRangePath, `{` + ok + `,"x":1}`, "/x", "field.unknown", ""},
		{"missing query", logRangePath, `{` + logWin + `}`, "/query", "field.required", ""},
		{"missing from", logRangePath, `{` + q + `,"to":2,"width_px":3}`, "/from", "field.required", ""},
		{"missing to", logRangePath, `{` + q + `,"from":1,"width_px":3}`, "/to", "field.required", ""},
		{"missing width", logRangePath, `{` + q + `,"from":1,"to":2}`, "/width_px", "field.required", ""},
		{"query type", logRangePath, `{"query":1,` + logWin + `}`, "/query", "field.type", ""},
		{"from negative", logRangePath, `{` + q + `,"from":-1,"to":2,"width_px":3}`, "/from", "field.range", ""},
		{"width 0", logRangePath, `{` + q + `,"from":1,"to":2,"width_px":0}`, "/width_px", "field.range", ""},
		{"from = to", logRangePath, `{` + q + `,"from":2,"to":2,"width_px":3}`, "/to", "field.range", ""},
		{"empty query", logRangePath, `{"query":"",` + logWin + `}`, "/query", "field.range", ""},
		{"query not utf-8", logRangePath, "{\"query\":\"a\xffb\"," + logWin + "}", "/query", "field.range", ""},
		{"timeout 199", logRangePath, `{` + ok + `,"timeout_ms":199}`, "/timeout_ms", "field.range", ""},
		{"to beyond the supported range", logRangePath, `{` + q + `,"from":1,"to":9223372036855,"width_px":3}`, "/to", "field.range",
			"to is beyond the supported time range (at most 9223372036854)"},
		{"grid end beyond the supported range", logRangePath, `{` + q + `,"from":9223372036000,"to":9223372036854,"width_px":1}`, "/to", "field.range",
			"to is too close to the end of the supported time range for this width"},
		{"limit 0", logRangePath, `{` + ok + `,"limit":0}`, "/limit", "field.range", "limit must be between 1 and 5000"},
		{"limit 5001", logRangePath, `{` + ok + `,"limit":5001}`, "/limit", "field.range", "limit must be between 1 and 5000"},
		{"limit type", logRangePath, `{` + ok + `,"limit":"4"}`, "/limit", "field.type", ""},
		{"direction", logRangePath, `{` + ok + `,"direction":"sideways"}`, "/direction", "field.range", ""},
		{"direction case", logRangePath, `{` + ok + `,"direction":"Backward"}`, "/direction", "field.range", ""},
		{"cursor pattern", logRangePath, `{` + ok + `,"cursor":"!"}`, "/cursor", "field.range", ""},
		{"cursor 47 characters", logRangePath, `{` + ok + `,"cursor":"` + cursor[:47] + `"}`, "/cursor", "field.range", ""},
		{"cursor version 2", logRangePath, `{` + ok + `,"cursor":"` + v2 + `"}`, "/cursor", "cursor.invalid", ""},
		{"cursor of another direction", logRangePath, `{` + ok + `,"direction":"forward","cursor":"` + cursor + `"}`, "/cursor", "cursor.mismatch", ""},
		{"cursor of another query", logRangePath, `{"query":"{app=\"y\"}",` + logWin + `,"cursor":"` + cursor + `"}`, "/cursor", "cursor.mismatch", ""},
		{"range too long", logRangePath, `{` + q + `,"from":0,"to":1262304000000,"width_px":1}`, "/from", "range.too_long", ""},
		{"no tenant", "/api/dash/v1/query/logql/range", `{` + ok + `}`, "", "tenant.invalid", ""},
		{"volume not an object", logVolumePath, `[]`, "", "body.invalid", ""},
		{"volume unknown field", logVolumePath, `{` + ok + `,"limit":4}`, "/limit", "field.unknown", ""},
		{"volume missing width", logVolumePath, `{` + q + `,"from":1,"to":2}`, "/width_px", "field.required", ""},
		{"volume from = to", logVolumePath, `{` + q + `,"from":2,"to":2,"width_px":3}`, "/to", "field.range", ""},
		{"volume timeout", logVolumePath, `{` + ok + `,"timeout_ms":120001}`, "/timeout_ms", "field.range", ""},
		{"volume to beyond", logVolumePath, `{` + q + `,"from":1,"to":9223372036855,"width_px":3}`, "/to", "field.range",
			"to is beyond the supported time range (at most 9223372036854)"},
		{"volume grid end", logVolumePath, `{` + q + `,"from":9223372036000,"to":9223372036854,"width_px":1}`, "/to", "field.range",
			"to is too close to the end of the supported time range for this width"},
		{"volume range too long", logVolumePath, `{` + q + `,"from":0,"to":1262304000000,"width_px":1}`, "/from", "range.too_long", ""},
		{"volume no tenant", "/api/dash/v1/query/logql/volume?tenant=BAD", `{` + ok + `}`, "", "tenant.invalid", ""},
	} {
		e := wantError(t, c.name, postJSON(h, c.path, c.body), 400, "invalid", c.pointer, c.key)
		if c.message != "" && e.Error.Message != c.message {
			t.Errorf("%s: message %q, want %q", c.name, e.Error.Message, c.message)
		}
	}
	if n := len(up.requests()); n != 0 {
		t.Errorf("%d upstream requests for refused bodies", n)
	}

	// #62's PromQL routes keep their own bound.
	if rec := postJSON(h, rangePath, `{"query":"up","from":253402300000000,"to":253402300799999,"width_px":1200}`); rec.Code != 200 {
		t.Errorf("PromQL to 253402300799999: %d %s", rec.Code, rec.Body.String())
	}
}

// unit:logql-routes, metric path: frames are written as the upstream body is decoded.
func TestLogqlMetricStreams(t *testing.T) {
	release := make(chan struct{})
	up := newLogUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"level":"info"},"values":[[1767225600,"1"]]}`)
		_ = http.NewResponseController(w).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
		_, _ = io.WriteString(w, `]}}`)
	})
	defer close(release)
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	srv := httptest.NewServer(h)
	defer srv.Close()
	resp, err := http.Post(srv.URL+logRangePath, "application/json", strings.NewReader(logBody(`sum by (level) (count_over_time({app="x"}[1m]))`, "")))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	got := make(chan string, 1)
	go func() {
		r := bufio.NewReader(resp.Body)
		var b []byte
		for {
			c, err := r.ReadByte()
			if err != nil {
				got <- string(b)
				return
			}
			b = append(b, c)
			if bytes.Contains(b, []byte(`"values":[`)) && bytes.HasSuffix(b, []byte("]}")) {
				got <- string(b)
				return
			}
		}
	}()
	select {
	case b := <-got:
		if resp.StatusCode != 200 || !strings.HasPrefix(b, `{"kind":"series","start":1767225600000,"end":1767229200000,"step":5000,"frames":[{"key":`) {
			t.Errorf("%d first bytes %q", resp.StatusCode, b)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no complete frame before the upstream finished: the route buffers a metric result")
	}
}

// unit:logql-routes, metric path: a failure after the header resets the connection.
func TestLogqlMetricAbort(t *testing.T) {
	up := newLogUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"level":"info"},"values":[[1767225600,"1"]]},`)
		_ = http.NewResponseController(w).Flush()
		if conn, _, err := http.NewResponseController(w).Hijack(); err == nil {
			_ = conn.Close()
		}
	})
	h, logs := queryGateway(t, up.URL, pulsusdb.Options{})
	srv := httptest.NewServer(h)
	defer srv.Close()
	resp, err := http.Post(srv.URL+logRangePath, "application/json", strings.NewReader(logBody(`sum by (level) (count_over_time({app="x"}[1m]))`, "")))
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err == nil || json.Valid(b) {
		t.Errorf("the cut body read as complete (%v): %q", err, b)
	}
	found := false
	for _, r := range logs.records(t) {
		if r["msg"] == "logql_stream_aborted" {
			found = true
		}
		if r["msg"] == "promql_stream_aborted" {
			t.Error("a LogQL stream logged promql_stream_aborted")
		}
	}
	if !found {
		t.Error("no msg=logql_stream_aborted log record")
	}
}

// unit:logql-routes, member order through the route (T06-011): result before resultType gives the
// same bytes as resultType first, for a page and for a metric result.
func TestLogqlMemberOrder(t *testing.T) {
	bodies := map[bool][2]string{}
	for _, reverse := range []bool{false, true} {
		up := a1Upstream(t, reverse)
		h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
		page := postJSON(h, logRangePath, logBody(`{app="x"}`, `,"limit":4`))
		metric := postJSON(h, logRangePath, logBody(`sum by (level) (count_over_time({app="x"}[1m]))`, ""))
		if page.Code != 200 || metric.Code != 200 {
			t.Fatalf("reverse %v: %d %s / %d %s", reverse, page.Code, page.Body.String(), metric.Code, metric.Body.String())
		}
		bodies[reverse] = [2]string{page.Body.String(), metric.Body.String()}
	}
	for i, what := range []string{"streams", "series"} {
		if a, b := bodies[false][i], bodies[true][i]; a != b {
			t.Errorf("%s: result first gives another body:\n type first   %.300s\n result first %.300s", what, a, b)
		}
	}
	if !strings.HasPrefix(bodies[false][0], `{"kind":"streams",`) || !strings.HasPrefix(bodies[false][1], `{"kind":"series",`) {
		t.Errorf("bodies %.80s / %.80s", bodies[false][0], bodies[false][1])
	}
}

// unit:log-time-range (§3.3, Q6): the log routes end at maxLogTimeMs, before and after alignment.
func TestLogTimeRange(t *testing.T) {
	up := newLogUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/logs/v1/query_range":
			if strings.HasPrefix(r.Form.Get("query"), "sum by (level, detected_level)") {
				writeJSONBody(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
				return
			}
			writeJSONBody(w, emptyStreams)
		case "/api/logs/v1/series":
			writeJSONBody(w, `{"status":"success","data":[]}`)
		default:
			writeJSONBody(w, `{"status":"success","data":[]}`)
		}
	})
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	const q = `"query":"{app=\"x\"}"`
	for _, path := range []string{logRangePath, logVolumePath} {
		up.reset()
		e := wantError(t, path+" to beyond", postJSON(h, path, `{`+q+`,"from":1,"to":9223372036855,"width_px":3}`), 400, "invalid", "/to", "field.range")
		if e.Error.Message != "to is beyond the supported time range (at most 9223372036854)" {
			t.Errorf("%s: message %q", path, e.Error.Message)
		}
		e = wantError(t, path+" grid end", postJSON(h, path, `{`+q+`,"from":9223372036000,"to":9223372036854,"width_px":1}`), 400, "invalid", "/to", "field.range")
		if e.Error.Message != "to is too close to the end of the supported time range for this width" {
			t.Errorf("%s: message %q", path, e.Error.Message)
		}
		if n := len(up.requests()); n != 0 {
			t.Errorf("%s: %d upstream requests for refused times", path, n)
		}
		rec := postJSON(h, path, `{`+q+`,"from":9223372035000,"to":9223372036000,"width_px":1}`)
		rs := up.requests()
		if rec.Code != 200 || len(rs) != 1 || rs[0].Form.Get("end") != "9223372036000000000" {
			t.Errorf("%s at the end of the range: %d %s, upstream %+v", path, rec.Code, rec.Body.String(), rs)
		}
		up.reset()
		rec = postJSON(h, path, `{`+q+`,"from":0,"to":3600000,"width_px":1200}`)
		if rs := up.requests(); rec.Code != 200 || len(rs) != 1 || rs[0].Form.Get("start") != "0000000000000000000" {
			t.Errorf("%s from 0: %d %s, upstream %+v", path, rec.Code, rec.Body.String(), rs)
		}
	}
	for _, route := range []string{"/api/dash/v1/logs/labels?tenant=demo", "/api/dash/v1/logs/label/pod/values?tenant=demo", "/api/dash/v1/logs/series?tenant=demo&match=%7Bapp%3D%22x%22%7D"} {
		up.reset()
		e := wantError(t, route+" to beyond", do(h, http.MethodGet, route+"&from=1&to=9223372036855"), 400, "invalid", "/to", "field.range")
		if e.Error.Message != "to is beyond the supported time range (at most 9223372036854)" {
			t.Errorf("%s: message %q", route, e.Error.Message)
		}
		wantError(t, route+" from -1", do(h, http.MethodGet, route+"&from=-1&to=2"), 400, "invalid", "/from", "field.range")
		if n := len(up.requests()); n != 0 {
			t.Errorf("%s: %d upstream requests for refused times", route, n)
		}
		rec := do(h, http.MethodGet, route+"&from=0&to=9223372036854")
		if rs := up.requests(); rec.Code != 200 || len(rs) != 1 || rs[0].Form.Get("end") != "9223372036854000000" || rs[0].Form.Get("start") != "0000000000000000000" {
			t.Errorf("%s at the end of the range: %d %s, upstream %+v", route, rec.Code, rec.Body.String(), rs)
		}
	}
}

// goldenLogNow is Deps.Now of unit:logql-golden: 200 s after the newest A.1 entry.
var goldenLogNow = time.UnixMilli(1767229300000)

// unit:logql-golden (B.3, T04-001): the response bytes of the log routes.
func TestLogqlGolden(t *testing.T) {
	_, url := fakeharness.Start(t)
	h, _ := logGateway(t, url, pulsusdb.Options{}, goldenLogNow)
	cursorOf := func(b []byte) string {
		var m struct {
			Cursor string `json:"cursor"`
		}
		_ = json.Unmarshal(b, &m)
		return m.Cursor
	}
	type step struct {
		file, path, body string
		next             bool // the body takes the previous page's cursor
	}
	steps := []step{
		{"logql-streams-backward-1.json", logRangePath, logBody(`{app="x"}`, `,"limit":4`), false},
		{"logql-streams-backward-2.json", logRangePath, logBody(`{app="x"}`, `,"limit":4`), true},
		{"logql-streams-forward-1.json", logRangePath, logBody(`{app="x"}`, `,"limit":2,"direction":"forward"`), false},
		{"logql-streams-forward-2.json", logRangePath, logBody(`{app="x"}`, `,"limit":2,"direction":"forward"`), true},
		{"logql-streams-forward-3.json", logRangePath, logBody(`{app="x"}`, `,"limit":2,"direction":"forward"`), true},
		{"logql-metric.json", logRangePath, logBody(`sum by (level) (count_over_time({app="x"}[1m]))`, ""), false},
		{"logql-volume.json", logVolumePath, logBody(`{app="x"}`, ""), false},
	}
	prev := ""
	for _, s := range steps {
		body := s.body
		if s.next {
			body = strings.TrimSuffix(body, "}") + `,"cursor":"` + prev + `"}`
		}
		rec := postJSON(h, s.path, body)
		if rec.Code != 200 || rec.Header().Get("Content-Type") != "application/json" {
			t.Fatalf("%s: %d %q %s", s.file, rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
		}
		prev = cursorOf(rec.Body.Bytes())
		path := "../../../wire/fixtures/json/" + s.file
		if *update {
			if err := os.WriteFile(path, rec.Body.Bytes(), 0o644); err != nil { // #nosec G306 -- a repository fixture
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(path) // #nosec G304 -- a fixed fixture path
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(rec.Body.Bytes(), want) {
			t.Errorf("%s differs from the golden file:\n got %.600s\nwant %.600s", s.file, rec.Body.String(), want)
		}
	}
}

// The golden pages, checked against B.3 independently of the files.
func TestLogqlGoldenShape(t *testing.T) {
	_, url := fakeharness.Start(t)
	h, _ := logGateway(t, url, pulsusdb.Options{}, goldenLogNow)
	rec := postJSON(h, logRangePath, logBody(`{app="x"}`, `,"limit":4`))
	b := rec.Body.String()
	keyA := keyhash.Hex(keyhash.Labels([]keyhash.Label{{Name: "app", Value: "x"}, {Name: "pod", Value: "a"}}))
	for _, want := range []string{
		`{"kind":"streams","start":1767225600000,"end":1767229200000,"step":5000,"direction":"backward","streams":[`,
		`{"key":"` + keyA + `","labels":{"app":"x","pod":"a"},"entries":[{"ts_ns":"1767229100000000500","line":"a5","level":"info","metadata":{"detected_level":"info"}}]}`,
		`"labels":{"app":"x","pod":"b"},"entries":[{"ts_ns":"1767229100000000400","line":"b4","level":"warn","metadata":{"detected_level":"unknown"},"parsed":{"level":"WARNING"}}]}`,
		`],"cursor":"`,
		`","completeness":{"truncated":false,"warnings":[],"infos":[],"query_id":"fake-logs-page-b1-1","data_age_ms":200000}}`,
	} {
		if rec.Code != 200 || !strings.Contains(b, want) {
			t.Errorf("%d: backward page 1 lacks %s\n%s", rec.Code, want, b)
		}
	}
	if strings.Count(b, `"ts_ns"`) != 2 {
		t.Errorf("backward page 1 has %d entries, want 2: %s", strings.Count(b, `"ts_ns"`), b)
	}

	// Forward page 1 takes two requests; its query_id is that of the last (§3.4).
	rec = postJSON(h, logRangePath, logBody(`{app="x"}`, `,"limit":2,"direction":"forward"`))
	if p := decodePage(t, rec.Body.Bytes()); rec.Code != 200 || p.Completeness["query_id"] != "fake-logs-group-1" || p.Cursor == nil {
		t.Errorf("forward page 1: %d %s", rec.Code, rec.Body.String())
	}

	rec = postJSON(h, logRangePath, logBody(`sum by (level) (count_over_time({app="x"}[1m]))`, ""))
	if b := rec.Body.String(); rec.Code != 200 || !strings.HasPrefix(b, `{"kind":"series","start":1767225600000,"end":1767229200000,"step":5000,"frames":[`) ||
		strings.Contains(b, `"cursor"`) || strings.Count(b, `"key"`) != 2 {
		t.Errorf("metric: %d %.300s", rec.Code, b)
	}
	rec = postJSON(h, logVolumePath, logBody(`{app="x"}`, ""))
	if b := rec.Body.String(); rec.Code != 200 || !strings.HasPrefix(b, `{"start":1767225600000,"end":1767229200000,"step":5000,"frames":[`) || strings.Count(b, `"key"`) != 5 {
		t.Errorf("volume: %d %.300s", rec.Code, b)
	}
}

// unit:virtual-guard (route half, T07-020 v1): refused at its pointer before any request.
func TestLogVirtualGuard(t *testing.T) {
	up := newLogUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.Form.Get("query"), "sum by (level, detected_level)") {
			writeJSONBody(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
			return
		}
		if r.URL.Path == "/api/logs/v1/query_range" {
			writeJSONBody(w, emptyStreams)
			return
		}
		writeJSONBody(w, `{"status":"success","data":[]}`)
	})
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	const reserved = `{source="pulsus-dash"}`
	const passes = `{source="pulsus-dashboard"}` // #nosec G101 -- a selector, not a credential
	esc := func(s string) string {
		return strings.NewReplacer("{", "%7B", "}", "%7D", `"`, "%22", "=", "%3D").Replace(s)
	}
	for _, c := range []struct {
		name    string
		rec     func(sel string) *httptest.ResponseRecorder
		pointer string
	}{
		{"range", func(sel string) *httptest.ResponseRecorder { return postJSON(h, logRangePath, logBody(sel, "")) }, "/query"},
		{"volume", func(sel string) *httptest.ResponseRecorder { return postJSON(h, logVolumePath, logBody(sel, "")) }, "/query"},
		{"labels", func(sel string) *httptest.ResponseRecorder {
			return do(h, http.MethodGet, "/api/dash/v1/logs/labels?tenant=demo"+window+"&query="+esc(sel))
		}, "/query"},
		{"label values", func(sel string) *httptest.ResponseRecorder {
			return do(h, http.MethodGet, "/api/dash/v1/logs/label/pod/values?tenant=demo"+window+"&query="+esc(sel))
		}, "/query"},
		{"series", func(sel string) *httptest.ResponseRecorder {
			return do(h, http.MethodGet, "/api/dash/v1/logs/series?tenant=demo"+window+"&match="+esc(`{app="x"}`)+"&match="+esc(sel))
		}, "/match/1"},
	} {
		up.reset()
		e := wantError(t, c.name, c.rec(reserved), 400, "virtual_unsupported", c.pointer, "query.reserved")
		if e.Error.Hint["reserved"] != `source="pulsus-dash"` {
			t.Errorf("%s: hint %v", c.name, e.Error.Hint)
		}
		if n := len(up.requests()); n != 0 {
			t.Errorf("%s: %d upstream requests", c.name, n)
		}
		if rec := c.rec(passes); rec.Code != 200 || len(up.requests()) != 1 {
			t.Errorf("%s: %s gives %d %s after %d requests", c.name, passes, rec.Code, rec.Body.String(), len(up.requests()))
		}
	}
}

// The default limit and direction reach the upstream as Part A's pager sends them.
func TestLogqlDefaults(t *testing.T) {
	up := a1Upstream(t, false)
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	rec := postJSON(h, logRangePath, logBody(`{app="z"}`, ""))
	rs := up.requests()
	if rec.Code != 200 || len(rs) != 1 || rs[0].Form.Get("limit") != "1001" || rs[0].Form.Get("direction") != "backward" ||
		rs[0].Form.Get("start") != logLo || rs[0].Form.Get("end") != logHi {
		t.Errorf("defaults: %d %s, upstream %+v", rec.Code, rec.Body.String(), rs)
	}
	if p := decodePage(t, rec.Body.Bytes()); p.Cursor != nil || len(p.Streams) != 0 || p.Streams == nil {
		t.Errorf("empty page %+v", p)
	}
	if !slices.Contains([]string{"backward"}, decodePage(t, rec.Body.Bytes()).Direction) {
		t.Errorf("direction of the empty page: %s", rec.Body.String())
	}
}
