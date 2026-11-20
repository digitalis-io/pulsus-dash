package gateway

import (
	"bufio"
	"bytes"
	"encoding/json"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake/fakeharness"
)

var update = flag.Bool("update", false, "rewrite the golden response bodies in wire/fixtures/json")

// unit:range-golden (T04-001, T06-008): the response bytes of A.5.
func TestRangeGolden(t *testing.T) {
	_, url := fakeharness.Start(t)
	h, _ := queryGateway(t, url, pulsusdb.Options{})
	for _, c := range []struct{ file, path, body string }{
		{"promql-range-counter.json", rangePath, counterReq},
		{"promql-instant-gauge.json", instantPath, `{"query":"node_memory_free_bytes","at":1767229200000}`},
		{"promql-instant-scalar.json", instantPath, `{"query":"scalar(vector(1)) / 0","at":1767229200000}`},
	} {
		rec := postJSON(h, c.path, c.body)
		if rec.Code != 200 || rec.Header().Get("Content-Type") != "application/json" {
			t.Errorf("%s: %d %q %s", c.file, rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
			continue
		}
		path := "../../../wire/fixtures/json/" + c.file
		if *update {
			if err := os.WriteFile(path, rec.Body.Bytes(), 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		want, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(rec.Body.Bytes(), want) {
			t.Errorf("%s differs from the golden file:\n got %.400s\nwant %.400s", c.file, rec.Body.String(), want)
		}
	}
}

// The golden counter body, checked against A.5 independently of the file.
func TestRangeCounterShape(t *testing.T) {
	_, url := fakeharness.Start(t)
	h, _ := queryGateway(t, url, pulsusdb.Options{})
	rec := postJSON(h, rangePath, counterReq)
	body := rec.Body.String()
	for _, want := range []string{
		`{"start":1767225600000,"end":1767229200000,"step":5000,"frames":[{"key":"47ad55f1f828d9ee","labels":{"instance":"a:9090","job":"api"},"timestamps":[1767225600000,1767225605000,`,
		`"values":[0.1,"NaN","+Inf","-Inf",null,-0,5e-324,0.30000000000000004,null,`,
		`,1e+308]},{"key":"`,
		`"labels":{"instance":"b:9090","job":"api"}`,
		`],"completeness":{"truncated":false,"warnings":[],"infos":[],"query_id":"fake-counter-1","data_age_ms":30000,"read_cache":"miss"}}`,
	} {
		if rec.Code != 200 || !strings.Contains(body, want) {
			t.Errorf("%d: body lacks %s", rec.Code, want)
		}
	}
	if !strings.HasSuffix(body, `"read_cache":"miss"}}`) || strings.Count(body, `"key":`) != 2 {
		t.Errorf("body tail %q", body[max(0, len(body)-200):])
	}
}

// unit:range-streams (T06-011): the first frame arrives while the upstream still holds the rest.
func TestRangeStreams(t *testing.T) {
	release := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"api"},"values":[[1767225600,"1"]]}`)
		http.NewResponseController(w).Flush()
		select {
		case <-release:
		case <-r.Context().Done():
		}
		_, _ = io.WriteString(w, `]}}`)
	}))
	defer up.Close()
	defer close(release)
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	srv := httptest.NewServer(h)
	defer srv.Close()
	resp, err := http.Post(srv.URL+rangePath, "application/json", strings.NewReader(counterReq))
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
		if resp.StatusCode != 200 || !strings.HasPrefix(b, `{"start":1767225600000,"end":1767229200000,"step":5000,"frames":[{"key":`) {
			t.Errorf("%d first bytes %q", resp.StatusCode, b)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no complete frame before the upstream finished: the gateway buffers")
	}
}

// unit:range-abort (§4.1 step 10): a failure after the first frame resets the connection.
func TestRangeAbort(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"api"},"values":[[1767225600,"1"]]},`)
		http.NewResponseController(w).Flush()
		conn, _, err := http.NewResponseController(w).Hijack()
		if err == nil {
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
	if err == nil {
		t.Errorf("the body read succeeded (%d bytes %q): a truncated body looked complete", len(b), b)
	}
	if json.Valid(b) {
		t.Errorf("the partial body is valid JSON: %q", b)
	}
	found := false
	for _, r := range logs.records(t) {
		if r["msg"] == "promql_stream_aborted" {
			found = true
		}
	}
	if !found {
		t.Error("no msg=promql_stream_aborted log record")
	}
}

// unit:virtual-guard (gateway half): refused with the pointer of its input, before any request.
func TestVirtualGuardRoutes(t *testing.T) {
	fake, url := fakeharness.Start(t)
	h, _ := queryGateway(t, url, pulsusdb.Options{})
	const q = "&from=1767225600000&to=1767229200000"
	for _, c := range []struct {
		name    string
		rec     func() *httptest.ResponseRecorder
		pointer string
	}{
		{"range", func() *httptest.ResponseRecorder {
			return postJSON(h, rangePath, `{"query":"count(ALERTS)","from":1,"to":2,"width_px":10}`)
		}, "/query"},
		{"instant", func() *httptest.ResponseRecorder { return postJSON(h, instantPath, `{"query":"ALERTS","at":1}`) }, "/query"},
		{"labels", func() *httptest.ResponseRecorder {
			return do(h, http.MethodGet, "/api/dash/v1/prom/labels?tenant=demo"+q+"&match=ALERTS")
		}, "/match/0"},
		{"series", func() *httptest.ResponseRecorder {
			return do(h, http.MethodGet, "/api/dash/v1/prom/series?tenant=demo"+q+"&match=up&match=ALERTS")
		}, "/match/1"},
		{"label values", func() *httptest.ResponseRecorder {
			return do(h, http.MethodGet, "/api/dash/v1/prom/label/job/values?tenant=demo"+q+"&match=ALERTS_FOR_STATE")
		}, "/match/0"},
		{"metadata", func() *httptest.ResponseRecorder {
			return do(h, http.MethodGet, "/api/dash/v1/prom/metadata?tenant=demo&metric=ALERTS")
		}, "/metric"},
	} {
		e := wantError(t, c.name, c.rec(), 400, "virtual_unsupported", c.pointer, "query.reserved")
		if r, _ := e.Error.Hint["reserved"].(string); r != "ALERTS" && r != "ALERTS_FOR_STATE" {
			t.Errorf("%s: hint %v", c.name, e.Error.Hint)
		}
		if n := len(fake.Requests()); n != 0 {
			t.Errorf("%s: the fake received %d requests", c.name, n)
		}
	}
}

// unit:sanitise (gateway half; review r1 #7, T06-024).
func TestSanitiseThroughGateway(t *testing.T) {
	const cred = "user:pw-secret"
	const token = "dXNlcjpwdy1zZWNyZXQ="
	var upURL string
	mode := ""
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := strings.TrimPrefix(upURL, "http://")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "a=b")
		w.Header().Set("X-Extra", "y")
		switch mode {
		case "error":
			w.Header().Set("X-Pulsus-Query-Id", "bad id!")
			w.WriteHeader(400)
			msg := "bad " + cred + " at " + upURL + "/x host " + host + " " + token + " \u0007" + strings.Repeat("z", 2000)
			b, _ := json.Marshal(map[string]string{"status": "error", "errorType": "bad_data", "error": msg})
			_, _ = w.Write(b)
		case "warnings":
			w.Header().Set("X-Pulsus-Query-Id", "pw-secret")
			ws := make([]string, 25)
			for i := range ws {
				ws[i] = "w" + strings.Repeat("x", i)
			}
			ws[3] = "leak pw-secret here"
			b, _ := json.Marshal(ws)
			_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[]},"warnings":`+string(b)+`}`)
		case "embedded":
			w.Header().Set("X-Pulsus-Query-Id", "aapw-secretbb")
			w.Header().Set("X-Pulsus-Read-Cache", "pw-secret")
			_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
		case "metadata":
			_, _ = io.WriteString(w, `{"status":"success","data":{"up":[{"type":"gauge","help":"see `+cred+`","unit":""}]}}`)
		}
	}))
	defer up.Close()
	upURL = up.URL
	host := strings.TrimPrefix(up.URL, "http://")
	h, logs := queryGateway(t, up.URL, pulsusdb.Options{Secrets: secretsMap(map[string]string{"env:C": cred})}, withCredentials("env:C"))
	needles := []string{cred, "pw-secret", up.URL, host, token}
	clean := func(what string, rec *httptest.ResponseRecorder) {
		t.Helper()
		for _, n := range needles {
			if strings.Contains(rec.Body.String(), n) {
				t.Errorf("%s: response contains %q: %s", what, n, rec.Body.String())
			}
		}
		if rec.Header().Get("Set-Cookie") != "" || rec.Header().Get("X-Extra") != "" {
			t.Errorf("%s: upstream headers forwarded: %v", what, rec.Header())
		}
	}

	mode = "error"
	rec := postJSON(h, rangePath, `{"query":"up","from":1767225600000,"to":1767229200000,"width_px":1200}`)
	clean("error", rec)
	e := wantError(t, "error", rec, 400, "invalid", "/query", "query.invalid")
	if n := strings.Count(e.Error.Message, "<redacted>"); n != 4 {
		t.Errorf("message has %d <redacted>, want 4: %q", n, e.Error.Message)
	}
	for _, c := range e.Error.Message {
		if c < 0x20 {
			t.Errorf("message has a control character: %q", e.Error.Message)
			break
		}
	}
	if len(e.Error.Message) > 1024+len("…") || !strings.HasSuffix(e.Error.Message, "…") {
		t.Errorf("message is %d bytes, want ≤ 1024 + …", len(e.Error.Message))
	}
	if e.Error.QueryID != "" {
		t.Errorf("query_id %q, want absent", e.Error.QueryID)
	}

	mode = "warnings"
	rec = postJSON(h, rangePath, `{"query":"up","from":1767225600000,"to":1767229200000,"width_px":1200}`)
	clean("warnings", rec)
	var body struct {
		Completeness map[string]any `json:"completeness"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("warnings: %v %s", err, rec.Body.String())
	}
	ws, _ := body.Completeness["warnings"].([]any)
	if len(ws) != 21 || ws[20] != "pulsus-dash: 5 more warnings omitted" || ws[3] != "leak <redacted> here" {
		t.Errorf("warnings %v", ws)
	}
	if _, ok := body.Completeness["query_id"]; ok {
		t.Errorf("query_id present: %v", body.Completeness)
	}

	mode = "embedded"
	rec = postJSON(h, rangePath, `{"query":"up","from":1767225600000,"to":1767229200000,"width_px":1200}`)
	clean("embedded", rec)
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if _, ok := body.Completeness["query_id"]; ok || body.Completeness["read_cache"] != "other" {
		t.Errorf("completeness %v, want no query_id and read_cache other", body.Completeness)
	}

	mode = "metadata"
	rec = do(h, http.MethodGet, "/api/dash/v1/prom/metadata?tenant=demo")
	clean("metadata", rec)
	if !strings.Contains(rec.Body.String(), `"help":"see <redacted>"`) {
		t.Errorf("metadata %s", rec.Body.String())
	}

	out := logs.String()
	for _, n := range append(needles, "bad id!") {
		if strings.Contains(out, n) {
			t.Errorf("the log contains %q", n)
		}
	}
	if !strings.Contains(out, `"query_id_present":true`) || !regexp.MustCompile(`"query_id_hash":"[0-9a-f]{8}"`).MatchString(out) {
		t.Errorf("the log lacks query_id_present=true and an 8-hex query_id_hash: %s", out)
	}
}
