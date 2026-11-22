package gateway

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	logplan "github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/logs"
	promplan "github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/prom"
)

// logPlanFor runs steps 3–6 of the LogQL route order (plan #116 §4.4, ADR-0021 §7, T06-029):
// Prepare; the Classify refusal and the byte guard on the substituted text; the step (Resolve is
// the identity: LogQL reserved selectors have no floor, T07 §4.3) and the processing cap at it;
// Plan; and the authoritative Classify and byte guard on the planned text. It is pure and runs
// before any I/O, tenant resolution included; ctx is only for failure's request-id log.
func (q *dataRoutes) logPlanFor(ctx context.Context, in logplan.Inputs) (logplan.Planned, *reqError) {
	prepared, pe := logplan.Prepare(in)
	if pe != nil {
		return logplan.Planned{}, logPlanError(pe)
	}
	// v1 (T07 §0): nothing resolves to a virtual source, so a reserved selector is refused.
	if prepared.Class().Source != logplan.SourcePulsusDB {
		return logplan.Planned{}, q.failure(ctx, pulsusdb.ReservedError("query", logplan.ReservedMatcher))
	}
	if v := pulsusdb.CheckReserved("query", prepared.Substituted()); v != nil {
		return logplan.Planned{}, q.failure(ctx, v)
	}
	step := in.StepMs
	if pe := prepared.CheckCap(step); pe != nil {
		return logplan.Planned{}, logPlanError(pe)
	}
	planned, pe := prepared.Plan(step)
	if pe != nil {
		return logplan.Planned{}, logPlanError(pe)
	}
	// The final classification is authoritative (plan #116 §3.2): a macro at the step can change
	// a decoded value. Then the byte guard on the text sent.
	if planned.Class.Source != logplan.SourcePulsusDB {
		return logplan.Planned{}, withLogPlanned(q.failure(ctx, pulsusdb.ReservedError("query", logplan.ReservedMatcher)), planned)
	}
	if v := pulsusdb.CheckReserved("query", planned.Query); v != nil {
		return logplan.Planned{}, withLogPlanned(q.failure(ctx, v), planned)
	}
	return planned, nil
}

// logPlanError is the response of a LogQL planning refusal, as planError's: 400 or 413, code
// invalid, the refusal's fields; the full plan only on the final-size 413; hint {reason:
// processing_cap} and no plan on the processing cap.
func logPlanError(e *logplan.PlanError) *reqError {
	fields := make([]api.FieldError, 0, len(e.Fields))
	for _, f := range e.Fields {
		fields = append(fields, api.FieldError{Pointer: f.Pointer, MessageKey: f.MessageKey})
	}
	body := api.ErrorBody{Code: api.Invalid, Message: e.Message, Fields: &fields}
	switch e.Kind {
	case logplan.ErrSentTooLarge:
		if e.Planned != nil {
			body.Planned = logErrorPlanned(e.Planned.Wire())
		}
	case logplan.ErrProcessingCap:
		body.Hint = hint("reason", "processing_cap")
	}
	return &reqError{status: e.Status(), body: body}
}

// toAPILogPlanned is the OpenAPI LogqlPlannedQuery of a plan.
func toAPILogPlanned(w logplan.PlannedWire) api.LogqlPlannedQuery {
	return api.LogqlPlannedQuery{Query: w.Query, Expanded: w.Expanded, Bytes: w.Bytes, StepMs: w.StepMs}
}

// appendLogPlanned appends the planned member's object, members in PlannedWire order.
func appendLogPlanned(b []byte, w logplan.PlannedWire) []byte {
	b = append(b, `{"query":`...)
	b = appendString(b, w.Query)
	b = append(b, `,"expanded":`...)
	b = appendString(b, w.Expanded)
	b = append(b, `,"bytes":`...)
	b = strconv.AppendInt(b, int64(w.Bytes), 10)
	b = append(b, `,"step_ms":`...)
	b = strconv.AppendInt(b, w.StepMs, 10)
	return append(b, '}')
}

// logErrorPlanned is the ErrorBody planned union holding a LogQL plan; nil if it cannot be built
// (unreachable: the object always marshals).
func logErrorPlanned(w logplan.PlannedWire) *api.ErrorBody_Planned {
	var u api.ErrorBody_Planned
	if err := u.FromLogqlPlannedQuery(toAPILogPlanned(w)); err != nil {
		return nil
	}
	return &u
}

// promErrorPlanned is the ErrorBody planned union holding a PromQL plan: the same bytes as the
// PlannedQuery object it holds.
func promErrorPlanned(w promplan.PlannedWire) *api.ErrorBody_Planned {
	var u api.ErrorBody_Planned
	if err := u.FromPlannedQuery(*toAPIPlanned(w)); err != nil {
		return nil
	}
	return &u
}

// withLogPlanned is e with the plan in its body: errCancelled as is (nothing is written), else a
// copy, so a shared error value is never changed.
func withLogPlanned(e *reqError, p logplan.Planned) *reqError {
	if e == nil || e == errCancelled {
		return e
	}
	c := *e
	c.body.Planned = logErrorPlanned(p.Wire())
	return &c
}

// failureLogPlanned is the response of an error after LogQL planning (plan #116 §4.5): PulsusDB's
// position is mapped from the sent text to the raw text (none inside the volume template) and
// the first "at byte N" of its message follows; then the unchanged mapping of failure, with the
// plan.
func (q *dataRoutes) failureLogPlanned(ctx context.Context, err error, p logplan.Planned) *reqError {
	var pe *pulsusdb.Error
	if errors.As(err, &pe) && pe.Position != nil {
		mapped := *pe
		mapped.Position = nil
		if raw, ok := p.ToSource(pe.Position.Offset); ok {
			mapped.Position = &pulsusdb.Position{Offset: raw}
			mapped.Message = logplan.RewriteAtByte(pe.Message, raw)
		}
		err = &mapped
	}
	return withLogPlanned(q.failure(ctx, err), p)
}

// failLogPlanned writes failureLogPlanned's response; a cancel by the browser writes nothing.
func (q *dataRoutes) failLogPlanned(w http.ResponseWriter, r *http.Request, err error, p logplan.Planned) {
	if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
		return
	}
	writeReqError(w, q.failureLogPlanned(r.Context(), err, p))
}
