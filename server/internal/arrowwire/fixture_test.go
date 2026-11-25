package arrowwire

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake/fakeharness"
)

var update = flag.Bool("update", false, "rewrite wire/fixtures/arrow")

const fixtureDir = "../../../wire/fixtures/arrow"

// fixtures are the golden DSF bodies of plan #68 B1 §3.5, each with its expectation built from
// the writer's inputs.
var fixtures = []struct {
	name  string
	build func(t *testing.T) ([]byte, expectBody)
}{
	{"promql-range-counter", buildCounter},
	{"grid-batches", buildBatches},
	{"grid-error", buildError},
	{"grid-empty", buildEmpty},
	{"part-ids", buildPartIDs},
}

// unit:codec-roundtrip (Go side, T04-001, T04-005): each fixture is rebuilt byte for byte, and
// its committed bytes read back with arrow-go equal its .expect.json.
func TestFixtures(t *testing.T) {
	for _, fx := range fixtures {
		t.Run(fx.name, func(t *testing.T) {
			body, want := fx.build(t)
			wantJSON, err := json.MarshalIndent(want, "", " ")
			if err != nil {
				t.Fatal(err)
			}
			wantJSON = append(wantJSON, '\n')
			dsf, exp := filepath.Join(fixtureDir, fx.name+".dsf"), filepath.Join(fixtureDir, fx.name+".expect.json")
			if *update {
				if err := os.WriteFile(dsf, body, 0o644); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(exp, wantJSON, 0o644); err != nil {
					t.Fatal(err)
				}
			}
			committed, err := os.ReadFile(dsf)
			if err != nil {
				t.Fatalf("%v (run with -update to write the fixtures)", err)
			}
			if !bytes.Equal(committed, body) {
				t.Errorf("%s: the writer's %d bytes differ from the committed %d", dsf, len(body), len(committed))
			}
			committedExp, err := os.ReadFile(exp)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(committedExp, wantJSON) {
				t.Errorf("%s differs from the expectation built from the writer's inputs", exp)
			}
			got, err := json.MarshalIndent(readBody(t, committed), "", " ")
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(append(got, '\n'), committedExp) {
				t.Errorf("%s read back with arrow-go differs from %s:\n%s", dsf, exp, firstDiff(got, committedExp))
			}
		})
	}
}

func firstDiff(a, b []byte) string {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			lo := max(i-200, 0)
			return "got  …" + string(a[lo:min(i+200, len(a))]) + "\nwant …" + string(b[lo:min(i+200, len(b))])
		}
	}
	return "lengths differ: " + strconv.Itoa(len(a)) + " vs " + strconv.Itoa(len(b))
}

func mustOK(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// buildCounter runs the counter query against the strict PulsusDB fake and writes parts 1/2.
func buildCounter(t *testing.T) ([]byte, expectBody) {
	_, url := fakeharness.Start(t)
	c := pulsusdb.New(pulsusdb.Options{})
	binding := core.TenantBinding{ID: uuid.MustParse("01900000-0000-7000-8000-000000000001"), Slug: "demo", DatasourceURL: url, Kind: "pulsusdb"}
	rc := &core.RequestCtx{Tenant: core.TenantCtx{Org: core.OrgID(uuid.MustParse("01900000-0000-7000-8000-0000000000aa")), Binding: binding},
		Principal: core.LocalPrincipal, Scope: core.FullTenantScope(), Priority: core.PriorityInteractive, RequestID: "req-1"}
	g, err := pulsusdb.PromGrid(1767225600000, 1767229200000, 1200)
	mustOK(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	rs, err := c.QueryRange(ctx, rc, pulsusdb.RangeQuery{Query: `sum by (job, instance) (rate(http_requests_total[5m]))`,
		Start: time.UnixMilli(g.Start), End: time.UnixMilli(g.End), Step: time.Duration(g.Step) * time.Millisecond, Timeout: 30 * time.Second})
	mustOK(t, err)
	defer func() { _ = rs.Close() }()

	golden, err := os.ReadFile("../../../wire/fixtures/json/promql-range-counter.json")
	mustOK(t, err)
	var route struct {
		Planned json.RawMessage `json:"planned"`
	}
	mustOK(t, json.Unmarshal(golden, &route))

	spec := GridSpec{LabelsPart: 1, DataPart: 2, Grid: g, Result: "metric", Source: "pulsusdb",
		RequestedStartMs: 1767225600000, Planned: []byte(route.Planned)}
	planned := CoverageFrom(rs.Completeness(), PhasePlanned, 0)
	var buf bytes.Buffer
	w := NewWriter(&buf)
	p, err := w.Grid(spec, planned)
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
	final := CoverageFrom(rs.Completeness(), PhaseFinal, uint32(len(series)))
	mustOK(t, p.Finish(final))
	mustOK(t, w.End())
	return buf.Bytes(), expectBody{Parts: []expectPart{expectPartFor(spec, series, []Coverage{planned, final}, nil)}, Errors: []expectError{}}
}

func emptyComp() pulsusdb.Completeness {
	return pulsusdb.Completeness{Warnings: []string{}, Infos: []string{}, ReadCacheThroughMs: -1, NewestSampleMs: -1}
}

// buildBatches writes 70 synthetic series of 4 points: batches 1, 64, 5; volatile, rank 1.
func buildBatches(t *testing.T) ([]byte, expectBody) {
	spec := GridSpec{LabelsPart: 1, DataPart: 2, Rank: 1, Volatile: true, Grid: pulsusdb.Grid{Start: 60_000, End: 105_000, Step: 15_000},
		Result: "metric", Source: "pulsusdb", Unit: "bytes", RequestedStartMs: 67_500}
	var series []*pulsusdb.Series
	for i := 0; i < 70; i++ {
		v := []float64{float64(i), -float64(i) / 4, math.Float64frombits(0x7FF8000000000001), 0}
		p := []bool{true, true, true, i%3 != 0}
		if i%2 == 1 {
			v[2] = math.Float64frombits(0xFFF8000000000000)
		}
		var s *pulsusdb.Series
		switch i {
		case 0:
			s = newSeries(v, p)
		case 1:
			s = newSeries(v, p, "a", "", "msg", "héllo ✓")
		default:
			s = newSeries(v, p, "job", "batch", "n", strconv.Itoa(i))
		}
		series = append(series, s)
	}
	comp := emptyComp()
	comp.Truncated, comp.Warnings = true, []string{"results truncated due to limit"}
	planned := CoverageFrom(emptyComp(), PhasePlanned, 0)
	final := CoverageFrom(comp, PhaseFinal, 70)
	final.TruncationReason = ptr("limit")
	var buf bytes.Buffer
	w := NewWriter(&buf)
	p, err := w.Grid(spec, planned)
	mustOK(t, err)
	for _, s := range series {
		mustOK(t, p.Add(s))
	}
	mustOK(t, p.Finish(final))
	mustOK(t, w.End())
	return buf.Bytes(), expectBody{Parts: []expectPart{expectPartFor(spec, series, []Coverage{planned, final}, nil)}, Errors: []expectError{}}
}

// buildError fails parts 3/4 after one sent and one pending series, then refuses part 5.
func buildError(t *testing.T) ([]byte, expectBody) {
	spec := GridSpec{LabelsPart: 3, DataPart: 4, Grid: pulsusdb.Grid{Start: 1767225600000, End: 1767225615000, Step: 5000},
		Result: "metric", Source: "pulsusdb", RequestedStartMs: 1767225600000}
	s0, s1 := rampSeries(0, 4), rampSeries(1, 4)
	planned := CoverageFrom(emptyComp(), PhasePlanned, 0)
	partial := CoverageFrom(emptyComp(), PhasePartial, 1)
	e := ErrorRow{Code: 1, HTTPStatus: 422, Message: "too broad", Suggestion: ptr("add a label matcher")}
	e5 := ErrorRow{Code: 0, HTTPStatus: 400, Message: "parse error", Position: ptr(uint32(7))}
	var buf bytes.Buffer
	w := NewWriter(&buf)
	p, err := w.Grid(spec, planned)
	mustOK(t, err)
	mustOK(t, p.Add(s0))
	mustOK(t, p.Add(s1))
	mustOK(t, p.Fail(partial, e))
	mustOK(t, w.Error(5, 0, e5))
	mustOK(t, w.End())
	return buf.Bytes(), expectBody{Parts: []expectPart{expectPartFor(spec, []*pulsusdb.Series{s0}, []Coverage{planned, partial}, &e)},
		Errors: []expectError{{Part: 5, Error: toErrorJSON(e5)}}}
}

// buildEmpty finishes a part pair without series.
func buildEmpty(t *testing.T) ([]byte, expectBody) {
	spec := GridSpec{LabelsPart: 1, DataPart: 2, Grid: pulsusdb.Grid{Start: 0, End: 60_000, Step: 15_000},
		Result: "metric", Source: "pulsusdb", RequestedStartMs: 0}
	planned := CoverageFrom(emptyComp(), PhasePlanned, 0)
	final := CoverageFrom(emptyComp(), PhaseFinal, 0)
	var buf bytes.Buffer
	w := NewWriter(&buf)
	p, err := w.Grid(spec, planned)
	mustOK(t, err)
	mustOK(t, p.Finish(final))
	mustOK(t, w.End())
	return buf.Bytes(), expectBody{Parts: []expectPart{expectPartFor(spec, nil, []Coverage{planned, final}, nil)}, Errors: []expectError{}}
}

// buildPartIDs is the valid part-id sequence of unit:part-ids: 1/2 and 3/4 open together, both
// finished, then an ERROR for part 5 and END.
func buildPartIDs(t *testing.T) ([]byte, expectBody) {
	specA := GridSpec{LabelsPart: 1, DataPart: 2, Grid: pulsusdb.Grid{Start: 0, End: 15_000, Step: 5000}, Result: "metric", Source: "pulsusdb"}
	specB := specA
	specB.LabelsPart, specB.DataPart = 3, 4
	a, b := rampSeries(0, 4), rampSeries(1, 4)
	planned := CoverageFrom(emptyComp(), PhasePlanned, 0)
	final := CoverageFrom(emptyComp(), PhaseFinal, 1)
	e5 := ErrorRow{Code: 8, HTTPStatus: 500, Message: "internal"}
	var buf bytes.Buffer
	w := NewWriter(&buf)
	pa, err := w.Grid(specA, planned)
	mustOK(t, err)
	mustOK(t, pa.Add(a))
	pb, err := w.Grid(specB, planned)
	mustOK(t, err)
	mustOK(t, pa.Finish(final))
	mustOK(t, pb.Add(b))
	mustOK(t, pb.Finish(final))
	mustOK(t, w.Error(5, 0, e5))
	mustOK(t, w.End())
	return buf.Bytes(), expectBody{Parts: []expectPart{
		expectPartFor(specA, []*pulsusdb.Series{a}, []Coverage{planned, final}, nil),
		expectPartFor(specB, []*pulsusdb.Series{b}, []Coverage{planned, final}, nil),
	}, Errors: []expectError{{Part: 5, Error: toErrorJSON(e5)}}}
}
