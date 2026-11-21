package pulsusdb

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
)

func lbl(kv ...string) []Label {
	var ls []Label
	for i := 0; i+1 < len(kv); i += 2 {
		ls = append(ls, Label{Name: kv[i], Value: kv[i+1]})
	}
	sort.Slice(ls, func(i, j int) bool { return ls[i].Name < ls[j].Name })
	return ls
}

// unit:log-level (Table 3.2a; detected_level first).
func TestLogLevel(t *testing.T) {
	for _, c := range []struct {
		ls   []Label
		want Level
	}{
		{lbl("detected_level", "info", "level", "WARNING"), LevelInfo},
		{lbl("detected_level", "ERR", "level", "debug"), LevelError},
		{lbl("detected_level", "debug", "level", "error"), LevelDebug},
		{lbl("detected_level", "trace", "level", "critical"), LevelTrace},
		{lbl("detected_level", "unknown", "level", "WARNING"), LevelWarn},
		{lbl("detected_level", "nonsense", "level", "Fatal"), LevelCritical},
		{lbl("level", "crit"), LevelCritical},
		{lbl("level", "emergency"), LevelCritical},
		{lbl("level", "alert"), LevelCritical},
		{lbl("level", "notice"), LevelInfo},
		{lbl("level", "informational"), LevelInfo},
		{lbl("level", "warn"), LevelWarn},
		{lbl("level", "err"), LevelError},
		{lbl("level", "trace"), LevelTrace},
		{lbl("detected_level", "unknown"), LevelUnknown},
		{lbl("level", "nonsense"), LevelUnknown},
		{lbl(), LevelUnknown},
		{lbl("app", "x", "detected_level", "DEBUG", "pod", "a"), LevelDebug},
	} {
		if got := LevelOf(c.ls); got != c.want {
			t.Errorf("LevelOf(%v) = %v, want %v", c.ls, got, c.want)
		}
	}
	var names []string
	for l := LevelUnknown; l <= LevelCritical; l++ {
		names = append(names, l.String())
	}
	if g := strings.Join(names, " "); g != "unknown trace debug info warn error critical" {
		t.Errorf("level names %q", g)
	}
	if Backward.String() != "backward" || Forward.String() != "forward" {
		t.Errorf("directions %q %q", Backward, Forward)
	}
}

// logsAPI answers every log route of the client with fixed bodies.
func logsAPI(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch {
	case strings.HasSuffix(r.URL.Path, "/labels"), strings.HasSuffix(r.URL.Path, "/values"):
		_, _ = io.WriteString(w, `{"status":"success","data":["a","b","c"]}`)
	case strings.HasSuffix(r.URL.Path, "/series"):
		_, _ = io.WriteString(w, `{"status":"success","data":[{"app":"x"},{"app":"y"},{"app":"z"}]}`)
	case strings.HasPrefix(r.Form.Get("query"), volumeTestPrefix):
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
	default:
		_, _ = io.WriteString(w, streamsBody(typeFirst, nil))
	}
}

const volumeTestPrefix = "sum by (level, detected_level) (count_over_time("

func formKeys(s seen) []string {
	var ks []string
	for k := range s.Form {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

func decoratedBinding(url string) core.TenantBinding {
	b := testBinding(url)
	b.ScopeOrgID, b.Database, b.CredentialsRef = "acme", "logs_b", "env:C"
	return b
}

func wantDecorated(t *testing.T, what string, s seen) {
	t.Helper()
	if s.Header.Get("X-Scope-OrgID") != "acme" || s.Header.Get("X-Pulsus-Database") != "logs_b" ||
		s.Header.Get("Authorization") != "Basic "+base64.StdEncoding.EncodeToString([]byte("user:pw-secret-1")) ||
		s.Header.Get("Accept") != "application/json" {
		t.Errorf("%s: headers %v, want the decoration", what, s.Header)
	}
}

func timeoutMs(t *testing.T, s seen) int64 {
	t.Helper()
	v, ok := strings.CutSuffix(s.Form.Get("timeout"), "ms")
	n, err := strconv.ParseInt(v, 10, 64)
	if !ok || err != nil {
		t.Errorf("timeout %q", s.Form.Get("timeout"))
	}
	return n
}

// unit:logql-calls (§3.2, T06-005, T06-006, T06-009).
func TestLogQLCalls(t *testing.T) {
	for _, c := range []struct {
		v    int64
		want string
	}{{0, "0000000000000000000"}, {1000, "0000000000000001000"}, {-1, "-000000000000000001"},
		{9223372036854775807, "9223372036854775807"}, {1767225600000000000, "1767225600000000000"}} {
		if g := nsParam(c.v); g != c.want {
			t.Errorf("nsParam(%d) = %q, want %q", c.v, g, c.want)
		}
	}

	u := newUpstream(t, logsAPI)
	c := New(Options{Secrets: secretsOf(map[string]string{"env:C": "user:pw-secret-1"})})
	rc := rcFor(decoratedBinding(u.URL))
	ctx := func() context.Context { return ctxWithin(t, 10*time.Second) }
	mq := LogMatchQuery{Query: `{app="x"}`, StartNs: 1767225600000000000, EndNs: 1767229200000000000, Limit: 2}
	calls := []struct {
		name, method, path string
		run                func() error
		keys               []string
		form               map[string]string
	}{
		{"LogQueryRange", "GET", "/api/logs/v1/query_range", func() error {
			_, err := c.LogQueryRange(ctx(), rc, a1Query(10, Forward))
			return err
		}, []string{"direction", "end", "limit", "query", "start", "step", "timeout"},
			map[string]string{"query": `{app="x"}`, "start": "1767225600000000000", "end": "1767229200000000000", "step": "5000ms", "limit": "11", "direction": "forward"}},
		{"LogVolume", "GET", "/api/logs/v1/query_range", func() error {
			_, _, err := c.LogVolume(ctx(), rc, VolumeQuery{Query: `{app="x"}`, Grid: a1Grid()})
			return err
		}, []string{"end", "query", "start", "step", "timeout"},
			map[string]string{"query": volumeTestPrefix + `{app="x"}` + "\n| drop __error__ [5s]))", "start": "1767225600000000000", "end": "1767229200000000000", "step": "5000ms"}},
		{"LogLabels", "GET", "/api/logs/v1/labels", func() error {
			r, err := c.LogLabels(ctx(), rc, mq)
			if err == nil && (!slices.Equal(r.Values, []string{"a", "b"}) || !r.Completeness.Truncated) {
				t.Errorf("LogLabels limit 2: %+v, want 2 values, truncated", r)
			}
			return err
		}, []string{"end", "query", "start"}, map[string]string{"query": `{app="x"}`, "start": "1767225600000000000", "end": "1767229200000000000"}},
		{"LogLabelValues", "GET", "/api/logs/v1/label/a%2Fb/values", func() error {
			r, err := c.LogLabelValues(ctx(), rc, "a/b", mq)
			if err == nil && (len(r.Values) != 2 || !r.Completeness.Truncated) {
				t.Errorf("LogLabelValues limit 2: %+v", r)
			}
			return err
		}, []string{"end", "query", "start"}, map[string]string{"query": `{app="x"}`}},
		{"LogLabels without query", "GET", "/api/logs/v1/labels", func() error {
			q := mq
			q.Query = ""
			_, err := c.LogLabels(ctx(), rc, q)
			return err
		}, []string{"end", "start"}, nil},
		{"LogSeries", "GET", "/api/logs/v1/series", func() error {
			r, err := c.LogSeries(ctx(), rc, LogSeriesQuery{Match: []string{`{app="x"}`, `{app="y"}`}, StartNs: 1, EndNs: 2, Limit: 2})
			if err == nil && (len(r.Series) != 2 || !r.Completeness.Truncated) {
				t.Errorf("LogSeries limit 2: %+v", r)
			}
			return err
		}, []string{"end", "match[]", "start"}, map[string]string{"start": "0000000000000000001", "end": "0000000000000000002"}},
	}
	for _, cl := range calls {
		before := len(u.requests())
		if err := cl.run(); err != nil {
			t.Errorf("%s: %v", cl.name, err)
			continue
		}
		rs := u.requests()
		if len(rs) != before+1 {
			t.Errorf("%s: %d requests, want 1", cl.name, len(rs)-before)
			continue
		}
		r := rs[before]
		if r.Method != cl.method || r.Path != cl.path {
			t.Errorf("%s: %s %s, want %s %s", cl.name, r.Method, r.Path, cl.method, cl.path)
		}
		if g := formKeys(r); !slices.Equal(g, cl.keys) {
			t.Errorf("%s: parameters %v, want %v", cl.name, g, cl.keys)
		}
		for k, w := range cl.form {
			if g := r.Form.Get(k); g != w {
				t.Errorf("%s: %s = %q, want %q", cl.name, k, g, w)
			}
		}
		if cl.name == "LogSeries" && !slices.Equal(r.Form["match[]"], []string{`{app="x"}`, `{app="y"}`}) {
			t.Errorf("LogSeries match[] %v", r.Form["match[]"])
		}
		wantDecorated(t, cl.name, r)
	}

	// A query whose URL would exceed 8 KiB is sent as a POST form instead (query_range and series).
	long := `{app="x"} |= "` + strings.Repeat("a", 8200) + `"`
	before := len(u.requests())
	ql := a1Query(10, Backward)
	ql.Query = long
	_, errQ := c.LogQueryRange(ctx(), rc, ql)
	_, errS := c.LogSeries(ctx(), rc, LogSeriesQuery{Match: []string{long}, StartNs: 1, EndNs: 2, Limit: 2})
	_, errL := c.LogLabels(ctx(), rc, LogMatchQuery{Query: `{app="x"}`, StartNs: 1, EndNs: 2, Limit: 2})
	if rs := u.requests()[before:]; errQ != nil || errS != nil || errL != nil || len(rs) != 3 ||
		rs[0].Method != "POST" || rs[0].Form.Get("query") != long || rs[1].Method != "POST" || rs[1].Form.Get("match[]") != long ||
		rs[2].Method != "GET" {
		t.Errorf("URL-length fallback: %v %v %v, requests %d", errQ, errS, errL, len(rs))
	}

	// A three-request page (B, B3, B2): every request decorated, each timeout ≤ the previous one.
	_, _, _, e4, _, e6 := windowData()
	x, y := tEntry{uHi, lsA, "x"}, tEntry{uHi, lsB, "y"}
	u3 := logUpstream(t, scripted([]tEntry{e6, e4}, []tEntry{x, y}, []tEntry{x, y}))
	p, err := c.LogQueryRange(ctx(), rcFor(decoratedBinding(u3.URL)), windowQuery(1, Backward))
	if err != nil || p == nil || p.Page == nil || p.Page.Requests != 3 {
		t.Errorf("three-request page: %+v %v", p, err)
	}
	if rs := u3.requests(); len(rs) == 3 {
		prev := int64(1 << 62)
		for i, r := range rs {
			wantDecorated(t, "page request "+strconv.Itoa(i+1), r)
			if ms := timeoutMs(t, r); ms > prev {
				t.Errorf("request %d timeout %d ms > the previous %d ms", i+1, ms, prev)
			} else {
				prev = ms
			}
		}
	} else {
		t.Errorf("three-request page: %d requests", len(rs))
	}

	// Retries: a JSON 503 unavailable is retried; a text 503 is not.
	var fails atomic.Int32
	var text atomic.Bool
	ur := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if fails.Add(-1) >= 0 {
			if text.Load() {
				w.Header().Set("Content-Type", "text/plain; charset=utf-8")
				w.WriteHeader(503)
				_, _ = io.WriteString(w, "unavailable")
				return
			}
			answer(503, `{"status":"error","errorType":"unavailable","error":"x"}`)(w, r)
			return
		}
		logsAPI(w, r)
	})
	cr := New(Options{Sleep: func(context.Context, time.Duration) error { return nil }})
	rcr := rcFor(testBinding(ur.URL))
	for range 20 {
		if _, err := cr.LogQueryRange(ctx(), rcr, a1Query(10, Backward)); err != nil {
			t.Fatalf("warm-up: %v", err)
		}
	}
	base := len(ur.requests())
	fails.Store(1)
	if _, err := cr.LogQueryRange(ctx(), rcr, a1Query(10, Backward)); err != nil || len(ur.requests())-base != 2 {
		t.Errorf("JSON 503 then 200: %v after %d attempts, want success after 2", err, len(ur.requests())-base)
	}
	base = len(ur.requests())
	text.Store(true)
	fails.Store(1)
	if _, err := cr.LogQueryRange(ctx(), rcr, a1Query(10, Backward)); kindOf(err) != KindUnavailable || len(ur.requests())-base != 1 {
		t.Errorf("text 503: %v after %d attempts, want KindUnavailable after 1", err, len(ur.requests())-base)
	}

	// A page whose second request fails fails as a whole.
	uf := logUpstream(t, func(r logReq) string {
		if r.n == 0 {
			return streamsBody(typeFirst, []tEntry{x, y})
		}
		return `{"status":"success","data":`
	})
	if r, err := c.LogQueryRange(ctx(), rcFor(decoratedBinding(uf.URL)), windowQuery(1, Backward)); err == nil || r != nil {
		t.Errorf("second request fails: %+v %v, want the error and no page", r, err)
	}

	// A 300 ms deadline and an upstream that stalls on the second request.
	var n atomic.Int32
	us := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) > 1 {
			select {
			case <-r.Context().Done():
			case <-time.After(5 * time.Second):
			}
			return
		}
		answer(200, streamsBody(typeFirst, []tEntry{x, y}))(w, r)
	})
	if _, err := c.LogQueryRange(ctxWithin(t, 300*time.Millisecond), rcFor(decoratedBinding(us.URL)), windowQuery(1, Backward)); kindOf(err) != KindTimeout {
		t.Errorf("stalled second request: %v, want KindTimeout", err)
	}

	// A zero scope sends nothing.
	rz := rcFor(testBinding(u.URL))
	rz.Scope = core.DataScope{}
	before = len(u.requests())
	if _, err := c.LogQueryRange(ctx(), rz, a1Query(10, Backward)); kindOf(err) != KindScopeDenied || len(u.requests()) != before {
		t.Errorf("zero scope: %v, %d requests", err, len(u.requests())-before)
	}
}

// volumeSeries is the scripted matrix of unit:volume-compose.
var volumeSeries = []matrixSeries{
	{lbl("detected_level", "info"), [][2]string{{"1767225600", "3"}, {"1767225605", "2"}}},
	{lbl("detected_level", "info", "level", "warn"), [][2]string{{"1767225600", "2"}}},
	{lbl("level", "WARNING"), [][2]string{{"1767225600", "1"}, {"1767229200", "4"}}},
	{lbl("detected_level", "error"), [][2]string{{"1767225600", "4"}}},
	{lbl("detected_level", "error", "level", "error"), [][2]string{{"1767225600", "1"}}},
	{lbl("detected_level", "unknown", "level", "debug"), [][2]string{{"1767225600", "6"}}},
	{lbl(), [][2]string{{"1767225605", "7"}}},
}

// wantLevelSeries checks a volume series: its level label, key and exactly the present points.
func wantLevelSeries(t *testing.T, s *Series, level string, points map[int]float64) {
	t.Helper()
	ls := []Label{{Name: "level", Value: level}}
	if !slices.Equal(s.Labels, ls) || s.Key != keyhash.Labels(ls) {
		t.Errorf("series %v key %x, want level %s", s.Labels, s.Key, level)
		return
	}
	if len(s.Values) != 721 || len(s.Present) != 721 || len(s.Timestamps) != 721 {
		t.Errorf("%s: %d points, want 721", level, len(s.Values))
		return
	}
	for i := range s.Present {
		w, ok := points[i]
		if s.Present[i] != ok || (ok && s.Values[i] != w) {
			t.Errorf("%s point %d = %v %v, want %v %v", level, i, s.Values[i], s.Present[i], w, ok)
		}
	}
}

// unit:volume-compose: a level whose input series have no present point is omitted (§4.4).
func TestVolumeOmitsEmptyLevel(t *testing.T) {
	ss := []matrixSeries{
		{lbl("level", "critical"), nil},
		{lbl("detected_level", "info"), [][2]string{{"1767225600", "3"}}},
		{lbl("level", "trace"), [][2]string{}},
	}
	u := newUpstream(t, answer(200, body(typeFirst, "matrix", matrixJSON(typeFirst, ss))))
	got, _, err := New(Options{}).LogVolume(ctxWithin(t, 5*time.Second), rcFor(testBinding(u.URL)), VolumeQuery{Query: `{app="x"}`, Grid: a1Grid()})
	if err != nil {
		t.Fatal(err)
	}
	var levels []string
	for _, s := range got {
		levels = append(levels, s.Labels[0].Value)
	}
	if !slices.Equal(levels, []string{"info"}) {
		t.Fatalf("levels %v, want info only", levels)
	}
	wantLevelSeries(t, got[0], "info", map[int]float64{0: 3})
}

// unit:volume-compose (§4.4, T07-002).
func TestVolumeCompose(t *testing.T) {
	u := newUpstream(t, answer(200, body(typeFirst, "matrix", matrixJSON(typeFirst, volumeSeries))))
	c := New(Options{})
	rc := rcFor(testBinding(u.URL))
	ss, _, err := c.LogVolume(ctxWithin(t, 5*time.Second), rc, VolumeQuery{Query: `{app="x"}`, Grid: a1Grid()})
	if err != nil {
		t.Fatal(err)
	}
	if q := u.requests()[0].Form.Get("query"); q != "sum by (level, detected_level) (count_over_time({app=\"x\"}\n| drop __error__ [5s]))" {
		t.Errorf("composed %q", q)
	}
	var levels []string
	for _, s := range ss {
		levels = append(levels, s.Labels[0].Value)
	}
	if !slices.Equal(levels, []string{"error", "warn", "info", "debug", "unknown"}) {
		t.Fatalf("levels %v, want error warn info debug unknown", levels)
	}
	wantLevelSeries(t, ss[0], "error", map[int]float64{0: 5})
	wantLevelSeries(t, ss[1], "warn", map[int]float64{0: 1, 720: 4})
	wantLevelSeries(t, ss[2], "info", map[int]float64{0: 5, 1: 2})
	wantLevelSeries(t, ss[3], "debug", map[int]float64{0: 6})
	wantLevelSeries(t, ss[4], "unknown", map[int]float64{1: 7})

	g := Grid{Start: 1767225600000, End: 1767229200000, Step: 60000}
	_, _, _ = c.LogVolume(ctxWithin(t, 5*time.Second), rc, VolumeQuery{Query: `{app="x"}`, Grid: g})
	if q := u.requests()[1].Form.Get("query"); !strings.HasSuffix(q, "\n| drop __error__ [60s]))") || u.requests()[1].Form.Get("step") != "60000ms" {
		t.Errorf("step 60 000: %q step %q", q, u.requests()[1].Form.Get("step"))
	}

	// Positions map back into the user's text.
	for _, c2 := range []struct {
		at      int
		wantPos int // -1 = none
		wantMsg string
	}{
		{57, 8, "unexpected '[' at byte 8: x"},
		{50, 2, "unexpected '[' at byte 2: x"},
		{47, -1, "unexpected '[' at byte 47: x"},
	} {
		msg := "unexpected '[' at byte " + strconv.Itoa(c2.at) + ": x"
		ue := newUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(400)
			_, _ = io.WriteString(w, msg)
		})
		_, _, err := c.LogVolume(ctxWithin(t, 5*time.Second), rcFor(testBinding(ue.URL)), VolumeQuery{Query: `{app="x"`, Grid: a1Grid()})
		e, ok := err.(*Error)
		switch {
		case !ok || e.Kind != KindQueryInvalid:
			t.Errorf("at byte %d: %v, want KindQueryInvalid", c2.at, err)
		case c2.wantPos < 0 && e.Position != nil, c2.wantPos >= 0 && (e.Position == nil || e.Position.Offset != c2.wantPos):
			t.Errorf("at byte %d: position %v, want %d", c2.at, e.Position, c2.wantPos)
		case e.Message != c2.wantMsg:
			t.Errorf("at byte %d: message %q, want %q", c2.at, e.Message, c2.wantMsg)
		}
	}

	us := newUpstream(t, answer(200, streamsBody(typeFirst, a1Data())))
	_, _, err = c.LogVolume(ctxWithin(t, 5*time.Second), rcFor(testBinding(us.URL)), VolumeQuery{Query: `{app="x"}`, Grid: a1Grid()})
	wantProtocol(t, "volume answered with streams", err)
}

// signalBody closes wantMore on the first Read made after it returned the first n bytes.
type signalBody struct {
	io.ReadCloser
	n        int
	read     int
	wantMore chan struct{}
	once     sync.Once
	closed   atomic.Bool
}

func (b *signalBody) Read(p []byte) (int, error) {
	if b.read >= b.n {
		b.once.Do(func() { close(b.wantMore) })
	}
	n, err := b.ReadCloser.Read(p)
	b.read += n
	return n, err
}

func (b *signalBody) Close() error {
	b.closed.Store(true)
	return b.ReadCloser.Close()
}

// signalTransport wraps every response body in body.
type signalTransport struct {
	inner http.RoundTripper
	body  *signalBody
}

func (s *signalTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	resp, err := s.inner.RoundTrip(r)
	if err == nil {
		s.body.ReadCloser = resp.Body
		resp.Body = s.body
	}
	return resp, err
}

// unit:volume-buffered (§4.4; T06-011 case 3).
func TestVolumeBuffered(t *testing.T) {
	head := `{"status":"success","data":{"resultType":"matrix","result":[` +
		`{"metric":{"detected_level":"info"},"values":[[1767225600,"3"]]}` + `,`
	tail := `{"metric":{"level":"info"},"values":[[1767225600,"2"],[1767225605,"1"]]}` + `,` +
		`{"metric":{"detected_level":"error"},"values":[[1767225605,"4"]]}` + `]}}`
	release := make(chan struct{})
	u := newUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, head)
		w.(http.Flusher).Flush()
		<-release
		_, _ = io.WriteString(w, tail)
	})
	sb := &signalBody{n: len(head), wantMore: make(chan struct{})}
	c := New(Options{Transport: &signalTransport{inner: newTransport(), body: sb}})
	type result struct {
		ss  []*Series
		err error
	}
	done := make(chan result, 1)
	go func() {
		ss, _, err := c.LogVolume(ctxWithin(t, 10*time.Second), rcFor(testBinding(u.URL)), VolumeQuery{Query: `{app="x"}`, Grid: a1Grid()})
		done <- result{ss, err}
	}()
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	select {
	case <-done:
		t.Fatal("LogVolume returned before the matrix ended")
	case <-sb.wantMore:
	case <-time.After(2 * time.Second):
		t.Fatal("LogVolume did not read past the first series")
	}
	select {
	case <-done:
		t.Fatal("LogVolume returned while the upstream was blocked")
	case <-time.After(50 * time.Millisecond):
	}
	if n := slotsHeld(c); n != 1 {
		t.Errorf("slots held while blocked: %d, want 1", n)
	}
	close(release)
	var r result
	select {
	case r = <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("LogVolume did not return after release")
	}
	if r.err != nil || len(r.ss) != 2 {
		t.Fatalf("LogVolume = %d series, %v; want 2", len(r.ss), r.err)
	}
	wantLevelSeries(t, r.ss[0], "error", map[int]float64{1: 4})
	wantLevelSeries(t, r.ss[1], "info", map[int]float64{0: 5, 1: 1})
	if !sb.closed.Load() || slotsHeld(c) != 0 {
		t.Errorf("after return: body closed %v, slots held %d", sb.closed.Load(), slotsHeld(c))
	}
}
