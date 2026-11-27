// Package logs plans LogQL queries on the server (ADR-0021, plan #116). It substitutes variables
// and the step macros by the LogQL lexical rules, classifies the stream selectors that name the
// reserved source (T07 §4.1 step 1a), applies the fixed volume template and the 65 536-byte limit
// on the final planned text. Every function here is pure and imports only the standard library:
// LogQL planning needs no metric types and no parser (ADR-0021 §5). Nothing here logs or returns
// the query text or a variable value in an error.
package logs

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Limits of a plan (plan #116 §3.1, the PromQL limits of plan #112 §3.1).
const (
	MaxRawBytes   = 131_072
	MaxSentBytes  = 65_536
	MaxVars       = 64
	MaxValueBytes = 4_096
	// MaxExpandedBytes is the processing cap, the request-body limit (T06-021).
	MaxExpandedBytes = 2 << 20
	// DefaultScrapeMs is S of $__rate_interval, the same value as prom.DefaultScrapeMs.
	DefaultScrapeMs = 15_000
	// ReservedMatcher is the name the refusal reports (T07-020).
	ReservedMatcher = `source="pulsus-dash"`
)

// Kind is the query kind of a route.
type Kind int

// The query kinds.
const (
	KindRange Kind = iota + 1
	KindVolume
)

// Inputs are what a route hands the planner: the raw text and the request members.
type Inputs struct {
	Query  string
	Vars   map[string]string
	Kind   Kind
	StepMs int64 // the grid step
	// RangeMs is the request window, to − from, for $__range, $__range_s and $__range_ms; 0 = none.
	RangeMs int64
}

// Planned is a plan: the text sent to PulsusDB and what the client reads of it.
type Planned struct {
	Query, Expanded string // sent text (volume: the template around Expanded); the substituted text
	Bytes           int    // len(Query)
	StepMs          int64
	// Class is Classify(Query), its spans on the planned text: the authoritative classification
	// (plan #116 §3.2).
	Class   Class
	sub, rw []segment
}

// PlannedWire is the wire form of a plan (OpenAPI LogqlPlannedQuery).
type PlannedWire struct {
	Query    string `json:"query"`
	Expanded string `json:"expanded"`
	Bytes    int    `json:"bytes"`
	StepMs   int64  `json:"step_ms"`
}

// Wire is the plan's wire form.
func (p Planned) Wire() PlannedWire {
	return PlannedWire{Query: p.Query, Expanded: p.Expanded, Bytes: p.Bytes, StepMs: p.StepMs}
}

// ToSource maps a byte offset of the sent text to the raw text (plan #116 §4.2): none inside the
// volume prefix or suffix (its first byte included), or out of range.
func (p Planned) ToSource(sentByte int) (rawByte int, ok bool) {
	e, ok := at(p.rw, len(p.Query), sentByte)
	if !ok {
		return 0, false
	}
	return at(p.sub, len(p.Expanded), e)
}

// RateWindowMs is max(4 × step, step + DefaultScrapeMs, 4 × DefaultScrapeMs), PromQL's window at
// the same step, so one board means one window.
func RateWindowMs(stepMs int64) int64 {
	return max(4*stepMs, stepMs+DefaultScrapeMs, 4*DefaultScrapeMs)
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

// VolumeRange is the range of the volume template: whole seconds as "<s>s" (#65: [5s], [60s]),
// else "<ms>ms".
func VolumeRange(stepMs int64) string {
	if stepMs%1000 == 0 {
		return strconv.FormatInt(stepMs/1000, 10) + "s"
	}
	return strconv.FormatInt(stepMs, 10) + "ms"
}

// volumePrefix and volumeSuffix wrap the substituted text as the single operand of the fixed
// volume template (T07 §0, T07-002, #65 §4.4). The suffix starts with a newline. "| drop
// __error__" keeps lines a parser stage fails on from failing the whole query.
const volumePrefix = "sum by (level, detected_level) (count_over_time("

func volumeSuffix(stepMs int64) string {
	return "\n| drop __error__ [" + VolumeRange(stepMs) + "]))"
}

// atByte is PulsusDB's LogQL position, "at byte N" with N a 0-based byte offset (#65 §4.5).
var atByte = regexp.MustCompile(`\bat byte (\d{1,9})\b`)

// RewriteAtByte replaces the offset of the first "at byte N" of msg with off; msg is unchanged
// without one.
func RewriteAtByte(msg string, off int) string {
	m := atByte.FindStringSubmatchIndex(msg)
	if m == nil {
		return msg
	}
	return msg[:m[2]] + strconv.Itoa(off) + msg[m[3]:]
}

// Prepared is a query checked, substituted with placeholder macros and classified.
type Prepared struct {
	in          Inputs
	substituted string
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

// processingCap is the refusal of a substituted text over MaxExpandedBytes (row 9). It carries no
// plan: nothing was planned.
func processingCap() *PlanError {
	return &PlanError{Kind: ErrProcessingCap,
		Message: "the substituted query is over 2097152 bytes, the most the server processes",
		Fields:  []FieldError{{Pointer: "/query", MessageKey: "query.too_large_to_plan"}}}
}

// namesError is row 7 or 7b: one field per name, in first-reference order.
func namesError(kind PlanErrorKind, names []string, key, prefix, suffix string) *PlanError {
	e := &PlanError{Kind: kind, Message: prefix + "$" + strings.Join(names, ", $") + suffix}
	for _, n := range names {
		e.Fields = append(e.Fields, FieldError{Pointer: "/vars/" + pointerToken(n), MessageKey: key})
	}
	return e
}

// hashError is row 9b: PulsusDB's LogQL has no comments (plan #121 §1), so a '#' outside strings
// is refused before any I/O. raw is the '#' mapped to the raw text; ok false (an offset with no
// position) gives no Position and a message without "at byte".
func hashError(raw int, ok bool) *PlanError {
	e := inputError("/query", "query.invalid", "unexpected '#': LogQL has no comments")
	if ok {
		e.Message = "unexpected '#' at byte " + strconv.Itoa(raw) + ": LogQL has no comments"
		e.Position = &raw
	}
	return e
}

// prepareSubstitute is Prepare before row 9b: rows 1–5, 7, 7b and 9, then the substituted text
// (each macro as the placeholder "1s") and its segment map to the raw text.
func prepareSubstitute(in Inputs) (text string, segs []segment, err *PlanError) {
	if e := checkInputs(in); e != nil {
		return "", nil, e
	}
	count := substitute(in.Query, in.Vars, placeholders(), false)
	if len(count.missing) > 0 {
		return "", nil, namesError(ErrVariableMissing, count.missing, "variable.missing", "no value for variable ", "")
	}
	if len(count.unrepresentable) > 0 {
		return "", nil, namesError(ErrInput, count.unrepresentable, "variable.unrepresentable",
			"the value of variable ", " cannot be written where it is referenced")
	}
	if count.size > MaxExpandedBytes {
		return "", nil, processingCap()
	}
	built := substitute(in.Query, in.Vars, placeholders(), true)
	return built.text, built.segs, nil
}

// Prepare checks the inputs, substitutes the variables (each macro as the placeholder "1s"),
// refuses a top-level '#' and classifies the substituted text: rows 1–5, 7, 7b, 9 and 9b of
// §3.1, before any I/O. Row 9b comes before Classify (plan #121 §4.3), so a text with a '#' is
// refused as query.invalid whatever selectors it holds.
func Prepare(in Inputs) (*Prepared, *PlanError) {
	text, segs, err := prepareSubstitute(in)
	if err != nil {
		return nil, err
	}
	if off := hashAt(text); off >= 0 {
		return nil, hashError(at(segs, len(text), off))
	}
	return &Prepared{in: in, substituted: text, class: Classify(text)}, nil
}

// Substituted is the placeholder text: Classify and the byte guard read it, nothing sends it.
func (p *Prepared) Substituted() string { return p.substituted }

// Class is the classification of the substituted text: an early refusal only; the planned text's
// Planned.Class is authoritative (plan #116 §3.2).
func (p *Prepared) Class() Class { return p.class }

// CheckCap is row 9 at the step: a macro's text there may be longer than the "1s" placeholder
// Prepare counted, so the substituted length is counted again, without building the text. Plan
// repeats it.
func (p *Prepared) CheckCap(stepMs int64) *PlanError {
	if substitute(p.in.Query, p.in.Vars, macrosAt(stepMs), false).size > MaxExpandedBytes {
		return processingCap()
	}
	return nil
}

// Plan substitutes the macros at stepMs, applies the volume template, refuses a top-level '#' in
// the final text, applies the size limit and classifies the planned text: rows 6, 9, 9b and 10 of
// §3.1 (plan #116 §4.1, plan #121 §4.3).
func (p *Prepared) Plan(stepMs int64) (Planned, *PlanError) {
	if stepMs <= 0 {
		return Planned{}, inputError("/step_ms", "field.range", "step_ms must be positive")
	}
	// The cap at the step again, in defence: callers check it with CheckCap first.
	if pe := p.CheckCap(stepMs); pe != nil {
		return Planned{}, pe
	}
	sub := substitute(p.in.Query, p.in.Vars, macrosAt(stepMs), true)
	expanded := sub.text
	out := Planned{Query: expanded, Expanded: expanded, StepMs: stepMs, sub: sub.segs,
		rw: []segment{{sentFrom: 0, sentLen: len(expanded), rawFrom: 0, rawLen: len(expanded), kind: segCopy}}}
	if p.in.Kind == KindVolume {
		suffix := volumeSuffix(stepMs)
		out.Query = volumePrefix + expanded + suffix
		out.rw = []segment{
			{sentFrom: 0, sentLen: len(volumePrefix), kind: segAdded},
			{sentFrom: len(volumePrefix), sentLen: len(expanded), rawFrom: 0, rawLen: len(expanded), kind: segCopy},
			{sentFrom: len(volumePrefix) + len(expanded), sentLen: len(suffix), kind: segAdded},
		}
	}
	// Row 9b on the final text, in defence: macros and the template add no '#', so after Prepare
	// passed this cannot fire.
	if off := hashAt(out.Query); off >= 0 {
		return Planned{}, hashError(out.ToSource(off))
	}
	out.Bytes = len(out.Query)
	out.Class = Classify(out.Query)
	if out.Bytes > MaxSentBytes {
		planned := out
		return Planned{}, &PlanError{Kind: ErrSentTooLarge, Message: "the planned query is over 65536 bytes",
			Fields: []FieldError{{Pointer: "/query", MessageKey: "query.sent_too_large"}}, Planned: &planned}
	}
	return out, nil
}

// Plan is Prepare, then Plan at in.StepMs: LogQL reserved selectors have no step floor (T07 §4.3),
// so Resolve is the identity.
func Plan(in Inputs) (Planned, *PlanError) {
	p, err := Prepare(in)
	if err != nil {
		return Planned{}, err
	}
	return p.Plan(in.StepMs)
}
