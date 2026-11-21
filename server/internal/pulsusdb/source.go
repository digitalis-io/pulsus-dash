package pulsusdb

import "mime"

// The decoder seam. A success body is decoded by the seriesSource its Content-Type selects; the
// sources share the grid placement, the points limit and the completeness block (ResultStream).
// Every source yields strings only through the request's redactor (T06-024): today the one
// source is the JSON tokenizer (updec.go, source_json.go); a later Arrow source joins it here.

// bodyFormat is a success-body encoding the client can decode.
type bodyFormat uint8

// The body formats.
const (
	formatJSON bodyFormat = iota + 1
)

// acceptHeader is the Accept header of every request: the formats newSource decodes.
const acceptHeader = "application/json"

// formatOf maps a success response's Content-Type to its decoder; false for any other type.
func formatOf(contentType string) (bodyFormat, bool) {
	mt, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return 0, false
	}
	switch mt {
	case "application/json":
		return formatJSON, true
	}
	return 0, false
}

// rawSeries is one decoded series before grid placement: labels (redacted, sorted) and the
// points as the body gave them.
type rawSeries struct {
	Labels []Label
	T      []int64 // ms
	V      []float64
}

// instantResult is a decoded instant body.
type instantResult struct {
	typ      ResultType
	series   []*Series // points as given
	t        int64     // scalar or string: its timestamp (ms)
	scalar   float64
	scalarOK bool
	str      string // redacted and cut
	cut      bool   // the points limit stopped decoding
}

// seriesSource is one success-body decoder. It fills the completeness builder it was made with
// (warnings, infos, truncated, skipped native histograms).
type seriesSource interface {
	// openRange reads a range (matrix) body up to its first series.
	openRange() error
	// nextRange decodes the next series into r, reusing r's slices; io.EOF once the body ended
	// and was validated.
	nextRange(r *rawSeries) error
	// readInstant decodes a whole instant body.
	readInstant() (instantResult, error)
}

// logSource is a seriesSource that also decodes LogQL log bodies (#65 §4.1). The pager reads
// only the logResponse it yields, so a second body format implements this and nothing else.
type logSource interface {
	seriesSource
	// openLogs reads a log query_range body whose result type mode allows: either a decoded
	// streams result, or a matrix whose series nextRange then yields.
	openLogs(mode logMode) (logOpen, error)
}

// logMode says which result types a log body may have.
type logMode struct{ streams, matrix bool }

func (m logMode) allows(t ResultType) bool {
	return (t == ResultStreams && m.streams) || (t == ResultMatrix && m.matrix)
}

// logOpen is how a log body opened: a decoded streams result (logs), or a matrix (matrix) whose
// body has already ended when ended is set (it was captured before its resultType).
type logOpen struct {
	logs   *logResponse
	matrix bool
	ended  bool
}

// newSource returns the decoder of resp's body.
func newSource(resp *response, comp *compBuilder, lim Limits) (seriesSource, error) {
	switch resp.format {
	case formatJSON:
		return &jsonSource{dec: newUpstreamDecoder(resp.body, resp.red), comp: comp, lim: lim}, nil
	}
	return nil, protocolError()
}
