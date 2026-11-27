package gateway

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/arrowwire/wiretest"
	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	promplan "github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/prom"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake/fakeharness"
)

var demo2BindingID = uuid.MustParse("01900000-0000-7000-8000-000000000002")

// The window of the plan tests (plan #112 A.5): one hour at 1 200 px, step 5 s.
const (
	planWindow = `"from":1767225600000,"to":1767229200000,"width_px":1200`
	planAt     = `"at":1767229200000`
)

// plannedGateway is queryGateway with the bindings demo and demo2 (same URL, different IDs) and
// the real metric-types cache over the PulsusDB metadata route.
func plannedGateway(t *testing.T, upstreamURL string, now func() time.Time) http.Handler {
	t.Helper()
	logger := slog.New(slog.DiscardHandler)
	b1 := core.TenantBinding{OrgID: pdbOrg, ID: demoBindingID, Slug: "demo", DatasourceURL: upstreamURL, Kind: "pulsusdb"}
	b2 := core.TenantBinding{OrgID: pdbOrg, ID: demo2BindingID, Slug: "demo2", DatasourceURL: upstreamURL, Kind: "pulsusdb"}
	view := core.BootstrapView{Org: core.Org{ID: pdbOrg, Slug: "default", Name: "Default organisation"}, Bindings: []core.TenantBinding{b1, b2}}
	client := pulsusdb.New(pulsusdb.Options{Logger: logger})
	return New(Deps{
		Logger: logger, Probe: &fakeProbe{version: 1}, SchemaLatest: 1,
		Bootstrap: func(context.Context) (core.BootstrapView, error) { return view, nil },
		Now:       now,
		PulsusDB:  client,
		Types:     promplan.NewTypesCache(promplan.MetadataFetch(client), promplan.CacheOptions{Now: now}),
	})
}

// planBody is the members of a response this file reads.
type planBody struct {
	Planned *struct {
		Query         string `json:"query"`
		Expanded      string `json:"expanded"`
		Bytes         int    `json:"bytes"`
		ValueType     string `json:"value_type"`
		RateCandidate bool   `json:"rate_candidate"`
		RateApplied   bool   `json:"rate_applied"`
		Histogram     bool   `json:"histogram"`
		StepMs        int64  `json:"step_ms"`
		RateWindowMs  int64  `json:"rate_window_ms"`
	} `json:"planned"`
	Completeness struct {
		Warnings []string `json:"warnings"`
	} `json:"completeness"`
	Error *struct {
		Code   string         `json:"code"`
		Hint   map[string]any `json:"hint"`
		Fields []struct {
			Pointer    string `json:"pointer"`
			MessageKey string `json:"message_key"`
		} `json:"fields"`
		Planned *struct {
			Query string `json:"query"`
			Bytes int    `json:"bytes"`
		} `json:"planned"`
	} `json:"error"`
}

func planBodyOf(t *testing.T, rec *httptest.ResponseRecorder) planBody {
	t.Helper()
	var b planBody
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
		t.Fatalf("body %.200q: %v", rec.Body.String(), err)
	}
	return b
}

func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func rangeBody(query string, extra ...string) string {
	return `{"query":` + jsonString(query) + `,` + planWindow + strings.Join(append([]string{""}, extra...), ",") + `}`
}

func instantBody(query string, extra ...string) string {
	return `{"query":` + jsonString(query) + `,` + planAt + strings.Join(append([]string{""}, extra...), ",") + `}`
}

// served is the planned query of each 200 or post-planning error response, in order.
type served struct {
	mu      sync.Mutex
	planned []string
}

func (s *served) add(t *testing.T, rec *httptest.ResponseRecorder) planBody {
	t.Helper()
	b := planBodyOf(t, rec)
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case b.Planned != nil:
		s.planned = append(s.planned, b.Planned.Query)
	case b.Error != nil && b.Error.Planned != nil:
		s.planned = append(s.planned, b.Error.Planned.Query)
	default:
		t.Errorf("response without planned: %.200s", rec.Body.String())
	}
	return b
}

// assertAuthority: each recorded query request's query equals the planned.query of the response
// it served, in order (itest:plan-authority, T06-029).
func assertAuthority(t *testing.T, fake *pulsusfake.Fake, s *served) {
	t.Helper()
	var sent []string
	for _, r := range fake.Requests() {
		if r.Path == "/api/v1/query_range" || r.Path == "/api/v1/query" {
			sent = append(sent, r.Form.Get("query"))
		}
	}
	if len(sent) != len(s.planned) {
		t.Fatalf("%d upstream queries %q, %d planned %q", len(sent), sent, len(s.planned), s.planned)
	}
	for i := range sent {
		if sent[i] != s.planned[i] {
			t.Errorf("request %d sent %q, planned %q", i, sent[i], s.planned[i])
		}
	}
}

func countPath(fake *pulsusfake.Fake, path string) int {
	n := 0
	for _, r := range fake.Requests() {
		if r.Path == path {
			n++
		}
	}
	return n
}

func fixedNow() time.Time { return goldenNow }

// itest:promql-planned (ADR-0021 §2, §3): rows P1–P6 of plan #112 A.5.
func TestPromqlPlanned(t *testing.T) {
	fake, url := fakeharness.Start(t)
	h := plannedGateway(t, url, fixedNow)
	s := &served{}

	rec := postJSON(h, rangePath, rangeBody("rate(x[$__rate_interval])"))
	const p1 = `{"planned":{"query":"rate(x[1m])","expanded":"rate(x[1m])","bytes":11,"value_type":"vector","rate_candidate":false,"rate_applied":false,"histogram":false,"step_ms":5000},"start":1767225600000,`
	if rec.Code != 200 || !strings.HasPrefix(rec.Body.String(), p1) {
		t.Errorf("P1: %d %.300s", rec.Code, rec.Body.String())
	}
	s.add(t, rec)

	rec = postJSON(h, rangePath, rangeBody("x_total"))
	if b := s.add(t, rec); rec.Code != 200 || b.Planned == nil || b.Planned.Query != "rate(x_total[1m])" || !b.Planned.RateApplied || b.Planned.RateWindowMs != 60000 {
		t.Errorf("P2: %d %.300s", rec.Code, rec.Body.String())
	}
	if n := countPath(fake, "/api/v1/metadata"); n != 0 {
		t.Errorf("P1, P2: %d metadata requests", n)
	}

	rec = postJSON(h, rangePath, rangeBody("x_total", `"rate":false`))
	if b := s.add(t, rec); rec.Code != 200 || b.Planned == nil || b.Planned.Query != "x_total" || !b.Planned.RateCandidate || b.Planned.RateApplied {
		t.Errorf("P3: %d %.300s", rec.Code, rec.Body.String())
	}

	rec = postJSON(h, instantPath, instantBody("rate(x[$__rate_interval])", `"step_ms":15000`))
	body := rec.Body.String()
	if b := s.add(t, rec); rec.Code != 200 || !strings.HasPrefix(body, `{"planned":{"query":"rate(x[1m])"`) || b.Planned == nil ||
		b.Planned.StepMs != 15000 || !strings.Contains(body, `"step_ms":15000},"result_type":"vector"`) {
		t.Errorf("P4: %d %.300s", rec.Code, body)
	}

	before := len(fake.Requests())
	wantError(t, "P5", postJSON(h, instantPath, instantBody("rate(x[$__rate_interval])")), 400, "invalid", "/step_ms", "field.required")
	wantError(t, "P6", postJSON(h, instantPath, instantBody(`x{a="$__interval"}`)), 400, "invalid", "/step_ms", "field.required")
	if n := len(fake.Requests()) - before; n != 0 {
		t.Errorf("P5, P6: %d upstream requests", n)
	}
	assertAuthority(t, fake, s)
}

// itest:plan-authority (T06-029, ENT-006): rows A1–A7 of plan #112 A.5, and A2 over P1–P4, A1,
// A5 and E1–E4.
func TestPlanAuthority(t *testing.T) {
	fake, url := fakeharness.Start(t)
	h := plannedGateway(t, url, fixedNow)
	s := &served{}
	for _, c := range []struct{ path, body string }{
		{rangePath, rangeBody("rate(x[$__rate_interval])")},
		{rangePath, rangeBody("x_total")},
		{rangePath, rangeBody("x_total", `"rate":false`)},
		{instantPath, instantBody("rate(x[$__rate_interval])", `"step_ms":15000`)},
	} {
		s.add(t, postJSON(h, c.path, c.body))
	}

	rec := postJSON(h, rangePath, rangeBody("rate(x_total[1m])"))
	if b := s.add(t, rec); rec.Code != 200 || b.Planned == nil || b.Planned.Query != "rate(x_total[1m])" || b.Planned.RateCandidate {
		t.Errorf("A1: %d %.300s", rec.Code, rec.Body.String())
	}
	rec = postJSON(h, rangePath, rangeBody("x_total", `"vars":{"x":"1"}`))
	if b := s.add(t, rec); rec.Code != 200 || b.Planned == nil || b.Planned.Query != "rate(x_total[1m])" {
		t.Errorf("A5: %d %.300s", rec.Code, rec.Body.String())
	}
	for _, q := range []struct{ query, vars string }{
		{`x_total{job="a"}`, ""}, {`up{job="$r"}`, `"vars":{"r":"ab"}`}, {"y_total", ""}, {"z_total", ""},
	} {
		extra := []string{}
		if q.vars != "" {
			extra = append(extra, q.vars)
		}
		s.add(t, postJSON(h, rangePath, rangeBody(q.query, extra...)))
	}
	// A2
	assertAuthority(t, fake, s)

	before := len(fake.Requests())
	rec = postJSON(h, rangePath, rangeBody(`up{r="$r"}`))
	wantError(t, "A3", rec, 400, "invalid", "/vars/r", "variable.missing")
	if b := planBodyOf(t, rec); b.Error == nil || b.Error.Planned != nil {
		t.Errorf("A3: %s", rec.Body.String())
	}
	for _, c := range []struct{ name, body, reserved string }{
		{"A4", rangeBody("$m", `"vars":{"m":"ALERTS"}`), "ALERTS"},
		{"A6", rangeBody("ALERTS{"), "ALERTS"},
		{"A7", rangeBody("$metric > 0.8", `"vars":{"metric":"pulsus_anomaly_score"}`), "pulsus_anomaly_score"},
	} {
		e := wantError(t, c.name, postJSON(h, rangePath, c.body), 400, "virtual_unsupported", "/query", "query.reserved")
		if e.Error.Hint["reserved"] != c.reserved {
			t.Errorf("%s: hint %v", c.name, e.Error.Hint)
		}
	}
	if n := len(fake.Requests()) - before; n != 0 {
		t.Errorf("A3, A4, A6, A7: %d upstream requests", n)
	}
}

// itest:plan-authority with the DSF Accept (plan #68 D1 §5, T06-029): the range rows of A.5
// answered as DSF send the same upstream queries as their JSON runs, each the planned.query the
// body carries in dash.planned.
func TestPlanAuthorityDSF(t *testing.T) {
	sentQueries := func(accept string) []string {
		fake, url := fakeharness.Start(t)
		h := plannedGateway(t, url, fixedNow)
		for _, b := range []string{rangeBody("rate(x[$__rate_interval])"), rangeBody("x_total"), rangeBody("x_total", `"rate":false`),
			rangeBody("rate(x_total[1m])"), rangeBody("x_total", `"vars":{"x":"1"}`), rangeBody(`x_total{job="a"}`), rangeBody(`up{job="$r"}`, `"vars":{"r":"ab"}`)} {
			rec := serve(h, b, accept)
			if accept == "" || rec.Code != 200 {
				continue
			}
			p := wiretest.Read(t, rec.Body.Bytes())
			var planned struct {
				Query string `json:"query"`
			}
			if len(p.Parts) != 1 || p.Parts[0].Planned == nil || json.Unmarshal([]byte(*p.Parts[0].Planned), &planned) != nil {
				t.Fatalf("%s: no dash.planned", b)
			}
			if r := fake.Requests(); r[len(r)-1].Form.Get("query") != planned.Query {
				t.Errorf("%s: sent %q, planned %q", b, r[len(r)-1].Form.Get("query"), planned.Query)
			}
		}
		var out []string
		for _, r := range fake.Requests() {
			out = append(out, r.Method+" "+r.Path+" "+r.Form.Get("query"))
		}
		return out
	}
	if j, d := sentQueries(""), sentQueries(dsfAccept); !slices.Equal(j, d) || len(j) == 0 {
		t.Errorf("upstream requests differ:\n json %q\n dsf  %q", j, d)
	}
}

// docOf is Part B's helper: n bytes, a comment then an unclosed selector (unknown shape).
func docOf(n int) string { return "#" + strings.Repeat("a", n-10) + "\nup{job=\"" }

// itest:plan-sizes (T09-015): rows Z1–Z5 of plan #112 A.5.
func TestPlanSizes(t *testing.T) {
	fake, url := fakeharness.Start(t)
	h := plannedGateway(t, url, fixedNow)

	e := wantError(t, "Z1", postJSON(h, rangePath, rangeBody(docOf(131073))), 400, "invalid", "/query", "field.range")
	if e.Error.Message != "query must be 1 to 131072 bytes" {
		t.Errorf("Z1: %q", e.Error.Message)
	}
	n19 := `x_total{a="` + strings.Repeat("b", 65517) + `"}`
	rec := postJSON(h, rangePath, rangeBody(n19))
	wantError(t, "Z2", rec, 413, "invalid", "/query", "query.sent_too_large")
	if b := planBodyOf(t, rec); b.Error == nil || b.Error.Planned == nil || b.Error.Planned.Bytes != 65540 || !strings.HasPrefix(b.Error.Planned.Query, `rate(x_total{a="`) {
		t.Errorf("Z2: planned %+v", b.Error)
	}
	rec = postJSON(h, rangePath, rangeBody(docOf(100000)))
	wantError(t, "Z3", rec, 413, "invalid", "/query", "query.sent_too_large")
	if b := planBodyOf(t, rec); b.Error == nil || b.Error.Planned == nil || b.Error.Planned.Bytes != 100000 || len(b.Error.Planned.Query) != 100000 {
		t.Errorf("Z3: planned bytes")
	}
	c := "#" + strings.Repeat("a", 4095)
	rec = postJSON(h, rangePath, rangeBody(strings.Repeat("$c", 600)+"\nx_total", `"vars":{"c":`+jsonString(c)+`}`))
	e = wantError(t, "Z4", rec, 413, "invalid", "/query", "query.too_large_to_plan")
	if e.Error.Hint["reason"] != "processing_cap" || planBodyOf(t, rec).Error.Planned != nil {
		t.Errorf("Z4: %.300s", rec.Body.String())
	}
	if n := len(fake.Requests()); n != 0 {
		t.Errorf("Z1–Z4: %d upstream requests", n)
	}
	rec = postJSON(h, rangePath, rangeBody(strings.Repeat("$c", 40)+"\nx_total", `"vars":{"c":`+jsonString(c)+`}`))
	if b := planBodyOf(t, rec); rec.Code != 200 || b.Planned == nil || b.Planned.Query != "rate(x_total[1m])" || b.Planned.Bytes != 17 {
		t.Errorf("Z5: %d %.300s", rec.Code, rec.Body.String())
	}
	if got := fake.Requests(); len(got) != 1 || got[0].Form.Get("query") != "rate(x_total[1m])" {
		t.Errorf("Z5: upstream %d requests", len(got))
	}
}

// itest:plan-error-position (T09-009, ADR-0021 §3): rows E1–E4 of plan #112 A.5.
func TestPlanErrorPosition(t *testing.T) {
	_, url := fakeharness.Start(t)
	h := plannedGateway(t, url, fixedNow)
	for _, c := range []struct {
		name, body, planned string
		offset              int // -1: no position
	}{
		{"E1", rangeBody(`x_total{job="a"}`), `rate(x_total{job="a"}[1m])`, 14},
		{"E2", rangeBody(`up{job="$r"}`, `"vars":{"r":"ab"}`), `up{job="ab"}`, 8},
		{"E3", rangeBody("y_total"), "rate(y_total[1m])", -1},
		{"E4", rangeBody("z_total"), "rate(z_total[1m])", -1},
	} {
		rec := postJSON(h, rangePath, c.body)
		wantError(t, c.name, rec, 400, "invalid", "/query", "query.invalid")
		b := planBodyOf(t, rec)
		if b.Error == nil || b.Error.Planned == nil || b.Error.Planned.Query != c.planned {
			t.Errorf("%s: planned %.300s", c.name, rec.Body.String())
			continue
		}
		pos, has := b.Error.Hint["position"].(map[string]any)
		switch {
		case c.offset < 0 && has:
			t.Errorf("%s: position %v, want none", c.name, pos)
		case c.offset >= 0 && (!has || pos["offset"] != float64(c.offset)):
			t.Errorf("%s: position %v, want %d", c.name, b.Error.Hint["position"], c.offset)
		}
	}
}

// clock is a settable Deps.Now and CacheOptions.Now.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) now() time.Time  { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *clock) set(t time.Time) { c.mu.Lock(); defer c.mu.Unlock(); c.t = t }

// itest:metric-types-cache (ADR-0021 §2): rows M1–M4 of plan #112 A.5.
func TestMetricTypesCacheRoute(t *testing.T) {
	var metadata atomic.Int32
	var fail atomic.Bool
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/metadata":
			metadata.Add(1)
			if r.Form.Get("limit") != "10000" {
				t.Errorf("metadata limit %q", r.Form.Get("limit"))
			}
			if fail.Load() {
				w.WriteHeader(http.StatusBadGateway)
				_, _ = w.Write([]byte(`{"status":"error","errorType":"internal","error":"down"}`))
				return
			}
			_, _ = w.Write([]byte(`{"status":"success","data":{"x_c":[{"type":"counter","help":"","unit":""}]}}`))
		case "/api/v1/query_range":
			_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[]}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer up.Close()
	clk := &clock{t: goldenNow}
	h := plannedGateway(t, up.URL, clk.now)
	run := func(name, path string, wantQuery string) planBody {
		t.Helper()
		rec := postJSON(h, path, rangeBody("x_c"))
		b := planBodyOf(t, rec)
		if rec.Code != 200 || b.Planned == nil || b.Planned.Query != wantQuery {
			t.Errorf("%s: %d %.300s", name, rec.Code, rec.Body.String())
		}
		return b
	}
	run("M1 t0", rangePath, "rate(x_c[1m])")
	clk.set(goldenNow.Add(59 * time.Second))
	run("M1 t0+59s", rangePath, "rate(x_c[1m])")
	if n := metadata.Load(); n != 1 {
		t.Errorf("M1: %d metadata requests", n)
	}
	clk.set(goldenNow.Add(61 * time.Second))
	run("M2", rangePath, "rate(x_c[1m])")
	if n := metadata.Load(); n != 2 {
		t.Errorf("M2: %d metadata requests", n)
	}
	run("M3", strings.Replace(rangePath, "tenant=demo", "tenant=demo2", 1), "rate(x_c[1m])")
	if n := metadata.Load(); n != 3 {
		t.Errorf("M3: %d metadata requests", n)
	}

	fail.Store(true)
	metadata.Store(0)
	clk.set(goldenNow)
	h = plannedGateway(t, up.URL, clk.now)
	for i := range 2 {
		clk.set(goldenNow.Add(time.Duration(i) * 2 * time.Second))
		b := run("M4 "+strconv.Itoa(i), rangePath, "x_c")
		if len(b.Completeness.Warnings) == 0 || b.Completeness.Warnings[0] != promplan.WarnTypesUnavailable || b.Planned == nil || b.Planned.RateCandidate {
			t.Errorf("M4 %d: warnings %q", i, b.Completeness.Warnings)
		}
	}
	if n := metadata.Load(); n != 1 {
		t.Errorf("M4: %d metadata requests", n)
	}
}

// itest:plan-sizes (code review r1): the step macros at the resolved step count against the
// processing cap. 510 × a 4 096-byte value and 3 000 × $__interval fit the cap with the "1s"
// placeholders but not as "1500ms": 413 processing_cap, no planned, no upstream request.
func TestPlanMacroCap(t *testing.T) {
	fake, url := fakeharness.Start(t)
	h := plannedGateway(t, url, fixedNow)
	c := "#" + strings.Repeat("a", 4095)
	q := strings.Repeat("$c", 510) + strings.Repeat("$__interval", 3000)
	rec := postJSON(h, instantPath, instantBody(q, `"vars":{"c":`+jsonString(c)+`}`, `"step_ms":1500`))
	e := wantError(t, "macro cap", rec, 413, "invalid", "/query", "query.too_large_to_plan")
	if e.Error.Hint["reason"] != "processing_cap" || planBodyOf(t, rec).Error.Planned != nil {
		t.Errorf("macro cap: %.300s", rec.Body.String())
	}
	if n := len(fake.Requests()); n != 0 {
		t.Errorf("%d upstream requests", n)
	}
}

// Review r2: the resolved-step cap is checked before tenant resolution and any metadata read. A
// bare selector after the comment needs metric types, yet the 413 comes with no upstream request.
func TestPlanMacroCapBeforeTypes(t *testing.T) {
	fake, url := fakeharness.Start(t)
	h := plannedGateway(t, url, fixedNow)
	c := "#" + strings.Repeat("a", 4095)
	q := strings.Repeat("$c", 510) + strings.Repeat("$__interval", 3000) + "\nx"
	rec := postJSON(h, instantPath, instantBody(q, `"vars":{"c":`+jsonString(c)+`}`, `"step_ms":1500`))
	e := wantError(t, "macro cap, bare selector", rec, 413, "invalid", "/query", "query.too_large_to_plan")
	if e.Error.Hint["reason"] != "processing_cap" || planBodyOf(t, rec).Error.Planned != nil {
		t.Errorf("%.300s", rec.Body.String())
	}
	if n := len(fake.Requests()); n != 0 {
		t.Errorf("%d upstream requests (metadata included), want 0", n)
	}
}

// promqlCase is a plan case of the shared fixture, as this file reads it.
type promqlCase struct {
	Name   string `json:"name"`
	Inputs struct {
		Query string            `json:"query"`
		Vars  map[string]string `json:"vars"`
	} `json:"inputs"`
	Planned *struct {
		Query string `json:"query"`
	} `json:"planned"`
	Error *struct {
		Message string `json:"message"`
		Fields  []struct {
			Pointer    string `json:"pointer"`
			MessageKey string `json:"message_key"`
		} `json:"fields"`
	} `json:"error"`
}

// promqlValueCases are the #118 cases of wire/fixtures/plan/promql.json by their Q number.
func promqlValueCases(t *testing.T) map[string]promqlCase {
	t.Helper()
	b, err := os.ReadFile("../../../wire/fixtures/plan/promql.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Plan []json.RawMessage `json:"plan"`
	}
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	out := map[string]promqlCase{}
	for _, raw := range f.Plan {
		var c promqlCase
		// A case whose query is a {"concat": …} Text is not one of the Q cases.
		if json.Unmarshal(raw, &c) != nil || !strings.HasPrefix(c.Name, "Q") {
			continue
		}
		out[strings.Fields(c.Name)[0]] = c
	}
	return out
}

// valueUpstream answers the range route with an empty matrix and the metadata route with no
// metric types, recording every request.
func valueUpstream(t *testing.T) *logUpstream {
	return newLogUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/query_range":
			writeJSONBody(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
		case "/api/v1/metadata":
			writeJSONBody(w, `{"status":"success","data":{}}`)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
}

func valuesBody(c promqlCase) string {
	vars, _ := json.Marshal(c.Inputs.Vars)
	return rangeBody(c.Inputs.Query, `"vars":`+string(vars))
}

func pathCount(rs []upReq, path string) int {
	n := 0
	for _, r := range rs {
		if r.Path == path {
			n++
		}
	}
	return n
}

// itest:plan-authority (PromQL, plan #118 §5.1): the value cases of promql.json are sent as
// planned, or refused with variable.unrepresentable and no upstream request (T06-029).
func TestPromqlValuesInStrings(t *testing.T) {
	cases := promqlValueCases(t)
	up := valueUpstream(t)
	h := plannedGateway(t, up.URL, fixedNow)
	get := func(q string) promqlCase {
		t.Helper()
		c, ok := cases[q]
		if !ok {
			t.Fatalf("%s: not in the fixture", q)
		}
		return c
	}
	refused := func(q string, rec *httptest.ResponseRecorder, c promqlCase) {
		t.Helper()
		if rec.Code != 400 {
			t.Errorf("%s: status %d, want 400 (body %.300s)", q, rec.Code, rec.Body.String())
			return
		}
		e := errEnvelopeOf(t, rec.Body.Bytes())
		if e.Error.Code != "invalid" || c.Error == nil || e.Error.Message != c.Error.Message || len(e.Error.Fields) != len(c.Error.Fields) {
			t.Errorf("%s: %.300s", q, rec.Body.String())
			return
		}
		for i, f := range c.Error.Fields {
			if e.Error.Fields[i].Pointer != f.Pointer || e.Error.Fields[i].MessageKey != f.MessageKey {
				t.Errorf("%s: field %d %+v, want %+v", q, i, e.Error.Fields[i], f)
			}
		}
		if b := planBodyOf(t, rec); b.Planned != nil || (b.Error != nil && b.Error.Planned != nil) {
			t.Errorf("%s: a refusal carries a plan: %.300s", q, rec.Body.String())
		}
	}
	for _, q := range []string{"Q1", "Q2", "Q3", "Q4", "Q5", "Q7", "Q8", "Q11", "Q12", "Q13", "Q14", "Q17", "Q19",
		"Q24", "Q26", "Q27", "Q28", "Q29", "Q30"} {
		c := get(q)
		up.reset()
		rec := postJSON(h, rangePath, valuesBody(c))
		rs := up.requests()
		sent := make([]string, 0, len(rs))
		for _, r := range rs {
			sent = append(sent, r.Path+" "+r.Form.Get("query"))
		}
		b := planBodyOf(t, rec)
		if rec.Code != 200 || c.Planned == nil || b.Planned == nil || len(rs) != 1 || rs[0].Path != "/api/v1/query_range" ||
			rs[0].Form.Get("query") != c.Planned.Query || b.Planned.Query != c.Planned.Query {
			t.Errorf("%s: %d %.300s, upstream %q", q, rec.Code, rec.Body.String(), sent)
		}
	}
	for _, q := range []string{"Q6", "Q9", "Q10", "Q15", "Q16", "Q20"} {
		c := get(q)
		up.reset()
		rec := postJSON(h, rangePath, valuesBody(c))
		refused(q, rec, c)
		if n := len(up.requests()); n != 0 {
			t.Errorf("%s: %d upstream requests, want 0", q, n)
		}
	}

	// Q23 needs metric types if planned: on a fresh gateway, so no earlier case filled the cache.
	c := get("Q23")
	up23 := valueUpstream(t)
	h23 := plannedGateway(t, up23.URL, fixedNow)
	refused("Q23", postJSON(h23, rangePath, valuesBody(c)), c)
	rs := up23.requests()
	if n := pathCount(rs, "/api/v1/metadata"); n != 0 {
		t.Errorf("Q23: %d /api/v1/metadata requests, want 0", n)
	}
	if n := pathCount(rs, "/api/v1/query_range"); n != 0 {
		t.Errorf("Q23: %d /api/v1/query_range requests, want 0", n)
	}
}
