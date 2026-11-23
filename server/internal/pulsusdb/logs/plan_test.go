package logs

import (
	"reflect"
	"slices"
	"strconv"
	"testing"
)

func fields(fs []fxField) []FieldError {
	out := make([]FieldError, 0, len(fs))
	for _, f := range fs {
		out = append(out, FieldError(f))
	}
	return out
}

// checkError compares a refusal with the case's error member.
func checkError(t *testing.T, c fxCase, err *PlanError) {
	t.Helper()
	if c.Error == nil {
		t.Fatalf("refused: %v (%+v), want a plan", err, err.Fields)
	}
	if err.Status() != c.Error.Status || err.Message != c.Error.Message || !slices.Equal(err.Fields, fields(c.Error.Fields)) {
		t.Errorf("error %d %q %+v, want %d %q %+v", err.Status(), err.Message, err.Fields, c.Error.Status, c.Error.Message, c.Error.Fields)
	}
	switch {
	case c.Error.Position == nil && err.Position != nil:
		t.Errorf("position %d, want none", *err.Position)
	case c.Error.Position != nil && (err.Position == nil || *err.Position != *c.Error.Position):
		t.Errorf("position %v, want %d", err.Position, *c.Error.Position)
	}
	if (c.Error.Hint != nil) != (err.Kind == ErrProcessingCap) || (c.Error.Hint != nil && c.Error.Hint.Reason != "processing_cap") {
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
	}
}

// facts are the classification facts a parity entry compares (plan #116 §3.5).
func facts(c Class) fxFacts { return fxFacts{Class: string(c.Source), Reserved: c.Reserved} }

func checkSpans(t *testing.T, tag string, c Class, all []fxSpan) {
	t.Helper()
	var want []fxSpan
	for _, s := range all {
		if s.Text == tag {
			want = append(want, s)
		}
	}
	got := make([]fxSpan, 0, len(c.Selectors))
	for _, s := range c.Selectors {
		got = append(got, fxSpan{Text: tag, From: s.From, To: s.To, Reserved: s.Reserved})
	}
	if !slices.Equal(got, want) {
		t.Errorf("%s spans %v, want %v", tag, got, want)
	}
}

// unit:plan-parity (Go, logs): every plan case of the shared fixture, by its outcome (plan #116
// §3.5, §5.1).
func TestLogsPlanParity(t *testing.T) {
	f := loadFixture(t)
	names := map[string]bool{}
	for _, c := range f.Plan {
		if names[c.Name] {
			t.Errorf("duplicate case name %q", c.Name)
		}
		names[c.Name] = true
		t.Run(c.Name, func(t *testing.T) {
			in := c.inputs()
			p, perr := Prepare(in)
			if perr != nil {
				// A preparation failure: only its error.
				checkError(t, c, perr)
				if c.Substituted != nil || c.Want != nil || c.Planned != nil || len(c.ToSource) > 0 {
					t.Error("a preparation failure records only its error")
				}
				return
			}
			if c.Substituted == nil {
				t.Fatal("prepared, but the case records no substituted text")
			}
			if got := p.Substituted(); got != string(*c.Substituted) {
				t.Errorf("Substituted\n got %.300q\nwant %.300q", got, *c.Substituted)
			}
			got, err := p.Plan(in.StepMs)
			// Plan(in) is Prepare, then Plan at the grid step (Resolve is the identity).
			if g2, e2 := Plan(in); g2.Wire() != got.Wire() || (e2 == nil) != (err == nil) {
				t.Errorf("Plan(inputs) differs from Prepare then Plan")
			}
			var planned *Planned
			switch {
			case err != nil:
				checkError(t, c, err)
				planned = err.Planned
			case c.Planned == nil:
				t.Fatalf("Plan gave %.200v, want error %+v", got.Wire(), c.Error)
			default:
				if w := c.Planned.wire(); got.Wire() != w {
					t.Errorf("Wire\n got %.300v\nwant %.300v", got.Wire(), w)
				}
				planned = &got
			}
			for _, pair := range c.ToSource {
				if err != nil || pair[0] == nil {
					t.Fatalf("to_source %v without a plan", pair)
				}
				raw, ok := got.ToSource(*pair[0])
				switch {
				case pair[1] == nil && ok:
					t.Errorf("ToSource(%d) = %d, want none", *pair[0], raw)
				case pair[1] != nil && (!ok || raw != *pair[1]):
					t.Errorf("ToSource(%d) = %d, %v; want %d", *pair[0], raw, ok, *pair[1])
				}
			}
			if c.Want == nil {
				return
			}
			switch {
			case err != nil && err.Kind == ErrSentTooLarge:
				// The route reports this plan: its text classifies as want.planned.
				if c.Want.Planned == nil || c.Want.Prepared != nil || c.Want.SameClass != nil || len(c.Selectors) > 0 {
					t.Fatalf("a sent-too-large entry holds only want.planned: %+v", c.Want)
				}
				if g := facts(Classify(string(c.Error.Planned.Query))); !reflect.DeepEqual(g, *c.Want.Planned) {
					t.Errorf("Classify(error.planned.query) %+v, want %+v", g, *c.Want.Planned)
				}
				if g := facts(planned.Class); !reflect.DeepEqual(g, *c.Want.Planned) {
					t.Errorf("error plan's Class %+v, want %+v", g, *c.Want.Planned)
				}
			case err == nil:
				if c.Want.Prepared == nil || c.Want.Planned == nil || c.Want.SameClass == nil {
					t.Fatalf("a parity entry states prepared, planned and same_class: %+v", c.Want)
				}
				gp, gq := facts(p.Class()), facts(planned.Class)
				if !reflect.DeepEqual(gp, *c.Want.Prepared) {
					t.Errorf("prepared facts %+v, want %+v", gp, *c.Want.Prepared)
				}
				if !reflect.DeepEqual(gq, *c.Want.Planned) {
					t.Errorf("planned facts %+v, want %+v", gq, *c.Want.Planned)
				}
				if same := reflect.DeepEqual(gp, gq); same != *c.Want.SameClass {
					t.Errorf("same class %v, want %v", same, *c.Want.SameClass)
				}
				checkSpans(t, "prepared", p.Class(), c.Selectors)
				checkSpans(t, "planned", planned.Class, c.Selectors)
				if !reflect.DeepEqual(planned.Class, Classify(planned.Query)) {
					t.Errorf("Planned.Class is not Classify(Planned.Query)")
				}
			default:
				t.Errorf("want without a plan to classify")
			}
		})
	}
}

// hashRefusal checks that err is row 9b at pos (plan #121 §3.1).
func hashRefusal(t *testing.T, what string, err *PlanError, pos int) {
	t.Helper()
	want := "unexpected '#' at byte " + strconv.Itoa(pos) + ": LogQL has no comments"
	switch {
	case err == nil:
		t.Errorf("%s: err = nil, want ErrInput query.invalid at %d", what, pos)
	case err.Kind != ErrInput || err.Message != want || !slices.Equal(err.Fields, []FieldError{{"/query", "query.invalid"}}) ||
		err.Position == nil || *err.Position != pos || err.Planned != nil:
		t.Errorf("%s: %d %q %+v position %v, want ErrInput %q [/query query.invalid] at %d", what, err.Kind, err.Message, err.Fields, err.Position, want, pos)
	}
}

// TestPrepareHashBeforeClassify: row 9b in Prepare refuses H1 before Classify reads the
// selector after the '#' (plan #121 §4.3, T07-020).
func TestPrepareHashBeforeClassify(t *testing.T) {
	for _, k := range []Kind{KindRange, KindVolume} {
		p, err := Prepare(Inputs{Query: "# x\r{source = \"pulsus-dash\"}", Vars: map[string]string{}, Kind: k, StepMs: 5000})
		if p != nil {
			t.Errorf("Prepare(H1) kind %d: prepared, want the hash refusal", k)
		}
		hashRefusal(t, "Prepare(H1) kind "+strconv.Itoa(int(k)), err, 0)
	}
}

// TestPlanHashAtFinal: row 9b in Plan checks the final planned text (plan #121 §4.3); Prepare is
// bypassed, so only that check can refuse. The volume offset 56 maps through the template to 8.
func TestPlanHashAtFinal(t *testing.T) {
	for _, k := range []Kind{KindRange, KindVolume} {
		got, err := (&Prepared{in: Inputs{Query: "{a=\"x\"} #", Kind: k}}).Plan(5000)
		if err == nil {
			t.Errorf("Plan kind %d: planned %q, want the hash refusal at 8", k, got.Query)
			continue
		}
		hashRefusal(t, "Plan kind "+strconv.Itoa(int(k)), err, 8)
	}
}

// The tables of logql.json, and their equality with promql.json's (Q2: one board, one window).
func TestLogsPlanTables(t *testing.T) {
	f := loadFixture(t)
	p := loadPromTables(t)
	if len(f.RateWindow) == 0 || len(f.Durations) == 0 || len(f.VolumeRange) == 0 {
		t.Fatal("empty tables")
	}
	if !reflect.DeepEqual(f.RateWindow, p.RateWindow) || !reflect.DeepEqual(f.Durations, p.Durations) {
		t.Error("logql.json's rate_window and durations differ from promql.json's")
	}
	for _, r := range f.RateWindow {
		if got := RateWindowMs(r.StepMs); got != r.WindowMs || FormatDuration(got) != r.Text {
			t.Errorf("RateWindowMs(%d) = %d %q, want %d %q", r.StepMs, got, FormatDuration(got), r.WindowMs, r.Text)
		}
	}
	for _, d := range f.Durations {
		if got := FormatDuration(d.Ms); got != d.Text {
			t.Errorf("FormatDuration(%d) = %q, want %q", d.Ms, got, d.Text)
		}
	}
	for _, v := range f.VolumeRange {
		if got := VolumeRange(v.StepMs); got != v.Text {
			t.Errorf("VolumeRange(%d) = %q, want %q", v.StepMs, got, v.Text)
		}
	}
}

// Rows 1 and 5: bad UTF-8 in the text and in a value (the fixture's JSON cannot hold it).
func TestLogsPlanInvalidUTF8(t *testing.T) {
	_, e := Plan(Inputs{Query: "a\xffb", Kind: KindRange, StepMs: 5000})
	if e == nil || e.Status() != 400 || e.Message != "query must be UTF-8" || !slices.Equal(e.Fields, []FieldError{{"/query", "field.range"}}) {
		t.Errorf("query: %+v", e)
	}
	_, e = Plan(Inputs{Query: `{a="$r"}`, Vars: map[string]string{"r": "\xff"}, Kind: KindRange, StepMs: 5000})
	if e == nil || e.Status() != 400 || e.Message != "a variable value must be UTF-8 and at most 4096 bytes" ||
		!slices.Equal(e.Fields, []FieldError{{"/vars/r", "field.range"}}) {
		t.Errorf("value: %+v", e)
	}
}

// The "at byte N" rewrite of a mapped position (plan #116 §4.5).
func TestRewriteAtByte(t *testing.T) {
	for _, c := range []struct {
		msg  string
		off  int
		want string
	}{
		{"unexpected '[' at byte 57: x", 8, "unexpected '[' at byte 8: x"},
		{"x at byte 9 at byte 10", 1, "x at byte 1 at byte 10"},
		{"no offset", 3, "no offset"},
	} {
		if got := RewriteAtByte(c.msg, c.off); got != c.want {
			t.Errorf("RewriteAtByte(%q, %d) = %q, want %q", c.msg, c.off, got, c.want)
		}
	}
}
