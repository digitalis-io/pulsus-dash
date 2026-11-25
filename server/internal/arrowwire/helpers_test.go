package arrowwire

import (
	"bytes"
	"encoding/binary"
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

	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// The .expect.json shape (plan #68 B1 §3.5). B2's Rust reader decodes the same files.
type expectBody struct {
	Parts  []expectPart  `json:"parts"`
	Errors []expectError `json:"errors"`
}

type expectGrid struct {
	StartMs          int64  `json:"start_ms"`
	RequestedStartMs int64  `json:"requested_start_ms"`
	StepMs           int64  `json:"step_ms"`
	Len              uint32 `json:"len"`
}

type expectSeries struct {
	ID     uint32      `json:"id"`
	Key    string      `json:"key"`
	Labels [][2]string `json:"labels"`
	Bits   []*string   `json:"bits"`
}

type expectPart struct {
	LabelsPart uint32         `json:"labels_part"`
	DataPart   uint32         `json:"data_part"`
	Rank       uint16         `json:"rank"`
	Grid       expectGrid     `json:"grid"`
	Result     string         `json:"result"`
	Source     string         `json:"source"`
	Unit       *string        `json:"unit"`
	Planned    *string        `json:"planned"`
	Series     []expectSeries `json:"series"`
	Coverage   []coverageJSON `json:"coverage"`
	Error      *errorJSON     `json:"error"`
}

type expectError struct {
	Part  uint32    `json:"part"`
	Error errorJSON `json:"error"`
}

type coverageJSON struct {
	Phase            uint8    `json:"phase"`
	Exactness        uint8    `json:"exactness"`
	RollupLevelS     *uint32  `json:"rollup_level_s"`
	SampledRatio     *float64 `json:"sampled_ratio"`
	Truncated        bool     `json:"truncated"`
	TruncationReason *string  `json:"truncation_reason"`
	DroppedCount     *uint64  `json:"dropped_count"`
	SeriesReturned   uint32   `json:"series_returned"`
	RowsRead         *uint64  `json:"rows_read"`
	BytesRead        *uint64  `json:"bytes_read"`
	ShardsFailed     *uint16  `json:"shards_failed"`
	ShardsSkipped    *uint16  `json:"shards_skipped"`
	RetentionFloor   *int64   `json:"retention_floor"`
	ExcludedDims     []string `json:"excluded_dims"`
	Warnings         []string `json:"warnings"`
	Infos            []string `json:"infos"`
	UpstreamQueryIDs []string `json:"upstream_query_ids"`
	ReadCache        *uint8   `json:"read_cache"`
	ReadCacheThrough *int64   `json:"read_cache_through"`
	DataEnd          *int64   `json:"data_end"`
	UpstreamMs       uint32   `json:"upstream_ms"`
	ConvertMs        uint32   `json:"convert_ms"`
}

type errorJSON struct {
	Code         uint8   `json:"code"`
	HTTPStatus   uint16  `json:"http_status"`
	Message      string  `json:"message"`
	Position     *uint32 `json:"position"`
	RetryAfterMs *uint32 `json:"retry_after_ms"`
	Suggestion   *string `json:"suggestion"`
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func toCoverageJSON(c Coverage) coverageJSON {
	return coverageJSON{Phase: uint8(c.Phase), Exactness: c.Exactness, RollupLevelS: c.RollupLevelS,
		SampledRatio: c.SampledRatio, Truncated: c.Truncated, TruncationReason: c.TruncationReason,
		DroppedCount: c.DroppedCount, SeriesReturned: c.SeriesReturned, RowsRead: c.RowsRead, BytesRead: c.BytesRead,
		ShardsFailed: c.ShardsFailed, ShardsSkipped: c.ShardsSkipped, RetentionFloor: c.RetentionFloorMs,
		ExcludedDims: nonNil(c.ExcludedDims), Warnings: nonNil(c.Warnings), Infos: nonNil(c.Infos),
		UpstreamQueryIDs: nonNil(c.UpstreamQueryIDs), ReadCache: c.ReadCache, ReadCacheThrough: c.ReadCacheThroughMs,
		DataEnd: c.DataEndMs, UpstreamMs: c.UpstreamMs, ConvertMs: c.ConvertMs}
}

func toErrorJSON(e ErrorRow) errorJSON {
	return errorJSON{Code: e.Code, HTTPStatus: e.HTTPStatus, Message: e.Message, Position: e.Position,
		RetryAfterMs: e.RetryAfterMs, Suggestion: e.Suggestion}
}

func ptr[T any](v T) *T { return &v }

func gridLen(g pulsusdb.Grid) uint32 { return uint32((g.End-g.Start)/g.Step + 1) }

// expectSeriesOf is the expectation of series sent in Add order (ids dense from 0).
func expectSeriesOf(series []*pulsusdb.Series) []expectSeries {
	out := []expectSeries{}
	for i, s := range series {
		e := expectSeries{ID: uint32(i), Key: fmt.Sprintf("%016x", s.Key), Labels: [][2]string{}, Bits: []*string{}}
		for _, l := range s.Labels {
			e.Labels = append(e.Labels, [2]string{l.Name, l.Value})
		}
		for k, v := range s.Values {
			if s.Present[k] {
				e.Bits = append(e.Bits, ptr(fmt.Sprintf("%016x", math.Float64bits(v))))
			} else {
				e.Bits = append(e.Bits, nil)
			}
		}
		out = append(out, e)
	}
	return out
}

// expectPartFor is the expectation of one GridPart built from the writer's inputs: sent are the
// series that reach the wire, cov every coverage the part writes (planned first).
func expectPartFor(s GridSpec, sent []*pulsusdb.Series, cov []Coverage, e *ErrorRow) expectPart {
	p := expectPart{LabelsPart: s.LabelsPart, DataPart: s.DataPart, Rank: s.Rank,
		Grid:   expectGrid{StartMs: s.Grid.Start, RequestedStartMs: s.RequestedStartMs, StepMs: s.Grid.Step, Len: gridLen(s.Grid)},
		Result: s.Result, Source: s.Source, Series: expectSeriesOf(sent), Coverage: []coverageJSON{}}
	if s.Unit != "" {
		p.Unit = ptr(s.Unit)
	}
	if s.Planned != nil {
		p.Planned = ptr(string(s.Planned))
	}
	for _, c := range cov {
		p.Coverage = append(p.Coverage, toCoverageJSON(c))
	}
	if e != nil {
		p.Error = ptr(toErrorJSON(*e))
	}
	return p
}

// newSeries builds a series with its key; labels are name, value pairs (sorted by the caller).
func newSeries(values []float64, present []bool, kv ...string) *pulsusdb.Series {
	ls := []pulsusdb.Label{}
	for i := 0; i+1 < len(kv); i += 2 {
		ls = append(ls, pulsusdb.Label{Name: kv[i], Value: kv[i+1]})
	}
	return &pulsusdb.Series{Key: keyhash.Labels(ls), Labels: ls, Values: values, Present: present}
}

// rampSeries is a series of n present values i, i+1, … labelled {i="<i>"}.
func rampSeries(i, n int) *pulsusdb.Series {
	v, p := make([]float64, n), make([]bool, n)
	for k := range v {
		v[k], p[k] = float64(i+k), true
	}
	return newSeries(v, p, "i", strconv.Itoa(i))
}

// rawFrame is one frame of a body, with the body offset of its header.
type rawFrame struct {
	Header
	Off     int64
	Payload []byte
}

func splitFrames(t *testing.T, b []byte) []rawFrame {
	t.Helper()
	var out []rawFrame
	for off := 0; off < len(b); {
		h, err := ParseHeader(b[off:])
		if err != nil {
			t.Fatalf("frame at %d: %v", off, err)
		}
		end := off + HeaderLen + int(h.PayloadLen)
		if end > len(b) {
			t.Fatalf("frame at %d: payload past the body", off)
		}
		out = append(out, rawFrame{Header: h, Off: int64(off), Payload: b[off+HeaderLen : end]})
		off = end
	}
	return out
}

// message is one encapsulated IPC message of a payload.
type message struct {
	Off, BodyOff int64 // body offsets of the message and of its body
	MetaLen      int   // L
	BodyLen      int64
	Type         ipc.MessageType
}

// messages walks the IPC messages of a payload at body offset base, up to an EOS or the end.
func messages(t *testing.T, payload []byte, base int64) (ms []message, eos bool) {
	t.Helper()
	for i := 0; i < len(payload); {
		if len(payload)-i < 8 || binary.LittleEndian.Uint32(payload[i:]) != 0xFFFFFFFF {
			t.Fatalf("message at %d: no continuation marker", base+int64(i))
		}
		l := int(binary.LittleEndian.Uint32(payload[i+4:]))
		if l == 0 {
			if i+8 != len(payload) {
				t.Fatalf("bytes after EOS at %d", base+int64(i))
			}
			return ms, true
		}
		mr := ipc.NewMessageReader(bytes.NewReader(payload[i:]))
		m, err := mr.Message()
		if err != nil {
			t.Fatalf("message at %d: %v", base+int64(i), err)
		}
		ms = append(ms, message{Off: base + int64(i), BodyOff: base + int64(i+8+l), MetaLen: l, BodyLen: m.BodyLen(), Type: m.Type()})
		mr.Release()
		i += 8 + l + int(ms[len(ms)-1].BodyLen)
		if i > len(payload) {
			t.Fatalf("message body past the payload at %d", base+int64(i))
		}
	}
	return ms, false
}

// readStream reads the records of an IPC stream with arrow-go.
func readStream(t *testing.T, stream []byte) (*arrow.Schema, []arrow.RecordBatch) {
	t.Helper()
	r, err := ipc.NewReader(bytes.NewReader(stream), ipc.WithAllocator(memory.NewGoAllocator()))
	if err != nil {
		t.Fatalf("ipc reader: %v", err)
	}
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

func meta(t *testing.T, s *arrow.Schema, key string) (string, bool) {
	t.Helper()
	i := s.Metadata().FindKey(key)
	if i < 0 {
		return "", false
	}
	return s.Metadata().Values()[i], true
}

func metaInt(t *testing.T, s *arrow.Schema, key string) int64 {
	t.Helper()
	v, ok := meta(t, s, key)
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
	return ptr(a.Value(i))
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

func optTS(a *array.Timestamp, i int) *int64 {
	if a.IsNull(i) {
		return nil
	}
	return ptr(int64(a.Value(i)))
}

// coverageOf reads the one coverage/1 row of a META payload.
func coverageOf(t *testing.T, payload []byte) coverageJSON {
	t.Helper()
	s, recs := readStream(t, payload)
	if v, _ := meta(t, s, "dash.schema"); v != "coverage/1" || len(recs) != 1 || recs[0].NumRows() != 1 {
		t.Fatalf("META: schema %q, %d records", v, len(recs))
	}
	r := recs[0]
	col := func(name string) arrow.Array {
		idx := s.FieldIndices(name)
		if len(idx) != 1 {
			t.Fatalf("coverage/1 has no column %s", name)
		}
		return r.Column(idx[0])
	}
	c := coverageJSON{
		Phase:            col("phase").(*array.Uint8).Value(0),
		Exactness:        col("exactness").(*array.Uint8).Value(0),
		Truncated:        col("truncated").(*array.Boolean).Value(0),
		TruncationReason: optStr(col("truncation_reason").(*array.String), 0),
		SeriesReturned:   col("series_returned").(*array.Uint32).Value(0),
		RetentionFloor:   optTS(col("retention_floor").(*array.Timestamp), 0),
		ExcludedDims:     strList(col("excluded_dims").(*array.List), 0),
		Warnings:         strList(col("warnings").(*array.List), 0),
		Infos:            strList(col("infos").(*array.List), 0),
		UpstreamQueryIDs: strList(col("upstream_query_ids").(*array.List), 0),
		ReadCacheThrough: optTS(col("read_cache_through").(*array.Timestamp), 0),
		DataEnd:          optTS(col("data_end").(*array.Timestamp), 0),
		UpstreamMs:       col("upstream_ms").(*array.Uint32).Value(0),
		ConvertMs:        col("convert_ms").(*array.Uint32).Value(0),
	}
	if a := col("rollup_level_s").(*array.Uint32); a.IsValid(0) {
		c.RollupLevelS = ptr(a.Value(0))
	}
	if a := col("sampled_ratio").(*array.Float64); a.IsValid(0) {
		c.SampledRatio = ptr(a.Value(0))
	}
	if a := col("dropped_count").(*array.Uint64); a.IsValid(0) {
		c.DroppedCount = ptr(a.Value(0))
	}
	if a := col("rows_read").(*array.Uint64); a.IsValid(0) {
		c.RowsRead = ptr(a.Value(0))
	}
	if a := col("bytes_read").(*array.Uint64); a.IsValid(0) {
		c.BytesRead = ptr(a.Value(0))
	}
	if a := col("shards_failed").(*array.Uint16); a.IsValid(0) {
		c.ShardsFailed = ptr(a.Value(0))
	}
	if a := col("shards_skipped").(*array.Uint16); a.IsValid(0) {
		c.ShardsSkipped = ptr(a.Value(0))
	}
	if a := col("read_cache").(*array.Uint8); a.IsValid(0) {
		c.ReadCache = ptr(a.Value(0))
	}
	return c
}

// errorOf reads the one error/1 row of an ERROR payload.
func errorOf(t *testing.T, payload []byte) errorJSON {
	t.Helper()
	s, recs := readStream(t, payload)
	if v, _ := meta(t, s, "dash.schema"); v != "error/1" || len(recs) != 1 || recs[0].NumRows() != 1 {
		t.Fatalf("ERROR: schema %q, %d records", v, len(recs))
	}
	r := recs[0]
	e := errorJSON{
		Code:       r.Column(0).(*array.Uint8).Value(0),
		HTTPStatus: r.Column(1).(*array.Uint16).Value(0),
		Message:    r.Column(2).(*array.String).Value(0),
		Suggestion: optStr(r.Column(5).(*array.String), 0),
	}
	if a := r.Column(3).(*array.Uint32); a.IsValid(0) {
		e.Position = ptr(a.Value(0))
	}
	if a := r.Column(4).(*array.Uint32); a.IsValid(0) {
		e.RetryAfterMs = ptr(a.Value(0))
	}
	return e
}

type labelRow struct {
	key    uint64
	labels [][2]string
}

// readLabels reads a labels/1 stream into id → (key, labels).
func readLabels(t *testing.T, stream []byte) map[uint32]*labelRow {
	t.Helper()
	s, recs := readStream(t, stream)
	if v, _ := meta(t, s, "dash.schema"); v != "labels/1" {
		t.Fatalf("labels part schema %q", v)
	}
	out := map[uint32]*labelRow{}
	for _, r := range recs {
		ids, keys := r.Column(0).(*array.Uint32), r.Column(1).(*array.Uint64)
		ks, vs := r.Column(2).(*array.String), r.Column(3).(*array.String)
		for i := 0; i < int(r.NumRows()); i++ {
			row := out[ids.Value(i)]
			if row == nil {
				row = &labelRow{key: keys.Value(i), labels: [][2]string{}}
				out[ids.Value(i)] = row
			}
			if ks.IsNull(i) != vs.IsNull(i) {
				t.Errorf("series %d: half-null label row", ids.Value(i))
			}
			if ks.IsValid(i) {
				row.labels = append(row.labels, [2]string{ks.Value(i), vs.Value(i)})
			}
		}
	}
	return out
}

// readBody reads a DSF body back with arrow-go into the .expect.json shape. Null value slots
// must hold the canonical NaN bits.
func readBody(t *testing.T, b []byte) expectBody {
	t.Helper()
	frames := splitFrames(t, b)
	byPart := map[uint32][]rawFrame{}
	var order []uint32
	out := expectBody{Parts: []expectPart{}, Errors: []expectError{}}
	for _, f := range frames {
		if f.PartID == 0 {
			if f.Type == FrameError {
				out.Errors = append(out.Errors, expectError{Part: 0, Error: errorOf(t, f.Payload)})
			}
			continue
		}
		if _, ok := byPart[f.PartID]; !ok {
			order = append(order, f.PartID)
		}
		byPart[f.PartID] = append(byPart[f.PartID], f)
	}
	stream := func(fs []rawFrame) []byte {
		var s []byte
		for _, f := range fs {
			if f.Type == FrameSchema || f.Type == FrameBatch {
				s = append(s, f.Payload...)
			}
		}
		return s
	}
	for _, id := range order {
		fs := byPart[id]
		if fs[0].Type == FrameError {
			out.Errors = append(out.Errors, expectError{Part: id, Error: errorOf(t, fs[0].Payload)})
			continue
		}
		if fs[0].Type != FrameMeta { // a labels part, read with its data part
			continue
		}
		p := expectPart{DataPart: id, Rank: fs[0].Rank, Coverage: []coverageJSON{}, Series: []expectSeries{}}
		for _, f := range fs {
			if f.Rank != p.Rank {
				t.Errorf("part %d: rank %d then %d", id, p.Rank, f.Rank)
			}
			switch f.Type {
			case FrameMeta:
				p.Coverage = append(p.Coverage, coverageOf(t, f.Payload))
			case FrameError:
				p.Error = ptr(errorOf(t, f.Payload))
			}
		}
		s, recs := readStream(t, stream(fs))
		if v, _ := meta(t, s, "dash.schema"); v != "metric_matrix.grid/1" {
			t.Fatalf("part %d schema %q", id, v)
		}
		p.LabelsPart = uint32(metaInt(t, s, "dash.labels_part"))
		p.Grid = expectGrid{StartMs: metaInt(t, s, "dash.grid.start_ms"), RequestedStartMs: metaInt(t, s, "dash.grid.requested_start_ms"),
			StepMs: metaInt(t, s, "dash.grid.step_ms"), Len: uint32(metaInt(t, s, "dash.grid.len"))}
		p.Result, _ = meta(t, s, "dash.result")
		p.Source, _ = meta(t, s, "dash.source")
		if v, ok := meta(t, s, "dash.unit"); ok {
			p.Unit = ptr(v)
		}
		if v, ok := meta(t, s, "dash.planned"); ok {
			p.Planned = ptr(v)
		}
		labels := readLabels(t, stream(byPart[p.LabelsPart]))
		for _, r := range recs {
			ids := r.Column(0).(*array.Uint32)
			list := r.Column(1).(*array.FixedSizeList)
			vals := list.ListValues().(*array.Float64)
			n := int(p.Grid.Len)
			for i := 0; i < int(r.NumRows()); i++ {
				l := labels[ids.Value(i)]
				if l == nil {
					t.Fatalf("part %d: series %d not in labels part %d", id, ids.Value(i), p.LabelsPart)
				}
				e := expectSeries{ID: ids.Value(i), Key: fmt.Sprintf("%016x", l.key), Labels: l.labels, Bits: []*string{}}
				for k := 0; k < n; k++ {
					j := i*n + k
					bits := math.Float64bits(vals.Value(j))
					if vals.IsNull(j) {
						if bits != 0x7FF8000000000000 {
							t.Errorf("part %d series %d point %d: null slot bits %016x", id, e.ID, k, bits)
						}
						e.Bits = append(e.Bits, nil)
					} else {
						e.Bits = append(e.Bits, ptr(fmt.Sprintf("%016x", bits)))
					}
				}
				p.Series = append(p.Series, e)
			}
		}
		out.Parts = append(out.Parts, p)
	}
	return out
}

// seq is the (type, part, flags) sequence of a body.
type seqItem struct {
	T     FrameType
	Part  uint32
	Flags uint16
}

func frameSeq(t *testing.T, b []byte) []seqItem {
	t.Helper()
	var out []seqItem
	for _, f := range splitFrames(t, b) {
		out = append(out, seqItem{f.Type, f.PartID, f.Flags})
	}
	return out
}

// wantSeq is the §3.4 sequence of one GridPart finished after the given data batches, then
// END. pending: the last batch was still pending at Finish, so its labels batch carries LAST;
// otherwise Finish writes a 0-row labels batch with LAST.
func wantSeq(l, d uint32, flags uint16, batches int, pending bool) []seqItem {
	s := []seqItem{{FrameSchema, l, flags}, {FrameMeta, d, flags}, {FrameSchema, d, flags}}
	for i := 0; i < batches; i++ {
		lf := flags
		if pending && i == batches-1 {
			lf |= FlagLast
		}
		s = append(s, seqItem{FrameBatch, l, lf}, seqItem{FrameBatch, d, flags})
	}
	if !pending {
		s = append(s, seqItem{FrameBatch, l, flags | FlagLast})
	}
	return append(s, seqItem{FrameMeta, d, flags | FlagLast}, seqItem{FrameEnd, 0, 0})
}
