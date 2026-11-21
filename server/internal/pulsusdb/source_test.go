package pulsusdb

import (
	"context"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"
)

// rawSeries is one series of fakeSource: labels and points as a body would give them.
type rawSeries struct {
	Labels []Label
	T      []int64 // ms
	V      []float64
}

// fakeSource is a non-JSON source: it hands the series it holds to the sink point by point.
type fakeSource struct {
	series []rawSeries
	i      int
}

func (f *fakeSource) openRange() error { return nil }

func (f *fakeSource) nextRange(sink seriesSink) ([]Label, error) {
	if f.i == len(f.series) {
		return nil, io.EOF
	}
	r := f.series[f.i]
	f.i++
	if err := sink.begin(); err != nil {
		return nil, err
	}
	for i, ms := range r.T {
		if err := sink.add(ms, r.V[i]); err != nil {
			return nil, err
		}
	}
	return r.Labels, nil
}

func (f *fakeSource) readInstant() (instantResult, error) { return instantResult{}, nil }

func fakeStream(src seriesSource, lim Limits) *ResultStream {
	resp := &response{body: io.NopCloser(strings.NewReader("")), release: func() {}}
	return newRangeStream(context.Background(), src, resp, lim, newComp(upstreamHeaders{}, lim), Grid{Start: 0, End: 20000, Step: 5000})
}

// Grid placement happens after decoding, in ResultStream, so every source shares it (Arrow seam).
func TestPlacementAfterDecoding(t *testing.T) {
	src := &fakeSource{series: []rawSeries{
		{Labels: []Label{{Name: "job", Value: "a"}}, T: []int64{0, 10000, 20000}, V: []float64{1, 2, 3}},
		{Labels: []Label{{Name: "job", Value: "b"}}, T: []int64{5000}, V: []float64{4}},
	}}
	rs := fakeStream(src, withDefaults(Limits{}))
	ss, err := drain(rs)
	if err != nil || len(ss) != 2 {
		t.Fatalf("%d series, err %v; want 2", len(ss), err)
	}
	if !slices.Equal(ss[0].Present, []bool{true, false, true, false, true}) || !slices.Equal(ss[0].Values, []float64{1, 0, 2, 0, 3}) ||
		!slices.Equal(ss[0].Timestamps, []int64{0, 5000, 10000, 15000, 20000}) {
		t.Errorf("series a placed as %v %v %v", ss[0].Timestamps, ss[0].Values, ss[0].Present)
	}
	if !slices.Equal(ss[1].Present, []bool{false, true, false, false, false}) || ss[1].Values[1] != 4 {
		t.Errorf("series b placed as %v %v", ss[1].Values, ss[1].Present)
	}
	if c := rs.Completeness(); c.NewestSampleMs != 20000 {
		t.Errorf("NewestSampleMs = %d, want 20000", c.NewestSampleMs)
	}

	off := fakeStream(&fakeSource{series: []rawSeries{{Labels: []Label{}, T: []int64{1000}, V: []float64{1}}}}, withDefaults(Limits{}))
	_, err = drain(off)
	wantProtocol(t, "off grid from a non-JSON source", err)

	lim := withDefaults(Limits{})
	lim.MaxPoints = 5
	cut := fakeStream(&fakeSource{series: []rawSeries{{Labels: []Label{}, T: []int64{0}, V: []float64{1}}, {Labels: []Label{}, T: []int64{0}, V: []float64{1}}}}, lim)
	ss, err = drain(cut)
	if c := cut.Completeness(); err != nil || len(ss) != 1 || !c.Truncated {
		t.Errorf("points cut: %d series err %v completeness %+v; want 1 and truncated", len(ss), err, c)
	}
}

// Success bodies are dispatched on Content-Type; Accept is chosen in one place.
func TestBodyFormat(t *testing.T) {
	for ct, ok := range map[string]bool{
		"application/json": true, "application/json; charset=utf-8": true, "Application/JSON": true,
		"text/plain": false, "": false, "application/vnd.apache.arrow.stream": false,
	} {
		f, got := formatOf(ct)
		if got != ok || (ok && f != formatJSON) {
			t.Errorf("formatOf(%q) = %v %v, want ok %v", ct, f, got, ok)
		}
	}
	u := newUpstream(t, answer(200, okLabels))
	if _, err := New(Options{}).Labels(ctxWithin(t, 10*time.Second), rcFor(testBinding(u.URL)), labelsQuery()); err != nil {
		t.Fatal(err)
	}
	for _, r := range u.requests() {
		if r.Header.Get("Accept") != acceptHeader {
			t.Errorf("%s %s: Accept %q, want %q", r.Method, r.Path, r.Header.Get("Accept"), acceptHeader)
		}
	}
	text := newUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = io.WriteString(w, okLabels)
	})
	_, err := New(Options{}).Labels(ctxWithin(t, 10*time.Second), rcFor(testBinding(text.URL)), labelsQuery())
	wantProtocol(t, "text/plain success body", err)
}
