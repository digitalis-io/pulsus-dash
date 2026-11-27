package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/arrowwire"
	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	promplan "github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/prom"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake"
)

// The route fixtures of plan #68 Part D1 §5 (wire/fixtures/route/): each case's bodies written by
// the real range handler over a pulsusfake upstream, with the fixed clock routeNow. The Rust
// route_parity test decodes each .dsf and compares it with its .json.
const routeFixtureDir = "../../../wire/fixtures/route"

// dsfAccept is the Accept of a request for a DSF body.
const dsfAccept = "application/vnd.pulsus.dash-stream;v=1"

// routeNow is Deps.Now of the route fixtures: 2026-11-19T13:00Z.
var routeNow = time.UnixMilli(1795093200000)

// The windows of the cases: 12:00–13:00 at 60 px (step 60 s, 61 points), 12:05–13:05 (a
// sample after routeNow) and 12:50–13:00 at 10 px (11 points).
const (
	hourWindow   = `"from":1795089600000,"to":1795093200000,"width_px":60`
	futureWindow = `"from":1795089900000,"to":1795093500000,"width_px":60`
	shortWindow  = `"from":1795092600000,"to":1795093200000,"width_px":10`
)

// upSeries is one upstream matrix series: labels, then (seconds, value) points.
type upSeries struct {
	labels map[string]string
	points [][2]string
}

// ramp is a series with a point at every step from start (s) to end (s), valued by f.
func ramp(labels map[string]string, start, end, step int64, f func(i int) string) upSeries {
	s := upSeries{labels: labels}
	for i, t := 0, start; t <= end; i, t = i+1, t+step {
		s.points = append(s.points, [2]string{strconv.FormatInt(t, 10), f(i)})
	}
	return s
}

func routeMatrix(ss []upSeries) json.RawMessage {
	var b strings.Builder
	b.WriteString(`{"status":"success","data":{"resultType":"matrix","result":[`)
	for i, s := range ss {
		if i > 0 {
			b.WriteByte(',')
		}
		m, _ := json.Marshal(s.labels)
		b.WriteString(`{"metric":` + string(m) + `,"values":[`)
		for j, p := range s.points {
			if j > 0 {
				b.WriteByte(',')
			}
			b.WriteString("[" + p[0] + `,"` + p[1] + `"]`)
		}
		b.WriteString("]}")
	}
	b.WriteString("]}}")
	return json.RawMessage(b.String())
}

// rangeTranscript answers every query_range with ss and the headers hdr (Content-Type added).
func rangeTranscript(ss []upSeries, hdr map[string]string) pulsusfake.Transcript {
	h := map[string]string{"Content-Type": "application/json"}
	for k, v := range hdr {
		h[k] = v
	}
	return pulsusfake.Transcript{Name: "route", Provenance: pulsusfake.Provenance{Synthetic: "route fixtures (plan #68 D1 §5)"},
		Match:    pulsusfake.Match{Method: "POST", Paths: []string{"/api/v1/query_range"}},
		Response: pulsusfake.Response{Status: 200, Headers: h, Body: routeMatrix(ss)}}
}

// metadataTranscript answers the metric-types lookup with status (504: the lookup times out).
func metadataTranscript(status int) pulsusfake.Transcript {
	body := json.RawMessage(`{"status":"success","data":{}}`)
	if status != 200 {
		body = json.RawMessage(`{"status":"error","errorType":"timeout","error":"metadata timed out"}`)
	}
	return pulsusfake.Transcript{Name: "metadata", Provenance: pulsusfake.Provenance{Synthetic: "route fixtures (plan #68 D1 §5)"},
		Match:    pulsusfake.Match{Method: "GET", Paths: []string{"/api/v1/metadata"}},
		Response: pulsusfake.Response{Status: status, Headers: map[string]string{"Content-Type": "application/json"}, Body: body}}
}

// routeGateway is a gateway over a pulsusfake serving ts, with the real metric-types cache, the
// clock routeNow and JSON logs.
func routeGateway(t testing.TB, ts ...pulsusfake.Transcript) (http.Handler, *pulsusfake.Fake, *syncBuffer) {
	t.Helper()
	fake := pulsusfake.New(ts, pulsusfake.Options{})
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	logs := &syncBuffer{}
	logger := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	b := core.TenantBinding{OrgID: pdbOrg, ID: demoBindingID, Slug: "demo", DatasourceURL: srv.URL, Kind: "pulsusdb"}
	view := core.BootstrapView{Org: core.Org{ID: pdbOrg, Slug: "default", Name: "Default organisation"}, Bindings: []core.TenantBinding{b}}
	client := pulsusdb.New(pulsusdb.Options{Logger: logger})
	now := func() time.Time { return routeNow }
	return New(Deps{
		Logger: logger, Probe: &fakeProbe{version: 1}, SchemaLatest: 1,
		Bootstrap: func(context.Context) (core.BootstrapView, error) { return view, nil },
		Now:       now,
		PulsusDB:  client,
		Types:     promplan.NewTypesCache(promplan.MetadataFetch(client), promplan.CacheOptions{Now: now}),
	}), fake, logs
}

// injectFailure makes the call-th read of an upstream series fail with err (1 = the first
// series: before the header). It is undone when t ends.
func injectFailure(t testing.TB, call int, err error) *int {
	t.Helper()
	prev, n := nextSeries, 0
	nextSeries = func(rs *pulsusdb.ResultStream) (*pulsusdb.Series, error) {
		n++
		if n == call {
			return nil, err
		}
		return prev(rs)
	}
	t.Cleanup(func() { nextSeries = prev })
	return &n
}

// withLimits makes the DSF writer use l until t ends.
func withLimits(t testing.TB, l arrowwire.Limits) {
	t.Helper()
	prev := arrowLimits
	arrowLimits = func() arrowwire.Limits { return l }
	t.Cleanup(func() { arrowLimits = prev })
}

// testLimits is wire/schemas/limits-test.json.
func testLimits(t testing.TB) arrowwire.Limits {
	t.Helper()
	b, err := os.ReadFile("../../../wire/schemas/limits-test.json")
	if err != nil {
		t.Fatal(err)
	}
	var l arrowwire.Limits
	if err := json.Unmarshal(b, &l); err != nil {
		t.Fatal(err)
	}
	return l
}

// rangeReq is a range request body for query over window.
func rangeReq(query, window string) string {
	return `{"query":` + jsonString(query) + `,` + window + `}`
}

// serve posts body to the range route on h, with accept ("" = no Accept).
func serve(h http.Handler, body, accept string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, rangePath, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if accept != "" {
		req.Header.Set("Accept", accept)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

var (
	jobA = map[string]string{"job": "api", "instance": "a.test:9090"}
	jobB = map[string]string{"job": "api", "instance": "b.test:9090"}
)

// hourSeries is a full series of the hour window (61 points).
func hourSeries(labels map[string]string, f func(i int) string) upSeries {
	return ramp(labels, 1795089600, 1795093200, 60, f)
}

func half(i int) string  { return strconv.FormatFloat(float64(i)*0.5, 'g', -1, 64) }
func plain(i int) string { return strconv.Itoa(i) }

// twoSeries is the two-series upstream (61 points each).
func twoSeries() []upSeries { return []upSeries{hourSeries(jobA, half), hourSeries(jobB, plain)} }

// manySeries is n series of the short window (11 points each).
func manySeries(n int) []upSeries {
	out := make([]upSeries, n)
	for i := range out {
		out[i] = ramp(map[string]string{"job": "batch", "instance": fmt.Sprintf("i-%03d.test", i)}, 1795092600, 1795093200, 60,
			func(j int) string { return strconv.Itoa(i*100 + j) })
	}
	return out
}

// The mid-failure classes (§3.4): the error read after the first series, and before the header
// for its err-<class>.json. The query-invalid position is the planned offset of '{' in
// rate(x_total{job="a"}[1m]), which maps to the raw offset 7.
var failClasses = []struct {
	name string
	err  error
}{
	{"query-invalid", &pulsusdb.Error{Kind: pulsusdb.KindQueryInvalid, Status: 400, Message: "1:13: parse error: unexpected character inside braces",
		Position: &pulsusdb.Position{Offset: 12}, QueryID: "fake-route-1"}},
	{"too-broad", &pulsusdb.Error{Kind: pulsusdb.KindTooBroad, Status: 422, Message: "the selector matches too many series", QueryID: "fake-route-1"}},
	{"rate-limited", &pulsusdb.Error{Kind: pulsusdb.KindRateLimited, Status: 429, Message: "PulsusDB is rate limiting this tenant", RetryAfter: "7", QueryID: "fake-route-1"}},
	{"timeout", &pulsusdb.Error{Kind: pulsusdb.KindTimeout, Message: "the query timed out"}},
	{"unavailable", &pulsusdb.Error{Kind: pulsusdb.KindUnavailable, Status: 503, Message: "PulsusDB is unavailable", QueryID: "fake-route-1"}},
	{"internal", errors.New("decoder invariant broken")},
}

// failQuery is the query of the failure cases.
const failQuery = `x_total{job="a"}`

// routeOutput is one fixture file a case writes.
type routeOutput struct {
	file string
	body []byte
}

// routeCase is one fixture case: run returns the files it writes.
type routeCase struct {
	name string
	run  func(t *testing.T) []routeOutput
}

// both writes case.dsf (DSF Accept) and case.json (no Accept) for one upstream and request.
func both(name, req string, ts ...pulsusfake.Transcript) routeCase {
	return routeCase{name, func(t *testing.T) []routeOutput {
		h, _, _ := routeGateway(t, ts...)
		return []routeOutput{{name + ".dsf", okBody(t, serve(h, req, dsfAccept), arrowwire.ContentType)},
			{name + ".json", okBody(t, serve(h, req, ""), "application/json")}}
	}}
}

func okBody(t *testing.T, rec *httptest.ResponseRecorder, ct string) []byte {
	t.Helper()
	if rec.Code != 200 || rec.Header().Get("Content-Type") != ct {
		t.Fatalf("%d %q, want 200 %q: %.300s", rec.Code, rec.Header().Get("Content-Type"), ct, rec.Body.String())
	}
	return rec.Body.Bytes()
}

// envelopeFile is an err-<class>.json: the status, the Retry-After value (null if none) and the
// envelope the handler wrote.
func envelopeFile(rec *httptest.ResponseRecorder) []byte {
	ra := "null"
	if v := rec.Header().Get("Retry-After"); v != "" {
		ra = strconv.Quote(v)
	}
	return []byte(`{"status":` + strconv.Itoa(rec.Code) + `,"retry_after":` + ra + `,"body":` + strings.TrimSuffix(rec.Body.String(), "\n") + "}\n")
}

func routeCases() []routeCase {
	cases := []routeCase{
		both("two-series", rangeReq("sum by (job, instance) (rate(req_total[5m]))", hourWindow),
			rangeTranscript(twoSeries(), map[string]string{"X-Pulsus-Query-Id": "fake-route-1", "X-Pulsus-Read-Cache": "miss"})),
		both("gaps", rangeReq("rate(req_total[5m])", hourWindow), rangeTranscript([]upSeries{
			{labels: jobA, points: [][2]string{{"1795089600", "1"}, {"1795089660", "NaN"}, {"1795089780", "+Inf"}, {"1795089840", "-Inf"},
				{"1795090200", "-0"}, {"1795093080", "2.5"}}},
		}, nil)),
		both("empty", rangeReq("rate(req_total[5m])", hourWindow), rangeTranscript(nil, map[string]string{"X-Pulsus-Query-Id": "fake-route-2"})),
		both("types-warning", rangeReq("x_c", hourWindow), metadataTranscript(504),
			rangeTranscript([]upSeries{hourSeries(jobA, plain)}, nil)),
		both("read-cache", rangeReq("rate(req_total[5m])", hourWindow),
			rangeTranscript([]upSeries{hourSeries(jobA, half)}, map[string]string{"X-Pulsus-Read-Cache": "hit", "X-Pulsus-Read-Cache-Through": "45000000"})),
		both("future-sample", rangeReq("rate(req_total[5m])", futureWindow),
			rangeTranscript([]upSeries{ramp(jobA, 1795089900, 1795093500, 60, plain)}, nil)),
		both("many", rangeReq("rate(req_total[5m])", shortWindow), rangeTranscript(manySeries(600), nil)),
		{"limits-many", func(t *testing.T) []routeOutput {
			withLimits(t, testLimits(t))
			h, _, _ := routeGateway(t, rangeTranscript(manySeries(600), nil))
			return []routeOutput{{"limits-many.dsf", okBody(t, serve(h, rangeReq("rate(req_total[5m])", shortWindow), dsfAccept), arrowwire.ContentType)}}
		}},
		{"refused-open-parts", func(t *testing.T) []routeOutput {
			l := testLimits(t)
			l.OpenParts = 0
			withLimits(t, l)
			h, _, _ := routeGateway(t, rangeTranscript(twoSeries(), nil))
			return []routeOutput{{"refused-open-parts.dsf", okBody(t, serve(h, rangeReq("rate(req_total[5m])", hourWindow), dsfAccept), arrowwire.ContentType)}}
		}},
	}
	// Plan #68 D2 §5: the virtual refusal is raised by the guard before any request, so it is always
	// a pre-header JSON envelope, never a stream row.
	cases = append(cases, routeCase{"virtual", func(t *testing.T) []routeOutput {
		h, _, _ := routeGateway(t, rangeTranscript(twoSeries(), nil))
		rec := serve(h, rangeReq("ALERTS", hourWindow), dsfAccept)
		if rec.Code != 400 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
			t.Fatalf("err-virtual: %d %q", rec.Code, rec.Header().Get("Content-Type"))
		}
		return []routeOutput{{"err-virtual.json", envelopeFile(rec)}}
	}})
	for _, c := range failClasses {
		cases = append(cases, routeCase{"mid-failure-" + c.name, func(t *testing.T) []routeOutput {
			h, _, _ := routeGateway(t, rangeTranscript(twoSeries(), map[string]string{"X-Pulsus-Query-Id": "fake-route-1"}))
			injectFailure(t, 2, c.err)
			out := []routeOutput{{"mid-failure-" + c.name + ".dsf", okBody(t, serve(h, rangeReq(failQuery, hourWindow), dsfAccept), arrowwire.ContentType)}}
			injectFailure(t, 1, c.err)
			rec := serve(h, rangeReq(failQuery, hourWindow), dsfAccept)
			if rec.Code < 400 || !strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
				t.Fatalf("err-%s: %d %q", c.name, rec.Code, rec.Header().Get("Content-Type"))
			}
			return append(out, routeOutput{"err-" + c.name + ".json", envelopeFile(rec)})
		}})
	}
	return cases
}

// TestRouteFixtures (parity, plan #68 D1 §5): the committed wire/fixtures/route/ files equal the
// handler's output (regenerate with -update).
func TestRouteFixtures(t *testing.T) {
	for _, c := range routeCases() {
		t.Run(c.name, func(t *testing.T) {
			for _, o := range c.run(t) {
				path := filepath.Join(routeFixtureDir, o.file)
				if *update {
					if err := os.MkdirAll(routeFixtureDir, 0o755); err != nil { // #nosec G301 -- a repository directory
						t.Fatal(err)
					}
					if err := os.WriteFile(path, o.body, 0o644); err != nil { // #nosec G306 -- a repository fixture
						t.Fatal(err)
					}
					continue
				}
				want, err := os.ReadFile(path) // #nosec G304 -- fixture names are constants of the tests
				if err != nil {
					t.Fatalf("%v (run with -update to write the fixtures)", err)
				}
				if !bytes.Equal(o.body, want) {
					t.Errorf("%s: the handler's %d bytes differ from the committed %d", o.file, len(o.body), len(want))
				}
			}
		})
	}
}
