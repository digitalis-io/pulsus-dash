package prom

import (
	"sort"

	"github.com/prometheus/prometheus/promql/parser"
)

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

// promParser is the one parser of the package: zero options (experimental functions, fill
// modifiers and unquoted UTF-8 names off). Options are per parser, so no package global of the
// upstream module is ever set; it is safe for concurrent use.
var promParser = parser.NewParser(parser.Options{})

func unknownShape() Shape { return Shape{Metrics: []string{}, ValueType: ValueUnknown} }

// ShapeOf reads the shape of text with the upstream parser (plan #112 §4.3). It never fails: a
// parse or type error, or a panic of the parser, gives the unknown shape.
func ShapeOf(text string) (s Shape) {
	defer func() {
		if recover() != nil {
			s = unknownShape()
		}
	}()
	expr, err := promParser.ParseExpr(text)
	if err != nil || expr == nil {
		return unknownShape()
	}
	s = Shape{Metrics: []string{}, ValueType: valueTypeOf(expr.Type())}
	if vs, ok := expr.(*parser.VectorSelector); ok && vs.Name != "" && vs.OriginalOffset == 0 && vs.OriginalOffsetExpr == nil &&
		vs.Timestamp == nil && vs.StartOrEnd == 0 && !vs.Anchored && !vs.Smoothed {
		s.Bare = &BareSelector{Metric: vs.Name, From: int(vs.PosRange.Start), To: int(vs.PosRange.End)}
	}
	first := map[string]int{}
	parser.Inspect(expr, func(n parser.Node, _ []parser.Node) error {
		switch v := n.(type) {
		case *parser.VectorSelector:
			if v.Name == "" {
				break
			}
			if at, seen := first[v.Name]; !seen || int(v.PosRange.Start) < at {
				first[v.Name] = int(v.PosRange.Start)
			}
		case *parser.Call:
			if v.Func != nil && (v.Func.Name == "histogram_quantile" || v.Func.Name == "histogram_quantiles") {
				s.HasHistogramQuantile = true
			}
		}
		return nil
	})
	for name := range first {
		s.Metrics = append(s.Metrics, name)
	}
	sort.Slice(s.Metrics, func(i, j int) bool {
		a, b := s.Metrics[i], s.Metrics[j]
		if first[a] != first[b] {
			return first[a] < first[b]
		}
		return a < b
	})
	return s
}

func valueTypeOf(t parser.ValueType) ValueType {
	switch t {
	case parser.ValueTypeScalar:
		return ValueScalar
	case parser.ValueTypeString:
		return ValueString
	case parser.ValueTypeVector:
		return ValueVector
	case parser.ValueTypeMatrix:
		return ValueMatrix
	}
	return ValueUnknown
}
