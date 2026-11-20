package pulsusdb

import (
	"errors"
	"io"
	"math"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
)

const counterBody = `{"status":"success","data":{"resultType":"matrix","result":[` +
	`{"metric":{"job":"api","instance":"a:9090"},"values":[[1767225600,"0.1"],[1767225605,"NaN"],` +
	`[1767225610,"+Inf"],[1767225615,"-Inf"],[1767225625,"-0"],[1767225630,"5e-324"],` +
	`[1767225635,"0.30000000000000004"],[1767229200,"1e+308"]]},` +
	`{"metric":{"instance":"b:9090","job":"api"},"values":[[1767225600,"2"],[1767229200,"3"]]}]}}`

// rangeOf runs QueryRange of q against an upstream answering body.
func rangeOf(t *testing.T, body string, lim Limits, kv ...string) (*ResultStream, error) {
	t.Helper()
	u := newUpstream(t, answer(200, body, kv...))
	c := New(Options{Limits: lim})
	rs, err := c.QueryRange(ctxWithin(t, 10*time.Second), rcFor(testBinding(u.URL)), counterRange("q"))
	if rs != nil {
		t.Cleanup(func() { _ = rs.Close() })
	}
	return rs, err
}

// drain reads every series until EOF or an error.
func drain(rs *ResultStream) ([]*Series, error) {
	var out []*Series
	for {
		s, err := rs.Next()
		if errors.Is(err, io.EOF) {
			return out, nil
		}
		if err != nil {
			return out, err
		}
		out = append(out, s)
	}
}

// unit:stream-decode (T06-008, T06-011, T04-005).
func TestStreamCounter(t *testing.T) {
	rs, err := rangeOf(t, counterBody, Limits{}, "X-Pulsus-Query-Id", "fake-counter-1", "X-Pulsus-Read-Cache", "miss",
		"X-Pulsus-Read-Cache-Through", "1767229")
	if err != nil {
		t.Fatal(err)
	}
	if rs.Type() != ResultMatrix {
		t.Errorf("Type = %q", rs.Type())
	}
	ss, err := drain(rs)
	if err != nil || len(ss) != 2 {
		t.Fatalf("%d series, err %v; want 2", len(ss), err)
	}
	s := ss[0]
	wantLabels := []Label{{Name: "instance", Value: "a:9090"}, {Name: "job", Value: "api"}}
	if !slices.Equal(s.Labels, wantLabels) || s.Key != keyhash.Labels(wantLabels) {
		t.Errorf("labels %v key %x, want sorted %v", s.Labels, s.Key, wantLabels)
	}
	if len(s.Timestamps) != 721 || len(s.Values) != 721 || len(s.Present) != 721 {
		t.Fatalf("lengths %d %d %d, want 721", len(s.Timestamps), len(s.Values), len(s.Present))
	}
	for i, ts := range s.Timestamps {
		if ts != 1767225600000+int64(i)*5000 {
			t.Fatalf("timestamp %d = %d, off the grid", i, ts)
		}
	}
	want := map[int]string{0: "0.1", 1: "NaN", 2: "+Inf", 3: "-Inf", 5: "-0", 6: "5e-324", 7: "0.30000000000000004", 720: "1e+308"}
	for i := range 721 {
		w, ok := want[i]
		if s.Present[i] != ok {
			t.Errorf("present[%d] = %v, want %v", i, s.Present[i], ok)
			continue
		}
		if !ok {
			continue
		}
		f, _ := strconv.ParseFloat(w, 64)
		if math.Float64bits(s.Values[i]) != math.Float64bits(f) {
			t.Errorf("value[%d] = %v, want %s bit for bit", i, s.Values[i], w)
		}
	}
	c := rs.Completeness()
	if c.Truncated || c.QueryID != "fake-counter-1" || c.ReadCache != "miss" || c.ReadCacheThroughMs != 1767229 ||
		c.NewestSampleMs != 1767229200000 || c.Warnings == nil || c.Infos == nil {
		t.Errorf("completeness %+v", c)
	}
	if err := rs.Close(); err != nil {
		t.Error(err)
	}
	if err := rs.Close(); err != nil {
		t.Errorf("second Close: %v", err)
	}
}

func TestStreamShapes(t *testing.T) {
	series := `{"metric":{"job":"api"},"values":[[1767225600,"1"]]}`
	for _, c := range []struct {
		name, body string
		n          int
		truncated  bool
		warnings   []string
	}{
		{"warnings first", `{"warnings":["w1"],"data":{"result":[` + series + `],"resultType":"matrix"},"status":"success"}`, 1, false, []string{"w1"}},
		{"flagged", `{"status":"success","data":{"resultType":"matrix","truncated":true,"result":[` + series + `]}}`, 1, true, []string{}},
		{"top-level flag", `{"status":"success","truncated":true,"data":{"resultType":"matrix","result":[` + series + `]}}`, 1, true, []string{}},
		{"reordered", `{"data":{"result":[{"values":[[1767225600,"1"]],"metric":{"job":"api"}}],"resultType":"matrix"},"warnings":[],"status":"success"}`, 1, false, []string{}},
		{"truncation warning", `{"status":"success","data":{"resultType":"matrix","result":[` + series + `]},"warnings":["results truncated due to limit"]}`, 1, true, []string{"results truncated due to limit"}},
		{"truncation info", `{"status":"success","data":{"resultType":"matrix","result":[]},"infos":["Results TRUNCATED"]}`, 0, true, []string{}},
		{"unknown keys", `{"status":"success","x":{"y":[1,2]},"data":{"z":null,"resultType":"matrix","result":[` + series + `]}}`, 1, false, []string{}},
	} {
		rs, err := rangeOf(t, c.body, Limits{})
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		ss, err := drain(rs)
		comp := rs.Completeness()
		if err != nil || len(ss) != c.n || comp.Truncated != c.truncated || !slices.Equal(comp.Warnings, c.warnings) || comp.Warnings == nil {
			t.Errorf("%s: %d series err %v completeness %+v; want %d truncated %v warnings %q", c.name, len(ss), err, comp, c.n, c.truncated, c.warnings)
		}
	}
}

func TestStreamProtocolErrors(t *testing.T) {
	head := `{"status":"success","data":{"resultType":"matrix","result":[`
	// Failing when QueryRange returns.
	for _, c := range []struct{ name, body string }{
		{"vector on range", `{"status":"success","data":{"resultType":"vector","result":[]}}`},
		{"error status", `{"status":"error","data":{"resultType":"matrix","result":[]}}`},
		{"not json", `<html>`},
		{"not an object", `[1]`},
	} {
		rs, err := rangeOf(t, c.body, Limits{})
		if err == nil {
			_, err = drain(rs)
		}
		wantProtocol(t, c.name, err)
	}
	// Failing on Next.
	for _, c := range []struct{ name, body string }{
		{"off grid", head + `{"metric":{},"values":[[1767225601,"1"]]}]}}`},
		{"before start", head + `{"metric":{},"values":[[1767225595,"1"]]}]}}`},
		{"exponent timestamp", head + `{"metric":{},"values":[[1.767225600e9,"1"]]}]}}`},
		{"value element", head + `{"metric":{},"value":[1767225600,"1"]}]}}`},
		{"non-object element", head + `1]}}`},
		{"value not a float", head + `{"metric":{},"values":[[1767225600,"abc"]]}]}}`},
		{"value a number", head + `{"metric":{},"values":[[1767225600,1]]}]}}`},
		{"missing metric", head + `{"values":[[1767225600,"1"]]}]}}`},
		{"vector after result", `{"status":"success","data":{"result":[{"metric":{},"values":[[1767225600,"1"]]}],"resultType":"vector"}}`},
		{"error status after", head + `{"metric":{},"values":[[1767225600,"1"]]}]},"status":"error"}`},
		{"truncated body", head + `{"metric":{},"values":[[1767225600,"1"]]}`},
	} {
		rs, err := rangeOf(t, c.body, Limits{})
		if err == nil {
			_, err = drain(rs)
		}
		wantProtocol(t, c.name, err)
	}
}

func TestStreamMaxPoints(t *testing.T) {
	lim := DefaultLimits
	lim.MaxPoints = 721
	rs, err := rangeOf(t, counterBody, lim)
	if err != nil {
		t.Fatal(err)
	}
	ss, err := drain(rs)
	c := rs.Completeness()
	if err != nil || len(ss) != 1 || !c.Truncated || !slices.Equal(c.Warnings, []string{"pulsus-dash: response truncated at 721 points"}) {
		t.Errorf("%d series err %v completeness %+v; want 1 and the truncation warning", len(ss), err, c)
	}
}

func TestInstantShapes(t *testing.T) {
	run := func(body string) (*ResultStream, error) {
		up := newUpstream(t, answer(200, body))
		return New(Options{}).Query(ctxWithin(t, 10*time.Second), rcFor(testBinding(up.URL)),
			InstantQuery{Query: "q", At: time.UnixMilli(1767229200000), Timeout: 30 * time.Second})
	}
	rs, err := run(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{"__name__":"m"},"value":[1700000000.5,"1.5e9"]},{"value":[1700000000,"NaN"],"metric":{}}]}}`)
	if err != nil {
		t.Fatal(err)
	}
	ss, err := drain(rs)
	if err != nil || rs.Type() != ResultVector || len(ss) != 2 || ss[0].Timestamps[0] != 1700000000500 || ss[0].Values[0] != 1.5e9 || !ss[0].Present[0] || !math.IsNaN(ss[1].Values[0]) {
		t.Errorf("vector: type %q %d series err %v", rs.Type(), len(ss), err)
	}
	if c := rs.Completeness(); c.NewestSampleMs != -1 {
		t.Errorf("instant NewestSampleMs = %d, want -1", c.NewestSampleMs)
	}
	rs, err = run(`{"status":"success","data":{"resultType":"scalar","result":[1767229200,"+Inf"]}}`)
	if err != nil {
		t.Fatal(err)
	}
	if ts, v, ok := rs.Scalar(); rs.Type() != ResultScalar || !ok || ts != 1767229200000 || !math.IsInf(v, 1) {
		t.Errorf("scalar: %q %d %v %v", rs.Type(), ts, v, ok)
	}
	rs, err = run(`{"status":"success","data":{"resultType":"string","result":[1767229200.25,"hello"]}}`)
	if err != nil {
		t.Fatal(err)
	}
	if ts, v, ok := rs.StringValue(); rs.Type() != ResultString || !ok || ts != 1767229200250 || v != "hello" {
		t.Errorf("string: %q %d %q %v", rs.Type(), ts, v, ok)
	}
	rs, err = run(`{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"a":"b"},"values":[[1767225600,"1"],[1767225601,"2"]]}]}}`)
	if err != nil {
		t.Fatal(err)
	}
	if ss, err := drain(rs); err != nil || len(ss) != 1 || !slices.Equal(ss[0].Timestamps, []int64{1767225600000, 1767225601000}) {
		t.Errorf("instant matrix: %v %v", ss, err)
	}
	_, err = run(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1e9,"1"]}]}}`)
	wantProtocol(t, "1e9 timestamp", err)
	_, err = run(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[-1,"1"]}]}}`)
	wantProtocol(t, "signed timestamp", err)
	_, err = run(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1.2345,"1"]}]}}`)
	wantProtocol(t, "4 fraction digits", err)
	rs, err = run(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{},"value":[1.2340,"1"]}]}}`)
	if err == nil {
		if ss, err := drain(rs); err != nil || ss[0].Timestamps[0] != 1234 {
			t.Errorf("trailing zero fraction: %v %v", ss, err)
		}
	} else {
		t.Errorf("trailing zero fraction: %v", err)
	}
}
