package gateway

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	promplan "github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/prom"
)

// plannedReq is a request planned and ready to send (plan #112 §3.4): the resolved tenant, the
// request context of the data call, the plan, and whether it was made without metric types.
type plannedReq struct {
	tc           core.TenantCtx
	rc           *core.RequestCtx
	planned      promplan.Planned
	typesWarning bool
}

// planFor runs steps 3–8 of the route order (plan #112 §4.4, ADR-0021 §7, T06-029): Prepare,
// the Classify refusal and the byte guard on the substituted text (both before any I/O), the
// step and the processing cap at that step (still before any I/O), tenant resolution, the metric types when the plan depends on them, Plan, and the guard
// on the planned text. ctx carries the route deadline. (nil, nil): the browser went away.
func (q *dataRoutes) planFor(ctx context.Context, tenant string, in promplan.Inputs) (*plannedReq, *reqError) {
	prepared, pe := promplan.Prepare(in)
	if pe != nil {
		return nil, planError(pe)
	}
	class := prepared.Class()
	// v1 (T07 §0): nothing resolves to a virtual source, so a reserved selector is refused.
	if class.Source != promplan.SourcePulsusDB {
		return nil, q.failure(ctx, pulsusdb.ReservedError("query", class.Reserved[0]))
	}
	if v := pulsusdb.CheckReserved("query", prepared.Substituted()); v != nil {
		return nil, q.failure(ctx, v)
	}
	step := promplan.FloorStep(in.StepMs, class.FloorMs)
	// The processing cap with the macros at that step, still before any I/O.
	if pe := prepared.CheckCap(step); pe != nil {
		return nil, planError(pe)
	}
	tc, e := resolveTenant(ctx, q.d, tenant)
	if e == errCancelled {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	if q.d.PulsusDB == nil || q.d.Types == nil {
		return nil, q.failure(ctx, &pulsusdb.Error{Kind: pulsusdb.KindConfig})
	}
	rc := dataRequestCtxFrom(ctx, tc)
	types, warn := promplan.MetricTypes{}, false
	if prepared.NeedsTypes() {
		t, err := q.d.Types.Types(ctx, rc)
		switch {
		case errors.Is(err, context.Canceled) && ctx.Err() != nil:
			return nil, nil
		case err != nil:
			// The plan degrades: only names ending in _total are rated (ADR-0021 consequences).
			warn = true
		default:
			types = t
		}
	}
	planned, pe := prepared.Plan(step, types)
	if pe != nil {
		return nil, planError(pe)
	}
	// The authoritative guard: the planned text is what is sent (rewrites add no reserved name).
	if v := pulsusdb.CheckReserved("query", planned.Query); v != nil {
		f := q.failure(ctx, v)
		f.body.Planned = promErrorPlanned(planned.Wire())
		return nil, f
	}
	return &plannedReq{tc: tc, rc: rc, planned: planned, typesWarning: warn}, nil
}

// planError is the response of a planning refusal: 400 or 413, code invalid, the refusal's
// fields; the full plan only on the final-size 413; hint {reason: processing_cap} and no plan
// on the processing cap.
func planError(e *promplan.PlanError) *reqError {
	fields := make([]api.FieldError, 0, len(e.Fields))
	for _, f := range e.Fields {
		fields = append(fields, api.FieldError{Pointer: f.Pointer, MessageKey: f.MessageKey})
	}
	body := api.ErrorBody{Code: api.Invalid, Message: e.Message, Fields: &fields}
	switch e.Kind {
	case promplan.ErrSentTooLarge:
		if e.Planned != nil {
			body.Planned = promErrorPlanned(e.Planned.Wire())
		}
	case promplan.ErrProcessingCap:
		body.Hint = hint("reason", "processing_cap")
	}
	return &reqError{status: e.Status(), body: body}
}

// toAPIPlanned is the OpenAPI PlannedQuery of a plan.
func toAPIPlanned(w promplan.PlannedWire) *api.PlannedQuery {
	p := &api.PlannedQuery{Query: w.Query, Expanded: w.Expanded, Bytes: w.Bytes, ValueType: api.PlannedQueryValueType(w.ValueType),
		RateCandidate: w.RateCandidate, RateApplied: w.RateApplied, Histogram: w.Histogram}
	if w.StepMs != 0 {
		v := w.StepMs
		p.StepMs = &v
	}
	if w.RateWindowMs != 0 {
		v := w.RateWindowMs
		p.RateWindowMs = &v
	}
	return p
}

// appendPlanned appends the planned member's object, members in PlannedWire order.
func appendPlanned(b []byte, w promplan.PlannedWire) []byte {
	b = append(b, `{"query":`...)
	b = appendString(b, w.Query)
	b = append(b, `,"expanded":`...)
	b = appendString(b, w.Expanded)
	b = append(b, `,"bytes":`...)
	b = strconv.AppendInt(b, int64(w.Bytes), 10)
	b = append(b, `,"value_type":`...)
	b = appendString(b, w.ValueType)
	b = append(b, `,"rate_candidate":`...)
	b = strconv.AppendBool(b, w.RateCandidate)
	b = append(b, `,"rate_applied":`...)
	b = strconv.AppendBool(b, w.RateApplied)
	b = append(b, `,"histogram":`...)
	b = strconv.AppendBool(b, w.Histogram)
	if w.StepMs != 0 {
		b = append(b, `,"step_ms":`...)
		b = strconv.AppendInt(b, w.StepMs, 10)
	}
	if w.RateWindowMs != 0 {
		b = append(b, `,"rate_window_ms":`...)
		b = strconv.AppendInt(b, w.RateWindowMs, 10)
	}
	return append(b, '}')
}

// failurePlanned is the response of an error after planning (plan #112 §4.6): PulsusDB's
// position is mapped from the sent text to the raw text (none inside a rewrite), then the
// unchanged mapping of failure, with the plan.
func (q *dataRoutes) failurePlanned(ctx context.Context, err error, p promplan.Planned) *reqError {
	var pe *pulsusdb.Error
	if errors.As(err, &pe) && pe.Position != nil {
		mapped := *pe
		mapped.Position = nil
		if raw, ok := p.ToSource(pe.Position.Offset); ok {
			mapped.Position = &pulsusdb.Position{Offset: raw}
		}
		err = &mapped
	}
	f := q.failure(ctx, err)
	if f != errCancelled {
		f.body.Planned = promErrorPlanned(p.Wire())
	}
	return f
}

// failPlanned writes failurePlanned's response; a cancel by the browser writes nothing.
func (q *dataRoutes) failPlanned(w http.ResponseWriter, r *http.Request, err error, p promplan.Planned) {
	if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
		return
	}
	writeReqError(w, q.failurePlanned(r.Context(), err, p))
}

// withTypesWarning puts WarnTypesUnavailable first in the warnings of a plan made without types.
func withTypesWarning(c pulsusdb.Completeness, warn bool) pulsusdb.Completeness {
	if warn {
		c.Warnings = append([]string{promplan.WarnTypesUnavailable}, c.Warnings...)
	}
	return c
}
