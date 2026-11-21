package pulsusdb

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
)

// Label is one label of a series.
type Label = keyhash.Label

// ResultType is the upstream resultType.
type ResultType string

// The result types.
const (
	ResultMatrix ResultType = "matrix"
	ResultVector ResultType = "vector"
	ResultScalar ResultType = "scalar"
	ResultString ResultType = "string"
)

// Series is one series. For a range query it is placed on the request grid: Timestamps holds
// every grid point (shared by the series of one stream; read-only), Values and Present have the
// same length, and Present[i] is false where PulsusDB gave no point (never filled, T04-005).
// NaN and ±Inf are values.
type Series struct {
	Key        uint64  // keyhash.Labels(Labels)
	Labels     []Label // sorted by Name
	Timestamps []int64 // ms
	Values     []float64
	Present    []bool
}

// Completeness is the completeness block of a response (PRF-031).
type Completeness struct {
	Truncated          bool
	Warnings, Infos    []string // redacted and cleaned, in order, ≤ MaxMessages each; never nil
	QueryID            string   // X-Pulsus-Query-Id when accepted (§4.9), else ""
	ReadCache          string   // hit | miss | bypass | other | "" (absent)
	ReadCacheThroughMs int64    // -1 when absent
	NewestSampleMs     int64    // newest present sample (range only); -1 = none
}

// compBuilder collects the completeness of one response.
type compBuilder struct {
	c                  Completeness
	lim                Limits
	omittedW, omittedI int
	pointsCut          bool
	histSkipped        int // series whose native histogram samples were skipped
}

func newComp(h upstreamHeaders, lim Limits) *compBuilder {
	return &compBuilder{lim: lim, c: Completeness{Warnings: []string{}, Infos: []string{}, QueryID: h.QueryID,
		ReadCache: h.ReadCache, ReadCacheThroughMs: h.ReadCacheThroughMs, NewestSampleMs: -1}}
}

// messages reads a warnings or infos array: each redacted (by String) and cleaned; a text that
// mentions "truncated" (ASCII case-insensitive) marks the response truncated.
func (b *compBuilder) messages(d *upstreamDecoder, warnings bool) error {
	k, err := d.Next()
	if err != nil || k == tokNull {
		return err
	}
	if k != tokArrStart {
		return protocolError()
	}
	list, omitted := &b.c.Infos, &b.omittedI
	if warnings {
		list, omitted = &b.c.Warnings, &b.omittedW
	}
	for {
		k, err := d.Next()
		if err != nil {
			return err
		}
		if k == tokArrEnd {
			return nil
		}
		if k != tokString {
			return protocolError()
		}
		t := d.String()
		if strings.Contains(strings.ToLower(t), "truncated") {
			b.c.Truncated = true
		}
		if len(*list) < b.lim.MaxMessages {
			*list = append(*list, cleanText(t, b.lim.TextBytes))
		} else {
			*omitted++
		}
	}
}

// flag reads a truncated member: only a JSON true counts.
func (b *compBuilder) flag(d *upstreamDecoder) error {
	k, err := d.Next()
	if err != nil {
		return err
	}
	if k == tokBool && d.Bool() {
		b.c.Truncated = true
	}
	return d.Skip()
}

func (b *compBuilder) finish() Completeness {
	if b.omittedW > 0 {
		b.c.Warnings = append(b.c.Warnings, fmt.Sprintf("pulsus-dash: %d more warnings omitted", b.omittedW))
	}
	if b.omittedI > 0 {
		b.c.Infos = append(b.c.Infos, fmt.Sprintf("pulsus-dash: %d more infos omitted", b.omittedI))
	}
	if b.histSkipped > 0 {
		b.c.Warnings = append(b.c.Warnings, fmt.Sprintf("pulsus-dash: native histogram samples skipped in %d series", b.histSkipped))
	}
	if b.pointsCut {
		b.c.Truncated = true
		b.c.Warnings = append(b.c.Warnings, fmt.Sprintf("pulsus-dash: response truncated at %d points", b.lim.MaxPoints))
	}
	b.omittedW, b.omittedI, b.pointsCut, b.histSkipped = 0, 0, false, 0
	return b.c
}

// ResultStream yields the series of one range or instant response. Its body is decoded by a
// seriesSource chosen from the response's Content-Type; ResultStream places range series on the
// grid after decoding, so every source shares the placement. It is owned by one goroutine; Close
// is idempotent and frees the body and the tenant slot.
type ResultStream struct {
	ctx  context.Context
	src  seriesSource
	resp *response
	lim  Limits
	comp *compBuilder

	stream  bool // range: series are decoded on Next
	grid    Grid
	ts      []int64   // the grid's timestamps, shared
	emitted int       // grid points handed out
	raw     rawSeries // the source's buffer, reused across series

	typ    ResultType
	series []*Series // instant
	idx    int
	inst   instantResult

	final  Completeness
	done   bool
	err    error
	closed bool
}

// newRangeStream returns the range stream of src on grid g; src has read up to the first series.
func newRangeStream(ctx context.Context, src seriesSource, resp *response, lim Limits, comp *compBuilder, g Grid) *ResultStream {
	rs := &ResultStream{ctx: ctx, src: src, resp: resp, lim: lim, comp: comp, stream: true, grid: g, typ: ResultMatrix}
	rs.ts = make([]int64, g.points())
	for i := range rs.ts {
		rs.ts[i] = g.Start + int64(i)*g.Step
	}
	return rs
}

// newInstantStream returns the stream of a decoded instant result; the body is released.
func newInstantStream(ctx context.Context, src seriesSource, resp *response, lim Limits, comp *compBuilder, res instantResult) *ResultStream {
	rs := &ResultStream{ctx: ctx, src: src, resp: resp, lim: lim, comp: comp, typ: res.typ, series: res.series, inst: res}
	if res.cut {
		comp.pointsCut = true
	}
	rs.finish()
	return rs
}

// Type is the result type.
func (s *ResultStream) Type() ResultType { return s.typ }

// Scalar is the scalar result (Type() == scalar).
func (s *ResultStream) Scalar() (tsMs int64, v float64, ok bool) {
	return s.inst.t, s.inst.scalar, s.typ == ResultScalar
}

// StringValue is the string result (Type() == string), redacted and cut.
func (s *ResultStream) StringValue() (tsMs int64, v string, ok bool) {
	return s.inst.t, s.inst.str, s.typ == ResultString
}

// Completeness is final once Next returned io.EOF.
func (s *ResultStream) Completeness() Completeness {
	if s.done {
		return s.final
	}
	return s.comp.c
}

// Close releases the body and the slot; it is idempotent.
func (s *ResultStream) Close() error {
	if !s.closed {
		s.closed = true
		s.resp.close()
	}
	return nil
}

// Next returns the next series, or io.EOF after the last.
func (s *ResultStream) Next() (*Series, error) {
	if s.err != nil {
		return nil, s.err
	}
	if !s.stream {
		if s.idx < len(s.series) {
			s.idx++
			return s.series[s.idx-1], nil
		}
		return nil, io.EOF
	}
	if s.done {
		return nil, io.EOF
	}
	err := s.src.nextRange(&s.raw)
	if err == io.EOF {
		s.finish()
		return nil, io.EOF
	}
	if err != nil {
		return nil, s.fail(err)
	}
	n := s.grid.points()
	if s.emitted+n > s.lim.MaxPoints {
		s.comp.pointsCut = true
		s.finish()
		return nil, io.EOF
	}
	ser, err := s.place(&s.raw)
	if err != nil {
		return nil, s.fail(err)
	}
	s.emitted += n
	return ser, nil
}

// place puts a decoded series on the grid; an off-grid timestamp is KindProtocol. Absent points
// stay absent (T04-005).
func (s *ResultStream) place(r *rawSeries) (*Series, error) {
	g := s.grid
	n := g.points()
	ser := &Series{Labels: r.Labels, Timestamps: s.ts, Values: make([]float64, n), Present: make([]bool, n)}
	if ser.Labels == nil {
		ser.Labels = []Label{}
	}
	for i, ms := range r.T {
		if ms < g.Start || ms > g.End || (ms-g.Start)%g.Step != 0 {
			return nil, protocolError()
		}
		j := (ms - g.Start) / g.Step
		ser.Values[j], ser.Present[j] = r.V[i], true
		if ms > s.comp.c.NewestSampleMs {
			s.comp.c.NewestSampleMs = ms
		}
	}
	ser.Key = keyhash.Labels(ser.Labels)
	return ser, nil
}

func (s *ResultStream) fail(err error) error {
	s.err = readError(s.ctx, err)
	s.resp.close()
	return s.err
}

// finish completes the stream: the completeness is final and the slot is freed.
func (s *ResultStream) finish() {
	s.final = s.comp.finish()
	s.done = true
	s.resp.close()
}
