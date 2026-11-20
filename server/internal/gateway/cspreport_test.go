package gateway

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"go.yaml.in/yaml/v3"

	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
)

const (
	cspPath     = "/api/dash/v1/csp-report"
	reportsJSON = "application/reports+json"
	legacyCSP   = "application/csp-report"
)

func cspDeps(logs *syncBuffer) Deps {
	return Deps{Logger: slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})), Probe: &fakeProbe{version: 1}}
}

// poster serves h on a real listener (the handler needs a connection for its read deadline, R7)
// and returns a function that posts one report and records the response.
func poster(t *testing.T, h http.Handler) func(contentType, body string) *httptest.ResponseRecorder {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return func(contentType, body string) *httptest.ResponseRecorder {
		t.Helper()
		resp, err := srv.Client().Post(srv.URL+cspPath, contentType, strings.NewReader(body))
		if err != nil {
			t.Fatalf("POST: %v", err)
		}
		defer func() { _ = resp.Body.Close() }()
		rec := httptest.NewRecorder()
		for k, v := range resp.Header {
			rec.Header()[k] = v
		}
		rec.WriteHeader(resp.StatusCode)
		if _, err := io.Copy(rec.Body, resp.Body); err != nil {
			t.Fatalf("response body: %v", err)
		}
		return rec
	}
}

// violation returns one Reporting API entry of type csp-violation with the given body fields.
func violation(body map[string]any) map[string]any {
	return map[string]any{"type": "csp-violation", "age": 0, "url": "http://x/", "user_agent": "test", "body": body}
}

func mustJSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

func byMsg(recs []map[string]any, msg string) []map[string]any {
	var out []map[string]any
	for _, r := range recs {
		if r["msg"] == msg {
			out = append(out, r)
		}
	}
	return out
}

// cspServer is gateway.New behind a real listener, so that ResponseController reaches the
// connection through every middleware.
func cspServer(t *testing.T, d Deps) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(New(d))
	t.Cleanup(srv.Close)
	return srv
}

// R1
func TestCSPReportAccepts(t *testing.T) {
	logs := &syncBuffer{}
	post := poster(t, New(cspDeps(logs)))
	body := mustJSON([]any{violation(map[string]any{
		"effectiveDirective": "script-src-elem", "disposition": "enforce", "blockedURL": "inline",
		"documentURL": "http://x/t/demo/boards?q=1",
	})})
	if rec := post(reportsJSON, body); rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
		t.Fatalf("reports+json: %d %q, want 204 and no body", rec.Code, rec.Body.String())
	}
	legacy := mustJSON(map[string]any{"csp-report": map[string]any{
		"effective-directive": "style-src-elem", "violated-directive": "style-src-elem 'self'",
		"disposition": "report", "blocked-uri": "data", "document-uri": "http://x/t/demo/admin",
	}})
	if rec := post(legacyCSP, legacy); rec.Code != http.StatusNoContent {
		t.Fatalf("csp-report: %d %q, want 204", rec.Code, rec.Body.String())
	}
	recs := byMsg(logs.records(t), "csp_violation")
	if len(recs) != 2 {
		t.Fatalf("%d csp_violation records, want 2", len(recs))
	}
	want := []map[string]string{
		{"directive": "script-src-elem", "disposition": "enforce", "route": "/t/:tenant/boards", "blocked": "inline"},
		{"directive": "style-src-elem", "disposition": "report", "route": "/t/:tenant/admin", "blocked": "data"},
	}
	for i, r := range recs {
		if r["level"] != "WARN" {
			t.Errorf("record %d level = %v, want WARN", i, r["level"])
		}
		for k, v := range want[i] {
			if r[k] != v {
				t.Errorf("record %d %s = %v, want %s", i, k, r[k], v)
			}
		}
	}
	all := logs.buf.String()
	for _, leak := range []string{"demo", "q=1"} {
		if strings.Contains(all, leak) {
			t.Errorf("the log contains %q", leak)
		}
	}
}

// R2
func TestCSPReportLimits(t *testing.T) {
	post := poster(t, New(cspDeps(&syncBuffer{})))
	big := `[{"type":"csp-violation","body":{"sample":"` + strings.Repeat("a", 65*1024) + `"}}]`
	wantJSON(t, post(reportsJSON, big), http.StatusRequestEntityTooLarge, `{"error":{"code":"invalid","message":"payload too large"}}`)
	wantJSON(t, post("text/plain", "[]"), http.StatusUnsupportedMediaType, `{"error":{"code":"invalid","message":"unsupported media type"}}`)
	wantJSON(t, post(reportsJSON, "{"), http.StatusBadRequest, `{"error":{"code":"invalid","message":"bad request"}}`)
}

// R3
func TestCSPReportRateLimit(t *testing.T) {
	var mu sync.Mutex
	now := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	d := cspDeps(&syncBuffer{})
	d.Now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	post := poster(t, New(d))
	body := mustJSON([]any{violation(map[string]any{"effectiveDirective": "img-src"})})
	for i := range 20 {
		if rec := post(reportsJSON, body); rec.Code != http.StatusNoContent {
			t.Fatalf("request %d: %d, want 204", i+1, rec.Code)
		}
	}
	rec := post(reportsJSON, body)
	wantJSON(t, rec, http.StatusTooManyRequests, `{"error":{"code":"unavailable","message":"rate limited"}}`)
	if got := rec.Header().Get("Retry-After"); got != "1" {
		t.Errorf("Retry-After = %q, want 1", got)
	}
	mu.Lock()
	now = now.Add(time.Second)
	mu.Unlock()
	if rec := post(reportsJSON, body); rec.Code != http.StatusNoContent {
		t.Errorf("after 1 s: %d, want 204", rec.Code)
	}
}

// R4
func TestCSPReportTruncation(t *testing.T) {
	logs := &syncBuffer{}
	post := poster(t, New(cspDeps(logs)))
	var reports []any
	for range 25 {
		reports = append(reports, violation(map[string]any{"effectiveDirective": "font-src"}))
	}
	if rec := post(reportsJSON, mustJSON(reports)); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", rec.Code)
	}
	recs := logs.records(t)
	if n := len(byMsg(recs, "csp_violation")); n != 20 {
		t.Errorf("%d csp_violation records, want 20", n)
	}
	tr := byMsg(recs, "csp_report_truncated")
	if len(tr) != 1 || tr[0]["ignored"] != float64(5) {
		t.Errorf("truncation records = %v, want one with ignored=5", tr)
	}
}

// R5
func TestCSPReportLogsNoSecrets(t *testing.T) {
	const secret = "s3cr3t-T0K"
	logs := &syncBuffer{}
	post := poster(t, New(cspDeps(logs)))
	extra := map[string]any{
		"sample": secret, "sourceFile": "https://" + secret + "/a.js", "referrer": "https://" + secret + "/",
		"statusCode": 200, "lineNumber": 7, "columnNumber": 9, "x-" + secret: secret,
	}
	with := func(m map[string]any) map[string]any {
		for k, v := range extra {
			m[k] = v
		}
		return violation(m)
	}
	reports := []any{
		with(map[string]any{"effectiveDirective": "script-src " + secret, "disposition": "enforce"}),
		with(map[string]any{"effectiveDirective": secret, "disposition": "enforce"}),
		with(map[string]any{"effectiveDirective": "img-src", "disposition": secret}),
		with(map[string]any{"effectiveDirective": "img-src", "blockedURL": "https://" + secret + ".corp/" + secret + "?k=" + secret}),
		with(map[string]any{"effectiveDirective": "img-src", "documentURL": "http://x/t/" + secret + "/boards/" + secret}),
		with(map[string]any{"effectiveDirective": "img-src", "documentURL": "http://x/" + secret}),
	}
	if rec := post(reportsJSON, mustJSON(reports)); rec.Code != http.StatusNoContent {
		t.Fatalf("status %d, want 204", rec.Code)
	}
	if all := logs.buf.String(); strings.Contains(all, secret) {
		t.Errorf("the log contains the secret:\n%s", all)
	}
	recs := byMsg(logs.records(t), "csp_violation")
	if len(recs) != 6 {
		t.Fatalf("%d csp_violation records, want 6", len(recs))
	}
	for i, w := range []struct{ key, want string }{
		{"directive", "script-src"}, {"directive", "other"}, {"disposition", "other"},
		{"blocked", "url"}, {"route", "unknown"}, {"route", "unknown"},
	} {
		if recs[i][w.key] != w.want {
			t.Errorf("record %d %s = %v, want %s", i, w.key, recs[i][w.key], w.want)
		}
	}
	for _, r := range recs {
		for k := range r {
			if !slices.Contains([]string{"time", "level", "msg", "directive", "disposition", "route", "blocked"}, k) {
				t.Errorf("record has attribute %q", k)
			}
		}
	}
}

// rawPost opens a connection and sends the headers of a csp-report with Content-Length 1000 and
// the first 10 bytes of its body, then stalls.
func rawPost(t *testing.T, addr string) net.Conn {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	_, err = fmt.Fprintf(c, "POST %s HTTP/1.1\r\nHost: x\r\nContent-Type: %s\r\nContent-Length: 1000\r\n\r\n[{\"type\":\"", cspPath, reportsJSON)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func readResponse(t *testing.T, c net.Conn, within time.Duration) (*http.Response, []byte, *bufio.Reader) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(within))
	br := bufio.NewReader(c)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatalf("no response within %v: %v", within, err)
	}
	b, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		t.Fatalf("response body: %v", err)
	}
	return resp, b, br
}

// R6
func TestCSPReportStalledBody(t *testing.T) {
	logs := &syncBuffer{}
	d := cspDeps(logs)
	d.CSPReadTimeout = 100 * time.Millisecond
	srv := cspServer(t, d)
	addr := strings.TrimPrefix(srv.URL, "http://")

	c := rawPost(t, addr)
	start := time.Now()
	resp, body, br := readResponse(t, c, time.Second)
	if resp.StatusCode != http.StatusRequestTimeout {
		t.Fatalf("stalled body: status %d, want 408", resp.StatusCode)
	}
	if d := time.Since(start); d > time.Second {
		t.Errorf("408 after %v, want within 1s", d)
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var env api.ErrorEnvelope
	if err := dec.Decode(&env); err != nil || env.Error.Code != api.Invalid || env.Error.Message != "request timeout" {
		t.Errorf("408 body %q (%v), want the envelope invalid/request timeout", body, err)
	}
	if _, err := br.ReadByte(); err != io.EOF {
		t.Errorf("after the 408 the connection is open (read err %v), want it closed", err)
	}
	found := false
	for _, r := range byMsg(logs.records(t), "http") {
		if r["route"] == cspPath && r["status"] == float64(408) {
			found = true
		}
	}
	if !found {
		t.Error("no access-log record with status=408")
	}

	// Concurrency: eight stalled reports hold every slot, the ninth is refused. A longer deadline
	// keeps the eight in flight while the ninth arrives.
	d2 := cspDeps(&syncBuffer{})
	d2.CSPReadTimeout = time.Second
	srv2 := cspServer(t, d2)
	addr2 := strings.TrimPrefix(srv2.URL, "http://")
	var stalls []net.Conn
	for range 8 {
		stalls = append(stalls, rawPost(t, addr2))
	}
	time.Sleep(200 * time.Millisecond)
	ninth := rawPost(t, addr2)
	resp, body, _ = readResponse(t, ninth, 500*time.Millisecond)
	if resp.StatusCode != http.StatusTooManyRequests || resp.Header.Get("Retry-After") != "1" {
		t.Errorf("ninth stall: %d %q (Retry-After %q), want 429 with Retry-After: 1", resp.StatusCode, body, resp.Header.Get("Retry-After"))
	}
	for i, s := range stalls {
		if resp, _, _ := readResponse(t, s, 3*time.Second); resp.StatusCode != http.StatusRequestTimeout {
			t.Errorf("stall %d: %d, want 408", i, resp.StatusCode)
		}
	}
	res, err := http.Post(srv2.URL+cspPath, reportsJSON, strings.NewReader(mustJSON([]any{violation(map[string]any{"effectiveDirective": "img-src"})})))
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		t.Errorf("after the stalls: %d, want 204 (slots released)", res.StatusCode)
	}
}

// countingReader records whether it was read.
type countingReader struct{ reads int }

func (r *countingReader) Read([]byte) (int, error) { r.reads++; return 0, io.EOF }

// R7
func TestCSPReportNoDeadlineSupport(t *testing.T) {
	logs := &syncBuffer{}
	h := newCSPReport(cspDeps(logs))
	body := &countingReader{}
	req := httptest.NewRequest(http.MethodPost, cspPath, body)
	req.Header.Set("Content-Type", reportsJSON)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	wantJSON(t, rec, http.StatusInternalServerError, `{"error":{"code":"internal","message":"internal error"}}`)
	if got := rec.Header().Get("Connection"); got != "close" {
		t.Errorf("Connection = %q, want close", got)
	}
	if body.reads != 0 {
		t.Errorf("the body was read %d times, want 0", body.reads)
	}
	var errs []map[string]any
	for _, r := range logs.records(t) {
		if r["level"] == "ERROR" && r["msg"] == "csp_report_no_deadline" {
			errs = append(errs, r)
		}
	}
	if len(errs) != 1 {
		t.Errorf("%d error records csp_report_no_deadline, want 1", len(errs))
	}
}

// R9
func TestCSPReportStatusesInSpec(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "api", "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Paths map[string]map[string]struct {
			OperationID string               `yaml:"operationId"`
			Responses   map[string]yaml.Node `yaml:"responses"`
		} `yaml:"paths"`
	}
	if err := yaml.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	op, ok := doc.Paths[cspPath]["post"]
	if !ok || op.OperationID != "postCspReport" {
		t.Fatalf("no postCspReport operation at %s", cspPath)
	}
	var codes []string
	for c := range op.Responses {
		codes = append(codes, c)
	}
	slices.Sort(codes)
	if want := []string{"204", "400", "408", "413", "415", "429", "500"}; !slices.Equal(codes, want) {
		t.Errorf("postCspReport responses = %v, want %v", codes, want)
	}
}

// The read deadline is wall-clock time: a limiter clock fixed in the past must not time out a
// body that arrives after the headers.
func TestCSPReportDeadlineIsWallClock(t *testing.T) {
	d := cspDeps(&syncBuffer{})
	d.Now = func() time.Time { return time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC) }
	srv := cspServer(t, d)
	body := mustJSON([]any{violation(map[string]any{"effectiveDirective": "img-src"})})
	c, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	if _, err := fmt.Fprintf(c, "POST %s HTTP/1.1\r\nHost: x\r\nContent-Type: %s\r\nContent-Length: %d\r\n\r\n", cspPath, reportsJSON, len(body)); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if _, err := io.WriteString(c, body); err != nil {
		t.Fatal(err)
	}
	if resp, _, _ := readResponse(t, c, 2*time.Second); resp.StatusCode != http.StatusNoContent {
		t.Errorf("status %d, want 204", resp.StatusCode)
	}
}
