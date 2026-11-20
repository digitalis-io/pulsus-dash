package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// Bounds of the completion routes (plan #62 §3.4).
const (
	completionDeadline = 10 * time.Second
	defaultLimit       = 1000
	maxLimit           = 10_000
	maxNameBytes       = 256
)

// The completion routes GET /api/dash/v1/prom/{labels,label/{name}/values,series,metadata}
// (M-UI1 metadata for the editor). They are declared in api/openapi.yaml and hand-written here:
// the generated binding of query parameters would need a parameter runtime module that is not
// a dependency. Their answers are those the spec declares (200, 429 with Retry-After, and the
// error envelope otherwise), the same as the POST routes'.

// params reads query parameters with the validation rows of §3.4; the first problem sticks.
type params struct {
	v   url.Values
	err *reqError
}

func (p *params) int64(name string) int64 {
	if p.err != nil {
		return 0
	}
	s, ok := p.v[name]
	if !ok || len(s) == 0 {
		p.err = fieldError("/"+name, "field.required", name+" is required")
		return 0
	}
	n, err := strconv.ParseInt(s[0], 10, 64)
	if err != nil {
		p.err = fieldError("/"+name, "field.type", name+" must be an integer")
	}
	return n
}

func (p *params) limit() int {
	if p.err != nil {
		return 0
	}
	s := p.v.Get("limit")
	if s == "" {
		return defaultLimit
	}
	n, err := strconv.Atoi(s)
	switch {
	case err != nil:
		p.err = fieldError("/limit", "field.type", "limit must be an integer")
	case n < 1 || n > maxLimit:
		p.err = fieldError("/limit", "field.range", "limit must be between 1 and 10000")
	}
	return n
}

func (p *params) matches(required bool) []string {
	if p.err != nil {
		return nil
	}
	ms := p.v["match"]
	if required && len(ms) == 0 {
		p.err = fieldError("/match", "field.required", "match is required")
		return nil
	}
	for i, m := range ms {
		if len(m) > maxQueryBytes {
			p.err = fieldError("/match/"+strconv.Itoa(i), "field.range", "match must be at most 65536 bytes")
			return nil
		}
	}
	return ms
}

// window is from and to, from < to.
func (p *params) window() (time.Time, time.Time) {
	from, to := p.int64("from"), p.int64("to")
	if p.err == nil && from >= to {
		p.err = fieldError("/to", "field.range", "to must be after from")
	}
	return time.UnixMilli(from), time.UnixMilli(to)
}

// completion runs the shared steps of a completion route: tenant, parameters, deadline and
// resolution; call does the PulsusDB call and returns the 200 body.
func (q *dataRoutes) completion(w http.ResponseWriter, r *http.Request, parse func(*params) error,
	call func(ctx context.Context, rcx *requestScope) (any, error)) {
	tenant, e := tenantParam(r)
	if e != nil {
		writeReqError(w, e)
		return
	}
	p := &params{v: r.URL.Query()}
	_ = parse(p)
	if p.err != nil {
		writeReqError(w, p.err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), completionDeadline)
	defer cancel()
	tc, e := resolveTenant(ctx, q.d, tenant)
	if e != nil {
		writeReqError(w, e)
		return
	}
	if q.d.PulsusDB == nil {
		q.fail(w, r, &pulsusdb.Error{Kind: pulsusdb.KindConfig})
		return
	}
	body, err := call(ctx, &requestScope{rc: requestCtx(r, tc), c: q.d.PulsusDB})
	if err != nil {
		q.fail(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(body)
}

// toAPI is the completeness of a completion route (no data age).
func toAPI(c pulsusdb.Completeness) api.Completeness {
	out := api.Completeness{Truncated: c.Truncated, Warnings: c.Warnings, Infos: c.Infos}
	if c.QueryID != "" {
		id := c.QueryID
		out.QueryId = &id
	}
	if c.ReadCache != "" {
		rc := api.CompletenessReadCache(c.ReadCache)
		out.ReadCache = &rc
	}
	if c.ReadCacheThroughMs >= 0 {
		v := c.ReadCacheThroughMs
		out.ReadCacheThroughMs = &v
	}
	return out
}

func (q *dataRoutes) labels(w http.ResponseWriter, r *http.Request) {
	var mq pulsusdb.MatchQuery
	q.completion(w, r, func(p *params) error {
		mq.Start, mq.End = p.window()
		mq.Match, mq.Limit = p.matches(false), p.limit()
		return nil
	}, func(ctx context.Context, s *requestScope) (any, error) {
		v, err := s.c.Labels(ctx, s.rc, mq)
		if err != nil {
			return nil, err
		}
		return api.PromValuesResponse{Values: v.Values, Completeness: toAPI(v.Completeness)}, nil
	})
}

func (q *dataRoutes) labelValues(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if u, err := url.PathUnescape(name); err == nil {
		name = u
	}
	var mq pulsusdb.MatchQuery
	q.completion(w, r, func(p *params) error {
		if len(name) < 1 || len(name) > maxNameBytes {
			p.err = fieldError("/name", "field.range", "name must be 1 to 256 bytes")
			return nil
		}
		mq.Start, mq.End = p.window()
		mq.Match, mq.Limit = p.matches(false), p.limit()
		return nil
	}, func(ctx context.Context, s *requestScope) (any, error) {
		v, err := s.c.LabelValues(ctx, s.rc, name, mq)
		if err != nil {
			return nil, err
		}
		return api.PromValuesResponse{Values: v.Values, Completeness: toAPI(v.Completeness)}, nil
	})
}

func (q *dataRoutes) series(w http.ResponseWriter, r *http.Request) {
	var mq pulsusdb.MatchQuery
	q.completion(w, r, func(p *params) error {
		mq.Start, mq.End = p.window()
		mq.Match, mq.Limit = p.matches(true), p.limit()
		return nil
	}, func(ctx context.Context, s *requestScope) (any, error) {
		v, err := s.c.Series(ctx, s.rc, mq)
		if err != nil {
			return nil, err
		}
		out := api.PromSeriesResponse{Series: make([]api.SeriesLabels, 0, len(v.Series)), Completeness: toAPI(v.Completeness)}
		for _, ls := range v.Series {
			m := make(map[string]string, len(ls))
			for _, l := range ls {
				m[l.Name] = l.Value
			}
			out.Series = append(out.Series, api.SeriesLabels{Key: keyhash.Hex(keyhash.Labels(ls)), Labels: m})
		}
		return out, nil
	})
}

func (q *dataRoutes) metadata(w http.ResponseWriter, r *http.Request) {
	var mq pulsusdb.MetadataQuery
	q.completion(w, r, func(p *params) error {
		mq.Metric = p.v.Get("metric")
		if len(mq.Metric) > maxQueryBytes {
			p.err = fieldError("/metric", "field.range", "metric must be at most 65536 bytes")
			return nil
		}
		mq.Limit = p.limit()
		return nil
	}, func(ctx context.Context, s *requestScope) (any, error) {
		v, err := s.c.Metadata(ctx, s.rc, mq)
		if err != nil {
			return nil, err
		}
		out := api.PromMetadataResponse{Metrics: make(map[string][]api.MetricMetadata, len(v.Metrics)), Completeness: toAPI(v.Completeness)}
		for name, ms := range v.Metrics {
			list := make([]api.MetricMetadata, 0, len(ms))
			for _, m := range ms {
				list = append(list, api.MetricMetadata{Type: m.Type, Help: m.Help, Unit: m.Unit})
			}
			out.Metrics[name] = list
		}
		return out, nil
	})
}
