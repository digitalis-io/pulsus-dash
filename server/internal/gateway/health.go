package gateway

import (
	"context"
	"errors"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
)

// readyCheckTimeout is the budget of each readiness check (Ping, then SchemaVersion).
const readyCheckTimeout = time.Second

// health implements the probe routes (T19-006). PulsusDB is never contacted (T06-026).
type health struct{ deps Deps }

func (h *health) GetHealthz(context.Context, api.GetHealthzRequestObject) (api.GetHealthzResponseObject, error) {
	return api.GetHealthz200JSONResponse{Status: api.HealthStatusOk}, nil
}

// GetStartupz is ready as soon as the listener is open: there is no cache to warm yet.
func (h *health) GetStartupz(context.Context, api.GetStartupzRequestObject) (api.GetStartupzResponseObject, error) {
	return api.GetStartupz200JSONResponse{Status: api.HealthStatusOk}, nil
}

// auditPartitions is the audit partition check (T11-021): unknown without a state.
func (h *health) auditPartitions() api.ReadyChecksAuditPartitions {
	if h.deps.AuditPartitions == nil {
		return api.ReadyChecksAuditPartitionsUnknown
	}
	return api.ReadyChecksAuditPartitions(h.deps.AuditPartitions.Check())
}

// GetReadyz checks Postgres, the schema window and the audit partitions. An audit partition state
// of error (audited saves fail or are about to) is not ready; low is reported but stays ready.
func (h *health) GetReadyz(ctx context.Context, _ api.GetReadyzRequestObject) (api.GetReadyzResponseObject, error) {
	audit := h.auditPartitions()
	notReady := func(pg api.ReadyChecksPostgres, schema api.ReadyChecksSchema) (api.GetReadyzResponseObject, error) {
		return api.GetReadyz503JSONResponse{Status: api.ReadyStatusNotReady,
			Checks: api.ReadyChecks{Postgres: pg, Schema: schema, AuditPartitions: audit}}, nil
	}

	pingCtx, cancel := context.WithTimeout(ctx, readyCheckTimeout)
	err := h.deps.Probe.Ping(pingCtx)
	cancel()
	if err != nil {
		h.deps.Logger.WarnContext(ctx, "readyz", "check", "postgres", "error", err.Error())
		return notReady(api.ReadyChecksPostgresUnreachable, api.ReadyChecksSchemaUnknown)
	}

	schemaCtx, cancel := context.WithTimeout(ctx, readyCheckTimeout)
	v, err := h.deps.Probe.SchemaVersion(schemaCtx)
	cancel()
	if err != nil {
		h.deps.Logger.WarnContext(ctx, "readyz", "check", "schema", "error", err.Error())
		if errors.Is(err, context.DeadlineExceeded) {
			return notReady(api.ReadyChecksPostgresOk, api.ReadyChecksSchemaTimeout)
		}
		return notReady(api.ReadyChecksPostgresOk, api.ReadyChecksSchemaError)
	}
	switch latest := h.deps.SchemaLatest; {
	case v < latest:
		return notReady(api.ReadyChecksPostgresOk, api.ReadyChecksSchemaBehind)
	case v > latest+1:
		return notReady(api.ReadyChecksPostgresOk, api.ReadyChecksSchemaAhead)
	}
	if audit == api.ReadyChecksAuditPartitionsError {
		return notReady(api.ReadyChecksPostgresOk, api.ReadyChecksSchemaOk)
	}
	return api.GetReadyz200JSONResponse{Status: api.ReadyStatusReady,
		Checks: api.ReadyChecks{Postgres: api.ReadyChecksPostgresOk, Schema: api.ReadyChecksSchemaOk, AuditPartitions: audit}}, nil
}
