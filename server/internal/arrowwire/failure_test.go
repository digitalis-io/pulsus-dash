package arrowwire

import (
	"bytes"
	"errors"
	"io"
	"reflect"
	"strings"
	"testing"
)

// An oversized coverage or error given to Fail still closes the part on the wire (outcome (b)):
// the closing labels batch, a bounded partial META and the ERROR with the upstream code; the
// Writer stays usable for the next part.
func TestFailOversized(t *testing.T) {
	big := strings.Repeat("w", 40<<20)
	cases := []struct {
		name string
		cov  Coverage
		row  ErrorRow
	}{
		{"coverage past MaxPayload", Coverage{Phase: PhasePartial, Warnings: []string{big, big}, SeriesReturned: 1},
			ErrorRow{Code: 1, HTTPStatus: 422, Message: "too broad", Suggestion: ptr("add a label matcher")}},
		{"error past MaxPayload", Coverage{Phase: PhasePartial, SeriesReturned: 1},
			ErrorRow{Code: 5, HTTPStatus: 504, Message: big + big, Position: ptr(uint32(3))}},
	}
	for _, c := range cases {
		w, buf := completedPart(t)
		p, err := w.Grid(gridSpec(3, 4, 4), Coverage{})
		mustOK(t, err)
		mustOK(t, p.Add(rampSeries(0, 4)))
		open := buf.Len()
		if err := p.Fail(c.cov, c.row); !errors.Is(err, ErrFrameTooLarge) {
			t.Errorf("%s: Fail %v, want ErrFrameTooLarge", c.name, err)
		}
		rest := splitFrames(t, buf.Bytes()[open:])
		want := []seqItem{{FrameBatch, 3, FlagLast}, {FrameMeta, 4, 0}, {FrameError, 4, FlagLast}}
		if got := frameSeq(t, buf.Bytes()[open:]); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: close %v, want %v", c.name, got, want)
		}
		cov := coverageOf(t, rest[1].Payload)
		if cov.Phase != uint8(PhasePartial) || !cov.Truncated || cov.TruncationReason == nil || cov.SeriesReturned != 1 {
			t.Errorf("%s: bounded coverage %+v", c.name, cov)
		}
		n := 0
		for _, s := range append(append(append(cov.ExcludedDims, cov.Warnings...), cov.Infos...), cov.UpstreamQueryIDs...) {
			n += len(s)
		}
		if n > boundListBytes {
			t.Errorf("%s: %d list bytes kept", c.name, n)
		}
		e := errorOf(t, rest[2].Payload)
		if e.Code != c.row.Code || e.HTTPStatus != c.row.HTTPStatus || !reflect.DeepEqual(e.Position, c.row.Position) {
			t.Errorf("%s: error %d %d, want the upstream %d %d", c.name, e.Code, e.HTTPStatus, c.row.Code, c.row.HTTPStatus)
		}
		if len(c.row.Message) <= boundMessage && e.Message != c.row.Message {
			t.Errorf("%s: message %q, want %q", c.name, e.Message, c.row.Message)
		}
		if len(c.row.Message) > boundMessage && (len(e.Message) > boundMessage || !strings.HasSuffix(e.Message, cutMarker)) {
			t.Errorf("%s: message of %d bytes not cut to the bound", c.name, len(e.Message))
		}
		if err := p.Add(rampSeries(1, 4)); !errors.Is(err, ErrOrder) {
			t.Errorf("%s: later Add %v, want ErrOrder", c.name, err)
		}
		q, err := w.Grid(gridSpec(5, 6, 4), Coverage{})
		mustOK(t, err)
		mustOK(t, q.Add(rampSeries(0, 4)))
		mustOK(t, q.Finish(Coverage{Phase: PhaseFinal, SeriesReturned: 1}))
		mustOK(t, w.End())
		if got := readBody(t, buf.Bytes()); len(got.Parts) != 3 {
			t.Errorf("%s: %d parts read back, want 3", c.name, len(got.Parts))
		}
	}
}

// failWriter accepts limit bytes, then fails; short makes it return a short count instead.
type failWriter struct {
	buf   bytes.Buffer
	limit int
	short bool
	calls int
}

var errSink = errors.New("sink failed")

func (f *failWriter) Write(b []byte) (int, error) {
	f.calls++
	room := f.limit - f.buf.Len()
	if len(b) <= room {
		return f.buf.Write(b)
	}
	f.buf.Write(b[:max(room, 0)])
	if f.short {
		return max(room, 0), nil
	}
	return max(room, 0), errSink
}

// A write error or a short write of the io.Writer is sticky: the call returns it, and every
// later call returns it without writing.
func TestStickyWriteError(t *testing.T) {
	for _, short := range []bool{false, true} {
		for _, limit := range []int{0, 10, 2000} {
			fw := &failWriter{limit: limit, short: short}
			w := NewWriter(fw)
			p, err := w.Grid(gridSpec(1, 2, 4), Coverage{})
			want := errSink
			if short {
				want = io.ErrShortWrite
			}
			if !errors.Is(err, want) {
				t.Fatalf("short=%v limit=%d: Grid %v, want %v", short, limit, err, want)
			}
			if p != nil {
				t.Errorf("short=%v limit=%d: Grid returned a part", short, limit)
			}
			n, calls := fw.buf.Len(), fw.calls
			for name, call := range map[string]func() error{
				"Grid":  func() error { _, err := w.Grid(gridSpec(3, 4, 4), Coverage{}); return err },
				"Error": func() error { return w.Error(5, 0, ErrorRow{Message: "x"}) },
				"End":   w.End,
			} {
				if err := call(); !errors.Is(err, want) {
					t.Errorf("short=%v limit=%d: later %s %v, want the sticky %v", short, limit, name, err, want)
				}
			}
			if fw.buf.Len() != n || fw.calls != calls {
				t.Errorf("short=%v limit=%d: %d more bytes, %d more writes after the error", short, limit, fw.buf.Len()-n, fw.calls-calls)
			}
		}
	}

	// A write error inside an open part: Add, Flush, Finish and Fail all return it.
	fw := &failWriter{limit: 1 << 30}
	w := NewWriter(fw)
	p, err := w.Grid(gridSpec(1, 2, 4), Coverage{})
	mustOK(t, err)
	fw.limit = fw.buf.Len()
	if err := p.Add(rampSeries(0, 4)); !errors.Is(err, errSink) {
		t.Fatalf("Add %v, want the write error", err)
	}
	n := fw.buf.Len()
	for name, call := range map[string]func() error{
		"Add":    func() error { return p.Add(rampSeries(1, 4)) },
		"Flush":  p.Flush,
		"Finish": func() error { return p.Finish(Coverage{Phase: PhaseFinal}) },
		"Fail":   func() error { return p.Fail(Coverage{}, ErrorRow{}) },
		"End":    w.End,
	} {
		if err := call(); !errors.Is(err, errSink) {
			t.Errorf("later %s %v, want the sticky write error", name, err)
		}
	}
	if fw.buf.Len() != n {
		t.Errorf("%d bytes written after the error", fw.buf.Len()-n)
	}
}
