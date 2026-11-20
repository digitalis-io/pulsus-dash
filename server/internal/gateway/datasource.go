package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
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

// datasourceCheck is GET /api/dash/v1/datasource/check (T06-025): one runtimeinfo call of the
// tenant's binding, never part of readiness (T06-026). It answers 200 with the state, 404 for
// an unknown tenant and 503 when the configuration store is unavailable.
func (q *dataRoutes) datasourceCheck(w http.ResponseWriter, r *http.Request) {
	tenant, e := tenantParam(r)
	if e != nil {
		writeReqError(w, e)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), checkDeadline)
	defer cancel()
	tc, e := resolveTenant(ctx, q.d, tenant)
	if e != nil {
		writeReqError(w, e)
		return
	}
	state := api.DatasourceStatusStateError
	if q.d.PulsusDB != nil {
		_, err := q.d.PulsusDB.RuntimeInfo(ctx, requestCtx(r, tc))
		if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
			return
		}
		state = checkState(err)
	}
	at := q.now().UnixMilli()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(api.DatasourceStatus{State: state, CheckedAt: &at})
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
