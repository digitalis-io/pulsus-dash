package pulsusdb

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"math"
	"math/rand/v2"
	"net"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

const (
	okLabels = `{"status":"success","data":["a"]}`
	okEmpty  = `{"status":"success","data":[]}`
)

// budgetCall is a POST (Series): http.Transport replays a failed GET on a reused connection by
// itself, which would hide the attempts the budget counts.
func budgetCall(t *testing.T, c *Client, ctx context.Context, u *upstream) error {
	t.Helper()
	_, err := c.Series(ctx, rcFor(testBinding(u.URL)), labelsQuery())
	return err
}

const strongCred = "user:pw-secret" // dXNlcjpwdy1zZWNyZXQ=

func secretsOf(m map[string]string) func(string) (string, error) {
	return func(ref string) (string, error) {
		v, ok := m[ref]
		if !ok {
			return "", errors.New("environment variable is not set")
		}
		return v, nil
	}
}

func labelsQuery() MatchQuery {
	return MatchQuery{Match: []string{"up"}, Start: time.UnixMilli(1767225600000), End: time.UnixMilli(1767229200000), Limit: 1000}
}

// unit:decoration (T06-002, T06-006, T06-025).
func TestDecoration(t *testing.T) {
	u := newUpstream(t, answer(200, counterBody))
	c := New(Options{Secrets: secretsOf(map[string]string{"env:CREDS": strongCred, "env:NOUSER": "nouser", "env:EMPTYUSER": ":pw-secret-1"})})
	full := testBinding(u.URL + "/prefix/")
	full.ScopeOrgID, full.Database, full.CredentialsRef = "acme", "metrics_b", "env:CREDS"
	rs, err := c.QueryRange(ctxWithin(t, 10*time.Second), rcFor(full), counterRange(`sum by (job, instance) (rate(http_requests_total[5m]))`))
	if err != nil {
		t.Fatal(err)
	}
	_ = rs.Close()
	reqs := u.requests()
	if len(reqs) != 1 {
		t.Fatalf("%d requests, want 1", len(reqs))
	}
	r := reqs[0]
	if r.Method != http.MethodPost || r.Path != "/prefix/api/v1/query_range" {
		t.Errorf("request %s %s, want POST /prefix/api/v1/query_range", r.Method, r.Path)
	}
	if g := r.Header.Get("X-Scope-OrgID"); g != "acme" {
		t.Errorf("X-Scope-OrgID %q", g)
	}
	if g := r.Header.Get("X-Pulsus-Database"); g != "metrics_b" {
		t.Errorf("X-Pulsus-Database %q", g)
	}
	if g, w := r.Header.Get("Authorization"), "Basic "+base64.StdEncoding.EncodeToString([]byte(strongCred)); g != w {
		t.Errorf("Authorization %q, want %q", g, w)
	}
	if g := r.Header.Get("User-Agent"); g != "pulsus-dash/0.1.0-dev" {
		t.Errorf("User-Agent %q", g)
	}
	if g := r.Header.Get("Accept"); g != "application/json" {
		t.Errorf("Accept %q", g)
	}
	for k, w := range map[string]string{"query": `sum by (job, instance) (rate(http_requests_total[5m]))`, "start": "1767225600", "end": "1767229200", "step": "5"} {
		if g := r.Form.Get(k); g != w {
			t.Errorf("form %s = %q, want %q", k, g, w)
		}
	}

	// A binding without scope, database or credentials sends none of the three headers.
	_ = mustRange(t, c, testBinding(u.URL))
	plain := u.requests()[1]
	for _, h := range []string{"X-Scope-OrgID", "X-Pulsus-Database", "Authorization"} {
		if v := plain.Header.Values(h); len(v) != 0 {
			t.Errorf("plain binding sent %s %q", h, v)
		}
	}

	// Refused before any request.
	before := len(u.requests())
	for _, c2 := range []struct {
		name string
		rc   *core.RequestCtx
		kind ErrorKind
	}{
		{"no user", rcWith(testBinding(u.URL), "env:NOUSER", ""), KindConfig},
		{"empty user", rcWith(testBinding(u.URL), "env:EMPTYUSER", ""), KindConfig},
		{"unresolvable", rcWith(testBinding(u.URL), "env:MISSING", ""), KindConfig},
		{"other kind", rcWith(testBinding(u.URL), "", "other"), KindConfig},
		{"zero scope", func() *core.RequestCtx { rc := rcFor(testBinding(u.URL)); rc.Scope = core.DataScope{}; return rc }(), KindScopeDenied},
	} {
		_, err := c.QueryRange(ctxWithin(t, 5*time.Second), c2.rc, counterRange("up"))
		if kindOf(err) != c2.kind {
			t.Errorf("%s: err %v, want %v", c2.name, err, c2.kind)
		}
		if _, err := c.Labels(ctxWithin(t, 5*time.Second), c2.rc, labelsQuery()); kindOf(err) != c2.kind {
			t.Errorf("%s (labels): err %v, want %v", c2.name, err, c2.kind)
		}
	}
	if n := len(u.requests()); n != before {
		t.Errorf("%d requests sent for refused calls", n-before)
	}
}

func rcWith(b core.TenantBinding, ref, kind string) *core.RequestCtx {
	b.CredentialsRef = ref
	if kind != "" {
		b.Kind = kind
	}
	return rcFor(b)
}

func mustRange(t *testing.T, c *Client, b core.TenantBinding) []*Series {
	t.Helper()
	rs, err := c.QueryRange(ctxWithin(t, 10*time.Second), rcFor(b), counterRange("up"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rs.Close() }()
	ss, err := drain(rs)
	if err != nil {
		t.Fatal(err)
	}
	return ss
}

func TestRoutesAndParameters(t *testing.T) {
	bodies := map[string]string{
		"/api/v1/query":              `{"status":"success","data":{"resultType":"vector","result":[]}}`,
		"/api/v1/series":             `{"status":"success","data":[{"job":"api","__name__":"up"}]}`,
		"/api/v1/labels":             okLabels,
		"/api/v1/label/a/b/values":   okLabels,
		"/api/v1/metadata":           `{"status":"success","data":{"up":[{"type":"gauge","help":"Target up.","unit":""}]}}`,
		"/api/v1/status/runtimeinfo": `{"status":"success","data":{"rollupLevels":["1m","1d"],"x":1}}`,
	}
	u := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		answer(200, bodies[r.URL.Path], "X-Pulsus-Query-Id", "q-1")(w, r)
	})
	c := New(Options{})
	rc := rcFor(testBinding(u.URL))
	ctx := ctxWithin(t, 10*time.Second)
	rs, err := c.Query(ctx, rc, InstantQuery{Query: "up", At: time.UnixMilli(1767229200123), Timeout: 30 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	_ = rs.Close()
	sr, err := c.Series(ctx, rc, MatchQuery{Match: []string{"up", `{job="x"}`}, Start: time.UnixMilli(1000), End: time.UnixMilli(2500), Limit: 10})
	if err != nil || len(sr.Series) != 1 || !slices.Equal(sr.Series[0], []Label{{Name: "__name__", Value: "up"}, {Name: "job", Value: "api"}}) {
		t.Errorf("Series = %+v %v", sr, err)
	}
	if v, err := c.Labels(ctx, rc, labelsQuery()); err != nil || !slices.Equal(v.Values, []string{"a"}) {
		t.Errorf("Labels = %+v %v", v, err)
	}
	if _, err := c.LabelValues(ctx, rc, "a/b", labelsQuery()); err != nil {
		t.Errorf("LabelValues: %v", err)
	}
	md, err := c.Metadata(ctx, rc, MetadataQuery{Metric: "up", Limit: 5})
	if err != nil || md.Metrics["up"][0] != (MetricMetadata{Type: "gauge", Help: "Target up."}) {
		t.Errorf("Metadata = %+v %v", md, err)
	}
	ri, err := c.RuntimeInfo(ctx, rc)
	if err != nil || !slices.Equal(ri.RollupLevels, []string{"1m", "1d"}) || ri.QueryID != "q-1" {
		t.Errorf("RuntimeInfo = %+v %v", ri, err)
	}
	reqs := u.requests()
	want := []struct{ method, path, form string }{
		{"POST", "/api/v1/query", "query=up&time=1767229200.123"},
		{"POST", "/api/v1/series", "end=2.500&limit=10&match%5B%5D=up&match%5B%5D=%7Bjob%3D%22x%22%7D&start=1"},
		{"GET", "/api/v1/labels", "end=1767229200&limit=1000&match%5B%5D=up&start=1767225600"},
		{"GET", "/api/v1/label/a%2Fb/values", "end=1767229200&limit=1000&match%5B%5D=up&start=1767225600"},
		{"GET", "/api/v1/metadata", "limit=5&metric=up"},
		{"GET", "/api/v1/status/runtimeinfo", ""},
	}
	if len(reqs) != len(want) {
		t.Fatalf("%d requests, want %d", len(reqs), len(want))
	}
	instantTimeout := reqs[0].Form.Get("timeout")
	for i, w := range want {
		f := reqs[i].Form
		f.Del("timeout")
		if reqs[i].Method != w.method || reqs[i].Path != w.path || f.Encode() != w.form {
			t.Errorf("request %d: %s %s %s, want %s %s %s", i, reqs[i].Method, reqs[i].Path, f.Encode(), w.method, w.path, w.form)
		}
	}
	if !strings.HasSuffix(instantTimeout, "ms") {
		t.Errorf("instant timeout %q", instantTimeout)
	}
}

// failing is an upstream that resets the first n connections before headers, then answers. A
// request leaves inFlight just before its reset or answer becomes visible to the client: a deferred
// decrement could run after the client has already sent its retry, and count one request twice.
type failing struct {
	n         atomic.Int32
	inFlight  atomic.Int32
	maxFlight atomic.Int32
	status    int
	body      string
}

func (f *failing) handler(w http.ResponseWriter, r *http.Request) {
	cur := f.inFlight.Add(1)
	for {
		m := f.maxFlight.Load()
		if cur <= m || f.maxFlight.CompareAndSwap(m, cur) {
			break
		}
	}
	if f.n.Add(-1) >= 0 {
		conn, _, err := http.NewResponseController(w).Hijack()
		f.inFlight.Add(-1)
		if err == nil {
			_ = conn.(*net.TCPConn).SetLinger(0)
			_ = conn.Close()
		}
		return
	}
	status, body := f.status, f.body
	if status == 0 {
		status, body = 200, okEmpty
	}
	f.inFlight.Add(-1) // before the first byte of the answer is written
	answer(status, body)(w, r)
}

type sleeps struct {
	mu sync.Mutex
	d  []time.Duration
}

func (s *sleeps) sleep(_ context.Context, d time.Duration) error {
	s.mu.Lock()
	s.d = append(s.d, d)
	s.mu.Unlock()
	return nil
}

// budgetClient returns a client with a frozen clock, recorded sleeps and Jitter 0.5, after `warm`
// successful calls to u.
func budgetClient(t *testing.T, u *upstream, warm int) (*Client, *sleeps) {
	t.Helper()
	s := &sleeps{}
	clk := newFakeClock()
	c := New(Options{Now: clk.Now, Sleep: s.sleep, Jitter: func() float64 { return 0.5 }})
	for range warm {
		if err := budgetCall(t, c, ctxWithin(t, 10*time.Second), u); err != nil {
			t.Fatalf("warm-up: %v", err)
		}
	}
	s.d = nil
	return c, s
}

// unit:retry-budget (T06-009).
func TestRetryBudget(t *testing.T) {
	f := &failing{}
	u := newUpstream(t, f.handler)
	attempts := func() int { return len(u.requests()) }

	c, s := budgetClient(t, u, 20)
	base := attempts()
	f.n.Store(2)
	if err := budgetCall(t, c, ctxWithin(t, 10*time.Second), u); err != nil {
		t.Errorf("after 2 resets: %v", err)
	}
	if n := attempts() - base; n != 3 || !slices.Equal(s.d, []time.Duration{225 * time.Millisecond, 225 * time.Millisecond}) {
		t.Errorf("%d attempts, sleeps %v; want 3 and [225ms 225ms]", n, s.d)
	}

	c, _ = budgetClient(t, u, 0)
	base = attempts()
	f.n.Store(1)
	if err := budgetCall(t, c, ctxWithin(t, 10*time.Second), u); kindOf(err) != KindUnreachable {
		t.Errorf("empty window: err %v, want KindUnreachable", err)
	}
	if n := attempts() - base; n != 1 {
		t.Errorf("empty window: %d attempts, want 1", n)
	}
	f.n.Store(0)

	for _, c2 := range []struct {
		status   int
		body     string
		attempts int
		kind     ErrorKind
	}{
		{503, `{"status":"error","errorType":"unavailable","error":"x"}`, 3, KindUnavailable},
		{503, `{"status":"error","errorType":"timeout","error":"x"}`, 1, KindTimeout},
		{504, `{"status":"error"}`, 1, KindTimeout},
		{400, `{"status":"error","errorType":"bad_data","error":"x"}`, 1, KindQueryInvalid},
		{422, `{"status":"error","errorType":"execution","error":"x"}`, 1, KindTooBroad},
		{429, `{"status":"error"}`, 1, KindRateLimited},
		{401, `{"status":"error"}`, 1, KindUnauthorised},
		{500, `{"status":"error"}`, 1, KindProtocol},
	} {
		c, _ := budgetClient(t, u, 20)
		f.status, f.body = c2.status, c2.body
		base := attempts()
		err := budgetCall(t, c, ctxWithin(t, 10*time.Second), u)
		if kindOf(err) != c2.kind || attempts()-base != c2.attempts {
			t.Errorf("%d %s: err %v after %d attempts; want %v after %d", c2.status, c2.body, err, attempts()-base, c2.kind, c2.attempts)
		}
		f.status, f.body = 0, ""
	}

	// The backoff plus 100 ms must fit in the remaining deadline.
	s2 := &sleeps{}
	clk := newFakeClock()
	c = New(Options{Now: clk.Now, Sleep: s2.sleep, Jitter: func() float64 { return 0.5 }})
	for range 20 {
		_ = budgetCall(t, c, ctxWithin(t, 10*time.Second), u)
	}
	ctx, cancel := context.WithDeadline(context.Background(), clk.Now().Add(200*time.Millisecond))
	defer cancel()
	base = attempts()
	f.n.Store(1)
	if err := budgetCall(t, c, ctx, u); kindOf(err) != KindUnreachable || attempts()-base != 1 {
		t.Errorf("200 ms left: err %v after %d attempts; want KindUnreachable after 1", err, attempts()-base)
	}
	f.n.Store(0)
	if m := f.maxFlight.Load(); m != 1 {
		t.Errorf("%d requests in flight at once, want 1 (no hedging)", m)
	}
}

// unit:timeout-budget (T06-010, §4.2).
func TestTimeoutBudget(t *testing.T) {
	f := &failing{status: 200, body: counterBody}
	u := newUpstream(t, f.handler)
	clk := newFakeClock()
	c := New(Options{Now: clk.Now, Sleep: func(_ context.Context, d time.Duration) error { clk.Advance(d); return nil },
		Jitter: func() float64 { return 0.5 }})
	rangeAt := func(deadline time.Time) error {
		ctx, cancel := context.WithDeadline(context.Background(), deadline)
		defer cancel()
		rs, err := c.QueryRange(ctx, rcFor(testBinding(u.URL)), counterRange("up"))
		if err == nil {
			_ = rs.Close()
		}
		return err
	}
	lastTimeout := func() string { r := u.requests(); return r[len(r)-1].Form.Get("timeout") }

	if err := rangeAt(clk.Now().Add(30 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if g := lastTimeout(); g != "29900ms" {
		t.Errorf("first attempt timeout %q, want 29900ms", g)
	}
	for range 19 {
		_ = rangeAt(clk.Now().Add(30 * time.Second))
	}
	f.n.Store(1)
	if err := rangeAt(clk.Now().Add(30 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if g := lastTimeout(); g != "29675ms" {
		t.Errorf("retry timeout %q, want 29675ms (30000 - 225 - 100)", g)
	}
	if err := rangeAt(clk.Now().Add(200 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if g := lastTimeout(); g != "100ms" {
		t.Errorf("200 ms deadline: timeout %q, want 100ms", g)
	}
	before := len(u.requests())
	d := clk.Now().Add(200 * time.Millisecond)
	clk.Advance(150 * time.Millisecond)
	if err := rangeAt(d); kindOf(err) != KindTimeout {
		t.Errorf("50 ms left: err %v, want KindTimeout", err)
	}
	if n := len(u.requests()); n != before {
		t.Errorf("%d requests sent with 50 ms left", n-before)
	}
}

// unit:tenant-limit (T06 §4.10).
func TestTenantLimit(t *testing.T) {
	release := make(chan struct{})
	u := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"success","data":{"resultType":"matrix","result":[`))
		_ = http.NewResponseController(w).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	t.Cleanup(func() { close(release) })
	c := New(Options{TenantConcurrency: 2})
	open := func(b core.TenantBinding) (*ResultStream, error) {
		return c.QueryRange(ctxWithin(t, 10*time.Second), rcFor(b), counterRange("up"))
	}
	a, err := open(testBinding(u.URL))
	if err != nil {
		t.Fatal(err)
	}
	b, err := open(testBinding(u.URL))
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	_, err = open(testBinding(u.URL))
	if d := time.Since(start); kindOf(err) != KindBusy || d < 50*time.Millisecond || d >= 200*time.Millisecond {
		t.Errorf("third: err %v after %v, want KindBusy after 50..200 ms", err, d)
	}
	other := testBinding(u.URL)
	other.ID = uuid.MustParse("01900000-0000-7000-8000-000000000002")
	o, err := open(other)
	if err != nil {
		t.Errorf("another binding was blocked: %v", err)
	} else {
		_ = o.Close()
	}
	_ = a.Close()
	d, err := open(testBinding(u.URL))
	if err != nil {
		t.Errorf("after Close: %v", err)
	} else {
		_ = d.Close()
	}
	_ = b.Close()
}

// unit:credential-strength (client half, §4.10, r5-1).
func TestCredentialStrength(t *testing.T) {
	u := newUpstream(t, answer(200, okLabels))
	weak := []string{"u:1234567", "u:12345678", "u:", ":abcdefgh", "u:-1234567", "u:1.5e+300", "u:0x1p-1074",
		"u:+Infinity", "u:  12345678  ", "u:1_000_000"}
	for _, cred := range weak {
		logs := &logBuffer{}
		c := New(Options{Logger: logs.logger(), Secrets: secretsOf(map[string]string{"env:C": cred})})
		_, err := c.Labels(ctxWithin(t, 5*time.Second), rcWith(testBinding(u.URL), "env:C", ""), labelsQuery())
		if kindOf(err) != KindConfig {
			t.Errorf("%q: err %v, want KindConfig", cred, err)
		}
		out := logs.String()
		_, pw, _ := strings.Cut(cred, ":")
		if !strings.Contains(out, `"msg":"pulsusdb_credentials_weak"`) || !strings.Contains(out, `"tenant":"demo"`) ||
			(pw != "" && strings.Contains(out, pw)) {
			t.Errorf("%q: log %q, want msg=pulsusdb_credentials_weak tenant=demo and no value", cred, out)
		}
	}
	if n := len(u.requests()); n != 0 {
		t.Errorf("%d requests sent with weak credentials", n)
	}
	c := New(Options{Secrets: secretsOf(map[string]string{"env:C": "u:abcd1234"})})
	if _, err := c.Labels(ctxWithin(t, 5*time.Second), rcWith(testBinding(u.URL), "env:C", ""), labelsQuery()); err != nil {
		t.Fatal(err)
	}
	if r := u.requests(); len(r) != 1 || r[0].Header.Get("Authorization") != "Basic dTphYmNkMTIzNA==" {
		t.Errorf("requests %+v, want one with Basic dTphYmNkMTIzNA==", r)
	}
}

// Property (r5-1): every float text, in every format, padded or not, is a weak password, so an
// upstream sample can never equal an accepted password.
func TestWeakPasswordProperty(t *testing.T) {
	seed := rand.Uint64() // #nosec G404 -- a logged seed makes failures reproducible
	t.Logf("seed %d", seed)
	rng := rand.New(rand.NewPCG(seed, 1)) // #nosec G404 -- seeded for reproducible cases
	for i := range 1000 {
		var v float64
		switch rng.IntN(4) {
		case 0:
			v = rng.NormFloat64() * math.Pow(10, float64(rng.IntN(600)-300))
		case 1:
			v = math.Float64frombits(rng.Uint64())
		case 2:
			v = float64(rng.Int64N(1 << 53))
		default:
			v = []float64{math.Inf(1), math.Inf(-1), math.NaN(), 0, math.Copysign(0, -1), 5e-324}[rng.IntN(6)]
		}
		if rng.IntN(2) == 0 {
			v = -v
		}
		s := strconv.FormatFloat(v, "efgx"[rng.IntN(4)], rng.IntN(20)-1, 64)
		if rng.IntN(3) == 0 && s[0] >= '0' && s[0] <= '9' {
			s = "+" + s
		}
		s = strings.Repeat(" ", rng.IntN(3)) + s + strings.Repeat(" ", rng.IntN(3))
		if !core.WeakPassword(s) {
			t.Fatalf("case %d: %q is accepted as a password", i, s)
		}
	}
	for _, ok := range []string{"abcd1234", "pw-secret", "Zq9-planted-SECRET", "correct horse"} {
		if core.WeakPassword(ok) {
			t.Errorf("%q is refused, want accepted", ok)
		}
	}
}

// review r1 #1: the 503 body is decoded with the request's redactor. With the (accepted)
// password "unavailable", the redactor turns errorType into <redacted>, so the 503 is not the
// retryable kind and no retry is made; an unredacted read would retry.
func TestUnavailableBodyUsesRequestRedactor(t *testing.T) {
	f := &failing{}
	u := newUpstream(t, f.handler)
	s := &sleeps{}
	c := New(Options{Now: newFakeClock().Now, Sleep: s.sleep, Jitter: func() float64 { return 0.5 },
		Secrets: secretsOf(map[string]string{"env:C": "user:unavailable"})})
	rc := rcWith(testBinding(u.URL), "env:C", "")
	for range 20 {
		if _, err := c.Series(ctxWithin(t, 10*time.Second), rc, labelsQuery()); err != nil {
			t.Fatalf("warm-up: %v", err)
		}
	}
	f.status, f.body = 503, `{"status":"error","errorType":"unavailable","error":"x"}`
	base := len(u.requests())
	_, err := c.Series(ctxWithin(t, 10*time.Second), rc, labelsQuery())
	if kindOf(err) != KindUnavailable || len(u.requests())-base != 1 {
		t.Errorf("err %v after %d attempts; want KindUnavailable after 1 (errorType redacted)", err, len(u.requests())-base)
	}
}

// review r1 #1: readErrorBody returns errorType and error redacted with the request's needles.
func TestErrorBodyRedacted(t *testing.T) {
	u := newUpstream(t, answer(503, ""))
	cred := "user:Zq9-planted-SECRET" // #nosec G101 -- the planted test credential
	red := newRedactor(testBinding(u.URL), cred)
	token := base64.StdEncoding.EncodeToString([]byte(cred))
	host := strings.TrimPrefix(u.URL, "http://")
	body := `{"status":"error","errorType":"` + cred + ` ` + token + `","error":"` + u.URL + `/x ` + host + `"}`
	c := New(Options{})
	et, msg, err := c.readErrorBody(&http.Response{Body: io.NopCloser(strings.NewReader(body))}, red)
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"Zq9-planted-SECRET", token, u.URL, host} {
		if strings.Contains(et, n) || strings.Contains(msg, n) {
			t.Errorf("errorType %q error %q contain %q", et, msg, n)
		}
	}
	if et != "<redacted> <redacted>" || msg != "<redacted>/x <redacted>" {
		t.Errorf("errorType %q error %q", et, msg)
	}
}

// review r1 #2: 503 body-read failures are classified, never taken as "unavailable".
func TestUnavailableBodyFailures(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	stall := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(503)
		_, _ = io.WriteString(w, `{"status":"error",`)
		_ = http.NewResponseController(w).Flush()
		select {
		case <-r.Context().Done():
		case <-release:
		}
	})
	c := New(Options{})
	start := time.Now()
	_, err := c.Series(ctxWithin(t, 300*time.Millisecond), rcFor(testBinding(stall.URL)), labelsQuery())
	if kindOf(err) != KindTimeout || time.Since(start) > 2*time.Second {
		t.Errorf("stalled 503 body: err %v after %v, want KindTimeout at the deadline", err, time.Since(start))
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(100 * time.Millisecond); cancel() }()
	if _, err := c.Series(ctx, rcFor(testBinding(stall.URL)), labelsQuery()); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled during a 503 body: err %v, want context.Canceled", err)
	}

	big := newUpstream(t, answer(503, `{"status":"error","errorType":"unavailable","error":"`+strings.Repeat("e", 1024)+`"}`))
	small := New(Options{Limits: Limits{ErrorBody: 256}})
	if _, err := small.Series(ctxWithin(t, 5*time.Second), rcFor(testBinding(big.URL)), labelsQuery()); kindOf(err) != KindProtocol || len(big.requests()) != 1 {
		t.Errorf("oversized 503 body: err %v after %d attempts, want KindProtocol after 1", err, len(big.requests()))
	}
	bad := newUpstream(t, answer(503, `<html>`))
	if _, err := c.Series(ctxWithin(t, 5*time.Second), rcFor(testBinding(bad.URL)), labelsQuery()); kindOf(err) != KindProtocol || len(bad.requests()) != 1 {
		t.Errorf("malformed 503 body: err %v after %d attempts, want KindProtocol after 1", err, len(bad.requests()))
	}
}
