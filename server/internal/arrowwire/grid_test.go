package arrowwire

import (
	"bytes"
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

func gridSpec(l, d uint32, n int) GridSpec {
	return GridSpec{LabelsPart: l, DataPart: d, Grid: pulsusdb.Grid{Start: 0, End: int64(n-1) * 1000, Step: 1000},
		Result: "metric", Source: "pulsusdb"}
}

// dataBatchRows is the row count of each data BATCH of part d, read back with arrow-go.
func dataBatchRows(t *testing.T, b []byte, d uint32) []int {
	t.Helper()
	var stream []byte
	for _, f := range splitFrames(t, b) {
		if f.PartID == d && (f.Type == FrameSchema || f.Type == FrameBatch) {
			stream = append(stream, f.Payload...)
		}
	}
	_, recs := readStream(t, stream)
	var rows []int
	for _, r := range recs {
		rows = append(rows, int(r.NumRows()))
	}
	return rows
}

// oneMessage checks that every SCHEMA and BATCH payload is exactly one IPC message.
func oneMessage(t *testing.T, b []byte) {
	t.Helper()
	for _, f := range splitFrames(t, b) {
		if f.Type != FrameSchema && f.Type != FrameBatch {
			continue
		}
		ms, eos := messages(t, f.Payload, f.Off+HeaderLen)
		if len(ms) != 1 || eos || int64(len(f.Payload)) != 8+int64(ms[0].MetaLen)+ms[0].BodyLen {
			t.Errorf("frame at %d: %d messages, eos %v, payload %d", f.Off, len(ms), eos, len(f.Payload))
		}
	}
}

// completedPart writes one finished grid (parts 1/2, one series) on a fresh Writer.
func completedPart(t *testing.T) (*Writer, *bytes.Buffer) {
	t.Helper()
	return completedPartWith(t, DefaultLimits())
}

// completedPartWith is completedPart on a Writer with the limits l.
func completedPartWith(t *testing.T, l Limits) (*Writer, *bytes.Buffer) {
	t.Helper()
	var buf bytes.Buffer
	w := NewWriterLimits(&buf, l)
	p, err := w.Grid(gridSpec(1, 2, 4), Coverage{})
	mustOK(t, err)
	mustOK(t, p.Add(rampSeries(0, 4)))
	mustOK(t, p.Finish(Coverage{Phase: PhaseFinal, SeriesReturned: 1}))
	return w, &buf
}

// refusedOnce checks that exactly one stream-level ERROR follows prefix (outcome (a)).
func refusedOnce(t *testing.T, prefix, body []byte) {
	t.Helper()
	if !bytes.HasPrefix(body, prefix) {
		t.Fatal("the completed part's frames changed")
	}
	rest := splitFrames(t, body[len(prefix):])
	if len(rest) != 1 || rest[0].Type != FrameError || rest[0].PartID != 0 || rest[0].Flags != FlagLast || rest[0].Rank != 0 {
		t.Fatalf("after the refusal: %+v, want one ERROR(part 0)|LAST", frameSeq(t, body[len(prefix):]))
	}
	if e := errorOf(t, rest[0].Payload); e.Code != 8 || e.Message != "writer refused" {
		t.Errorf("stream-level error %+v", e)
	}
}

// unit:dsf-writer-order (T04-006, T04-012).
func TestWriterOrder(t *testing.T) {
	cases := []struct {
		series, n int
		batches   []int
		pending   bool // the last batch is sent by Finish
		volatile  bool
		rank      uint16
	}{
		{0, 4, nil, false, false, 0},
		{1, 4, []int{1}, false, false, 0},
		{2, 4, []int{1, 1}, true, false, 0},
		{9, 4, []int{1, 8}, true, false, 0},
		{65, 4, []int{1, 64}, false, false, 0},
		{70, 4, []int{1, 64, 5}, true, true, 3},
		{9, 11001, []int{1, 8}, true, false, 0},
	}
	for _, c := range cases {
		var buf bytes.Buffer
		w := NewWriter(&buf)
		s := gridSpec(7, 8, c.n)
		s.Volatile, s.Rank = c.volatile, c.rank
		p, err := w.Grid(s, Coverage{})
		mustOK(t, err)
		for i := 0; i < c.series; i++ {
			mustOK(t, p.Add(rampSeries(i, c.n)))
		}
		mustOK(t, p.Finish(Coverage{Phase: PhaseFinal, SeriesReturned: uint32(c.series)})) // #nosec G115 -- ≤ 70
		mustOK(t, w.End())
		var flags uint16
		if c.volatile {
			flags = FlagVolatile
		}
		if got, want := frameSeq(t, buf.Bytes()), wantSeq(7, 8, flags, len(c.batches), c.pending); !reflect.DeepEqual(got, want) {
			t.Errorf("%d×%d: frames %v, want %v", c.series, c.n, got, want)
			continue
		}
		if got := dataBatchRows(t, buf.Bytes(), 8); !reflect.DeepEqual(got, c.batches) {
			t.Errorf("%d×%d: batches %v, want %v", c.series, c.n, got, c.batches)
		}
		for _, f := range splitFrames(t, buf.Bytes()) {
			if f.PartID != 0 && f.Rank != c.rank {
				t.Errorf("%d×%d: frame rank %d, want %d", c.series, c.n, f.Rank, c.rank)
			}
		}
		oneMessage(t, buf.Bytes())
	}
}

// Every bad spec, in a fresh Writer after one completed grid, is refused with exactly one
// stream-level ERROR (outcome (a)); a later Grid is ErrOrder and writes nothing.
func TestWriterBadSpecs(t *testing.T) {
	g := func(start, end, step int64) pulsusdb.Grid { return pulsusdb.Grid{Start: start, End: end, Step: step} }
	bad := []struct {
		name string
		grid pulsusdb.Grid
		req  int64
	}{
		{"reversed", g(10, 0, 5), 10},
		{"unaligned", g(0, 7, 5), 0},
		{"step 0", g(0, 10, 0), 0},
		{"step -5", g(0, 10, -5), 0},
		{"oversized", g(0, 1<<22, 1), 0},
		{"overflowing", g(math.MinInt64, math.MaxInt64, 1), math.MinInt64},
		{"requested before start", g(0, 10, 5), -1},
		{"requested at start+step", g(0, 10, 5), 5},
		{"requested far after", g(math.MinInt64, math.MinInt64+3, 1), math.MaxInt64},
	}
	for _, c := range bad {
		w, buf := completedPart(t)
		prefix := append([]byte(nil), buf.Bytes()...)
		s := gridSpec(3, 4, 4)
		s.Grid, s.RequestedStartMs = c.grid, c.req
		if _, err := w.Grid(s, Coverage{}); !errors.Is(err, ErrShape) {
			t.Errorf("%s: %v, want ErrShape", c.name, err)
			continue
		}
		refusedOnce(t, prefix, buf.Bytes())
		n := buf.Len()
		if _, err := w.Grid(gridSpec(5, 6, 4), Coverage{}); !errors.Is(err, ErrOrder) || buf.Len() != n {
			t.Errorf("%s: later Grid %v, %d bytes written", c.name, err, buf.Len()-n)
		}
		mustOK(t, w.End())
	}
}

// The largest grid: n = 2²² points in one series fits one data BATCH.
func TestWriterBoundaryGrid(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	s := gridSpec(1, 2, MaxGridLen)
	p, err := w.Grid(s, Coverage{})
	mustOK(t, err)
	mustOK(t, p.Add(rampSeries(0, MaxGridLen)))
	mustOK(t, p.Finish(Coverage{Phase: PhaseFinal, SeriesReturned: 1}))
	mustOK(t, w.End())
	if got, want := frameSeq(t, buf.Bytes()), wantSeq(1, 2, 0, 1, false); !reflect.DeepEqual(got, want) {
		t.Fatalf("frames %v, want %v", got, want)
	}
	for _, f := range splitFrames(t, buf.Bytes()) {
		if f.Type == FrameSchema && f.PartID == 2 && !bytes.Contains(f.Payload, []byte("4194304")) {
			t.Error("dash.grid.len is not 4194304")
		}
		if f.Type == FrameBatch && f.PartID == 2 && f.PayloadLen >= MaxPayload {
			t.Errorf("data BATCH payload %d ≥ MaxPayload", f.PayloadLen)
		}
	}
}

// A refused Add closes its part with the refusal-contract close (outcome (b)).
func TestWriterAddRefusals(t *testing.T) {
	huge := strings.Repeat("x", MaxPayload+1)
	cases := []struct {
		name    string
		series  *pulsusdb.Series
		err     error
		message string
	}{
		{"wrong length", rampSeries(9, 3), ErrShape, "writer refused: shape"},
		{"labels past MaxPayload", newSeries([]float64{1, 2, 3, 4}, []bool{true, true, true, true}, "big", huge), ErrFrameTooLarge, "writer refused: frame too large"},
	}
	for _, c := range cases {
		w, buf := completedPart(t)
		prefix := append([]byte(nil), buf.Bytes()...)
		p, err := w.Grid(gridSpec(3, 4, 4), Coverage{})
		mustOK(t, err)
		mustOK(t, p.Add(rampSeries(0, 4))) // the first batch, sent
		mustOK(t, p.Add(rampSeries(1, 4))) // pending
		open := buf.Len()
		if err := p.Add(c.series); !errors.Is(err, c.err) {
			t.Errorf("%s: Add %v, want %v", c.name, err, c.err)
			continue
		}
		if !bytes.HasPrefix(buf.Bytes(), prefix) {
			t.Errorf("%s: the completed part's frames changed", c.name)
		}
		rest := splitFrames(t, buf.Bytes()[open:])
		got := frameSeq(t, buf.Bytes()[open:])
		want := []seqItem{{FrameBatch, 3, FlagLast}, {FrameMeta, 4, 0}, {FrameError, 4, FlagLast}}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: close %v, want %v", c.name, got, want)
			continue
		}
		if cov := coverageOf(t, rest[1].Payload); cov.Phase != uint8(PhasePartial) {
			t.Errorf("%s: close coverage phase %d", c.name, cov.Phase)
		}
		if e := errorOf(t, rest[2].Payload); e.Code != 8 || e.Message != c.message {
			t.Errorf("%s: error %+v, want code 8 %q", c.name, e, c.message)
		}
		n := buf.Len()
		if err := p.Fail(Coverage{Phase: PhasePartial}, ErrorRow{}); !errors.Is(err, ErrOrder) {
			t.Errorf("%s: later Fail %v, want ErrOrder", c.name, err)
		}
		if err := p.Add(rampSeries(2, 4)); !errors.Is(err, ErrOrder) || buf.Len() != n {
			t.Errorf("%s: later Add %v, %d bytes", c.name, err, buf.Len()-n)
		}
		mustOK(t, w.End())
	}
}

// unit:part-ids (T04-009): part ids are non-zero, distinct within a Grid and never reused.
func TestPartIDs(t *testing.T) {
	type call func(w *Writer, open *GridPart) error
	grid := func(l, d uint32) call {
		return func(w *Writer, _ *GridPart) error { _, err := w.Grid(gridSpec(l, d, 4), Coverage{}); return err }
	}
	errorFor := func(part uint32) call {
		return func(w *Writer, _ *GridPart) error {
			return w.Error(part, 0, ErrorRow{Code: 8, HTTPStatus: 500, Message: "x"})
		}
	}
	cases := []struct {
		name string
		open bool // parts 3/4 open before the call
		call call
	}{
		{"labels part 0", false, grid(0, 4)},
		{"data part 0", false, grid(3, 0)},
		{"labels == data", false, grid(3, 3)},
		{"Grid reuses an open id", true, grid(5, 3)},
		{"Grid reuses a finished id", false, grid(1, 6)},
		{"Error part 0", false, errorFor(0)},
		{"Error reuses an open id", true, errorFor(4)},
		{"Error reuses a finished id", false, errorFor(2)},
	}
	for _, c := range cases {
		w, buf := completedPart(t)
		var open *GridPart
		if c.open {
			var err error
			open, err = w.Grid(gridSpec(3, 4, 4), Coverage{})
			mustOK(t, err)
		}
		prefix := append([]byte(nil), buf.Bytes()...)
		if err := c.call(w, open); !errors.Is(err, ErrShape) {
			t.Errorf("%s: %v, want ErrShape", c.name, err)
			continue
		}
		refusedOnce(t, prefix, buf.Bytes())
		n := buf.Len()
		if _, err := w.Grid(gridSpec(10, 11, 4), Coverage{}); !errors.Is(err, ErrOrder) {
			t.Errorf("%s: later Grid %v", c.name, err)
		}
		if err := w.Error(12, 0, ErrorRow{}); !errors.Is(err, ErrOrder) || buf.Len() != n {
			t.Errorf("%s: later Error %v, %d bytes", c.name, err, buf.Len()-n)
		}
		if open != nil {
			mustOK(t, open.Finish(Coverage{Phase: PhaseFinal})) // open parts still close normally
		}
		mustOK(t, w.End())
	}
	body, _ := buildPartIDs(t)
	for _, f := range splitFrames(t, body) {
		if f.PartID == 0 && f.Type != FrameEnd {
			t.Errorf("valid part-id body has a stream-level frame %v", f.Type)
		}
	}
}
