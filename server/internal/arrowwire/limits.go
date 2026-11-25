package arrowwire

import (
	"errors"
	"io"

	"github.com/apache/arrow-go/v18/arrow"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// ErrLimit: a wire limit (wire/schemas/limits.json) was reached.
var ErrLimit = errors.New("arrowwire: limit")

// Limits are the shared wire limits (wire/schemas/limits.json).
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

// DefaultLimits (stub).
func DefaultLimits() Limits { return Limits{} }

// NewWriterLimits (stub).
func NewWriterLimits(w io.Writer, _ Limits) *Writer { return NewWriter(w) }

// The accounting costs (stub).
const (
	costPart, costSchema, costSeries, costLabel, costBatch, costBatchSeries = 0, 0, 0, 0, 0, 0
	costCoverage, costListElement, costError, costValue, costValidityWord   = 0, 0, 0, 0, 0
)

// The truncation reasons.
const (
	reasonWireLimit   = "wire_limit"
	reasonWireBudget  = "wire_budget"
	reasonCoverageCut = "coverage_cut"
)

func schemaCost(*arrow.Schema) int                      { return 0 }
func labelSetCost(*pulsusdb.Series) int                 { return 0 }
func batchCost(int) int                                 { return 0 }
func valueCost(int, int) int                            { return 0 }
func coverageCost(Coverage) int                         { return 0 }
func errorCost(ErrorRow) int                            { return 0 }
func cutCoverage(c Coverage, _ Limits) (Coverage, bool) { return c, false }
func cutError(e ErrorRow, _ Limits) ErrorRow            { return e }
