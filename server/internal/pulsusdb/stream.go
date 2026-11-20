package pulsusdb

import (
	"context"
	"errors"
	"fmt"
	"io"
	"slices"
	"strconv"
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
	if b.pointsCut {
		b.c.Truncated = true
		b.c.Warnings = append(b.c.Warnings, fmt.Sprintf("pulsus-dash: response truncated at %d points", b.lim.MaxPoints))
	}
	b.omittedW, b.omittedI, b.pointsCut = 0, 0, false
	return b.c
}

// instantForm is the shape of an instant result element.
type instantForm uint8

const (
	formNone   instantForm = iota // empty result
	formVector                    // series with "value"
	formMatrix                    // series with "values"
	formPair                      // [t, "v"]: scalar or string
)

// errPointsCut stops decoding when the next series would exceed Limits.MaxPoints.
var errPointsCut = errors.New("pulsusdb: points limit")

// ResultStream yields the series of one range or instant response. It is owned by one goroutine;
// Close is idempotent and frees the body and the tenant slot.
type ResultStream struct {
	ctx  context.Context
	dec  *upstreamDecoder
	resp *response
	lim  Limits
	comp *compBuilder

	stream  bool // range: series are decoded on Next
	grid    Grid
	ts      []int64 // the grid's timestamps, shared
	emitted int     // grid points handed out

	started, inData, resultSeen, badStatus bool
	seenType                               ResultType
	typ                                    ResultType

	series  []*Series // instant
	idx     int
	form    instantForm
	points  int
	pairT   int64
	scalarV float64
	scalarO bool
	strV    string

	final  Completeness
	done   bool
	err    error
	closed bool
}

// Type is the result type.
func (s *ResultStream) Type() ResultType { return s.typ }

// Scalar is the scalar result (Type() == scalar).
func (s *ResultStream) Scalar() (tsMs int64, v float64, ok bool) {
	return s.pairT, s.scalarV, s.typ == ResultScalar
}

// StringValue is the string result (Type() == string), redacted and cut.
func (s *ResultStream) StringValue() (tsMs int64, v string, ok bool) {
	return s.pairT, s.strV, s.typ == ResultString
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
	if s.done && !s.stream {
		if s.idx < len(s.series) {
			s.idx++
			return s.series[s.idx-1], nil
		}
		return nil, io.EOF
	}
	if s.done {
		return nil, io.EOF
	}
	k, err := s.dec.Next()
	if err != nil {
		return nil, s.fail(err)
	}
	switch k {
	case tokArrEnd:
		s.inData = true
		if at, err := s.walk(); err != nil || at {
			return nil, s.fail(orProtocol(err))
		}
		if err := s.endCheck(); err != nil {
			return nil, s.fail(err)
		}
		s.finish()
		return nil, io.EOF
	case tokObjStart:
		n := s.grid.points()
		if s.emitted+n > s.lim.MaxPoints {
			s.comp.pointsCut = true
			s.finish()
			return nil, io.EOF
		}
		ser, err := s.rangeSeries()
		if err != nil {
			return nil, s.fail(err)
		}
		s.emitted += n
		return ser, nil
	}
	return nil, s.fail(protocolError())
}

func orProtocol(err error) error {
	if err == nil {
		return protocolError()
	}
	return err
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

// walk reads top-level members (and those of data) until data.result begins on a range stream
// (true), or the document ends (false). It resumes where it stopped.
func (s *ResultStream) walk() (bool, error) {
	d := s.dec
	if !s.started {
		k, err := d.Next()
		if err != nil {
			return false, err
		}
		if k != tokObjStart {
			return false, protocolError()
		}
		s.started = true
	}
	for {
		if s.inData {
			at, err := s.walkData()
			if err != nil || at {
				return at, err
			}
			s.inData = false
			continue
		}
		k, err := d.Next()
		if err != nil {
			return false, err
		}
		if k == tokObjEnd {
			if k, err := d.Next(); err != nil || k != tokEOF {
				return false, orProtocol(err)
			}
			return false, nil
		}
		switch key := d.String(); key {
		case "data":
			if k, err := d.Next(); err != nil || k != tokObjStart {
				return false, orProtocol(err)
			}
			s.inData = true
		case "status":
			if err := s.status(); err != nil {
				return false, err
			}
		case "warnings", "infos":
			if err := s.comp.messages(d, key == "warnings"); err != nil {
				return false, err
			}
		case "truncated":
			if err := s.comp.flag(d); err != nil {
				return false, err
			}
		default:
			if err := skipValue(d); err != nil {
				return false, err
			}
		}
	}
}

func (s *ResultStream) walkData() (bool, error) {
	d := s.dec
	for {
		k, err := d.Next()
		if err != nil {
			return false, err
		}
		if k == tokObjEnd {
			return false, nil
		}
		switch d.String() {
		case "resultType":
			if k, err := d.Next(); err != nil || k != tokString {
				return false, orProtocol(err)
			}
			s.seenType = ResultType(d.String())
			if s.stream && s.seenType != ResultMatrix {
				return false, protocolError()
			}
		case "result":
			if s.resultSeen {
				return false, protocolError()
			}
			s.resultSeen = true
			if s.stream {
				if k, err := d.Next(); err != nil || k != tokArrStart {
					return false, orProtocol(err)
				}
				return true, nil
			}
			if err := s.instantResult(); err != nil {
				return false, err
			}
		case "truncated":
			if err := s.comp.flag(d); err != nil {
				return false, err
			}
		default:
			if err := skipValue(d); err != nil {
				return false, err
			}
		}
	}
}

// status checks a status member: anything but success fails, at once before the result, else at
// the end.
func (s *ResultStream) status() error {
	if k, err := s.dec.Next(); err != nil || k != tokString {
		return orProtocol(err)
	}
	if s.dec.String() != "success" {
		if !s.resultSeen {
			return protocolError()
		}
		s.badStatus = true
	}
	return nil
}

// endCheck validates the whole document once it ended.
func (s *ResultStream) endCheck() error {
	if s.badStatus || !s.resultSeen {
		return protocolError()
	}
	if s.stream {
		if s.seenType != ResultMatrix {
			return protocolError()
		}
		return nil
	}
	ok := false
	switch s.seenType {
	case ResultVector:
		ok = s.form == formVector || s.form == formNone
	case ResultMatrix:
		ok = s.form == formMatrix || s.form == formNone
	case ResultScalar:
		ok = s.form == formPair && s.scalarO
	case ResultString:
		ok = s.form == formPair
	}
	if !ok {
		return protocolError()
	}
	s.typ = s.seenType
	return nil
}

func skipValue(d *upstreamDecoder) error {
	if _, err := d.Next(); err != nil {
		return err
	}
	return d.Skip()
}

// labels reads a metric object; names and values are redacted and cut, the result sorted.
func (s *ResultStream) labels() ([]Label, error) {
	return readLabels(s.dec)
}

func readLabels(d *upstreamDecoder) ([]Label, error) {
	if k, err := d.Next(); err != nil || k != tokObjStart {
		return nil, orProtocol(err)
	}
	return readLabelBody(d)
}

// readLabelBody reads the members of a label object whose '{' was read.
func readLabelBody(d *upstreamDecoder) ([]Label, error) {
	var ls []Label
	for {
		k, err := d.Next()
		if err != nil {
			return nil, err
		}
		if k == tokObjEnd {
			break
		}
		name := cutData(d.String())
		if k, err := d.Next(); err != nil || k != tokString {
			return nil, orProtocol(err)
		}
		ls = append(ls, Label{Name: name, Value: cutData(d.String())})
	}
	slices.SortFunc(ls, func(a, b Label) int {
		if c := strings.Compare(a.Name, b.Name); c != 0 {
			return c
		}
		return strings.Compare(a.Value, b.Value)
	})
	if ls == nil {
		ls = []Label{}
	}
	return ls, nil
}

// point reads [t, "v"] after its opening bracket was read.
func (s *ResultStream) point() (int64, float64, error) {
	d := s.dec
	if k, err := d.Next(); err != nil || k != tokNumber {
		return 0, 0, orProtocol(err)
	}
	n, _ := d.Number()
	ms, ok := secondsToMs(n)
	if !ok {
		return 0, 0, protocolError()
	}
	if k, err := d.Next(); err != nil || k != tokString {
		return 0, 0, orProtocol(err)
	}
	v, err := d.Sample()
	if err != nil {
		return 0, 0, err
	}
	if k, err := d.Next(); err != nil || k != tokArrEnd {
		return 0, 0, orProtocol(err)
	}
	return ms, v, nil
}

// rangeSeries reads one matrix series (its '{' was read) onto the grid.
func (s *ResultStream) rangeSeries() (*Series, error) {
	d := s.dec
	n := s.grid.points()
	ser := &Series{Timestamps: s.ts, Values: make([]float64, n), Present: make([]bool, n)}
	gotMetric, gotValues := false, false
	for {
		k, err := d.Next()
		if err != nil {
			return nil, err
		}
		if k == tokObjEnd {
			break
		}
		switch d.String() {
		case "metric":
			if ser.Labels, err = s.labels(); err != nil {
				return nil, err
			}
			gotMetric = true
		case "values":
			if err := s.gridPoints(ser); err != nil {
				return nil, err
			}
			gotValues = true
		case "value":
			return nil, protocolError()
		default:
			if err := skipValue(d); err != nil {
				return nil, err
			}
		}
	}
	if !gotMetric || !gotValues {
		return nil, protocolError()
	}
	ser.Key = keyhash.Labels(ser.Labels)
	return ser, nil
}

// gridPoints places a values array on the grid; an off-grid timestamp is KindProtocol.
func (s *ResultStream) gridPoints(ser *Series) error {
	d := s.dec
	if k, err := d.Next(); err != nil || k != tokArrStart {
		return orProtocol(err)
	}
	g := s.grid
	for {
		k, err := d.Next()
		if err != nil {
			return err
		}
		if k == tokArrEnd {
			return nil
		}
		if k != tokArrStart {
			return protocolError()
		}
		ms, v, err := s.point()
		if err != nil {
			return err
		}
		if ms < g.Start || ms > g.End || (ms-g.Start)%g.Step != 0 {
			return protocolError()
		}
		i := (ms - g.Start) / g.Step
		ser.Values[i], ser.Present[i] = v, true
		if ms > s.comp.c.NewestSampleMs {
			s.comp.c.NewestSampleMs = ms
		}
	}
}

// instantResult reads a whole instant result array: a [t, "v"] pair or series objects.
func (s *ResultStream) instantResult() error {
	d := s.dec
	if k, err := d.Next(); err != nil || k != tokArrStart {
		return orProtocol(err)
	}
	k, err := d.Next()
	if err != nil {
		return err
	}
	switch k {
	case tokArrEnd:
		return nil
	case tokNumber:
		n, _ := d.Number()
		ms, ok := secondsToMs(n)
		if !ok {
			return protocolError()
		}
		if k, err := d.Next(); err != nil || k != tokString {
			return orProtocol(err)
		}
		v, ferr := d.Sample()
		s.form, s.pairT, s.scalarV, s.scalarO, s.strV = formPair, ms, v, ferr == nil, cutData(d.String())
		if k, err := d.Next(); err != nil || k != tokArrEnd {
			return orProtocol(err)
		}
		return nil
	case tokObjStart:
		for {
			if err := s.instantSeries(); err != nil {
				return err
			}
			k, err := d.Next()
			if err != nil {
				return err
			}
			if k == tokArrEnd {
				return nil
			}
			if k != tokObjStart {
				return protocolError()
			}
		}
	}
	return protocolError()
}

// instantSeries reads one vector sample or matrix series (its '{' was read), points as given.
func (s *ResultStream) instantSeries() error {
	d := s.dec
	ser := &Series{}
	var form instantForm
	gotMetric := false
	for {
		k, err := d.Next()
		if err != nil {
			return err
		}
		if k == tokObjEnd {
			break
		}
		switch key := d.String(); key {
		case "metric":
			if ser.Labels, err = s.labels(); err != nil {
				return err
			}
			gotMetric = true
		case "value", "values":
			if form != formNone {
				return protocolError()
			}
			if k, err := d.Next(); err != nil || k != tokArrStart {
				return orProtocol(err)
			}
			if key == "value" {
				form = formVector
				ms, v, err := s.point()
				if err != nil {
					return err
				}
				ser.add(ms, v)
				continue
			}
			form = formMatrix
			for {
				k, err := d.Next()
				if err != nil {
					return err
				}
				if k == tokArrEnd {
					break
				}
				if k != tokArrStart {
					return protocolError()
				}
				ms, v, err := s.point()
				if err != nil {
					return err
				}
				ser.add(ms, v)
			}
		default:
			if err := skipValue(d); err != nil {
				return err
			}
		}
	}
	if !gotMetric || form == formNone || (s.form != formNone && s.form != form) {
		return protocolError()
	}
	s.form = form
	if s.points+len(ser.Values) > s.lim.MaxPoints {
		return errPointsCut
	}
	s.points += len(ser.Values)
	ser.Key = keyhash.Labels(ser.Labels)
	s.series = append(s.series, ser)
	return nil
}

func (ser *Series) add(ms int64, v float64) {
	ser.Timestamps = append(ser.Timestamps, ms)
	ser.Values = append(ser.Values, v)
	ser.Present = append(ser.Present, true)
}

// secondsToMs converts a JSON number of seconds to integer ms without floats: digits, then at
// most 3 fraction digits (more only if all zero). A sign or an exponent is refused.
func secondsToMs(s string) (int64, bool) {
	whole, frac, dot := strings.Cut(s, ".")
	if whole == "" || len(whole) > 15 || !allDigits(whole) || (dot && (frac == "" || !allDigits(frac))) {
		return 0, false
	}
	if len(frac) > 3 {
		if strings.Trim(frac[3:], "0") != "" {
			return 0, false
		}
		frac = frac[:3]
	}
	frac += strings.Repeat("0", 3-len(frac))
	sec, err := strconv.ParseInt(whole, 10, 64)
	if err != nil {
		return 0, false
	}
	ms, _ := strconv.ParseInt(frac, 10, 64)
	return sec*1000 + ms, true
}

func allDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return true
}
