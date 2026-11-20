package gateway

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// countingTransport counts the upstream requests and answers none.
type countingTransport struct{ n atomic.Int32 }

func (c *countingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	c.n.Add(1)
	return nil, http.ErrHandlerTimeout
}

// orderGateway is a gateway whose bootstrap is bootstrap and whose upstream is counted.
func orderGateway(bootstrap func(context.Context) (core.BootstrapView, error)) (http.Handler, *countingTransport, *syncBuffer) {
	logs := &syncBuffer{}
	logger := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	ct := &countingTransport{}
	return New(Deps{Logger: logger, Probe: &fakeProbe{version: 1}, SchemaLatest: 1, Bootstrap: bootstrap,
		PulsusDB: pulsusdb.New(pulsusdb.Options{Logger: logger, Transport: ct})}), ct, logs
}

// review r1 #3: a reserved input is refused before tenant resolution and any upstream request.
func TestReservedBeforeResolution(t *testing.T) {
	var calls atomic.Int32
	h, ct, _ := orderGateway(func(context.Context) (core.BootstrapView, error) {
		calls.Add(1)
		return core.BootstrapView{}, nil
	})
	const q = "&from=1767225600000&to=1767229200000"
	for _, c := range []struct {
		name, pointer string
		rec           func() *httptest.ResponseRecorder
	}{
		{"range", "/query", func() *httptest.ResponseRecorder {
			return postJSON(h, rangePath, `{"query":"count(ALERTS)","from":1,"to":2,"width_px":10}`)
		}},
		{"instant", "/query", func() *httptest.ResponseRecorder { return postJSON(h, instantPath, `{"query":"ALERTS","at":1}`) }},
		{"labels", "/match/0", func() *httptest.ResponseRecorder {
			return do(h, http.MethodGet, "/api/dash/v1/prom/labels?tenant=demo"+q+"&match=ALERTS")
		}},
		{"label values", "/match/1", func() *httptest.ResponseRecorder {
			return do(h, http.MethodGet, "/api/dash/v1/prom/label/job/values?tenant=demo"+q+"&match=up&match=pulsus_anomaly_score")
		}},
		{"series", "/match/0", func() *httptest.ResponseRecorder {
			return do(h, http.MethodGet, "/api/dash/v1/prom/series?tenant=demo"+q+`&match={source="pulsus-dash"}`)
		}},
		{"metadata", "/metric", func() *httptest.ResponseRecorder {
			return do(h, http.MethodGet, "/api/dash/v1/prom/metadata?tenant=demo&metric=ALERTS_FOR_STATE")
		}},
	} {
		wantError(t, c.name, c.rec(), 400, "virtual_unsupported", c.pointer, "query.reserved")
		if n := calls.Load(); n != 0 {
			t.Errorf("%s: bootstrap called %d times", c.name, n)
		}
		if n := ct.n.Load(); n != 0 {
			t.Errorf("%s: %d upstream requests", c.name, n)
		}
	}
}

// stalledBootstrap blocks until the request's context ends, like a store that does not answer.
func stalledBootstrap(ctx context.Context) (core.BootstrapView, error) {
	<-ctx.Done()
	return core.BootstrapView{}, ctx.Err()
}

// review r1 #6: a deadline during tenant resolution is a timeout (504), not a store failure.
func TestStalledBootstrapTimeout(t *testing.T) {
	h, ct, logs := orderGateway(stalledBootstrap)
	for _, c := range []struct {
		name string
		rec  func() *httptest.ResponseRecorder
	}{
		{"range", func() *httptest.ResponseRecorder {
			return postJSON(h, rangePath, `{"query":"up","from":1767225600000,"to":1767229200000,"width_px":1200,"timeout_ms":300}`)
		}},
		{"instant", func() *httptest.ResponseRecorder {
			return postJSON(h, instantPath, `{"query":"up","at":1767229200000,"timeout_ms":300}`)
		}},
		{"check", func() *httptest.ResponseRecorder {
			return do(h, http.MethodGet, "/api/dash/v1/datasource/check?tenant=demo")
		}},
	} {
		start := time.Now()
		e := wantError(t, c.name, c.rec(), 504, "unavailable", "-", "")
		if e.Error.Hint["reason"] != "upstream_timeout" || time.Since(start) > 7*time.Second {
			t.Errorf("%s: hint %v after %v", c.name, e.Error.Hint, time.Since(start))
		}
	}
	if ct.n.Load() != 0 || strings.Contains(logs.String(), `"msg":"tenant_resolution"`) {
		t.Errorf("upstream requests %d; logs %s", ct.n.Load(), logs.String())
	}
}

// review r1 #6: a browser that goes away during tenant resolution gets nothing (499), not 503.
func TestStalledBootstrapCancel(t *testing.T) {
	h, _, logs := orderGateway(stalledBootstrap)
	srv := httptest.NewServer(h)
	defer srv.Close()
	for _, c := range []struct{ method, path, route, body string }{
		{http.MethodPost, rangePath, "/api/dash/v1/query/promql/range", `{"query":"up","from":1767225600000,"to":1767229200000,"width_px":1200}`},
		{http.MethodGet, "/api/dash/v1/prom/labels?tenant=demo&from=1&to=2", "/api/dash/v1/prom/labels", ""},
		{http.MethodGet, "/api/dash/v1/datasource/check?tenant=demo", "/api/dash/v1/datasource/check", ""},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
		req, _ := http.NewRequestWithContext(ctx, c.method, srv.URL+c.path, strings.NewReader(c.body))
		if resp, err := http.DefaultClient.Do(req); err == nil {
			_ = resp.Body.Close()
			t.Errorf("%s: answered %d", c.route, resp.StatusCode)
		}
		cancel()
		deadline := time.Now().Add(2 * time.Second)
		for {
			status := -1
			for _, r := range logs.records(t) {
				if r["msg"] == "http" && r["route"] == c.route {
					status = int(r["status"].(float64))
				}
			}
			if status == 499 {
				break
			}
			if status != -1 || time.Now().After(deadline) {
				t.Errorf("%s: access log status %d, want 499", c.route, status)
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	if strings.Contains(logs.String(), `"msg":"tenant_resolution"`) {
		t.Error("a cancel was logged as a store failure")
	}
}
