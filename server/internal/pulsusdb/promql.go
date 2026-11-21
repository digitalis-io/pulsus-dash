package pulsusdb

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"time"

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
	rs := c.newStream(ctx, resp)
	rs.stream, rs.grid, rs.typ = true, g, ResultMatrix
	rs.ts = make([]int64, g.points())
	for i := range rs.ts {
		rs.ts[i] = g.Start + int64(i)*g.Step
	}
	at, err := rs.walk()
	if err == nil && !at {
		err = rs.endCheck()
		if err == nil {
			err = protocolError() // a matrix document without a result array
		}
	}
	if err != nil {
		err = readError(ctx, err)
		resp.close()
		c.logCall(ctx, rc, cl.route, start, resp, err)
		return nil, err
	}
	c.logCall(ctx, rc, cl.route, start, resp, nil)
	return rs, nil
}

func (c *Client) newStream(ctx context.Context, resp *response) *ResultStream {
	return &ResultStream{ctx: ctx, dec: newUpstreamDecoder(resp.body, resp.red), resp: resp, lim: c.o.Limits,
		comp: newComp(resp.hdr, c.o.Limits)}
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
	rs := c.newStream(ctx, resp)
	_, err = rs.walk()
	switch {
	case errors.Is(err, errPointsCut):
		rs.comp.pointsCut = true
		rs.typ = rs.seenType
		if rs.typ != ResultMatrix {
			rs.typ = ResultVector
		}
		err = nil
	case err == nil:
		err = rs.endCheck()
	}
	if err != nil {
		err = readError(ctx, err)
		resp.close()
		c.logCall(ctx, rc, cl.route, start, resp, err)
		return nil, err
	}
	rs.finish()
	c.logCall(ctx, rc, cl.route, start, resp, nil)
	return rs, nil
}

// matchCall is the call of the completion routes.
func (c *Client) matchCall(route, method, path string, q MatchQuery) call {
	form := url.Values{"start": {formatSeconds(q.Start)}, "end": {formatSeconds(q.End)}, "limit": {strconv.Itoa(q.Limit)}}
	in := make([]guardInput, 0, len(q.Match))
	for i, m := range q.Match {
		form.Add("match[]", m)
		in = append(in, guardInput{"match/" + strconv.Itoa(i), m})
	}
	return call{route: route, method: method, path: path, form: form, inputs: in, limit: c.o.Limits.MetaBody, retry: true}
}

// Series lists the label sets matching q (len(q.Match) ≥ 1).
func (c *Client) Series(ctx context.Context, rc *core.RequestCtx, q MatchQuery) (*SeriesResult, error) {
	out := &SeriesResult{Series: [][]Label{}}
	cl := c.matchCall("series", http.MethodPost, "/api/v1/series", q)
	comp, err := c.meta(ctx, rc, cl, c.o.Timeouts.Metadata, func(d *upstreamDecoder, b *compBuilder) error {
		return eachElement(d, func() error {
			ls, err := readLabelBody(d)
			if err != nil {
				return err
			}
			if len(out.Series) >= c.o.Limits.MaxValues {
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

// Labels lists label names.
func (c *Client) Labels(ctx context.Context, rc *core.RequestCtx, q MatchQuery) (*ValuesResult, error) {
	return c.values(ctx, rc, c.matchCall("labels", http.MethodGet, "/api/v1/labels", q))
}

// LabelValues lists the values of label name.
func (c *Client) LabelValues(ctx context.Context, rc *core.RequestCtx, name string, q MatchQuery) (*ValuesResult, error) {
	return c.values(ctx, rc, c.matchCall("label_values", http.MethodGet, "/api/v1/label/"+url.PathEscape(name)+"/values", q))
}

func (c *Client) values(ctx context.Context, rc *core.RequestCtx, cl call) (*ValuesResult, error) {
	out := &ValuesResult{Values: []string{}}
	comp, err := c.meta(ctx, rc, cl, c.o.Timeouts.Metadata, func(d *upstreamDecoder, b *compBuilder) error {
		return eachElement(d, func() error {
			if len(out.Values) >= c.o.Limits.MaxValues {
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
	err = decodeTop(newUpstreamDecoder(resp.body, resp.red), comp, onData)
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

// escapeLabelName is name in the U__ form when it is not a legacy label name.
func escapeLabelName(name string) string { return name }
