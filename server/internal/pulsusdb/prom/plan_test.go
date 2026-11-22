package prom

import (
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

func fields(fs []fxField) []FieldError {
	out := make([]FieldError, 0, len(fs))
	for _, f := range fs {
		out = append(out, FieldError(f))
	}
	return out
}

// checkResult compares one Plan result with the case's planned or error member, and its
// to_source pairs.
func checkResult(t *testing.T, c fxCase, got Planned, err *PlanError) {
	t.Helper()
	var p *Planned
	switch {
	case c.Planned != nil:
		if err != nil {
			t.Fatalf("Plan: %v (%+v), want a plan", err, err.Fields)
		}
		if w := c.Planned.wire(); got.Wire() != w {
			t.Errorf("Wire\n got %.300v\nwant %.300v", got.Wire(), w)
		}
		p = &got
	case c.Error != nil:
		if err == nil {
			t.Fatalf("Plan gave %.200v, want error %q", got.Wire(), c.Error.Message)
		}
		if err.Status() != c.Error.Status || err.Message != c.Error.Message || !slices.Equal(err.Fields, fields(c.Error.Fields)) {
			t.Errorf("error %d %q %+v, want %d %q %+v", err.Status(), err.Message, err.Fields, c.Error.Status, c.Error.Message, c.Error.Fields)
		}
		if c.Error.Hint != nil && (c.Error.Hint.Reason != "processing_cap" || err.Kind != ErrProcessingCap) {
			t.Errorf("hint %+v with kind %d", c.Error.Hint, err.Kind)
		}
		switch {
		case c.Error.Planned == nil && err.Planned != nil:
			t.Errorf("error carries a plan %.200v, want none", err.Planned.Wire())
		case c.Error.Planned != nil && err.Planned == nil:
			t.Errorf("error carries no plan")
		case c.Error.Planned != nil:
			if w := c.Error.Planned.wire(); err.Planned.Wire() != w {
				t.Errorf("error plan\n got %.300v\nwant %.300v", err.Planned.Wire(), w)
			}
			p = err.Planned
		}
	default:
		t.Fatal("case has neither planned nor error")
	}
	for _, pair := range c.ToSource {
		if p == nil || pair[0] == nil {
			t.Fatalf("to_source %v without a plan", pair)
		}
		raw, ok := p.ToSource(*pair[0])
		switch {
		case pair[1] == nil && ok:
			t.Errorf("ToSource(%d) = %d, want none", *pair[0], raw)
		case pair[1] != nil && (!ok || raw != *pair[1]):
			t.Errorf("ToSource(%d) = %d, %v; want %d", *pair[0], raw, ok, *pair[1])
		}
	}
}

// unit:plan-parity (Go): every plan case of the shared fixture (plan #112 §5.1).
func TestPlanParity(t *testing.T) {
	f := loadFixture(t)
	groups := map[string]map[string]bool{}
	names := map[string]bool{}
	for _, c := range f.Plan {
		if names[c.Name] {
			t.Errorf("duplicate case name %q", c.Name)
		}
		names[c.Name] = true
		t.Run(c.Name, func(t *testing.T) {
			in := c.inputs()
			got, err := Plan(in, MetricTypes(c.Types))
			checkResult(t, c, got, err)
			p, perr := Prepare(in)
			if c.NeedsTypes == nil {
				if perr == nil {
					t.Errorf("Prepare passed; the case has no needs_types, so it must be refused before types")
				}
				return
			}
			if perr != nil {
				t.Fatalf("Prepare: %v", perr)
			}
			if p.NeedsTypes() != *c.NeedsTypes {
				t.Errorf("NeedsTypes %v, want %v", p.NeedsTypes(), *c.NeedsTypes)
			}
			if !*c.NeedsTypes {
				g0, e0 := Plan(in, MetricTypes{})
				if !reflect.DeepEqual(g0.Wire(), got.Wire()) || (e0 == nil) != (err == nil) ||
					(e0 != nil && (e0.Message != err.Message || !reflect.DeepEqual(e0.Planned, err.Planned))) {
					t.Errorf("NeedsTypes false, but the plan without types differs")
				}
			}
		})
		if c.Group != "" {
			if groups[c.Group] == nil {
				groups[c.Group] = map[string]bool{}
			}
			if c.Planned != nil {
				groups[c.Group][string(c.Planned.Query)] = true
			}
		}
	}
	for g, qs := range groups {
		if len(qs) != 1 {
			t.Errorf("group %s has %d planned queries, want 1", g, len(qs))
		}
	}
}

// unit:plan-parity (Go): the fixture's tables.
func TestPlanTables(t *testing.T) {
	f := loadFixture(t)
	for _, k := range f.KindOf {
		if got := KindOf(k.Name, k.Types); got != k.Want {
			t.Errorf("KindOf(%q, %v) = %q, want %q", k.Name, k.Types, got, k.Want)
		}
	}
	for i, m := range f.FromMetadata {
		in := map[string][]pulsusdb.MetricMetadata{}
		for name, list := range m.Metadata {
			out := []pulsusdb.MetricMetadata{}
			for _, e := range list {
				out = append(out, pulsusdb.MetricMetadata{Type: e.Type, Help: e.Help, Unit: e.Unit})
			}
			in[name] = out
		}
		got := TypesFromMetadata(in)
		if got == nil || !reflect.DeepEqual(got, m.Types) {
			t.Errorf("from_metadata %d: %v, want %v", i, got, m.Types)
		}
	}
	for _, r := range f.RateWindow {
		if w := RateWindowMs(r.StepMs); w != r.WindowMs || FormatDuration(w) != r.Text {
			t.Errorf("RateWindowMs(%d) = %d %q, want %d %q", r.StepMs, w, FormatDuration(w), r.WindowMs, r.Text)
		}
	}
	for _, d := range f.Durations {
		if got := FormatDuration(d.Ms); got != d.Text {
			t.Errorf("FormatDuration(%d) = %q, want %q", d.Ms, got, d.Text)
		}
	}
	for _, b := range f.Bytes {
		if len(b.Text) != b.Bytes {
			t.Errorf("len(%.20q) = %d, want %d", b.Text, len(b.Text), b.Bytes)
		}
	}
}

// Review r1 (#118): repeated references to one quoted value over the processing cap are counted
// once per value and quote state, so the refusal is cheap. 65 000 references to a 4 096-byte LF
// value inside "…" would be 532 480 000 encoded bytes.
func TestPlanCapRepeatedQuotedValue(t *testing.T) {
	in := Inputs{Query: `x{a="` + strings.Repeat("$a", 65_000) + `"}`, Vars: map[string]string{"a": strings.Repeat("\n", 4096)},
		Kind: KindRange, StepMs: 5000, Rate: true}
	t0 := time.Now()
	_, err := Prepare(in)
	d := time.Since(t0)
	if err == nil || err.Kind != ErrProcessingCap {
		t.Fatalf("Prepare: %+v, want the processing cap", err)
	}
	if d > 200*time.Millisecond {
		t.Errorf("Prepare took %v, want under 200ms", d)
	}
	// The refusal order is unchanged: a missing variable, then a value that cannot be written,
	// then the cap.
	in.Query = "x{a=`$a`}" + strings.Repeat(`{a="$a"}`, 1000) + " $m"
	in.Vars = map[string]string{"a": strings.Repeat("`", 4096)}
	if _, err := Prepare(in); err == nil || err.Kind != ErrVariableMissing {
		t.Errorf("missing first: %+v", err)
	}
	in.Query = "x{a=`$a`}" + strings.Repeat(`{a="$a"}`, 1000)
	if _, err := Prepare(in); err == nil || err.Kind != ErrInput || err.Fields[0].MessageKey != "variable.unrepresentable" {
		t.Errorf("unrepresentable before the cap: %+v", err)
	}
}

// §3.1 rows 1 and 5: bytes that are not UTF-8 (JSON cannot carry them, so they are not in the
// fixture).
func TestPlanInvalidUTF8(t *testing.T) {
	_, err := Plan(Inputs{Query: "a\xffb", Kind: KindRange, StepMs: 5000, Rate: true}, nil)
	if err == nil || err.Kind != ErrInput || err.Message != "query must be UTF-8" ||
		!slices.Equal(err.Fields, []FieldError{{"/query", "field.range"}}) {
		t.Errorf("query: %+v", err)
	}
	_, err = Plan(Inputs{Query: "up", Vars: map[string]string{"r": "\xff"}, Kind: KindRange, StepMs: 5000, Rate: true}, nil)
	if err == nil || err.Kind != ErrInput || err.Message != "a variable value must be UTF-8 and at most 4096 bytes" ||
		!slices.Equal(err.Fields, []FieldError{{"/vars/r", "field.range"}}) {
		t.Errorf("value: %+v", err)
	}
}

// unit:plan-classify (T07 §4.1 step 1a, §4.3, §4.8 order): Classify of every case that passes
// Prepare, and the resolve rows of the classify group.
func TestClassify(t *testing.T) {
	f := loadFixture(t)
	n := 0
	for _, c := range f.Plan {
		p, perr := Prepare(c.inputs())
		if perr != nil {
			if c.NeedsTypes != nil {
				t.Errorf("%s: Prepare: %v", c.Name, perr)
			}
			continue
		}
		want := Class{Source: SourcePulsusDB, Reserved: []string{}}
		if c.Classify != nil {
			want = Class{Source: Source(c.Classify.Source), Reserved: c.Classify.Reserved, FloorMs: c.Classify.FloorMs}
		}
		got := p.Class()
		if got.Source != want.Source || got.FloorMs != want.FloorMs || !slices.Equal(got.Reserved, want.Reserved) {
			t.Errorf("%s: Class %+v, want %+v", c.Name, got, want)
		}
		if c.Resolve != nil {
			n++
			step := FloorStep(c.Resolve.GridStepMs, got.FloorMs)
			if step != c.Resolve.StepMs || step != c.Inputs.StepMs {
				t.Errorf("%s: FloorStep(%d, %d) = %d, want %d (inputs %d)", c.Name, c.Resolve.GridStepMs, got.FloorMs, step, c.Resolve.StepMs, c.Inputs.StepMs)
			}
			pl, err := p.Plan(c.Resolve.StepMs, MetricTypes(c.Types))
			if err != nil || c.Planned == nil || pl.Wire() != c.Planned.wire() {
				t.Errorf("%s: Plan(%d) = %.200v, %v", c.Name, c.Resolve.StepMs, pl.Wire(), err)
			}
		}
	}
	if n < 4 {
		t.Errorf("%d resolve rows, want the classify group", n)
	}
	for _, c := range []struct{ step, floor, want int64 }{{5000, 0, 5000}, {5000, 300000, 300000}, {300001, 300000, 600000}, {15000, 15000, 15000}, {0, 15000, 0}} {
		if got := FloorStep(c.step, c.floor); got != c.want {
			t.Errorf("FloorStep(%d, %d) = %d, want %d", c.step, c.floor, got, c.want)
		}
	}
}

// The fixture's reserved section against the server's byte guard (plan #112 A.11).
func TestReservedFixture(t *testing.T) {
	f := loadFixture(t)
	if len(f.Reserved) == 0 {
		t.Fatal("no reserved rows")
	}
	for _, r := range f.Reserved {
		e := pulsusdb.CheckReserved("query", string(r.Text))
		switch {
		case r.Want == nil && e != nil:
			t.Errorf("%q: refused %q, want nil", r.Text, e.Reserved)
		case r.Want != nil && (e == nil || e.Reserved != *r.Want):
			t.Errorf("%q: %v, want %q", r.Text, e, *r.Want)
		}
	}
}
