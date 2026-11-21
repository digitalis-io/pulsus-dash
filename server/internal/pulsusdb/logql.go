package pulsusdb

import (
	"context"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// Direction is the order of a log page.
type Direction uint8

// The directions.
const (
	Backward Direction = iota
	Forward
)

func (d Direction) String() string { return "" }

// Level is T04 log_lines/1 level.
type Level uint8

// The levels.
const (
	LevelUnknown Level = iota
	LevelTrace
	LevelDebug
	LevelInfo
	LevelWarn
	LevelError
	LevelCritical
)

func (l Level) String() string { return "" }

// LevelOf is the level of a stream.
func LevelOf(ls []Label) Level { return LevelUnknown }

// MaxLogLimit is PulsusDB's maximum limit.
const MaxLogLimit = 5000

func nsParam(v int64) string { return "" }

// LogWindow is the log window (LoNs, HiNs].
type LogWindow struct{ LoNs, HiNs int64 }

// PageCursor continues a page.
type PageCursor struct {
	TsNs int64
	Skip int
}

// LogRangeQuery is a log query.
type LogRangeQuery struct {
	Query     string
	Grid      Grid
	Window    LogWindow
	Limit     int
	Direction Direction
	After     *PageCursor
}

// LogStream is one stream of a page.
type LogStream struct {
	Key    uint64
	Labels []Label
	Level  Level
}

// LogEntry is one entry of a page.
type LogEntry struct {
	TsNs   int64
	Stream int
	Line   string
}

// LogPage is one page of a log query.
type LogPage struct {
	Streams      []LogStream
	Entries      []LogEntry
	Next         *PageCursor
	Requests     int
	Completeness Completeness
}

// LogResult holds a page or a series stream.
type LogResult struct {
	Page   *LogPage
	Series *ResultStream
}

// LogQueryRange runs a log query.
func (c *Client) LogQueryRange(ctx context.Context, rc *core.RequestCtx, q LogRangeQuery) (*LogResult, error) {
	return nil, protocolError()
}

// VolumeQuery is a volume query.
type VolumeQuery struct {
	Query string
	Grid  Grid
}

// LogVolume returns the volume per level.
func (c *Client) LogVolume(ctx context.Context, rc *core.RequestCtx, q VolumeQuery) ([]*Series, Completeness, error) {
	return nil, Completeness{}, protocolError()
}

// LogMatchQuery is a log completion query.
type LogMatchQuery struct {
	Query          string
	StartNs, EndNs int64
	Limit          int
}

// LogSeriesQuery is a log series query.
type LogSeriesQuery struct {
	Match          []string
	StartNs, EndNs int64
	Limit          int
}

// LogLabels lists log label names.
func (c *Client) LogLabels(ctx context.Context, rc *core.RequestCtx, q LogMatchQuery) (*ValuesResult, error) {
	return nil, protocolError()
}

// LogLabelValues lists the values of a log label.
func (c *Client) LogLabelValues(ctx context.Context, rc *core.RequestCtx, name string, q LogMatchQuery) (*ValuesResult, error) {
	return nil, protocolError()
}

// LogSeries lists log streams.
func (c *Client) LogSeries(ctx context.Context, rc *core.RequestCtx, q LogSeriesQuery) (*SeriesResult, error) {
	return nil, protocolError()
}
