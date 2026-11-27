package prom

import (
	"slices"
	"strings"
	"testing"
)

// Issue #291: $__range, $__range_s and $__range_ms. The planned texts of the three forms, the
// rounding rule and the no-window refusal are fixture cases (RG1–RG10, unit:plan-parity); these
// cover what the fixture cannot state.

// noWindowFields is the refusal of a range macro in a request without a window.
var noWindowFields = []FieldError{{Pointer: "/query", MessageKey: "query.no_window"}}

// Prepare substitutes the range macros as placeholders ("1s", "1", "1"), as it does the step
// macros; Plan writes them from the window.
func TestRangeMacrosPrepareThenPlan(t *testing.T) {
	in := Inputs{Query: "count_over_time(x[$__range]) + $__range_s + ${__range_ms}", Kind: KindRange, StepMs: 60_000, Rate: true, RangeMs: 21_600_000}
	p, err := Prepare(in)
	if err != nil {
		t.Fatalf("Prepare: %+v", err)
	}
	if got, want := p.Substituted(), "count_over_time(x[1s]) + 1 + 1"; got != want {
		t.Errorf("Substituted %q, want %q", got, want)
	}
	got, err := p.Plan(60_000, MetricTypes{})
	if err != nil {
		t.Fatalf("Plan: %+v", err)
	}
	if want := "count_over_time(x[6h]) + 21600 + 21600000"; got.Query != want || got.Expanded != want {
		t.Errorf("Plan %q / %q, want %q", got.Query, got.Expanded, want)
	}
	// The window does not depend on the step: another step gives the same range text.
	if g2, _ := p.Plan(300_000, MetricTypes{}); g2.Query != got.Query {
		t.Errorf("Plan at 300 s %q, want %q", g2.Query, got.Query)
	}
}

// An instant query gets the range macros when its caller has a window (the evaluator), and they
// need no step: only the step macros need step_ms.
func TestRangeMacrosInstantWithWindow(t *testing.T) {
	got, err := Plan(Inputs{Query: "sum(increase(x_total[$__range]))", Kind: KindInstant, Rate: true, RangeMs: 3_600_000}, MetricTypes{})
	if err != nil {
		t.Fatalf("Plan: %+v", err)
	}
	if want := "sum(increase(x_total[1h]))"; got.Query != want || got.StepMs != 0 {
		t.Errorf("Plan %q step %d, want %q step 0", got.Query, got.StepMs, want)
	}
}

// The refusal order: a missing variable, then step_ms for a step macro, then the window.
func TestRangeMacrosRefusalOrder(t *testing.T) {
	cases := []struct {
		name, query string
		step        int64
		want        []FieldError
	}{
		{"missing first", "x[$__range] + $a", 60_000, []FieldError{{Pointer: "/vars/a", MessageKey: "variable.missing"}}},
		{"step_ms before the window", "x[$__interval] + x[$__range]", 0, []FieldError{{Pointer: "/step_ms", MessageKey: "field.required"}}},
		{"the window", "x[$__interval] + x[$__range_ms]", 60_000, noWindowFields},
	}
	for _, c := range cases {
		_, err := Prepare(Inputs{Query: c.query, Kind: KindInstant, StepMs: c.step, Rate: true})
		if err == nil || err.Kind != ErrInput && err.Kind != ErrVariableMissing || !slices.Equal(err.Fields, c.want) {
			t.Errorf("%s: %+v, want %+v", c.name, err, c.want)
		}
	}
	// A negative window is no window.
	if _, err := Prepare(Inputs{Query: "vector($__range_s)", Kind: KindRange, StepMs: 60_000, RangeMs: -1}); err == nil || !slices.Equal(err.Fields, noWindowFields) {
		t.Errorf("negative window: %+v", err)
	}
}

// The planned-text limit counts the range macros at the window: a text under the limit with
// the placeholders goes over it with 12-digit milliseconds, and the refusal carries the plan.
func TestRangeMacrosSentLimit(t *testing.T) {
	q := "vector(1) # " + strings.Repeat("$__range_ms", 5_500)
	in := Inputs{Query: q, Kind: KindRange, StepMs: 60_000, Rate: true, RangeMs: 100_000_000_000}
	if len(q) > MaxSentBytes {
		t.Fatalf("raw text %d bytes is already over the limit", len(q))
	}
	p, err := Prepare(in)
	if err != nil {
		t.Fatalf("Prepare: %+v", err)
	}
	if pe := p.CheckCap(60_000); pe != nil {
		t.Fatalf("CheckCap: %+v", pe)
	}
	_, err = p.Plan(60_000, MetricTypes{})
	if err == nil || err.Kind != ErrSentTooLarge || err.Planned == nil || err.Planned.Bytes != 12+5_500*12 {
		t.Fatalf("Plan: %+v, want ErrSentTooLarge with %d planned bytes", err, 12+5_500*12)
	}
}
