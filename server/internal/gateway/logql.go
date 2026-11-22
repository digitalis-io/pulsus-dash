package gateway

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// The LogQL query routes (plan #65 Part B §4.1): POST /api/dash/v1/query/logql/range and
// …/volume. Every input is validated before any I/O (tenant resolution included), then Part A's
// LogQueryRange or LogVolume runs under the route deadline.

// logCommon, logRangeRequest and logVolumeRequest have pointer fields so a missing field is
// detected; logCommon's fields are promoted, so both bodies are flat JSON objects.
type logCommon struct {
	Query     *string `json:"query"`
	From      *int64  `json:"from"`
	To        *int64  `json:"to"`
	WidthPx   *int64  `json:"width_px"`
	TimeoutMs *int64  `json:"timeout_ms"`
}

type logRangeRequest struct {
	logCommon
	Limit     *int64  `json:"limit"`
	Direction *string `json:"direction"`
	Cursor    *string `json:"cursor"`
}

type logVolumeRequest struct{ logCommon }

const defaultLogLimit = 1000

// logWindow is the validated common part of a range or volume request.
type logWindow struct {
	tenant   string
	query    string
	from, to int64
	grid     pulsusdb.Grid
	timeout  time.Duration
}

// toBeyond is the §3.3 row of a to past maxLogTimeMs (all five routes).
func toBeyond(to int64) *reqError {
	return rangeIf(to > maxLogTimeMs, "/to", "to is beyond the supported time range (at most 9223372036854)")
}

// readLogWindow is steps 1 to 3 of §4.1 for the fields both POST routes share: the body (into
// dst), the required fields, the bounds, the reserved-selector guard and the grid, whose end must
// not pass maxLogTimeMs either. extra checks the route's own fields after the shared bounds.
func (q *dataRoutes) readLogWindow(w http.ResponseWriter, r *http.Request, dst any, c *logCommon, extra func() *reqError) (logWindow, bool) {
	tenant, e := tenantParam(r)
	if e == nil {
		e = readBody(w, r, dst)
	}
	if e == nil {
		e = firstError(required("query", c.Query != nil), required("from", c.From != nil), required("to", c.To != nil), required("width_px", c.WidthPx != nil))
	}
	if e != nil {
		writeReqError(w, e)
		return logWindow{}, false
	}
	lw := logWindow{tenant: tenant, query: *c.Query, from: *c.From, to: *c.To}
	timeout, te := timeoutOf(c.TimeoutMs)
	wpx := *c.WidthPx
	if e := firstError(checkQuery(lw.query), rangeIf(lw.from < 0, "/from", "from must be at least 0"), toBeyond(lw.to),
		rangeIf(wpx < 1 || wpx > maxWidthPx, "/width_px", "width_px must be between 1 and 10000"),
		rangeIf(lw.from >= lw.to, "/to", "to must be after from"), te, extra()); e != nil {
		writeReqError(w, e)
		return logWindow{}, false
	}
	// Reserved selectors are refused before any I/O, tenant resolution included (T07-020 v1).
	if v := pulsusdb.CheckReserved("query", lw.query); v != nil {
		q.fail(w, r, v)
		return logWindow{}, false
	}
	grid, err := pulsusdb.PromGrid(lw.from, lw.to, int(wpx))
	if err != nil {
		writeReqError(w, fieldError("/from", "range.too_long", err.Error()))
		return logWindow{}, false
	}
	if grid.End > maxLogTimeMs {
		writeReqError(w, fieldError("/to", "field.range", "to is too close to the end of the supported time range for this width"))
		return logWindow{}, false
	}
	lw.grid, lw.timeout = grid, timeout
	return lw, true
}

// serveLogsRange is POST /api/dash/v1/query/logql/range (§4.1): a log page written in one go
// after its last upstream response, or a LogQL metric result streamed series by series.
func (q *dataRoutes) serveLogsRange(w http.ResponseWriter, r *http.Request) {
	var req logRangeRequest
	limit, dir := int64(defaultLogLimit), pulsusdb.Backward
	lw, ok := q.readLogWindow(w, r, &req, &req.logCommon, func() *reqError {
		if req.Limit != nil {
			limit = *req.Limit
		}
		var de *reqError
		if req.Direction != nil {
			switch *req.Direction {
			case "backward":
			case "forward":
				dir = pulsusdb.Forward
			default:
				de = fieldError("/direction", "field.range", "direction must be backward or forward")
			}
		}
		var ce *reqError
		if req.Cursor != nil && !cursorPattern.MatchString(*req.Cursor) {
			ce = fieldError("/cursor", "field.range", "cursor must be 48 base64url characters")
		}
		return firstError(rangeIf(limit < 1 || limit > pulsusdb.MaxLogLimit, "/limit", "limit must be between 1 and 5000"), de, ce)
	})
	if !ok {
		return
	}
	var after *pulsusdb.PageCursor
	if req.Cursor != nil {
		var e *reqError
		if after, e = cursorAfter(*req.Cursor, dir, lw.query, lw.from, lw.to); e != nil {
			writeReqError(w, e)
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), lw.timeout)
	defer cancel()
	tc, e := resolveTenant(ctx, q.d, lw.tenant)
	if e != nil {
		writeReqError(w, e)
		return
	}
	if q.d.PulsusDB == nil {
		q.fail(w, r, &pulsusdb.Error{Kind: pulsusdb.KindConfig})
		return
	}
	rc := dataRequestCtx(r, tc)
	res, err := q.d.PulsusDB.LogQueryRange(ctx, rc, pulsusdb.LogRangeQuery{Query: lw.query, Grid: lw.grid,
		Window: pulsusdb.LogWindow{LoNs: lw.from * 1_000_000, HiNs: lw.to * 1_000_000}, Limit: int(limit), Direction: dir, After: after})
	if err != nil {
		q.fail(w, r, err)
		return
	}
	if rs := res.Series; rs != nil {
		defer func() { _ = rs.Close() }()
		first, err := rs.Next()
		if err != nil && !errors.Is(err, io.EOF) {
			q.fail(w, r, err)
			return
		}
		q.stream(w, r, rc, nil, rs, lw.grid, first, "series", "logql_stream_aborted")
		return
	}
	page := res.Page
	cursor := ""
	if page.Next != nil {
		cursor = encodeCursor(logCursor{Dir: dir, QueryHash: keyhash.Text(lw.query), FromMs: lw.from, ToMs: lw.to, At: *page.Next})
	}
	b := appendLogPage(make([]byte, 0, logPageCap(page)), page, lw.from, lw.to, lw.grid.Step, dir, cursor, q.dataAge(page.Completeness))
	q.d.Logger.DebugContext(r.Context(), "logql_page", "tenant", tc.Binding.Slug, "entries", len(page.Entries),
		"streams", len(page.Streams), "upstream_requests", page.Requests, "cursor", cursor != "", "request_id", rc.RequestID)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b)
}

// logPageCap estimates the encoded size of a page, so the body is built in one allocation.
func logPageCap(p *pulsusdb.LogPage) int {
	n := 512 + 160*len(p.Streams)
	for i := range p.Entries {
		n += 64 + len(p.Entries[i].Line)
	}
	return n
}

// serveLogsVolume is POST /api/dash/v1/query/logql/volume: the level frames of LogVolume on the
// grid, written in one go after the whole upstream matrix was read (T06-011 case 3).
func (q *dataRoutes) serveLogsVolume(w http.ResponseWriter, r *http.Request) {
	var req logVolumeRequest
	lw, ok := q.readLogWindow(w, r, &req, &req.logCommon, func() *reqError { return nil })
	if !ok {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), lw.timeout)
	defer cancel()
	tc, e := resolveTenant(ctx, q.d, lw.tenant)
	if e != nil {
		writeReqError(w, e)
		return
	}
	if q.d.PulsusDB == nil {
		q.fail(w, r, &pulsusdb.Error{Kind: pulsusdb.KindConfig})
		return
	}
	series, c, err := q.d.PulsusDB.LogVolume(ctx, dataRequestCtx(r, tc), pulsusdb.VolumeQuery{Query: lw.query, Grid: lw.grid})
	if err != nil {
		q.fail(w, r, err)
		return
	}
	g := lw.grid
	b := append(make([]byte, 0, 4096), `{"start":`...)
	b = strconv.AppendInt(b, g.Start, 10)
	b = append(b, `,"end":`...)
	b = strconv.AppendInt(b, g.End, 10)
	b = append(b, `,"step":`...)
	b = strconv.AppendInt(b, g.Step, 10)
	b = append(b, `,"frames":[`...)
	for i, s := range series {
		if i > 0 {
			b = append(b, ',')
		}
		b = appendFrame(b, s)
	}
	b = append(b, `],"completeness":`...)
	b = appendCompleteness(b, c, q.dataAge(c))
	b = append(b, '}')
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(b)
}

// maxLogQueryBytes bounds a LogQL query text; the LogQL routes send it unplanned (T06-029 covers
// LogQL once logs.Plan lands, #116).
const maxLogQueryBytes = 65536

// checkQuery checks the size of a LogQL query text.
func checkQuery(q string) *reqError {
	if len(q) < 1 || len(q) > maxLogQueryBytes {
		return fieldError("/query", "field.range", "query must be 1 to 65536 bytes")
	}
	return nil
}

// dataRequestCtx is the request context of a data call for the resolved tenant.
func dataRequestCtx(r *http.Request, t core.TenantCtx) *core.RequestCtx {
	return dataRequestCtxFrom(r.Context(), t)
}

// fail writes the response of a data-call error on an unplanned route. A cancel by the browser
// writes nothing (the access log records 499).
func (q *dataRoutes) fail(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, context.Canceled) && r.Context().Err() != nil {
		return
	}
	writeReqError(w, q.failure(r.Context(), err))
}
