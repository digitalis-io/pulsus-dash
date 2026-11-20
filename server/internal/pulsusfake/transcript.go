package pulsusfake

import (
	"encoding/json"
	"errors"
	"io/fs"
)

// Transcript is one recorded PulsusDB exchange.
type Transcript struct {
	Name       string     `json:"name"`
	Provenance Provenance `json:"provenance"`
	Match      Match      `json:"match"`
	Response   Response   `json:"response"`
}

// Provenance says where a transcript came from.
type Provenance struct {
	Captured  string `json:"captured,omitempty"`
	PulsusDB  string `json:"pulsusdb,omitempty"`
	Route     string `json:"route,omitempty"`
	Sanitised string `json:"sanitised,omitempty"`
	Synthetic string `json:"synthetic,omitempty"`
}

// Match selects the requests a transcript answers.
type Match struct {
	Method string   `json:"method"`
	Paths  []string `json:"paths"`
	Query  *string  `json:"query,omitempty"`
}

// Response is what the fake answers.
type Response struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    json.RawMessage   `json:"body"`
	DelayMs int               `json:"delay_ms"`
	Hang    bool              `json:"hang"`
}

// Load reads every *.json transcript of fsys.
func Load(fsys fs.FS) ([]Transcript, error) {
	_ = fsys
	return nil, errors.New("pulsusfake: not implemented")
}

// Default returns the embedded transcripts.
func Default() []Transcript { return nil }
