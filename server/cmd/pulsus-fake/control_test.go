package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake"
)

// summary is a record as listed by GET /__fake/requests, decoded by its JSON names (plan #63 §3.6).
type summary struct {
	Transcript   string `json:"transcript"`
	Method       string `json:"method"`
	Path         string `json:"path"`
	Query        string `json:"query"`
	Start        string `json:"start"`
	End          string `json:"end"`
	Step         string `json:"step"`
	Time         string `json:"time"`
	State        string `json:"state"`
	ReceivedAtMs int64  `json:"receivedAtMs"`
}

func transcript(name string, resp pulsusfake.Response) pulsusfake.Transcript {
	q := name
	if resp.Status == 0 {
		resp.Status = http.StatusOK
	}
	if resp.Body == nil && !resp.Hang {
		resp.Body = json.RawMessage(`{"status":"success","data":{"resultType":"matrix","result":[]}}`)
	}
	return pulsusfake.Transcript{
		Name:       name,
		Provenance: pulsusfake.Provenance{Synthetic: "control test"},
		Match:      pulsusfake.Match{Method: http.MethodPost, Paths: []string{"/api/v1/query_range"}, Query: &q},
		Response:   resp,
	}
}

func controlTranscripts() []pulsusfake.Transcript {
	return []pulsusfake.Transcript{
		transcript("hang", pulsusfake.Response{Hang: true}),
		transcript("slow", pulsusfake.Response{DelayMs: 300}),
		transcript("ok", pulsusfake.Response{}),
	}
}

func newControlServer(t *testing.T, o pulsusfake.Options, control bool) (*pulsusfake.Fake, *httptest.Server) {
	t.Helper()
	f := pulsusfake.New(controlTranscripts(), o)
	srv := httptest.NewServer(newHandler(f, control, io.Discard))
	t.Cleanup(srv.Close)
	return f, srv
}

func query(ctx context.Context, base, q string, form url.Values) (*http.Response, error) {
	if form == nil {
		form = url.Values{}
	}
	form.Set("query", q)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/v1/query_range", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return http.DefaultClient.Do(req)
}

func mustQuery(t *testing.T, base, q string, form url.Values) {
	t.Helper()
	resp, err := query(context.Background(), base, q, form)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
}

func call(t *testing.T, method, u string) (*http.Response, string) {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), method, u, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b)
}

func list(t *testing.T, base string) []summary {
	t.Helper()
	resp, body := call(t, http.MethodGet, base+"/__fake/requests")
	if resp.StatusCode != http.StatusOK {
		return nil
	}
	var out []summary
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("GET /__fake/requests: %v: %s", err, body)
	}
	return out
}

// waitList polls GET /__fake/requests every 5 ms for at most 1 s until ok holds.
func waitList(t *testing.T, base, what string, ok func([]summary) bool) []summary {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for {
		l := list(t, base)
		if ok(l) {
			return l
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s; last list %+v", what, l)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func find(l []summary, q string) []summary {
	var out []summary
	for _, s := range l {
		if s.Query == q {
			out = append(out, s)
		}
	}
	return out
}

func stateIs(q, state string) func([]summary) bool {
	return func(l []summary) bool {
		m := find(l, q)
		return len(m) == 1 && m[0].State == state
	}
}

// ci:go-test control lifecycle: a record is listed from arrival to completion or cancellation.
func TestControlLifecycle(t *testing.T) {
	_, srv := newControlServer(t, pulsusfake.Options{MaxRecords: controlRecords}, true)
	form := func() url.Values { return url.Values{"start": {"1"}, "end": {"2"}, "step": {"3"}} }

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel) // before srv.Close, which waits for the hung request
	hung := make(chan struct{})
	go func() {
		defer close(hung)
		if resp, err := query(ctx, srv.URL, "hang", form()); err == nil {
			_ = resp.Body.Close()
		}
	}()
	waitList(t, srv.URL, "hang inflight", stateIs("hang", "inflight"))
	cancel()
	<-hung
	waitList(t, srv.URL, "hang cancelled", stateIs("hang", "cancelled"))

	slow := make(chan struct{})
	go func() {
		defer close(slow)
		resp, err := query(context.Background(), srv.URL, "slow", form())
		if err != nil {
			t.Error(err)
			return
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()
	waitList(t, srv.URL, "slow inflight", stateIs("slow", "inflight"))
	<-slow
	waitList(t, srv.URL, "slow completed", stateIs("slow", "completed"))

	mustQuery(t, srv.URL, "ok", form())
	l := waitList(t, srv.URL, "ok completed", stateIs("ok", "completed"))
	var order []string
	for _, s := range l {
		order = append(order, s.Transcript)
		if s.Method != http.MethodPost || s.Path != "/api/v1/query_range" || s.Start != "1" || s.End != "2" || s.Step != "3" || s.Time != "" || s.ReceivedAtMs <= 0 {
			t.Errorf("record %+v does not echo the request", s)
		}
	}
	if strings.Join(order, ",") != "hang,slow,ok" {
		t.Errorf("order %v, want hang, slow, ok", order)
	}
	if m := find(l, "hang"); len(m) != 1 || m[0].State != "cancelled" {
		t.Errorf("hang records %+v, want one cancelled", m)
	}
}

// ci:go-test control routes: reset, methods, unknown routes; control calls are never listed.
func TestControlRoutes(t *testing.T) {
	f, srv := newControlServer(t, pulsusfake.Options{MaxRecords: controlRecords}, true)
	mustQuery(t, srv.URL, "ok", nil)

	resp, _ := call(t, http.MethodPost, srv.URL+"/__fake/reset")
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("POST /__fake/reset = %d, want 204", resp.StatusCode)
	}
	resp, body := call(t, http.MethodGet, srv.URL+"/__fake/requests")
	if resp.StatusCode != http.StatusOK || strings.TrimSpace(body) != "[]" || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		t.Errorf("GET /__fake/requests after reset = %d %q %q", resp.StatusCode, resp.Header.Get("Content-Type"), body)
	}
	resp, _ = call(t, http.MethodPost, srv.URL+"/__fake/requests")
	if resp.StatusCode != http.StatusMethodNotAllowed || resp.Header.Get("Allow") != "GET" {
		t.Errorf("POST /__fake/requests = %d Allow %q", resp.StatusCode, resp.Header.Get("Allow"))
	}
	resp, _ = call(t, http.MethodGet, srv.URL+"/__fake/reset")
	if resp.StatusCode != http.StatusMethodNotAllowed || resp.Header.Get("Allow") != "POST" {
		t.Errorf("GET /__fake/reset = %d Allow %q", resp.StatusCode, resp.Header.Get("Allow"))
	}
	resp, body = call(t, http.MethodGet, srv.URL+"/__fake/x")
	if resp.StatusCode != http.StatusNotFound || body != `{"error":"pulsus-fake: unknown control route"}` || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		t.Errorf("GET /__fake/x = %d %q", resp.StatusCode, body)
	}
	if r := f.Requests(); len(r) != 0 {
		t.Errorf("control calls were recorded: %+v", r)
	}
}

// ci:go-test control cap: a --control fake keeps the newest 1 000 records.
func TestControlCap(t *testing.T) {
	_, srv := newControlServer(t, pulsusfake.Options{MaxRecords: controlRecords}, true)
	for i := 1; i <= 1001; i++ {
		mustQuery(t, srv.URL, "ok", url.Values{"start": {strconv.Itoa(i)}})
	}
	l := list(t, srv.URL)
	if len(l) != 1000 || l[0].Start != "2" || l[len(l)-1].Start != "1001" {
		first, last := "", ""
		if len(l) > 0 {
			first, last = l[0].Start, l[len(l)-1].Start
		}
		t.Errorf("%d records, first start %q, last %q; want 1000, 2, 1001", len(l), first, last)
	}
}

// ci:go-test no control: without --control the fake is unchanged (no control routes, Reset per request).
func TestNoControl(t *testing.T) {
	f, srv := newControlServer(t, pulsusfake.Options{}, false)
	resp, body := call(t, http.MethodGet, srv.URL+"/__fake/requests")
	if resp.StatusCode != http.StatusNotFound || body != `{"status":"error","errorType":"not_found","error":"pulsus-fake: unexpected request"}` {
		t.Errorf("GET /__fake/requests = %d %s", resp.StatusCode, body)
	}
	if r := f.Requests(); len(r) != 0 {
		t.Errorf("records kept after a request: %+v", r)
	}
	mustQuery(t, srv.URL, "ok", nil)
	if r := f.Requests(); len(r) != 0 {
		t.Errorf("records kept after a request: %+v", r)
	}
}
