// Package wiretest reads DSF bodies back with arrow-go for the tests of the packages that write
// them through arrowwire (plan #68 Part D1 §5): the gateway's route tests and fixtures. It is
// test support only; no production code imports it.
package wiretest

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"strconv"
	"testing"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/array"
	"github.com/apache/arrow-go/v18/arrow/ipc"
	"github.com/apache/arrow-go/v18/arrow/memory"

	"github.com/digitalis-io/pulsus-dash/server/internal/arrowwire"
)

// Frame is one DSF frame of a body.
type Frame struct {
	arrowwire.Header
	Off     int
	Payload []byte
}

// Series is one series of a data part, in id order.
type Series struct {
	ID     uint32
	Key    uint64
	Labels [][2]string
	Values []float64 // NaN bits kept
	Valid  []bool    // false: an absent point (validity bit 0)
}

// Coverage is one coverage/1 row.
type Coverage struct {
	Phase            uint8
	Exactness        uint8
	Truncated        bool
	TruncationReason *string
	SeriesReturned   uint32
	Warnings, Infos  []string
	UpstreamQueryIDs []string
	ReadCache        *uint8
	ReadCacheThrough *int64
	DataEnd          *int64
}

// Error is one error/1 row.
type Error struct {
	Code         uint8
	HTTPStatus   uint16
	Message      string
	Position     *uint32
	RetryAfterMs *uint32
	Suggestion   *string
}

// Part is one labels/1 + metric_matrix.grid/1 part pair.
type Part struct {
	LabelsPart, DataPart uint32
	StartMs, StepMs      int64
	RequestedStartMs     int64
	Len                  int
	Result, Source       string
	Planned              *string
	Series               []Series
	Coverage             []Coverage // in body order, the planned row first
	Error                *Error
	Closed               bool // the data part's last frame carries LAST
}

// Body is a DSF body read back.
type Body struct {
	Frames []Frame
	Parts  []Part
	Errors []Error // stream-level ERROR rows (part 0)
	Ended  bool    // the last frame is END
}

// Split splits b into frames; a malformed header or a payload past the body fails the test.
func Split(t testing.TB, b []byte) []Frame {
	t.Helper()
	var out []Frame
	for off := 0; off < len(b); {
		h, err := arrowwire.ParseHeader(b[off:])
		if err != nil {
			t.Fatalf("frame at %d: %v", off, err)
		}
		end := off + arrowwire.HeaderLen + int(h.PayloadLen)
		if end > len(b) {
			t.Fatalf("frame at %d: payload past the body", off)
		}
		out = append(out, Frame{Header: h, Off: off, Payload: b[off+arrowwire.HeaderLen : end]})
		off = end
	}
	return out
}

// Read reads a complete DSF body (frames up to its end) into parts, series and rows.
func Read(t testing.TB, b []byte) Body {
	t.Helper()
	frames := Split(t, b)
	out := Body{Frames: frames}
	if n := len(frames); n > 0 && frames[n-1].Type == arrowwire.FrameEnd {
		out.Ended = true
	}
	byPart := map[uint32][]Frame{}
	var order []uint32
	for _, f := range frames {
		if f.PartID == 0 {
			if f.Type == arrowwire.FrameError {
				out.Errors = append(out.Errors, errorOf(t, f.Payload))
			}
			continue
		}
		if _, ok := byPart[f.PartID]; !ok {
			order = append(order, f.PartID)
		}
		byPart[f.PartID] = append(byPart[f.PartID], f)
	}
	for _, id := range order {
		fs := byPart[id]
		if fs[0].Type != arrowwire.FrameMeta { // a labels part, read with its data part
			continue
		}
		out.Parts = append(out.Parts, readPart(t, id, fs, byPart))
	}
	return out
}

func stream(fs []Frame) []byte {
	var s []byte
	for _, f := range fs {
		if f.Type == arrowwire.FrameSchema || f.Type == arrowwire.FrameBatch {
			s = append(s, f.Payload...)
		}
	}
	return s
}

func readPart(t testing.TB, id uint32, fs []Frame, byPart map[uint32][]Frame) Part {
	t.Helper()
	p := Part{DataPart: id, Closed: fs[len(fs)-1].Flags&arrowwire.FlagLast != 0}
	for _, f := range fs {
		switch f.Type {
		case arrowwire.FrameMeta:
			p.Coverage = append(p.Coverage, coverageOf(t, f.Payload))
		case arrowwire.FrameError:
			e := errorOf(t, f.Payload)
			p.Error = &e
		}
	}
	s, recs := readStream(t, stream(fs))
	if v, _ := meta(s, "dash.schema"); v != "metric_matrix.grid/1" {
		t.Fatalf("part %d schema %q", id, v)
	}
	p.LabelsPart = uint32(metaInt(t, s, "dash.labels_part")) // #nosec G115 -- written as u32
	p.StartMs, p.StepMs = metaInt(t, s, "dash.grid.start_ms"), metaInt(t, s, "dash.grid.step_ms")
	p.RequestedStartMs, p.Len = metaInt(t, s, "dash.grid.requested_start_ms"), int(metaInt(t, s, "dash.grid.len"))
	p.Result, _ = meta(s, "dash.result")
	p.Source, _ = meta(s, "dash.source")
	if v, ok := meta(s, "dash.planned"); ok {
		p.Planned = &v
	}
	labels := readLabels(t, stream(byPart[p.LabelsPart]))
	for _, r := range recs {
		ids := r.Column(0).(*array.Uint32)
		vals := r.Column(1).(*array.FixedSizeList).ListValues().(*array.Float64)
		for i := 0; i < int(r.NumRows()); i++ {
			l, ok := labels[ids.Value(i)]
			if !ok {
				t.Fatalf("part %d: series %d not in labels part %d", id, ids.Value(i), p.LabelsPart)
			}
			ser := Series{ID: ids.Value(i), Key: l.key, Labels: l.labels}
			for k := range p.Len {
				j := i*p.Len + k
				ser.Values = append(ser.Values, vals.Value(j))
				ser.Valid = append(ser.Valid, vals.IsValid(j))
			}
			p.Series = append(p.Series, ser)
		}
		r.Release()
	}
	return p
}

func readStream(t testing.TB, b []byte) (*arrow.Schema, []arrow.RecordBatch) {
	t.Helper()
	r, err := ipc.NewReader(bytes.NewReader(b), ipc.WithAllocator(memory.NewGoAllocator()))
	if err != nil {
		t.Fatalf("ipc reader: %v", err)
	}
	defer r.Release()
	var recs []arrow.RecordBatch
	for r.Next() {
		rec := r.RecordBatch()
		rec.Retain()
		recs = append(recs, rec)
	}
	if err := r.Err(); err != nil && !errors.Is(err, io.EOF) {
		t.Fatalf("ipc read: %v", err)
	}
	return r.Schema(), recs
}

func meta(s *arrow.Schema, key string) (string, bool) {
	i := s.Metadata().FindKey(key)
	if i < 0 {
		return "", false
	}
	return s.Metadata().Values()[i], true
}

func metaInt(t testing.TB, s *arrow.Schema, key string) int64 {
	t.Helper()
	v, ok := meta(s, key)
	if !ok {
		t.Fatalf("metadata %s missing", key)
	}
	n, err := strconv.ParseInt(v, 10, 64)
	if err != nil {
		t.Fatalf("metadata %s = %q: %v", key, v, err)
	}
	return n
}

func optStr(a *array.String, i int) *string {
	if a.IsNull(i) {
		return nil
	}
	v := a.Value(i)
	return &v
}

func optTS(a *array.Timestamp, i int) *int64 {
	if a.IsNull(i) {
		return nil
	}
	v := int64(a.Value(i))
	return &v
}

func strList(a *array.List, i int) []string {
	out := []string{}
	start, end := a.ValueOffsets(i)
	vals := a.ListValues().(*array.String)
	for k := start; k < end; k++ {
		out = append(out, vals.Value(int(k)))
	}
	return out
}

func coverageOf(t testing.TB, payload []byte) Coverage {
	t.Helper()
	s, recs := readStream(t, payload)
	if v, _ := meta(s, "dash.schema"); v != "coverage/1" || len(recs) != 1 || recs[0].NumRows() != 1 {
		t.Fatalf("META: schema %q, %d records", v, len(recs))
	}
	r := recs[0]
	defer r.Release()
	col := func(name string) arrow.Array {
		idx := s.FieldIndices(name)
		if len(idx) != 1 {
			t.Fatalf("coverage/1 has no column %s", name)
		}
		return r.Column(idx[0])
	}
	c := Coverage{
		Phase:            col("phase").(*array.Uint8).Value(0),
		Exactness:        col("exactness").(*array.Uint8).Value(0),
		Truncated:        col("truncated").(*array.Boolean).Value(0),
		TruncationReason: optStr(col("truncation_reason").(*array.String), 0),
		SeriesReturned:   col("series_returned").(*array.Uint32).Value(0),
		Warnings:         strList(col("warnings").(*array.List), 0),
		Infos:            strList(col("infos").(*array.List), 0),
		UpstreamQueryIDs: strList(col("upstream_query_ids").(*array.List), 0),
		ReadCacheThrough: optTS(col("read_cache_through").(*array.Timestamp), 0),
		DataEnd:          optTS(col("data_end").(*array.Timestamp), 0),
	}
	if a := col("read_cache").(*array.Uint8); a.IsValid(0) {
		v := a.Value(0)
		c.ReadCache = &v
	}
	return c
}

func errorOf(t testing.TB, payload []byte) Error {
	t.Helper()
	s, recs := readStream(t, payload)
	if v, _ := meta(s, "dash.schema"); v != "error/1" || len(recs) != 1 || recs[0].NumRows() != 1 {
		t.Fatalf("ERROR: schema %q, %d records", v, len(recs))
	}
	r := recs[0]
	defer r.Release()
	e := Error{
		Code:       r.Column(0).(*array.Uint8).Value(0),
		HTTPStatus: r.Column(1).(*array.Uint16).Value(0),
		Message:    r.Column(2).(*array.String).Value(0),
		Suggestion: optStr(r.Column(5).(*array.String), 0),
	}
	if a := r.Column(3).(*array.Uint32); a.IsValid(0) {
		v := a.Value(0)
		e.Position = &v
	}
	if a := r.Column(4).(*array.Uint32); a.IsValid(0) {
		v := a.Value(0)
		e.RetryAfterMs = &v
	}
	return e
}

type labelRow struct {
	key    uint64
	labels [][2]string
}

func readLabels(t testing.TB, b []byte) map[uint32]labelRow {
	t.Helper()
	s, recs := readStream(t, b)
	if v, _ := meta(s, "dash.schema"); v != "labels/1" {
		t.Fatalf("labels part schema %q", v)
	}
	out := map[uint32]labelRow{}
	for _, r := range recs {
		ids, keys := r.Column(0).(*array.Uint32), r.Column(1).(*array.Uint64)
		ks, vs := r.Column(2).(*array.String), r.Column(3).(*array.String)
		for i := 0; i < int(r.NumRows()); i++ {
			row, ok := out[ids.Value(i)]
			if !ok {
				row = labelRow{key: keys.Value(i), labels: [][2]string{}}
			}
			if ks.IsValid(i) {
				row.labels = append(row.labels, [2]string{ks.Value(i), vs.Value(i)})
			}
			out[ids.Value(i)] = row
		}
		r.Release()
	}
	return out
}

// Final is the part's last coverage row (nil if none).
func (p Part) Final() *Coverage {
	if len(p.Coverage) == 0 {
		return nil
	}
	return &p.Coverage[len(p.Coverage)-1]
}

// SameValue reports whether a and b are the same value: bit-equal, or both NaN.
func SameValue(a, b float64) bool {
	return math.Float64bits(a) == math.Float64bits(b) || (math.IsNaN(a) && math.IsNaN(b))
}

// String is a short description of the frame sequence, for failure messages.
func (b Body) String() string {
	s := ""
	for _, f := range b.Frames {
		s += fmt.Sprintf("%d/%d/%d ", f.Type, f.PartID, f.Flags)
	}
	return s
}
