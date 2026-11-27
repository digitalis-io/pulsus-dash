package logs

import (
	"slices"
	"testing"
)

// Issue #291: the range macros in LogQL. The planned texts are fixture cases (RG1–RG6,
// unit:plan-parity); these cover what the fixture cannot state.

// Prepare substitutes the range macros as placeholders; Plan writes them from the window, which
// does not depend on the step.
func TestRangeMacrosPrepareThenPlan(t *testing.T) {
	in := Inputs{Query: `sum(count_over_time({app="x"}[$__range])) > $__range_s`, Kind: KindRange, StepMs: 60_000, RangeMs: 5_400_000}
	p, err := Prepare(in)
	if err != nil {
		t.Fatalf("Prepare: %+v", err)
	}
	if got, want := p.Substituted(), `sum(count_over_time({app="x"}[1s])) > 1`; got != want {
		t.Errorf("Substituted %q, want %q", got, want)
	}
	for _, step := range []int64{60_000, 300_000} {
		got, err := p.Plan(step)
		if err != nil {
			t.Fatalf("Plan(%d): %+v", step, err)
		}
		if want := `sum(count_over_time({app="x"}[90m])) > 5400`; got.Query != want {
			t.Errorf("Plan(%d) %q, want %q", step, got.Query, want)
		}
	}
}

// A missing variable is refused before the missing window.
func TestRangeMacrosRefusalOrder(t *testing.T) {
	_, err := Prepare(Inputs{Query: `{app="$a"} |= "$__range"`, Kind: KindRange, StepMs: 60_000})
	if err == nil || !slices.Equal(err.Fields, []FieldError{{Pointer: "/vars/a", MessageKey: "variable.missing"}}) {
		t.Errorf("missing first: %+v", err)
	}
	_, err = Prepare(Inputs{Query: `{app="x"} |= "$__range"`, Kind: KindVolume, StepMs: 60_000, RangeMs: -5})
	if err == nil || !slices.Equal(err.Fields, []FieldError{{Pointer: "/query", MessageKey: "query.no_window"}}) {
		t.Errorf("negative window: %+v", err)
	}
}
