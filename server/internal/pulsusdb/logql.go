package pulsusdb

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
)

// Direction is the order of a log page.
type Direction uint8

// The directions: newest first (the default) and oldest first.
const (
	Backward Direction = iota
	Forward
)

// String is the upstream direction value.
func (d Direction) String() string {
	if d == Forward {
		return "forward"
	}
	return "backward"
}

// Level is T04 log_lines/1 level (code 6 is critical).
type Level uint8

// The levels, in their T04 codes.
const (
	LevelUnknown Level = iota
	LevelTrace
	LevelDebug
	LevelInfo
	LevelWarn
	LevelError
	LevelCritical
)

var levelNames = [...]string{"unknown", "trace", "debug", "info", "warn", "error", "critical"}

func (l Level) String() string {
	if int(l) < len(levelNames) {
		return levelNames[l]
	}
	return "unknown"
}

// levelValues is Table 3.2a of #65 (T04 §4.3): the recognised values, lower case.
var levelValues = map[string]Level{
	"critical": LevelCritical, "crit": LevelCritical, "fatal": LevelCritical, "alert": LevelCritical, "emergency": LevelCritical,
	"error": LevelError, "err": LevelError,
	"warn": LevelWarn, "warning": LevelWarn,
	"info": LevelInfo, "informational": LevelInfo, "notice": LevelInfo,
	"debug": LevelDebug,
	"trace": LevelTrace,
}

// LevelOf is the level of a stream: the value of label "detected_level" if Table 3.2a knows it
// (ASCII case-insensitive), else that of "level" if the table knows it, else LevelUnknown. ls is
// sorted by name.
func LevelOf(ls []Label) Level {
	lv, _ := levelIn(ls)
	return lv
}

// levelIn is LevelOf, and whether ls has a recognised level.
func levelIn(ls []Label) (Level, bool) {
	for _, name := range []string{"detected_level", "level"} {
		for _, l := range ls {
			if l.Name != name {
				continue
			}
			if lv, ok := levelValues[strings.ToLower(l.Value)]; ok && isASCII(l.Value) {
				return lv, true
			}
		}
	}
	return LevelUnknown, false
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// maxGridMs is the latest grid end whose ns value fits in int64 (2262-04-11).
const maxGridMs = math.MaxInt64 / 1_000_000

// MaxLogLimit is PulsusDB's maximum limit; also the group-fetch limit.
const MaxLogLimit = 5000

// nsParam writes an upstream ns timestamp as %019d. It is always 19 characters or more, so
// PulsusDB never reads it as seconds (ten characters or fewer are seconds); -1 gives
// "-000000000000000001".
func nsParam(v int64) string { return fmt.Sprintf("%019d", v) }

// stepParam is the step parameter of a log query_range call: whole ms with the unit.
func stepParam(g Grid) string { return strconv.FormatInt(g.Step, 10) + "ms" }

// LogWindow is the log window (LoNs, HiNs]; the caller guarantees 0 ≤ LoNs < HiNs.
type LogWindow struct{ LoNs, HiNs int64 }

// PageCursor continues a page. Every entry of the window beyond TsNs in direction order has been
// delivered, and so have the first Skip entries of the group at TsNs in group order.
type PageCursor struct {
	TsNs int64 // in (LoNs, HiNs]
	Skip int   // 0..MaxLogLimit-1
}

// LogRangeQuery is a log query_range call.
type LogRangeQuery struct {
	Query     string      // sent byte for byte (T07-002)
	Grid      Grid        // PromGrid of the request (ms): first-page bounds, metric placement
	Window    LogWindow   // Grid.Start·10⁶ ≤ LoNs, HiNs ≤ Grid.End·10⁶
	Limit     int         // 1..MaxLogLimit
	Direction Direction   //
	After     *PageCursor // nil: the first page
}

// LogStream is one stream of a page.
type LogStream struct {
	Key    uint64  // keyhash.Labels(Labels)
	Labels []Label // sorted by name; the indexed stream labels of a categorised response
	Level  Level   // LevelOf(Labels); an entry's own level is LogEntry.Level
}

// LogEntry is one entry of a page.
type LogEntry struct {
	TsNs   int64
	Stream int    // index into LogPage.Streams
	Line   string // redacted; cut at Limits.LineBytes
	// Level is EntryLevel(the stream's labels, Metadata, Parsed).
	Level Level
	// Metadata and Parsed are the entry's structured metadata and parsed fields from the
	// categorised response (categorize-labels): sorted by name, redacted, each name and value
	// cut at 4 096 bytes; nil if the entry has none.
	Metadata []Label
	Parsed   []Label
}

// categorizeHeader asks PulsusDB for the categorised streams response: indexed stream labels,
// with structured metadata and parsed fields per entry (owner decision 2026-11-21).
const categorizeHeader, categorizeValue = "X-Loki-Response-Encoding-Flags", "categorize-labels"

// EntryLevel is the level of an entry: that of its stream labels if LevelOf finds one, else that
// of its structured metadata, else that of its parsed fields, else LevelUnknown.
func EntryLevel(stream, metadata, parsed []Label) Level {
	for _, ls := range [][]Label{stream, metadata, parsed} {
		if lv, ok := levelIn(ls); ok {
			return lv
		}
	}
	return LevelUnknown
}

// LogPage is one page of a log query (#65 §4.2).
type LogPage struct {
	Streams      []LogStream  // by Key ascending; only streams with a delivered entry
	Entries      []LogEntry   // in page order, ≤ Limit
	Next         *PageCursor  // nil: no further entry in the window
	Requests     int          // upstream requests made for this page (1..3)
	Completeness Completeness // NewestSampleMs = the newest delivered entry's ts / 1e6 (floor); -1 if none
}

// LogResult holds exactly one of Page (resultType streams) or Series (resultType matrix, on
// q.Grid; the caller must Close it).
type LogResult struct {
	Page   *LogPage
	Series *ResultStream
}

// valid checks what the caller guarantees; a query outside it is refused as KindProtocol
// before any request.
func (q LogRangeQuery) valid() bool {
	g, w := q.Grid, q.Window
	if g.Step <= 0 || g.Start < 0 || g.End < g.Start || g.End > maxGridMs {
		return false
	}
	if q.Limit < 1 || q.Limit > MaxLogLimit || w.LoNs < g.Start*1e6 || w.HiNs > g.End*1e6 || w.LoNs < 0 || w.LoNs >= w.HiNs {
		return false
	}
	a := q.After
	return a == nil || (a.TsNs > w.LoNs && a.TsNs <= w.HiNs && a.Skip >= 0 && a.Skip < MaxLogLimit)
}

// LogQueryRange runs a log query and returns one page, or the metric series of a LogQL metric
// query (recognised by its resultType only). A page takes 1 to 3 upstream requests (§4.2 of
// #65): the first page is sent on the grid, so a metric query anchors on it; log entries are
// those in the window. It returns the page after its last response was read (T06-011 case 1).
func (c *Client) LogQueryRange(ctx context.Context, rc *core.RequestCtx, q LogRangeQuery) (*LogResult, error) {
	if !q.valid() {
		return nil, protocolError()
	}
	p := &pager{c: c, ctx: ctx, rc: rc, q: q, L: min(q.Limit+1, MaxLogLimit)}
	var (
		page *LogPage
		rs   *ResultStream
		err  error
	)
	switch {
	case q.After == nil:
		page, rs, err = p.stepB(true)
	case q.After.Skip > 0:
		page, err = p.stepA(q.After.TsNs, q.After.Skip)
	default:
		page, rs, err = p.stepB(false)
	}
	switch {
	case err != nil:
		return nil, err
	case rs != nil:
		return &LogResult{Series: rs}, nil
	}
	return &LogResult{Page: page}, nil
}

// VolumeQuery is a log volume query.
type VolumeQuery struct {
	// Query is the planned volume text: logs.Plan applied the fixed template around the
	// substituted text (T07-002, plan #116). It is sent byte for byte.
	Query string
	Grid  Grid
}

// LogVolume returns one Series per level with a present point, in the order critical, error,
// warn, info, debug, trace, unknown; Labels = [{level, <name>}], Key = keyhash.Labels(Labels).
// Each grid point t counts the lines of (t − step, t], so the edge points can count lines
// outside the log window. It returns after the whole upstream matrix is read (T06-011 case 3);
// it is not a ResultStream. An error position is an offset into q.Query, unmapped: the gateway
// maps it to the raw text (plan #116 §4.5).
func (c *Client) LogVolume(ctx context.Context, rc *core.RequestCtx, q VolumeQuery) ([]*Series, Completeness, error) {
	g := q.Grid
	if g.Step <= 0 || g.Start < 0 || g.End < g.Start || g.End > maxGridMs {
		return nil, Completeness{}, protocolError()
	}
	cl := call{route: "logs_volume", method: http.MethodGet, path: "/api/logs/v1/query_range", query: q.Query,
		form:   url.Values{"query": {q.Query}, "start": {nsParam(g.Start * 1e6)}, "end": {nsParam(g.End * 1e6)}, "step": {stepParam(g)}},
		inputs: []guardInput{{"query", q.Query}}, limit: c.o.Limits.DataBody, retry: true, timeout: true, postOver: true}
	t0 := time.Now()
	resp, err := c.do(ctx, rc, cl)
	if err != nil {
		c.logCall(ctx, rc, cl.route, t0, resp, err)
		return nil, Completeness{}, err
	}
	rs, _, err := c.openLogs(ctx, resp, logMode{matrix: true}, g)
	if err != nil {
		c.logCall(ctx, rc, cl.route, t0, resp, err)
		return nil, Completeness{}, err
	}
	defer func() { _ = rs.Close() }()
	var acc [LevelCritical + 1]*Series
	for {
		s, err := rs.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			c.logCall(ctx, rc, cl.route, t0, resp, err)
			return nil, Completeness{}, err
		}
		lv := LevelOf(s.Labels)
		for i, ok := range s.Present {
			if !ok {
				continue
			}
			// The accumulator is made at the level's first present point, so a level whose
			// input series have none is omitted.
			a := acc[lv]
			if a == nil {
				ls := []Label{{Name: "level", Value: lv.String()}}
				a = &Series{Key: keyhash.Labels(ls), Labels: ls, Timestamps: s.Timestamps,
					Values: make([]float64, len(s.Values)), Present: make([]bool, len(s.Present))}
				acc[lv] = a
			}
			a.Values[i] += s.Values[i]
			a.Present[i] = true
		}
	}
	out := []*Series{}
	for _, lv := range []Level{LevelCritical, LevelError, LevelWarn, LevelInfo, LevelDebug, LevelTrace, LevelUnknown} {
		if acc[lv] != nil {
			out = append(out, acc[lv])
		}
	}
	c.logCall(ctx, rc, cl.route, t0, resp, nil)
	return out, rs.Completeness(), nil
}

// LogMatchQuery is a log completion query (labels, label values).
type LogMatchQuery struct {
	Query          string // "" = none; sent as query
	StartNs, EndNs int64
	Limit          int // 1..10000; applied by the BFF (PulsusDB ignores it)
}

// LogSeriesQuery is a log series query.
type LogSeriesQuery struct {
	Match          []string // ≥ 1; sent as match[] in order
	StartNs, EndNs int64
	Limit          int // 1..10000; applied by the BFF
}

// cutOf is the cut of a log completion call: its Limit, within MaxValues.
func (c *Client) cutOf(limit int) int {
	if limit < 1 || limit > c.o.Limits.MaxValues {
		return c.o.Limits.MaxValues
	}
	return limit
}

func (c *Client) logMatchCall(route, path string, q LogMatchQuery) call {
	form := url.Values{"start": {nsParam(q.StartNs)}, "end": {nsParam(q.EndNs)}}
	var in []guardInput
	if q.Query != "" {
		form.Set("query", q.Query)
		in = []guardInput{{"query", q.Query}}
	}
	return call{route: route, method: http.MethodGet, path: path, form: form, inputs: in,
		limit: c.o.Limits.MetaBody, retry: true, cut: c.cutOf(q.Limit)}
}

// LogLabels lists the log label names (Metadata timeout).
func (c *Client) LogLabels(ctx context.Context, rc *core.RequestCtx, q LogMatchQuery) (*ValuesResult, error) {
	return c.values(ctx, rc, c.logMatchCall("logs_labels", "/api/logs/v1/labels", q))
}

// LogLabelValues lists the values of log label name (Metadata timeout).
func (c *Client) LogLabelValues(ctx context.Context, rc *core.RequestCtx, name string, q LogMatchQuery) (*ValuesResult, error) {
	return c.values(ctx, rc, c.logMatchCall("logs_label_values", "/api/logs/v1/label/"+url.PathEscape(name)+"/values", q))
}

// LogSeries lists the label sets of the streams matching q (Metadata timeout).
func (c *Client) LogSeries(ctx context.Context, rc *core.RequestCtx, q LogSeriesQuery) (*SeriesResult, error) {
	form := url.Values{"start": {nsParam(q.StartNs)}, "end": {nsParam(q.EndNs)}}
	in := make([]guardInput, 0, len(q.Match))
	for i, m := range q.Match {
		form.Add("match[]", m)
		in = append(in, guardInput{"match/" + strconv.Itoa(i), m})
	}
	return c.series(ctx, rc, call{route: "logs_series", method: http.MethodGet, path: "/api/logs/v1/series", form: form,
		inputs: in, limit: c.o.Limits.MetaBody, retry: true, cut: c.cutOf(q.Limit), postOver: true})
}
