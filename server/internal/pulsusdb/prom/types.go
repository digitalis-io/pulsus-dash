package prom

import (
	"context"
	"errors"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// MetricKind is a metric's type as metadata reports it.
type MetricKind string

// The metric kinds.
const (
	MetricCounter   MetricKind = "counter"
	MetricGauge     MetricKind = "gauge"
	MetricHistogram MetricKind = "histogram"
	MetricSummary   MetricKind = "summary"
	MetricUnknown   MetricKind = "unknown"
)

// MetricTypes maps metric names to their kinds.
type MetricTypes map[string]MetricKind

// KindOf is the kind of name: its own entry, else that of its base name without one of
// _bucket, _count, _sum, _total (a _count or _sum of a histogram or summary is a counter).
func KindOf(name string, t MetricTypes) MetricKind { return "" }

// TypesFromMetadata is the kinds of a metadata answer: each name's first entry.
func TypesFromMetadata(m map[string][]pulsusdb.MetricMetadata) MetricTypes { return nil }

// WarnTypesUnavailable is the completeness warning of a plan made without metric types.
const WarnTypesUnavailable = "pulsus-dash: metric types unavailable, so only names ending in _total are rated (metric_types_unavailable)"

// ErrTypesWait is the answer of a plan that waited its limit for metric types.
var ErrTypesWait = errors.New("prom: metric types not ready")

// TypesSource gives the metric types of the request's tenant binding.
type TypesSource interface {
	Types(ctx context.Context, rc *core.RequestCtx) (MetricTypes, error)
}

// StaticTypes is a TypesSource without I/O (tests and workloads).
type StaticTypes MetricTypes

// Types returns the map.
func (s StaticTypes) Types(context.Context, *core.RequestCtx) (MetricTypes, error) {
	return MetricTypes(s), nil
}

// Fetch reads the metric types of the request's binding.
type Fetch func(ctx context.Context, rc *core.RequestCtx) (MetricTypes, error)

// MetadataFetch reads the types through the PulsusDB metadata route.
func MetadataFetch(c *pulsusdb.Client) Fetch {
	return func(context.Context, *core.RequestCtx) (MetricTypes, error) { return nil, nil }
}

// CacheOptions are the TypesCache settings; zero values take the defaults.
type CacheOptions struct {
	TTL, ErrorTTL, Wait, FetchTimeout time.Duration // 0 → 60 s, 5 s, 2 s, 10 s
	Now                               func() time.Time
}

// TypesCache is the per-binding metric-types cache (plan #112 §4.5).
type TypesCache struct{}

// NewTypesCache returns a cache over fetch.
func NewTypesCache(fetch Fetch, o CacheOptions) *TypesCache { return &TypesCache{} }

// Types returns the binding's types.
func (c *TypesCache) Types(ctx context.Context, rc *core.RequestCtx) (MetricTypes, error) {
	return nil, nil
}
