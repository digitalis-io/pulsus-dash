package pulsusdb

import (
	"context"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// RangeQuery is a range query.
type RangeQuery struct {
	Query      string
	Start, End time.Time
	Step       time.Duration
	Timeout    time.Duration
}

// InstantQuery is an instant query.
type InstantQuery struct {
	Query   string
	At      time.Time
	Timeout time.Duration
}

// MatchQuery is a completion query.
type MatchQuery struct {
	Match      []string
	Start, End time.Time
	Limit      int
}

// MetadataQuery is a metadata query.
type MetadataQuery struct {
	Metric string
	Limit  int
}

// ValuesResult is a list of label names or values.
type ValuesResult struct {
	Values       []string
	Completeness Completeness
}

// SeriesResult is a list of label sets.
type SeriesResult struct {
	Series       [][]Label
	Completeness Completeness
}

// MetricMetadata is one metadata entry.
type MetricMetadata struct{ Type, Help, Unit string }

// MetadataResult maps metric names to their metadata.
type MetadataResult struct {
	Metrics      map[string][]MetricMetadata
	Completeness Completeness
}

// RuntimeInfo is the answer of the data-source check.
type RuntimeInfo struct {
	RollupLevels []string
	QueryID      string
}

// QueryRange runs a range query and streams its series.
func (c *Client) QueryRange(ctx context.Context, rc *core.RequestCtx, q RangeQuery) (*ResultStream, error) {
	return nil, errStub
}

// Query runs an instant query.
func (c *Client) Query(ctx context.Context, rc *core.RequestCtx, q InstantQuery) (*ResultStream, error) {
	return nil, errStub
}

// Series lists the label sets matching q.
func (c *Client) Series(ctx context.Context, rc *core.RequestCtx, q MatchQuery) (*SeriesResult, error) {
	return nil, errStub
}

// Labels lists label names.
func (c *Client) Labels(ctx context.Context, rc *core.RequestCtx, q MatchQuery) (*ValuesResult, error) {
	return nil, errStub
}

// LabelValues lists the values of label name.
func (c *Client) LabelValues(ctx context.Context, rc *core.RequestCtx, name string, q MatchQuery) (*ValuesResult, error) {
	return nil, errStub
}

// Metadata lists metric metadata.
func (c *Client) Metadata(ctx context.Context, rc *core.RequestCtx, q MetadataQuery) (*MetadataResult, error) {
	return nil, errStub
}

// RuntimeInfo checks the binding.
func (c *Client) RuntimeInfo(ctx context.Context, rc *core.RequestCtx) (*RuntimeInfo, error) {
	return nil, errStub
}
