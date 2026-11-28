// An external test package: it imports pulsusdb for the byte guard (see logs.LoadFixture).
package logs_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/logs"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/vars"
)

// unit:logql-classify (Go): every entry of the fixture's classify group, classified on its
// substituted text (plan #116 §3.5, A.1.1), and the byte guard over the reserved table. The text
// is Prepare's substitution before row 9b (plan #121 §5.1), so an entry with a top-level '#' is
// still classified; Prepare itself refuses it at prepare_position.
func TestLogqlClassify(t *testing.T) {
	f := logs.LoadFixture(t)
	for _, e := range f.Classify {
		t.Run(e.Name, func(t *testing.T) {
			vs := e.Vars
			if vs == nil {
				vs = map[string]vars.Value{}
			}
			in := logs.Inputs{Query: string(e.Text), Vars: vs, Kind: logs.KindRange, StepMs: 5000}
			sub, serr := logs.PrepareSubstitute(in)
			if serr != nil {
				t.Fatalf("logs.PrepareSubstitute: %v", serr)
			}
			c := logs.Classify(sub)
			if string(c.Source) != e.Want.Class || !slices.Equal(c.Reserved, e.Want.Reserved) {
				t.Errorf("class %s %v, want %s %v", c.Source, c.Reserved, e.Want.Class, e.Want.Reserved)
			}
			if len(c.Selectors) != len(e.Want.Selectors) {
				t.Fatalf("%d selectors %v, want %d", len(c.Selectors), c.Selectors, len(e.Want.Selectors))
			}
			for i, s := range c.Selectors {
				w := e.Want.Selectors[i]
				if s.Reserved != w.Reserved || sub[s.From:s.To] != string(w.Text) {
					t.Errorf("selector %d %q reserved %v, want %q %v", i, sub[s.From:s.To], s.Reserved, w.Text, w.Reserved)
				}
			}
			p, err := logs.Prepare(in)
			if e.PreparePosition != nil {
				if err == nil || err.Kind != logs.ErrInput || !slices.Equal(err.Fields, []logs.FieldError{{Pointer: "/query", MessageKey: "query.invalid"}}) ||
					err.Position == nil || *err.Position != *e.PreparePosition {
					t.Errorf("logs.Prepare: %v, want ErrInput /query query.invalid at %d", err, *e.PreparePosition)
				}
				return
			}
			if err != nil {
				t.Fatalf("logs.Prepare: %v", err)
			}
			if pc := p.Class(); string(pc.Source) != string(c.Source) || !slices.Equal(pc.Reserved, c.Reserved) || !slices.Equal(pc.Selectors, c.Selectors) {
				t.Errorf("Prepare's class %+v, want Classify(sub) %+v", pc, c)
			}
		})
	}
	if len(f.Reserved) == 0 {
		t.Fatal("no reserved rows")
	}
	for _, r := range f.Reserved {
		got := pulsusdb.CheckReserved("query", string(r.Text))
		switch {
		case r.Want == nil && got != nil:
			t.Errorf("CheckReserved(%q) = %q, want none", r.Text, got.Reserved)
		case r.Want != nil && (got == nil || got.Reserved != *r.Want):
			t.Errorf("CheckReserved(%q) = %v, want %q", r.Text, got, *r.Want)
		}
	}
}

// FuzzClassify: the reader never panics, its source is one of the three, and its selectors are
// in range, ordered and disjoint.
// `go test -fuzz` is not run in CI; the seeds run with every `go test`.
func FuzzClassify(f *testing.F) {
	for _, s := range fuzzSeeds() {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, text string) {
		c := logs.Classify(text)
		switch c.Source {
		case logs.SourcePulsusDB, logs.SourceVirtual, logs.SourceMixed:
		default:
			t.Fatalf("source %q", c.Source)
		}
		prev := 0
		for _, s := range c.Selectors {
			if s.From < prev || s.From >= s.To || s.To > len(text) {
				t.Fatalf("selector %+v after %d in %d bytes", s, prev, len(text))
			}
			prev = s.To
		}
		if len(c.Reserved) > 1 || (len(c.Reserved) == 1 && c.Reserved[0] != logs.ReservedMatcher) {
			t.Fatalf("reserved %v", c.Reserved)
		}
	})
}

// fuzzSeeds are every case text of the fixture and the edge texts of plan #116 §5.1.
func fuzzSeeds() []string {
	seeds := []string{"", "{", strings.Repeat(`"`, 1_000), strings.Repeat("{", 10_000), "`", "#"}
	f, err := logs.ReadFixture()
	if err != nil {
		return seeds
	}
	for _, e := range f.Classify {
		seeds = append(seeds, string(e.Text))
	}
	for _, c := range f.Plan {
		if len(c.Inputs.Query) <= 4_096 {
			seeds = append(seeds, string(c.Inputs.Query))
		}
	}
	return seeds
}
