//go:build itest

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake/fakeharness"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

const counterQuery = "sum by (job, instance) (rate(http_requests_total[5m]))"

// boundServe migrates a database whose seeded binding demo points at url, then starts serve.
func boundServe(t *testing.T, c storetest.Cluster, url, extra string, env ...string) (*served, *storetest.TestDB) {
	t.Helper()
	db := storetest.NewDB(t, c)
	cfg, base := dbConfig(t, db, "datasource:\n  url: "+url+"\n  slug: demo\n"+extra)
	base = append(base, env...)
	if r := migrateCLI(t, cfg, base); r.code != 0 {
		t.Fatalf("migrate: exit %d stderr %q", r.code, r.stderr)
	}
	s := startServeArgs(t, base, false, "serve", "--config", cfg, "--api-only")
	s.waitReady(t)
	t.Cleanup(func() { s.cancel() })
	return s, db
}

// send POSTs body to the BFF and returns the status and raw body.
func (s *served) send(t *testing.T, path, body string, hdr ...string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, "http://"+s.addr+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		t.Fatalf("POST %s: %v", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, b
}

func rangeBody(query string, extra string) string {
	q, _ := json.Marshal(query)
	return `{"query":` + string(q) + `,"from":1767225600000,"to":1767229200000,"width_px":1200` + extra + `}`
}

type frame struct {
	Key        string            `json:"key"`
	Labels     map[string]string `json:"labels"`
	Timestamps []int64           `json:"timestamps"`
	Values     []any             `json:"values"`
}

type rangeResp struct {
	Start, End, Step int64
	Frames           []frame
	Completeness     map[string]any
}

func decodeRange(t *testing.T, b []byte) rangeResp {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var r rangeResp
	if err := dec.Decode(&r); err != nil {
		t.Fatalf("range body %.300q: %v", b, err)
	}
	return r
}

// frameValue maps a decoded frame value to a float; ok is false for null (absent).
func frameValue(t *testing.T, v any) (float64, bool) {
	t.Helper()
	switch x := v.(type) {
	case nil:
		return 0, false
	case json.Number:
		f, err := strconv.ParseFloat(x.String(), 64)
		if err != nil {
			t.Fatal(err)
		}
		return f, true
	case string:
		switch x {
		case "NaN":
			return math.NaN(), true
		case "+Inf":
			return math.Inf(1), true
		case "-Inf":
			return math.Inf(-1), true
		}
	}
	t.Fatalf("frame value %#v", v)
	return 0, false
}

func errorOf(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("envelope %q: %v", b, err)
	}
	return m["error"]
}

func transcriptByName(t *testing.T, name string) pulsusfake.Transcript {
	t.Helper()
	for _, tr := range pulsusfake.Default() {
		if tr.Name == name {
			return tr
		}
	}
	t.Fatalf("no transcript %s", name)
	return pulsusfake.Transcript{}
}

// itest:promql-range (PRF-031, T06-011, T04-004, T04-005, T07-002).
func TestPromqlRangeItest(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			fake, url := fakeharness.Start(t)
			s, _ := boundServe(t, c, url, "")
			code, b := s.send(t, "/api/dash/v1/query/promql/range?tenant=demo", rangeBody(counterQuery, ""))
			if code != 200 {
				t.Fatalf("range %d %s", code, b)
			}
			r := decodeRange(t, b)
			if r.Step != 5000 || r.Start != 1767225600000 || r.End != 1767229200000 || len(r.Frames) != 2 {
				t.Fatalf("step %d start %d end %d frames %d", r.Step, r.Start, r.End, len(r.Frames))
			}
			var body struct {
				Data struct {
					Result []struct {
						Metric map[string]string `json:"metric"`
						Values [][2]any          `json:"values"`
					} `json:"result"`
				} `json:"data"`
			}
			if err := json.Unmarshal(transcriptByName(t, "counter").Response.Body, &body); err != nil {
				t.Fatal(err)
			}
			for i, tr := range body.Data.Result {
				f := r.Frames[i]
				var ls []keyhash.Label
				for k, v := range tr.Metric {
					ls = append(ls, keyhash.Label{Name: k, Value: v})
				}
				if f.Key != keyhash.Hex(keyhash.Labels(ls)) || len(f.Labels) != len(tr.Metric) {
					t.Errorf("frame %d key %s labels %v", i, f.Key, f.Labels)
				}
				for k, v := range tr.Metric {
					if f.Labels[k] != v {
						t.Errorf("frame %d label %s = %q, want %q", i, k, f.Labels[k], v)
					}
				}
				if len(f.Timestamps) != 721 || len(f.Values) != 721 {
					t.Fatalf("frame %d: %d timestamps %d values", i, len(f.Timestamps), len(f.Values))
				}
				given := map[int64]string{}
				for _, p := range tr.Values {
					given[int64(p[0].(float64))*1000] = p[1].(string)
				}
				for j, ts := range f.Timestamps {
					if ts != 1767225600000+int64(j)*5000 {
						t.Fatalf("frame %d timestamp %d = %d", i, j, ts)
					}
					v, present := frameValue(t, f.Values[j])
					want, ok := given[ts]
					if present != ok {
						t.Errorf("frame %d point %d present %v, want %v", i, j, present, ok)
						continue
					}
					if ok {
						w, _ := strconv.ParseFloat(want, 64)
						if math.Float64bits(v) != math.Float64bits(w) {
							t.Errorf("frame %d point %d = %v, want %s bit for bit", i, j, v, want)
						}
					}
				}
			}
			reqs := fake.Requests()
			if len(reqs) != 1 {
				t.Fatalf("%d upstream requests", len(reqs))
			}
			f := reqs[0].Form
			if f.Get("start") != "1767225600" || f.Get("end") != "1767229200" || f.Get("step") != "5" || f.Get("query") != counterQuery {
				t.Errorf("upstream form %v", f)
			}
			if m := regexp.MustCompile(`^([0-9]+)ms$`).FindStringSubmatch(f.Get("timeout")); m == nil {
				t.Errorf("timeout %q", f.Get("timeout"))
			} else if n, _ := strconv.Atoi(m[1]); n < 29000 || n > 29900 {
				t.Errorf("timeout %d ms, want 29 000..29 900", n)
			}

			code, b = s.send(t, "/api/dash/v1/query/promql/range?tenant=demo", rangeBody("sum by (le) (rate(http_request_duration_seconds_bucket[5m]))", ""))
			if r := decodeRange(t, b); code != 200 || len(r.Frames) != 3 || r.Frames[0].Labels["le"] != "0.1" || r.Frames[1].Labels["le"] != "1" || r.Frames[2].Labels["le"] != "+Inf" {
				t.Errorf("histogram %d %+v", code, r.Frames)
			}
			code, b = s.send(t, "/api/dash/v1/query/promql/range?tenant=demo", rangeBody("topk(1000, up)", ""))
			if r := decodeRange(t, b); code != 200 || r.Completeness["truncated"] != true || !sameStrings(r.Completeness["warnings"], "results truncated due to limit") {
				t.Errorf("truncated %d %v", code, r.Completeness)
			}
			code, b = s.send(t, "/api/dash/v1/query/promql/range?tenant=demo", rangeBody("topk(5, up)", ""))
			if r := decodeRange(t, b); code != 200 || r.Completeness["truncated"] != true || !sameStrings(r.Completeness["warnings"]) {
				t.Errorf("flagged %d %v", code, r.Completeness)
			}
			code, b = s.send(t, "/api/dash/v1/query/promql/range?tenant=demo", rangeBody(`up{job="api"}`, ""))
			if r := decodeRange(t, b); code != 200 || len(r.Frames) != 1 || r.Frames[0].Labels["job"] != "api" || r.Frames[0].Values[0] != json.Number("1") {
				t.Errorf("reordered %d %+v", code, r.Frames)
			}
			s.stop(t)
		})
	}
}

func sameStrings(v any, want ...string) bool {
	xs, ok := v.([]any)
	if !ok || len(xs) != len(want) {
		return false
	}
	for i := range xs {
		if xs[i] != want[i] {
			return false
		}
	}
	return true
}

// closedURL is the URL of a listener that was closed: nothing answers there.
func closedURL(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "localhost:0")
	if err != nil {
		t.Fatal(err)
	}
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	_ = ln.Close()
	return "http://localhost:" + port
}

// itest:promql-errors (T06-026, T06-009, PRF-031, T09-009).
func TestPromqlErrorsItest(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			fake, url := fakeharness.Start(t)
			s, _ := boundServe(t, c, url, "")
			const path = "/api/dash/v1/query/promql/range?tenant=demo"

			code, b := s.send(t, path, rangeBody("up{", ""))
			e := errorOf(t, b)
			fields, _ := e["fields"].([]any)
			hint, _ := e["hint"].(map[string]any)
			pos, _ := hint["position"].(map[string]any)
			if code != 400 || e["code"] != "invalid" || len(fields) != 1 || fields[0].(map[string]any)["pointer"] != "/query" ||
				pos["offset"] != float64(3) || e["message"] != "1:4: parse error: unexpected end of input inside braces" || e["query_id"] != "fake-parse-1" {
				t.Errorf("parse error: %d %s", code, b)
			}
			code, b = s.send(t, path, rangeBody("sum(rate(slow_total[1y]))", ""))
			if e := errorOf(t, b); code != 504 || e["code"] != "unavailable" || e["hint"].(map[string]any)["reason"] != "upstream_timeout" {
				t.Errorf("timeout: %d %s", code, b)
			}
			start := time.Now()
			code, b = s.send(t, path, rangeBody("sum(hang_total)", `,"timeout_ms":300`))
			if code != 504 || time.Since(start) > time.Second {
				t.Errorf("hang: %d after %v: %s", code, time.Since(start), b)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			if rec, err := fake.WaitCancelled(ctx, "hang"); err != nil || !rec.Cancelled {
				t.Errorf("hang: the fake did not record the cancel: %v", err)
			}
			cancel()
			code, b = s.send(t, path, rangeBody(`{__name__=~".+"}`, ""))
			if e := errorOf(t, b); code != 422 || e["code"] != "too_broad" || e["hint"].(map[string]any)["action"] != "narrow" {
				t.Errorf("too broad: %d %s", code, b)
			}
			code, b = s.send(t, path, rangeBody("sum(", ""))
			e = errorOf(t, b)
			fields, _ = e["fields"].([]any)
			if code != 400 || e["code"] != "invalid" || len(fields) != 1 || fields[0].(map[string]any)["pointer"] != "/query" ||
				e["hint"] != nil || e["message"] != "unclosed left parenthesis" {
				t.Errorf("no position: %d %s", code, b)
			}
			fake.Reset()
			code, b = s.send(t, path, rangeBody("up", `,"timeout_ms":199`))
			e = errorOf(t, b)
			fields, _ = e["fields"].([]any)
			if code != 400 || len(fields) != 1 || fields[0].(map[string]any)["pointer"] != "/timeout_ms" || fields[0].(map[string]any)["message_key"] != "field.range" {
				t.Errorf("timeout_ms 199: %d %s", code, b)
			}
			code, b = s.send(t, path, rangeBody("count(ALERTS)", ""))
			if e := errorOf(t, b); code != 400 || e["code"] != "virtual_unsupported" || e["hint"].(map[string]any)["reserved"] != "ALERTS" {
				t.Errorf("reserved: %d %s", code, b)
			}
			if n := len(fake.Requests()); n != 0 {
				t.Errorf("%d upstream requests for refused queries", n)
			}
			s.stop(t)

			closed, _ := boundServe(t, c, closedURL(t), "")
			code, b = closed.send(t, path, rangeBody("up", ""))
			if e := errorOf(t, b); code != 502 || e["hint"].(map[string]any)["reason"] != "upstream_unreachable" {
				t.Errorf("closed port: %d %s", code, b)
			}
			if code, m := closed.get(t, "/readyz"); code != 200 || m["status"] != "ready" {
				t.Errorf("/readyz %d %v", code, m)
			}
			closed.stop(t)
		})
	}
}

// accessStatus waits for the access-log record of route and returns its status.
func accessStatus(t *testing.T, s *served, route string) float64 {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		for _, line := range strings.Split(s.stderr.String(), "\n") {
			var m map[string]any
			if json.Unmarshal([]byte(line), &m) == nil && m["msg"] == "http" && m["route"] == route {
				st, _ := m["status"].(float64)
				return st
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no access log record for %s: %s", route, s.stderr.String())
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// itest:cancel (PRF-030, T06-010).
func TestCancelItest(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			fake, url := fakeharness.Start(t)
			s, _ := boundServe(t, c, url, "")
			ctx, cancel := context.WithCancel(context.Background())
			req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+s.addr+"/api/dash/v1/query/promql/range?tenant=demo",
				strings.NewReader(rangeBody("sum(hang_total)", "")))
			done := make(chan struct{})
			go func() {
				defer close(done)
				if resp, err := http.DefaultClient.Do(req); err == nil {
					_ = resp.Body.Close()
				}
			}()
			deadline := time.Now().Add(5 * time.Second)
			for len(fake.Requests()) == 0 {
				if time.Now().After(deadline) {
					t.Fatal("the request never reached the fake")
				}
				time.Sleep(5 * time.Millisecond)
			}
			t0 := time.Now()
			cancel()
			wctx, wcancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer wcancel()
			rec, err := fake.WaitCancelled(wctx, "hang")
			if err != nil {
				t.Fatalf("WaitCancelled: %v", err)
			}
			if d := rec.CancelledAt.Sub(t0); d > 100*time.Millisecond {
				t.Errorf("upstream cancelled %v after the browser, want ≤ 100 ms", d)
			}
			<-done
			if st := accessStatus(t, s, "/api/dash/v1/query/promql/range"); st != 499 {
				t.Errorf("access log status %v, want 499", st)
			}
			s.stop(t)
		})
	}
}

// itest:cancel-mid-stream (PRF-030, T06-010).
func TestCancelMidStreamItest(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			var mu sync.Mutex
			n := 0
			observed := make(chan time.Time, 1)
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = r.ParseForm() // as PulsusDB does; net/http then notices the cancel
				mu.Lock()
				n++
				first := n == 1
				mu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				if !first {
					_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
					return
				}
				_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"instance":"a:9090","job":"api"},"values":[[1767225600,"0.1"]]}`)
				http.NewResponseController(w).Flush()
				<-r.Context().Done()
				observed <- time.Now()
			}))
			defer up.Close()
			s, _ := boundServe(t, c, up.URL, "pulsusdb:\n  tenant_concurrency: 1\n")
			ctx, cancel := context.WithCancel(context.Background())
			req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+s.addr+"/api/dash/v1/query/promql/range?tenant=demo",
				strings.NewReader(rangeBody(counterQuery, "")))
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			br := bufio.NewReader(resp.Body)
			var got []byte
			for !(bytes.Contains(got, []byte(`"values":[`)) && bytes.HasSuffix(got, []byte("]}"))) {
				c, err := br.ReadByte()
				if err != nil {
					t.Fatalf("read %q: %v", got, err)
				}
				got = append(got, c)
			}
			t0 := time.Now()
			cancel()
			_ = resp.Body.Close()
			select {
			case at := <-observed:
				if d := at.Sub(t0); d > 100*time.Millisecond {
					t.Errorf("upstream saw the cancel %v after the browser, want ≤ 100 ms", d)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("the upstream never saw the cancel")
			}
			if code, b := s.send(t, "/api/dash/v1/query/promql/range?tenant=demo", rangeBody(counterQuery, "")); code != 200 {
				t.Errorf("second request %d %s: the slot was not released", code, b)
			}
			if strings.Contains(s.stderr.String(), "promql_stream_aborted") {
				t.Error("a browser cancel logged promql_stream_aborted")
			}
			s.stop(t)
		})
	}
}

// itest:tenant-header (T06-006, T06-002).
func TestTenantHeaderItest(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			fake, url := fakeharness.Start(t)
			s, db := boundServe(t, c, url, "  scope_org_id: acme\n  database: metrics_b\n  credentials_ref: env:FAKE_CREDS\n",
				"FAKE_CREDS=user:pw-secret")
			storetest.Exec(t, db.SuperURL, `INSERT INTO tenant_bindings (org_id, id, slug, datasource_url)
				SELECT org_id, gen_random_uuid(), 'plain', datasource_url FROM tenant_bindings WHERE slug = 'demo'`)
			if code, b := s.send(t, "/api/dash/v1/query/promql/range?tenant=demo", rangeBody(counterQuery, "")); code != 200 {
				t.Fatalf("demo %d %s", code, b)
			}
			r := fake.Requests()[0]
			if r.Header.Get("X-Scope-OrgID") != "acme" || r.Header.Get("X-Pulsus-Database") != "metrics_b" ||
				r.Header.Get("Authorization") != "Basic dXNlcjpwdy1zZWNyZXQ=" {
				t.Errorf("demo headers %v", r.Header)
			}
			fake.Reset()
			if code, b := s.send(t, "/api/dash/v1/query/promql/range?tenant=plain", rangeBody(counterQuery, ""), "X-Scope-OrgID", "evil"); code != 200 {
				t.Fatalf("plain %d %s", code, b)
			}
			r = fake.Requests()[0]
			for _, h := range []string{"X-Scope-OrgID", "X-Pulsus-Database", "Authorization"} {
				if v := r.Header.Values(h); len(v) != 0 {
					t.Errorf("plain sent %s %q", h, v)
				}
			}
			code, b := s.send(t, "/api/dash/v1/query/promql/range?tenant=nope", rangeBody(counterQuery, ""))
			if e := errorOf(t, b); code != 404 || e["code"] != "not_found" {
				t.Errorf("nope %d %s", code, b)
			}
			s.stop(t)
		})
	}
}

// itest:datasource-check (T06-025, T06-026).
func TestDatasourceCheckItest(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			_, url := fakeharness.Start(t)
			s, _ := boundServe(t, c, url, "")
			code, m := s.get(t, "/api/dash/v1/datasource/check?tenant=demo")
			if _, ok := m["checked_at"].(float64); code != 200 || m["state"] != "ok" || !ok {
				t.Errorf("check %d %v", code, m)
			}
			s.stop(t)
			closed, _ := boundServe(t, c, closedURL(t), "")
			if code, m := closed.get(t, "/api/dash/v1/datasource/check?tenant=demo"); code != 200 || m["state"] != "unreachable" {
				t.Errorf("closed port check %d %v", code, m)
			}
			if code, m := closed.get(t, "/readyz"); code != 200 || m["status"] != "ready" {
				t.Errorf("/readyz %d %v", code, m)
			}
			closed.stop(t)
		})
	}
}
