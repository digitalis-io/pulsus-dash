package pulsusdb

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
)

// A.1 shared values.
const t0 = int64(1767229100000000000)

var (
	lsA = []Label{{Name: "app", Value: "x"}, {Name: "detected_level", Value: "info"}, {Name: "pod", Value: "a"}}
	lsB = []Label{{Name: "app", Value: "x"}, {Name: "detected_level", Value: "unknown"}, {Name: "level", Value: "WARNING"}, {Name: "pod", Value: "b"}}
	lsC = []Label{{Name: "app", Value: "x"}, {Name: "detected_level", Value: "ERR"}, {Name: "level", Value: "debug"}, {Name: "pod", Value: "c"}}
)

// tEntry is one test log entry.
type tEntry struct {
	ts   int64
	ls   []Label
	line string
}

func (e tEntry) key() uint64 { return keyhash.Labels(e.ls) }

func (e tEntry) String() string { return fmt.Sprintf("%s@%d", e.line, e.ts-t0) }

// a1Data is the six entries of A.1: a5@500, b4@400 and the group at 300 (a3 twice, b3, c3).
func a1Data() []tEntry {
	return []tEntry{{t0 + 500, lsA, "a5"}, {t0 + 400, lsB, "b4"}, {t0 + 300, lsA, "a3"}, {t0 + 300, lsA, "a3"},
		{t0 + 300, lsB, "b3"}, {t0 + 300, lsC, "c3"}}
}

func a1Grid() Grid        { return Grid{Start: 1767225600000, End: 1767229200000, Step: 5000} }
func a1Window() LogWindow { return LogWindow{LoNs: 1767225600000000000, HiNs: 1767229200000000000} }

func a1Query(limit int, dir Direction) LogRangeQuery {
	return LogRangeQuery{Query: `{app="x"}`, Grid: a1Grid(), Window: a1Window(), Limit: limit, Direction: dir}
}

// groupCmp is the group order: stream key ascending, then line bytes ascending.
func groupCmp(a, b tEntry) int {
	if c := cmp.Compare(a.key(), b.key()); c != 0 {
		return c
	}
	return strings.Compare(a.line, b.line)
}

// pageOrder sorts es in page order of dir.
func pageOrder(es []tEntry, dir Direction) []tEntry {
	out := slices.Clone(es)
	slices.SortStableFunc(out, func(a, b tEntry) int {
		if a.ts != b.ts {
			if dir == Backward {
				return cmp.Compare(b.ts, a.ts)
			}
			return cmp.Compare(a.ts, b.ts)
		}
		return groupCmp(a, b)
	})
	return out
}

// order is the member order of a test body (A.1 body).
type order bool

const (
	typeFirst   order = false
	resultFirst order = true
)

func jstr(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

// jobj writes an object of key and raw-value pairs; resultFirst writes them in reverse order.
func jobj(o order, kv ...string) string {
	var parts []string
	for i := 0; i+1 < len(kv); i += 2 {
		parts = append(parts, jstr(kv[i])+":"+kv[i+1])
	}
	if o == resultFirst {
		slices.Reverse(parts)
	}
	return "{" + strings.Join(parts, ",") + "}"
}

func labelsJSON(o order, ls []Label) string {
	var kv []string
	for _, l := range ls {
		kv = append(kv, l.Name, jstr(l.Value))
	}
	return jobj(o, kv...)
}

// streamsJSON groups es into stream objects in order of first appearance, entries in the given order.
func streamsJSON(o order, es []tEntry) string {
	var keys []uint64
	by := map[uint64][]tEntry{}
	for _, e := range es {
		k := e.key()
		if _, ok := by[k]; !ok {
			keys = append(keys, k)
		}
		by[k] = append(by[k], e)
	}
	var objs []string
	for _, k := range keys {
		var vs []string
		for _, e := range by[k] {
			vs = append(vs, "["+jstr(strconv.FormatInt(e.ts, 10))+","+jstr(e.line)+"]")
		}
		objs = append(objs, jobj(o, "stream", labelsJSON(o, by[k][0].ls), "values", "["+strings.Join(vs, ",")+"]"))
	}
	return "[" + strings.Join(objs, ",") + "]"
}

// body is the A.1 body(order, kind, result).
func body(o order, kind, result string) string {
	data := jobj(o, "resultType", jstr(kind), "result", result, "stats", "{}")
	return jobj(o, "status", jstr("success"), "data", data, "warnings", `["w1"]`)
}

func streamsBody(o order, es []tEntry) string { return body(o, "streams", streamsJSON(o, es)) }

// logReq is one log query_range request as the upstream saw it.
type logReq struct {
	n          int // 0-based call index
	start, end int64
	limit      int
	dir        string
}

// answerMu serialises every scripted answer, so the answers may share a random source.
var answerMu sync.Mutex

// logUpstream answers each log request with answer(r).
func logUpstream(t *testing.T, answer func(r logReq) string) *upstream {
	t.Helper()
	var calls atomic.Int64
	return newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		start, _ := strconv.ParseInt(r.Form.Get("start"), 10, 64)
		end, _ := strconv.ParseInt(r.Form.Get("end"), 10, 64)
		limit, _ := strconv.Atoi(r.Form.Get("limit"))
		lr := logReq{n: int(calls.Add(1) - 1), start: start, end: end, limit: limit, dir: r.Form.Get("direction")}
		answerMu.Lock()
		b := answer(lr)
		answerMu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, b)
	})
}

// topLimit is a valid top-limit answer to r over data: every entry strictly before the edge
// timestamp in direction order, plus pick(edge group, need) of the edge group; shuffled by rng.
func topLimit(data []tEntry, r logReq, rng *rand.Rand, pick func(group []tEntry, need int) []tEntry) []tEntry {
	var sel []tEntry
	for _, e := range data {
		if r.start < e.ts && e.ts <= r.end {
			sel = append(sel, e)
		}
	}
	dir := Backward
	if r.dir == "forward" {
		dir = Forward
	}
	sel = pageOrder(sel, dir)
	if len(sel) > r.limit {
		edge := sel[r.limit-1].ts
		var before, group []tEntry
		for _, e := range sel {
			switch {
			case e.ts == edge:
				group = append(group, e)
			case len(group) == 0:
				before = append(before, e)
			}
		}
		need := r.limit - len(before)
		if pick == nil {
			rng.Shuffle(len(group), func(i, j int) { group[i], group[j] = group[j], group[i] })
			group = group[:need]
		} else {
			group = pick(group, need)
		}
		sel = append(before, group...)
	}
	rng.Shuffle(len(sel), func(i, j int) { sel[i], sel[j] = sel[j], sel[i] })
	return sel
}

// entriesOf maps a page back to test entries, in page order.
func entriesOf(p *LogPage) []tEntry {
	out := make([]tEntry, 0, len(p.Entries))
	for _, e := range p.Entries {
		out = append(out, tEntry{e.TsNs, p.Streams[e.Stream].Labels, e.Line})
	}
	return out
}

func sameEntries(a, b []tEntry) bool {
	return slices.EqualFunc(a, b, func(x, y tEntry) bool {
		return x.ts == y.ts && x.line == y.line && slices.Equal(x.ls, y.ls)
	})
}

func cur(ts int64, skip int) *PageCursor { return &PageCursor{TsNs: ts, Skip: skip} }

func curString(c *PageCursor) string {
	if c == nil {
		return "nil"
	}
	return fmt.Sprintf("{%d,%d}", c.TsNs, c.Skip)
}

func sameCursor(a, b *PageCursor) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

// logPage runs one LogQueryRange and returns its page; t fails on an error or a metric result.
func logPage(t *testing.T, c *Client, u *upstream, q LogRangeQuery) *LogPage {
	t.Helper()
	r, err := c.LogQueryRange(ctxWithin(t, 10*time.Second), rcFor(testBinding(u.URL)), q)
	if err != nil {
		t.Fatalf("LogQueryRange(after %s): %v", curString(q.After), err)
	}
	if r == nil || r.Page == nil {
		t.Fatalf("LogQueryRange(after %s): no page", curString(q.After))
	}
	return r.Page
}

// wantPage checks one page's entries, cursor and request count (requests < 0: not checked).
func wantPage(t *testing.T, what string, p *LogPage, es []tEntry, next *PageCursor, requests int) {
	t.Helper()
	if got := entriesOf(p); !sameEntries(got, es) {
		t.Errorf("%s: entries %v, want %v", what, got, es)
	}
	if !sameCursor(p.Next, next) {
		t.Errorf("%s: Next %s, want %s", what, curString(p.Next), curString(next))
	}
	if requests >= 0 && p.Requests != requests {
		t.Errorf("%s: Requests %d, want %d", what, p.Requests, requests)
	}
}

// at returns the entries of es at ts.
func at(es []tEntry, ts int64) []tEntry {
	var out []tEntry
	for _, e := range es {
		if e.ts == ts {
			out = append(out, e)
		}
	}
	return out
}

// unit:log-paging (§4.2, §4.6; acceptance 1 at the client level).
func TestLogPaging(t *testing.T) {
	rng := rand.New(rand.NewPCG(65, 1)) // #nosec G404 -- seeded for reproducible cases
	group := pageOrder(at(a1Data(), t0+300), Backward)
	a5, b4 := a1Data()[0], a1Data()[1]

	t.Run("first page form", func(t *testing.T) {
		for _, c := range []struct{ limit, sent int }{{4, 5}, {5000, 5000}} {
			u := logUpstream(t, func(logReq) string { return streamsBody(typeFirst, nil) })
			q := a1Query(c.limit, Forward)
			_ = logPage(t, New(Options{}), u, q)
			r := u.requests()[0]
			for k, w := range map[string]string{"start": nsParam(1767225600000000000), "end": nsParam(1767229200000000000),
				"limit": strconv.Itoa(c.sent), "direction": "forward", "step": "5000ms", "query": `{app="x"}`} {
				if g := r.Form.Get(k); g != w {
					t.Errorf("Limit %d: form %s = %q, want %q", c.limit, k, g, w)
				}
			}
		}
	})

	t.Run("backward adversarial subsets", func(t *testing.T) {
		// Page 1 holds a different 3-subset of the group at 300 in each run, streams in another order.
		subsets := [][]int{{0, 1, 2}, {0, 2, 3}, {1, 3, 2}, {3, 0, 1}}
		for run, sub := range subsets {
			u := logUpstream(t, func(r logReq) string {
				if r.n == 0 {
					es := []tEntry{a5, b4}
					for _, i := range sub {
						es = append(es, group[i])
					}
					rng.Shuffle(len(es), func(i, j int) { es[i], es[j] = es[j], es[i] })
					return streamsBody(typeFirst, es)
				}
				g := slices.Clone(group)
				rng.Shuffle(len(g), func(i, j int) { g[i], g[j] = g[j], g[i] })
				return streamsBody(typeFirst, g)
			})
			c := New(Options{})
			q := a1Query(4, Backward)
			p1 := logPage(t, c, u, q)
			wantPage(t, fmt.Sprintf("run %d page 1", run), p1, []tEntry{a5, b4}, cur(t0+300, 0), 1)
			q.After = p1.Next
			p2 := logPage(t, c, u, q)
			wantPage(t, fmt.Sprintf("run %d page 2", run), p2, pageOrder(group, Backward), nil, 1)
		}
	})

	t.Run("forward sub-paged group", func(t *testing.T) {
		g := pageOrder(group, Forward)
		for run := range 4 {
			u := logUpstream(t, func(r logReq) string {
				return streamsBody(typeFirst, topLimit(a1Data(), r, rng, nil))
			})
			c := New(Options{})
			q := a1Query(2, Forward)
			p := logPage(t, c, u, q)
			wantPage(t, fmt.Sprintf("run %d page 1", run), p, g[0:2], cur(t0+300, 2), 2)
			q.After = p.Next
			p = logPage(t, c, u, q)
			wantPage(t, fmt.Sprintf("run %d page 2", run), p, g[2:4], cur(t0+301, 0), 1)
			q.After = p.Next
			p = logPage(t, c, u, q)
			wantPage(t, fmt.Sprintf("run %d page 3", run), p, []tEntry{b4, a5}, nil, -1)
		}
	})

	t.Run("backward group fetch", func(t *testing.T) {
		g := pageOrder(group, Backward)
		u := logUpstream(t, func(r logReq) string {
			return streamsBody(typeFirst, topLimit(a1Data(), r, rng, nil))
		})
		c := New(Options{})
		q := a1Query(2, Backward)
		steps := []struct {
			es       []tEntry
			next     *PageCursor
			requests int
		}{
			{[]tEntry{a5, b4}, cur(t0+300, 0), 1},
			{g[0:2], cur(t0+300, 2), 2},
			{g[2:4], cur(t0+299, 0), 1},
			{nil, nil, 1},
		}
		for i, s := range steps {
			p := logPage(t, c, u, q)
			wantPage(t, fmt.Sprintf("page %d", i+1), p, s.es, s.next, s.requests)
			q.After = p.Next
		}
	})

	t.Run("three-entry group, limit 1", func(t *testing.T) {
		T := t0 + 300
		a3, b3, c3 := tEntry{T, lsA, "a3"}, tEntry{T, lsB, "b3"}, tEntry{T, lsC, "c3"}
		g := pageOrder([]tEntry{a3, b3, c3}, Backward)
		for _, dir := range []Direction{Backward, Forward} {
			groupAnswers := [][]tEntry{{c3, a3, b3}, {b3, c3, a3}, {a3, c3, b3}}
			var mu sync.Mutex
			ga := 0
			u := logUpstream(t, func(r logReq) string {
				switch {
				case r.n == 0:
					return streamsBody(typeFirst, []tEntry{a3, b3})
				case r.start == T-1 && r.end == T:
					mu.Lock()
					defer mu.Unlock()
					a := groupAnswers[ga%3]
					ga++
					return streamsBody(typeFirst, a)
				}
				return streamsBody(typeFirst, topLimit([]tEntry{a3, b3, c3}, r, rng, nil))
			})
			c := New(Options{})
			q := a1Query(1, dir)
			var got []tEntry
			empty, ended := 0, false
			for i := 0; i < 10 && !ended; i++ {
				p := logPage(t, c, u, q)
				got = append(got, entriesOf(p)...)
				if len(p.Entries) == 0 {
					empty++
				}
				ended = p.Next == nil
				q.After = p.Next
			}
			if !sameEntries(got, g) || empty > 1 || !ended {
				t.Errorf("%v: delivered %v (%d empty pages), want %v", dir, got, empty, g)
			}
		}
	})

	t.Run("data changed", func(t *testing.T) {
		T := t0 + 300
		u := logUpstream(t, func(logReq) string { return streamsBody(typeFirst, group[:2]) })
		q := a1Query(4, Backward)
		q.After = cur(T, 3)
		wantPage(t, "shrunk group", logPage(t, New(Options{}), u, q), nil, cur(T-1, 0), 1)
	})

	t.Run("documented limit", func(t *testing.T) {
		T := t0 + 300
		mk := func(n int) []tEntry {
			out := make([]tEntry, n)
			for i := range out {
				out[i] = tEntry{T, []Label{{Name: "app", Value: "x"}, {Name: "pod", Value: strconv.Itoa(i % 7)}}, fmt.Sprintf("l%04d", i)}
			}
			return out
		}
		shuffled := func(es []tEntry) []tEntry {
			out := slices.Clone(es)
			rng.Shuffle(len(out), func(i, j int) { out[i], out[j] = out[j], out[i] })
			return out
		}
		// 4 999 at T: 50 pages deliver each exactly once, the last with Next = past(T).
		data := mk(4999)
		u := logUpstream(t, func(r logReq) string { return streamsBody(typeFirst, topLimit(data, r, rng, nil)) })
		c := New(Options{})
		q := a1Query(100, Backward)
		var got []tEntry
		var p *LogPage
		for range 50 {
			p = logPage(t, c, u, q)
			got = append(got, entriesOf(p)...)
			q.After = p.Next
		}
		if !sameEntries(got, pageOrder(data, Backward)) || !sameCursor(p.Next, cur(T-1, 0)) {
			t.Errorf("4 999 at T: %d delivered (exact %v), last Next %s", len(got), sameEntries(got, pageOrder(data, Backward)), curString(p.Next))
		}
		// 5 001 at T, every answer a different 5 000: pages stay ≤ Limit, nothing flagged, paging ends.
		data = mk(5001)
		u = logUpstream(t, func(r logReq) string {
			return streamsBody(typeFirst, shuffled(topLimit(data, r, rng, nil)))
		})
		q = a1Query(100, Backward)
		for i := range 50 {
			p = logPage(t, c, u, q)
			if len(p.Entries) > 100 || p.Completeness.Truncated {
				t.Fatalf("5 001 at T page %d: %d entries, truncated %v", i+1, len(p.Entries), p.Completeness.Truncated)
			}
			for _, w := range p.Completeness.Warnings {
				if strings.HasPrefix(w, "pulsus-dash:") {
					t.Fatalf("5 001 at T page %d: warning %q", i+1, w)
				}
			}
			q.After = p.Next
		}
		if !sameCursor(p.Next, cur(T-1, 0)) {
			t.Errorf("5 001 at T: Next after 50 pages %s, want past(T)", curString(p.Next))
		}
		// 4 999 at T plus one older entry, Limit 4 999: one request, 4 999 entries.
		data = append(mk(4999), tEntry{T - 10, lsA, "older"})
		u = logUpstream(t, func(r logReq) string { return streamsBody(typeFirst, topLimit(data, r, rng, nil)) })
		p = logPage(t, c, u, a1Query(4999, Backward))
		if len(p.Entries) != 4999 || p.Requests != 1 {
			t.Errorf("4 999 + 1 older: %d entries, %d requests; want 4999, 1", len(p.Entries), p.Requests)
		}
	})

	t.Run("protocol", func(t *testing.T) {
		T := t0 + 300
		for _, c := range []struct {
			name   string
			after  *PageCursor
			answer func(r logReq) string
		}{
			{"ts at start", cur(T, 0), func(r logReq) string {
				return streamsBody(typeFirst, []tEntry{{r.start, lsA, "x"}})
			}},
			{"ts after end", nil, func(r logReq) string {
				return streamsBody(typeFirst, []tEntry{{r.end + 1, lsA, "x"}})
			}},
			{"more than limit", nil, func(r logReq) string {
				es := make([]tEntry, r.limit+1)
				for i := range es {
					es[i] = tEntry{t0 + int64(i), lsA, "x"}
				}
				return streamsBody(typeFirst, es)
			}},
			{"group entry not at T", cur(T, 1), func(r logReq) string {
				return streamsBody(typeFirst, []tEntry{{T, lsA, "x"}, {T - 1, lsA, "y"}})
			}},
			{"matrix after the first page", cur(T, 0), func(logReq) string {
				return body(typeFirst, "matrix", `[]`)
			}},
			{"matrix on a group fetch", nil, func(r logReq) string {
				if r.n == 0 {
					return streamsBody(typeFirst, []tEntry{{T, lsA, "x"}, {T, lsB, "y"}, {T, lsC, "z"}})
				}
				return body(typeFirst, "matrix", `[]`)
			}},
			{"matrix on a re-issue", nil, func(r logReq) string {
				if r.n == 0 {
					return streamsBody(typeFirst, []tEntry{{1767229200000000000, lsA, "x"}, {1767229199000000000, lsA, "y"}, {1767229198900000000, lsA, "z"}})
				}
				return body(typeFirst, "matrix", `[]`)
			}},
		} {
			u := logUpstream(t, c.answer)
			q := a1Query(2, Backward)
			if c.name == "matrix on a re-issue" {
				q.Window.HiNs = 1767229100000000000
			}
			q.After = c.after
			_, err := New(Options{}).LogQueryRange(ctxWithin(t, 5*time.Second), rcFor(testBinding(u.URL)), q)
			wantProtocol(t, c.name, err)
		}
	})

	t.Run("streams merged", func(t *testing.T) {
		raw := `{"status":"success","data":{"resultType":"streams","result":[` +
			`{"stream":` + labelsJSON(typeFirst, lsB) + `,"values":[["` + strconv.FormatInt(t0+2, 10) + `","b"]]},` +
			`{"stream":` + labelsJSON(typeFirst, lsA) + `,"values":[["` + strconv.FormatInt(t0+3, 10) + `","a1"]]},` +
			`{"stream":` + labelsJSON(typeFirst, lsC) + `,"values":[["` + strconv.FormatInt(t0+4, 10) + `","c"]]},` +
			`{"stream":` + labelsJSON(resultFirst, lsA) + `,"values":[["` + strconv.FormatInt(t0+1, 10) + `","a2"]]}]}}`
		u := newUpstream(t, answer(200, raw))
		p := logPage(t, New(Options{}), u, a1Query(10, Backward))
		if len(p.Streams) != 3 {
			t.Fatalf("%d streams, want 3 (equal label sets merged)", len(p.Streams))
		}
		if !slices.IsSortedFunc(p.Streams, func(a, b LogStream) int { return cmp.Compare(a.Key, b.Key) }) {
			t.Errorf("streams not by key ascending")
		}
		for _, s := range p.Streams {
			if s.Key != keyhash.Labels(s.Labels) || s.Level != LevelOf(s.Labels) {
				t.Errorf("stream %v: key %x level %v", s.Labels, s.Key, s.Level)
			}
		}
		if len(p.Entries) != 4 {
			t.Errorf("%d entries, want 4", len(p.Entries))
		}
	})

	t.Run("property", func(t *testing.T) {
		prng := rand.New(rand.NewPCG(65, 0)) // #nosec G404 -- seed 65 (A.2 row 10): the cases
		hrng := rand.New(rand.NewPCG(65, 2)) // #nosec G404 -- the upstream's subsets and orders
		streams := [][]Label{lsA, lsB, lsC}
		for cs := range 500 {
			nts := 1 + prng.IntN(6)
			tss := make([]int64, nts)
			for i := range tss {
				tss[i] = t0 + int64(prng.IntN(50))
			}
			n := 1 + prng.IntN(40)
			data := make([]tEntry, n)
			for i := range data {
				data[i] = tEntry{tss[prng.IntN(nts)], streams[prng.IntN(3)], "l" + strconv.Itoa(prng.IntN(4))}
			}
			limit := 1 + prng.IntN(8)
			dir := []Direction{Backward, Forward}[prng.IntN(2)]
			u := logUpstream(t, func(r logReq) string {
				return streamsBody(order(hrng.IntN(2) == 1), topLimit(data, r, hrng, nil))
			})
			c := New(Options{})
			q := a1Query(limit, dir)
			var got []tEntry
			emptyAt := -1
			ok, ended := true, false
			for i := 0; i < 3*n+10 && !ended; i++ {
				p := logPage(t, c, u, q)
				es := entriesOf(p)
				if len(es) > limit || p.Requests > 3 || !sameEntries(es, pageOrder(es, dir)) {
					ok = false
				}
				if len(es) == 0 {
					if emptyAt >= 0 {
						ok = false
					}
					emptyAt = i
				}
				got = append(got, es...)
				ended = p.Next == nil
				if ended && emptyAt >= 0 && emptyAt != i {
					ok = false
				}
				q.After = p.Next
			}
			if !ok || !ended || !sameEntries(got, pageOrder(data, dir)) {
				t.Fatalf("case %d (limit %d, %v): delivered %v, want %v", cs, limit, dir, got, pageOrder(data, dir))
			}
		}
	})

	t.Run("cancellation", func(t *testing.T) {
		T := t0 + 300
		two := streamsBody(typeFirst, []tEntry{{T, lsA, "x"}, {T, lsB, "y"}})
		// (a) cancelled while the upstream blocks on the main request.
		entered := make(chan struct{})
		u := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
			close(entered)
			<-r.Context().Done()
		})
		rt := &countingTransport{inner: newTransport()}
		c := New(Options{Transport: rt})
		ctx, cancel := context.WithCancel(context.Background())
		go func() { <-entered; cancel() }()
		_, err := c.LogQueryRange(ctx, rcFor(testBinding(u.URL)), a1Query(1, Backward))
		if !errors.Is(err, context.Canceled) || rt.n.Load() != 1 {
			t.Errorf("(a) err %v, %d requests; want context.Canceled, 1", err, rt.n.Load())
		}
		// (b) the main request is answered, and ctx is cancelled as its body ends.
		u = newUpstream(t, answer(200, two))
		ctx, cancel = context.WithCancel(context.Background())
		defer cancel()
		rt = &countingTransport{inner: newTransport(), onEOF: cancel}
		c = New(Options{Transport: rt})
		_, err = c.LogQueryRange(ctx, rcFor(testBinding(u.URL)), a1Query(1, Backward))
		if !errors.Is(err, context.Canceled) || rt.n.Load() != 1 {
			t.Errorf("(b) err %v, %d requests; want context.Canceled and no group fetch", err, rt.n.Load())
		}
	})
}

// countingTransport counts round trips; onEOF, if set, runs when a response body reaches EOF.
type countingTransport struct {
	inner http.RoundTripper
	n     atomic.Int64
	onEOF func()
}

func (c *countingTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	c.n.Add(1)
	resp, err := c.inner.RoundTrip(r)
	if err == nil && c.onEOF != nil {
		resp.Body = &eofBody{ReadCloser: resp.Body, onEOF: c.onEOF}
	}
	return resp, err
}

type eofBody struct {
	io.ReadCloser
	onEOF func()
	once  sync.Once
}

func (b *eofBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if errors.Is(err, io.EOF) {
		b.once.Do(b.onEOF)
	}
	return n, err
}

// The unaligned window of A.1 (unit:log-window).
const (
	uLo = int64(1767225601234000000)
	uHi = int64(1767229198765000000)
)

func windowData() (e1, e2, e3, e4, e5, e6 tEntry) {
	return tEntry{uLo, lsA, "e1"}, tEntry{uLo + 1, lsA, "e2"}, tEntry{uHi, lsA, "e3"}, tEntry{uHi + 1, lsA, "e4"},
		tEntry{1767225600000000001, lsA, "e5"}, tEntry{1767229200000000000, lsA, "e6"}
}

func windowQuery(limit int, dir Direction) LogRangeQuery {
	g, err := PromGrid(1767225601234, 1767229198765, 1200)
	if err != nil {
		panic(err)
	}
	return LogRangeQuery{Query: `{app="x"}`, Grid: g, Window: LogWindow{LoNs: uLo, HiNs: uHi}, Limit: limit, Direction: dir}
}

// scripted answers the i-th request with answers[i] (the last one repeated).
func scripted(answers ...[]tEntry) func(r logReq) string {
	return func(r logReq) string {
		return streamsBody(typeFirst, answers[min(r.n, len(answers)-1)])
	}
}

func wantForm(t *testing.T, what string, s seen, kv ...string) {
	t.Helper()
	for i := 0; i+1 < len(kv); i += 2 {
		if g := s.Form.Get(kv[i]); g != kv[i+1] {
			t.Errorf("%s: form %s = %q, want %q", what, kv[i], g, kv[i+1])
		}
	}
}

// unit:log-window (§4.2 window).
func TestLogWindow(t *testing.T) {
	e1, e2, e3, e4, e5, e6 := windowData()
	all := []tEntry{e6, e4, e3, e2, e1, e5}

	if q := windowQuery(10, Backward); q.Grid != a1Grid() {
		t.Fatalf("unaligned grid %+v, want the A.1 grid", q.Grid)
	}
	for _, dir := range []Direction{Backward, Forward} {
		u := logUpstream(t, scripted(all))
		p := logPage(t, New(Options{}), u, windowQuery(10, dir))
		want := []tEntry{e3, e2}
		if dir == Forward {
			want = []tEntry{e2, e3}
		}
		wantPage(t, fmt.Sprintf("%v limit 10", dir), p, want, nil, 1)
		wantForm(t, "limit 10", u.requests()[0], "start", "1767225600000000000", "end", "1767229200000000000", "limit", "11")
	}

	// Backward, Limit 1: the first answer lies beyond to → re-issue on the window.
	u := logUpstream(t, scripted([]tEntry{e6, e4}, []tEntry{e3, e2}, []tEntry{e2}))
	c := New(Options{})
	q := windowQuery(1, Backward)
	p := logPage(t, c, u, q)
	wantPage(t, "backward limit 1 page 1", p, []tEntry{e3}, cur(uLo+1, 0), 2)
	if rs := u.requests(); len(rs) == 2 {
		wantForm(t, "re-issue", rs[1], "start", "1767225601234000000", "end", "1767229198765000000", "limit", "2")
	}
	q.After = p.Next
	p = logPage(t, c, u, q)
	wantPage(t, "backward limit 1 page 2", p, []tEntry{e2}, nil, 1)
	if rs := u.requests(); len(rs) == 3 {
		wantForm(t, "backward page 2", rs[2], "start", nsParam(uLo), "end", "1767225601234000001")
	}

	// Forward, Limit 1: the first answer lies before from → re-issue.
	u = logUpstream(t, scripted([]tEntry{e5, e1}, []tEntry{e2, e3}, []tEntry{e3}))
	q = windowQuery(1, Forward)
	p = logPage(t, c, u, q)
	wantPage(t, "forward limit 1 page 1", p, []tEntry{e2}, cur(uHi, 0), 2)
	q.After = p.Next
	p = logPage(t, c, u, q)
	wantPage(t, "forward limit 1 page 2", p, []tEntry{e3}, nil, 1)
	if rs := u.requests(); len(rs) == 3 {
		wantForm(t, "forward page 2", rs[2], "start", "1767229198764999999", "end", nsParam(uHi))
	}

	// Backward, Limit 2: the edge group is exactly to → group fetch.
	u = logUpstream(t, scripted([]tEntry{e6, e4, e3}, []tEntry{e3}))
	p = logPage(t, c, u, windowQuery(2, Backward))
	wantPage(t, "backward limit 2", p, []tEntry{e3}, cur(uHi-1, 0), 2)
	if rs := u.requests(); len(rs) == 2 {
		wantForm(t, "group fetch", rs[1], "start", "1767229198764999999", "end", "1767229198765000000", "limit", "5000")
	}

	// A metric query sends the grid bounds, not the window.
	u = newUpstream(t, answer(200, `{"status":"success","data":{"resultType":"matrix","result":[]}}`))
	r, err := c.LogQueryRange(ctxWithin(t, 5*time.Second), rcFor(testBinding(u.URL)), windowQuery(10, Backward))
	if err != nil || r == nil || r.Series == nil || r.Page != nil {
		t.Errorf("metric: %+v %v, want a series stream", r, err)
	} else {
		_ = r.Series.Close()
		wantForm(t, "metric", u.requests()[0], "start", "1767225600000000000", "end", "1767229200000000000")
	}

	// The int64 edge.
	hi := int64(9223372036000000000)
	x, y := tEntry{hi, lsA, "x"}, tEntry{hi, lsB, "y"}
	g := pageOrder([]tEntry{x, y}, Forward)
	u = logUpstream(t, scripted([]tEntry{x, y}))
	q = LogRangeQuery{Query: `{app="x"}`, Grid: Grid{Start: 9223372035000, End: 9223372036000, Step: 1000},
		Window: LogWindow{LoNs: 9223372035000000000, HiNs: hi}, Limit: 1, Direction: Forward}
	p = logPage(t, c, u, q)
	wantPage(t, "int64 edge page 1", p, g[:1], cur(hi, 1), 2)
	if rs := u.requests(); len(rs) == 2 {
		wantForm(t, "int64 group fetch", rs[1], "start", "9223372035999999999", "end", "9223372036000000000", "step", "1000ms")
	}
	q.After = p.Next
	p = logPage(t, c, u, q)
	wantPage(t, "int64 edge page 2", p, g[1:], nil, 1)
}

// logsOf runs a first page (Limit 10, backward) over an upstream answering raw.
func logsOf(t *testing.T, raw string, o Options) (*LogResult, error) {
	t.Helper()
	u := newUpstream(t, answer(200, raw))
	return New(o).LogQueryRange(ctxWithin(t, 5*time.Second), rcFor(testBinding(u.URL)), a1Query(10, Backward))
}

func streamDoc(values string) string {
	return `{"status":"success","data":{"resultType":"streams","result":[{"stream":{"app":"x"},"values":[` + values + `]}]}}`
}

func ts(off int64) string { return strconv.Quote(strconv.FormatInt(t0+off, 10)) }

// unit:log-decode (§4.3, T06-011, T06-024).
func TestLogDecode(t *testing.T) {
	for name, raw := range map[string]string{
		"values before stream": `{"status":"success","data":{"resultType":"streams","result":[{"values":[[` + ts(1) + `,"l"]],"stream":{"app":"x"}}]}}`,
		"three-element value":  streamDoc(`[` + ts(1) + `,"l",{"k":"v"}]`),
	} {
		r, err := logsOf(t, raw, Options{})
		if err != nil || r == nil || r.Page == nil || len(r.Page.Entries) != 1 || r.Page.Entries[0].Line != "l" {
			t.Errorf("%s: %+v %v, want one entry", name, r, err)
		}
	}
	d := newUpstreamDecoder(strings.NewReader(`"9223372036854775807"`), redactor{})
	if _, err := d.Next(); err != nil {
		t.Fatal(err)
	}
	if v, err := d.Nanos(); err != nil || v != 9223372036854775807 {
		t.Errorf("Nanos(max int64) = %d %v", v, err)
	}
	for _, tok := range []string{`"01"`, `"00"`, `"-1"`, `"9223372036854775808"`, `"1e3"`, `""`, `1`} {
		d := newUpstreamDecoder(strings.NewReader(tok), redactor{})
		if _, err := d.Next(); err != nil {
			t.Fatal(err)
		}
		if v, err := d.Nanos(); kindOf(err) != KindProtocol {
			t.Errorf("Nanos(%s) = %d %v, want KindProtocol", tok, v, err)
		}
	}
	d = newUpstreamDecoder(strings.NewReader(`"0"`), redactor{})
	_, _ = d.Next()
	if v, err := d.Nanos(); err != nil || v != 0 {
		t.Errorf(`Nanos("0") = %d %v`, v, err)
	}
	for name, raw := range map[string]string{
		"ts 01":             streamDoc(`["01","l"]`),
		"ts -1":             streamDoc(`["-1","l"]`),
		"ts over int64":     streamDoc(`["9223372036854775808","l"]`),
		"ts number token":   streamDoc(`[` + strconv.FormatInt(t0+1, 10) + `,"l"]`),
		"resultType vector": `{"status":"success","data":{"resultType":"vector","result":[]}}`,
		"status error":      `{"status":"error","data":{"resultType":"streams","result":[]}}`,
	} {
		_, err := logsOf(t, raw, Options{})
		wantProtocol(t, name, err)
	}
	_, err := logsOf(t, streamDoc(`[`+ts(1)+`,"a"],[`+ts(2)+`,"b"],[`+ts(3)+`,"c"],[`+ts(4)+`,"d"]`), Options{Limits: Limits{MaxEntries: 3}})
	wantProtocol(t, "4 entries over MaxEntries 3", err)

	// A long line is cut at 65 536 bytes and flagged.
	r, err := logsOf(t, streamDoc(`[`+ts(1)+`,"`+strings.Repeat("x", 65537)+`"]`), Options{})
	if err != nil || r == nil || r.Page == nil || len(r.Page.Entries) != 1 {
		t.Fatalf("long line: %+v %v", r, err)
	}
	p := r.Page
	if l := p.Entries[0].Line; l != strings.Repeat("x", 65536)+"…" {
		t.Errorf("long line cut to %d bytes", len(l))
	}
	if !p.Completeness.Truncated || !slices.Contains(p.Completeness.Warnings, "pulsus-dash: 1 lines cut at 65536 bytes") {
		t.Errorf("long line completeness %+v", p.Completeness)
	}
	_, err = logsOf(t, streamDoc(`[`+ts(1)+`,"`+strings.Repeat("y", 101)+`"]`), Options{Limits: Limits{PageBytes: 100}})
	if e, ok := err.(*Error); !ok || e.Kind != KindTooBroad || e.Message != "the log page is larger than 64 MiB; lower the limit or narrow the query" {
		t.Errorf("PageBytes 100: %v, want KindTooBroad with the §4.3 message", err)
	}

	// Redaction of lines and label values.
	var base atomic.Value // the upstream's own URL, set once it listens
	u := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		answer(200, `{"status":"success","data":{"resultType":"streams","result":[{"stream":{"app":"x","url":`+
			jstr(base.Load().(string))+`},"values":[[`+ts(1)+`,"login pw-secret-1 ok"]]}]}}`)(w, r)
	})
	base.Store(u.URL)
	b := testBinding(u.URL)
	b.CredentialsRef = "env:C"
	c := New(Options{Secrets: secretsOf(map[string]string{"env:C": "user:pw-secret-1"})})
	res, err := c.LogQueryRange(ctxWithin(t, 5*time.Second), rcFor(b), a1Query(10, Backward))
	if err != nil || res == nil || res.Page == nil || len(res.Page.Entries) != 1 {
		t.Fatalf("redaction: %+v %v", res, err)
	}
	if l := res.Page.Entries[0].Line; l != "login <redacted> ok" {
		t.Errorf("line %q, want the password redacted", l)
	}
	if ls := res.Page.Streams[0].Labels; len(ls) != 2 || ls[1].Value != "<redacted>" {
		t.Errorf("labels %v, want the binding URL redacted", ls)
	}
}
