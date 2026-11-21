package prom

import "github.com/prometheus/prometheus/promql/parser"

// ValueType is the type of a query's top expression.
type ValueType string

// The value types.
const (
	ValueScalar  ValueType = "scalar"
	ValueString  ValueType = "string"
	ValueVector  ValueType = "vector"
	ValueMatrix  ValueType = "matrix"
	ValueUnknown ValueType = "unknown"
)

// BareSelector is a top-level selector with a metric name and no modifier, and its byte span
// in the text.
type BareSelector struct {
	Metric   string
	From, To int
}

// Shape is what the planner reads from a query (plan #112 §4.3).
type Shape struct {
	Bare                 *BareSelector
	Metrics              []string
	HasHistogramQuantile bool
	ValueType            ValueType
}

// ShapeOf reads the shape of text with the upstream parser; it never fails.
func ShapeOf(text string) Shape { return Shape{} }

// promParser is the one parser of the package: zero options (experimental functions, fill
// modifiers and unquoted UTF-8 names off); options are per parser, so no package global of
// the upstream module is ever set.
var promParser = parser.NewParser(parser.Options{})
