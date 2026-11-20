//go:build itest

package pulsusdb

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
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
