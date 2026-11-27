package arrowwire

import (
	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/array"

	"github.com/digitalis-io/pulsus-dash/server/internal/apierr"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// Phase is the coverage phase (coverage/1 `phase`).
type Phase uint8

// The phases.
const (
	PhasePlanned Phase = iota
	PhasePartial
	PhaseFinal
)

// Coverage is one coverage/1 row (T04 §5.3): one field per column in order; a nullable column
// is a pointer (nil = null); timestamps are ms since the epoch. Lists are written empty when nil.
// Codes: Exactness 0 raw-exact, 1 rollup, 2 sampled, 3 estimated, 4 unknown; ReadCache 0 hit,
// 1 miss, 2 bypass, 3 other.
type Coverage struct {
	Phase              Phase
	Exactness          uint8
	RollupLevelS       *uint32
	SampledRatio       *float64
	Truncated          bool
	TruncationReason   *string
	DroppedCount       *uint64
	SeriesReturned     uint32
	RowsRead           *uint64
	BytesRead          *uint64
	ShardsFailed       *uint16
	ShardsSkipped      *uint16
	RetentionFloorMs   *int64
	ExcludedDims       []string
	Warnings           []string
	Infos              []string
	UpstreamQueryIDs   []string
	ReadCache          *uint8
	ReadCacheThroughMs *int64
	DataEndMs          *int64
	UpstreamMs         uint32
	ConvertMs          uint32
}

// ErrorRow is one error/1 row (T04 §5.1). Code: 0 bad_query, 1 too_broad, 2 unauthorised,
// 3 forbidden_scope, 4 upstream_unavailable, 5 timeout, 6 cancelled, 7 rate_limited, 8 internal.
type ErrorRow struct {
	Code                   uint8
	HTTPStatus             uint16
	Message                string
	Position, RetryAfterMs *uint32
	Suggestion             *string
}

// The exactness the BFF reports when it did not ask PulsusDB (no X-Pulsus-Explain).
const exactnessUnknown = 4

// CoverageFrom maps a PulsusDB completeness block to coverage/1 (plan #68 B1 §3.3): Truncated,
// Warnings and Infos as they are; QueryID as the one upstream id (none if ""); ReadCache
// hit/miss/bypass/other as 0–3 ("" null); ReadCacheThroughMs and NewestSampleMs as
// read_cache_through and data_end (negative = null); exactness 4 unknown; all else null or 0.
func CoverageFrom(c pulsusdb.Completeness, ph Phase, seriesReturned uint32) Coverage {
	out := Coverage{Phase: ph, Exactness: exactnessUnknown, Truncated: c.Truncated, SeriesReturned: seriesReturned,
		ExcludedDims: []string{}, Warnings: nonNilStrings(c.Warnings), Infos: nonNilStrings(c.Infos), UpstreamQueryIDs: []string{}}
	if c.QueryID != "" {
		out.UpstreamQueryIDs = []string{c.QueryID}
	}
	if code, ok := map[string]uint8{"hit": 0, "miss": 1, "bypass": 2, "other": 3}[c.ReadCache]; ok {
		out.ReadCache = &code
	}
	if c.ReadCacheThroughMs >= 0 {
		v := c.ReadCacheThroughMs
		out.ReadCacheThroughMs = &v
	}
	if c.NewestSampleMs >= 0 {
		v := c.NewestSampleMs
		out.DataEndMs = &v
	}
	return out
}

func nonNilStrings(s []string) []string {
	return append(make([]string, 0, len(s)), s...)
}

// coveragePayload is the META payload of c.
func coveragePayload(c Coverage) func(*payloadBuf) error {
	return func(p *payloadBuf) error {
		rec := coverageRecord(c)
		defer rec.Release()
		return streamPayload(rec)(p)
	}
}

// errorPayload is the ERROR payload of e.
func errorPayload(e ErrorRow) func(*payloadBuf) error {
	return func(p *payloadBuf) error {
		b := array.NewRecordBuilder(mem, error1)
		defer b.Release()
		b.Field(0).(*array.Uint8Builder).Append(e.Code)
		b.Field(1).(*array.Uint16Builder).Append(e.HTTPStatus)
		b.Field(2).(*array.StringBuilder).Append(e.Message)
		appendOpt(b.Field(3).(*array.Uint32Builder), e.Position)
		appendOpt(b.Field(4).(*array.Uint32Builder), e.RetryAfterMs)
		appendOpt(b.Field(5).(*array.StringBuilder), e.Suggestion)
		rec := b.NewRecordBatch()
		defer rec.Release()
		return streamPayload(rec)(p)
	}
}

// optBuilder is a builder with Append and AppendNull.
type optBuilder[T any] interface {
	Append(T)
	AppendNull()
}

func appendOpt[T any](b optBuilder[T], v *T) {
	if v == nil {
		b.AppendNull()
	} else {
		b.Append(*v)
	}
}

func appendTS(b *array.TimestampBuilder, v *int64) {
	if v == nil {
		b.AppendNull()
	} else {
		b.Append(arrow.Timestamp(*v))
	}
}

func appendList(b *array.ListBuilder, xs []string) {
	b.Append(true)
	vb := b.ValueBuilder().(*array.StringBuilder)
	for _, x := range xs {
		vb.Append(x)
	}
}

// coverageRecord is the one-row coverage/1 batch of c.
func coverageRecord(c Coverage) arrow.RecordBatch {
	b := array.NewRecordBuilder(mem, coverage1)
	defer b.Release()
	b.Field(0).(*array.Uint8Builder).Append(uint8(c.Phase))
	b.Field(1).(*array.Uint8Builder).Append(c.Exactness)
	appendOpt(b.Field(2).(*array.Uint32Builder), c.RollupLevelS)
	appendOpt(b.Field(3).(*array.Float64Builder), c.SampledRatio)
	b.Field(4).(*array.BooleanBuilder).Append(c.Truncated)
	appendOpt(b.Field(5).(*array.StringBuilder), c.TruncationReason)
	appendOpt(b.Field(6).(*array.Uint64Builder), c.DroppedCount)
	b.Field(7).(*array.Uint32Builder).Append(c.SeriesReturned)
	appendOpt(b.Field(8).(*array.Uint64Builder), c.RowsRead)
	appendOpt(b.Field(9).(*array.Uint64Builder), c.BytesRead)
	appendOpt(b.Field(10).(*array.Uint16Builder), c.ShardsFailed)
	appendOpt(b.Field(11).(*array.Uint16Builder), c.ShardsSkipped)
	appendTS(b.Field(12).(*array.TimestampBuilder), c.RetentionFloorMs)
	appendList(b.Field(13).(*array.ListBuilder), c.ExcludedDims)
	appendList(b.Field(14).(*array.ListBuilder), c.Warnings)
	appendList(b.Field(15).(*array.ListBuilder), c.Infos)
	appendList(b.Field(16).(*array.ListBuilder), c.UpstreamQueryIDs)
	appendOpt(b.Field(17).(*array.Uint8Builder), c.ReadCache)
	appendTS(b.Field(18).(*array.TimestampBuilder), c.ReadCacheThroughMs)
	appendTS(b.Field(19).(*array.TimestampBuilder), c.DataEndMs)
	b.Field(20).(*array.Uint32Builder).Append(c.UpstreamMs)
	b.Field(21).(*array.Uint32Builder).Append(c.ConvertMs)
	return b.NewRecordBatch()
}

// ErrorFrom is the error/1 row of a classified failure (plan #68 D1 §3.4).
func ErrorFrom(c apierr.Class) ErrorRow {
	_ = c
	return ErrorRow{}
}
