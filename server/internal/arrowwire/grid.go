package arrowwire

import (
	"encoding/binary"
	"errors"
	"math"
	uni "unicode/utf8"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/array"
	"github.com/apache/arrow-go/v18/arrow/memory"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// MaxGridLen is the most points of a grid: dash.grid.len ≤ 2²² (wire/schemas max, B2's
// MAX_GRID_LEN), so a one-series batch (32 MiB of values, 512 KiB of validity) fits MaxPayload.
const MaxGridLen = 1 << 22

// nullBits is the bit pattern of an absent value slot.
const nullBits = 0x7FF8000000000000

// batchBytes is the value bytes a later data batch aims at (T04 §4.3: ≤ 1 MiB, ≤ 64 series).
const batchBytes, batchSeries = 1 << 20, 64

// labelsOverhead bounds a labels batch's metadata and padding in the Add size check.
const labelsOverhead = 64 << 10

// GridSpec describes one labels/1 + metric_matrix.grid/1 part pair.
type GridSpec struct {
	LabelsPart, DataPart uint32
	Rank                 uint16
	Volatile             bool // every frame of both parts carries FlagVolatile
	Grid                 pulsusdb.Grid
	Result, Source, Unit string // dash.result, dash.source, dash.unit ("" = omitted)
	RequestedStartMs     int64  // dash.grid.requested_start_ms: the request's from; Grid.Start ≤ it < Grid.Start + Grid.Step
	Planned              []byte // dash.planned (the route's planned object); nil = omitted
}

// GridPart is an open part pair. It holds at most one pending batch.
type GridPart struct {
	w       *Writer
	spec    GridSpec
	n       int
	schema  *arrow.Schema
	planned Coverage
	flags   uint16
	sent    uint32 // series sent; the next series id
	batches int    // data batches sent
	pending []*pulsusdb.Series
	pendLab int // label bytes pending
	closed  bool
}

// gridPoints checks the grid of s (§3.3 "Grid checks") and returns its number of points.
func gridPoints(s GridSpec) (int, bool) {
	g := s.Grid
	if g.Step <= 0 || g.End < g.Start || (g.Start < 0 && g.End > math.MaxInt64+g.Start) {
		return 0, false
	}
	d := g.End - g.Start
	if d%g.Step != 0 || d/g.Step >= MaxGridLen {
		return 0, false
	}
	if s.RequestedStartMs < g.Start || uint64(s.RequestedStartMs)-uint64(g.Start) >= uint64(g.Step) { // #nosec G115 -- ordered int64s: the unsigned difference cannot overflow; Step > 0
		return 0, false
	}
	return int(d/g.Step) + 1, true
}

// Grid opens a part pair and writes SCHEMA(L), META(D, planned) and SCHEMA(D); planned is
// written with PhasePlanned. A bad part id or grid is ErrShape and frames above MaxPayload
// are ErrFrameTooLarge: either writes the stream-level ERROR instead (outcome (a)).
func (w *Writer) Grid(s GridSpec, planned Coverage) (*GridPart, error) {
	if err := w.callable(); err != nil {
		return nil, err
	}
	if s.LabelsPart == 0 || s.DataPart == 0 || s.LabelsPart == s.DataPart || w.used[s.LabelsPart] || w.used[s.DataPart] {
		return nil, w.refuse(ErrShape)
	}
	n, ok := gridPoints(s)
	if !ok {
		return nil, w.refuse(ErrShape)
	}
	planned.Phase = PhasePlanned
	p := &GridPart{w: w, spec: s, n: n, schema: gridSchema(s, n), planned: planned}
	if s.Volatile {
		p.flags = FlagVolatile
	}
	f := w.frames()
	for _, fr := range []struct {
		h Header
		b func(*payloadBuf) error
	}{
		{p.header(FrameSchema, s.LabelsPart, 0), schemaPayload(labels1)},
		{p.header(FrameMeta, s.DataPart, 0), coveragePayload(planned)},
		{p.header(FrameSchema, s.DataPart, 0), schemaPayload(p.schema)},
	} {
		if err := f.add(fr.h, fr.b); err != nil {
			return nil, w.refuse(err)
		}
	}
	w.used[s.LabelsPart], w.used[s.DataPart] = true, true
	if err := f.commit(); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *GridPart) header(t FrameType, part uint32, flags uint16) Header {
	return Header{Type: t, Flags: p.flags | flags, PartID: part, Rank: p.spec.Rank}
}

// usable is the precondition of every GridPart call.
func (p *GridPart) usable() error {
	switch {
	case p.w.err != nil:
		return p.w.err
	case p.closed || p.w.ended:
		return ErrOrder
	}
	return nil
}

// batchSize is the series count of the next data batch: 1 for the first (T04-006), then
// clamp(⌊1 MiB / (8·len)⌋, 1, 64).
func (p *GridPart) batchSize() int {
	if p.batches == 0 {
		return 1
	}
	return min(max(batchBytes/(8*p.n), 1), batchSeries)
}

func labelBytes(s *pulsusdb.Series) int {
	n := 0
	for _, l := range s.Labels {
		n += len(l.Name) + len(l.Value) + 24 // + ids, key hash, offsets, validity
	}
	return n + 24
}

// Add adds one series: len(Values) == len(Present) == the grid's length, else ErrShape; a
// series whose labels cannot fit one labels frame is ErrFrameTooLarge. Either closes the part
// (outcome (b)). A batch is sent when it is full.
func (p *GridPart) Add(s *pulsusdb.Series) error {
	if err := p.usable(); err != nil {
		return err
	}
	if s == nil || len(s.Values) != p.n || len(s.Present) != p.n {
		return p.refuse(ErrShape)
	}
	lb := labelBytes(s)
	if lb+labelsOverhead > MaxPayload {
		return p.refuse(ErrFrameTooLarge)
	}
	if len(p.pending) > 0 && p.pendLab+lb+labelsOverhead > MaxPayload {
		if err := p.Flush(); err != nil {
			return err
		}
	}
	p.pending = append(p.pending, s)
	p.pendLab += lb
	if len(p.pending) >= p.batchSize() {
		return p.Flush()
	}
	return nil
}

// Flush sends the pending series: BATCH(L) with their label rows, then BATCH(D).
func (p *GridPart) Flush() error {
	if err := p.usable(); err != nil {
		return err
	}
	if len(p.pending) == 0 {
		return nil
	}
	f := p.w.frames()
	if err := p.addBatches(f, false); err != nil {
		return p.refuse(err)
	}
	return p.commitBatches(f)
}

// addBatches adds BATCH(L) and BATCH(D) of the pending series; last sets LAST on BATCH(L).
func (p *GridPart) addBatches(f *frameSet, last bool) error {
	var lf uint16
	if last {
		lf = FlagLast
	}
	lrec := labelsRecord(p.pending, p.sent)
	defer lrec.Release()
	drec := gridRecord(p.schema, p.pending, p.sent, p.n)
	defer drec.Release()
	if err := f.add(p.header(FrameBatch, p.spec.LabelsPart, lf), batchPayload(lrec)); err != nil {
		return err
	}
	return f.add(p.header(FrameBatch, p.spec.DataPart, 0), batchPayload(drec))
}

func (p *GridPart) commitBatches(f *frameSet) error {
	if err := f.commit(); err != nil {
		return err
	}
	p.sent += uint32(len(p.pending)) // #nosec G115 -- a batch holds ≤ 64 series (or one frame of labels)
	p.batches++
	p.pending, p.pendLab = nil, 0
	return nil
}

// Finish sends the pending series with LAST on the labels batch (or a 0-row labels batch),
// then META(D, c)|LAST. c must be PhaseFinal or PhasePartial, else ErrShape and nothing is
// written.
func (p *GridPart) Finish(c Coverage) error {
	if err := p.usable(); err != nil {
		return err
	}
	if c.Phase != PhaseFinal && c.Phase != PhasePartial {
		return ErrShape
	}
	f := p.w.frames()
	var err error
	if len(p.pending) > 0 {
		err = p.addBatches(f, true)
	} else {
		err = p.addEmptyLabels(f)
	}
	if err == nil {
		err = f.add(p.header(FrameMeta, p.spec.DataPart, FlagLast), coveragePayload(c))
	}
	if err != nil {
		return p.refuse(err)
	}
	if len(p.pending) > 0 {
		err = p.commitBatches(f)
	} else {
		err = f.commit()
	}
	if err == nil {
		p.closed = true
	}
	return err
}

func (p *GridPart) addEmptyLabels(f *frameSet) error {
	rec := labelsRecord(nil, 0)
	defer rec.Release()
	return f.add(p.header(FrameBatch, p.spec.LabelsPart, FlagLast), batchPayload(rec))
}

// Fail drops the pending series and writes a 0-row BATCH(L)|LAST, META(D, c) with
// PhasePartial and ERROR(D, e)|LAST.
func (p *GridPart) Fail(c Coverage, e ErrorRow) error {
	if err := p.usable(); err != nil {
		return err
	}
	c.Phase = PhasePartial
	return p.close(c, e, nil)
}

// refuse closes the part for a refused Add or flush (outcome (b)): the planned coverage as
// partial and ERROR code 8 "writer refused: shape" or "writer refused: frame too large".
func (p *GridPart) refuse(err error) error {
	c := p.planned
	c.Phase, c.SeriesReturned = PhasePartial, p.sent
	msg := "writer refused: shape"
	if errors.Is(err, ErrFrameTooLarge) {
		msg = "writer refused: frame too large"
	}
	return p.close(c, refusedRow(msg), err)
}

// close writes the failure close of the part: a 0-row BATCH(L)|LAST, META(D, c) and
// ERROR(D, e)|LAST, and returns cause (or a write error). If c or e makes a frame larger than
// MaxPayload, the close is written with boundCoverage(c) and boundError(e) instead, which keep
// the phase, the counts and the error's code and status, and it returns ErrFrameTooLarge. The
// part is closed only once its closing frames are written.
func (p *GridPart) close(c Coverage, e ErrorRow, cause error) error {
	p.pending, p.pendLab = nil, 0
	f, err := p.closeFrames(c, e)
	if errors.Is(err, ErrFrameTooLarge) {
		f, err = p.closeFrames(boundCoverage(c), boundError(e))
		if cause == nil {
			cause = ErrFrameTooLarge
		}
	}
	if err != nil {
		return err
	}
	if werr := f.commit(); werr != nil {
		return werr
	}
	p.closed = true
	return cause
}

func (p *GridPart) closeFrames(c Coverage, e ErrorRow) (*frameSet, error) {
	f := p.w.frames()
	err := p.addEmptyLabels(f)
	if err == nil {
		err = f.add(p.header(FrameMeta, p.spec.DataPart, 0), coveragePayload(c))
	}
	if err == nil {
		err = f.add(p.header(FrameError, p.spec.DataPart, FlagLast), errorPayload(e))
	}
	return f, err
}

// The bounds of a close written after an oversized coverage or error (outcome (b)): far below
// MaxPayload, so the bounded frames always fit.
const (
	boundListBytes  = 1 << 20 // string bytes kept over the four coverage lists
	boundListItems  = 4096    // list elements kept
	boundReason     = 64      // truncation_reason bytes
	boundMessage    = 1 << 20 // error message bytes
	boundSuggestion = 256 << 10
	cutMarker       = "…(truncated)"
)

// cutUTF8 cuts s to at most n bytes at a UTF-8 boundary, ending with cutMarker when cut.
func cutUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	k := max(n-len(cutMarker), 0)
	for k > 0 && !uni.RuneStart(s[k]) {
		k--
	}
	return s[:k] + cutMarker
}

// boundCoverage is c as a partial, truncated coverage whose lists and reason are cut to the
// bounds above (reason "coverage_cut" if c had none).
func boundCoverage(c Coverage) Coverage {
	c.Phase, c.Truncated = PhasePartial, true
	reason := "coverage_cut"
	if c.TruncationReason != nil {
		reason = cutUTF8(*c.TruncationReason, boundReason)
	}
	c.TruncationReason = &reason
	bytes, items := 0, 0
	cut := func(xs []string) []string {
		out := []string{}
		for _, x := range xs {
			if items >= boundListItems || bytes >= boundListBytes {
				break
			}
			x = cutUTF8(x, boundListBytes-bytes)
			bytes, items = bytes+len(x), items+1
			out = append(out, x)
		}
		return out
	}
	c.ExcludedDims, c.Warnings, c.Infos, c.UpstreamQueryIDs = cut(c.ExcludedDims), cut(c.Warnings), cut(c.Infos), cut(c.UpstreamQueryIDs)
	return c
}

// boundError is e with its message and suggestion cut to the bounds above; code, status,
// position and retry are kept.
func boundError(e ErrorRow) ErrorRow {
	e.Message = cutUTF8(e.Message, boundMessage)
	if e.Suggestion != nil {
		s := cutUTF8(*e.Suggestion, boundSuggestion)
		e.Suggestion = &s
	}
	return e
}

// pad64 rounds n up to a multiple of 64 (grid buffers, §3.2).
func pad64(n int) int { return (n + 63) &^ 63 }

func bufOf(b []byte) *memory.Buffer { return memory.NewBufferBytes(b) }

// gridRecord is the metric_matrix.grid/1 batch of series with ids from first. Every buffer is
// allocated with its length rounded up to 64 so arrow-go keeps it whole and each column
// starts at a body offset ≡ 0 (mod 64). Absent slots hold nullBits; values keep their bits.
func gridRecord(schema *arrow.Schema, series []*pulsusdb.Series, first uint32, n int) arrow.RecordBatch {
	k := len(series)
	ids := make([]byte, pad64(4*k))
	vals := make([]byte, pad64(8*k*n))
	valid := make([]byte, pad64((k*n+7)/8))
	nulls := 0
	for i, s := range series {
		binary.LittleEndian.PutUint32(ids[4*i:], first+uint32(i))
		for j, v := range s.Values {
			slot := i*n + j
			bits := uint64(nullBits)
			if s.Present[j] {
				bits = math.Float64bits(v)
				valid[slot/8] |= 1 << (slot % 8)
			} else {
				nulls++
			}
			binary.LittleEndian.PutUint64(vals[8*slot:], bits)
		}
	}
	var validity *memory.Buffer
	if nulls > 0 {
		validity = bufOf(valid)
	}
	child := array.NewData(f64, k*n, []*memory.Buffer{validity, bufOf(vals)}, nil, nulls, 0)
	defer child.Release()
	list := array.NewData(schema.Field(1).Type, k, []*memory.Buffer{nil}, []arrow.ArrayData{child}, 0, 0)
	defer list.Release()
	idd := array.NewData(u32, k, []*memory.Buffer{nil, bufOf(ids)}, nil, 0, 0)
	defer idd.Release()
	ida, la := array.MakeFromData(idd), array.MakeFromData(list)
	defer ida.Release()
	defer la.Release()
	return array.NewRecordBatch(schema, []arrow.Array{ida, la}, int64(k))
}

// stringColumn builds a nullable utf8 array from vals (nil = null).
func stringColumn(vals []*string) arrow.Array {
	offsets := make([]byte, 4*(len(vals)+1))
	valid := make([]byte, (len(vals)+7)/8)
	var data []byte
	nulls := 0
	for i, v := range vals {
		if v == nil {
			nulls++
		} else {
			valid[i/8] |= 1 << (i % 8)
			data = append(data, *v...)
		}
		binary.LittleEndian.PutUint32(offsets[4*(i+1):], uint32(len(data))) // #nosec G115 -- Add keeps a labels batch ≤ MaxPayload < 2³¹
	}
	var validity *memory.Buffer
	if nulls > 0 {
		validity = bufOf(valid)
	}
	d := array.NewData(utf8, len(vals), []*memory.Buffer{validity, bufOf(offsets), bufOf(data)}, nil, nulls, 0)
	defer d.Release()
	return array.MakeFromData(d)
}

// labelsRecord is the labels/1 batch of series with ids from first: one row per label in
// label-name order, one all-null row for a series without labels.
func labelsRecord(series []*pulsusdb.Series, first uint32) arrow.RecordBatch {
	var ids, keys []byte
	var ks, vs []*string
	for i, s := range series {
		id := first + uint32(i)
		row := func(k, v *string) {
			ids = binary.LittleEndian.AppendUint32(ids, id)
			keys = binary.LittleEndian.AppendUint64(keys, s.Key)
			ks, vs = append(ks, k), append(vs, v)
		}
		if len(s.Labels) == 0 {
			row(nil, nil)
		}
		for j := range s.Labels {
			row(&s.Labels[j].Name, &s.Labels[j].Value)
		}
	}
	r := len(ks)
	idd := array.NewData(u32, r, []*memory.Buffer{nil, bufOf(ids)}, nil, 0, 0)
	defer idd.Release()
	kd := array.NewData(u64, r, []*memory.Buffer{nil, bufOf(keys)}, nil, 0, 0)
	defer kd.Release()
	cols := []arrow.Array{array.MakeFromData(idd), array.MakeFromData(kd), stringColumn(ks), stringColumn(vs)}
	defer func() {
		for _, c := range cols {
			c.Release()
		}
	}()
	return array.NewRecordBatch(labels1, cols, int64(r))
}
