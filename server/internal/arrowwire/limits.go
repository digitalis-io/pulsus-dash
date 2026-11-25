package arrowwire

import (
	"errors"
	"io"

	"github.com/apache/arrow-go/v18/arrow"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// ErrLimit: a wire limit (wire/schemas/limits.json, plan #68 B3 §3.1) was reached. A Grid or
// Writer.Error refused by it writes the stream-level ERROR (outcome (a)); inside an open part
// the part auto-closes with truncated coverage (outcome (c)) and later calls on it return
// ErrLimit without writing.
var ErrLimit = errors.New("arrowwire: limit")

// Limits are the shared wire limits; DefaultLimits is wire/schemas/limits.json (unit:limits-json)
// and B2's reader enforces the same values. Sizes are bytes.
type Limits struct {
	MaxPayload         int `json:"max_payload"`
	MaxChunk           int `json:"max_chunk"`
	SourceBuffer       int `json:"source_buffer"`
	MaxGridLen         int `json:"max_grid_len"`
	OpenParts          int `json:"open_parts"`
	DistinctParts      int `json:"distinct_parts"`
	RowsPerBatchLabels int `json:"rows_per_batch_labels"`
	RowsPerBatchGrid   int `json:"rows_per_batch_grid"`
	SeriesPerPart      int `json:"series_per_part"`
	LabelRowsPerPart   int `json:"label_rows_per_part"`
	LabelBytesPerPart  int `json:"label_bytes_per_part"`
	MetaListElements   int `json:"meta_list_elements"`
	MetaStringBytes    int `json:"meta_string_bytes"`
	ReasonBytes        int `json:"reason_bytes"`
	BodyBudget         int `json:"body_budget"`
	ValueBudget        int `json:"value_budget"`
	PartReserve        int `json:"part_reserve"`
	StreamReserve      int `json:"stream_reserve"`
}

// DefaultLimits is wire/schemas/limits.json.
func DefaultLimits() Limits {
	return Limits{
		MaxPayload: MaxPayload, MaxChunk: 2 * MaxPayload, SourceBuffer: 1 << 20, MaxGridLen: MaxGridLen,
		OpenParts: 64, DistinctParts: 1024, RowsPerBatchLabels: 1 << 20, RowsPerBatchGrid: 1 << 16,
		SeriesPerPart: 1 << 20, LabelRowsPerPart: 1 << 22, LabelBytesPerPart: 16 << 20,
		MetaListElements: 4096, MetaStringBytes: 1 << 20, ReasonBytes: 64,
		BodyBudget: 64 << 20, ValueBudget: 1 << 30,
		PartReserve:   costCoverage + (1 << 20) + costListElement*4096 + costError + (1 << 20),
		StreamReserve: costError + (1 << 20),
	}
}

// NewWriterLimits returns a Writer on w that enforces l (NewWriter uses DefaultLimits).
func NewWriterLimits(w io.Writer, l Limits) *Writer {
	return &Writer{w: w, used: map[uint32]bool{}, lim: l}
}

// The accounting costs (§3.1; wire/schemas/limits.json "cost"): the bytes B2's reader creates,
// charged once and never refunded, identical on both sides.
const (
	costPart         = 256 // per part
	costSchema       = 256 // per accepted schema, plus field names and metadata keys and values
	costSeries       = 96  // per series label set (B2 keeps a 32-byte entry, its label Arc and the batch list)
	costLabel        = 48  // per label of a set, plus its key and value
	costBatch        = 64  // per data batch
	costBatchSeries  = 32  // per series of a data batch
	costCoverage     = 256 // per coverage/1 row, plus its strings
	costListElement  = 16  // per coverage list element
	costError        = 256 // per error/1 row, plus its strings
	costValue        = 8   // value_budget: per value of a data batch
	costValidityWord = 8   // value_budget: per 64 values (the chunk's validity words)
)

// The truncation reasons of the limits (B3 §3.2).
const (
	reasonWireLimit   = "wire_limit"
	reasonWireBudget  = "wire_budget"
	reasonCoverageCut = "coverage_cut"
)

func fieldNames(f arrow.Field) int {
	n := len(f.Name)
	if l, ok := f.Type.(arrow.ListLikeType); ok {
		n += fieldNames(l.ElemField())
	}
	return n
}

// schemaCost is the charge of an accepted SCHEMA: 256 + field names (children included) +
// metadata keys and values.
func schemaCost(s *arrow.Schema) int {
	n := costSchema
	for _, f := range s.Fields() {
		n += fieldNames(f)
	}
	md := s.Metadata()
	for i, k := range md.Keys() {
		n += len(k) + len(md.Values()[i])
	}
	return n
}

// labelSetCost is the charge of one series' labels: 96 + Σ(48 + key + value); a series
// without labels (one null row) is 96.
func labelSetCost(s *pulsusdb.Series) int {
	n := costSeries
	for _, l := range s.Labels {
		n += costLabel + len(l.Name) + len(l.Value)
	}
	return n
}

// labelRows is the labels/1 rows of s: one per label, one null row without labels.
func labelRows(s *pulsusdb.Series) int { return max(len(s.Labels), 1) }

func labelBytesOf(s *pulsusdb.Series) int {
	n := 0
	for _, l := range s.Labels {
		n += len(l.Name) + len(l.Value)
	}
	return n
}

// batchCost is the body-budget charge of a data batch of k series.
func batchCost(k int) int { return costBatch + costBatchSeries*k }

// valueCost is the value-budget charge of a data batch of k series of n points.
func valueCost(k, n int) int { return costValue*k*n + costValidityWord*((k*n+63)/64) }

func strBytes(xs []string) int {
	n := 0
	for _, x := range xs {
		n += len(x)
	}
	return n
}

// coverageStrings is the string bytes and list elements of c.
func coverageStrings(c Coverage) (bytes, elems int) {
	if c.TruncationReason != nil {
		bytes = len(*c.TruncationReason)
	}
	for _, xs := range [][]string{c.ExcludedDims, c.Warnings, c.Infos, c.UpstreamQueryIDs} {
		bytes, elems = bytes+strBytes(xs), elems+len(xs)
	}
	return bytes, elems
}

// coverageCost is the charge of a coverage/1 row: 256 + string bytes + 16 × list elements.
func coverageCost(c Coverage) int {
	b, e := coverageStrings(c)
	return costCoverage + b + costListElement*e
}

func errorStrings(e ErrorRow) int {
	n := len(e.Message)
	if e.Suggestion != nil {
		n += len(*e.Suggestion)
	}
	return n
}

// errorCost is the charge of an error/1 row: 256 + string bytes.
func errorCost(e ErrorRow) int { return costError + errorStrings(e) }

// cutPrefix is s cut to at most n bytes at a UTF-8 boundary, with cutMarker appended.
func cutPrefix(s string, n int) string {
	k := min(max(n, 0), len(s))
	for k > 0 && k < len(s) && !isRuneStart(s[k]) {
		k--
	}
	return s[:k] + cutMarker
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }

// cutCoverage applies the coverage cut policy (§3.1): truncation_reason is capped at
// ReasonBytes (50 B + the marker); if the strings or list elements would pass MetaStringBytes /
// MetaListElements, the coverage is truncated, its reason is its own (capped) or coverage_cut,
// the marker is reserved, and the lists are filled in column order from the remaining allowance:
// the string that crosses it is cut with the marker and later elements are dropped. It reports
// whether anything was cut.
func cutCoverage(c Coverage, l Limits) (Coverage, bool) {
	cut := false
	if r := c.TruncationReason; r != nil && len(*r) > l.ReasonBytes {
		s := cutUTF8(*r, l.ReasonBytes)
		c.TruncationReason, c.Truncated, cut = &s, true, true
	}
	if b, e := coverageStrings(c); b <= l.MetaStringBytes && e <= l.MetaListElements {
		return c, cut
	}
	c.Truncated = true
	if c.TruncationReason == nil {
		r := reasonCoverageCut
		c.TruncationReason = &r
	}
	allow := l.MetaStringBytes - len(*c.TruncationReason) - len(cutMarker)
	kept, stop := 0, false
	fill := func(xs []string) []string {
		out := []string{}
		for _, x := range xs {
			if stop || kept >= l.MetaListElements {
				stop = true
				break
			}
			kept++
			if len(x) > allow {
				out, stop = append(out, cutPrefix(x, allow)), true
				break
			}
			out, allow = append(out, x), allow-len(x)
		}
		return out
	}
	c.ExcludedDims, c.Warnings, c.Infos, c.UpstreamQueryIDs = fill(c.ExcludedDims), fill(c.Warnings), fill(c.Infos), fill(c.UpstreamQueryIDs)
	return c, true
}

// cutError cuts an ErrorRow whose message and suggestion pass MetaStringBytes: the suggestion
// to at most a quarter of it, then the message to the rest, each at a UTF-8 boundary ending
// with the marker, so an explicit error always goes out.
func cutError(e ErrorRow, l Limits) ErrorRow {
	if errorStrings(e) <= l.MetaStringBytes {
		return e
	}
	rest := l.MetaStringBytes
	if e.Suggestion != nil {
		s := cutUTF8(*e.Suggestion, l.MetaStringBytes/4)
		e.Suggestion, rest = &s, rest-len(s)
	}
	e.Message = cutUTF8(e.Message, rest)
	return e
}

// reserve is the body budget kept free: part_reserve per open data part, and stream_reserve
// until the stream-level ERROR was written.
func (w *Writer) reserve(openData int) int {
	r := openData * w.lim.PartReserve
	if !w.refused {
		r += w.lim.StreamReserve
	}
	return r
}

// fits reports whether charge (and the reserves of openData open data parts) fits body_budget.
func (w *Writer) fits(charge, openData int) bool {
	return w.noBudget || w.spent+charge+w.reserve(openData) <= w.lim.BodyBudget
}

// admit checks a Grid (parts = 2) or Writer.Error (parts = 1) against open_parts,
// distinct_parts and the body budget with all reserves.
func (w *Writer) admit(parts, charge, openData int) bool {
	return w.open+parts <= w.lim.OpenParts && len(w.used)+parts <= w.lim.DistinctParts && w.fits(charge, openData)
}

// cutCov is c after the part's sticky cut (once a coverage of the part was cut, every later one
// is truncated with its own reason or coverage_cut) and the cut policy.
func (p *GridPart) cutCov(c Coverage) Coverage {
	if p.cut {
		c.Truncated = true
		if c.TruncationReason == nil {
			r := reasonCoverageCut
			c.TruncationReason = &r
		}
	}
	c, cut := cutCoverage(c, p.w.lim)
	p.cut = p.cut || cut
	return c
}

// flushCost is the per-part and budget check of a flush of the pending series (§3.2
// "Auto-close"): the truncation reason when it would pass a limit ("" if it fits), and its
// body and value charges.
func (p *GridPart) flushCost() (reason string, body, values int) {
	l, k := p.w.lim, len(p.pending)
	rows, lbytes := 0, 0
	body = batchCost(k)
	for _, s := range p.pending {
		rows, lbytes, body = rows+labelRows(s), lbytes+labelBytesOf(s), body+labelSetCost(s)
	}
	values = valueCost(k, p.n)
	switch {
	case int(p.sent)+k > l.SeriesPerPart || p.lrows+rows > l.LabelRowsPerPart || p.lbytes+lbytes > l.LabelBytesPerPart:
		return reasonWireLimit, body, values
	case !p.w.noBudget && (!p.w.fits(body, p.w.openData) || p.w.values+values > l.ValueBudget):
		return reasonWireBudget, body, values
	}
	return "", body, values
}

// labelGroups splits the pending series into labels batches of at most RowsPerBatchLabels
// rows, only between series (a single series is never above it: Add refuses it).
func (p *GridPart) labelGroups() [][]*pulsusdb.Series {
	var out [][]*pulsusdb.Series
	start, rows := 0, 0
	for i, s := range p.pending {
		r := labelRows(s)
		if i > start && rows+r > p.w.lim.RowsPerBatchLabels {
			out, start, rows = append(out, p.pending[start:i]), i, 0
		}
		rows += r
	}
	return append(out, p.pending[start:])
}

// autoClose closes the part for a limit (outcome (c)): it drops the pending series and writes a
// 0-row BATCH(L)|LAST and a final META(D)|LAST from base with truncated and reason, charged
// from the part's reserve; the part is closed for good. It returns ErrLimit (or a write error).
func (p *GridPart) autoClose(base Coverage, reason string) error {
	p.pending, p.pendLab = nil, 0
	base.Phase, base.SeriesReturned, base.Truncated = PhaseFinal, p.sent, true
	base.TruncationReason = &reason
	c := p.cutCov(base)
	f := p.w.frames()
	err := p.addEmptyLabels(f)
	if err == nil {
		err = f.add(p.header(FrameMeta, p.spec.DataPart, FlagLast), coveragePayload(c))
	}
	if err == nil {
		err = f.commit()
	}
	if err != nil {
		return err
	}
	p.w.spent += coverageCost(c)
	p.limited = true
	p.markClosed()
	return ErrLimit
}

// markClosed releases the part's open-part count and reserve.
func (p *GridPart) markClosed() {
	p.closed = true
	p.w.open -= 2
	p.w.openData--
}
