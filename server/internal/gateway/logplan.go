package gateway

import (
	"context"

	logplan "github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/logs"
)

// logPlanFor is steps 3–6 of the LogQL route order (plan #116 §4.4). Stub.
func (q *dataRoutes) logPlanFor(context.Context, logplan.Inputs) (logplan.Planned, *reqError) {
	return logplan.Planned{}, nil
}
