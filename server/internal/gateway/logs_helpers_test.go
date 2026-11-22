package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// The shared values of plan #65 A.1 and the log route paths (Part B).
const (
	logRangePath  = "/api/dash/v1/query/logql/range?tenant=demo"
	logVolumePath = "/api/dash/v1/query/logql/volume?tenant=demo"
	logWin        = `"from":1767225600000,"to":1767229200000,"width_px":1200`
	logLo         = "1767225600000000000"
	logHi         = "1767229200000000000"
	a1T0          = int64(1767229100000000000)
)

// logBody is a range or volume body for query with logWin and extra members (",…").
func logBody(query, extra string) string {
	q, _ := json.Marshal(query)
	return `{"query":` + string(q) + `,` + logWin + extra + `}`
}

// logGateway is queryGateway with Deps.Now at now.
func logGateway(t *testing.T, url string, o pulsusdb.Options, now time.Time) (http.Handler, *syncBuffer) {
	t.Helper()
	b := core.TenantBinding{OrgID: pdbOrg, ID: demoBindingID, Slug: "demo", DatasourceURL: url, Kind: "pulsusdb"}
	logs := &syncBuffer{}
	logger := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	o.Logger = logger
	view := core.BootstrapView{Org: core.Org{ID: pdbOrg, Slug: "default", Name: "Default organisation"}, Bindings: []core.TenantBinding{b}}
	return New(Deps{
		Logger: logger, Probe: &fakeProbe{version: 1}, SchemaLatest: 1,
		Bootstrap: func(context.Context) (core.BootstrapView, error) { return view, nil },
		Now:       func() time.Time { return now },
		PulsusDB:  pulsusdb.New(o),
	}), logs
}

// logUpstream is a scripted PulsusDB that records every request (form parsed) before answering.
type logUpstream struct {
	*httptest.Server
	mu    sync.Mutex
	reqs  []upReq
	count int
}

type upReq struct {
	Path string
	Form url.Values
	Done <-chan struct{} // the request's context
}

func newLogUpstream(t *testing.T, h func(w http.ResponseWriter, r *http.Request)) *logUpstream {
	t.Helper()
	u := &logUpstream{}
	u.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		u.mu.Lock()
		u.reqs = append(u.reqs, upReq{Path: r.URL.Path, Form: r.Form, Done: r.Context().Done()})
		u.count++
		u.mu.Unlock()
		h(w, r)
	}))
	t.Cleanup(u.Close)
	return u
}

func (u *logUpstream) requests() []upReq {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]upReq(nil), u.reqs...)
}

func (u *logUpstream) reset() {
	u.mu.Lock()
	u.reqs = nil
	u.mu.Unlock()
}

// writeJSONBody answers 200 application/json with body.
func writeJSONBody(w http.ResponseWriter, body string) {
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write([]byte(body))
}

const emptyStreams = `{"status":"success","data":{"resultType":"streams","result":[],"stats":{}}}`

// kv and ord write a JSON document in a chosen member order (plan #65 A.1 body(order, …)).
type kv struct {
	k string
	v any
}

type ord []kv

// appendOrdered appends v as compact JSON; reverse writes every object's members in reverse.
func appendOrdered(b *bytes.Buffer, v any, reverse bool) {
	switch x := v.(type) {
	case ord:
		b.WriteByte('{')
		for i := range x {
			m := x[i]
			if reverse {
				m = x[len(x)-1-i]
			}
			if i > 0 {
				b.WriteByte(',')
			}
			k, _ := json.Marshal(m.k)
			b.Write(k)
			b.WriteByte(':')
			appendOrdered(b, m.v, reverse)
		}
		b.WriteByte('}')
	case []any:
		b.WriteByte('[')
		for i, e := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			appendOrdered(b, e, reverse)
		}
		b.WriteByte(']')
	case json.RawMessage:
		b.Write(x)
	default:
		j, _ := json.Marshal(x)
		b.Write(j)
	}
}

// a1Answer is body(order, kind, result) of plan #65 A.1.
func a1Answer(reverse bool, kind string, result []any) string {
	doc := ord{{"status", "success"}, {"data", ord{{"resultType", kind}, {"result", result}, {"stats", ord{}}}}, {"warnings", []any{"w1"}}}
	var b bytes.Buffer
	appendOrdered(&b, doc, reverse)
	return b.String()
}

// a1Entry is a categorised value [ts, line, {structuredMetadata, parsed}].
func a1Entry(dts int64, line string, meta ord) []any {
	return []any{strconv.FormatInt(a1T0+dts, 10), line, meta}
}

var (
	metaA = ord{{"structuredMetadata", ord{{"detected_level", "info"}}}}
	metaB = ord{{"structuredMetadata", ord{{"detected_level", "unknown"}}}, {"parsed", ord{{"level", "WARNING"}}}}
	metaC = ord{{"structuredMetadata", ord{{"detected_level", "ERR"}}}, {"parsed", ord{{"level", "debug"}}}}
)

func a1Stream(pod string, values ...[]any) ord {
	vs := make([]any, len(values))
	for i, v := range values {
		vs[i] = v
	}
	return ord{{"stream", ord{{"app", "x"}, {"pod", pod}}}, {"values", vs}}
}

// a1BackwardPage1 is the answer of logs-page-backward-1 (a 5-entry top-limit with part of the
// group at 300).
func a1BackwardPage1() []any {
	return []any{
		a1Stream("c", a1Entry(300, "c3", metaC)),
		a1Stream("a", a1Entry(500, "a5", metaA), a1Entry(300, "a3", metaA)),
		a1Stream("b", a1Entry(400, "b4", metaB), a1Entry(300, "b3", metaB)),
	}
}

// a1Metric is the matrix of logs-metric.
func a1Metric() []any {
	return []any{
		ord{{"metric", ord{{"level", "error"}}}, {"values", []any{[]any{json.RawMessage("1767225600.000"), "3"}, []any{json.RawMessage("1767225605.000"), "1"}}}},
		ord{{"metric", ord{{"level", "info"}}}, {"values", []any{[]any{json.RawMessage("1767225600.000"), "10"}, []any{json.RawMessage("1767229200.000"), "7"}}}},
	}
}

// logPage is a decoded streams body.
type logPage struct {
	Kind    string `json:"kind"`
	Planned struct {
		Query    string `json:"query"`
		Expanded string `json:"expanded"`
		Bytes    int    `json:"bytes"`
		StepMs   int64  `json:"step_ms"`
	} `json:"planned"`
	Start     int64  `json:"start"`
	End       int64  `json:"end"`
	Step      int64  `json:"step"`
	Direction string `json:"direction"`
	Streams   []struct {
		Key     string            `json:"key"`
		Labels  map[string]string `json:"labels"`
		Entries []struct {
			TsNs     string            `json:"ts_ns"`
			Line     string            `json:"line"`
			Level    string            `json:"level"`
			Metadata map[string]string `json:"metadata"`
			Parsed   map[string]string `json:"parsed"`
		} `json:"entries"`
	} `json:"streams"`
	Cursor       *string        `json:"cursor"`
	Completeness map[string]any `json:"completeness"`
}

func decodePage(t *testing.T, b []byte) logPage {
	t.Helper()
	var p logPage
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		t.Fatalf("page body %.400q: %v", b, err)
	}
	return p
}
