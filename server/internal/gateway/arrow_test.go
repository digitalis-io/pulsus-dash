package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/arrowwire"
	"github.com/digitalis-io/pulsus-dash/server/internal/arrowwire/wiretest"
	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	promplan "github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/prom"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake/fakeharness"
)

// serveDSF serves body with the DSF Accept on h; a connection reset (the handler panicking with
// http.ErrAbortHandler) fails the test instead of the binary.
func serveDSF(t *testing.T, h http.Handler, body string) (rec *httptest.ResponseRecorder) {
	t.Helper()
	defer func() {
		if v := recover(); v != nil {
			t.Errorf("the handler reset the connection: %v", v)
			rec = httptest.NewRecorder()
		}
	}()
	return serve(h, body, dsfAccept)
}

// readDSF checks a 200 DSF response and reads its body.
func readDSF(t *testing.T, what string, rec *httptest.ResponseRecorder) wiretest.Body {
	t.Helper()
	if rec.Code != 200 || rec.Header().Get("Content-Type") != arrowwire.ContentType {
		t.Fatalf("%s: %d %q: %.300s", what, rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
	return wiretest.Read(t, rec.Body.Bytes())
}

// onePart is the body's one data part.
func onePart(t *testing.T, what string, b wiretest.Body) wiretest.Part {
	t.Helper()
	if len(b.Parts) != 1 || !b.Ended {
		t.Fatalf("%s: %d parts, ended %v: %s", what, len(b.Parts), b.Ended, b)
	}
	return b.Parts[0]
}

// plannedOf is the planned member's bytes of a PromQL JSON range body.
func plannedOf(t *testing.T, body []byte) string {
	t.Helper()
	s, ok := bytes.CutPrefix(body, []byte(`{"planned":`))
	i := bytes.Index(s, []byte(`,"start":`))
	if !ok || i < 0 {
		t.Fatalf("no planned member: %.200s", body)
	}
	return string(s[:i])
}

// unit:range-negotiation (§3.1): the formats by Accept, Vary on every response, the JSON body
// byte for byte as the golden file of today's handler.
func TestRangeNegotiation(t *testing.T) {
	_, url := fakeharness.Start(t)
	h, _ := queryGateway(t, url, pulsusdb.Options{})
	golden, err := os.ReadFile("../../../wire/fixtures/json/promql-range-counter.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, accept := range []string{"", "application/json", "*/*", "application/*", "application/vnd.pulsus.dash-stream;v=2",
		"application/vnd.pulsus.dash-stream;q=0", "text/html, application/json;q=0.9", "application/vnd.pulsus.dash-streams"} {
		rec := serve(h, counterReq, accept)
		if rec.Code != 200 || rec.Header().Get("Content-Type") != "application/json" || !bytes.Equal(rec.Body.Bytes(), golden) {
			t.Errorf("Accept %q: %d %q, body equal to the golden file: %v", accept, rec.Code, rec.Header().Get("Content-Type"), bytes.Equal(rec.Body.Bytes(), golden))
		}
		if v := rec.Header().Values("Vary"); !reflect.DeepEqual(v, []string{"Accept"}) {
			t.Errorf("Accept %q: Vary %q", accept, v)
		}
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("Accept %q: Cache-Control %q", accept, rec.Header().Get("Cache-Control"))
		}
	}
	for _, accept := range []string{dsfAccept, "application/vnd.pulsus.dash-stream", "APPLICATION/VND.PULSUS.DASH-STREAM; V=1",
		"application/json;q=0.5, application/vnd.pulsus.dash-stream;v=1;q=0.9", `application/vnd.pulsus.dash-stream; v="1"`,
		"application/vnd.pulsus.dash-stream;v=2, application/vnd.pulsus.dash-stream;v=1"} {
		rec := serve(h, counterReq, accept)
		if rec.Code != 200 || rec.Header().Get("Content-Type") != arrowwire.ContentType {
			t.Errorf("Accept %q: %d %q", accept, rec.Code, rec.Header().Get("Content-Type"))
			continue
		}
		if v := rec.Header().Values("Vary"); !reflect.DeepEqual(v, []string{"Accept"}) || rec.Header().Get("Cache-Control") != "no-store" {
			t.Errorf("Accept %q: Vary %q, Cache-Control %q", accept, v, rec.Header().Get("Cache-Control"))
		}
		if b := wiretest.Read(t, rec.Body.Bytes()); len(b.Parts) != 1 || len(b.Parts[0].Series) != 2 || !b.Ended {
			t.Errorf("Accept %q: body %s", accept, b)
		}
	}
	rec := serve(h, `{"from":1767225600000,"to":1767229200000,"width_px":1200}`, dsfAccept)
	wantError(t, "missing query", rec, 400, "invalid", "/query", "field.required")
	if rec.Header().Get("Content-Type") != "application/json" || rec.Header().Get("Vary") != "Accept" {
		t.Errorf("400: %q, Vary %q", rec.Header().Get("Content-Type"), rec.Header().Get("Vary"))
	}
}

// An empty result finishes the empty part: zero series, the final coverage, no Add (r3 #2).
func TestRangeArrowEmpty(t *testing.T) {
	h, _, _ := routeGateway(t, rangeTranscript(nil, map[string]string{"X-Pulsus-Query-Id": "fake-route-2"}))
	p := onePart(t, "empty", readDSF(t, "empty", serveDSF(t, h, rangeReq("rate(req_total[5m])", hourWindow))))
	c := p.Final()
	if len(p.Series) != 0 || p.Error != nil || !p.Closed || c == nil || c.Phase != uint8(arrowwire.PhaseFinal) || c.SeriesReturned != 0 ||
		!reflect.DeepEqual(c.UpstreamQueryIDs, []string{"fake-route-2"}) || c.DataEnd != nil || c.Truncated {
		t.Errorf("empty part: %d series, error %+v, closed %v, final %+v", len(p.Series), p.Error, p.Closed, c)
	}
}

// blockingUpstream sends one series, then holds the rest until release is closed (or the
// request ends, which it reports on gone).
func blockingUpstream(t *testing.T, release <-chan struct{}, gone chan<- struct{}) *httptest.Server {
	t.Helper()
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"api"},"values":[[1767225600,"1"]]}`)
		_ = http.NewResponseController(w).Flush()
		select {
		case <-release:
			_, _ = io.WriteString(w, `,{"metric":{"job":"web"},"values":[[1767225615,"2"]]}]}}`)
		case <-r.Context().Done():
			if gone != nil {
				close(gone)
			}
		}
	}))
	t.Cleanup(up.Close)
	return up
}

// T04-006, T06-029: the first batch arrives while the upstream holds the rest; the final frames
// after it; dash.planned is the JSON body's planned bytes.
func TestRangeArrowBody(t *testing.T) {
	release := make(chan struct{})
	released := false
	defer func() {
		if !released {
			close(release)
		}
	}()
	up := blockingUpstream(t, release, nil)
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	srv := httptest.NewServer(h)
	defer srv.Close()
	req, err := http.NewRequest(http.MethodPost, srv.URL+rangePath, strings.NewReader(counterReq))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Accept", dsfAccept)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 || resp.Header.Get("Content-Type") != arrowwire.ContentType {
		t.Fatalf("%d %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	frames := make(chan arrowwire.Header, 64)
	var body bytes.Buffer
	var mu sync.Mutex
	go func() {
		defer close(frames)
		hdr := make([]byte, arrowwire.HeaderLen)
		for {
			if _, err := io.ReadFull(resp.Body, hdr); err != nil {
				return
			}
			fh, err := arrowwire.ParseHeader(hdr)
			if err != nil {
				return
			}
			payload := make([]byte, fh.PayloadLen)
			if _, err := io.ReadFull(resp.Body, payload); err != nil {
				return
			}
			mu.Lock()
			body.Write(hdr)
			body.Write(payload)
			mu.Unlock()
			frames <- fh
		}
	}()
	next := func(what string) arrowwire.Header {
		t.Helper()
		select {
		case fh, ok := <-frames:
			if !ok {
				t.Fatalf("%s: the body ended", what)
			}
			return fh
		case <-time.After(3 * time.Second):
			t.Fatalf("%s: no frame within 3 s: the gateway buffers", what)
		}
		return arrowwire.Header{}
	}
	want := []struct {
		typ  arrowwire.FrameType
		part uint32
	}{{arrowwire.FrameSchema, 1}, {arrowwire.FrameMeta, 2}, {arrowwire.FrameSchema, 2}, {arrowwire.FrameBatch, 1}, {arrowwire.FrameBatch, 2}}
	for i, w := range want {
		if fh := next("first batch"); fh.Type != w.typ || fh.PartID != w.part {
			t.Fatalf("frame %d: type %d part %d, want %d %d", i, fh.Type, fh.PartID, w.typ, w.part)
		}
	}
	close(release)
	released = true
	var last []arrowwire.Header
	for fh := range frames {
		last = append(last, fh)
	}
	n := len(last)
	if n < 2 || last[n-2].Type != arrowwire.FrameMeta || last[n-2].PartID != 2 || last[n-2].Flags&arrowwire.FlagLast == 0 || last[n-1].Type != arrowwire.FrameEnd {
		t.Fatalf("final frames %+v, want META(2)|LAST then END", last)
	}
	mu.Lock()
	b := wiretest.Read(t, body.Bytes())
	mu.Unlock()
	p := onePart(t, "body", b)
	if p.LabelsPart != 1 || p.DataPart != 2 || p.StartMs != 1767225600000 || p.RequestedStartMs != 1767225600000 || p.StepMs != 15000 ||
		p.Len != 241 || p.Result != "metric" || p.Source != "pulsusdb" || len(p.Series) != 2 || p.Error != nil {
		t.Errorf("part %+v", p)
	}
	jsonBody := serve(h, counterReq, "")
	if want := plannedOf(t, jsonBody.Body.Bytes()); p.Planned == nil || *p.Planned != want {
		t.Errorf("dash.planned %v, want the JSON body's planned bytes %s", p.Planned, want)
	}
}

// wantRow is the error/1 row of each failure class (§3.4).
var wantRow = map[string]wiretest.Error{
	"query-invalid": {Code: 0, HTTPStatus: 400, Message: "1:13: parse error: unexpected character inside braces", Position: ptrTo(uint32(7))},
	"too-broad":     {Code: 1, HTTPStatus: 422, Message: "the selector matches too many series", Suggestion: ptrTo("narrow")},
	"rate-limited":  {Code: 7, HTTPStatus: 429, Message: "PulsusDB is rate limiting this tenant", RetryAfterMs: ptrTo(uint32(7000))},
	"timeout":       {Code: 5, HTTPStatus: 504, Message: "the query timed out", Suggestion: ptrTo("narrow")},
	"unavailable":   {Code: 4, HTTPStatus: 502, Message: "PulsusDB is unavailable"},
	"internal":      {Code: 8, HTTPStatus: 500, Message: "internal error"},
}

func ptrTo[T any](v T) *T { return &v }

// T04-012: a failure after the header ends the part in band (error/1 per §3.4, a partial coverage
// from the completeness so far, series_returned the series written), END, no reset.
func TestRangeArrowFailure(t *testing.T) {
	for _, c := range failClasses {
		t.Run(c.name, func(t *testing.T) {
			h, _, logs := routeGateway(t, rangeTranscript(twoSeries(), map[string]string{"X-Pulsus-Query-Id": "fake-route-1"}))
			injectFailure(t, 2, c.err)
			p := onePart(t, c.name, readDSF(t, c.name, serveDSF(t, h, rangeReq(failQuery, hourWindow))))
			cov := p.Final()
			if p.Error == nil || !reflect.DeepEqual(*p.Error, wantRow[c.name]) {
				t.Errorf("error row %+v, want %+v", p.Error, wantRow[c.name])
			}
			if cov == nil || cov.Phase != uint8(arrowwire.PhasePartial) || cov.SeriesReturned != 1 || len(p.Series) != 1 ||
				!reflect.DeepEqual(cov.UpstreamQueryIDs, []string{"fake-route-1"}) || cov.DataEnd == nil || *cov.DataEnd != 1795093200000 {
				t.Errorf("%d series, coverage %+v", len(p.Series), cov)
			}
			if !strings.Contains(logs.String(), `"msg":"promql_stream_failed"`) {
				t.Errorf("no promql_stream_failed record")
			}
		})
	}
	t.Run("pending", func(t *testing.T) {
		ss := append(twoSeries(), hourSeries(map[string]string{"job": "c"}, plain), hourSeries(map[string]string{"job": "d"}, plain),
			hourSeries(map[string]string{"job": "e"}, plain))
		h, _, _ := routeGateway(t, rangeTranscript(ss, nil))
		injectFailure(t, 5, failClasses[4].err)
		p := onePart(t, "pending", readDSF(t, "pending", serveDSF(t, h, rangeReq(failQuery, hourWindow))))
		if cov := p.Final(); cov == nil || cov.SeriesReturned != 1 || len(p.Series) != 1 || p.Error == nil {
			t.Errorf("3 pending: %d series decoded, coverage %+v", len(p.Series), cov)
		}
	})
	t.Run("types-warning", func(t *testing.T) {
		h, _, _ := routeGateway(t, metadataTranscript(504), rangeTranscript(twoSeries(), nil))
		injectFailure(t, 2, failClasses[4].err)
		p := onePart(t, "types-warning", readDSF(t, "types-warning", serveDSF(t, h, rangeReq("x_c", hourWindow))))
		if cov := p.Final(); cov == nil || cov.Phase != uint8(arrowwire.PhasePartial) || len(cov.Warnings) == 0 || cov.Warnings[0] != promplan.WarnTypesUnavailable {
			t.Errorf("coverage %+v, want partial with the types warning", cov)
		}
	})
	t.Run("real upstream", func(t *testing.T) {
		up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"api"},"values":[[1767225600,"1"]]},`)
			_ = http.NewResponseController(w).Flush()
			if conn, _, err := http.NewResponseController(w).Hijack(); err == nil {
				_ = conn.Close()
			}
		}))
		defer up.Close()
		h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
		p := onePart(t, "real", readDSF(t, "real", serveDSF(t, h, counterReq)))
		if p.Error == nil || p.Error.Code != 4 || p.Error.HTTPStatus != 502 || len(p.Series) != 1 {
			t.Errorf("error %+v, %d series", p.Error, len(p.Series))
		}
	})
}

// TestRangeJSONMidFailure (r2 #4): without the DSF Accept a failure after the first frame still
// resets the connection.
func TestRangeJSONMidFailure(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"api"},"values":[[1767225600,"1"]]},`)
		_ = http.NewResponseController(w).Flush()
		if conn, _, err := http.NewResponseController(w).Hijack(); err == nil {
			_ = conn.Close()
		}
	}))
	defer up.Close()
	h, logs := queryGateway(t, up.URL, pulsusdb.Options{})
	srv := httptest.NewServer(h)
	defer srv.Close()
	resp, err := http.Post(srv.URL+rangePath, "application/json", strings.NewReader(counterReq))
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err == nil || json.Valid(b) || resp.Header.Get("Vary") != "Accept" {
		t.Errorf("JSON mid-failure: read error %v, valid %v, Vary %q", err, json.Valid(b), resp.Header.Get("Vary"))
	}
	if !strings.Contains(logs.String(), `"msg":"promql_stream_aborted"`) {
		t.Error("no promql_stream_aborted record")
	}
}

// r2 #1: series_returned counts the pending series Finish commits.
func TestRangeArrowFinishPending(t *testing.T) {
	ss := append(twoSeries(), hourSeries(map[string]string{"job": "c"}, plain), hourSeries(map[string]string{"job": "d"}, plain))
	h, _, _ := routeGateway(t, rangeTranscript(ss, nil))
	p := onePart(t, "pending", readDSF(t, "pending", serveDSF(t, h, rangeReq("rate(req_total[5m])", hourWindow))))
	if cov := p.Final(); cov == nil || cov.Phase != uint8(arrowwire.PhaseFinal) || cov.SeriesReturned != 4 || len(p.Series) != 4 {
		t.Errorf("%d series decoded, coverage %+v", len(p.Series), cov)
	}
}

// r2 #3: a mid-stream position is mapped to the raw text as the envelope's; none inside a rewrite.
func TestRangeArrowPosition(t *testing.T) {
	for _, c := range []struct {
		name    string
		planned int
		want    *uint32
	}{{"mapped", 12, ptrTo(uint32(7))}, {"inside the rewrite", 2, nil}} {
		t.Run(c.name, func(t *testing.T) {
			h, _, _ := routeGateway(t, rangeTranscript(twoSeries(), nil))
			err := &pulsusdb.Error{Kind: pulsusdb.KindQueryInvalid, Status: 400, Message: "bad", Position: &pulsusdb.Position{Offset: c.planned}}
			injectFailure(t, 2, err)
			p := onePart(t, c.name, readDSF(t, c.name, serveDSF(t, h, rangeReq(failQuery, hourWindow))))
			if p.Error == nil || !reflect.DeepEqual(p.Error.Position, c.want) {
				t.Errorf("row %+v, want position %v", p.Error, c.want)
			}
			injectFailure(t, 1, err)
			e := wantError(t, c.name, serve(h, rangeReq(failQuery, hourWindow), dsfAccept), 400, "invalid", "/query", "query.invalid")
			pos, has := e.Error.Hint["position"].(map[string]any)
			switch {
			case c.want == nil && has:
				t.Errorf("envelope position %v, want none", pos)
			case c.want != nil && (!has || pos["offset"] != float64(*c.want)):
				t.Errorf("envelope position %v, want %d", e.Error.Hint["position"], *c.want)
			}
		})
	}
}

// failingWriter is a ResponseWriter whose failAt-th Write fails; it counts the writes.
type failingWriter struct {
	mu      sync.Mutex
	hdr     http.Header
	code    int
	writes  int
	failAt  int
	body    bytes.Buffer
	onFirst func()
}

func (f *failingWriter) Header() http.Header { return f.hdr }
func (f *failingWriter) WriteHeader(c int)   { f.code = c }
func (f *failingWriter) Flush()              {}
func (f *failingWriter) Write(b []byte) (int, error) {
	f.mu.Lock()
	f.writes++
	n, cb := f.writes, f.onFirst
	f.mu.Unlock()
	if n == 1 && cb != nil {
		defer cb()
	}
	if n == f.failAt {
		return 0, errors.New("connection broke")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.body.Write(b)
}

func (f *failingWriter) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.writes
}

// countSeries counts the reads of an upstream series until t ends.
func countSeries(t *testing.T) *int {
	t.Helper()
	prev, n := nextSeries, 0
	nextSeries = func(rs *pulsusdb.ResultStream) (*pulsusdb.Series, error) {
		n++
		return prev(rs)
	}
	t.Cleanup(func() { nextSeries = prev })
	return &n
}

// §3.3: the writer outcomes.
func TestRangeArrowOutcomes(t *testing.T) {
	t.Run("grid refused", func(t *testing.T) {
		l := testLimits(t)
		l.OpenParts = 0
		withLimits(t, l)
		h, _, _ := routeGateway(t, rangeTranscript(twoSeries(), nil))
		b := readDSF(t, "refused", serveDSF(t, h, rangeReq("rate(req_total[5m])", hourWindow)))
		if len(b.Parts) != 0 || len(b.Errors) != 1 || b.Errors[0].Code != 8 || !b.Ended {
			t.Errorf("refused body %s, errors %+v", b, b.Errors)
		}
	})
	t.Run("planned too large", func(t *testing.T) {
		fake := pulsusfake.New([]pulsusfake.Transcript{rangeTranscript(twoSeries(), nil)}, pulsusfake.Options{})
		up := httptest.NewServer(fake)
		defer up.Close()
		client := pulsusdb.New(pulsusdb.Options{Logger: slog.New(slog.DiscardHandler)})
		rc := &core.RequestCtx{Tenant: core.TenantCtx{Org: pdbOrg, Binding: core.TenantBinding{OrgID: pdbOrg, ID: demoBindingID, Slug: "demo",
			DatasourceURL: up.URL, Kind: "pulsusdb"}}, Principal: core.LocalPrincipal, Scope: core.FullTenantScope(), Actor: core.LocalActor()}
		g, err := pulsusdb.PromGrid(1795089600000, 1795093200000, 60)
		if err != nil {
			t.Fatal(err)
		}
		rs, err := client.QueryRange(context.Background(), rc, pulsusdb.RangeQuery{Query: "up", Start: time.UnixMilli(g.Start), End: time.UnixMilli(g.End),
			Step: time.Minute, Timeout: 10 * time.Second})
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rs.Close() }()
		first, err := rs.Next()
		if err != nil {
			t.Fatal(err)
		}
		q := &dataRoutes{d: Deps{Logger: slog.New(slog.DiscardHandler), Now: func() time.Time { return routeNow }}}
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, rangePath, nil)
		big := append(append([]byte(`{"query":"`), bytes.Repeat([]byte("a"), arrowwire.MaxPayload)...), `"}`...)
		q.streamArrow(rec, req, rc, streamHead{planned: big}, promplan.Planned{}, rs, g, g.Start, first)
		b := readDSF(t, "planned too large", rec)
		if len(b.Parts) != 0 || len(b.Errors) != 1 || b.Errors[0].Code != 8 || !b.Ended {
			t.Errorf("body %s, errors %+v", b, b.Errors)
		}
	})
	t.Run("shape", func(t *testing.T) {
		ss := append(twoSeries(), hourSeries(map[string]string{"job": "c"}, plain))
		h, _, logs := routeGateway(t, rangeTranscript(ss, nil))
		prev, n := nextSeries, 0
		nextSeries = func(rs *pulsusdb.ResultStream) (*pulsusdb.Series, error) {
			n++
			s, err := prev(rs)
			if n == 2 && s != nil {
				short := *s
				short.Values, short.Present = s.Values[:3], s.Present[:3]
				return &short, err
			}
			return s, err
		}
		defer func() { nextSeries = prev }()
		p := onePart(t, "shape", readDSF(t, "shape", serveDSF(t, h, rangeReq("rate(req_total[5m])", hourWindow))))
		if p.Error == nil || p.Error.Code != 8 || p.Error.Message != "writer refused: shape" || !p.Closed || n != 2 {
			t.Errorf("shape: error %+v, closed %v, %d upstream reads (want 2)", p.Error, p.Closed, n)
		}
		if !strings.Contains(logs.String(), "promql_stream_refused") {
			t.Error("no promql_stream_refused record")
		}
	})
	t.Run("limit", func(t *testing.T) {
		withLimits(t, testLimits(t))
		h, _, _ := routeGateway(t, rangeTranscript(manySeries(600), nil))
		n := countSeries(t)
		p := onePart(t, "limit", readDSF(t, "limit", serveDSF(t, h, rangeReq("rate(req_total[5m])", shortWindow))))
		if cov := p.Final(); cov == nil || !cov.Truncated || cov.TruncationReason == nil || *cov.TruncationReason != "wire_limit" || *n >= 600 {
			t.Errorf("limit: coverage %+v, %d upstream reads", cov, *n)
		}
	})
	t.Run("io", func(t *testing.T) {
		h, _, logs := routeGateway(t, rangeTranscript(manySeries(600), nil))
		n := countSeries(t)
		fw := &failingWriter{hdr: http.Header{}, failAt: 2}
		req := httptest.NewRequest(http.MethodPost, rangePath, strings.NewReader(rangeReq("rate(req_total[5m])", shortWindow)))
		req.Header.Set("Accept", dsfAccept)
		h.ServeHTTP(fw, req)
		frames := wiretest.Split(t, fw.body.Bytes())
		for _, f := range frames {
			if f.Type == arrowwire.FrameEnd {
				t.Error("END written after the failed write")
			}
		}
		if fw.count() != 2 || *n >= 600 {
			t.Errorf("%d writes (want 2), %d upstream reads", fw.count(), *n)
		}
		if !strings.Contains(logs.String(), `"msg":"promql_stream_write_failed"`) {
			t.Error("no promql_stream_write_failed record")
		}
	})
}

// The client cancels after the first flush: the handler returns, the upstream request ends, and
// nothing more is written.
func TestRangeArrowCancel(t *testing.T) {
	release, gone := make(chan struct{}), make(chan struct{})
	defer close(release)
	up := blockingUpstream(t, release, gone)
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first := make(chan struct{})
	fw := &failingWriter{hdr: http.Header{}, onFirst: func() { close(first) }}
	req := httptest.NewRequest(http.MethodPost, rangePath, strings.NewReader(counterReq)).WithContext(ctx)
	req.Header.Set("Accept", dsfAccept)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() { _ = recover() }()
		h.ServeHTTP(fw, req)
	}()
	select {
	case <-first:
	case <-time.After(3 * time.Second):
		t.Fatal("no first flush")
	}
	writes := fw.count()
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the handler did not return after the cancel")
	}
	select {
	case <-gone:
	case <-time.After(3 * time.Second):
		t.Fatal("the upstream request was not closed")
	}
	if fw.count() != writes {
		t.Errorf("%d writes after the cancel", fw.count()-writes)
	}
}

// T04-010: with limits-test.json the part auto-closes with wire_limit; the body still ends.
func TestRangeArrowLimits(t *testing.T) {
	withLimits(t, testLimits(t))
	h, _, _ := routeGateway(t, rangeTranscript(manySeries(600), nil))
	p := onePart(t, "limits", readDSF(t, "limits", serveDSF(t, h, rangeReq("rate(req_total[5m])", shortWindow))))
	cov := p.Final()
	if cov == nil || cov.Phase != uint8(arrowwire.PhaseFinal) || !cov.Truncated || cov.TruncationReason == nil || *cov.TruncationReason != "wire_limit" ||
		int(cov.SeriesReturned) != len(p.Series) || len(p.Series) == 0 || len(p.Series) >= 600 || p.Error != nil {
		t.Errorf("%d series, coverage %+v", len(p.Series), cov)
	}
}

// bench:json-to-arrow (T06, report-only): the many case's body as JSON and as DSF.
func BenchmarkRangeBody(b *testing.B) {
	h, _, _ := routeGateway(b, rangeTranscript(manySeries(600), nil))
	body := rangeReq("rate(req_total[5m])", shortWindow)
	for _, c := range []struct{ name, accept string }{{"json", ""}, {"dsf", dsfAccept}} {
		b.Run(c.name, func(b *testing.B) {
			var n int
			for b.Loop() {
				rec := serve(h, body, c.accept)
				if rec.Code != 200 {
					b.Fatalf("%d", rec.Code)
				}
				n = rec.Body.Len()
			}
			b.ReportMetric(float64(n), "body_bytes")
		})
	}
}

// ENT-006, T06-002 (review r1 #1): a restricted, an empty and an unset data scope are denied
// with DSF asked for exactly as with JSON (the same status and envelope, Vary: Accept), and no
// upstream query is sent.
func TestRangeDSFScopeDenied(t *testing.T) {
	for _, c := range []struct {
		name  string
		scope core.DataScope
	}{
		{"restricted", core.ScopedTenant(core.ScopeClause{Attrs: map[string][]string{"env": {"staging"}}})},
		{"empty", core.ScopedTenant(core.ScopeClause{Bindings: []uuid.UUID{}})},
		{"unset", core.DataScope{}},
	} {
		t.Run(c.name, func(t *testing.T) {
			prev := dataScope
			dataScope = func() core.DataScope { return c.scope }
			defer func() { dataScope = prev }()
			fake, url := fakeharness.Start(t)
			h, _ := queryGateway(t, url, pulsusdb.Options{})
			j, d := serve(h, counterReq, ""), serve(h, counterReq, dsfAccept)
			wantError(t, c.name+" JSON", j, 403, "scope_denied", "-", "")
			if d.Code != j.Code || !bytes.Equal(d.Body.Bytes(), j.Body.Bytes()) || d.Header().Get("Content-Type") != "application/json" ||
				d.Header().Get("Vary") != "Accept" || j.Header().Get("Vary") != "Accept" {
				t.Errorf("DSF %d %q %s, JSON %d %s", d.Code, d.Header().Get("Content-Type"), d.Body.String(), j.Code, j.Body.String())
			}
			for _, r := range fake.Requests() {
				if r.Path == "/api/v1/query_range" || r.Path == "/api/v1/query" {
					t.Errorf("an upstream query was sent: %s %s", r.Method, r.Path)
				}
			}
		})
	}
}
