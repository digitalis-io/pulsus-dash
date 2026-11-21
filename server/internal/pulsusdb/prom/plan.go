// Package prom plans PromQL queries on the server (ADR-0021, plan #112): it substitutes
// variables and the step macros, reads the query's shape with the upstream PromQL parser,
// classifies its reserved selectors (T07 §4.1 step 1a), applies the bare-counter and
// bare-histogram rate rewrites and the 65 536-byte limit on the final planned text. Every
// function here is pure: metric types come from the caller (TypesSource).
package prom

// Limits of a plan (plan #112 §3.1).
const (
	MaxRawBytes   = 131_072
	MaxSentBytes  = 65_536
	MaxVars       = 64
	MaxValueBytes = 4_096
	// MaxExpandedBytes is the processing cap, the request-body limit (T06-021): a substituted
	// text over it is refused (row 9) even if a rewrite would shrink it.
	MaxExpandedBytes = 2 << 20
	// DefaultScrapeMs is the scrape interval S of ADR-0021 until a per-binding one exists.
	DefaultScrapeMs = 15_000
)

// Kind is the query kind of a route.
type Kind int

// The query kinds.
const (
	KindRange Kind = iota + 1
	KindInstant
)

// Inputs are what a route hands the planner: the raw text and the request members.
type Inputs struct {
	Query string
	Vars  map[string]string
	Kind  Kind
	Rate  bool
	// StepMs is the base step: range, the PromGrid step; instant, step_ms or 0.
	StepMs int64
}

// Planned is a plan: the text sent to PulsusDB and the facts the client reads.
type Planned struct {
	Query, Expanded                       string // sent text; substituted text before the rate rewrite
	Bytes                                 int    // len(Query)
	ValueType                             ValueType
	RateCandidate, RateApplied, Histogram bool
	StepMs, RateWindowMs                  int64 // RateWindowMs is 0 unless RateApplied
	sub, rw                               []segment
}

// PlannedWire is the wire form of a plan (OpenAPI PlannedQuery).
type PlannedWire struct {
	Query         string `json:"query"`
	Expanded      string `json:"expanded"`
	Bytes         int    `json:"bytes"`
	ValueType     string `json:"value_type"`
	RateCandidate bool   `json:"rate_candidate"`
	RateApplied   bool   `json:"rate_applied"`
	Histogram     bool   `json:"histogram"`
	StepMs        int64  `json:"step_ms,omitempty"`
	RateWindowMs  int64  `json:"rate_window_ms,omitempty"`
}

// Wire is the plan's wire form.
func (p Planned) Wire() PlannedWire { return PlannedWire{} }

// ToSource maps a byte offset of the sent text to the raw text (plan #112 §4.2).
func (p Planned) ToSource(sentByte int) (rawByte int, ok bool) { return 0, false }

// Source is the data source a query reads (T07 §4.1 step 1a).
type Source string

// The sources.
const (
	SourcePulsusDB Source = "pulsus_db"
	SourceVirtual  Source = "virtual"
	SourceMixed    Source = "mixed"
)

// Class is the classification of a query: its source, the reserved names it reads (first
// appearance, distinct) and the largest of their step floors.
type Class struct {
	Source   Source
	Reserved []string
	FloorMs  int64
}

// Prepared is a query checked, substituted with placeholder macros and classified.
type Prepared struct {
	in          Inputs
	substituted string
	shape       Shape
	class       Class
}

// Prepare checks the inputs, substitutes the variables (each macro as the placeholder "1s"),
// reads the shape and classifies it (rows 1–5 and 7–9 of §3.1, before any I/O).
func Prepare(in Inputs) (*Prepared, *PlanError) {
	return nil, &PlanError{Kind: ErrInput, Message: "not implemented"}
}

// Substituted is the placeholder text: the byte guard and Classify read it, nothing sends it.
func (p *Prepared) Substituted() string { return p.substituted }

// Class is the query's classification.
func (p *Prepared) Class() Class { return p.class }

// NeedsTypes reports whether the plan depends on metric types.
func (p *Prepared) NeedsTypes() bool { return false }

// Plan substitutes the macros at stepMs, reads the shape, applies the rewrites and the size
// limit (rows 6 and 10 of §3.1).
func (p *Prepared) Plan(stepMs int64, types MetricTypes) (Planned, *PlanError) {
	return Planned{}, &PlanError{Kind: ErrInput, Message: "not implemented"}
}

// Plan is Prepare, then Plan at FloorStep(in.StepMs, Class().FloorMs).
func Plan(in Inputs, types MetricTypes) (Planned, *PlanError) {
	return Planned{}, &PlanError{Kind: ErrInput, Message: "not implemented"}
}

// ClassifyShape classifies a shape (plan #112 §4.3).
func ClassifyShape(s Shape) Class { return Class{} }

// FloorStep is stepMs when floorMs ≤ 0, else the least multiple of floorMs at least stepMs.
func FloorStep(stepMs, floorMs int64) int64 { return 0 }

// RateWindowMs is max(4 × step, step + DefaultScrapeMs, 4 × DefaultScrapeMs).
func RateWindowMs(stepMs int64) int64 { return 0 }

// FormatDuration is the largest of d, h, m, s that divides ms (> 0), else "<ms>ms".
func FormatDuration(ms int64) string { return "" }
