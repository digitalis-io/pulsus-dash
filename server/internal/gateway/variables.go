package gateway

import (
	"context"
	"net/http"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	logplan "github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/logs"
	promplan "github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/prom"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/vars"
	"github.com/digitalis-io/pulsus-dash/server/internal/varquery"
)

// variablesRequest is the body of POST /api/dash/v1/variables/values (OpenAPI
// VariableValuesRequest); pointer fields detect a missing member.
type variablesRequest struct {
	Lang  *string  `json:"lang"`
	Query *string  `json:"query"`
	From  *int64   `json:"from"`
	To    *int64   `json:"to"`
	Vars  vars.Map `json:"vars"`
	Limit *int     `json:"limit"`
}

func (r *variablesRequest) rawQuery() *string { return r.Query }

// maxVariableQueryBytes bounds a variable query (the spec's query.text of a variable).
const maxVariableQueryBytes = 4096

// variablePlanned is the planned member of the answer: the label and the substituted selector
// (null for label_values(label)).
type variablePlanned struct {
	Label string  `json:"label"`
	Match *string `json:"match"`
}

type variablesResponse struct {
	Planned      variablePlanned  `json:"planned"`
	Values       []string         `json:"values"`
	Completeness api.Completeness `json:"completeness"`
}

// serveVariableValues is POST /api/dash/v1/variables/values (plan #289 §3.5, SRF-017, T06-029):
// the field checks, varquery.Parse, the selector substituted by its language module's rules
// (T07-031) and read as one selector, the reserved-name guard before tenant resolution, then the
// label values call of the completion routes (10 s, the scope check of Client.do). Nothing is
// sent upstream before every check passed.
func (q *dataRoutes) serveVariableValues(w http.ResponseWriter, r *http.Request) {
	tenant, e := tenantParam(r)
	var req variablesRequest
	if e == nil {
		e = readBody(w, r, &req)
	}
	if e == nil {
		e = firstError(required("lang", req.Lang != nil), required("query", req.Query != nil),
			required("from", req.From != nil), required("to", req.To != nil))
	}
	if e != nil {
		writeReqError(w, e)
		return
	}
	lang, text, from, to := *req.Lang, *req.Query, *req.From, *req.To
	limit, le := limitParam(req.Limit)
	window := windowParams(from, to)
	if lang == "logql" {
		window = logWindowParams(from, to)
	}
	if e := firstError(tenantOf(tenant),
		rangeIf(lang != "promql" && lang != "logql", "/lang", "lang must be promql or logql"),
		rangeIf(len(text) < 1 || len(text) > maxVariableQueryBytes, "/query", "query must be 1 to 4096 bytes"),
		rangeIf(from < 0, "/from", "from must be at least 0"), window, le); e != nil {
		writeReqError(w, e)
		return
	}
	vq, err := varquery.Parse(lang, text)
	if err != nil {
		writeReqError(w, fieldError("/query", "query.invalid", "a variable query must be label_values(label) or label_values(selector, label)"))
		return
	}
	var match *string
	if vq.Selector != "" {
		sel, e := substituteSelector(lang, vq.Selector, req.Vars)
		if e != nil {
			writeReqError(w, e)
			return
		}
		match = &sel
	}
	var reserved *pulsusdb.Error
	if match != nil {
		reserved = pulsusdb.CheckReserved("query", *match)
	}
	planned := variablePlanned{Label: vq.Label, Match: match}
	body, e := completion(r.Context(), q.d, tenant, nil, reserved,
		func(ctx context.Context, s *requestScope) (any, error) {
			var v *pulsusdb.ValuesResult
			var err error
			if lang == "promql" {
				mq := pulsusdb.MatchQuery{Start: time.UnixMilli(from), End: time.UnixMilli(to), Limit: limit}
				if match != nil {
					mq.Match = []string{*match}
				}
				v, err = s.c.LabelValues(ctx, s.rc, vq.Label, mq)
			} else {
				lq := pulsusdb.LogMatchQuery{StartNs: from * 1_000_000, EndNs: to * 1_000_000, Limit: limit}
				if match != nil {
					lq.Query = *match
				}
				v, err = s.c.LogLabelValues(ctx, s.rc, vq.Label, lq)
			}
			if err != nil {
				return nil, err
			}
			return variablesResponse{Planned: planned, Values: v.Values, Completeness: toAPI(v.Completeness)}, nil
		})
	switch {
	case e == nil && body == nil:
		return
	case e != nil:
		writeReqError(w, e)
		return
	}
	writeJSON(w, http.StatusOK, body)
}

// substituteSelector is step 3 of §3.5 in the query's language: the module's refusal as the
// planner routes answer it.
func substituteSelector(lang, sel string, vs vars.Map) (string, *reqError) {
	if lang == "promql" {
		out, pe := promplan.SubstituteSelector(sel, vs)
		if pe != nil {
			return "", planError(pe)
		}
		return out, nil
	}
	out, pe := logplan.SubstituteSelector(sel, vs)
	if pe != nil {
		return "", logPlanError(pe)
	}
	return out, nil
}
