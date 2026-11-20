package pulsusfake

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func post(t *testing.T, base, path string, form url.Values) (*http.Response, string) {
	t.Helper()
	resp, err := http.PostForm(base+path, form)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

// unit:fake-transcripts (test infrastructure).
func TestFakeTranscripts(t *testing.T) {
	if n := len(Default()); n != 17 {
		t.Fatalf("Default() has %d transcripts, want 17", n)
	}
	for _, tr := range Default() {
		if tr.Provenance.Captured == "" && tr.Provenance.Synthetic == "" {
			t.Errorf("%s has no provenance", tr.Name)
		}
	}
	f := New(Default(), Options{})
	srv := httptest.NewServer(f)
	defer srv.Close()

	// An exact query match beats a path-only transcript.
	resp, body := post(t, srv.URL, "/api/v1/query_range", url.Values{"query": {"topk(1000, up)"}})
	if resp.StatusCode != 200 || resp.Header.Get("X-Pulsus-Query-Id") != "fake-truncated-1" || !strings.Contains(body, "results truncated due to limit") {
		t.Errorf("truncated transcript: %d %q %s", resp.StatusCode, resp.Header.Get("X-Pulsus-Query-Id"), body)
	}
	resp, _ = post(t, srv.URL, "/api/v1/series", url.Values{"match[]": {"up"}})
	if resp.Header.Get("X-Pulsus-Query-Id") != "fake-series-1" {
		t.Errorf("path-only transcript: %q", resp.Header.Get("X-Pulsus-Query-Id"))
	}

	// Strict: an unmatched request is answered 404 and listed.
	f.Reset()
	resp, body = post(t, srv.URL, "/api/v1/query_range", url.Values{"query": {"unknown_metric"}, "start": {"0"}, "end": {"60"}, "step": {"15"}})
	if resp.StatusCode != 404 || body != `{"status":"error","errorType":"not_found","error":"pulsus-fake: unexpected request"}` {
		t.Errorf("unmatched: %d %s", resp.StatusCode, body)
	}
	if u := f.Unexpected(); len(u) != 1 || u[0].Path != "/api/v1/query_range" || u[0].Form.Get("query") != "unknown_metric" || u[0].Transcript != "" {
		t.Errorf("Unexpected() = %+v", u)
	}

	// The generator answers the same request on its grid.
	g := New(Default(), Options{Generate: true})
	gsrv := httptest.NewServer(g)
	defer gsrv.Close()
	resp, body = post(t, gsrv.URL, "/api/v1/query_range", url.Values{"query": {"unknown_metric"}, "start": {"0"}, "end": {"60"}, "step": {"15"}})
	var doc struct {
		Data struct {
			Result []struct {
				Metric map[string]string `json:"metric"`
				Values [][2]any          `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(body), &doc); err != nil || resp.StatusCode != 200 {
		t.Fatalf("generated: %d %s %v", resp.StatusCode, body, err)
	}
	if len(doc.Data.Result) != 1 || doc.Data.Result[0].Metric["fake"] != "generated" || len(doc.Data.Result[0].Values) != 5 ||
		resp.Header.Get("X-Pulsus-Query-Id") != "fake-generated" {
		t.Errorf("generated body %s headers %v", body, resp.Header)
	} else {
		for i, p := range doc.Data.Result[0].Values {
			if p[0].(float64) != float64(i*15) {
				t.Errorf("generated point %d at %v, want %d", i, p[0], i*15)
			}
		}
	}
	if u := g.Unexpected(); len(u) != 0 {
		t.Errorf("generator Unexpected() = %+v", u)
	}
	if r := g.Requests(); len(r) != 1 || r[0].Transcript != "generated" {
		t.Errorf("generator Requests() = %+v", r)
	}
}

func TestFakeHangRecordsCancel(t *testing.T) {
	f := New(Default(), Options{})
	srv := httptest.NewServer(f)
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+"/api/v1/query_range",
		strings.NewReader(url.Values{"query": {"sum(hang_total)"}}.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	done := make(chan error, 1)
	go func() {
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			_ = resp.Body.Close()
		}
		done <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for len(f.Requests()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	t0 := time.Now()
	cancel()
	wctx, wcancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer wcancel()
	rec, err := f.WaitCancelled(wctx, "hang")
	if err != nil || !rec.Cancelled || rec.Completed || rec.CancelledAt.Sub(t0) > time.Second {
		t.Errorf("WaitCancelled = %+v, %v", rec, err)
	}
	if err := <-done; err == nil {
		t.Error("the cancelled request completed")
	}
}

func TestLoadRefuses(t *testing.T) {
	good := `{"name":"a","provenance":{"synthetic":"x"},"match":{"method":"GET","paths":["/a"]},"response":{"status":200,"headers":{},"body":{}}}`
	if ts, err := Load(fstest.MapFS{"a.json": {Data: []byte(good)}}); err != nil || len(ts) != 1 || ts[0].Name != "a" {
		t.Errorf("Load(good) = %v, %v", ts, err)
	}
	for name, fsys := range map[string]fstest.MapFS{
		"duplicate":     {"a.json": {Data: []byte(good)}, "b.json": {Data: []byte(good)}},
		"no provenance": {"a.json": {Data: []byte(strings.Replace(good, `{"synthetic":"x"}`, `{}`, 1))}},
		"bad json":      {"a.json": {Data: []byte(`{`)}},
	} {
		if _, err := Load(fsys); err == nil {
			t.Errorf("Load(%s) succeeded", name)
		}
	}
}
