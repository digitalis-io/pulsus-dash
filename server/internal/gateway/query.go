package gateway

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	promplan "github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/prom"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/vars"
)

// Bounds of the query routes (plan #62 §3.4, A.2; the query and its variables are checked by
// prom.Prepare, plan #112 §3.1); the body limit is maxRequestBody (T06-021). maxQueryBytes is the
// limit of a completion route's match value.
const (
	maxQueryBytes    = 65536
	minStepMs        = 1_000
	maxStepMs        = 86_400_000
	maxTimeMs        = 253402300799999
	minTimeoutMs     = 200
	maxTimeoutMs     = 120_000
	defaultTimeoutMs = 30_000
	maxWidthPx       = 10_000
	maxRangeMs       = 9_007_199_254_740_991
	streamBuffer     = 32 << 10
	// maxLogTimeMs is the latest time the log routes accept, before and after grid alignment:
	// ⌊(2⁶³−1)/10⁶⌋ ms (2262-04-11T23:47:16.854Z), so every ns value fits int64 (plan #65
	// Part B §3.3, Q6). The PromQL routes keep maxTimeMs.
	maxLogTimeMs = 9_223_372_036_854
)

// dataRoutes are the hand-written PulsusDB query routes: PromQL range and instant (this file) and
// LogQL range and volume (logql.go); the completion routes (prom.go, logs.go) and the data-source
// check (datasource.go) are strict handlers.
type dataRoutes struct{ d Deps }

func (q *dataRoutes) now() time.Time {
	if q.d.Now != nil {
		return q.d.Now()
	}
	return time.Now()
}

// dataScope is the data scope of every data call: the full tenant until T10 (M-UI6). It is a
// test seam (arrow_test.go: a restricted or empty scope is denied the same for JSON and DSF);
// production code never changes it.
var dataScope = core.FullTenantScope

// dataRequestCtxFrom is the RequestCtx of every data call: the request's (organisation, actor
// and request ID) with the resolved tenant, the fixed local principal (D12) and dataScope.
func dataRequestCtxFrom(ctx context.Context, t core.TenantCtx) *core.RequestCtx {
	rc := *rcFrom(ctx)
	rc.Tenant, rc.Principal, rc.Scope, rc.Priority = t, core.LocalPrincipal, dataScope(), core.PriorityInteractive
	if rc.RequestID == "" {
		rc.RequestID, _ = ctx.Value(requestIDKey{}).(string)
	}
	return &rc
}

// rangeRequest and instantRequest have pointer fields so a missing field is detected.
type rangeRequest struct {
	Query     *string  `json:"query"`
	From      *int64   `json:"from"`
	To        *int64   `json:"to"`
	WidthPx   *int64   `json:"width_px"`
	TimeoutMs *int64   `json:"timeout_ms"`
	Vars      vars.Map `json:"vars"`
	Rate      *bool    `json:"rate"`
	StepMs    *int64   `json:"step_ms"`
	RangeMs   *int64   `json:"range_ms"`
}

type instantRequest struct {
	Query     *string  `json:"query"`
	At        *int64   `json:"at"`
	TimeoutMs *int64   `json:"timeout_ms"`
	Vars      vars.Map `json:"vars"`
	StepMs    *int64   `json:"step_ms"`
}

// queryHolder is a body with a query member, for readBody's UTF-8 pointer.
type queryHolder interface{ rawQuery() *string }

func (r *rangeRequest) rawQuery() *string   { return r.Query }
func (r *instantRequest) rawQuery() *string { return r.Query }

// readBody decodes one JSON object into dst (≤ 2 MiB, no unknown field, nothing after it).
func readBody(w http.ResponseWriter, r *http.Request, dst any) *reqError {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBody))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return &reqError{status: http.StatusRequestEntityTooLarge, body: api.ErrorBody{Code: api.Invalid, Message: "body too large"}}
		}
		return fieldError("", "body.invalid", "the body is not a JSON object")
	}
	bodyInvalid := fieldError("", "body.invalid", "the body is not a JSON object")
	if t := bytes.TrimLeft(b, " \t\r\n"); len(t) == 0 || t[0] != '{' {
		return bodyInvalid
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var ve *vars.TypeError
		if errors.As(err, &ve) {
			if ve.Name == "" {
				return fieldError("/vars", "field.type", "wrong type")
			}
			return fieldError("/vars"+pointerOf(ve.Name), "field.type", "wrong type")
		}
		var te *json.UnmarshalTypeError
		if errors.As(err, &te) && te.Field != "" {
			// The decoder's dotted path ("vars.a") as a JSON pointer ("/vars/a").
			return fieldError("/"+strings.ReplaceAll(te.Field, ".", "/"), "field.type", "wrong type")
		}
		if name, ok := strings.CutPrefix(err.Error(), "json: unknown field "); ok {
			if n, err := strconv.Unquote(name); err == nil {
				return fieldError("/"+n, "field.unknown", "unknown field")
			}
		}
		return bodyInvalid
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return bodyInvalid
	}
	if !utf8.Valid(b) {
		// The decoder turned the bad bytes into U+FFFD: in the query, or else in a variable.
		if qh, ok := dst.(queryHolder); ok {
			if q := qh.rawQuery(); q == nil || !strings.ContainsRune(*q, utf8.RuneError) {
				return fieldError("/vars", "field.range", "vars must be UTF-8")
			}
		}
		return fieldError("/query", "field.range", "query must be UTF-8")
	}
	return nil
}

func required(name string, present bool) *reqError {
	if present {
		return nil
	}
	return fieldError("/"+name, "field.required", name+" is required")
}

// timeoutOf is timeout_ms (default 30 000) checked against 200..120 000.
func timeoutOf(ms *int64) (time.Duration, *reqError) {
	v := int64(defaultTimeoutMs)
	if ms != nil {
		v = *ms
	}
	if v < minTimeoutMs || v > maxTimeoutMs {
		return 0, fieldError("/timeout_ms", "field.range", "timeout_ms must be between 200 and 120000")
	}
	return time.Duration(v) * time.Millisecond, nil
}

func firstError(es ...*reqError) *reqError {
	for _, e := range es {
		if e != nil {
			return e
		}
	}
	return nil
}

// failure is the response of a data-call error (§4.4); a reserved selector is logged at info
// with its field, never the text.
func (q *dataRoutes) failure(ctx context.Context, err error) *reqError {
	if errors.Is(err, context.Canceled) {
		return errCancelled
	}
	status, body, retryAfter := upstreamError(err)
	if body.Code == api.VirtualUnsupported && body.Fields != nil {
		id, _ := ctx.Value(requestIDKey{}).(string)
		q.d.Logger.InfoContext(ctx, "reserved_selector", "field", (*body.Fields)[0].Pointer, "request_id", id)
	}
	return &reqError{status: status, body: body, retryAfter: retryAfter}
}

// serveRange is POST /api/dash/v1/query/promql/range (plan #62 §4.1, plan #112 §4.4): the raw
// text is planned on the server and the planned text is sent; the frames are written as the
// upstream body is decoded, one series at a time, after the planned member.
//
// With the DSF Accept the 200 body is DSF (streamArrow, plan #68 D1); every other response, and
// every step before the first byte, is the same for both formats. Every response varies on Accept.
func (q *dataRoutes) serveRange(w http.ResponseWriter, r *http.Request) {
	w.Header().Add("Vary", "Accept")
	tenant, e := tenantParam(r)
	if e != nil {
		writeReqError(w, e)
		return
	}
	var req rangeRequest
	if e := readBody(w, r, &req); e != nil {
		writeReqError(w, e)
		return
	}
	if e := firstError(required("query", req.Query != nil), required("from", req.From != nil),
		required("to", req.To != nil), required("width_px", req.WidthPx != nil)); e != nil {
		writeReqError(w, e)
		return
	}
	from, to, width := *req.From, *req.To, *req.WidthPx
	timeout, te := timeoutOf(req.TimeoutMs)
	if e := firstError(rangeIf(from < 0, "/from", "from must be at least 0"),
		rangeIf(to > maxTimeMs, "/to", "to is out of range"), rangeIf(width < 1 || width > maxWidthPx, "/width_px", "width_px must be between 1 and 10000"),
		rangeIf(from >= to, "/to", "to must be after from"), te); e != nil {
		writeReqError(w, e)
		return
	}
	rangeMs := to - from
	if req.RangeMs != nil {
		rangeMs = *req.RangeMs
	}
	if e := firstError(rangeIf(rangeMs < 1 || rangeMs > maxRangeMs, "/range_ms", "range_ms must be between 1 and 9007199254740991"),
		rangeIf(req.StepMs != nil && (*req.StepMs < pulsusdb.PromLadder[0] || *req.StepMs > maxStepMs), "/step_ms", "step_ms must be between 15000 and 86400000")); e != nil {
		writeReqError(w, e)
		return
	}
	grid, err := rangeGrid(from, to, int(width), req.StepMs)
	if errors.Is(err, pulsusdb.ErrStepNotOnLadder) {
		writeReqError(w, fieldError("/step_ms", "field.range", err.Error()))
		return
	}
	if err != nil {
		writeReqError(w, fieldError("/from", "range.too_long", err.Error()))
		return
	}
	rate := req.Rate == nil || *req.Rate
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	pr, e := q.planFor(ctx, w, tenant, promplan.Inputs{Query: *req.Query, Vars: req.Vars, Kind: promplan.KindRange, Rate: rate, StepMs: grid.Step,
		RangeMs: rangeMs})
	if e != nil || pr == nil {
		if e != nil {
			writeReqError(w, e)
		}
		return
	}
	rs, err := q.d.PulsusDB.QueryRange(ctx, pr.rc, pulsusdb.RangeQuery{Query: pr.planned.Query,
		Start: time.UnixMilli(grid.Start), End: time.UnixMilli(grid.End), Step: time.Duration(grid.Step) * time.Millisecond, Timeout: timeout})
	if err != nil {
		q.failPlanned(w, r, err, pr.planned)
		return
	}
	defer func() { _ = rs.Close() }()
	first, err := nextSeries(rs)
	if err != nil && !errors.Is(err, io.EOF) {
		q.failPlanned(w, r, err, pr.planned)
		return
	}
	h := streamHead{planned: appendPlanned(nil, pr.planned.Wire()), typesWarning: pr.typesWarning}
	if wantsArrow(r) {
		q.streamArrow(w, r, pr.rc, h, pr.planned, rs, grid, from, first)
		return
	}
	q.stream(w, r, pr.rc, h, rs, grid, first, "promql_stream_aborted")
}

// rangeGrid is the range route's grid: at the client's ladder step when it sent one (the range
// store, #304 §A.1), else from the chart width (ADR-0021 §1). Either way the server plans.
func rangeGrid(from, to int64, width int, stepMs *int64) (pulsusdb.Grid, error) {
	if stepMs != nil {
		return pulsusdb.PromGridStep(from, to, *stepMs)
	}
	return pulsusdb.PromGrid(from, to, width)
}

// setScopeHeaders writes the scope epoch and sequence the request runs under (#304 §A.2,
// ADR-0038): the browser's range store orders and drops its cached data by them.
func setScopeHeaders(w http.ResponseWriter, rc *core.RequestCtx) {
	b := rc.Tenant.Binding
	w.Header().Set("X-Pulsus-Scope-Epoch", core.ScopeEpoch(rc.Principal.ID, b, rc.Scope))
	w.Header().Set("X-Pulsus-Scope-Seq", strconv.FormatInt(b.ScopeSeq, 10))
}

func rangeIf(bad bool, pointer, msg string) *reqError {
	if bad {
		return fieldError(pointer, "field.range", msg)
	}
	return nil
}

// streamHead is what a range body writes before its grid (plan #116 §3.4): the kind member
// ("" = none, the PromQL body; "series", a LogQL metric result), the encoded planned object
// (nil = none) and whether the PromQL types warning joins the completeness.
type streamHead struct {
	kind         string
	planned      []byte
	typesWarning bool
}

// stream writes the range body from the first frame on (§4.1 steps 8-10). A failure after the
// header was written resets the connection, so the browser never sees a truncated body as valid.
// The body starts with h's kind and planned members, in that order (T06-029: PromQL
// {"planned":…, LogQL {"kind":"series","planned":…). abortMsg is the log message of a reset.
func (q *dataRoutes) stream(w http.ResponseWriter, r *http.Request, rc *core.RequestCtx, h streamHead, rs *pulsusdb.ResultStream,
	g pulsusdb.Grid, first *pulsusdb.Series, abortMsg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	bw := bufio.NewWriterSize(w, streamBuffer)
	buf := make([]byte, 0, streamBuffer)
	buf = append(buf, '{')
	if h.kind != "" {
		buf = append(buf, `"kind":`...)
		buf = appendString(buf, h.kind)
		buf = append(buf, ',')
	}
	if h.planned != nil {
		buf = append(buf, `"planned":`...)
		buf = append(buf, h.planned...)
		buf = append(buf, ',')
	}
	buf = append(buf, `"start":`...)
	buf = strconv.AppendInt(buf, g.Start, 10)
	buf = append(buf, `,"end":`...)
	buf = strconv.AppendInt(buf, g.End, 10)
	buf = append(buf, `,"step":`...)
	buf = strconv.AppendInt(buf, g.Step, 10)
	buf = append(buf, `,"frames":[`...)
	write := func() bool {
		_, err := bw.Write(buf)
		buf = buf[:0]
		return err == nil
	}
	if first != nil {
		buf = appendFrame(buf, first)
		if !write() || bw.Flush() != nil {
			return
		}
		_ = http.NewResponseController(w).Flush()
		for {
			s, err := rs.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				q.abort(r, rc, err, abortMsg)
				return
			}
			buf = append(buf, ',')
			buf = appendFrame(buf, s)
			if !write() {
				return
			}
		}
	}
	c := withTypesWarning(rs.Completeness(), h.typesWarning)
	buf = append(buf, `],"completeness":`...)
	buf = appendCompleteness(buf, c, q.dataAge(c))
	buf = append(buf, '}')
	if write() && bw.Flush() == nil {
		_ = http.NewResponseController(w).Flush()
	}
}

// dataAge is the data_age_ms of c: now minus its newest sample, at least 0; -1 (omitted) when it
// has none.
func (q *dataRoutes) dataAge(c pulsusdb.Completeness) int64 {
	if c.NewestSampleMs < 0 {
		return -1
	}
	return max(0, q.now().UnixMilli()-c.NewestSampleMs)
}

// abort ends a stream that failed after its header: silently if the browser went away, else
// logged as msg and the connection reset (the recoverer re-panics http.ErrAbortHandler).
func (q *dataRoutes) abort(r *http.Request, rc *core.RequestCtx, err error, msg string) {
	if r.Context().Err() != nil {
		return
	}
	kind := "internal"
	var pe *pulsusdb.Error
	if errors.As(err, &pe) {
		kind = pe.Kind.String()
	}
	q.d.Logger.WarnContext(r.Context(), msg, "tenant", rc.Tenant.Binding.Slug, "kind", kind, "request_id", rc.RequestID)
	panic(http.ErrAbortHandler)
}

// serveInstant is POST /api/dash/v1/query/promql/instant (plan #112 §4.4): planned as the range
// route is; the body is decoded completely, then written in one go.
func (q *dataRoutes) serveInstant(w http.ResponseWriter, r *http.Request) {
	tenant, e := tenantParam(r)
	if e != nil {
		writeReqError(w, e)
		return
	}
	var req instantRequest
	if e := readBody(w, r, &req); e != nil {
		writeReqError(w, e)
		return
	}
	if e := firstError(required("query", req.Query != nil), required("at", req.At != nil)); e != nil {
		writeReqError(w, e)
		return
	}
	timeout, te := timeoutOf(req.TimeoutMs)
	var stepMs int64
	if req.StepMs != nil {
		stepMs = *req.StepMs
	}
	if e := firstError(rangeIf(*req.At < 0 || *req.At > maxTimeMs, "/at", "at is out of range"), te,
		rangeIf(req.StepMs != nil && (stepMs < minStepMs || stepMs > maxStepMs), "/step_ms", "step_ms must be between 1000 and 86400000")); e != nil {
		writeReqError(w, e)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	// The instant body has no window, so a range macro is refused (#291).
	pr, e := q.planFor(ctx, nil, tenant, promplan.Inputs{Query: *req.Query, Vars: req.Vars, Kind: promplan.KindInstant, Rate: true, StepMs: stepMs})
	if e != nil || pr == nil {
		if e != nil {
			writeReqError(w, e)
		}
		return
	}
	rs, err := q.d.PulsusDB.Query(ctx, pr.rc, pulsusdb.InstantQuery{Query: pr.planned.Query, At: time.UnixMilli(*req.At), Timeout: timeout})
	if err != nil {
		q.failPlanned(w, r, err, pr.planned)
		return
	}
	defer func() { _ = rs.Close() }()
	b := append(make([]byte, 0, 4096), `{"planned":`...)
	b = appendPlanned(b, pr.planned.Wire())
	b = append(b, `,"result_type":`...)
	b = appendString(b, string(rs.Type()))
	b = append(b, `,"at":`...)
	b = strconv.AppendInt(b, *req.At, 10)
	b = append(b, `,"frames":[`...)
	for n := 0; ; n++ {
		s, err := rs.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			q.failPlanned(w, r, err, pr.planned)
			return
		}
		if n > 0 {
			b = append(b, ',')
		}
		b = appendFrame(b, s)
	}
	b = append(b, ']')
	if ts, v, ok := rs.Scalar(); ok {
		b = append(b, `,"scalar":{"timestamp":`...)
		b = strconv.AppendInt(b, ts, 10)
		b = append(b, `,"value":`...)
		b = appendValue(b, v, true)
		b = append(b, '}')
	}
	if ts, v, ok := rs.StringValue(); ok {
		b = append(b, `,"string":{"timestamp":`...)
		b = strconv.AppendInt(b, ts, 10)
		b = append(b, `,"value":`...)
		b = appendString(b, v)
		b = append(b, '}')
	}
	b = append(b, `,"completeness":`...)
	b = appendCompleteness(b, withTypesWarning(rs.Completeness(), pr.typesWarning), -1)
	b = append(b, '}')
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b)
}
