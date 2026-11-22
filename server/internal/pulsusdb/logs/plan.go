// Package logs plans LogQL queries on the server (ADR-0021, plan #116). Stub: the failing tests of
// plan #116 §5 compile against it.
package logs

// Limits of a plan (plan #116 §3.1).
const (
	MaxRawBytes      = 131_072
	MaxSentBytes     = 65_536
	MaxVars          = 64
	MaxValueBytes    = 4_096
	MaxExpandedBytes = 2 << 20
	DefaultScrapeMs  = 15_000
	ReservedMatcher  = `source="pulsus-dash"`
)

// Kind is the query kind of a route.
type Kind int

// The query kinds.
const (
	KindRange Kind = iota + 1
	KindVolume
)

// Inputs are what a route hands the planner.
type Inputs struct {
	Query  string
	Vars   map[string]string
	Kind   Kind
	StepMs int64
}

// Planned is a plan.
type Planned struct {
	Query, Expanded string
	Bytes           int
	StepMs          int64
	Class           Class
}

// PlannedWire is the wire form of a plan (OpenAPI LogqlPlannedQuery).
type PlannedWire struct {
	Query    string `json:"query"`
	Expanded string `json:"expanded"`
	Bytes    int    `json:"bytes"`
	StepMs   int64  `json:"step_ms"`
}

// Wire is the plan's wire form.
func (p Planned) Wire() PlannedWire { return PlannedWire{} }

// ToSource maps a sent byte to the raw text.
func (p Planned) ToSource(int) (int, bool) { return 0, false }

// RateWindowMs is the rate window at a step.
func RateWindowMs(int64) int64 { return 0 }

// FormatDuration formats a duration.
func FormatDuration(int64) string { return "" }

// VolumeRange is the range of the volume template.
func VolumeRange(int64) string { return "" }

// RewriteAtByte rewrites the first "at byte N" of msg.
func RewriteAtByte(msg string, _ int) string { return msg }

// Prepared is a prepared query.
type Prepared struct{}

func notImplemented() *PlanError { return &PlanError{Kind: ErrInput, Message: "not implemented"} }

// Prepare checks and substitutes the inputs.
func Prepare(Inputs) (*Prepared, *PlanError) { return nil, notImplemented() }

// Substituted is the placeholder text.
func (p *Prepared) Substituted() string { return "" }

// Class is the classification of the substituted text.
func (p *Prepared) Class() Class { return Class{} }

// CheckCap is the processing cap at a step.
func (p *Prepared) CheckCap(int64) *PlanError { return notImplemented() }

// Plan plans at a step.
func (p *Prepared) Plan(int64) (Planned, *PlanError) { return Planned{}, notImplemented() }

// Plan is Prepare, then Plan.
func Plan(Inputs) (Planned, *PlanError) { return Planned{}, notImplemented() }
