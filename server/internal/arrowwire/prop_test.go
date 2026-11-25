package arrowwire

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

var propLabels = []string{"", "a", "héllo ✓", "日本語", "x=\"y\"", "tab\tnew\nline", "🙂"}

// propValue is one random point: a value string, or "" for an absent point.
func propValue(r *rand.Rand) string {
	switch r.IntN(10) {
	case 0:
		return "NaN"
	case 1:
		return "+Inf"
	case 2:
		return "-Inf"
	case 3:
		return "-0"
	case 4:
		return strconv.FormatFloat([]float64{5e-324, 2.2e-310, -1e-320}[r.IntN(3)], 'g', -1, 64)
	case 5:
		return strconv.FormatFloat([]float64{math.MaxFloat64, -math.MaxFloat64}[r.IntN(2)], 'g', -1, 64)
	case 6:
		return ""
	default:
		return strconv.FormatFloat((r.Float64()-0.5)*math.Pow(10, float64(r.IntN(40)-20)), 'g', -1, 64)
	}
}

// propMatrix is a seeded PulsusDB matrix body: 0–70 series of 1–300 points.
func propMatrix(seed uint64) (body []byte, start time.Time, n int, step time.Duration) {
	r := rand.New(rand.NewPCG(seed, 68)) // #nosec G404 -- seeded test data, not security
	series, n := r.IntN(71), 1+r.IntN(300)
	step = time.Duration(1+r.IntN(60)) * time.Second
	start = time.UnixMilli(1767225600000)
	type result struct {
		Metric map[string]string `json:"metric"`
		Values [][2]any          `json:"values"`
	}
	res := []result{}
	for s := 0; s < series; s++ {
		m := map[string]string{"series": strconv.Itoa(s)}
		if r.IntN(2) == 0 {
			m["label"] = propLabels[r.IntN(len(propLabels))]
		}
		var vals [][2]any
		for k := 0; k < n; k++ {
			v := propValue(r)
			if v == "" {
				continue
			}
			vals = append(vals, [2]any{start.Add(time.Duration(k) * step).Unix(), v})
		}
		if vals == nil {
			vals = [][2]any{}
		}
		res = append(res, result{Metric: m, Values: vals})
	}
	b, _ := json.Marshal(map[string]any{"status": "success", "data": map[string]any{"resultType": "matrix", "result": res}})
	return b, start, n, step
}

// propBody runs one seeded matrix body through Client.QueryRange into a GridPart and returns
// the DSF body and the series the client decoded.
func propBody(t *testing.T, seed uint64) ([]byte, []*pulsusdb.Series) {
	t.Helper()
	upstream, start, n, step := propMatrix(seed)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(upstream)
	}))
	defer srv.Close()
	binding := core.TenantBinding{ID: uuid.MustParse("01900000-0000-7000-8000-000000000001"), Slug: "demo", DatasourceURL: srv.URL, Kind: "pulsusdb"}
	rc := &core.RequestCtx{Tenant: core.TenantCtx{Org: core.OrgID(uuid.MustParse("01900000-0000-7000-8000-0000000000aa")), Binding: binding},
		Principal: core.LocalPrincipal, Scope: core.FullTenantScope(), Priority: core.PriorityInteractive, RequestID: "req-1"}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	end := start.Add(time.Duration(n-1) * step)
	rs, err := pulsusdb.New(pulsusdb.Options{}).QueryRange(ctx, rc, pulsusdb.RangeQuery{Query: "q", Start: start, End: end, Step: step, Timeout: 30 * time.Second})
	mustOK(t, err)
	defer func() { _ = rs.Close() }()
	spec := GridSpec{LabelsPart: 1, DataPart: 2, Grid: pulsusdb.Grid{Start: start.UnixMilli(), End: end.UnixMilli(), Step: step.Milliseconds()},
		Result: "metric", Source: "pulsusdb", RequestedStartMs: start.UnixMilli()}
	var buf bytes.Buffer
	w := NewWriter(&buf)
	p, err := w.Grid(spec, CoverageFrom(rs.Completeness(), PhasePlanned, 0))
	mustOK(t, err)
	var series []*pulsusdb.Series
	for {
		s, err := rs.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		mustOK(t, err)
		series = append(series, s)
		mustOK(t, p.Add(s))
	}
	mustOK(t, p.Finish(CoverageFrom(rs.Completeness(), PhaseFinal, uint32(len(series))))) // #nosec G115 -- ≤ 70 series
	mustOK(t, w.End())
	return buf.Bytes(), series
}

// unit:json-arrow-prop (T04-004, T04-005): 200 seeded PulsusDB bodies; the Arrow read-back is
// the client's Series bit for bit, validity = Present.
func TestJSONArrowProp(t *testing.T) {
	for seed := uint64(1); seed <= 200; seed++ {
		b, series := propBody(t, seed)
		got := readBody(t, b)
		if len(got.Parts) != 1 {
			t.Fatalf("seed %d: %d parts", seed, len(got.Parts))
		}
		if want := expectSeriesOf(series); !reflect.DeepEqual(got.Parts[0].Series, want) {
			t.Fatalf("seed %d: read-back differs from the decoded series", seed)
		}
	}
}
