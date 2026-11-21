package pulsusdb

import (
	"io"
	"net/http"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// seriesBody generates a matrix body of one series with n points lazily; ts(i) is the timestamp
// (s) of point i. It counts the bytes the client read, so a test can prove decoding stopped.
type seriesBody struct {
	head, tail string
	n, i       int
	ts         func(i int) int64
	buf        []byte
	read       int
}

func newSeriesBody(n int, ts func(i int) int64) *seriesBody {
	return &seriesBody{n: n, ts: ts,
		head: `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"job":"big"},"values":[`,
		tail: `]}]}}`}
}

func (b *seriesBody) Read(p []byte) (int, error) {
	for len(b.buf) == 0 {
		switch {
		case b.head != "":
			b.buf, b.head = []byte(b.head), ""
		case b.i < b.n:
			if b.i > 0 {
				b.buf = append(b.buf, ',')
			}
			b.buf = append(b.buf, '[')
			b.buf = strconv.AppendInt(b.buf, b.ts(b.i), 10)
			b.buf = append(b.buf, `,"1"]`...)
			b.i++
		case b.tail != "":
			b.buf, b.tail = []byte(b.tail), ""
		default:
			return 0, io.EOF
		}
	}
	n := copy(p, b.buf)
	b.buf = b.buf[n:]
	b.read += n
	return n, nil
}

func (b *seriesBody) Close() error { return nil }

// bodyTransport answers every request with 200 and body.
type bodyTransport struct{ body io.ReadCloser }

func (t bodyTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	_ = r.Body.Close()
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}},
		Body: t.body, Request: r}, nil
}

// review r3 #1: a range series is placed and checked point by point as it is read, so a series
// longer than the grid (off the grid past its end, or one timestamp repeated) stops decoding at
// the first bad point and allocates no more than the grid.
func TestRangeDecodingBounded(t *testing.T) {
	const points = 2_000_000 // about 40 MB of body; the grid has 721 points
	for _, c := range []struct {
		name string
		ts   func(i int) int64
	}{
		{"oversized", func(i int) int64 { return 1767225600 + 5*int64(i) }},
		{"repeated", func(int) int64 { return 1767225600 }},
	} {
		body := newSeriesBody(points, c.ts)
		cl := New(Options{Transport: bodyTransport{body}})
		var before, after runtime.MemStats
		runtime.GC()
		runtime.ReadMemStats(&before)
		rs, err := cl.QueryRange(ctxWithin(t, 30*time.Second), rcFor(testBinding("http://pulsusdb.invalid")), counterRange("q"))
		if err == nil {
			_, err = drain(rs)
			_ = rs.Close()
		}
		runtime.ReadMemStats(&after)
		alloc := after.TotalAlloc - before.TotalAlloc
		if kindOf(err) != KindProtocol {
			t.Errorf("%s: err %v, want KindProtocol", c.name, err)
		}
		if body.read > 1<<20 {
			t.Errorf("%s: the client read %d bytes; decoding must stop at the first bad point (< 1 MiB)", c.name, body.read)
		}
		if alloc > 4<<20 {
			t.Errorf("%s: decoding allocated %d bytes; a series is bounded by the grid (< 4 MiB)", c.name, alloc)
		}
	}
}

// review r4 #1: a histogram-only series is skipped without starting a grid series, so many of
// them allocate no grid each.
func TestSkippedHistogramsAllocateNoGrid(t *testing.T) {
	const n = 5000 // a grid series is 721 values and flags, about 6.5 KB; 5000 of them about 32 MB
	var b strings.Builder
	b.WriteString(`{"status":"success","data":{"resultType":"matrix","result":[`)
	for i := range n {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`{"metric":{"job":"h"},"histograms":[[1767225600,{"count":"1","sum":"1"}]]}`)
	}
	b.WriteString(`]}}`)
	body := io.NopCloser(strings.NewReader(b.String()))
	cl := New(Options{Transport: bodyTransport{body}})
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	rs, err := cl.QueryRange(ctxWithin(t, 30*time.Second), rcFor(testBinding("http://pulsusdb.invalid")), counterRange("q"))
	var ss []*Series
	if err == nil {
		ss, err = drain(rs)
		_ = rs.Close()
	}
	runtime.ReadMemStats(&after)
	if err != nil || len(ss) != 0 {
		t.Fatalf("%d series, err %v; want 0", len(ss), err)
	}
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > 8<<20 {
		t.Errorf("%d skipped histogram series allocated %d bytes; want no grid per skipped series (< 8 MiB)", n, alloc)
	}
	want := []string{"pulsus-dash: native histogram samples skipped in 5000 series"}
	if c := rs.Completeness(); c.Truncated || !slices.Equal(c.Warnings, want) {
		t.Errorf("completeness %+v, want not truncated and %q", c, want)
	}
}

// review r4 #1: a histogram-only series met at the points limit is skipped with the histogram
// warning; it does not end the response as truncated.
func TestHistogramAtPointsLimit(t *testing.T) {
	lim := DefaultLimits
	lim.MaxPoints = 721
	body := `{"status":"success","data":{"resultType":"matrix","result":[` +
		`{"metric":{"job":"a"},"values":[[1767225600,"1"]]},` +
		`{"metric":{"job":"h"},"histograms":[[1767225600,{"count":"1","sum":"1"}]]}]}}`
	rs, err := rangeOf(t, body, lim)
	if err != nil {
		t.Fatal(err)
	}
	ss, err := drain(rs)
	c := rs.Completeness()
	want := []string{"pulsus-dash: native histogram samples skipped in 1 series"}
	if err != nil || len(ss) != 1 || c.Truncated || !slices.Equal(c.Warnings, want) {
		t.Errorf("%d series err %v completeness %+v; want 1, not truncated, %q", len(ss), err, c, want)
	}
}
