package arrowwire

import "github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"

// Phase is the coverage phase.
type Phase uint8

// The phases.
const (
	PhasePlanned Phase = iota
	PhasePartial
	PhaseFinal
)

// Coverage is one coverage/1 row.
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

// ErrorRow is one error/1 row.
type ErrorRow struct {
	Code                   uint8
	HTTPStatus             uint16
	Message                string
	Position, RetryAfterMs *uint32
	Suggestion             *string
}

// CoverageFrom maps a pulsusdb completeness block to coverage/1.
func CoverageFrom(c pulsusdb.Completeness, ph Phase, seriesReturned uint32) Coverage {
	return Coverage{}
}
