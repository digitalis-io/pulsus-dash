package pulsusdb

import (
	"io"
	"net/http"
	"runtime"
	"strconv"
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
