// Package spec is the board spec v1 (plan #61 §3.4): strict decoding, validation, the upcaster,
// canonical JSON and the RFC 6902 patch of the audit trail.
package spec

import "errors"

// BoardSchemaVersion is the current board spec version.
const BoardSchemaVersion int64 = 1

// Board is a board spec.
type Board struct {
	Title    string     `json:"title"`
	Time     *TimeRange `json:"time,omitempty"`
	Panels   []Panel    `json:"panels"`
	Sections []Section  `json:"sections"`
}

// TimeRange is the saved time range.
type TimeRange struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// Section groups panels.
type Section struct {
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Collapsed bool    `json:"collapsed"`
	Panels    []Panel `json:"panels"`
}

// Panel is one panel.
type Panel struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Grid  Grid   `json:"grid"`
	Query Query  `json:"query"`
	Vis   Vis    `json:"vis"`
}

// Grid is the panel position.
type Grid struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

// Query is the panel query.
type Query struct {
	Lang string `json:"lang"`
	Text string `json:"text"`
}

// Vis is the visualisation.
type Vis struct {
	Kind string `json:"kind"`
}

// ErrSchemaTooNew is returned for a newer schema version.
var ErrSchemaTooNew = errors.New("spec: schema version is newer than this server")

// ErrSchemaVersion is returned for an invalid schema version.
var ErrSchemaVersion = errors.New("spec: invalid schema version")

// FieldError is one field error.
type FieldError struct{ Pointer, MessageKey string }

// ValidationError lists the field errors.
type ValidationError struct{ Fields []FieldError }

func (e *ValidationError) Error() string { return "invalid board" }

// ParseBoard is a stub.
func ParseBoard(raw []byte) (Board, error) { return Board{}, &ValidationError{} }

// DecodeBoard is a stub.
func DecodeBoard(raw []byte, schemaVersion int64) (Board, error) { return Board{}, nil }

// Validate is a stub.
func (b Board) Validate() error { return nil }

// Canonical is a stub.
func Canonical(v any) ([]byte, error) { return nil, nil }

// ContentHash is a stub.
func ContentHash(canon []byte) [32]byte { return [32]byte{} }

// Diff is a stub.
func Diff(from, to []byte) ([]byte, error) { return []byte("[]"), nil }
