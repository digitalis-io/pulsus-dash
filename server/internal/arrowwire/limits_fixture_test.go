package arrowwire

import (
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// The limits fixtures of plan #68 B3 §5, written with wire/schemas/limits-test.json. Its
// distinct_parts (8) allows at most four part pairs per body, so the at/beyond cases are spread
// over bodies of at most eight part ids.
func init() {
	for _, f := range []struct {
		name  string
		build func(*testing.T) ([]byte, expectBody, *Writer)
	}{
		{"limits-budget", limitsBudget}, {"limits-value", limitsValue}, {"limits-open-parts", limitsOpenParts},
		{"limits-distinct-parts", limitsDistinctParts}, {"limits-series", limitsSeries}, {"limits-rows", limitsRows},
		{"limits-strings", limitsStrings}, {"limits-errors", limitsErrors}, {"limits-fail", limitsFail},
		{"limits-refused", limitsRefused}, {"budget-over", budgetOver},
	} {
		build := f.build
		fixtures = append(fixtures, struct {
			name  string
			build func(t *testing.T) ([]byte, expectBody)
		}{f.name, func(t *testing.T) ([]byte, expectBody) {
			b, e, _ := build(t)
			return b, e
		}})
	}
}

func wantLimit(t *testing.T, what string, err error) {
	t.Helper()
	if !errors.Is(err, ErrLimit) {
		t.Fatalf("%s: %v, want ErrLimit", what, err)
	}
}

// padSpec is gridSpecN with a dash.planned object of pad filler bytes (to place a budget
// boundary within four part pairs).
func padSpec(l, d uint32, n, pad int) GridSpec {
	s := gridSpecN(l, d, n)
	s.Planned = []byte(`{"pad":"` + strings.Repeat("p", pad) + `"}`)
	return s
}

// gridCharge is the body budget a Grid charges (§3.1 accounting): two parts, both schemas and
// the planned coverage.
func gridCharge(s GridSpec, n int, planned Coverage) int {
	return 2*costPart + schemaCost(labels1) + schemaCost(gridSchema(s, n)) + coverageCost(planned)
}

// heavySeries is a 50-row series of 4 050 label bytes (within limits-test.json's per-part limits).
func heavySeries(i int) *pulsusdb.Series {
	kv := []string{}
	for k := 0; k < 50; k++ {
		kv = append(kv, "l"+strconv.Itoa(10+k), strings.Repeat("v", 78))
	}
	return seriesKV(i, 4, kv...)
}

// budgetInput derives limits-budget's padding: four one-series part pairs whose fourth Grid is
// admitted and whose fourth series is the first one past body_budget. n is derived with the
// writer's accounting: the largest series count k for which used(k) + reserves ≤ budget, where
// used(k) = (k−1)·T + G + S (T one whole part pair, G its Grid, S its series and batch).
func budgetInput(t *testing.T, l Limits) (pad int) {
	t.Helper()
	reserves := l.PartReserve + l.StreamReserve
	cost := func(pad int) (g, s, f int) {
		return gridCharge(padSpec(1, 2, 4, pad), 4, planned0()), labelSetCost(heavySeries(0)) + batchCost(1), coverageCost(final0(1))
	}
	// G grows by one byte per padding byte: solve 3·T + G + reserves ≤ budget for the largest pad,
	// then check it (and pad + 1) with the accounting itself.
	g0, s0, f0 := cost(0)
	pad = (l.BodyBudget - reserves - 3*(s0+f0) - 4*g0) / 4
	if g, s, f := cost(pad); pad < 0 || 3*(g+s+f)+g+reserves > l.BodyBudget {
		t.Fatalf("padding %d does not fit", pad)
	}
	if g, s, f := cost(pad + 1); 3*(g+s+f)+g+reserves <= l.BodyBudget {
		t.Fatalf("padding %d is not the largest", pad)
	}
	g, s, f := cost(pad)
	used := func(k int) int { return (k-1)*(g+s+f) + g + s }
	n := 0
	for used(n+1)+reserves <= l.BodyBudget && n < 100 {
		n++
	}
	if atN, beyond := used(n)+reserves <= l.BodyBudget, l.BodyBudget < used(n+1)+reserves; n != 3 || !atN || !beyond || n*(g+s+f)+g+reserves > l.BodyBudget {
		t.Fatalf("derived n = %d: used(n) %d, used(n+1) %d, reserves %d, budget %d", n, used(n), used(n+1), reserves, l.BodyBudget)
	}
	if 4*(g+s+f) <= l.BodyBudget {
		t.Fatalf("budget-over would fit the budget: %d", 4*(g+s+f))
	}
	return pad
}

func budgetBody(t *testing.T, over bool) ([]byte, expectBody, *Writer) {
	l := testLimits(t)
	pad := budgetInput(t, l)
	buf, w := limitWriter(t)
	w.noBudget = over
	exp := expectBody{Parts: []expectPart{}, Errors: []expectError{}}
	for i := 0; i < 4; i++ {
		spec := padSpec(uint32(2*i+1), uint32(2*i+2), 4, pad) // #nosec G115 -- i < 4
		p, err := w.Grid(spec, planned0())
		mustOK(t, err)
		s := heavySeries(i)
		if i < 3 || over {
			mustOK(t, p.Add(s))
			mustOK(t, p.Finish(final0(1)))
			exp.Parts = append(exp.Parts, expectPartFor(spec, []*pulsusdb.Series{s}, []Coverage{planned0(), final0(1)}, nil))
			continue
		}
		wantLimit(t, "the series past the budget", p.Add(s))
		wantLimit(t, "Finish after the auto-close", p.Finish(final0(1)))
		exp.Parts = append(exp.Parts, expectPartFor(spec, nil, []Coverage{planned0(), autoClosed(planned0(), 0, reasonWireBudget)}, nil))
	}
	mustOK(t, w.End())
	return buf.Bytes(), exp, w
}

// limitsBudget: three part pairs at the body budget, the fourth series beyond it (wire_budget).
func limitsBudget(t *testing.T) ([]byte, expectBody, *Writer) { return budgetBody(t, false) }

// budgetOver: limits-budget's input with the writer's budget checks off; the reader must fail it.
func budgetOver(t *testing.T) ([]byte, expectBody, *Writer) { return budgetBody(t, true) }

// limitsValue: one-series grids of a derived length; n = ⌊value_budget / cost⌋ = 3 series fit,
// the fourth auto-closes its part with wire_budget.
func limitsValue(t *testing.T) ([]byte, expectBody, *Writer) {
	l := testLimits(t)
	n := 1
	for 4*valueCost(1, n) <= l.ValueBudget {
		if n++; n > l.MaxGridLen {
			t.Fatal("no grid length found")
		}
	}
	k := l.ValueBudget / valueCost(1, n)
	if k != 3 || k*valueCost(1, n) > l.ValueBudget || (k+1)*valueCost(1, n) <= l.ValueBudget {
		t.Fatalf("derived %d series of %d points (cost %d)", k, n, valueCost(1, n))
	}
	buf, w := limitWriter(t)
	exp := expectBody{Parts: []expectPart{}, Errors: []expectError{}}
	for i := 0; i <= k; i++ {
		spec := gridSpecN(uint32(2*i+1), uint32(2*i+2), n) // #nosec G115 -- i ≤ 3
		p, err := w.Grid(spec, planned0())
		mustOK(t, err)
		s := rampSeries(i, n)
		if i < k {
			mustOK(t, p.Add(s))
			mustOK(t, p.Finish(final0(1)))
			exp.Parts = append(exp.Parts, expectPartFor(spec, []*pulsusdb.Series{s}, []Coverage{planned0(), final0(1)}, nil))
			continue
		}
		wantLimit(t, "the series past value_budget", p.Add(s))
		exp.Parts = append(exp.Parts, expectPartFor(spec, nil, []Coverage{planned0(), autoClosed(planned0(), 0, reasonWireBudget)}, nil))
	}
	mustOK(t, w.End())
	return buf.Bytes(), exp, w
}

// limitsOpenParts: 1/2 and 3/4 open (= open_parts), Grid(5, 6) refused; 1–4 close normally.
func limitsOpenParts(t *testing.T) ([]byte, expectBody, *Writer) {
	buf, w := limitWriter(t)
	var ps []*GridPart
	var exp expectBody
	for i := 0; i < 2; i++ {
		spec := gridSpecN(uint32(2*i+1), uint32(2*i+2), 4) // #nosec G115 -- i < 2
		p, err := w.Grid(spec, planned0())
		mustOK(t, err)
		s := rampSeries(i, 4)
		mustOK(t, p.Add(s))
		ps = append(ps, p)
		exp.Parts = append(exp.Parts, expectPartFor(spec, []*pulsusdb.Series{s}, []Coverage{planned0(), final0(1)}, nil))
	}
	_, err := w.Grid(gridSpecN(5, 6, 4), planned0())
	wantLimit(t, "Grid(5, 6) past open_parts", err)
	for _, p := range ps {
		mustOK(t, p.Finish(final0(1)))
	}
	mustOK(t, w.End())
	exp.Errors = []expectError{refusedJSON()}
	return buf.Bytes(), exp, w
}

// limitsDistinctParts: four part pairs opened and finished in turn (8 ids), Grid(9, 10) refused.
func limitsDistinctParts(t *testing.T) ([]byte, expectBody, *Writer) {
	buf, w := limitWriter(t)
	var exp expectBody
	for i := 0; i < 4; i++ {
		spec := gridSpecN(uint32(2*i+1), uint32(2*i+2), 4) // #nosec G115 -- i < 4
		p, err := w.Grid(spec, planned0())
		mustOK(t, err)
		s := rampSeries(i, 4)
		mustOK(t, p.Add(s))
		mustOK(t, p.Finish(final0(1)))
		exp.Parts = append(exp.Parts, expectPartFor(spec, []*pulsusdb.Series{s}, []Coverage{planned0(), final0(1)}, nil))
	}
	_, err := w.Grid(gridSpecN(9, 10, 4), planned0())
	wantLimit(t, "Grid(9, 10) past distinct_parts", err)
	mustOK(t, w.End())
	exp.Errors = []expectError{refusedJSON()}
	return buf.Bytes(), exp, w
}

// limitsRefused: 1/2 complete, Writer.Error(3), 4/5 and 6/7 complete (7 ids), then Grid(8, 9)
// needs two ids with one left.
func limitsRefused(t *testing.T) ([]byte, expectBody, *Writer) {
	buf, w := limitWriter(t)
	var exp expectBody
	e3 := ErrorRow{Code: 5, HTTPStatus: 504, Message: "timeout", RetryAfterMs: ptr(uint32(1000))}
	for _, ids := range [][2]uint32{{1, 2}, {4, 5}, {6, 7}} {
		spec := gridSpecN(ids[0], ids[1], 4)
		p, err := w.Grid(spec, planned0())
		mustOK(t, err)
		s := rampSeries(int(ids[0]), 4)
		mustOK(t, p.Add(s))
		mustOK(t, p.Finish(final0(1)))
		exp.Parts = append(exp.Parts, expectPartFor(spec, []*pulsusdb.Series{s}, []Coverage{planned0(), final0(1)}, nil))
		if ids[0] == 1 {
			mustOK(t, w.Error(3, 0, e3))
		}
	}
	_, err := w.Grid(gridSpecN(8, 9, 4), planned0())
	wantLimit(t, "Grid(8, 9) past distinct_parts", err)
	mustOK(t, w.End())
	exp.Errors = []expectError{refusedJSON(), {Part: 3, Error: toErrorJSON(e3)}}
	return buf.Bytes(), exp, w
}

// limitsSeries: 1/2 at every per-part limit (100 series, 300 label rows, 4 096 label bytes, one
// 50-row series, a 25 + 25 + 1-row batch); 3/4 101 series; 5/6 301 rows; 7/8 4 097 bytes.
func limitsSeries(t *testing.T) ([]byte, expectBody, *Writer) {
	buf, w := limitWriter(t)
	var exp expectBody

	// 1/2: at.
	spec := gridSpecN(1, 2, 4)
	p, err := w.Grid(spec, planned0())
	mustOK(t, err)
	at := []*pulsusdb.Series{rowsSeries(0, 4, 50, "a"), rowsSeries(1, 4, 25, "b"), rowsSeries(2, 4, 25, "c"), seriesKV(3, 4, "d", "")}
	for j := 0; j < 95; j++ {
		at = append(at, seriesKV(4+j, 4, "i", strconv.Itoa(j), "j", "x"))
	}
	bytes := 0
	for _, s := range at {
		for _, lb := range s.Labels {
			bytes += len(lb.Name) + len(lb.Value)
		}
	}
	kv := []string{}
	for k := 0; k < 9; k++ {
		kv = append(kv, "k"+strconv.Itoa(k), "")
	}
	kv[17] = strings.Repeat("v", 4096-bytes-18)
	at = append(at, seriesKV(99, 4, kv...))
	for i, s := range at {
		mustOK(t, p.Add(s))
		if i == 3 {
			mustOK(t, p.Flush())
		}
	}
	mustOK(t, p.Finish(final0(100)))
	exp.Parts = append(exp.Parts, expectPartFor(spec, at, []Coverage{planned0(), final0(100)}, nil))

	// beyond closes the part at Finish with wire_limit; sent are the series flushed before.
	beyond := func(l, d uint32, series []*pulsusdb.Series, sent int) {
		spec := gridSpecN(l, d, 4)
		p, err := w.Grid(spec, planned0())
		mustOK(t, err)
		for _, s := range series {
			mustOK(t, p.Add(s))
		}
		wantLimit(t, "Finish past a per-part limit", p.Finish(final0(len(series))))
		exp.Parts = append(exp.Parts, expectPartFor(spec, series[:sent], []Coverage{planned0(), autoClosed(final0(len(series)), sent, reasonWireLimit)}, nil))
	}
	var s101 []*pulsusdb.Series
	for i := 0; i < 101; i++ {
		s101 = append(s101, seriesKV(i, 4, "i", strconv.Itoa(i)))
	}
	beyond(3, 4, s101, 65)
	var r301 []*pulsusdb.Series
	for i := 0; i < 6; i++ {
		r301 = append(r301, rowsSeries(i, 4, 50, "a"))
	}
	beyond(5, 6, append(r301, seriesKV(6, 4, "z", "")), 1)
	beyond(7, 8, []*pulsusdb.Series{seriesKV(0, 4, "k", strings.Repeat("v", 2047)), seriesKV(1, 4, "k", strings.Repeat("v", 2048))}, 1)
	mustOK(t, w.End())
	exp.Errors = []expectError{}
	return buf.Bytes(), exp, w
}

// limitsRows: a single series of 51 label rows (above rows_per_batch): Add refuses it, nothing of
// it is written, and the part auto-closes with wire_limit.
func limitsRows(t *testing.T) ([]byte, expectBody, *Writer) {
	buf, w := limitWriter(t)
	spec := gridSpecN(1, 2, 4)
	p, err := w.Grid(spec, planned0())
	mustOK(t, err)
	wantLimit(t, "a 51-row series", p.Add(rowsSeries(0, 4, 51, "a")))
	wantLimit(t, "Finish after the auto-close", p.Finish(final0(1)))
	mustOK(t, w.End())
	return buf.Bytes(), expectBody{Parts: []expectPart{expectPartFor(spec, nil, []Coverage{planned0(), autoClosed(planned0(), 0, reasonWireLimit)}, nil)},
		Errors: []expectError{}}, w
}

// limitsStrings: the coverage cut policy (meta_string_bytes 1 024, meta_list_elements 16).
// 1/2: planned with 20 warnings (cut), then a clean final (sticky: truncated, coverage_cut).
// 3/4: planned with 1 025 B (cut to 998 B + marker), final with 1 025 B cut inside "é".
// 5/6: final with exactly 1 024 B of "é" (unchanged). 7/8: planned with a 100-B reason (cut to
// 50 B + marker, truncated), final with 20 excluded_dims (16 kept).
func limitsStrings(t *testing.T) ([]byte, expectBody, *Writer) {
	buf, w := limitWriter(t)
	var exp expectBody
	list := func(p string, n int) []string {
		out := []string{}
		for i := 0; i < n; i++ {
			out = append(out, p+strconv.Itoa(10+i))
		}
		return out
	}
	cutCov := func(c Coverage) Coverage {
		c.Truncated, c.TruncationReason = true, ptr(reasonCoverageCut)
		return c
	}
	pair := func(l, d uint32, planned, final, wantPlanned, wantFinal Coverage) {
		spec := gridSpecN(l, d, 4)
		p, err := w.Grid(spec, planned)
		mustOK(t, err)
		mustOK(t, p.Finish(final))
		wantPlanned.Phase = PhasePlanned
		exp.Parts = append(exp.Parts, expectPartFor(spec, nil, []Coverage{wantPlanned, wantFinal}, nil))
	}

	p1 := planned0()
	p1.Warnings = list("w", 20)
	w1 := cutCov(planned0())
	w1.Warnings = list("w", 16)
	pair(1, 2, p1, final0(0), w1, cutCov(final0(0)))

	p2 := planned0()
	p2.Warnings = []string{strings.Repeat("a", 1025)}
	w2 := cutCov(planned0())
	w2.Warnings = []string{strings.Repeat("a", 998) + cutMarker}
	f2 := final0(0)
	f2.Infos = []string{strings.Repeat("x", 997) + "é" + strings.Repeat("y", 26)}
	wf2 := cutCov(final0(0))
	wf2.Infos = []string{strings.Repeat("x", 997) + cutMarker}
	pair(3, 4, p2, f2, w2, wf2)

	f3 := final0(0)
	f3.Infos = []string{strings.Repeat("é", 512)}
	pair(5, 6, planned0(), f3, planned0(), f3)

	p4 := planned0()
	p4.TruncationReason = ptr(strings.Repeat("r", 100))
	w4 := planned0()
	w4.Truncated, w4.TruncationReason = true, ptr(strings.Repeat("r", 50)+cutMarker)
	f4 := final0(0)
	f4.ExcludedDims = list("d", 20)
	wf4 := cutCov(final0(0))
	wf4.ExcludedDims = list("d", 16)
	pair(7, 8, p4, f4, w4, wf4)

	mustOK(t, w.End())
	exp.Errors = []expectError{}
	return buf.Bytes(), exp, w
}

// limitsErrors: Writer.Error with a 1 024-B message (unchanged) and with 1 100 B + a 300-B
// suggestion (cut to 768 B and 256 B, each ending with the marker).
func limitsErrors(t *testing.T) ([]byte, expectBody, *Writer) {
	buf, w := limitWriter(t)
	e1 := ErrorRow{Code: 0, HTTPStatus: 400, Message: strings.Repeat("m", 1024)}
	e2 := ErrorRow{Code: 1, HTTPStatus: 422, Message: strings.Repeat("m", 1100), Suggestion: ptr(strings.Repeat("s", 300))}
	mustOK(t, w.Error(1, 0, e1))
	mustOK(t, w.Error(2, 0, e2))
	mustOK(t, w.End())
	cut := e2
	cut.Message, cut.Suggestion = strings.Repeat("m", 754)+cutMarker, ptr(strings.Repeat("s", 242)+cutMarker)
	return buf.Bytes(), expectBody{Parts: []expectPart{}, Errors: []expectError{{Part: 1, Error: toErrorJSON(e1)}, {Part: 2, Error: toErrorJSON(cut)}}}, w
}

// limitsFail: one part pair whose Grid and series leave exactly its part_reserve (and the stream
// reserve) of body_budget, then Fail with a maximal partial coverage and error: the body ends at
// body_budget − stream_reserve.
func limitsFail(t *testing.T) ([]byte, expectBody, *Writer) {
	l := testLimits(t)
	s := seriesKV(0, 4, "v", strings.Repeat("v", 1000))
	fill := l.BodyBudget - l.PartReserve - l.StreamReserve - labelSetCost(s) - batchCost(1)
	pad := fill - gridCharge(padSpec(1, 2, 4, 0), 4, planned0())
	spec := padSpec(1, 2, 4, pad)
	if pad < 0 || gridCharge(spec, 4, planned0()) != fill {
		t.Fatalf("padding %d: grid charge %d, want %d", pad, gridCharge(spec, 4, planned0()), fill)
	}
	partial := CoverageFrom(emptyComp(), PhasePartial, 1)
	for i := 0; i < l.MetaListElements; i++ {
		partial.Warnings = append(partial.Warnings, strings.Repeat(string(rune('a'+i)), l.MetaStringBytes/l.MetaListElements))
	}
	e := ErrorRow{Code: 4, HTTPStatus: 502, Message: strings.Repeat("e", l.MetaStringBytes)}
	if coverageCost(partial)+errorCost(e) != l.PartReserve {
		t.Fatalf("Fail charges %d, part_reserve %d", coverageCost(partial)+errorCost(e), l.PartReserve)
	}
	buf, w := limitWriter(t)
	p, err := w.Grid(spec, planned0())
	mustOK(t, err)
	mustOK(t, p.Add(s))
	if w.spent+l.PartReserve+l.StreamReserve != l.BodyBudget {
		t.Fatalf("after the series: used %d + reserves %d ≠ budget %d", w.spent, l.PartReserve+l.StreamReserve, l.BodyBudget)
	}
	mustOK(t, p.Fail(partial, e))
	mustOK(t, w.End())
	return buf.Bytes(), expectBody{Parts: []expectPart{expectPartFor(spec, []*pulsusdb.Series{s}, []Coverage{planned0(), partial}, &e)},
		Errors: []expectError{}}, w
}
