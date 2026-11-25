package arrowwire

import "github.com/apache/arrow-go/v18/arrow"

func labelsSchema() *arrow.Schema                { return arrow.NewSchema(nil, nil) }
func gridSchema(s GridSpec, n int) *arrow.Schema { return arrow.NewSchema(nil, nil) }
func coverageSchema() *arrow.Schema              { return arrow.NewSchema(nil, nil) }
func errorSchema() *arrow.Schema                 { return arrow.NewSchema(nil, nil) }
