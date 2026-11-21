package pulsusfake

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"path"
	"slices"
	"strings"
)

// Transcript is one recorded PulsusDB exchange (plan #62 §4.7, A.1).
type Transcript struct {
	Name       string     `json:"name"`
	Provenance Provenance `json:"provenance"`
	Match      Match      `json:"match"`
	Response   Response   `json:"response"`
}

// Provenance says where a transcript came from: captured from a development PulsusDB and
// sanitised (labels, values, timestamps and query ids replaced; no host, URL or tenant kept), or
// synthetic with the reason no capture exists.
type Provenance struct {
	Captured  string `json:"captured,omitempty"`  // YYYY-MM-DD
	PulsusDB  string `json:"pulsusdb,omitempty"`  // version reported by the capture
	Route     string `json:"route,omitempty"`     // the route captured
	Sanitised string `json:"sanitised,omitempty"` // what was replaced
	Synthetic string `json:"synthetic,omitempty"` // reason; exclusive with Captured
}

// Match selects the requests a transcript answers: the method, one of the paths and, if set,
// the form's query byte for byte.
type Match struct {
	Method string            `json:"method"`
	Paths  []string          `json:"paths"`
	Query  *string           `json:"query,omitempty"`
	Form   map[string]string `json:"form,omitempty"`
}

// Response is what the fake answers. Body is served byte for byte as it appears in the file.
type Response struct {
	Status   int               `json:"status"`
	Headers  map[string]string `json:"headers"`
	Body     json.RawMessage   `json:"body"`
	DelayMs  int               `json:"delay_ms"`
	Hang     bool              `json:"hang"`
	BodyText *string           `json:"body_text,omitempty"`
}

//go:embed testdata/*.json
var embedded embed.FS

// Load reads every *.json transcript of fsys, sorted by file name. A file that is not one
// transcript, a duplicate name or a missing (or double) provenance is an error.
func Load(fsys fs.FS) ([]Transcript, error) {
	names, err := fs.Glob(fsys, "*.json")
	if err != nil {
		return nil, fmt.Errorf("pulsusfake: %w", err)
	}
	slices.Sort(names)
	seen := map[string]bool{}
	out := make([]Transcript, 0, len(names))
	for _, n := range names {
		b, err := fs.ReadFile(fsys, n)
		if err != nil {
			return nil, fmt.Errorf("pulsusfake: %s: %w", n, err)
		}
		var t Transcript
		dec := json.NewDecoder(strings.NewReader(string(b)))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&t); err != nil {
			return nil, fmt.Errorf("pulsusfake: %s: %w", n, err)
		}
		p := t.Provenance
		switch {
		case t.Name == "":
			return nil, fmt.Errorf("pulsusfake: %s: no name", n)
		case seen[t.Name]:
			return nil, fmt.Errorf("pulsusfake: %s: duplicate name %q", n, t.Name)
		case (p.Captured == "") == (p.Synthetic == ""):
			return nil, fmt.Errorf("pulsusfake: %s: provenance must be either captured or synthetic", n)
		case t.Match.Method == "" || len(t.Match.Paths) == 0:
			return nil, fmt.Errorf("pulsusfake: %s: match needs a method and paths", n)
		}
		seen[t.Name] = true
		out = append(out, t)
	}
	return out, nil
}

// Default returns the embedded transcripts (testdata/*.json).
func Default() []Transcript {
	sub, err := fs.Sub(embedded, "testdata")
	if err != nil {
		panic(err) // the embedded tree is fixed at build time
	}
	ts, err := Load(sub)
	if err != nil {
		panic(err) // the embedded transcripts are checked by unit:fake-transcripts
	}
	return ts
}

func (t Transcript) matches(method, p string, query string, hasQuery bool) bool {
	if t.Match.Method != method || !slices.Contains(t.Match.Paths, path.Clean(p)) {
		return false
	}
	if t.Match.Query == nil {
		return true
	}
	return hasQuery && *t.Match.Query == query
}
