package pulsusdb

import (
	"io"

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

// Series is one series placed on the grid.
type Series struct {
	Key        uint64
	Labels     []Label
	Timestamps []int64
	Values     []float64
	Present    []bool
}

// Completeness is the completeness block of a response.
type Completeness struct {
	Truncated          bool
	Warnings, Infos    []string
	QueryID            string
	ReadCache          string
	ReadCacheThroughMs int64
	NewestSampleMs     int64
}

// ResultStream yields the series of one response.
type ResultStream struct{}

// Type is the result type.
func (s *ResultStream) Type() ResultType { return "" }

// Next returns the next series, or io.EOF.
func (s *ResultStream) Next() (*Series, error) { return nil, io.EOF }

// Scalar is the scalar result.
func (s *ResultStream) Scalar() (int64, float64, bool) { return 0, 0, false }

// StringValue is the string result.
func (s *ResultStream) StringValue() (int64, string, bool) { return 0, "", false }

// Completeness is final once Next returned io.EOF.
func (s *ResultStream) Completeness() Completeness { return Completeness{} }

// Close releases the stream.
func (s *ResultStream) Close() error { return nil }
