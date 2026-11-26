// Package spec is the board spec (plan #61 §3.4; v2 by plan #64 Part B §3.1, v3 by #173 Part 1, v4 by
// #215): strict,
// presence-aware decoding, validation with JSON-pointer field errors, the upcaster entry point
// (T11 §4.0), canonical JSON and the RFC 6902 patch recorded in the audit trail (T11-006).
package spec

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
)

// BoardSchemaVersion is the current board spec version, stored in board_versions.schema_version:
// 2 adds vis.thresholds and vis.legend (#64 Part B); 3 adds vis.options and the kinds barchart and
// pie (#173); 4 adds tags (#215, T24-029). Each version is a subset of the next.
const BoardSchemaVersion int64 = 4 // adds tags (#215)

// Board is a board spec. Panels are the ungrouped panels drawn above the sections. Tags are 0 to
// 16 unique AnnotationTags in their order; an empty list is the same as none (no key).
type Board struct {
	Title    string     `json:"title"`
	Time     *TimeRange `json:"time,omitempty"`
	Tags     []string   `json:"tags,omitempty"`
	Panels   []Panel    `json:"panels"`
	Sections []Section  `json:"sections"`
}

// TimeRange is the board's saved time range: relative (now, now/d, now-6h) or RFC 3339.
type TimeRange struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// Section is a titled group of panels with its own grid; a collapsed section renders and queries
// nothing.
type Section struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Collapsed bool    `json:"collapsed"`
	Panels    []Panel `json:"panels"`
}

// Panel is one panel of a grid.
type Panel struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Grid  Grid   `json:"grid"`
	Query *Query `json:"query,omitempty"`
	Vis   Vis    `json:"vis"`
}

// Grid is a panel's position in its grid of 12 columns: column X, row Y, W columns, H rows.
type Grid struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

// Query is a panel's query: Lang promql or logql.
type Query struct {
	Lang string `json:"lang"`
	Text string `json:"text"`
}

// Vis is a panel's visualisation: auto, line, bars, heatmap, stat, logs, barchart or pie.
type Vis struct {
	Kind       string      `json:"kind"`
	Thresholds *Thresholds `json:"thresholds,omitempty"`
	Legend     *Legend     `json:"legend,omitempty"`
	Options    *Options    `json:"options,omitempty"`
}

// visJSON is Vis with its options kept raw (UnmarshalJSON).
type visJSON struct {
	Kind       string          `json:"kind"`
	Thresholds *Thresholds     `json:"thresholds"`
	Legend     *Legend         `json:"legend"`
	Options    json.RawMessage `json:"options"`
}

// UnmarshalJSON decodes a vis whose shape is clean. The shape pass checks options only for a kind
// in visKinds, so the options of any other kind are not decoded: Validate reports that kind, and
// the spec is refused.
func (v *Vis) UnmarshalJSON(b []byte) error {
	var r visJSON
	if err := json.Unmarshal(b, &r); err != nil {
		return err
	}
	*v = Vis{Kind: r.Kind, Thresholds: r.Thresholds, Legend: r.Legend}
	if len(r.Options) == 0 || !slices.Contains(visKinds, r.Kind) {
		return nil
	}
	return json.Unmarshal(r.Options, &v.Options)
}

// Options are a panel's vis.options (board spec v3, T22 §6.1): one optional key per field, in
// OPTION_ORDER. Which keys a kind allows is the shape pass's (optionShape); the values are
// Validate's (board.options.<key>.invalid).
type Options struct {
	Reducer        *string  `json:"reducer,omitempty"`
	BaselineOffset *string  `json:"baselineOffset,omitempty"`
	CategoryBy     *string  `json:"categoryBy,omitempty"`
	Sort           *string  `json:"sort,omitempty"`
	Orientation    *string  `json:"orientation,omitempty"`
	ValueLabels    *bool    `json:"valueLabels,omitempty"`
	Min            *float64 `json:"min,omitempty"`
	Max            *float64 `json:"max,omitempty"`
	Donut          *bool    `json:"donut,omitempty"`
	Labels         *string  `json:"labels,omitempty"`
	Parts          *bool    `json:"parts,omitempty"`
	Layout         *string  `json:"layout,omitempty"`
	ColourMode     *string  `json:"colourMode,omitempty"`
	TextMode       *string  `json:"textMode,omitempty"`
	GraphMode      *string  `json:"graphMode,omitempty"`
}

// Thresholds are a panel's absolute threshold steps (1 to 8, distinct values); Direction is above
// (worse when the value is at or above a step) or below.
type Thresholds struct {
	Direction string          `json:"direction"`
	Steps     []ThresholdStep `json:"steps"`
}

// ThresholdStep is one threshold: a value (0, or 1e-9 <= |value| <= 1e15), a state (watch,
// degraded or failing) and a label of at most 200 runes ("" = the value as text).
type ThresholdStep struct {
	Value float64 `json:"value"`
	State string  `json:"state"`
	Label string  `json:"label"`
}

// Legend is a panel's legend; Mode is table or hidden.
type Legend struct {
	Mode string `json:"mode"`
}

// ErrSchemaTooNew is returned for a spec written by a newer server (rolling upgrade, N+1).
var ErrSchemaTooNew = errors.New("spec: schema version is newer than this server")

// ErrSchemaVersion is returned for a schema version below 1.
var ErrSchemaVersion = errors.New("spec: invalid schema version")

// FieldError is one problem: a JSON pointer into the spec and a message key the client
// translates.
type FieldError struct{ Pointer, MessageKey string }

// ValidationError lists the problems of a spec in document order, at most 50.
type ValidationError struct{ Fields []FieldError }

func (e *ValidationError) Error() string { return "invalid board" }

// maxFieldErrors bounds the field errors of one spec.
const maxFieldErrors = 50

// ParseBoard strictly decodes a spec of the current version and validates it: exact keys, every
// key present, no null, no duplicate key, integer grid values and no trailing data (shape.go),
// then the semantic rules (validate.go). Every problem is a *ValidationError.
func ParseBoard(raw []byte) (Board, error) {
	if fields := checkShape(raw); len(fields) > 0 {
		return Board{}, &ValidationError{Fields: fields}
	}
	var b Board
	if err := json.Unmarshal(raw, &b); err != nil {
		// The shape pass accepted raw, so this cannot happen; report it as invalid JSON anyway.
		return Board{}, &ValidationError{Fields: []FieldError{{Pointer: "", MessageKey: keyInvalid}}}
	}
	if err := b.Validate(); err != nil {
		return Board{}, err
	}
	return b, nil
}

// DecodeBoard decodes a stored spec of schemaVersion into the current version (the upcaster, T11
// §4.0): DecodeBoardUpTo with BoardSchemaVersion.
func DecodeBoard(raw []byte, schemaVersion int64) (Board, error) {
	return DecodeBoardUpTo(raw, schemaVersion, BoardSchemaVersion)
}

// DecodeBoardUpTo decodes a stored spec of schemaVersion when schemaMax is the newest version the
// caller reads. Versions 1 to 4 decode unchanged (each is a subset of the next: the identity upcast); a
// version above schemaMax returns ErrSchemaTooNew and a version below 1 ErrSchemaVersion. With
// schemaMax 1 it decodes as the previous release did (plan #64 Part B §4.7).
func DecodeBoardUpTo(raw []byte, schemaVersion, schemaMax int64) (Board, error) {
	switch {
	case schemaVersion < 1:
		return Board{}, fmt.Errorf("%w: %d", ErrSchemaVersion, schemaVersion)
	case schemaVersion > schemaMax:
		return Board{}, fmt.Errorf("%w: %d", ErrSchemaTooNew, schemaVersion)
	}
	b, err := ParseBoard(raw)
	if err != nil {
		return Board{}, fmt.Errorf("spec: stored board: %w", err)
	}
	return b, nil
}
