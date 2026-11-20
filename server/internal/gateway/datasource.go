package gateway

import (
	"context"
	"errors"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// checkDeadline bounds the data-source check.
const checkDeadline = 5 * time.Second

// requestScope is what a completion call needs: the request's RequestCtx and the client.
type requestScope struct {
	rc *core.RequestCtx
	c  *pulsusdb.Client
}

// datasource implements GET /api/dash/v1/datasource/check (T06-025): one runtimeinfo call of the
// tenant's binding, never part of readiness (T06-026). It answers 200 with the state, 400 for a
// malformed tenant, 404 for an unknown one and 503 when the configuration store is unavailable.
type datasource struct{ deps Deps }

func (d *datasource) GetDatasourceCheck(ctx context.Context, req api.GetDatasourceCheckRequestObject) (api.GetDatasourceCheckResponseObject, error) {
	if e := tenantOf(req.Params.Tenant); e != nil {
		return api.GetDatasourceCheck400JSONResponse(e.envelope()), nil
	}
	ctx, cancel := context.WithTimeout(ctx, checkDeadline)
	defer cancel()
	tc, e := resolveTenant(ctx, d.deps, req.Params.Tenant)
	if e != nil {
		if e.body.Code == api.NotFound {
			return api.GetDatasourceCheck404JSONResponse(e.envelope()), nil
		}
		return api.GetDatasourceCheck503JSONResponse(e.envelope()), nil
	}
	state := api.DatasourceStatusStateError
	if d.deps.PulsusDB != nil {
		_, err := d.deps.PulsusDB.RuntimeInfo(ctx, dataRequestCtxFrom(ctx, tc))
		if errors.Is(err, context.Canceled) {
			return nil, nil // the browser went away: nothing is written
		}
		state = checkState(err)
	}
	at := (&dataRoutes{d: d.deps}).now().UnixMilli()
	return api.GetDatasourceCheck200JSONResponse(api.DatasourceStatus{State: state, CheckedAt: &at}), nil
}

// checkState maps the runtimeinfo outcome (plan #62 §4.6).
func checkState(err error) api.DatasourceStatusState {
	if err == nil {
		return api.DatasourceStatusStateOk
	}
	var e *pulsusdb.Error
	if errors.As(err, &e) {
		switch e.Kind {
		case pulsusdb.KindUnauthorised:
			return api.DatasourceStatusStateUnauthorised
		case pulsusdb.KindUnreachable, pulsusdb.KindTimeout, pulsusdb.KindUnavailable:
			return api.DatasourceStatusStateUnreachable
		}
	}
	return api.DatasourceStatusStateError
}
