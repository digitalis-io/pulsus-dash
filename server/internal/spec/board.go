// Package spec is the board spec v1 (plan #61 §3.4): strict, presence-aware decoding, validation
// with JSON-pointer field errors, the upcaster entry point (T11 §4.0), canonical JSON and the
// RFC 6902 patch recorded in the audit trail (T11-006).
package spec

import (
	"encoding/json"
	"errors"
	"fmt"
)

// BoardSchemaVersion is the current board spec version, stored in board_versions.schema_version.
const BoardSchemaVersion int64 = 1

// Board is a board spec. Panels are the ungrouped panels drawn above the sections.
type Board struct {
	Title    string     `json:"title"`
	Time     *TimeRange `json:"time,omitempty"`
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
	Query Query  `json:"query"`
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

// Vis is a panel's visualisation: auto, line, bars, heatmap, stat or logs.
type Vis struct {
	Kind string `json:"kind"`
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
// §4.0). Version 1 is current and decodes unchanged; a newer version returns ErrSchemaTooNew and
// a version below 1 ErrSchemaVersion.
func DecodeBoard(raw []byte, schemaVersion int64) (Board, error) {
	switch {
	case schemaVersion < 1:
		return Board{}, fmt.Errorf("%w: %d", ErrSchemaVersion, schemaVersion)
	case schemaVersion > BoardSchemaVersion:
		return Board{}, fmt.Errorf("%w: %d", ErrSchemaTooNew, schemaVersion)
	}
	b, err := ParseBoard(raw)
	if err != nil {
		return Board{}, fmt.Errorf("spec: stored board: %w", err)
	}
	return b, nil
}
