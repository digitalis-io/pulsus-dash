package pulsusdb

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// The probe of PulsusDB's LogQL lexer (plan #121 §3.4, §4.2) and its recorder. The recorder writes
// only files built from constants and validated facts, never received bytes (§4.4).

// lexerCase is one probe text and the answer PulsusDB 0.0.13 gave at design time.
type lexerCase struct {
	id, query  string // query is sent byte for byte
	status     int    // 200 or 400
	message    string // the exact text/plain body of a 400
	transcript string // "logs-fffd-dq", "logs-fffd-bq" or ""
}

// fffd is U+FFFD, the replacement character, as UTF-8.
const fffd = "�"

// hashMsg is PulsusDB's refusal of a '#' at byte n.
func hashMsg(n int) string {
	return "unexpected '#' at byte " + strconv.Itoa(n) + ": expected a valid LogQL token"
}

// lexerCases are the rows of plan #121 §4.2, in order.
var lexerCases = []lexerCase{
	{id: "P1", query: "{app=\"xyz\"} # c", status: 400, message: hashMsg(12)},
	{id: "P2", query: "# c\r{app=\"x\"}", status: 400, message: hashMsg(0)},
	{id: "P3", query: "{app=\"x\"} # c\r)", status: 400, message: hashMsg(10)},
	{id: "P4", query: "{app=\"x\"} # c\n)", status: 400, message: hashMsg(10)},
	{id: "P5", query: "{app=\"x\"}\r|= \"y\"", status: 200},
	{id: "P6", query: "{app=\"x" + fffd + "y\"}", status: 200, transcript: "logs-fffd-dq"},
	{id: "P7", query: "{app=`x" + fffd + "y`}", status: 200, transcript: "logs-fffd-bq"},
	{id: "P8", query: "{app=\"x" + fffd + "y\"} )", status: 400, message: "unexpected trailing input at byte 14"},
	{id: "P9", query: "{app=`x" + fffd + "y`} )", status: 400, message: "unexpected trailing input at byte 14"},
	{id: "P10", query: "{app=\"x\\ufffdy\"}", status: 200},
	{id: "P11", query: "{app=\"x\"} " + fffd, status: 400, message: "unexpected '" + fffd + "' at byte 10: expected a valid LogQL token"},
	{id: "P12", query: "{app=\"#\"}", status: 200},
}

// probeResult is one answer as received: nothing of it is ever written or printed.
type probeResult struct {
	status int
	ctype  string
	body   []byte
}

// maxProbeBody bounds every probe body read.
const maxProbeBody = 64 << 10

// The probe's fixed errors: a reason code each, never a wrapped transport error, URL or response
// value. (errTooLarge is the package's body-limit error, so these carry a probe prefix.)
var (
	errProbeRequest   = errors.New("request")
	errProbeTransport = errors.New("transport")
	errProbeRead      = errors.New("read")
	errProbeTooLarge  = errors.New("too large")
)

// The recorder is not written yet (plan #121 tests first): every entry point is a stub.

func rawLogResponse(_ context.Context, _ *Client, _ *core.RequestCtx, _ url.Values) (probeResult, error) {
	return probeResult{}, nil
}

func rawBuildInfo(_ context.Context, _ *Client, _ *core.RequestCtx) (probeResult, error) {
	return probeResult{}, nil
}

func runLexer(_ context.Context, _ *Client, _ *core.RequestCtx, _ []lexerCase, _ []string, _, _ string) error {
	return nil
}

func synthesise(_ []lexerCase, _ []probeResult, _ probeResult, _ []string, _ string) (map[string][]byte, error) {
	return nil, nil
}

func leaks(_ []byte, _ []string) bool { return false }

func writeAll(_ string, _ map[string][]byte) error { return nil }

func probeSecrets(_, _, _ string) []string { return nil }

// emptyStreamsBody is the empty 200 answer of the design-time probe.
const emptyStreamsBody = `{"status":"success","data":{"resultType":"streams","encodingFlags":["categorize-labels"],"result":[],"stats":{"streams":0,"entries":0,"bytes":0}}}`

// wantFFFDdq is the §3.5 text of logs-fffd-dq for 2026-01-01 and PulsusDB 0.0.0.
const wantFFFDdq = `{
  "name": "logs-fffd-dq",
  "provenance": {"captured": "2026-01-01", "pulsusdb": "0.0.0", "route": "/api/logs/v1/query_range", "sanitised": "synthesised from validated fields: status, resultType, an empty result"},
  "match": {"method": "GET", "paths": ["/api/logs/v1/query_range"], "query": "{app=\"x�y\"}"},
  "response": {
    "status": 200,
    "headers": {"Content-Type": "application/json", "X-Pulsus-Query-Id": "fake-logs-fffd-dq-1"},
    "body": {"status":"success","data":{"resultType":"streams","encodingFlags":["categorize-labels"],"result":[],"stats":{"streams":0,"entries":0,"bytes":0}}}
  }
}
`

// answerOf is the design-time answer of a case.
func answerOf(lc lexerCase) probeResult {
	if lc.status == http.StatusBadRequest {
		return probeResult{status: 400, ctype: "text/plain; charset=utf-8", body: []byte(lc.message)}
	}
	return probeResult{status: 200, ctype: "application/json", body: []byte(emptyStreamsBody)}
}

func goodResults() []probeResult {
	out := make([]probeResult, 0, len(lexerCases))
	for _, lc := range lexerCases {
		out = append(out, answerOf(lc))
	}
	return out
}

func buildInfoOf(version string) probeResult {
	return probeResult{status: 200, ctype: "application/json",
		body: []byte(`{"status":"success","data":{"version":"` + version + `","revision":"r","goVersion":"go"}}`)}
}

// caseIndex is the index of the case id in lexerCases.
func caseIndex(t *testing.T, id string) int {
	t.Helper()
	i := slices.IndexFunc(lexerCases, func(lc lexerCase) bool { return lc.id == id })
	if i < 0 {
		t.Fatalf("no case %s", id)
	}
	return i
}

func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	es, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, 0, len(es))
	for _, e := range es {
		out = append(out, e.Name())
	}
	return out
}

// noSecret fails when the error text holds any secret in any encoding leaks knows.
func noSecret(t *testing.T, what string, err error, secrets []string, extra ...string) {
	t.Helper()
	if err == nil {
		return
	}
	if leaks([]byte(err.Error()), append(slices.Clone(secrets), extra...)) {
		t.Errorf("%s: the error %q holds a secret", what, err)
	}
}

// unit:lexer-record (plan #121 §5.1): the recorder writes only synthesised, validated files,
// refuses any secret in any encoding and writes all files or none.
func TestLexerRecord(t *testing.T) {
	host := "probe-secret-host"
	secrets := []string{host, host + ":9999", "http" + "://" + host + ":9999"}
	date, bi := "2026-01-01", buildInfoOf("0.0.0")

	t.Run("ok", func(t *testing.T) {
		files, err := synthesise(lexerCases, goodResults(), bi, secrets, date)
		if err != nil || len(files) != 3 {
			t.Fatalf("synthesise: %d files, %v; want 3", len(files), err)
		}
		if got := string(files["logs-fffd-dq.json"]); got != wantFFFDdq {
			t.Errorf("logs-fffd-dq.json\n%s\nwant\n%s", got, wantFFFDdq)
		}
		if bq := string(files["logs-fffd-bq.json"]); !strings.Contains(bq, `"query": "{app=`+"`x\\ufffdy`"+`}"`) || !strings.Contains(bq, "fake-logs-fffd-bq-1") {
			t.Errorf("logs-fffd-bq.json\n%s", bq)
		}
		txt := string(files["lexer-transcript.txt"])
		if !strings.HasPrefix(txt, "pulsusdb 0.0.0, GET /api/logs/v1/query_range, 2026-01-01 UTC\n") ||
			!strings.Contains(txt, "\nP1 query=\"{app=\\\"xyz\\\"} # c\" status=400 message=\"unexpected '#' at byte 12: expected a valid LogQL token\"\n") ||
			!strings.Contains(txt, "\nP12 query=\"{app=\\\"#\\\"}\" status=200 result=empty streams\n") || strings.Count(txt, "\n") != 13 {
			t.Errorf("lexer-transcript.txt\n%s", txt)
		}
		dir := t.TempDir()
		if err := writeAll(dir, files); err != nil {
			t.Fatalf("writeAll: %v", err)
		}
		if names := dirNames(t, dir); !slices.Equal(names, []string{"lexer-transcript.txt", "logs-fffd-bq.json", "logs-fffd-dq.json"}) {
			t.Errorf("files %v", names)
		}
		if b, err := os.ReadFile(filepath.Join(dir, "logs-fffd-dq.json")); err != nil || string(b) != wantFFFDdq {
			t.Errorf("written logs-fffd-dq.json: %v", err)
		}
	})

	t.Run("no flags", func(t *testing.T) {
		got := goodResults()
		got[caseIndex(t, "P6")].body = []byte(`{"status":"success","data":{"resultType":"streams","result":[],"stats":{"streams":0,"entries":0,"bytes":0}}}`)
		files, err := synthesise(lexerCases, got, bi, secrets, date)
		if err != nil || strings.Contains(string(files["logs-fffd-dq.json"]), "encodingFlags") ||
			!strings.Contains(string(files["logs-fffd-bq.json"]), `"encodingFlags":["categorize-labels"]`) {
			t.Errorf("synthesise without flags: %v\n%s", err, files["logs-fffd-dq.json"])
		}
	})

	b64 := base64.StdEncoding.EncodeToString([]byte(host))
	for _, c := range []struct {
		name, id, ctype, body, want string
	}{
		{"encoded host: a \\u escape", "P6", "application/json",
			`{"status":"success","warnings":["probe-secret-host"],"data":{"resultType":"streams","result":[],"stats":{"streams":0,"entries":0,"bytes":0}}}`, "P6: leak"},
		{"encoded host: percent-encoded", "P1", "text/plain; charset=utf-8", "unexpected '#' at byte 12: probe%2Dsecret-host", "P1: leak"},
		{"encoded host: base64 in a flag", "P6", "application/json",
			`{"status":"success","data":{"resultType":"streams","encodingFlags":["` + b64 + `"],"result":[],"stats":{"streams":0,"entries":0,"bytes":0}}}`, "P6: leak"},
		{"non-empty result", "P6", "application/json",
			`{"status":"success","data":{"resultType":"streams","result":[{"stream":{"app":"x"},"values":[["1","secret-line"]]}],"stats":{"streams":0,"entries":0,"bytes":0}}}`, "P6: result not empty"},
		{"unknown field", "P6", "application/json",
			`{"status":"success","data":{"resultType":"streams","extra":1,"result":[],"stats":{"streams":0,"entries":0,"bytes":0}}}`, "P6: unknown field"},
		{"stats not zero", "P6", "application/json",
			`{"status":"success","data":{"resultType":"streams","result":[],"stats":{"streams":0,"entries":1,"bytes":0}}}`, "P6: stats not zero"},
		{"flag not allowed", "P6", "application/json",
			`{"status":"success","data":{"resultType":"streams","encodingFlags":["other"],"result":[],"stats":{"streams":0,"entries":0,"bytes":0}}}`, "P6: flag not allowed"},
		{"trailing data", "P6", "application/json", emptyStreamsBody + `{}`, "P6: body"},
		{"content type", "P6", "application/json; charset=utf-8", emptyStreamsBody, "P6: content type"},
		{"message differs", "P8", "text/plain; charset=utf-8", "unexpected trailing input at byte 13", "P8: message differs"},
		{"status", "P5", "text/plain; charset=utf-8", "x", "P5: status"},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := goodResults()
			i := caseIndex(t, c.id)
			got[i] = probeResult{status: got[i].status, ctype: c.ctype, body: []byte(c.body)}
			if c.name == "status" {
				got[i].status = 400
			}
			files, err := synthesise(lexerCases, got, bi, secrets, date)
			if files != nil || err == nil || err.Error() != c.want {
				t.Errorf("synthesise: %d files, %v; want %q", len(files), err, c.want)
			}
			noSecret(t, c.name, err, secrets, "secret-line")
		})
	}

	t.Run("no files on failure", func(t *testing.T) {
		got := goodResults()
		got[caseIndex(t, "P12")] = probeResult{status: 400, ctype: "text/plain; charset=utf-8", body: []byte("x")}
		dir := t.TempDir()
		files, err := synthesise(lexerCases, got, bi, secrets, date)
		if err == nil {
			if werr := writeAll(dir, files); werr != nil {
				t.Errorf("writeAll: %v", werr)
			}
		}
		if files != nil || err == nil || err.Error() != "P12: status" {
			t.Errorf("synthesise: %d files, %v; want P12: status", len(files), err)
		}
		if names := dirNames(t, dir); len(names) != 0 {
			t.Errorf("files %v after a failure", names)
		}
	})

	t.Run("writeAll", func(t *testing.T) {
		files, err := synthesise(lexerCases, goodResults(), bi, secrets, date)
		if err != nil {
			t.Fatal(err)
		}
		full := t.TempDir()
		keep := filepath.Join(full, "keep.txt")
		if err := os.WriteFile(keep, []byte("keep"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := writeAll(full, files); err == nil {
			t.Error("writeAll to a non-empty dir: nil error")
		}
		if b, err := os.ReadFile(keep); err != nil || string(b) != "keep" || len(dirNames(t, full)) != 1 {
			t.Errorf("non-empty dir changed: %q %v %v", b, err, dirNames(t, full))
		}
		inRepo, err := os.MkdirTemp(".", ".lexer-record-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(inRepo) })
		if err := writeAll(inRepo, files); err == nil {
			t.Error("writeAll to a dir in the repository: nil error")
		}
		if names := dirNames(t, inRepo); len(names) != 0 {
			t.Errorf("files %v in the repository", names)
		}
		nul := t.TempDir()
		if err := writeAll(nul, map[string][]byte{"a.json": []byte("a"), "b.json": []byte("b"), "c\x00.json": []byte("c")}); err == nil {
			t.Error("writeAll with a NUL name: nil error")
		}
		if names := dirNames(t, nul); len(names) != 0 {
			t.Errorf("files %v after a failed write", names)
		}
		if err := writeAll(filepath.Join(nul, "missing"), files); err == nil {
			t.Error("writeAll to a missing dir: nil error")
		}
	})

	t.Run("version", func(t *testing.T) {
		for _, v := range []string{"0.0.13-x/y", "", "v0.0.13"} {
			files, err := synthesise(lexerCases, goodResults(), buildInfoOf(v), secrets, date)
			if files != nil || err == nil || err.Error() != "buildinfo: version withheld" {
				t.Errorf("version %q: %d files, %v; want version withheld", v, len(files), err)
			}
		}
		if _, err := synthesise(lexerCases, goodResults()[1:], bi, secrets, date); err == nil || err.Error() != "probe: count" {
			t.Errorf("count: %v", err)
		}
	})

	t.Run("leaks", func(t *testing.T) {
		for _, b := range []string{host, "PROBE-SECRET-HOST", "probe%2Dsecret-host", "probe%252Dsecret-host", "probe\\x2dsecret-host",
			"probe&#45;secret-host", "probe&#x2d;secret-host", b64, base64.URLEncoding.EncodeToString([]byte(host + ":9999")),
			url.QueryEscape(secrets[2])} {
			if !leaks([]byte("a "+b+" z"), secrets) {
				t.Errorf("leaks(%q) = false", b)
			}
		}
		if leaks([]byte("probe-secret"), secrets) || leaks([]byte(host), nil) {
			t.Error("leaks without a secret")
		}
	})
}

// lexerServer answers every probe case as §4.2 and the build info as 0.0.13, except where
// override answers (it returns true).
func lexerServer(t *testing.T, override func(w http.ResponseWriter, r *http.Request, id string) bool) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/status/buildinfo":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"status":"success","data":{"version":"0.0.13"}}`)
			return
		case "/api/logs/v1/query_range":
		default:
			http.NotFound(w, r)
			return
		}
		q := r.URL.Query()
		i := slices.IndexFunc(lexerCases, func(lc lexerCase) bool { return lc.query == q.Get("query") })
		if i < 0 || q.Get("limit") != "1" || q.Get("direction") != "backward" || r.Header.Get(categorizeHeader) != categorizeValue {
			http.Error(w, "unexpected probe", http.StatusTeapot)
			return
		}
		if override != nil && override(w, r, lexerCases[i].id) {
			return
		}
		a := answerOf(lexerCases[i])
		w.Header().Set("Content-Type", a.ctype)
		w.WriteHeader(a.status)
		_, _ = w.Write(a.body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// unit:lexer-record, the full path (plan #121 §5.1 TestLexerRunPath): runLexer against an
// httptest server, through the probe's own bounded reads.
func TestLexerRunPath(t *testing.T) {
	answer := func(id, ctype, body string) func(http.ResponseWriter, *http.Request, string) bool {
		return func(w http.ResponseWriter, _ *http.Request, got string) bool {
			if got != id {
				return false
			}
			w.Header().Set("Content-Type", ctype)
			_, _ = io.WriteString(w, body)
			return true
		}
	}
	// 64 KiB + 2 bytes: the secret once before the 64 KiB mark and once across it, ending after it.
	over := `{"status":"success","x":"probe-secret-host`
	over += strings.Repeat("a", maxProbeBody+2-len(over)-len("probe-secret-host")) + "probe-secret-host"
	if len(over) != maxProbeBody+2 || !strings.HasSuffix(over[:maxProbeBody], "probe-secret-ho") {
		t.Fatalf("oversized body of %d bytes", len(over))
	}
	for _, c := range []struct {
		name     string
		override func(http.ResponseWriter, *http.Request, string) bool
		want     []string // any of
		hidden   []string // never in the error
	}{
		{"a truncated body", answer("P6", "application/json", `{"status":"success","data":{"resultType":"probe-secret-host","result":[{"stream":`),
			[]string{"P6: unknown field", "P6: body"}, []string{"probe-secret-host"}},
		{"b a non-empty result", answer("P6", "application/json",
			`{"status":"success","data":{"resultType":"streams","result":[{"stream":{"app":"secret-label"},"values":[["1","secret-line"]]}],"stats":{"streams":1,"entries":1,"bytes":11}}}`),
			[]string{"P6: result not empty"}, []string{"secret-label", "secret-line"}},
		{"c a closed connection", func(w http.ResponseWriter, _ *http.Request, id string) bool {
			if id != "P3" {
				return false
			}
			conn, _, err := http.NewResponseController(w).Hijack()
			if err == nil {
				_ = conn.Close()
			}
			return true
		}, []string{"P3: transport"}, nil},
		{"d all as designed", nil, nil, nil},
		{"e oversized", answer("P6", "application/json", over), []string{"P6: too large"}, []string{"probe-secret-host"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			srv := lexerServer(t, c.override)
			secrets := probeSecrets(srv.URL, "", "")
			cl := New(Options{Transport: http.DefaultTransport.(*http.Transport).Clone()})
			dir := t.TempDir()
			err := runLexer(ctxWithin(t, 30*time.Second), cl, rcFor(testBinding(srv.URL)), lexerCases, secrets, "2026-01-01", dir)
			names := dirNames(t, dir)
			if c.want == nil {
				if err != nil || !slices.Equal(names, []string{"lexer-transcript.txt", "logs-fffd-bq.json", "logs-fffd-dq.json"}) {
					t.Fatalf("runLexer: %v, files %v", err, names)
				}
				if b, _ := os.ReadFile(filepath.Join(dir, "lexer-transcript.txt")); !strings.HasPrefix(string(b), "pulsusdb 0.0.13, GET ") {
					t.Errorf("lexer-transcript.txt %q", b)
				}
				return
			}
			if err == nil || !slices.Contains(c.want, err.Error()) {
				t.Errorf("runLexer: %v, want one of %q", err, c.want)
			}
			noSecret(t, c.name, err, secrets, c.hidden...)
			if err != nil && strings.Contains(err.Error(), "http") {
				t.Errorf("runLexer: %q names a URL", err)
			}
			if len(names) != 0 {
				t.Errorf("files %v after a failure", names)
			}
		})
	}
}
