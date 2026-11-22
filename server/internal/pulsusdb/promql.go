package pulsusdb

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// RangeQuery is a range query (T06-011). Start and End are aligned by the caller (PromGrid).
type RangeQuery struct {
	Query      string        // sent byte for byte (T07-002)
	Start, End time.Time     // ms precision
	Step       time.Duration // whole seconds ≥ 1 s
	Timeout    time.Duration // the request's deadline budget (informational; the ctx deadline governs)
}

// InstantQuery is an instant query.
type InstantQuery struct {
	Query   string
	At      time.Time
	Timeout time.Duration
}

// MatchQuery is an editor-completion query.
type MatchQuery struct {
	Match      []string // repeated match[]; sent in order, byte for byte
	Start, End time.Time
	Limit      int // 1..10000; sent as limit
}

// MetadataQuery is a metadata query.
type MetadataQuery struct {
	Metric string // "" = all
	Limit  int    // 1..10000; sent as limit
}

// ValuesResult is a list of label names or values (≤ MaxValues; more → cut and Truncated).
type ValuesResult struct {
	Values       []string
	Completeness Completeness
}

// SeriesResult is a list of label sets, each sorted (≤ MaxValues).
type SeriesResult struct {
	Series       [][]Label
	Completeness Completeness
}

// MetricMetadata is one metadata entry.
type MetricMetadata struct{ Type, Help, Unit string }

// MetadataResult maps metric names to their metadata (≤ MaxValues metrics).
type MetadataResult struct {
	Metrics      map[string][]MetricMetadata
	Completeness Completeness
}

// RuntimeInfo is the answer of the data-source check (T06-025).
type RuntimeInfo struct {
	RollupLevels []string
	QueryID      string
}

// QueryRange runs a range query and returns a stream of its series on the grid of q. The stream
// is decoded as the caller reads it; the caller must Close it.
func (c *Client) QueryRange(ctx context.Context, rc *core.RequestCtx, q RangeQuery) (*ResultStream, error) {
	start := time.Now()
	cl := call{route: "query_range", method: http.MethodPost, path: "/api/v1/query_range", query: q.Query,
		form: url.Values{"query": {q.Query}, "start": {formatSeconds(q.Start)}, "end": {formatSeconds(q.End)},
			"step": {strconv.FormatInt(int64(q.Step/time.Second), 10)}},
		inputs: []guardInput{{"query", q.Query}}, limit: c.o.Limits.DataBody, retry: true, timeout: true}
	resp, err := c.do(ctx, rc, cl)
	if err != nil {
		c.logCall(ctx, rc, cl.route, start, resp, err)
		return nil, err
	}
	g := Grid{Start: q.Start.UnixMilli(), End: q.End.UnixMilli(), Step: q.Step.Milliseconds()}
	if g.Step <= 0 || g.End < g.Start {
		resp.close()
		err := protocolError()
		c.logCall(ctx, rc, cl.route, start, resp, err)
		return nil, err
	}
	comp := newComp(resp.hdr, c.o.Limits)
	src, err := newSource(resp, comp, c.o.Limits)
	if err == nil {
		err = src.openRange()
	}
	if err != nil {
		err = readError(ctx, err)
		resp.close()
		c.logCall(ctx, rc, cl.route, start, resp, err)
		return nil, err
	}
	c.logCall(ctx, rc, cl.route, start, resp, nil)
	return newRangeStream(ctx, src, resp, c.o.Limits, comp, g), nil
}

// Query runs an instant query. The body is decoded completely before Query returns.
func (c *Client) Query(ctx context.Context, rc *core.RequestCtx, q InstantQuery) (*ResultStream, error) {
	start := time.Now()
	cl := call{route: "query", method: http.MethodPost, path: "/api/v1/query", query: q.Query,
		form:   url.Values{"query": {q.Query}, "time": {formatSeconds(q.At)}},
		inputs: []guardInput{{"query", q.Query}}, limit: c.o.Limits.DataBody, retry: true, timeout: true}
	resp, err := c.do(ctx, rc, cl)
	if err != nil {
		c.logCall(ctx, rc, cl.route, start, resp, err)
		return nil, err
	}
	comp := newComp(resp.hdr, c.o.Limits)
	src, err := newSource(resp, comp, c.o.Limits)
	var res instantResult
	if err == nil {
		res, err = src.readInstant()
	}
	if err != nil {
		err = readError(ctx, err)
		resp.close()
		c.logCall(ctx, rc, cl.route, start, resp, err)
		return nil, err
	}
	rs := newInstantStream(ctx, src, resp, c.o.Limits, comp, res)
	c.logCall(ctx, rc, cl.route, start, resp, nil)
	return rs, nil
}

// matchCall is the call of the completion routes. Times are whole seconds, the start floored and
// the end raised to unit seconds; with a 60 s unit an empty window becomes one minute. These are
// the shapes the reference clients send PulsusDB (labels and values snapped to the minute,
// series to the second).
func (c *Client) matchCall(route, method, path string, q MatchQuery, unit int64) call {
	from := floorDiv(q.Start.UnixMilli(), unit*1000) * unit
	to := -floorDiv(-q.End.UnixMilli(), unit*1000) * unit
	if unit > 1 && to <= from {
		to = from + unit
	}
	form := url.Values{"start": {strconv.FormatInt(from, 10)}, "end": {strconv.FormatInt(to, 10)}, "limit": {strconv.Itoa(q.Limit)}}
	in := make([]guardInput, 0, len(q.Match))
	for i, m := range q.Match {
		form.Add("match[]", m)
		in = append(in, guardInput{"match/" + strconv.Itoa(i), m})
	}
	return call{route: route, method: method, path: path, form: form, inputs: in, limit: c.o.Limits.MetaBody, retry: true,
		cut: c.o.Limits.MaxValues}
}

// Series lists the label sets matching q (len(q.Match) ≥ 1).
func (c *Client) Series(ctx context.Context, rc *core.RequestCtx, q MatchQuery) (*SeriesResult, error) {
	return c.series(ctx, rc, c.matchCall("series", http.MethodPost, "/api/v1/series", q, 1))
}

// series runs a series call: label sets, cut at cl.cut.
func (c *Client) series(ctx context.Context, rc *core.RequestCtx, cl call) (*SeriesResult, error) {
	out := &SeriesResult{Series: [][]Label{}}
	comp, err := c.meta(ctx, rc, cl, c.o.Timeouts.Metadata, func(d *upstreamDecoder, b *compBuilder) error {
		return eachElement(d, func() error {
			ls, err := readLabelBody(d)
			if err != nil {
				return err
			}
			if len(out.Series) >= cl.cut {
				b.c.Truncated = true
				return nil
			}
			out.Series = append(out.Series, ls)
			return nil
		}, tokObjStart)
	})
	if err != nil {
		return nil, err
	}
	out.Completeness = comp
	return out, nil
}

// Labels lists label names. It sends a POST form first and, on a 405 or a 400, the same request
// once as GET: the method order of the reference clients.
func (c *Client) Labels(ctx context.Context, rc *core.RequestCtx, q MatchQuery) (*ValuesResult, error) {
	out, err := c.values(ctx, rc, c.matchCall("labels", http.MethodPost, "/api/v1/labels", q, 60))
	var pe *Error
	if errors.As(err, &pe) && (pe.Status == http.StatusMethodNotAllowed || pe.Status == http.StatusBadRequest) {
		return c.values(ctx, rc, c.matchCall("labels", http.MethodGet, "/api/v1/labels", q, 60))
	}
	return out, err
}

// LabelValues lists the values of label name; a name that is not a legacy label name is sent in
// the U__ form, so the path never holds a percent escape.
func (c *Client) LabelValues(ctx context.Context, rc *core.RequestCtx, name string, q MatchQuery) (*ValuesResult, error) {
	return c.values(ctx, rc, c.matchCall("label_values", http.MethodGet, "/api/v1/label/"+escapeLabelName(name)+"/values", q, 60))
}

func (c *Client) values(ctx context.Context, rc *core.RequestCtx, cl call) (*ValuesResult, error) {
	out := &ValuesResult{Values: []string{}}
	comp, err := c.meta(ctx, rc, cl, c.o.Timeouts.Metadata, func(d *upstreamDecoder, b *compBuilder) error {
		return eachElement(d, func() error {
			if len(out.Values) >= cl.cut {
				b.c.Truncated = true
				return nil
			}
			out.Values = append(out.Values, cutData(d.String()))
			return nil
		}, tokString)
	})
	if err != nil {
		return nil, err
	}
	out.Completeness = comp
	return out, nil
}

// Metadata lists metric metadata.
func (c *Client) Metadata(ctx context.Context, rc *core.RequestCtx, q MetadataQuery) (*MetadataResult, error) {
	form := url.Values{"limit": {strconv.Itoa(q.Limit)}}
	if q.Metric != "" {
		form.Set("metric", q.Metric)
	}
	cl := call{route: "metadata", method: http.MethodGet, path: "/api/v1/metadata", form: form,
		inputs: []guardInput{{"metric", q.Metric}}, limit: c.o.Limits.MetaBody, retry: true}
	out := &MetadataResult{Metrics: map[string][]MetricMetadata{}}
	comp, err := c.meta(ctx, rc, cl, c.o.Timeouts.Metadata, func(d *upstreamDecoder, b *compBuilder) error {
		if k, err := d.Next(); err != nil || k != tokObjStart {
			return orProtocol(err)
		}
		for {
			k, err := d.Next()
			if err != nil {
				return err
			}
			if k == tokObjEnd {
				return nil
			}
			name := cutData(d.String())
			var list []MetricMetadata
			if err := eachElement(d, func() error {
				m, err := readMetricMetadata(d, c.o.Limits.TextBytes)
				list = append(list, m)
				return err
			}, tokObjStart); err != nil {
				return err
			}
			if _, dup := out.Metrics[name]; !dup && len(out.Metrics) >= c.o.Limits.MaxValues {
				b.c.Truncated = true
				continue
			}
			out.Metrics[name] = append(out.Metrics[name], list...)
		}
	})
	if err != nil {
		return nil, err
	}
	out.Completeness = comp
	return out, nil
}

func readMetricMetadata(d *upstreamDecoder, textBytes int) (MetricMetadata, error) {
	var m MetricMetadata
	for {
		k, err := d.Next()
		if err != nil {
			return m, err
		}
		if k == tokObjEnd {
			return m, nil
		}
		key := d.String()
		k, err = d.Next()
		if err != nil {
			return m, err
		}
		if k != tokString {
			if err := d.Skip(); err != nil {
				return m, err
			}
			continue
		}
		switch key {
		case "type":
			m.Type = cutData(d.String())
		case "unit":
			m.Unit = cutData(d.String())
		case "help":
			m.Help = cleanText(d.String(), textBytes)
		}
	}
}

// RuntimeInfo checks the binding: one attempt, the Check timeout.
func (c *Client) RuntimeInfo(ctx context.Context, rc *core.RequestCtx) (*RuntimeInfo, error) {
	cl := call{route: "runtimeinfo", method: http.MethodGet, path: "/api/v1/status/runtimeinfo", limit: c.o.Limits.MetaBody}
	out := &RuntimeInfo{RollupLevels: []string{}}
	comp, err := c.meta(ctx, rc, cl, c.o.Timeouts.Check, func(d *upstreamDecoder, _ *compBuilder) error {
		if k, err := d.Next(); err != nil || k != tokObjStart {
			return orProtocol(err)
		}
		for {
			k, err := d.Next()
			if err != nil {
				return err
			}
			if k == tokObjEnd {
				return nil
			}
			if d.String() != "rollupLevels" {
				if err := skipValue(d); err != nil {
					return err
				}
				continue
			}
			if err := eachElement(d, func() error {
				out.RollupLevels = append(out.RollupLevels, cutData(d.String()))
				return nil
			}, tokString); err != nil {
				return err
			}
		}
	})
	if err != nil {
		return nil, err
	}
	out.QueryID = comp.QueryID
	return out, nil
}

// meta runs a completion or check call under timeout and decodes its body: status, warnings,
// infos and truncated at the top level, data by onData (positioned before the data value).
func (c *Client) meta(ctx context.Context, rc *core.RequestCtx, cl call, timeout time.Duration,
	onData func(*upstreamDecoder, *compBuilder) error) (Completeness, error) {
	start := time.Now()
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	resp, err := c.do(ctx, rc, cl)
	if err != nil {
		c.logCall(ctx, rc, cl.route, start, resp, err)
		return Completeness{}, err
	}
	defer resp.close()
	comp := newComp(resp.hdr, c.o.Limits)
	if resp.format == formatJSON {
		err = decodeTop(newUpstreamDecoder(resp.body, resp.red), comp, onData)
	} else {
		err = protocolError() // completion and check bodies have one decoder
	}
	if err != nil {
		err = readError(ctx, err)
		if pe, ok := err.(*Error); ok {
			pe.Status, pe.QueryID = resp.status, resp.hdr.QueryID
		}
		c.logCall(ctx, rc, cl.route, start, resp, err)
		return Completeness{}, err
	}
	c.logCall(ctx, rc, cl.route, start, resp, nil)
	return comp.finish(), nil
}

func decodeTop(d *upstreamDecoder, comp *compBuilder, onData func(*upstreamDecoder, *compBuilder) error) error {
	if k, err := d.Next(); err != nil || k != tokObjStart {
		return orProtocol(err)
	}
	sawData := false
	for {
		k, err := d.Next()
		if err != nil {
			return err
		}
		if k == tokObjEnd {
			break
		}
		switch key := d.String(); key {
		case "status":
			if k, err := d.Next(); err != nil || k != tokString {
				return orProtocol(err)
			}
			if d.String() != "success" {
				return protocolError()
			}
		case "data":
			if sawData {
				return protocolError()
			}
			sawData = true
			if err := onData(d, comp); err != nil {
				return err
			}
		case "warnings", "infos":
			if err := comp.messages(d, key == "warnings"); err != nil {
				return err
			}
		case "truncated":
			if err := comp.flag(d); err != nil {
				return err
			}
		default:
			if err := skipValue(d); err != nil {
				return err
			}
		}
	}
	if !sawData {
		return protocolError()
	}
	if k, err := d.Next(); err != nil || k != tokEOF {
		return orProtocol(err)
	}
	return nil
}

// eachElement reads an array whose elements must start with kind and calls fn after each
// element's first token.
func eachElement(d *upstreamDecoder, fn func() error, kind tokenKind) error {
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
		if k != kind {
			return protocolError()
		}
		if err := fn(); err != nil {
			return err
		}
	}
}

// escapeLabelName returns name unchanged when it is a legacy label name ([a-zA-Z_][a-zA-Z0-9_]*),
// else its U__ form: "U__", then each rune as itself if it is a legacy rune, "__" for '_', and
// "_<hex code point>_" otherwise ("_FFFD_" for invalid UTF-8).
func escapeLabelName(name string) string {
	legacyRune := func(r rune, i int) bool {
		return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '_' || (i > 0 && r >= '0' && r <= '9')
	}
	legacy := name != ""
	for i, r := range name {
		if !legacyRune(r, i) {
			legacy = false
			break
		}
	}
	if legacy {
		return name
	}
	var b strings.Builder
	b.WriteString("U__")
	for i, r := range name {
		switch {
		case r == '_':
			b.WriteString("__")
		case legacyRune(r, i):
			b.WriteRune(r)
		case r == utf8.RuneError:
			b.WriteString("_FFFD_")
		default:
			b.WriteByte('_')
			b.WriteString(strconv.FormatInt(int64(r), 16))
			b.WriteByte('_')
		}
	}
	return b.String()
}
