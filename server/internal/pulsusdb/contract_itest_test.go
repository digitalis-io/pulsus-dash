//go:build itest

package pulsusdb

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
)

// recorder keeps the raw body of every response, for the order-compatibility check.
type recorder struct {
	mu     sync.Mutex
	bodies [][]byte
}

func (r *recorder) RoundTrip(req *http.Request) (*http.Response, error) {
	resp, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		return nil, err
	}
	b, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	r.bodies = append(r.bodies, b)
	r.mu.Unlock()
	resp.Body = io.NopCloser(bytes.NewReader(b))
	return resp, nil
}

func (r *recorder) last() []byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.bodies[len(r.bodies)-1]
}

// itest:pulsusdb-contract (T06-005, T06-011): read-only calls against a real deployment, skipped
// unless DASH_CONTRACT_PULSUSDB_URL is set.
func TestPulsusDBContract(t *testing.T) {
	base := os.Getenv("DASH_CONTRACT_PULSUSDB_URL")
	if base == "" {
		t.Skip("DASH_CONTRACT_PULSUSDB_URL is not set")
	}
	b := testBinding(base)
	b.ScopeOrgID = os.Getenv("DASH_CONTRACT_PULSUSDB_ORG")
	b.CredentialsRef = os.Getenv("DASH_CONTRACT_PULSUSDB_CREDENTIALS_REF")
	rec := &recorder{}
	c := New(Options{Transport: rec, Secrets: func(ref string) (string, error) {
		name, ok := strings.CutPrefix(ref, "env:")
		if !ok {
			return "", os.ErrNotExist
		}
		return os.Getenv(name), nil
	}})
	rc := rcFor(b)
	ctx := func() context.Context { return ctxWithin(t, 30*time.Second) }
	now := time.Now().Truncate(time.Minute)
	from := now.Add(-time.Hour)

	t.Run("RuntimeInfo", func(t *testing.T) {
		ri, err := c.RuntimeInfo(ctx(), rc)
		if err != nil || len(ri.RollupLevels) == 0 || ri.QueryID == "" {
			t.Fatalf("RuntimeInfo = %+v, %v", ri, err)
		}
	})
	t.Run("Query vector", func(t *testing.T) {
		rs, err := c.Query(ctx(), rc, InstantQuery{Query: "vector(1)", At: now, Timeout: 30 * time.Second})
		if err != nil {
			t.Fatal(err)
		}
		ss, err := drain(rs)
		if err != nil || rs.Type() != ResultVector || len(ss) != 1 || ss[0].Values[0] != 1 {
			t.Fatalf("vector(1): %q %v %v", rs.Type(), ss, err)
		}
		compareGeneric(t, rec.last(), ss)
	})
	t.Run("Query scalar", func(t *testing.T) {
		rs, err := c.Query(ctx(), rc, InstantQuery{Query: "scalar(vector(1)) / 0", At: now, Timeout: 30 * time.Second})
		if err != nil {
			t.Fatal(err)
		}
		if _, v, ok := rs.Scalar(); rs.Type() != ResultScalar || !ok || !math.IsInf(v, 1) {
			t.Fatalf("scalar: %q %v %v", rs.Type(), v, ok)
		}
	})
	t.Run("QueryRange", func(t *testing.T) {
		rs, err := c.QueryRange(ctx(), rc, RangeQuery{Query: "vector(1)", Start: from, End: now, Step: time.Minute, Timeout: 30 * time.Second})
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rs.Close() }()
		ss, err := drain(rs)
		if err != nil || len(ss) != 1 || len(ss[0].Timestamps) != 61 {
			t.Fatalf("range: %d series %v", len(ss), err)
		}
		for i, p := range ss[0].Present {
			if !p || ss[0].Timestamps[i] != from.UnixMilli()+int64(i)*60_000 {
				t.Fatalf("point %d absent or off the grid", i)
			}
		}
		compareGeneric(t, rec.last(), ss)
	})
	mq := MatchQuery{Match: []string{"up"}, Start: from, End: now, Limit: 1}
	t.Run("Series", func(t *testing.T) {
		r, err := c.Series(ctx(), rc, mq)
		if err != nil || len(r.Series) > 1 || !r.Completeness.Truncated {
			t.Fatalf("Series = %+v %v", r, err)
		}
	})
	t.Run("Labels", func(t *testing.T) {
		q := mq
		q.Limit = 2
		r, err := c.Labels(ctx(), rc, q)
		if err != nil || len(r.Values) > 2 || !r.Completeness.Truncated {
			t.Fatalf("Labels = %+v %v", r, err)
		}
	})
	t.Run("LabelValues", func(t *testing.T) {
		q := mq
		q.Limit, q.Match = 2, nil
		r, err := c.LabelValues(ctx(), rc, "__name__", q)
		if err != nil || len(r.Values) > 2 || !r.Completeness.Truncated {
			t.Fatalf("LabelValues = %+v %v", r, err)
		}
	})
	t.Run("Metadata", func(t *testing.T) {
		r, err := c.Metadata(ctx(), rc, MetadataQuery{Limit: 1})
		if err != nil || len(r.Metrics) != 1 {
			t.Fatalf("Metadata = %+v %v", r, err)
		}
		for _, ms := range r.Metrics {
			if len(ms) == 0 || ms[0].Type == "" {
				t.Fatalf("Metadata entry without a type: %+v", ms)
			}
		}
	})
	t.Run("QueryInvalid", func(t *testing.T) {
		_, err := c.Query(ctx(), rc, InstantQuery{Query: "sum(", At: now, Timeout: 30 * time.Second})
		e, ok := err.(*Error)
		if !ok || e.Kind != KindQueryInvalid || e.Message == "" || (e.Position != nil && (e.Position.Offset < 0 || e.Position.Offset > 4)) {
			t.Fatalf("sum( = %v", err)
		}
	})
	t.Run("TooBroad", func(t *testing.T) {
		rs, err := c.Query(ctx(), rc, InstantQuery{Query: `{__name__=~".+"}`, At: now, Timeout: 30 * time.Second})
		if err == nil {
			_ = rs.Close()
			t.Skip("the deployment is below its cardinality cap")
		}
		if kindOf(err) != KindTooBroad {
			t.Fatalf("name-less selector = %v, want KindTooBroad", err)
		}
	})
	t.Run("logql", func(t *testing.T) { contractLogQL(t, c, rc) })
}

// compareGeneric decodes raw with encoding/json and checks the client saw the same labels and values.
func compareGeneric(t *testing.T, raw []byte, ss []*Series) {
	t.Helper()
	var doc struct {
		Data struct {
			Result []struct {
				Metric map[string]string `json:"metric"`
				Values [][2]any          `json:"values"`
				Value  [2]any            `json:"value"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("generic decode: %v", err)
	}
	if len(doc.Data.Result) != len(ss) {
		t.Fatalf("%d series generic, %d by the client", len(doc.Data.Result), len(ss))
	}
	for i, r := range doc.Data.Result {
		keys := make([]string, 0, len(r.Metric))
		for k := range r.Metric {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for j, k := range keys {
			if ss[i].Labels[j].Name != k || ss[i].Labels[j].Value != r.Metric[k] {
				t.Errorf("series %d label %d differs", i, j)
			}
		}
		points := r.Values
		if len(points) == 0 {
			points = [][2]any{r.Value}
		}
		n := 0
		for k, p := range ss[i].Present {
			if !p {
				continue
			}
			want, _ := strconv.ParseFloat(points[n][1].(string), 64)
			if math.Float64bits(ss[i].Values[k]) != math.Float64bits(want) {
				t.Errorf("series %d point %d differs", i, n)
			}
			n++
		}
		if n != len(points) {
			t.Errorf("series %d: %d points generic, %d by the client", i, len(points), n)
		}
	}
}

// rawLogs is one raw log query_range answer, decoded generically (tests only).
type rawLogs struct {
	status    int
	ctype     string
	text      string
	typeFirst bool
	entries   []refEntry
}

// rawLogQuery sends one GET /api/logs/v1/query_range through the client's transport, decorated
// as the client decorates.
func rawLogQuery(ctx context.Context, c *Client, rc *core.RequestCtx, form url.Values) (rawLogs, error) {
	cred, err := c.credential(ctx, rc)
	if err != nil {
		return rawLogs{}, err
	}
	req, err := c.request(ctx, rc.Tenant.Binding, call{method: http.MethodGet, path: "/api/logs/v1/query_range"}, form, cred)
	if err != nil {
		return rawLogs{}, err
	}
	resp, err := c.http.Do(req) // #nosec G704 -- the contract binding's configured URL, from the environment
	if err != nil {
		return rawLogs{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return rawLogs{}, err
	}
	out := rawLogs{status: resp.StatusCode, ctype: resp.Header.Get("Content-Type"), text: string(b)}
	if resp.StatusCode != http.StatusOK {
		return out, nil
	}
	rt, rs := bytes.Index(b, []byte(`"resultType"`)), bytes.Index(b, []byte(`"result"`))
	out.typeFirst = rt >= 0 && rt < rs
	var doc struct {
		Data struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Stream map[string]string `json:"stream"`
				Values [][]any           `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		return out, err
	}
	if doc.Data.ResultType != "streams" {
		return out, fmt.Errorf("resultType %q", doc.Data.ResultType)
	}
	for _, r := range doc.Data.Result {
		var ls []Label
		for k, v := range r.Stream {
			ls = append(ls, Label{Name: k, Value: v})
		}
		key := keyhash.Labels(ls)
		for _, v := range r.Values {
			ts, err := strconv.ParseInt(v[0].(string), 10, 64)
			if err != nil {
				return out, err
			}
			out.entries = append(out.entries, refEntry{TsNs: ts, StreamKey: key, Line: v[1].(string)})
		}
	}
	return out, nil
}

func logForm(query string, lo, hi int64, limit int, dir string, enc func(int64) string) url.Values {
	return url.Values{"query": {query}, "start": {enc(lo)}, "end": {enc(hi)}, "limit": {strconv.Itoa(limit)}, "direction": {dir}}
}

func refCmp(a, b refEntry) int {
	if c := cmp.Compare(a.TsNs, b.TsNs); c != 0 {
		return c
	}
	if c := cmp.Compare(a.StreamKey, b.StreamKey); c != 0 {
		return c
	}
	return strings.Compare(a.Line, b.Line)
}

// multiset is es sorted, for comparison as a multiset.
func multiset(es []refEntry) []refEntry {
	out := slices.Clone(es)
	slices.SortFunc(out, refCmp)
	return out
}

// contractLogQL is the logql subtest of itest:pulsusdb-contract (#65 A.3).
func contractLogQL(t *testing.T, c *Client, rc *core.RequestCtx) {
	sel := os.Getenv("DASH_CONTRACT_LOGQL_SELECTOR")
	if sel == "" {
		t.Skip("DASH_CONTRACT_LOGQL_SELECTOR is not set")
	}
	ctx := func() context.Context { return ctxWithin(t, 30*time.Second) }
	now := time.Now().UnixNano()
	fetch := func(ctx context.Context, lo, hi int64) ([]refEntry, error) {
		r, err := rawLogQuery(ctx, c, rc, logForm(sel, lo, hi, 5000, "backward", nsParam))
		if err == nil && r.status != http.StatusOK {
			err = fmt.Errorf("status %d", r.status)
		}
		return r.entries, err
	}
	lo, hi, ref, out, n, err := reduceRefWindow(ctx(), fetch, now-int64(15*time.Minute), now-int64(5*time.Minute))
	if err != nil {
		t.Fatalf("reference window: %v", err)
	}
	if out != refOK {
		t.Skip(refSkipReason(out, n, hi-lo))
	}
	if len(ref) == 0 {
		t.Fatal("reference window: an empty answer after a non-empty one")
	}
	t.Logf("reference: %d entries in (%d, %d] after %d requests", len(ref), lo, hi, n)
	T := slices.MaxFunc(ref, refCmp).TsNs
	raw := func(lo, hi int64, limit int, dir string) rawLogs {
		t.Helper()
		r, err := rawLogQuery(ctx(), c, rc, logForm(sel, lo, hi, limit, dir, nsParam))
		if err != nil || r.status != http.StatusOK {
			t.Fatalf("raw (%d, %d] limit %d %s: %d %v", lo, hi, limit, dir, r.status, err)
		}
		return r
	}
	has := func(es []refEntry, ts int64) bool {
		return slices.ContainsFunc(es, func(e refEntry) bool { return e.TsNs == ts })
	}

	t.Run("window", func(t *testing.T) {
		if !has(raw(lo, T, 5000, "backward").entries, T) || has(raw(lo, T-1, 5000, "backward").entries, T) ||
			!has(raw(T-1, hi, 5000, "forward").entries, T) || has(raw(T, hi, 5000, "forward").entries, T) {
			t.Error("the log window is not (start, end]")
		}
	})
	t.Run("encoding", func(t *testing.T) {
		r, err := rawLogQuery(ctx(), c, rc, logForm(sel, lo, hi, 5000, "backward", func(v int64) string { return strconv.FormatInt(v, 10) }))
		if err != nil || !slices.Equal(multiset(r.entries), multiset(ref)) {
			t.Errorf("unpadded and %%019d differ: %d vs %d entries, %v", len(r.entries), len(ref), err)
		}
	})
	t.Run("property a", func(t *testing.T) {
		counts := map[int64]int{}
		for _, e := range ref {
			counts[e.TsNs]++
		}
		var ties []int64
		for ts, k := range counts {
			if k >= 2 {
				ties = append(ties, ts)
			}
		}
		slices.Sort(ties)
		if len(ties) == 0 {
			t.Log("no tie in window")
			return
		}
		for _, ts := range ties[:min(6, len(ties))] {
			want := multiset(slices.DeleteFunc(slices.Clone(ref), func(e refEntry) bool { return e.TsNs != ts }))
			for _, dir := range []string{"backward", "forward"} {
				if got := multiset(raw(ts-1, ts, 5000, dir).entries); !slices.Equal(got, want) {
					t.Errorf("group fetch at %d %s: %d entries, want %d", ts, dir, len(got), len(want))
				}
			}
		}
	})
	t.Run("property b", func(t *testing.T) {
		for _, limit := range []int{1, 7, 50} {
			for _, dir := range []string{"backward", "forward"} {
				es := raw(lo, hi, limit, dir).entries
				if len(es) == 0 {
					t.Fatalf("limit %d %s: empty", limit, dir)
				}
				edge := slices.MinFunc(es, refCmp).TsNs
				if dir == "forward" {
					edge = slices.MaxFunc(es, refCmp).TsNs
				}
				before := func(ts int64) bool { return (dir == "backward" && ts > edge) || (dir == "forward" && ts < edge) }
				got := multiset(slices.DeleteFunc(slices.Clone(es), func(e refEntry) bool { return !before(e.TsNs) }))
				want := multiset(slices.DeleteFunc(slices.Clone(ref), func(e refEntry) bool { return !before(e.TsNs) }))
				if !slices.Equal(got, want) {
					t.Errorf("limit %d %s: %d entries before the edge, reference %d", limit, dir, len(got), len(want))
				}
			}
		}
	})
	t.Run("member order", func(t *testing.T) {
		t.Logf("resultType precedes result: %v", raw(lo, hi, 10, "backward").typeFirst)
	})
	t.Run("text errors", func(t *testing.T) {
		r, err := rawLogQuery(ctx(), c, rc, logForm(sel[:len(sel)-1], lo, hi, 10, "backward", nsParam))
		if err != nil || r.status != 400 || !strings.HasPrefix(r.ctype, "text/plain") || !regexp.MustCompile(`at byte [0-9]+`).MatchString(r.text) {
			t.Errorf("truncated selector: %d %q %v", r.status, r.ctype, err)
		}
		if r, err := rawLogQuery(ctx(), c, rc, logForm(sel, lo, hi, 5001, "backward", nsParam)); err != nil || r.status != 400 {
			t.Errorf("limit 5001: %d %v, want 400", r.status, err)
		}
	})
	q := func(limit int) LogRangeQuery {
		g, err := PromGrid(floorDiv(lo, 1e6), -floorDiv(-hi, 1e6), 1200)
		if err != nil {
			t.Fatal(err)
		}
		return LogRangeQuery{Query: sel, Grid: g, Window: LogWindow{LoNs: lo, HiNs: hi}, Limit: limit, Direction: Backward}
	}
	collect := func(limit int) []refEntry {
		t.Helper()
		qq := q(limit)
		var all []refEntry
		for range 10_000 {
			r, err := c.LogQueryRange(ctx(), rc, qq)
			if err != nil || r.Page == nil {
				t.Fatalf("LogQueryRange limit %d: %v", limit, err)
			}
			var page []refEntry
			for _, e := range r.Page.Entries {
				page = append(page, refEntry{TsNs: e.TsNs, StreamKey: r.Page.Streams[e.Stream].Key, Line: e.Line})
			}
			if !slices.IsSortedFunc(page, func(a, b refEntry) int { return cmp.Compare(b.TsNs, a.TsNs) }) {
				t.Fatalf("limit %d: a page is not in page order", limit)
			}
			all = append(all, page...)
			if r.Page.Next == nil {
				return all
			}
			qq.After = r.Page.Next
		}
		t.Fatalf("limit %d: paging did not end", limit)
		return nil
	}
	t.Run("paging", func(t *testing.T) {
		if a, b := multiset(collect(5000)), multiset(collect(3)); !slices.Equal(a, b) {
			t.Errorf("limit 5000 gave %d entries, limit 3 gave %d", len(a), len(b))
		}
	})
	t.Run("request shape", func(t *testing.T) {
		// The tested shape: GET with a query string and step=<n>ms; a URL over 8 KiB falls back
		// to a POST form. Both must be accepted.
		long := q(10)
		long.Query = sel + ` |= "` + strings.Repeat("z", maxGetQuery) + `"`
		r, err := c.LogQueryRange(ctx(), rc, long)
		var pe *Error
		if err != nil && (!errors.As(err, &pe) || pe.Kind != KindTooBroad) {
			t.Errorf("POST fallback: %v", err)
		} else if err == nil && r.Page == nil {
			t.Error("POST fallback: no page")
		}
		g, err := rawLogQuery(ctx(), c, rc, logForm(long.Query, lo, hi, 10, "backward", nsParam))
		t.Logf("a GET with a %d-byte query: status %d, %v", len(long.Query), g.status, err)
	})
}
