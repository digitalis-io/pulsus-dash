package pulsusdb

import (
	"cmp"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
)

// logResponse is one decoded log response (resultType streams): the input of the pager. It holds
// no decoder state, so a second body format can produce it without touching the paging logic.
type logResponse struct {
	streams []decodedStream
	entries []decodedEntry
	comp    Completeness
}

type decodedStream struct {
	key    uint64
	labels []Label // sorted by name; redacted and cut
}

type decodedEntry struct {
	ts     int64
	stream int     // index into logResponse.streams
	line   string  // redacted; cut at Limits.LineBytes
	cut    bool    // the line was cut
	meta   []Label // structured metadata (categorised shape); nil if none
	parsed []Label // parsed fields (categorised shape); nil if none
}

// errPageTooLarge is the refusal of a log response over Limits.PageBytes (#65 §4.3).
func errPageTooLarge() *Error {
	return &Error{Kind: KindTooBroad, Message: "the log page is larger than 64 MiB; lower the limit or narrow the query"}
}

// streamsResult reads the elements of a streams result array whose '[' was read (#65 §4.3):
// objects with stream and values in any order; values of [ts, line] or [ts, line, <any>], where
// an object third element is the categorised entry (readCategorised). Stream objects with equal
// label sets are merged.
func streamsResult(d *upstreamDecoder, lim Limits) (*logResponse, error) {
	lr := &logResponse{}
	index := map[uint64]int{}
	var bytes int64
	for {
		k, err := d.Next()
		if err != nil {
			return nil, err
		}
		if k == tokArrEnd {
			return lr, nil
		}
		if k != tokObjStart {
			return nil, protocolError()
		}
		var (
			labels     []Label
			gotStream  bool
			gotValues  bool
			firstEntry = len(lr.entries)
		)
		for {
			k, err := d.Next()
			if err != nil {
				return nil, err
			}
			if k == tokObjEnd {
				break
			}
			switch d.String() {
			case "stream":
				if gotStream {
					return nil, protocolError()
				}
				if labels, err = readLabels(d); err != nil {
					return nil, err
				}
				gotStream = true
				for _, l := range labels {
					bytes += int64(len(l.Name) + len(l.Value))
				}
			case "values":
				if gotValues {
					return nil, protocolError()
				}
				gotValues = true
				if err := readLogValues(d, lim, lr, &bytes); err != nil {
					return nil, err
				}
			default:
				if err := skipValue(d); err != nil {
					return nil, err
				}
			}
			if bytes > lim.PageBytes {
				return nil, errPageTooLarge()
			}
		}
		if !gotStream || !gotValues {
			return nil, protocolError()
		}
		key := keyhash.Labels(labels)
		si, ok := index[key]
		if !ok {
			si = len(lr.streams)
			index[key] = si
			lr.streams = append(lr.streams, decodedStream{key: key, labels: labels})
		}
		for i := firstEntry; i < len(lr.entries); i++ {
			lr.entries[i].stream = si
		}
	}
}

// readLogValues reads a values array of [ts, line] pairs with an optional third element: an
// object is read by readCategorised, any other value is skipped.
func readLogValues(d *upstreamDecoder, lim Limits, lr *logResponse, bytes *int64) error {
	if k, err := d.Next(); err != nil || k != tokArrStart {
		return orProtocol(err)
	}
	for {
		k, err := d.Next()
		if err != nil {
			return err
		}
		if k == tokArrEnd {
			return nil
		}
		if k != tokArrStart {
			return protocolError()
		}
		if k, err := d.Next(); err != nil || k != tokString {
			return orProtocol(err)
		}
		ts, err := d.Nanos()
		if err != nil {
			return err
		}
		if k, err := d.Next(); err != nil || k != tokString {
			return orProtocol(err)
		}
		e := decodedEntry{ts: ts, line: d.String()}
		if len(e.line) > lim.LineBytes {
			e.line, e.cut = cutUTF8(e.line, lim.LineBytes)+"…", true
		}
		if k, err = d.Next(); err != nil {
			return err
		}
		if k != tokArrEnd {
			if k == tokObjStart {
				err = readCategorised(d, &e, bytes)
			} else {
				err = d.Skip()
			}
			if err != nil {
				return err
			}
			if k, err := d.Next(); err != nil || k != tokArrEnd {
				return orProtocol(err)
			}
		}
		if len(lr.entries) >= lim.MaxEntries {
			return protocolError()
		}
		*bytes += int64(len(e.line))
		if *bytes > lim.PageBytes {
			return errPageTooLarge()
		}
		lr.entries = append(lr.entries, e)
	}
}

// readCategorised reads the members of a categorised entry object whose '{' was read:
// structuredMetadata and parsed are string maps (redacted and cut like labels, counted towards
// PageBytes); any other member is skipped.
func readCategorised(d *upstreamDecoder, e *decodedEntry, bytes *int64) error {
	var gotMeta, gotParsed bool
	for {
		k, err := d.Next()
		if err != nil {
			return err
		}
		if k == tokObjEnd {
			return nil
		}
		var (
			dst  *[]Label
			seen *bool
		)
		switch d.String() {
		case "structuredMetadata":
			dst, seen = &e.meta, &gotMeta
		case "parsed":
			dst, seen = &e.parsed, &gotParsed
		default:
			if err := skipValue(d); err != nil {
				return err
			}
			continue
		}
		if *seen {
			return protocolError() // a repeated member
		}
		*seen = true
		ls, err := readLabels(d)
		if err != nil {
			return err
		}
		for _, l := range ls {
			*bytes += int64(len(l.Name) + len(l.Value))
		}
		if len(ls) > 0 {
			*dst = ls
		}
	}
}

// openLogs reads a 200 log query_range response through the decoder its Content-Type selects
// (#65 §4.1). It returns either a decoded streams result (the body read and closed, the slot
// freed) or a matrix stream on g: streaming when resultType came first, else read from the
// capture with the body already closed.
func (c *Client) openLogs(ctx context.Context, resp *response, mode logMode, g Grid) (*ResultStream, *logResponse, error) {
	comp := newComp(resp.hdr, c.o.Limits)
	src, err := newSource(resp, comp, c.o.Limits)
	var o logOpen
	if err == nil {
		ls, ok := src.(logSource)
		if !ok {
			err = protocolError() // a body format without a log decoder
		} else {
			o, err = ls.openLogs(mode)
		}
	}
	if err != nil {
		resp.close()
		return nil, nil, readError(ctx, err)
	}
	if o.matrix {
		rs := newRangeStream(ctx, src, resp, c.o.Limits, comp, g)
		if o.ended {
			resp.close() // the body has ended: free the slot before any series is handed out
		}
		return rs, nil, nil
	}
	resp.close()
	o.logs.comp = comp.finish()
	return nil, o.logs, nil
}

// pageEntry is a delivered entry with its stream.
type pageEntry struct {
	ts     int64
	key    uint64
	labels []Label
	line   string
	cut    bool
	meta   []Label
	parsed []Label
}

func flatten(lr *logResponse) []pageEntry {
	out := make([]pageEntry, len(lr.entries))
	for i, e := range lr.entries {
		s := lr.streams[e.stream]
		out[i] = pageEntry{ts: e.ts, key: s.key, labels: s.labels, line: e.line, cut: e.cut, meta: e.meta, parsed: e.parsed}
	}
	return out
}

// groupCompare is the group order: stream key ascending, then line bytes ascending, then
// structured metadata, then parsed fields (each as its sorted (name, value) list).
func groupCompare(a, b pageEntry) int {
	if c := cmp.Compare(a.key, b.key); c != 0 {
		return c
	}
	if c := strings.Compare(a.line, b.line); c != 0 {
		return c
	}
	if c := slices.CompareFunc(a.meta, b.meta, labelCompare); c != 0 {
		return c
	}
	return slices.CompareFunc(a.parsed, b.parsed, labelCompare)
}

func labelCompare(a, b Label) int {
	if c := strings.Compare(a.Name, b.Name); c != 0 {
		return c
	}
	return strings.Compare(a.Value, b.Value)
}

// pager builds one page of a log query (#65 §4.2). Every request goes through Client.do with
// the caller's ctx and rc; no further request starts once ctx is done.
type pager struct {
	c     *Client
	ctx   context.Context
	rc    *core.RequestCtx
	q     LogRangeQuery
	L     int // the main fetch's limit
	n     int // upstream requests made
	comps []Completeness
}

// fetch sends one log query_range request on (start, end] and checks its entries: each within
// the bounds, at most limit of them. It returns a decoded response, or a metric stream (only
// when matrix is allowed).
func (p *pager) fetch(start, end int64, limit int, matrix bool) (*logResponse, *ResultStream, error) {
	c, ctx := p.c, p.ctx
	if p.n > 0 && ctx.Err() != nil {
		return nil, nil, readError(ctx, ctx.Err())
	}
	p.n++
	q := p.q
	cl := call{route: "logs_query_range", method: http.MethodGet, path: "/api/logs/v1/query_range", query: q.Query,
		form: url.Values{"query": {q.Query}, "start": {nsParam(start)}, "end": {nsParam(end)},
			"step": {stepParam(q.Grid)}, "limit": {strconv.Itoa(limit)}, "direction": {q.Direction.String()}},
		inputs: []guardInput{{"query", q.Query}}, limit: c.o.Limits.DataBody, retry: true, timeout: true, postOver: true,
		categorize: true}
	t0 := time.Now()
	resp, err := c.do(ctx, p.rc, cl)
	if err != nil {
		c.logCall(ctx, p.rc, cl.route, t0, resp, err, "page_request", p.n)
		return nil, nil, err
	}
	rs, lr, err := c.openLogs(ctx, resp, logMode{streams: true, matrix: matrix}, q.Grid)
	if err == nil && lr != nil {
		if len(lr.entries) > limit {
			err = protocolError()
		}
		for _, e := range lr.entries {
			if e.ts <= start || e.ts > end {
				err = protocolError()
				break
			}
		}
	}
	if pe, ok := err.(*Error); ok && pe.Status == 0 {
		pe.Status, pe.QueryID = resp.status, resp.hdr.QueryID
	}
	c.logCall(ctx, p.rc, cl.route, t0, resp, err, "page_request", p.n)
	if err != nil {
		return nil, nil, err
	}
	if lr != nil {
		p.comps = append(p.comps, lr.comp)
	}
	return lr, rs, nil
}

// stepB is the main fetch of a first page (first) or of a page after {T, 0}.
func (p *pager) stepB(first bool) (*LogPage, *ResultStream, error) {
	q, lo, hi := p.q, p.q.Window.LoNs, p.q.Window.HiNs
	var start, end int64
	switch {
	case first:
		start, end = q.Grid.Start*1e6, q.Grid.End*1e6
	case q.Direction == Backward:
		start, end = lo, q.After.TsNs
	default:
		start, end = q.After.TsNs-1, hi
	}
	lr, rs, err := p.fetch(start, end, p.L, first)
	if err != nil || rs != nil {
		return nil, rs, err
	}
	for reissued := false; ; reissued = true {
		all := flatten(lr)
		limited := len(all) == p.L
		var edge int64
		for i, e := range all {
			if i == 0 || (q.Direction == Backward && e.ts < edge) || (q.Direction == Forward && e.ts > edge) {
				edge = e.ts
			}
		}
		inW := lo < edge && edge <= hi
		far := (q.Direction == Backward && edge <= lo) || (q.Direction == Forward && edge > hi)
		var d []pageEntry
		for _, e := range all {
			if (!limited || e.ts != edge) && lo < e.ts && e.ts <= hi {
				d = append(d, e)
			}
		}
		switch {
		case len(d) > 0: // B1
			var next *PageCursor
			if limited && !far {
				next = &PageCursor{TsNs: edge}
			}
			return p.page(d, next), nil, nil
		case limited && inW: // B2
			page, err := p.stepA(edge, 0)
			return page, nil, err
		case limited && !far && !reissued: // B3: the edge lies before the window on a first page
			if lr, _, err = p.fetch(lo, hi, p.L, false); err != nil {
				return nil, nil, err
			}
			continue
		}
		return p.page(nil, nil), nil, nil // B4
	}
}

// stepA delivers the group at P from offset skip, by a group fetch on (P−1, P].
func (p *pager) stepA(P int64, skip int) (*LogPage, error) {
	lr, _, err := p.fetch(P-1, P, MaxLogLimit, false)
	if err != nil {
		return nil, err
	}
	g := flatten(lr)
	for _, e := range g {
		if e.ts != P {
			return nil, protocolError()
		}
	}
	slices.SortFunc(g, groupCompare)
	if skip >= len(g) { // the group shrank: the data changed
		return p.page(nil, p.past(P)), nil
	}
	page := g[skip:min(skip+p.q.Limit, len(g))]
	next := p.past(P)
	if s := skip + len(page); s < len(g) {
		next = &PageCursor{TsNs: P, Skip: s}
	}
	return p.page(page, next), nil
}

// past is the cursor just beyond P in direction order, or nil at the end of the window.
func (p *pager) past(P int64) *PageCursor {
	w := p.q.Window
	switch {
	case p.q.Direction == Backward && P-1 > w.LoNs:
		return &PageCursor{TsNs: P - 1}
	case p.q.Direction == Forward && P < w.HiNs:
		return &PageCursor{TsNs: P + 1}
	}
	return nil
}

// page builds a page of es (put in page order) with its streams and merged completeness.
func (p *pager) page(es []pageEntry, next *PageCursor) *LogPage {
	dir := p.q.Direction
	slices.SortStableFunc(es, func(a, b pageEntry) int {
		if a.ts != b.ts {
			if dir == Backward {
				return cmp.Compare(b.ts, a.ts)
			}
			return cmp.Compare(a.ts, b.ts)
		}
		return groupCompare(a, b)
	})
	out := &LogPage{Streams: []LogStream{}, Entries: make([]LogEntry, 0, len(es)), Next: next, Requests: p.n}
	var keys []uint64
	labels := map[uint64][]Label{}
	newest, cut := int64(-1), 0
	for _, e := range es {
		if _, ok := labels[e.key]; !ok {
			keys = append(keys, e.key)
			labels[e.key] = e.labels
		}
		newest = max(newest, e.ts)
		if e.cut {
			cut++
		}
	}
	slices.Sort(keys)
	index := make(map[uint64]int, len(keys))
	for i, k := range keys {
		index[k] = i
		out.Streams = append(out.Streams, LogStream{Key: k, Labels: labels[k], Level: LevelOf(labels[k])})
	}
	for _, e := range es {
		out.Entries = append(out.Entries, LogEntry{TsNs: e.ts, Stream: index[e.key], Line: e.line,
			Level: EntryLevel(e.labels, e.meta, e.parsed), Metadata: e.meta, Parsed: e.parsed})
	}
	out.Completeness = mergeComp(p.comps)
	if newest >= 0 {
		out.Completeness.NewestSampleMs = newest / 1e6
	}
	if cut > 0 {
		out.Completeness.Truncated = true
		out.Completeness.Warnings = append(out.Completeness.Warnings,
			fmt.Sprintf("pulsus-dash: %d lines cut at %d bytes", cut, p.c.o.Limits.LineBytes))
	}
	return out
}

// mergeComp merges the completeness of a page's responses: truncated if any is; warnings and
// infos in order, each text once; the headers of the first response that has them.
func mergeComp(cs []Completeness) Completeness {
	out := Completeness{Warnings: []string{}, Infos: []string{}, ReadCacheThroughMs: -1, NewestSampleMs: -1}
	for _, c := range cs {
		out.Truncated = out.Truncated || c.Truncated
		for _, w := range c.Warnings {
			if !slices.Contains(out.Warnings, w) {
				out.Warnings = append(out.Warnings, w)
			}
		}
		for _, i := range c.Infos {
			if !slices.Contains(out.Infos, i) {
				out.Infos = append(out.Infos, i)
			}
		}
		if out.QueryID == "" {
			out.QueryID = c.QueryID
		}
		if out.ReadCache == "" {
			out.ReadCache = c.ReadCache
		}
		if out.ReadCacheThroughMs < 0 {
			out.ReadCacheThroughMs = c.ReadCacheThroughMs
		}
	}
	return out
}
