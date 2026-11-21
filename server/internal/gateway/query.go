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
)

// Bounds of the query routes (plan #62 §3.4, A.2); the body limit is maxRequestBody (T06-021).
const (
	maxQueryBytes    = 65536
	maxTimeMs        = 253402300799999
	minTimeoutMs     = 200
	maxTimeoutMs     = 120_000
	defaultTimeoutMs = 30_000
	maxWidthPx       = 10_000
	streamBuffer     = 32 << 10
)

// dataRoutes are the two hand-written PulsusDB query routes (streamed, this file); the
// completion routes (prom.go) and the data-source check (datasource.go) are strict handlers.
type dataRoutes struct{ d Deps }

func (q *dataRoutes) now() time.Time {
	if q.d.Now != nil {
		return q.d.Now()
	}
	return time.Now()
}

// dataRequestCtx is the RequestCtx of every data call: the request's (organisation, actor and
// request ID) with the resolved tenant, the fixed local principal (D12) and the full-tenant scope.
func dataRequestCtx(r *http.Request, t core.TenantCtx) *core.RequestCtx {
	return dataRequestCtxFrom(r.Context(), t)
}

func dataRequestCtxFrom(ctx context.Context, t core.TenantCtx) *core.RequestCtx {
	rc := *rcFrom(ctx)
	rc.Tenant, rc.Principal, rc.Scope, rc.Priority = t, core.LocalPrincipal, core.FullTenantScope(), core.PriorityInteractive
	if rc.RequestID == "" {
		rc.RequestID, _ = ctx.Value(requestIDKey{}).(string)
	}
	return &rc
}

// rangeRequest and instantRequest have pointer fields so a missing field is detected.
type rangeRequest struct {
	Query     *string `json:"query"`
	From      *int64  `json:"from"`
	To        *int64  `json:"to"`
	WidthPx   *int64  `json:"width_px"`
	TimeoutMs *int64  `json:"timeout_ms"`
}

type instantRequest struct {
	Query     *string `json:"query"`
	At        *int64  `json:"at"`
	TimeoutMs *int64  `json:"timeout_ms"`
}

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
		var te *json.UnmarshalTypeError
		if errors.As(err, &te) && te.Field != "" {
			return fieldError("/"+te.Field, "field.type", "wrong type")
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
	if !utf8.Valid(b) { // query is the only string field
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

func checkQuery(q string) *reqError {
	if len(q) < 1 || len(q) > maxQueryBytes {
		return fieldError("/query", "field.range", "query must be 1 to 65536 bytes")
	}
	return nil
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

// fail writes the response of a data-call error. A cancel by the browser writes nothing (the
// access log records 499).
func (q *dataRoutes) fail(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
		return
	}
	writeReqError(w, q.failure(r.Context(), err))
}

// serveRange is POST /api/dash/v1/query/promql/range (plan #62 §4.1): the frames are written as
// the upstream body is decoded, one series at a time.
func (q *dataRoutes) serveRange(w http.ResponseWriter, r *http.Request) {
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
	if e := firstError(checkQuery(*req.Query), rangeIf(from < 0, "/from", "from must be at least 0"),
		rangeIf(to > maxTimeMs, "/to", "to is out of range"), rangeIf(width < 1 || width > maxWidthPx, "/width_px", "width_px must be between 1 and 10000"),
		rangeIf(from >= to, "/to", "to must be after from"), te); e != nil {
		writeReqError(w, e)
		return
	}
	// Reserved selectors are refused before any I/O, tenant resolution included (T07-020 v1).
	if v := pulsusdb.CheckReserved("query", *req.Query); v != nil {
		q.fail(w, r, v)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	tc, e := resolveTenant(ctx, q.d, tenant)
	if e != nil {
		writeReqError(w, e)
		return
	}
	rc := dataRequestCtx(r, tc)
	grid, err := pulsusdb.PromGrid(from, to, int(width))
	if err != nil {
		writeReqError(w, fieldError("/from", "range.too_long", err.Error()))
		return
	}
	if q.d.PulsusDB == nil {
		q.fail(w, r, &pulsusdb.Error{Kind: pulsusdb.KindConfig})
		return
	}
	rs, err := q.d.PulsusDB.QueryRange(ctx, rc, pulsusdb.RangeQuery{Query: *req.Query,
		Start: time.UnixMilli(grid.Start), End: time.UnixMilli(grid.End), Step: time.Duration(grid.Step) * time.Millisecond, Timeout: timeout})
	if err != nil {
		q.fail(w, r, err)
		return
	}
	defer func() { _ = rs.Close() }()
	first, err := rs.Next()
	if err != nil && !errors.Is(err, io.EOF) {
		q.fail(w, r, err)
		return
	}
	q.stream(w, r, rc, rs, grid, first)
}

func rangeIf(bad bool, pointer, msg string) *reqError {
	if bad {
		return fieldError(pointer, "field.range", msg)
	}
	return nil
}

// stream writes the range body from the first frame on (§4.1 steps 8-10). A failure after the
// header was written resets the connection, so the browser never sees a truncated body as valid.
func (q *dataRoutes) stream(w http.ResponseWriter, r *http.Request, rc *core.RequestCtx, rs *pulsusdb.ResultStream, g pulsusdb.Grid, first *pulsusdb.Series) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	bw := bufio.NewWriterSize(w, streamBuffer)
	buf := make([]byte, 0, streamBuffer)
	buf = append(buf, `{"start":`...)
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
				q.abort(r, rc, err)
				return
			}
			buf = append(buf, ',')
			buf = appendFrame(buf, s)
			if !write() {
				return
			}
		}
	}
	c := rs.Completeness()
	age := int64(-1)
	if c.NewestSampleMs >= 0 {
		age = max(0, q.now().UnixMilli()-c.NewestSampleMs)
	}
	buf = append(buf, `],"completeness":`...)
	buf = appendCompleteness(buf, c, age)
	buf = append(buf, '}')
	if write() && bw.Flush() == nil {
		_ = http.NewResponseController(w).Flush()
	}
}

// abort ends a stream that failed after its header: silently if the browser went away, else
// logged and the connection reset (the recoverer re-panics http.ErrAbortHandler).
func (q *dataRoutes) abort(r *http.Request, rc *core.RequestCtx, err error) {
	if r.Context().Err() != nil {
		return
	}
	kind := "internal"
	var pe *pulsusdb.Error
	if errors.As(err, &pe) {
		kind = pe.Kind.String()
	}
	q.d.Logger.WarnContext(r.Context(), "promql_stream_aborted", "tenant", rc.Tenant.Binding.Slug, "kind", kind, "request_id", rc.RequestID)
	panic(http.ErrAbortHandler)
}

// serveInstant is POST /api/dash/v1/query/promql/instant: the body is decoded completely, then
// written in one go.
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
	if e := firstError(checkQuery(*req.Query), rangeIf(*req.At < 0 || *req.At > maxTimeMs, "/at", "at is out of range"), te); e != nil {
		writeReqError(w, e)
		return
	}
	if v := pulsusdb.CheckReserved("query", *req.Query); v != nil {
		q.fail(w, r, v)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()
	tc, e := resolveTenant(ctx, q.d, tenant)
	if e != nil {
		writeReqError(w, e)
		return
	}
	if q.d.PulsusDB == nil {
		q.fail(w, r, &pulsusdb.Error{Kind: pulsusdb.KindConfig})
		return
	}
	rs, err := q.d.PulsusDB.Query(ctx, dataRequestCtx(r, tc), pulsusdb.InstantQuery{Query: *req.Query, At: time.UnixMilli(*req.At), Timeout: timeout})
	if err != nil {
		q.fail(w, r, err)
		return
	}
	defer func() { _ = rs.Close() }()
	b := append(make([]byte, 0, 4096), `{"result_type":`...)
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
			q.fail(w, r, err)
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
	b = appendCompleteness(b, rs.Completeness(), -1)
	b = append(b, '}')
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b)
}
