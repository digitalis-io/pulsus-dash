package gateway

import (
	"bufio"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/digitalis-io/pulsus-dash/server/internal/apierr"
	"github.com/digitalis-io/pulsus-dash/server/internal/arrowwire"
	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	promplan "github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/prom"
)

// Test seams of the range route's DSF tests (arrow_test.go): the writer's limits and the read of
// the next upstream series. Production code never changes them.
var (
	arrowLimits = arrowwire.DefaultLimits
	nextSeries  = (*pulsusdb.ResultStream).Next
)

// dsfMediaType is arrowwire.ContentType without its parameters.
const dsfMediaType = "application/vnd.pulsus.dash-stream"

// wantsArrow reports whether the request's Accept lists the DSF media type (case-insensitive)
// with q > 0 and v=1 or no v (plan #68 D1 §3.1). Anything else, */* included, is JSON.
func wantsArrow(r *http.Request) bool {
	for _, line := range r.Header.Values("Accept") {
		for _, rng := range strings.Split(line, ",") {
			params := strings.Split(rng, ";")
			if !strings.EqualFold(strings.TrimSpace(params[0]), dsfMediaType) {
				continue
			}
			q, v, ok := 1.0, "1", true
			for _, p := range params[1:] {
				k, val, _ := strings.Cut(p, "=")
				val = strings.Trim(strings.TrimSpace(val), `"`)
				switch strings.ToLower(strings.TrimSpace(k)) {
				case "q":
					f, err := strconv.ParseFloat(val, 64)
					q, ok = f, ok && err == nil
				case "v":
					v = val
				}
			}
			if ok && q > 0 && v == "1" {
				return true
			}
		}
	}
	return false
}

// outcome is what the handler does after a writer call (§3.3).
type outcome uint8

const (
	goOn      outcome = iota
	closeBody         // stop reading upstream; END, then flush
	abandon           // stop; nothing more is written
)

// arrowStream is one DSF response body: the writer over one bufio.Writer over the response.
type arrowStream struct {
	q    *dataRoutes
	r    *http.Request
	rc   *core.RequestCtx
	bw   *bufio.Writer
	resp *http.ResponseController
	aw   *arrowwire.Writer
}

// flush sends what the writer committed: the bufio.Writer, then the response; the first error.
func (s *arrowStream) flush() error {
	if err := s.bw.Flush(); err != nil {
		return err
	}
	return s.resp.Flush()
}

// flushed runs flush; a failure is the sticky I/O outcome (logged unless the client went away).
func (s *arrowStream) flushed() bool {
	if err := s.flush(); err != nil {
		s.writeFailed(err)
		return false
	}
	return true
}

func (s *arrowStream) writeFailed(err error) {
	if s.r.Context().Err() != nil {
		return
	}
	s.q.d.Logger.WarnContext(s.r.Context(), "promql_stream_write_failed", "tenant", s.rc.Tenant.Binding.Slug, "error", err.Error(),
		"request_id", s.rc.RequestID)
}

// outcome maps a writer call's result (§3.3), checking the sticky I/O error first.
func (s *arrowStream) outcome(err error) outcome {
	if werr := s.aw.Err(); werr != nil {
		s.writeFailed(werr)
		return abandon
	}
	if s.r.Context().Err() != nil {
		return abandon
	}
	ctx, log := s.r.Context(), s.q.d.Logger
	switch {
	case err == nil:
		return goOn
	case errors.Is(err, arrowwire.ErrLimit):
		// The part (or the stream) closed in band with its wire_limit or wire_budget coverage.
	case errors.Is(err, arrowwire.ErrShape), errors.Is(err, arrowwire.ErrFrameTooLarge):
		log.WarnContext(ctx, "promql_stream_refused", "tenant", s.rc.Tenant.Binding.Slug, "error", err.Error(), "request_id", s.rc.RequestID)
	default: // ErrOrder: a bug
		log.ErrorContext(ctx, "promql_stream_order", "tenant", s.rc.Tenant.Binding.Slug, "error", err.Error(), "request_id", s.rc.RequestID)
	}
	return closeBody
}

// end ends the body for o: END and a flush for closeBody, nothing for abandon.
func (s *arrowStream) end(o outcome) {
	if o == abandon {
		return
	}
	if s.outcome(s.aw.End()) == abandon {
		return
	}
	s.flushed()
}

// streamArrow is serveRange's DSF branch (plan #68 D1 §3.2). rc is the request's RequestCtx;
// planned is the plan, whose source map maps a mid-stream position, and h.planned its wire bytes;
// from is the request's from. Every step before it (tenant, body, grid, plan, upstream call, first
// read) is the JSON route's, so the upstream request is the same for both formats. A failure after
// the header is written in band (error/1 and a partial coverage), never by a reset.
func (q *dataRoutes) streamArrow(w http.ResponseWriter, r *http.Request, rc *core.RequestCtx, h streamHead,
	planned promplan.Planned, rs *pulsusdb.ResultStream, g pulsusdb.Grid, from int64, first *pulsusdb.Series) {
	w.Header().Set("Content-Type", arrowwire.ContentType)
	w.WriteHeader(http.StatusOK)
	bw := bufio.NewWriterSize(w, streamBuffer)
	s := &arrowStream{q: q, r: r, rc: rc, bw: bw, resp: http.NewResponseController(w), aw: arrowwire.NewWriterLimits(bw, arrowLimits())}
	spec := arrowwire.GridSpec{LabelsPart: 1, DataPart: 2, Grid: g, Result: "metric", Source: "pulsusdb", RequestedStartMs: from, Planned: h.planned}
	part, err := s.aw.Grid(spec, arrowwire.CoverageFrom(withTypesWarning(rs.Completeness(), h.typesWarning), arrowwire.PhasePlanned, 0))
	if o := s.outcome(err); o != goOn {
		s.end(o)
		return
	}
	if first != nil {
		err := part.Add(first)
		if err == nil {
			err = part.Flush() // the first paint (T04-006)
		}
		if o := s.outcome(err); o != goOn {
			s.end(o)
			return
		}
		if !s.flushed() {
			return
		}
		for {
			ser, err := nextSeries(rs)
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				s.fail(part, err, rs, h, planned)
				return
			}
			if o := s.outcome(part.Add(ser)); o != goOn {
				s.end(o)
				return
			}
			if !s.flushed() {
				return
			}
		}
	}
	c := withTypesWarning(rs.Completeness(), h.typesWarning)
	if o := s.outcome(part.Finish(arrowwire.CoverageFrom(c, arrowwire.PhaseFinal, 0))); o != goOn {
		s.end(o)
		return
	}
	s.end(closeBody)
}

// fail closes the part for an upstream error after the header (§3.2 step 5): the completeness so
// far, the position mapped to the raw text, the class's error/1 row; nothing if the client went
// away.
func (s *arrowStream) fail(part *arrowwire.GridPart, err error, rs *pulsusdb.ResultStream, h streamHead, planned promplan.Planned) {
	if s.r.Context().Err() != nil {
		return
	}
	c := withTypesWarning(rs.Completeness(), h.typesWarning)
	cls := apierr.Classify(mapPosition(err, planned))
	kind := "internal"
	var pe *pulsusdb.Error
	if errors.As(err, &pe) {
		kind = pe.Kind.String()
	}
	s.q.d.Logger.WarnContext(s.r.Context(), "promql_stream_failed", "tenant", s.rc.Tenant.Binding.Slug, "kind", kind, "request_id", s.rc.RequestID)
	if s.outcome(part.Fail(arrowwire.CoverageFrom(c, arrowwire.PhasePartial, 0), arrowwire.ErrorFrom(cls))) == abandon {
		return
	}
	s.end(closeBody)
}
