package pulsusdb

import (
	"encoding/json"
	"fmt"
	"math/rand/v2"
	"os"
	"slices"
	"strconv"
	"testing"
)

// The shared paging fixture of plan #66 Part B (B.1.1): the client's synthetic log API passes the
// same cases (unit:log-synth).
type pagingFixture struct {
	T0     string                       `json:"t0"`
	Window struct{ From, To int64 }     `json:"window"`
	Stream map[string]map[string]string `json:"streams"`
	Cases  []pagingCase                 `json:"cases"`
}

type fixtureEntry struct {
	Off    int64  `json:"off"`
	Stream string `json:"stream"`
	Line   string `json:"line"`
	With   string `json:"with"`
}

type fixtureCursor struct {
	Off  int64 `json:"off"`
	Skip int   `json:"skip"`
}

type fixturePage struct {
	IDs  []string       `json:"ids"`
	Next *fixtureCursor `json:"next"`
}

type pagingCase struct {
	Name      string         `json:"name"`
	Direction string         `json:"direction"`
	Limit     int            `json:"limit"`
	Entries   []fixtureEntry `json:"entries"`
	Pages     []fixturePage  `json:"pages"`
	Mutate    *struct {
		AfterPage   int           `json:"after_page"`
		Insert      *fixtureEntry `json:"insert"`
		Replace     *fixtureEntry `json:"replace"`
		RefetchPage int           `json:"refetch_page"`
		Page        fixturePage   `json:"page"`
	} `json:"mutate"`
}

func readPagingFixture(t *testing.T) pagingFixture {
	t.Helper()
	b, err := os.ReadFile("../../../wire/fixtures/json/logql-paging.json")
	if err != nil {
		t.Fatal(err)
	}
	var f pagingFixture
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

// unit:log-paging (extended, plan #66 Part B B.1.1): every case of the shared fixture, for 10
// seeds of edge-group subsets.
func TestPagingFixture(t *testing.T) {
	f := readPagingFixture(t)
	base, err := strconv.ParseInt(f.T0, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	labels := func(stream string) []Label {
		m, ok := f.Stream[stream]
		if !ok {
			t.Fatalf("unknown stream %q", stream)
		}
		var ls []Label
		for k, v := range m {
			ls = append(ls, Label{Name: k, Value: v})
		}
		slices.SortFunc(ls, labelCompare)
		return ls
	}
	entry := func(e fixtureEntry) tEntry { return tEntry{base + e.Off, labels(e.Stream), e.Line} }
	cursor := func(c *fixtureCursor) *PageCursor {
		if c == nil {
			return nil
		}
		return cur(base+c.Off, c.Skip)
	}
	window := LogWindow{LoNs: f.Window.From * 1_000_000, HiNs: f.Window.To * 1_000_000}
	for _, c := range f.Cases {
		dir := Backward
		if c.Direction == "forward" {
			dir = Forward
		}
		var data []tEntry
		for _, e := range c.Entries {
			data = append(data, entry(e))
		}
		// ids are "<stream>/<line>"; each is one entry of the case's data (after any mutation).
		want := func(ids []string, es []tEntry) []tEntry {
			out := make([]tEntry, 0, len(ids))
			for _, id := range ids {
				i := slices.IndexFunc(es, func(e tEntry) bool {
					for s := range f.Stream {
						if id == s+"/"+e.line && slices.Equal(e.ls, labels(s)) {
							return true
						}
					}
					return false
				})
				if i < 0 {
					t.Fatalf("%s: id %s is not in the data", c.Name, id)
				}
				out = append(out, es[i])
			}
			return out
		}
		for seed := range uint64(10) {
			t.Run(fmt.Sprintf("%s/seed%d", c.Name, seed), func(t *testing.T) {
				live := slices.Clone(data)
				u := logUpstream(t, func(r logReq) string {
					// #nosec G404 -- seeded for reproducible edge-group subsets
					return streamsBody(typeFirst, topLimit(live, r, rand.New(rand.NewPCG(seed, 0)), nil))
				})
				cl := New(Options{})
				q := LogRangeQuery{Query: `{app="x"}`, Grid: a1Grid(), Window: window, Limit: c.Limit, Direction: dir}
				afters := []*PageCursor{nil}
				for i, p := range c.Pages {
					q.After = afters[i]
					got := logPage(t, cl, u, q)
					wantPage(t, fmt.Sprintf("page %d", i+1), got, want(p.IDs, live), cursor(p.Next), -1)
					afters = append(afters, got.Next)
				}
				m := c.Mutate
				if m == nil {
					return
				}
				if m.AfterPage != len(c.Pages) {
					t.Fatalf("after_page %d, %d pages listed", m.AfterPage, len(c.Pages))
				}
				answerMu.Lock()
				switch {
				case m.Insert != nil:
					live = append(live, entry(*m.Insert))
				case m.Replace != nil:
					old := entry(*m.Replace)
					for i, e := range live {
						if e.ts == old.ts && e.line == old.line && slices.Equal(e.ls, old.ls) {
							live[i].line = m.Replace.With
						}
					}
				}
				answerMu.Unlock()
				q.After = afters[m.RefetchPage-1]
				got := logPage(t, cl, u, q)
				wantPage(t, fmt.Sprintf("re-fetch of page %d", m.RefetchPage), got, want(m.Page.IDs, live),
					cursor(m.Page.Next), -1)
			})
		}
	}
}
