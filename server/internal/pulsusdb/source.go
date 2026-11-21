package pulsusdb

import "context"

// bodyFormat is a success-body encoding the client can decode.
type bodyFormat uint8

// The body formats.
const (
	formatJSON bodyFormat = iota + 1
)

// acceptHeader is the Accept header of every request.
const acceptHeader = "application/json"

// formatOf maps a success response's Content-Type to its decoder.
func formatOf(string) (bodyFormat, bool) { return 0, false }

// rawSeries is one decoded series before grid placement.
type rawSeries struct {
	Labels []Label
	T      []int64 // ms
	V      []float64
}

// instantResult is a decoded instant body.
type instantResult struct {
	typ      ResultType
	series   []*Series
	t        int64
	scalar   float64
	scalarOK bool
	str      string
	cut      bool
}

// seriesSource is one success-body decoder.
type seriesSource interface {
	openRange() error
	nextRange(r *rawSeries) error
	readInstant() (instantResult, error)
}

// newRangeStream returns the range stream of src on grid g.
func newRangeStream(_ context.Context, _ seriesSource, resp *response, _ Limits, comp *compBuilder, _ Grid) *ResultStream {
	return &ResultStream{resp: resp, comp: comp, stream: true, done: true, final: comp.finish()}
}
