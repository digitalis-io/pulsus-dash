package gateway

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

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

// prom implements the completion routes GET /api/dash/v1/prom/{labels,label/{name}/values,
// series,metadata} (M-UI1 metadata for the editor) as strict handlers. The generated wrapper
// binds the parameters; a missing or malformed one is answered by the gateway's request error
// handler with its §3.4 field error. Errors are the 429 response (with Retry-After) or the
// default response, so these routes answer as the POST routes do.
type prom struct{ deps Deps }

func (e *reqError) envelope() api.ErrorEnvelope { return api.ErrorEnvelope{Error: e.body} }

// rateLimited is the 429 response of e, with its Retry-After when it has one.
func (e *reqError) rateLimited() api.RateLimitedJSONResponse {
	r := api.RateLimitedJSONResponse{Body: e.envelope()}
	if e.retryAfter != "" {
		v := e.retryAfter
		r.Headers.RetryAfter = &v
	}
	return r
}

func tenantOf(t string) *reqError {
	if !tenantPattern.MatchString(t) {
		return fieldError("", "tenant.invalid", "tenant is required")
	}
	return nil
}

// matchParams checks the match values: present when required, each at most 65 536 bytes.
func matchParams(ms []string, required bool) *reqError {
	if required && len(ms) == 0 {
		return fieldError("/match", "field.required", "match is required")
	}
	for i, m := range ms {
		if len(m) > maxQueryBytes {
			return fieldError("/match/"+strconv.Itoa(i), "field.range", "match must be at most 65536 bytes")
		}
	}
	return nil
}

// limitParam is limit (default 1 000) checked against 1..10 000.
func limitParam(l *int) (int, *reqError) {
	if l == nil {
		return defaultLimit, nil
	}
	if *l < 1 || *l > maxLimit {
		return 0, fieldError("/limit", "field.range", "limit must be between 1 and 10000")
	}
	return *l, nil
}

func windowParams(from, to int64) *reqError {
	if from >= to {
		return fieldError("/to", "field.range", "to must be after from")
	}
	return nil
}

func optional(ms *[]string) []string {
	if ms == nil {
		return nil
	}
	return *ms
}

// completion runs the shared steps of a completion route after its parameter check: the
// deadline, tenant resolution and the call. It returns the 200 body or the error to answer; both
// are nil when the browser went away (nothing is written; the access log records 499).
func (p *prom) completion(ctx context.Context, tenant string, check *reqError, reserved *pulsusdb.Error,
	call func(context.Context, *requestScope) (any, error)) (any, *reqError) {
	if check != nil {
		return nil, check
	}
	q := &dataRoutes{d: p.deps}
	// Reserved selectors are refused before any I/O, tenant resolution included (T07-020 v1).
	if reserved != nil {
		return nil, q.failure(ctx, reserved)
	}
	ctx, cancel := context.WithTimeout(ctx, completionDeadline)
	defer cancel()
	tc, e := resolveTenant(ctx, p.deps, tenant)
	if e == errCancelled {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	if p.deps.PulsusDB == nil {
		return nil, q.failure(ctx, &pulsusdb.Error{Kind: pulsusdb.KindConfig})
	}
	body, err := call(ctx, &requestScope{rc: dataRequestCtxFrom(ctx, tc), c: p.deps.PulsusDB})
	if err != nil {
		if f := q.failure(ctx, err); f != errCancelled {
			return nil, f
		}
		return nil, nil
	}
	return body, nil
}

// reservedMatch is the guard over every match value (pointer /match/<i>).
func reservedMatch(ms []string) *pulsusdb.Error {
	for i, m := range ms {
		if v := pulsusdb.CheckReserved("match/"+strconv.Itoa(i), m); v != nil {
			return v
		}
	}
	return nil
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

func valuesCall(f func() (*pulsusdb.ValuesResult, error)) (any, error) {
	v, err := f()
	if err != nil {
		return nil, err
	}
	return api.PromValuesResponse{Values: v.Values, Completeness: toAPI(v.Completeness)}, nil
}

// GetPromLabels is GET /api/dash/v1/prom/labels.
func (p *prom) GetPromLabels(ctx context.Context, req api.GetPromLabelsRequestObject) (api.GetPromLabelsResponseObject, error) {
	pr := req.Params
	limit, le := limitParam(pr.Limit)
	mq := pulsusdb.MatchQuery{Match: optional(pr.Match), Start: time.UnixMilli(pr.From), End: time.UnixMilli(pr.To), Limit: limit}
	body, e := p.completion(ctx, pr.Tenant, firstError(tenantOf(pr.Tenant), windowParams(pr.From, pr.To), matchParams(mq.Match, false), le), reservedMatch(mq.Match),
		func(ctx context.Context, s *requestScope) (any, error) {
			return valuesCall(func() (*pulsusdb.ValuesResult, error) { return s.c.Labels(ctx, s.rc, mq) })
		})
	switch {
	case e == nil && body == nil:
		return nil, nil
	case e == nil:
		return api.GetPromLabels200JSONResponse(body.(api.PromValuesResponse)), nil
	case e.status == http.StatusTooManyRequests:
		return api.GetPromLabels429JSONResponse{RateLimitedJSONResponse: e.rateLimited()}, nil
	}
	return api.GetPromLabelsdefaultJSONResponse{Body: e.envelope(), StatusCode: e.status}, nil
}

// GetPromLabelValues is GET /api/dash/v1/prom/label/{name}/values.
func (p *prom) GetPromLabelValues(ctx context.Context, req api.GetPromLabelValuesRequestObject) (api.GetPromLabelValuesResponseObject, error) {
	pr := req.Params
	var ne *reqError
	if len(req.Name) < 1 || len(req.Name) > maxNameBytes {
		ne = fieldError("/name", "field.range", "name must be 1 to 256 bytes")
	}
	limit, le := limitParam(pr.Limit)
	mq := pulsusdb.MatchQuery{Match: optional(pr.Match), Start: time.UnixMilli(pr.From), End: time.UnixMilli(pr.To), Limit: limit}
	body, e := p.completion(ctx, pr.Tenant, firstError(tenantOf(pr.Tenant), ne, windowParams(pr.From, pr.To), matchParams(mq.Match, false), le), reservedMatch(mq.Match),
		func(ctx context.Context, s *requestScope) (any, error) {
			return valuesCall(func() (*pulsusdb.ValuesResult, error) { return s.c.LabelValues(ctx, s.rc, req.Name, mq) })
		})
	switch {
	case e == nil && body == nil:
		return nil, nil
	case e == nil:
		return api.GetPromLabelValues200JSONResponse(body.(api.PromValuesResponse)), nil
	case e.status == http.StatusTooManyRequests:
		return api.GetPromLabelValues429JSONResponse{RateLimitedJSONResponse: e.rateLimited()}, nil
	}
	return api.GetPromLabelValuesdefaultJSONResponse{Body: e.envelope(), StatusCode: e.status}, nil
}

// GetPromSeries is GET /api/dash/v1/prom/series.
func (p *prom) GetPromSeries(ctx context.Context, req api.GetPromSeriesRequestObject) (api.GetPromSeriesResponseObject, error) {
	pr := req.Params
	limit, le := limitParam(pr.Limit)
	mq := pulsusdb.MatchQuery{Match: pr.Match, Start: time.UnixMilli(pr.From), End: time.UnixMilli(pr.To), Limit: limit}
	body, e := p.completion(ctx, pr.Tenant, firstError(tenantOf(pr.Tenant), windowParams(pr.From, pr.To), matchParams(mq.Match, true), le), reservedMatch(mq.Match),
		func(ctx context.Context, s *requestScope) (any, error) {
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
	switch {
	case e == nil && body == nil:
		return nil, nil
	case e == nil:
		return api.GetPromSeries200JSONResponse(body.(api.PromSeriesResponse)), nil
	case e.status == http.StatusTooManyRequests:
		return api.GetPromSeries429JSONResponse{RateLimitedJSONResponse: e.rateLimited()}, nil
	}
	return api.GetPromSeriesdefaultJSONResponse{Body: e.envelope(), StatusCode: e.status}, nil
}

// GetPromMetadata is GET /api/dash/v1/prom/metadata.
func (p *prom) GetPromMetadata(ctx context.Context, req api.GetPromMetadataRequestObject) (api.GetPromMetadataResponseObject, error) {
	pr := req.Params
	limit, le := limitParam(pr.Limit)
	mq := pulsusdb.MetadataQuery{Limit: limit}
	var me *reqError
	if pr.Metric != nil {
		mq.Metric = *pr.Metric
		if len(mq.Metric) > maxQueryBytes {
			me = fieldError("/metric", "field.range", "metric must be at most 65536 bytes")
		}
	}
	body, e := p.completion(ctx, pr.Tenant, firstError(tenantOf(pr.Tenant), me, le), pulsusdb.CheckReserved("metric", mq.Metric),
		func(ctx context.Context, s *requestScope) (any, error) {
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
	switch {
	case e == nil && body == nil:
		return nil, nil
	case e == nil:
		return api.GetPromMetadata200JSONResponse(body.(api.PromMetadataResponse)), nil
	case e.status == http.StatusTooManyRequests:
		return api.GetPromMetadata429JSONResponse{RateLimitedJSONResponse: e.rateLimited()}, nil
	}
	return api.GetPromMetadatadefaultJSONResponse{Body: e.envelope(), StatusCode: e.status}, nil
}

// paramError is the §3.4 field error of a query parameter the generated wrapper could not bind,
// or nil for other request errors.
func paramError(err error) *reqError {
	var req *api.RequiredParamError
	var inv *api.InvalidParamFormatError
	var many *api.TooManyValuesForParamError
	name, key := "", ""
	switch {
	case errors.As(err, &req):
		name, key = req.ParamName, "field.required"
	case errors.As(err, &inv):
		name, key = inv.ParamName, "field.type"
	case errors.As(err, &many):
		name, key = many.ParamName, "field.type"
	default:
		return nil
	}
	if name == "tenant" {
		return fieldError("", "tenant.invalid", "tenant is required")
	}
	return fieldError("/"+name, key, name+" is missing or malformed")
}
