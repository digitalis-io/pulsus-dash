// Package prom plans PromQL queries on the server (ADR-0021, plan #112): it substitutes
// variables and the step macros, reads the query's shape with the upstream PromQL parser,
// classifies its reserved selectors (T07 §4.1 step 1a), applies the bare-counter and
// bare-histogram rate rewrites and the 65 536-byte limit on the final planned text. Every
// function here is pure: metric types come from the caller (TypesSource). Nothing here logs or
// returns the query text or a variable value in an error.
package prom

import (
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

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
	// RangeMs is the request window, to − from, for $__range, $__range_s and $__range_ms: range,
	// the request's; instant, 0 (the request carries no window).
	RangeMs int64
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
func (p Planned) Wire() PlannedWire {
	return PlannedWire{Query: p.Query, Expanded: p.Expanded, Bytes: p.Bytes, ValueType: string(p.ValueType),
		RateCandidate: p.RateCandidate, RateApplied: p.RateApplied, Histogram: p.Histogram,
		StepMs: p.StepMs, RateWindowMs: p.RateWindowMs}
}

// ToSource maps a byte offset of the sent text to the raw text (plan #112 §4.2): none inside a
// rewrite prefix or suffix (its first byte included), or out of range.
func (p Planned) ToSource(sentByte int) (rawByte int, ok bool) {
	e, ok := at(p.rw, len(p.Query), sentByte)
	if !ok {
		return 0, false
	}
	return at(p.sub, len(p.Expanded), e)
}

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

// reservedFloors are the virtual metric names of T07 §0 and their step floors (T07 §4.3).
var reservedFloors = map[string]int64{"ALERTS": 15_000, "ALERTS_FOR_STATE": 15_000, "pulsus_anomaly_score": 300_000}

// ClassifyShape classifies a shape (plan #112 §4.3): selectors without a metric name are not
// counted (T07 §4.11 decides them at Lower), and an unknown shape is pulsus_db; the T07-020
// byte guard covers both.
func ClassifyShape(s Shape) Class {
	c := Class{Source: SourcePulsusDB, Reserved: []string{}}
	for _, m := range s.Metrics {
		if f, ok := reservedFloors[m]; ok {
			c.Reserved = append(c.Reserved, m)
			c.FloorMs = max(c.FloorMs, f)
		}
	}
	switch {
	case len(c.Reserved) == 0:
	case len(c.Reserved) == len(s.Metrics):
		c.Source = SourceVirtual
	default:
		c.Source = SourceMixed
	}
	return c
}

// FloorStep is stepMs when floorMs ≤ 0, else the least multiple of floorMs at least stepMs
// (T07 §4.3).
func FloorStep(stepMs, floorMs int64) int64 {
	if floorMs <= 0 || stepMs <= 0 {
		return stepMs
	}
	return (stepMs + floorMs - 1) / floorMs * floorMs
}

// RateWindowMs is max(step + DefaultScrapeMs, 4 × DefaultScrapeMs) (#303): the conventional
// window, one scrape longer than the step and at least four scrapes, so a rate follows the step
// and keeps its short spikes.
func RateWindowMs(stepMs int64) int64 {
	return max(stepMs+DefaultScrapeMs, 4*DefaultScrapeMs)
}

var durationUnits = []struct {
	unit string
	ms   int64
}{{"d", 86_400_000}, {"h", 3_600_000}, {"m", 60_000}, {"s", 1_000}}

// FormatDuration is the largest of d, h, m, s that divides ms (> 0), else "<ms>ms".
func FormatDuration(ms int64) string {
	for _, u := range durationUnits {
		if ms > 0 && ms%u.ms == 0 {
			return strconv.FormatInt(ms/u.ms, 10) + u.unit
		}
	}
	return strconv.FormatInt(ms, 10) + "ms"
}

// RangeSeconds is the window of $__range and $__range_s (#291): rangeMs rounded to the nearest
// whole second, a half second up, and at least 1 s, so a sub-second window is never a zero range.
// $__range_ms is rangeMs itself.
func RangeSeconds(rangeMs int64) int64 {
	return max(1, (rangeMs+500)/1000)
}

// noWindow is the refusal of a range macro without a window (#291): the request has no from and
// to (an instant query), so $__range has no value.
func noWindow() *PlanError {
	return inputError("/query", "query.no_window", "$__range, $__range_s and $__range_ms need a time window, and the request has none")
}

// Prepared is a query checked, substituted with placeholder macros and classified.
type Prepared struct {
	in          Inputs
	substituted string
	shape       Shape
	class       Class
}

// pointerToken escapes a JSON pointer reference token (RFC 6901).
func pointerToken(s string) string {
	return strings.NewReplacer("~", "~0", "/", "~1").Replace(s)
}

func inputError(pointer, key, msg string) *PlanError {
	return &PlanError{Kind: ErrInput, Message: msg, Fields: []FieldError{{Pointer: pointer, MessageKey: key}}}
}

func validName(n string) bool {
	if n == "" || len(n) > maxNameLen || !isNameStart(n[0]) {
		return false
	}
	for i := 1; i < len(n); i++ {
		if !isNameByte(n[i]) {
			return false
		}
	}
	return true
}

// checkInputs is rows 1–5 of §3.1, first error wins.
func checkInputs(in Inputs) *PlanError {
	if !utf8.ValidString(in.Query) {
		return inputError("/query", "field.range", "query must be UTF-8")
	}
	if len(in.Query) == 0 || len(in.Query) > MaxRawBytes {
		return inputError("/query", "field.range", "query must be 1 to 131072 bytes")
	}
	if len(in.Vars) > MaxVars {
		return inputError("/vars", "field.range", "vars must have at most 64 entries")
	}
	names := make([]string, 0, len(in.Vars))
	for n := range in.Vars {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		if !validName(n) {
			return inputError("/vars/"+pointerToken(n), "field.pattern", "a variable name must match ^[A-Za-z_][A-Za-z0-9_]{0,63}$")
		}
		if v := in.Vars[n]; !utf8.ValidString(v) || len(v) > MaxValueBytes {
			return inputError("/vars/"+pointerToken(n), "field.range", "a variable value must be UTF-8 and at most 4096 bytes")
		}
	}
	return nil
}

// namesError is one refusal naming variables: "<prefix>$a, $b<suffix>", one field per name.
func namesError(kind PlanErrorKind, names []string, key, prefix, suffix string) *PlanError {
	e := &PlanError{Kind: kind, Message: prefix + "$" + strings.Join(names, ", $") + suffix}
	for _, n := range names {
		e.Fields = append(e.Fields, FieldError{Pointer: "/vars/" + pointerToken(n), MessageKey: key})
	}
	return e
}

// processingCap is the refusal of a substituted text over MaxExpandedBytes (row 9). It carries no
// plan: nothing was planned.
func processingCap() *PlanError {
	return &PlanError{Kind: ErrProcessingCap,
		Message: "the substituted query is over 2097152 bytes, the most the server processes",
		Fields:  []FieldError{{Pointer: "/query", MessageKey: "query.too_large_to_plan"}}}
}

// Prepare checks the inputs, substitutes the variables (each macro as its placeholder: "1s" for
// a duration, "1" for $__range_s and $__range_ms), reads the shape and classifies it: rows 1–5, 7,
// 7b (plan #118 §4.3), 8, 8b (a range macro without a window, #291) and 9 of §3.1, before any I/O.
func Prepare(in Inputs) (*Prepared, *PlanError) {
	if e := checkInputs(in); e != nil {
		return nil, e
	}
	count := substitute(in.Query, in.Vars, placeholders(), false)
	if len(count.missing) > 0 {
		return nil, namesError(ErrVariableMissing, count.missing, "variable.missing", "no value for variable ", "")
	}
	// Row 7b depends only on the raw text and the values, never on the step (plan #118 §4.3).
	if len(count.unrepresentable) > 0 {
		return nil, namesError(ErrInput, count.unrepresentable, "variable.unrepresentable",
			"the value of variable ", " cannot be written where it is referenced")
	}
	if count.macro && in.StepMs == 0 {
		return nil, inputError("/step_ms", "field.required", "step_ms is required for $__interval and $__rate_interval")
	}
	if count.rangeMacro && in.RangeMs <= 0 {
		return nil, noWindow()
	}
	if count.size > MaxExpandedBytes {
		return nil, processingCap()
	}
	text := substitute(in.Query, in.Vars, placeholders(), true).text
	shape := ShapeOf(text)
	return &Prepared{in: in, substituted: text, shape: shape, class: ClassifyShape(shape)}, nil
}

// Substituted is the placeholder text: the byte guard and Classify read it, nothing sends it.
func (p *Prepared) Substituted() string { return p.substituted }

// Class is the query's classification.
func (p *Prepared) Class() Class { return p.class }

// NeedsTypes reports whether the plan depends on metric types (plan #112 §4.1), from the
// placeholder shape: the macros never change the selectors. False guarantees that Plan gives the
// same plan with any types.
func (p *Prepared) NeedsTypes() bool {
	s := p.shape
	if s.Bare != nil {
		return !strings.HasSuffix(s.Bare.Metric, "_total")
	}
	if s.HasHistogramQuantile {
		return false
	}
	for _, m := range s.Metrics {
		if strings.HasSuffix(m, "_bucket") {
			return true
		}
	}
	return false
}

func isCounter(n string, t MetricTypes) bool {
	return strings.HasSuffix(n, "_total") || KindOf(n, t) == MetricCounter
}

func isHistogram(n string, t MetricTypes) bool {
	if !strings.HasSuffix(n, "_bucket") {
		return false
	}
	k := KindOf(n, t)
	return k == MetricHistogram || k == MetricUnknown
}

// CheckCap is row 9 at the resolved step: a macro's text there may be longer than the "1s"
// placeholder Prepare counted, so the substituted length is counted again, without building the
// text. It is pure: the routes call it right after resolving the step, before tenant resolution or
// any metadata read; Plan repeats it.
func (p *Prepared) CheckCap(stepMs int64) *PlanError {
	if substitute(p.in.Query, p.in.Vars, macrosAt(stepMs, p.in.RangeMs), false).size > MaxExpandedBytes {
		return processingCap()
	}
	return nil
}

// Plan substitutes the step macros at stepMs and the range macros from the window, reads the shape, applies the rewrites and the size
// limit: rows 6, 9 (the processing cap at the resolved step) and 10 of §3.1 (plan #112 §4.1).
func (p *Prepared) Plan(stepMs int64, types MetricTypes) (Planned, *PlanError) {
	if (p.in.Kind == KindRange && stepMs <= 0) || stepMs < 0 {
		return Planned{}, inputError("/step_ms", "field.range", "step_ms must be positive")
	}
	// The cap at the resolved step again, in defence: callers check it with CheckCap first.
	if pe := p.CheckCap(stepMs); pe != nil {
		return Planned{}, pe
	}
	sub := substitute(p.in.Query, p.in.Vars, macrosAt(stepMs, p.in.RangeMs), true)
	expanded := sub.text
	shape := ShapeOf(expanded)
	out := Planned{Query: expanded, Expanded: expanded, ValueType: shape.ValueType, StepMs: stepMs, sub: sub.segs,
		rw: []segment{{sentFrom: 0, sentLen: len(expanded), rawFrom: 0, rawLen: len(expanded), kind: segCopy}}}
	rated := stepMs > 0 && p.in.Rate
	wrap := func(prefix, suffix string, histogram bool) {
		b := shape.Bare
		span := expanded[b.From:b.To]
		out.Query = prefix + span + suffix
		out.RateCandidate, out.RateApplied, out.Histogram = true, true, histogram
		out.RateWindowMs = RateWindowMs(stepMs)
		out.rw = []segment{
			{sentFrom: 0, sentLen: len(prefix), kind: segAdded},
			{sentFrom: len(prefix), sentLen: len(span), rawFrom: b.From, rawLen: len(span), kind: segCopy},
			{sentFrom: len(prefix) + len(span), sentLen: len(suffix), kind: segAdded},
		}
	}
	window := func() string { return FormatDuration(RateWindowMs(stepMs)) }
	switch b := shape.Bare; {
	case b != nil && isHistogram(b.Metric, types):
		if rated {
			wrap("sum by (le) (rate(", "["+window()+"]))", true)
		} else {
			out.RateCandidate = true
		}
	case b != nil && isCounter(b.Metric, types):
		if rated {
			wrap("rate(", "["+window()+"])", false)
		} else {
			out.RateCandidate = true
		}
	default:
		if !shape.HasHistogramQuantile {
			for _, m := range shape.Metrics {
				if isHistogram(m, types) {
					out.Histogram = true
					break
				}
			}
		}
	}
	out.Bytes = len(out.Query)
	if out.Bytes > MaxSentBytes {
		planned := out
		return Planned{}, &PlanError{Kind: ErrSentTooLarge, Message: "the planned query is over 65536 bytes",
			Fields: []FieldError{{Pointer: "/query", MessageKey: "query.sent_too_large"}}, Planned: &planned}
	}
	return out, nil
}

// Plan is Prepare, then Plan at FloorStep(in.StepMs, Class().FloorMs).
func Plan(in Inputs, types MetricTypes) (Planned, *PlanError) {
	p, err := Prepare(in)
	if err != nil {
		return Planned{}, err
	}
	return p.Plan(FloorStep(in.StepMs, p.Class().FloorMs), types)
}
