package gateway

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake"
)

const plantedSecret = "Zq9-planted-SECRET" // #nosec G101 -- the planted test secret

// plantedUpstream serves internal/pulsusdb/testdata/adversarial with @SECRET@, @TOKEN@, @URL@ and
// @HOST@ replaced by the binding's secret, Basic token, URL and host:port.
func plantedUpstream(t *testing.T, secret, token string) *httptest.Server {
	t.Helper()
	ts, err := pulsusfake.Load(os.DirFS("../pulsusdb/testdata/adversarial"))
	if err != nil {
		t.Fatal(err)
	}
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		rep := strings.NewReplacer("@SECRET@", secret, "@TOKEN@", token, "@URL@", srv.URL, "@HOST@", strings.TrimPrefix(srv.URL, "http://"))
		for _, tr := range ts {
			if tr.Match.Method != r.Method || !slices.Contains(tr.Match.Paths, r.URL.Path) ||
				(tr.Match.Query != nil && *tr.Match.Query != r.Form.Get("query")) {
				continue
			}
			for k, v := range tr.Response.Headers {
				w.Header().Set(k, rep.Replace(v))
			}
			w.WriteHeader(tr.Response.Status)
			_, _ = io.WriteString(w, rep.Replace(string(tr.Response.Body)))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// responseBytes is the status line, the headers and the body.
func responseBytes(rec *httptest.ResponseRecorder) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d\n", rec.Code)
	for k, vs := range rec.Header() {
		fmt.Fprintf(&b, "%s: %s\n", k, strings.Join(vs, ","))
	}
	b.WriteString(rec.Body.String())
	return b.String()
}

// unit:redact-adversarial (T06-024).
func TestRedactAdversarial(t *testing.T) {
	cred := "user:" + plantedSecret
	token := base64.StdEncoding.EncodeToString([]byte(cred))
	if token != "dXNlcjpacTktcGxhbnRlZC1TRUNSRVQ=" { // #nosec G101 -- the planted test token (A.9)
		t.Fatalf("token %s", token)
	}
	up := plantedUpstream(t, plantedSecret, token)
	host := strings.TrimPrefix(up.URL, "http://")
	h, logs := queryGateway(t, up.URL, pulsusdb.Options{Secrets: secretsMap(map[string]string{"env:C": cred})}, withCredentials("env:C"))
	needles := []string{plantedSecret, token, up.URL, host}
	q := func(query string) string {
		return `{"query":"` + query + `","from":1767225600000,"to":1767229200000,"width_px":1200}`
	}
	for _, c := range []struct {
		name   string
		rec    *httptest.ResponseRecorder
		status int
		want   []string // substrings of the body where each plant was
	}{
		{"range", postJSON(h, rangePath, q("adv_range")), 200, []string{
			`"<redacted>_x":"a-<redacted>"`, `"esc":"<redacted>"`, `"addr":"<redacted> <redacted>"`,
			`"labels":{"<redacted>":"<redacted>"}`, `"warnings":["see <redacted>/api"]`, `"infos":["<redacted>"]`, `"read_cache":"other"`}},
		{"instant", postJSON(h, instantPath, `{"query":"adv_instant","at":1767229200000}`), 200, []string{
			`"<redacted>":"<redacted>"`, `"job":"x-<redacted>"`, `"warnings":["<redacted>"]`}},
		{"sample", postJSON(h, rangePath, q("adv_sample")), 502, []string{`"reason":"upstream_error"`}},
		{"series", do(h, http.MethodGet, "/api/dash/v1/prom/series?tenant=demo"+window+"&match=up"), 200, []string{`"<redacted>":"v-<redacted>"`}},
		{"labels", do(h, http.MethodGet, "/api/dash/v1/prom/labels?tenant=demo"+window), 200, []string{`"values":["<redacted>","ok-<redacted>"]`}},
		{"label values", do(h, http.MethodGet, "/api/dash/v1/prom/label/job/values?tenant=demo"+window), 200, []string{`"values":["<redacted>","<redacted>"]`}},
		{"metadata", do(h, http.MethodGet, "/api/dash/v1/prom/metadata?tenant=demo"), 200, []string{
			`"<redacted>_total":[{`, `"type":"<redacted>"`, `"help":"help <redacted>"`, `"unit":"<redacted>"`}},
		{"400", postJSON(h, rangePath, q("adv_400")), 400, []string{`"message":"bad <redacted> at <redacted>"`}},
		{"422", postJSON(h, rangePath, q("adv_422")), 422, []string{`"message":"too broad <redacted> <redacted>"`}},
		{"429", postJSON(h, rangePath, q("adv_429")), 429, nil},
		{"503", postJSON(h, rangePath, q("adv_503")), 502, []string{`"reason":"upstream_unavailable"`}},
		{"check", do(h, http.MethodGet, "/api/dash/v1/datasource/check?tenant=demo"), 200, []string{`"state":"ok"`}},
	} {
		all := responseBytes(c.rec) + "\n" + unescapedHTML(responseBytes(c.rec))
		if c.rec.Code != c.status {
			t.Errorf("%s: status %d, want %d: %s", c.name, c.rec.Code, c.status, c.rec.Body.String())
		}
		for _, n := range needles {
			if strings.Contains(all, n) {
				t.Errorf("%s: the response contains %q:\n%s", c.name, n, all)
			}
		}
		for _, w := range c.want {
			if !strings.Contains(unescapedHTML(c.rec.Body.String()), w) {
				t.Errorf("%s: body lacks %s: %s", c.name, w, c.rec.Body.String())
			}
		}
		for _, absent := range []string{`"query_id"`, `"read_cache_through_ms"`} {
			if strings.Contains(c.rec.Body.String(), absent) {
				t.Errorf("%s: body has %s: %s", c.name, absent, c.rec.Body.String())
			}
		}
		if c.rec.Header().Get("Retry-After") != "" {
			t.Errorf("%s: Retry-After %q forwarded", c.name, c.rec.Header().Get("Retry-After"))
		}
	}
	out := logs.String()
	for _, n := range needles {
		if strings.Contains(out, n) {
			t.Errorf("the log contains %q", n)
		}
	}
}

// propCase is one random upstream answer.
type propCase struct {
	status int
	body   string
}

// unit:redact-prop (T06-024): 1 000 random bodies, a random needle in a random string.
func TestRedactProperty(t *testing.T) {
	seed := rand.Uint64() // #nosec G404 -- a logged seed makes failures reproducible
	t.Logf("seed %d", seed)
	rng := rand.New(rand.NewPCG(seed, 2)) // #nosec G404 -- seeded for reproducible cases
	var mu sync.Mutex
	var cur propCase
	var cred string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		c := cur
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(c.status)
		_, _ = io.WriteString(w, c.body)
	}))
	defer up.Close()
	host := strings.TrimPrefix(up.URL, "http://")
	secrets := func(string) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		return cred, nil
	}
	h, logs := queryGateway(t, up.URL, pulsusdb.Options{Secrets: secrets}, withCredentials("env:C"))
	const alnum = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	logged := 0
	for i := range 1000 {
		secret := "Zq9"
		for range 13 {
			secret += string(alnum[rng.IntN(len(alnum))])
		}
		c := "user:" + secret
		token := base64.StdEncoding.EncodeToString([]byte(c))
		needles := []string{secret, token, up.URL, host}
		needle := needles[rng.IntN(len(needles))]
		route, pc := propBody(rng, needle)
		mu.Lock()
		cur, cred = pc, c
		mu.Unlock()
		var rec *httptest.ResponseRecorder
		switch route {
		case "range", "error":
			rec = postJSON(h, rangePath, `{"query":"prop","from":1767225600000,"to":1767229200000,"width_px":1200}`)
		case "instant":
			rec = postJSON(h, instantPath, `{"query":"prop","at":1767229200000}`)
		case "labels":
			rec = do(h, http.MethodGet, "/api/dash/v1/prom/labels?tenant=demo"+window)
		case "series":
			rec = do(h, http.MethodGet, "/api/dash/v1/prom/series?tenant=demo"+window+"&match=up")
		case "metadata":
			rec = do(h, http.MethodGet, "/api/dash/v1/prom/metadata?tenant=demo")
		}
		out := logs.String()
		all := responseBytes(rec) + unescapedHTML(responseBytes(rec)) + out[logged:]
		logged = len(out)
		for _, n := range needles {
			if strings.Contains(all, n) {
				t.Fatalf("case %d (seed %d, route %s): %q leaked\nbody %s\nresponse %s", i, seed, route, n, pc.body, responseBytes(rec))
			}
		}
		if rec.Code >= 500 && route != "error" {
			t.Fatalf("case %d (seed %d, route %s): %d %s\nupstream %s", i, seed, route, rec.Code, rec.Body.String(), pc.body)
		}
	}
}

// propBody builds a random valid body for a random route with needle in one random string,
// raw or with random characters escaped as \uXXXX; never in a sample value or a timestamp.
func propBody(rng *rand.Rand, needle string) (string, propCase) {
	var slots []string
	str := func() int {
		slots = append(slots, propString(rng))
		return len(slots) - 1
	}
	type kv struct{ k, v int }
	labels := func() []kv {
		n := 1 + rng.IntN(3)
		out := make([]kv, n)
		for i := range out {
			out[i] = kv{str(), str()}
		}
		return out
	}
	route := []string{"range", "instant", "labels", "series", "metadata", "error"}[rng.IntN(6)]
	var build func(enc func(int) string) string
	switch route {
	case "range", "instant":
		series := make([][]kv, 1+rng.IntN(3))
		for i := range series {
			series[i] = labels()
		}
		warn := str()
		build = func(enc func(int) string) string {
			var parts []string
			for i, ls := range series {
				var m []string
				for _, p := range ls {
					m = append(m, enc(p.k)+":"+enc(p.v))
				}
				if route == "range" {
					parts = append(parts, fmt.Sprintf(`{"metric":{%s},"values":[[%d,"1.5"]]}`, strings.Join(m, ","), 1767225600+5*i))
				} else {
					parts = append(parts, fmt.Sprintf(`{"metric":{%s},"value":[1767229200,"1.5"]}`, strings.Join(m, ",")))
				}
			}
			rt := map[string]string{"range": "matrix", "instant": "vector"}[route]
			return `{"status":"success","data":{"resultType":"` + rt + `","result":[` + strings.Join(parts, ",") + `]},"warnings":[` + enc(warn) + `]}`
		}
	case "labels":
		vals := []int{str(), str(), str()}
		build = func(enc func(int) string) string {
			return `{"status":"success","data":[` + enc(vals[0]) + "," + enc(vals[1]) + "," + enc(vals[2]) + `]}`
		}
	case "series":
		ls := labels()
		build = func(enc func(int) string) string {
			var m []string
			for _, p := range ls {
				m = append(m, enc(p.k)+":"+enc(p.v))
			}
			return `{"status":"success","data":[{` + strings.Join(m, ",") + `}]}`
		}
	case "metadata":
		name, typ, help, unit := str(), str(), str(), str()
		build = func(enc func(int) string) string {
			return `{"status":"success","data":{` + enc(name) + `:[{"type":` + enc(typ) + `,"help":` + enc(help) + `,"unit":` + enc(unit) + `}]}}`
		}
	case "error":
		msg := str()
		build = func(enc func(int) string) string {
			return `{"status":"error","errorType":"bad_data","error":` + enc(msg) + `}`
		}
	}
	target := rng.IntN(len(slots))
	at := rng.IntN(len(slots[target]) + 1)
	slots[target] = slots[target][:at] + needle + slots[target][at:]
	escape := rng.IntN(2) == 0
	enc := func(i int) string { return propEncode(rng, slots[i], escape && i == target) }
	status := 200
	if route == "error" {
		status = 400
	}
	return route, propCase{status: status, body: build(enc)}
}

func propString(rng *rand.Rand) string {
	const alphabet = "abcxyz0189 _-:./é✓"
	rs := []rune(alphabet)
	var b strings.Builder
	for range 1 + rng.IntN(10) {
		b.WriteRune(rs[rng.IntN(len(rs))])
	}
	return b.String()
}

// propEncode writes s as a JSON string; with escape, random characters become \uXXXX.
func propEncode(rng *rand.Rand, s string, escape bool) string {
	if !escape {
		b, _ := json.Marshal(s)
		return string(b)
	}
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		if r == '"' || r == '\\' || r < 0x20 || rng.IntN(3) == 0 {
			fmt.Fprintf(&b, `\u%04x`, r)
			continue
		}
		b.WriteRune(r)
	}
	b.WriteByte('"')
	return b.String()
}

// unit:sanitise (log routes, plan #65 Part B, T06-024): a credential in a log line, a stream
// label value or a text/plain error reaches the browser only as <redacted>, and never the log.
func TestSanitiseLogs(t *testing.T) {
	const cred = "user:pw-secret-1"          // #nosec G101 -- the planted test credential
	const token = "dXNlcjpwdy1zZWNyZXQtMQ==" // #nosec G101 -- the planted test credential
	var upURL string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		host := strings.TrimPrefix(upURL, "http://")
		leak := "pw-secret-1 " + token + " " + upURL + "/x " + host
		if r.Form.Get("query") == `{app="bad"}` {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, "unexpected token at byte 3: "+leak)
			return
		}
		line, _ := json.Marshal("line " + leak)
		label, _ := json.Marshal("v " + leak)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"streams","result":[{"stream":{"app":"x","leak":`+string(label)+`},"values":[["1767229100000000500",`+string(line)+`]]}]}}`)
	}))
	defer up.Close()
	upURL = up.URL
	host := strings.TrimPrefix(up.URL, "http://")
	h, logs := queryGateway(t, up.URL, pulsusdb.Options{Secrets: func(string) (string, error) { return cred, nil }}, withCredentials("env:C"))
	needles := []string{cred, "pw-secret-1", token, up.URL, host}
	clean := func(what string, rec *httptest.ResponseRecorder) {
		t.Helper()
		for _, n := range needles {
			if s := rec.Body.String(); strings.Contains(s, n) || strings.Contains(unescapedHTML(s), n) {
				t.Errorf("%s: the response contains %q: %s", what, n, s)
			}
		}
	}
	rec := postJSON(h, logRangePath, logBody(`{app="x"}`, ""))
	clean("page", rec)
	p := decodePage(t, rec.Body.Bytes())
	if rec.Code != 200 || len(p.Streams) != 1 || len(p.Streams[0].Entries) != 1 {
		t.Fatalf("page: %d %s", rec.Code, rec.Body.String())
	}
	if l := unescapedHTML(p.Streams[0].Entries[0].Line); !strings.HasPrefix(l, "line <redacted>") || strings.Count(l, "<redacted>") < 3 {
		t.Errorf("line %q, want each needle redacted", l)
	}
	if v := p.Streams[0].Labels["leak"]; !strings.HasPrefix(v, "v <redacted>") {
		t.Errorf("label value %q, want redacted", v)
	}
	rec = postJSON(h, logRangePath, logBody(`{app="bad"}`, ""))
	clean("text error", rec)
	e := wantError(t, "text error", rec, 400, "invalid", "/query", "query.invalid")
	if !strings.HasPrefix(e.Error.Message, "unexpected token at byte 3: <redacted>") {
		t.Errorf("message %q", e.Error.Message)
	}
	out := logs.String()
	for _, n := range needles {
		if strings.Contains(out, n) {
			t.Errorf("the log contains %q", n)
		}
	}
}
