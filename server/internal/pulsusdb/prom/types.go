package prom

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"

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

// kindOfType is a metadata type as a kind: one of the four, else unknown.
func kindOfType(t string) MetricKind {
	switch k := MetricKind(t); k {
	case MetricCounter, MetricGauge, MetricHistogram, MetricSummary:
		return k
	}
	return MetricUnknown
}

var typeSuffixes = []string{"_bucket", "_count", "_sum", "_total"}

// KindOf is the kind of name: its own entry, else that of its base name without one of
// _bucket, _count, _sum, _total (a _count or _sum of a histogram or summary is a counter); a
// name with neither is unknown.
func KindOf(name string, t MetricTypes) MetricKind {
	if k, ok := t[name]; ok {
		return kindOfType(string(k))
	}
	for _, suffix := range typeSuffixes {
		base, ok := strings.CutSuffix(name, suffix)
		if !ok {
			continue
		}
		k, ok := t[base]
		if !ok {
			return MetricUnknown
		}
		k = kindOfType(string(k))
		if (suffix == "_count" || suffix == "_sum") && (k == MetricHistogram || k == MetricSummary) {
			return MetricCounter
		}
		return k
	}
	return MetricUnknown
}

// TypesFromMetadata is the kinds of a metadata answer: each name's first entry; a type that is
// not one of the four is unknown, and a name with no entry is absent.
func TypesFromMetadata(m map[string][]pulsusdb.MetricMetadata) MetricTypes {
	out := make(MetricTypes, len(m))
	for name, list := range m {
		if len(list) > 0 {
			out[name] = kindOfType(list[0].Type)
		}
	}
	return out
}

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

// metadataLimit is the most metrics one metadata read returns (the route's maximum): names past
// it have no type, so only the _total rule rates them.
const metadataLimit = 10_000

// MetadataFetch reads the types through the PulsusDB metadata route.
func MetadataFetch(c *pulsusdb.Client) Fetch {
	return func(ctx context.Context, rc *core.RequestCtx) (MetricTypes, error) {
		if c == nil {
			return nil, &pulsusdb.Error{Kind: pulsusdb.KindConfig}
		}
		r, err := c.Metadata(ctx, rc, pulsusdb.MetadataQuery{Limit: metadataLimit})
		if err != nil {
			return nil, err
		}
		return TypesFromMetadata(r.Metrics), nil
	}
}

// CacheOptions are the TypesCache settings; zero values take the defaults.
type CacheOptions struct {
	TTL, ErrorTTL, Wait, FetchTimeout time.Duration // 0 → 60 s, 5 s, 2 s, 10 s
	Now                               func() time.Time
	// Logger receives metric_types_unavailable; nil discards it.
	Logger *slog.Logger
}

type entry struct {
	types   MetricTypes
	err     error
	expires time.Time
}

// TypesCache is the per-binding metric-types cache (plan #112 §4.5, T06 §4.4): one entry and
// one singleflight key per tenant binding. A hit returns the stored pair; a miss starts (or
// joins) one fetch, which runs on without the caller's cancellation and fills the entry. A
// caller waits at most Wait. Safe for concurrent use; no lock is held while waiting.
type TypesCache struct {
	fetch   Fetch
	o       CacheOptions
	mu      sync.Mutex
	entries map[string]entry
	sf      singleflight.Group
	// afterMiss runs after a caller found no fresh entry and before it joins the singleflight;
	// tests only (nil otherwise).
	afterMiss func()
}

// NewTypesCache returns a cache over fetch.
func NewTypesCache(fetch Fetch, o CacheOptions) *TypesCache {
	if o.TTL == 0 {
		o.TTL = 60 * time.Second
	}
	if o.ErrorTTL == 0 {
		o.ErrorTTL = 5 * time.Second
	}
	if o.Wait == 0 {
		o.Wait = 2 * time.Second
	}
	if o.FetchTimeout == 0 {
		o.FetchTimeout = 10 * time.Second
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Logger == nil {
		o.Logger = slog.New(slog.DiscardHandler)
	}
	return &TypesCache{fetch: fetch, o: o, entries: map[string]entry{}}
}

func cacheKey(rc *core.RequestCtx) string {
	return rc.Tenant.Org.String() + "/" + rc.Tenant.Binding.ID.String()
}

// Types returns the binding's types: the cached pair, or the fetch's answer within Wait
// (ErrTypesWait after it), or ctx.Err() when the caller goes away first.
func (c *TypesCache) Types(ctx context.Context, rc *core.RequestCtx) (MetricTypes, error) {
	key := cacheKey(rc)
	c.mu.Lock()
	e, ok := c.entries[key]
	c.mu.Unlock()
	if ok && c.o.Now().Before(e.expires) {
		return e.types, e.err
	}
	if c.afterMiss != nil {
		c.afterMiss()
	}
	ch := c.sf.DoChan(key, func() (any, error) {
		// Another fetch may have filled the entry, and left the singleflight, after this caller's
		// miss: take that entry rather than fetch again.
		c.mu.Lock()
		held, ok := c.entries[key]
		c.mu.Unlock()
		if ok && c.o.Now().Before(held.expires) {
			return held.types, held.err
		}
		fctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), c.o.FetchTimeout)
		defer cancel()
		t, err := c.fetch(fctx, rc)
		e := entry{types: t, expires: c.o.Now().Add(c.o.TTL)}
		if err != nil {
			e = entry{err: err, expires: c.o.Now().Add(c.o.ErrorTTL)}
			c.o.Logger.WarnContext(fctx, "metric_types_unavailable", "tenant", rc.Tenant.Binding.Slug, "kind", errorKind(err))
		}
		c.mu.Lock()
		c.entries[key] = e
		c.mu.Unlock()
		return t, err
	})
	timer := time.NewTimer(c.o.Wait)
	defer timer.Stop()
	select {
	case r := <-ch:
		if r.Err != nil {
			return nil, r.Err
		}
		t, _ := r.Val.(MetricTypes)
		return t, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, ErrTypesWait
	}
}

// errorKind is the log's kind of a fetch error: the PulsusDB kind, never its text.
func errorKind(err error) string {
	var pe *pulsusdb.Error
	switch {
	case errors.As(err, &pe):
		return pe.Kind.String()
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	}
	return "internal"
}
