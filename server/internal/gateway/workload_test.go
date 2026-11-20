package gateway

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// The budget workloads of plan #62 A.11. W1: a 1 000 × 1 000 matrix decoded, placed on the grid
// and encoded; W2: 1 000 sequential range requests for a 1-series, 60-point matrix.

const workloadFrom = 1767225600000

// matrixBody is a matrix of n series of points points at 5 s from workloadFrom: values "1.5",
// every 7th "NaN". It is built before the measured boundary (A.11).
func matrixBody(n, points int) []byte {
	b := make([]byte, 0, 64+n*(80+points*22))
	b = append(b, `{"status":"success","data":{"resultType":"matrix","result":[`...)
	for i := range n {
		if i > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"metric":{"__name__":"w","instance":"i-`...)
		b = fmt.Appendf(b, "%04d", i)
		b = append(b, `","job":"bench"},"values":[`...)
		for j := range points {
			if j > 0 {
				b = append(b, ',')
			}
			b = append(b, '[')
			b = strconv.AppendInt(b, workloadFrom/1000+int64(j)*5, 10)
			if j%7 == 0 {
				b = append(b, `,"NaN"]`...)
			} else {
				b = append(b, `,"1.5"]`...)
			}
		}
		b = append(b, "]}"...)
	}
	return append(b, "]}}"...)
}

// memTransport answers every request with body, after delay; it records the time it spent.
type memTransport struct {
	body  []byte
	delay time.Duration
	mu    sync.Mutex
	spent time.Duration
}

func (m *memTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	start := time.Now()
	if req.Body != nil {
		_, _ = io.Copy(io.Discard, req.Body)
		_ = req.Body.Close()
	}
	if m.delay > 0 {
		time.Sleep(m.delay)
	}
	m.mu.Lock()
	m.spent += time.Since(start)
	m.mu.Unlock()
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}},
		Body: io.NopCloser(bytes.NewReader(m.body)), Request: req, ContentLength: int64(len(m.body))}, nil
}

func (m *memTransport) take() time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	d := m.spent
	m.spent = 0
	return d
}

// discard is a ResponseWriter that drops the body.
type discard struct{ h http.Header }

func (d *discard) Header() http.Header         { return d.h }
func (d *discard) Write(p []byte) (int, error) { return len(p), nil }
func (d *discard) WriteHeader(int)             {}
func (d *discard) Flush()                      {}

// workloadGateway is a gateway with the binding in memory (no Postgres), credentials configured
// (so redaction is in the counted path) and the upstream m.
func workloadGateway(m *memTransport) http.Handler {
	b := core.TenantBinding{OrgID: pdbOrg, ID: demoBindingID, Slug: "demo", DatasourceURL: "http://localhost:9091",
		CredentialsRef: "env:C", Kind: "pulsusdb"}
	view := core.BootstrapView{Org: core.Org{ID: pdbOrg, Slug: "default", Name: "Default organisation"}, Bindings: []core.TenantBinding{b}}
	logger := slog.New(slog.DiscardHandler)
	return New(Deps{Logger: logger, Probe: &fakeProbe{version: 1}, SchemaLatest: 1,
		Bootstrap: func(context.Context) (core.BootstrapView, error) { return view, nil },
		PulsusDB: pulsusdb.New(pulsusdb.Options{Logger: logger, Transport: m,
			Secrets: func(string) (string, error) { return "bench:pw-secret-bench", nil }})})
}

// rangeOnce runs one range request of points grid points and reports its status.
func rangeOnce(h http.Handler, points int) int {
	to := workloadFrom + int64(points-1)*5000
	body := fmt.Sprintf(`{"query":"w","from":%d,"to":%d,"width_px":%d}`, workloadFrom, to, max(points, 1))
	req := httptest.NewRequest(http.MethodPost, rangePath, strings.NewReader(body))
	sw := &statusRecorder{}
	h.ServeHTTP(&statusOnly{discard: discard{h: http.Header{}}, rec: sw}, req)
	return sw.status
}

type statusRecorder struct{ status int }

type statusOnly struct {
	discard
	rec *statusRecorder
}

func (s *statusOnly) WriteHeader(code int) {
	if s.rec.status == 0 {
		s.rec.status = code
	}
}

func (s *statusOnly) Write(p []byte) (int, error) {
	if s.rec.status == 0 {
		s.rec.status = 200
	}
	return len(p), nil
}

// w1 is the W1 harness: the upstream body and the gateway, built before the measured boundary.
type w1 struct {
	h      http.Handler
	points int
}

func newW1(series, points int) w1 { return newW1Body(matrixBody(series, points), points) }

// newW1Body is the W1 harness over an upstream body built earlier (cpu-instr.sh writes it to a
// file before valgrind starts).
func newW1Body(body []byte, points int) w1 {
	return w1{h: workloadGateway(&memTransport{body: body}), points: points}
}

// run decodes, grids and encodes the matrix once: from the first read of the upstream body to
// the last byte of the response.
func (w w1) run(t testing.TB) {
	if code := rangeOnce(w.h, w.points); code != 200 {
		t.Fatalf("W1: status %d", code)
	}
}

// runW1 builds the W1 harness and runs it once.
func runW1(t testing.TB, series, points int) { newW1(series, points).run(t) }

// runW2 runs n sequential range requests for a 1-series, 60-point matrix and returns each
// request's duration minus the upstream's.
func runW2(t testing.TB, n int, delay time.Duration) []time.Duration {
	return runW2Body(t, matrixBody(1, 60), n, delay)
}

// runW2Body is W2 over an upstream body built earlier.
func runW2Body(t testing.TB, body []byte, n int, delay time.Duration) []time.Duration {
	m := &memTransport{body: body, delay: delay}
	h := workloadGateway(m)
	out := make([]time.Duration, 0, n)
	for range n {
		start := time.Now()
		if code := rangeOnce(h, 60); code != 200 {
			t.Fatalf("W2: status %d", code)
		}
		out = append(out, time.Since(start)-m.take())
	}
	return out
}
