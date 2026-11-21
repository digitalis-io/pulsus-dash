package gateway

import (
	"context"
	"net/http"

	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// logs implements the LogQL completion routes GET /api/dash/v1/logs/{labels,label/{name}/values,
// series} (plan #65 Part B §3.2) as strict handlers over Part A's LogLabels, LogLabelValues and
// LogSeries. They share completion with the PromQL routes: the guard before resolution, the
// 10 s deadline, and the 429 or default error response.
type logs struct{ deps Deps }

// logWindowParams is windowParams with the log routes' bounds (§3.3): from ≥ 0 and to at most
// maxLogTimeMs, so from·10⁶ and to·10⁶ fit int64.
func logWindowParams(from, to int64) *reqError {
	return firstError(rangeIf(from < 0, "/from", "from must be at least 0"), toBeyond(to), windowParams(from, to))
}

// logQueryParam checks the optional query parameter (at most 65 536 bytes).
func logQueryParam(q *string) (string, *reqError) {
	if q == nil {
		return "", nil
	}
	if len(*q) > maxQueryBytes {
		return "", fieldError("/query", "field.range", "query must be at most 65536 bytes")
	}
	return *q, nil
}

// reservedQuery is the guard over the optional query parameter.
func reservedQuery(q string) *pulsusdb.Error {
	if q == "" {
		return nil
	}
	return pulsusdb.CheckReserved("query", q)
}

// GetLogsLabels is GET /api/dash/v1/logs/labels.
func (l *logs) GetLogsLabels(ctx context.Context, req api.GetLogsLabelsRequestObject) (api.GetLogsLabelsResponseObject, error) {
	pr := req.Params
	limit, le := limitParam(pr.Limit)
	query, qe := logQueryParam(pr.Query)
	mq := pulsusdb.LogMatchQuery{Query: query, StartNs: pr.From * 1_000_000, EndNs: pr.To * 1_000_000, Limit: limit}
	body, e := completion(ctx, l.deps, pr.Tenant, firstError(tenantOf(pr.Tenant), logWindowParams(pr.From, pr.To), qe, le), reservedQuery(query),
		func(ctx context.Context, s *requestScope) (any, error) {
			return valuesCall(func() (*pulsusdb.ValuesResult, error) { return s.c.LogLabels(ctx, s.rc, mq) })
		})
	switch {
	case e == nil && body == nil:
		return nil, nil
	case e == nil:
		return api.GetLogsLabels200JSONResponse(body.(api.PromValuesResponse)), nil
	case e.status == http.StatusTooManyRequests:
		return api.GetLogsLabels429JSONResponse{RateLimitedJSONResponse: e.rateLimited()}, nil
	}
	return api.GetLogsLabelsdefaultJSONResponse{Body: e.envelope(), StatusCode: e.status}, nil
}

// GetLogsLabelValues is GET /api/dash/v1/logs/label/{name}/values.
func (l *logs) GetLogsLabelValues(ctx context.Context, req api.GetLogsLabelValuesRequestObject) (api.GetLogsLabelValuesResponseObject, error) {
	pr := req.Params
	var ne *reqError
	if len(req.Name) < 1 || len(req.Name) > maxNameBytes {
		ne = fieldError("/name", "field.range", "name must be 1 to 256 bytes")
	}
	limit, le := limitParam(pr.Limit)
	query, qe := logQueryParam(pr.Query)
	mq := pulsusdb.LogMatchQuery{Query: query, StartNs: pr.From * 1_000_000, EndNs: pr.To * 1_000_000, Limit: limit}
	body, e := completion(ctx, l.deps, pr.Tenant, firstError(tenantOf(pr.Tenant), ne, logWindowParams(pr.From, pr.To), qe, le), reservedQuery(query),
		func(ctx context.Context, s *requestScope) (any, error) {
			return valuesCall(func() (*pulsusdb.ValuesResult, error) { return s.c.LogLabelValues(ctx, s.rc, req.Name, mq) })
		})
	switch {
	case e == nil && body == nil:
		return nil, nil
	case e == nil:
		return api.GetLogsLabelValues200JSONResponse(body.(api.PromValuesResponse)), nil
	case e.status == http.StatusTooManyRequests:
		return api.GetLogsLabelValues429JSONResponse{RateLimitedJSONResponse: e.rateLimited()}, nil
	}
	return api.GetLogsLabelValuesdefaultJSONResponse{Body: e.envelope(), StatusCode: e.status}, nil
}

// GetLogsSeries is GET /api/dash/v1/logs/series.
func (l *logs) GetLogsSeries(ctx context.Context, req api.GetLogsSeriesRequestObject) (api.GetLogsSeriesResponseObject, error) {
	pr := req.Params
	limit, le := limitParam(pr.Limit)
	sq := pulsusdb.LogSeriesQuery{Match: pr.Match, StartNs: pr.From * 1_000_000, EndNs: pr.To * 1_000_000, Limit: limit}
	body, e := completion(ctx, l.deps, pr.Tenant, firstError(tenantOf(pr.Tenant), logWindowParams(pr.From, pr.To), matchParams(sq.Match, true), le), reservedMatch(sq.Match),
		func(ctx context.Context, s *requestScope) (any, error) {
			v, err := s.c.LogSeries(ctx, s.rc, sq)
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
		return api.GetLogsSeries200JSONResponse(body.(api.PromSeriesResponse)), nil
	case e.status == http.StatusTooManyRequests:
		return api.GetLogsSeries429JSONResponse{RateLimitedJSONResponse: e.rateLimited()}, nil
	}
	return api.GetLogsSeriesdefaultJSONResponse{Body: e.envelope(), StatusCode: e.status}, nil
}
