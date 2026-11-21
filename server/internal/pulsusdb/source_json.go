package pulsusdb

import (
	"bytes"
	"errors"
	"io"
	"slices"
	"strings"

	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
)

// jsonSource decodes a PromQL HTTP API JSON body (application/json) with the request's
// tokenizer, so every key and string it yields went through the redactor. It reads both member
// orders: data.result may come before or after resultType, status and the completeness members.
type jsonSource struct {
	dec  *upstreamDecoder
	comp *compBuilder
	lim  Limits

	rangeMode, started, inData, resultSeen, badStatus bool
	seenType                                          ResultType

	// Logs mode (#65 §4.1): a log query_range body, whose member order is not fixed either.
	logs     bool
	mode     logMode
	raw      []byte       // the result value, captured because it came before resultType
	logsRes  *logResponse // the decoded streams result
	buffered bool         // matrix series are read from the captured value; the body has ended

	res     instantResult // instant
	form    instantForm
	nPoints int // instant points decoded
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

func (s *jsonSource) openRange() error {
	s.rangeMode = true
	at, err := s.walk()
	if err == nil && !at {
		err = s.endCheck()
		if err == nil {
			err = protocolError() // a matrix document without a result array
		}
	}
	return err
}

func (s *jsonSource) nextRange(r *rawSeries) error {
	for {
		k, err := s.dec.Next()
		if err != nil {
			return err
		}
		switch k {
		case tokArrEnd:
			if s.buffered {
				// The tail of the document was walked before the capture was decoded.
				if k, err := s.dec.Next(); err != nil || k != tokEOF {
					return orProtocol(err)
				}
				return io.EOF
			}
			s.inData = true
			if at, err := s.walk(); err != nil || at {
				return orProtocol(err)
			}
			if err := s.endCheck(); err != nil {
				return err
			}
			return io.EOF
		case tokObjStart:
			kept, err := s.rangeSeries(r)
			if err != nil || kept {
				return err
			}
		default:
			return protocolError()
		}
	}
}

func (s *jsonSource) readInstant() (instantResult, error) {
	_, err := s.walk()
	switch {
	case errors.Is(err, errPointsCut):
		s.res.cut = true
		s.res.typ = s.seenType
		if s.res.typ != ResultMatrix {
			s.res.typ = ResultVector
		}
		return s.res, nil
	case err != nil:
		return instantResult{}, err
	}
	if err := s.endCheck(); err != nil {
		return instantResult{}, err
	}
	return s.res, nil
}

// walk reads top-level members (and those of data) until data.result begins on a range body
// (true), or the document ends (false). It resumes where it stopped.
func (s *jsonSource) walk() (bool, error) {
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

func (s *jsonSource) walkData() (bool, error) {
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
			if s.logs {
				if err := s.logsType(ResultType(d.String())); err != nil {
					return false, err
				}
				continue
			}
			s.seenType = ResultType(d.String())
			if s.rangeMode && s.seenType != ResultMatrix {
				return false, protocolError()
			}
		case "result":
			if s.resultSeen {
				return false, protocolError()
			}
			s.resultSeen = true
			if s.logs {
				at, err := s.logsResult()
				if err != nil || at {
					return at, err
				}
				continue
			}
			if s.rangeMode {
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
func (s *jsonSource) status() error {
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
func (s *jsonSource) endCheck() error {
	if s.badStatus || !s.resultSeen {
		return protocolError()
	}
	if s.logs {
		if s.seenType == "" {
			return protocolError()
		}
		return nil
	}
	if s.rangeMode {
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
		ok = s.form == formPair && s.res.scalarOK
	case ResultString:
		ok = s.form == formPair
	}
	if !ok {
		return protocolError()
	}
	s.res.typ = s.seenType
	return nil
}

// rangeSeries reads one matrix series (its '{' was read) into r, its points as given. A series
// with native histograms and no values is skipped (false); histogram samples next to values are
// dropped. Both count towards the completeness warning.
func (s *jsonSource) rangeSeries(r *rawSeries) (bool, error) {
	d := s.dec
	r.Labels, r.T, r.V = nil, r.T[:0], r.V[:0]
	gotMetric, gotValues, hist := false, false, false
	for {
		k, err := d.Next()
		if err != nil {
			return false, err
		}
		if k == tokObjEnd {
			break
		}
		switch d.String() {
		case "metric":
			if r.Labels, err = readLabels(d); err != nil {
				return false, err
			}
			gotMetric = true
		case "values":
			if err := s.rawPoints(r); err != nil {
				return false, err
			}
			gotValues = true
		case "value":
			return false, protocolError()
		case "histograms":
			if err := skipValue(d); err != nil {
				return false, err
			}
			hist = true
		default:
			if err := skipValue(d); err != nil {
				return false, err
			}
		}
	}
	if !gotMetric || (!gotValues && !hist) {
		return false, protocolError()
	}
	if hist {
		s.comp.histSkipped++
	}
	return gotValues, nil
}

// rawPoints reads a values array of [t, "v"] pairs into r (the range hot path: no callback).
func (s *jsonSource) rawPoints(r *rawSeries) error {
	d := s.dec
	if k, err := d.Next(); err != nil || k != tokArrStart {
		return orProtocol(err)
	}
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
		r.T, r.V = append(r.T, ms), append(r.V, v)
	}
}

// points reads a values array of [t, "v"] pairs and hands each to add.
func (s *jsonSource) points(add func(ms int64, v float64)) error {
	d := s.dec
	if k, err := d.Next(); err != nil || k != tokArrStart {
		return orProtocol(err)
	}
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
		add(ms, v)
	}
}

// point reads [t, "v"] after its opening bracket was read.
func (s *jsonSource) point() (int64, float64, error) {
	d := s.dec
	if k, err := d.Next(); err != nil || k != tokNumber {
		return 0, 0, orProtocol(err)
	}
	n, _ := d.numberBytes()
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

// instantResult reads a whole instant result array: a [t, "v"] pair or series objects.
func (s *jsonSource) instantResult() error {
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
		n, _ := d.numberBytes()
		ms, ok := secondsToMs(n)
		if !ok {
			return protocolError()
		}
		if k, err := d.Next(); err != nil || k != tokString {
			return orProtocol(err)
		}
		v, ferr := d.Sample()
		s.form = formPair
		s.res.t, s.res.scalar, s.res.scalarOK, s.res.str = ms, v, ferr == nil, cutData(d.String())
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

// instantSeries reads one vector sample or matrix series (its '{' was read), points as given. A
// sample or series with native histograms only is skipped and counted.
func (s *jsonSource) instantSeries() error {
	d := s.dec
	ser := &Series{}
	var form instantForm
	gotMetric, hist := false, false
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
			if ser.Labels, err = readLabels(d); err != nil {
				return err
			}
			gotMetric = true
		case "value":
			if form != formNone {
				return protocolError()
			}
			if k, err := d.Next(); err != nil || k != tokArrStart {
				return orProtocol(err)
			}
			form = formVector
			ms, v, err := s.point()
			if err != nil {
				return err
			}
			ser.add(ms, v)
		case "values":
			if form != formNone {
				return protocolError()
			}
			form = formMatrix
			if err := s.points(ser.add); err != nil {
				return err
			}
		case "histogram", "histograms":
			if err := skipValue(d); err != nil {
				return err
			}
			hist = true
		default:
			if err := skipValue(d); err != nil {
				return err
			}
		}
	}
	if !gotMetric || (form == formNone && !hist) {
		return protocolError()
	}
	if hist {
		s.comp.histSkipped++
	}
	if form == formNone {
		return nil
	}
	if s.form != formNone && s.form != form {
		return protocolError()
	}
	s.form = form
	if s.nPoints+len(ser.Values) > s.lim.MaxPoints {
		return errPointsCut
	}
	s.nPoints += len(ser.Values)
	ser.Key = keyhash.Labels(ser.Labels)
	s.res.series = append(s.res.series, ser)
	return nil
}

func (ser *Series) add(ms int64, v float64) {
	ser.Timestamps = append(ser.Timestamps, ms)
	ser.Values = append(ser.Values, v)
	ser.Present = append(ser.Present, true)
}

func orProtocol(err error) error {
	if err == nil {
		return protocolError()
	}
	return err
}

func skipValue(d *upstreamDecoder) error {
	if _, err := d.Next(); err != nil {
		return err
	}
	return d.Skip()
}

// readLabels reads a metric object; names and values are redacted and cut, the result sorted.
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

// secondsToMs converts a JSON number of seconds to integer ms without floats: 1 to 15 digits,
// then at most 3 fraction digits (more only if all zero). A sign or an exponent is refused.
func secondsToMs(s []byte) (int64, bool) {
	var sec int64
	i := 0
	for ; i < len(s) && s[i] >= '0' && s[i] <= '9'; i++ {
		sec = sec*10 + int64(s[i]-'0')
	}
	if i == 0 || i > 15 {
		return 0, false
	}
	ms := sec * 1000
	if i == len(s) {
		return ms, true
	}
	if s[i] != '.' || i+1 == len(s) {
		return 0, false
	}
	scale := int64(100)
	for j := i + 1; j < len(s); j++ {
		c := s[j]
		if c < '0' || c > '9' {
			return 0, false
		}
		if j-i > 3 {
			if c != '0' {
				return 0, false
			}
			continue
		}
		ms += int64(c-'0') * scale
		scale /= 10
	}
	return ms, true
}

// openLogs reads a log body in logs mode. With resultType before result, a matrix streams as a
// range body does and a streams result is decoded as it is read; with result first, the value
// is captured and decoded once the document ended.
func (s *jsonSource) openLogs(mode logMode) (logOpen, error) {
	s.logs, s.mode = true, mode
	at, err := s.walk()
	if err != nil {
		return logOpen{}, err
	}
	if at {
		s.rangeMode = true
		return logOpen{matrix: true}, nil
	}
	if err := s.endCheck(); err != nil {
		return logOpen{}, err
	}
	if s.raw != nil {
		if err := s.decodeCaptured(); err != nil {
			return logOpen{}, err
		}
	}
	if s.seenType == ResultMatrix {
		return logOpen{matrix: true, ended: true}, nil
	}
	if s.logsRes == nil {
		return logOpen{}, protocolError()
	}
	return logOpen{logs: s.logsRes}, nil
}

// logsType records a resultType in logs mode: the first must be allowed by the mode; a later one
// must equal it.
func (s *jsonSource) logsType(t ResultType) error {
	switch {
	case s.seenType != "" && t != s.seenType:
		return protocolError()
	case s.seenType == "" && !s.mode.allows(t):
		return protocolError()
	}
	s.seenType = t
	return nil
}

// logsResult reads the result member in logs mode: with resultType matrix already read it stops
// at the array (true); with streams it decodes the entries; with no resultType yet it captures
// the value.
func (s *jsonSource) logsResult() (bool, error) {
	d := s.dec
	k, err := d.Next()
	if err != nil {
		return false, err
	}
	switch s.seenType {
	case ResultMatrix:
		if k != tokArrStart {
			return false, protocolError()
		}
		return true, nil
	case ResultStreams:
		if k != tokArrStart {
			return false, protocolError()
		}
		s.logsRes, err = streamsResult(d, s.lim)
		return false, err
	}
	s.raw, err = d.CaptureValue(s.lim.CaptureBytes)
	return false, err
}

// decodeCaptured decodes a result captured before its resultType with a second tokenizer, which
// redacts as the first: streams whole; for a matrix, nextRange then reads the capture.
func (s *jsonSource) decodeCaptured() error {
	bd := newUpstreamDecoder(bytes.NewReader(s.raw), s.dec.red)
	s.raw = nil
	if k, err := bd.Next(); err != nil || k != tokArrStart {
		return orProtocol(err)
	}
	if s.seenType == ResultMatrix {
		s.dec, s.buffered, s.rangeMode = bd, true, true
		return nil
	}
	var err error
	if s.logsRes, err = streamsResult(bd, s.lim); err != nil {
		return err
	}
	if k, err := bd.Next(); err != nil || k != tokEOF {
		return orProtocol(err)
	}
	return nil
}
