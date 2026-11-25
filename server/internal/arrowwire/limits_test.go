package arrowwire

import (
	"bytes"
	"encoding/json"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"strings"
	"testing"
	uni "unicode/utf8"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// limitsFile is one of wire/schemas/limits*.json.
type limitsFile struct {
	Limits
	Cost map[string]int `json:"cost"`
}

func readLimits(t *testing.T, name string) limitsFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("../../../wire/schemas", name)) //nolint:gosec // the repository's limit files
	if err != nil {
		t.Fatal(err)
	}
	var f limitsFile
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return f
}

// testLimits is wire/schemas/limits-test.json, the set the limits-*.dsf fixtures use.
func testLimits(t *testing.T) Limits {
	t.Helper()
	return readLimits(t, "limits-test.json").Limits
}

// unit:limits-json, Go side (plan #68 B3 §3.1): DefaultLimits, MaxGridLen, MaxPayload and the
// accounting costs equal wire/schemas/limits.json; both files' reserves follow their formula.
func TestLimitsJSON(t *testing.T) {
	f := readLimits(t, "limits.json")
	if got := DefaultLimits(); got != f.Limits {
		t.Errorf("DefaultLimits() = %+v, limits.json = %+v", got, f.Limits)
	}
	if MaxGridLen != f.MaxGridLen || MaxPayload != f.MaxPayload {
		t.Errorf("MaxGridLen %d, MaxPayload %d; limits.json %d, %d", MaxGridLen, MaxPayload, f.MaxGridLen, f.MaxPayload)
	}
	costs := map[string]int{"part": costPart, "schema": costSchema, "series": costSeries, "label": costLabel,
		"batch": costBatch, "batch_series": costBatchSeries, "coverage": costCoverage, "list_element": costListElement,
		"error": costError, "value": costValue, "validity_word": costValidityWord}
	for _, name := range []string{"limits.json", "limits-test.json"} {
		l := readLimits(t, name)
		if !maps.Equal(l.Cost, costs) {
			t.Errorf("%s: cost %v, the writer's %v", name, l.Cost, costs)
		}
		pr := costCoverage + l.MetaStringBytes + costListElement*l.MetaListElements + costError + l.MetaStringBytes
		if l.PartReserve != pr || l.StreamReserve != costError+l.MetaStringBytes {
			t.Errorf("%s: part_reserve %d (formula %d), stream_reserve %d (formula %d)", name, l.PartReserve, pr,
				l.StreamReserve, costError+l.MetaStringBytes)
		}
	}
}

// limitWriter is a Writer with the test limit set on a buffer.
func limitWriter(t *testing.T) (*bytes.Buffer, *Writer) {
	t.Helper()
	var buf bytes.Buffer
	return &buf, NewWriterLimits(&buf, testLimits(t))
}

// gridSpecN is a part pair of an n-point grid at 0 with a 1 s step.
func gridSpecN(l, d uint32, n int) GridSpec {
	return GridSpec{LabelsPart: l, DataPart: d, Grid: pulsusdb.Grid{Start: 0, End: int64(n-1) * 1000, Step: 1000},
		Result: "metric", Source: "pulsusdb"}
}

func planned0() Coverage { return CoverageFrom(emptyComp(), PhasePlanned, 0) }

func final0(n int) Coverage { return CoverageFrom(emptyComp(), PhaseFinal, uint32(n)) } // #nosec G115 -- test counts

// seriesKV is an n-point ramp series with the label pairs kv.
func seriesKV(i, n int, kv ...string) *pulsusdb.Series {
	s := rampSeries(i, n)
	return newSeries(s.Values, s.Present, kv...)
}

// rowsSeries is an n-point series with r labels prefix00, prefix01, … with empty values.
func rowsSeries(i, n, r int, prefix string) *pulsusdb.Series {
	kv := make([]string, 0, 2*r)
	for k := 0; k < r; k++ {
		kv = append(kv, prefix+string(rune('0'+k/10))+string(rune('0'+k%10)), "")
	}
	return seriesKV(i, n, kv...)
}

// autoClosed is the coverage an auto-close writes from base (B3 §3.2).
func autoClosed(base Coverage, sent int, reason string) Coverage {
	base.Phase, base.SeriesReturned, base.Truncated = PhaseFinal, uint32(sent), true // #nosec G115 -- test counts
	base.TruncationReason = ptr(reason)
	return base
}

func refusedJSON() expectError {
	return expectError{Part: 0, Error: toErrorJSON(refusedRow("writer refused"))}
}

// labelsRows is the row count of a labels or data BATCH read with its part's SCHEMA payload.
func batchRows(t *testing.T, schema, batch rawFrame) int64 {
	t.Helper()
	_, recs := readStream(t, append(append([]byte{}, schema.Payload...), batch.Payload...))
	if len(recs) != 1 {
		t.Fatalf("batch of part %d: %d records", batch.PartID, len(recs))
	}
	return recs[0].NumRows()
}

// unit:wire-limits (plan #68 B3 §5; T04-010, T04-012, PRF-031): the writer's limits with
// limits-test.json. The fixture bodies themselves are checked byte for byte by TestFixtures.
func TestWireLimits(t *testing.T) {
	l := testLimits(t)

	t.Run("labels batches split between series", func(t *testing.T) {
		body, _, _ := limitsSeries(t)
		fs := splitFrames(t, body)
		type row struct {
			T    FrameType
			Part uint32
			Rows int64
		}
		var got []row
		schemas := map[uint32]rawFrame{}
		for _, f := range fs[:8] {
			r := row{f.Type, f.PartID, -1}
			switch f.Type {
			case FrameSchema:
				schemas[f.PartID] = f
			case FrameBatch:
				r.Rows = batchRows(t, schemas[f.PartID], f)
			}
			got = append(got, r)
		}
		want := []row{{FrameSchema, 1, -1}, {FrameMeta, 2, -1}, {FrameSchema, 2, -1},
			{FrameBatch, 1, 50}, {FrameBatch, 2, 1}, // one 50-row series: one BATCH(L)
			{FrameBatch, 1, 50}, {FrameBatch, 1, 1}, {FrameBatch, 2, 3}} // 25 + 25 + 1 rows
		if len(got) != len(want) {
			t.Fatalf("frames %v, want %v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("frame %d: %+v, want %+v", i, got[i], want[i])
			}
		}
	})

	t.Run("a series above rows_per_batch is refused and closes the part", func(t *testing.T) {
		buf, w := limitWriter(t)
		p, err := w.Grid(gridSpecN(1, 2, 4), planned0())
		mustOK(t, err)
		before := buf.Len()
		if err := p.Add(rowsSeries(0, 4, l.RowsPerBatchLabels+1, "a")); !errors.Is(err, ErrLimit) {
			t.Fatalf("Add of a 51-row series: %v, want ErrLimit", err)
		}
		fs := splitFrames(t, buf.Bytes()[before:])
		if len(fs) != 2 || fs[0].Type != FrameBatch || fs[0].PartID != 1 || fs[0].Flags != FlagLast ||
			fs[1].Type != FrameMeta || fs[1].PartID != 2 || fs[1].Flags != FlagLast {
			t.Fatalf("auto-close frames %v", frameSeq(t, buf.Bytes()[before:]))
		}
		if c := coverageOf(t, fs[1].Payload); !c.Truncated || c.TruncationReason == nil || *c.TruncationReason != reasonWireLimit ||
			c.Phase != uint8(PhaseFinal) || c.SeriesReturned != 0 {
			t.Errorf("auto-close coverage %+v", c)
		}
		n := buf.Len()
		for name, call := range map[string]func() error{
			"Add":    func() error { return p.Add(rampSeries(1, 4)) },
			"Flush":  p.Flush,
			"Finish": func() error { return p.Finish(final0(0)) },
			"Fail":   func() error { return p.Fail(planned0(), ErrorRow{Code: 8, HTTPStatus: 500, Message: "x"}) },
		} {
			if err := call(); !errors.Is(err, ErrLimit) {
				t.Errorf("%s after the auto-close: %v, want ErrLimit", name, err)
			}
		}
		if buf.Len() != n {
			t.Errorf("calls on a closed part wrote %d bytes", buf.Len()-n)
		}
		mustOK(t, w.End())
	})

	t.Run("error strings are cut", func(t *testing.T) {
		m1024 := strings.Repeat("m", 1024)
		if e := cutError(ErrorRow{Message: m1024}, l); e.Message != m1024 || e.Suggestion != nil {
			t.Errorf("a 1 024-B message changed: %d bytes", len(e.Message))
		}
		for _, in := range []ErrorRow{
			{Message: strings.Repeat("m", 1100), Suggestion: ptr(strings.Repeat("s", 300))},
			{Message: strings.Repeat("é", 550), Suggestion: ptr(strings.Repeat("ü", 150))},
		} {
			e := cutError(in, l)
			if e.Suggestion == nil || len(*e.Suggestion) > l.MetaStringBytes/4 || len(e.Message) > l.MetaStringBytes-l.MetaStringBytes/4 ||
				!strings.HasSuffix(e.Message, cutMarker) || !strings.HasSuffix(*e.Suggestion, cutMarker) ||
				!uni.ValidString(e.Message) || !uni.ValidString(*e.Suggestion) || len(e.Message)+len(*e.Suggestion) > l.MetaStringBytes {
				t.Errorf("cut error: message %d B, suggestion %v", len(e.Message), e.Suggestion)
			}
		}
	})

	t.Run("coverage cuts", func(t *testing.T) {
		names := func(p string, n int) []string {
			out := []string{}
			for i := 0; i < n; i++ {
				out = append(out, p+string(rune('a'+i)))
			}
			return out
		}
		total := func(c Coverage) int {
			n := 0
			if c.TruncationReason != nil {
				n += len(*c.TruncationReason)
			}
			for _, xs := range [][]string{c.ExcludedDims, c.Warnings, c.Infos, c.UpstreamQueryIDs} {
				for _, x := range xs {
					n += len(x)
					if !uni.ValidString(x) {
						t.Errorf("invalid UTF-8 %q", x)
					}
				}
			}
			return n
		}
		c := final0(0)
		c.ExcludedDims = names("d", 20)
		got, cut := cutCoverage(c, l)
		if !cut || len(got.ExcludedDims) != l.MetaListElements || !got.Truncated || got.TruncationReason == nil ||
			*got.TruncationReason != reasonCoverageCut {
			t.Errorf("20 excluded_dims: cut %v → %+v", cut, got)
		}
		c = final0(0)
		c.Warnings = names("w", 20)
		got, cut = cutCoverage(c, l)
		if !cut || len(got.Warnings) != l.MetaListElements || !got.Truncated || *got.TruncationReason != reasonCoverageCut {
			t.Errorf("20 warnings: cut %v → %+v", cut, got)
		}
		at := final0(0)
		at.Infos = []string{strings.Repeat("a", 1000), strings.Repeat("b", 24)}
		if got, cut := cutCoverage(at, l); cut || got.Truncated || total(got) != 1024 || got.TruncationReason != nil {
			t.Errorf("1 024 B changed: %+v", got)
		}
		for _, last := range []string{"b", "é"} {
			c := final0(0)
			c.Infos = []string{strings.Repeat("a", 997), last + strings.Repeat("c", 1025-997-len(last))}
			got, cut := cutCoverage(c, l)
			if !cut || !got.Truncated || *got.TruncationReason != reasonCoverageCut || total(got) > l.MetaStringBytes ||
				!strings.HasSuffix(got.Infos[len(got.Infos)-1], cutMarker) {
				t.Errorf("1 025 B (%q): %+v, %d B", last, got, total(got))
			}
		}
		c = final0(0)
		c.TruncationReason = ptr(strings.Repeat("r", 100))
		got, cut = cutCoverage(c, l)
		if !cut || !got.Truncated || *got.TruncationReason != strings.Repeat("r", 50)+cutMarker || len(*got.TruncationReason) != 64 {
			t.Errorf("a 100-B reason: %+v", got)
		}
	})

	t.Run("writer errors count against distinct_parts", func(t *testing.T) {
		buf, w := limitWriter(t)
		e := ErrorRow{Code: 0, HTTPStatus: 400, Message: "bad"}
		for part := uint32(1); part <= uint32(l.DistinctParts); part++ { // #nosec G115 -- 8
			mustOK(t, w.Error(part, 0, e))
		}
		if err := w.Error(uint32(l.DistinctParts)+1, 0, e); !errors.Is(err, ErrLimit) { // #nosec G115 -- 8
			t.Fatalf("Error %d: %v, want ErrLimit", l.DistinctParts+1, err)
		}
		fs := splitFrames(t, buf.Bytes())
		lastF := fs[len(fs)-1]
		if len(fs) != l.DistinctParts+1 || lastF.Type != FrameError || lastF.PartID != 0 || errorOf(t, lastF.Payload) != toErrorJSON(refusedRow("writer refused")) {
			t.Fatalf("frames %v", frameSeq(t, buf.Bytes()))
		}
		n := buf.Len()
		if _, err := w.Grid(gridSpecN(20, 21, 4), planned0()); !errors.Is(err, ErrOrder) {
			t.Errorf("Grid after the refusal: %v", err)
		}
		if err := w.Error(30, 0, e); !errors.Is(err, ErrOrder) {
			t.Errorf("Error after the refusal: %v", err)
		}
		if buf.Len() != n {
			t.Errorf("calls after the refusal wrote %d bytes", buf.Len()-n)
		}
		mustOK(t, w.End())
	})

	t.Run("budgets", func(t *testing.T) {
		for _, b := range []struct {
			name  string
			build func(*testing.T) ([]byte, expectBody, *Writer)
		}{
			{"limits-budget", limitsBudget}, {"limits-value", limitsValue}, {"limits-open-parts", limitsOpenParts},
			{"limits-distinct-parts", limitsDistinctParts}, {"limits-series", limitsSeries}, {"limits-rows", limitsRows},
			{"limits-strings", limitsStrings}, {"limits-errors", limitsErrors}, {"limits-fail", limitsFail},
			{"limits-refused", limitsRefused},
		} {
			_, _, w := b.build(t)
			if w.spent > l.BodyBudget || w.values > l.ValueBudget || w.spent <= 0 {
				t.Errorf("%s: body %d of %d, values %d of %d", b.name, w.spent, l.BodyBudget, w.values, l.ValueBudget)
			}
		}
		_, _, w := limitsFail(t)
		if w.spent != l.BodyBudget-l.StreamReserve {
			t.Errorf("limits-fail: used %d, want the budget less the stream reserve %d", w.spent, l.BodyBudget-l.StreamReserve)
		}
		_, _, w = budgetOver(t)
		if w.spent <= l.BodyBudget {
			t.Errorf("budget-over: used %d, must exceed %d by design", w.spent, l.BodyBudget)
		}
	})
}
