package logs

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

// fixturePath is the shared LogQL planner fixture (plan #116 §3.5), run here and by the client's
// StubApi mirror; promFixturePath is the PromQL one, whose tables logql.json repeats.
const (
	fixturePath     = "../../../../wire/fixtures/plan/logql.json"
	promFixturePath = "../../../../wire/fixtures/plan/promql.json"
)

// text is a fixture Text: a JSON string or {"concat": [string | {"repeat": Text, "count": n}]}
// (the rules of prom/fixture_test.go; test files cannot share them across packages).
type text string

func (t *text) UnmarshalJSON(b []byte) error {
	s, err := expandText(b)
	*t = text(s)
	return err
}

func expandText(b []byte) (string, error) {
	if b = bytes.TrimSpace(b); len(b) > 0 && b[0] == '"' {
		var s string
		err := json.Unmarshal(b, &s)
		return s, err
	}
	var c struct {
		Concat []json.RawMessage `json:"concat"`
	}
	if err := json.Unmarshal(b, &c); err != nil || c.Concat == nil {
		return "", fmt.Errorf("fixture: not a Text: %.60s", b)
	}
	var sb strings.Builder
	for _, part := range c.Concat {
		if p := bytes.TrimSpace(part); len(p) > 0 && p[0] == '"' {
			var s string
			if err := json.Unmarshal(p, &s); err != nil {
				return "", err
			}
			sb.WriteString(s)
			continue
		}
		var r struct {
			Repeat json.RawMessage `json:"repeat"`
			Count  int             `json:"count"`
		}
		if err := json.Unmarshal(part, &r); err != nil || r.Repeat == nil {
			return "", fmt.Errorf("fixture: not a concat part: %.60s", part)
		}
		s, err := expandText(r.Repeat)
		if err != nil {
			return "", err
		}
		sb.WriteString(strings.Repeat(s, r.Count))
	}
	return sb.String(), nil
}

type fxPlanned struct {
	Query    text  `json:"query"`
	Expanded text  `json:"expanded"`
	Bytes    int   `json:"bytes"`
	StepMs   int64 `json:"step_ms"`
}

func (p fxPlanned) wire() PlannedWire {
	return PlannedWire{Query: string(p.Query), Expanded: string(p.Expanded), Bytes: p.Bytes, StepMs: p.StepMs}
}

type fxField struct {
	Pointer    string `json:"pointer"`
	MessageKey string `json:"message_key"`
}

type fxError struct {
	Status  int       `json:"status"`
	Message string    `json:"message"`
	Fields  []fxField `json:"fields"`
	// Position is row 9b's byte offset into the raw text (plan #121 §3.3); absent means none.
	Position *int       `json:"position"`
	Hint     *fxHint    `json:"hint"`
	Planned  *fxPlanned `json:"planned"`
}

type fxHint struct {
	Reason string `json:"reason"`
}

// fxFacts are the facts of a class a parity entry compares: its source and reserved set.
type fxFacts struct {
	Class    string   `json:"class"`
	Reserved []string `json:"reserved"`
}

type fxWant struct {
	SameClass *bool    `json:"same_class"`
	Prepared  *fxFacts `json:"prepared"`
	Planned   *fxFacts `json:"planned"`
}

type fxSpan struct {
	Text     string `json:"text"` // "prepared" or "planned": the class the span belongs to
	From     int    `json:"from"`
	To       int    `json:"to"`
	Reserved bool   `json:"reserved"`
}

type fxCase struct {
	Name   string `json:"name"`
	From   string `json:"from"`
	Inputs struct {
		Query  text              `json:"query"`
		Vars   map[string]string `json:"vars"`
		Kind   string            `json:"kind"`
		StepMs int64             `json:"step_ms"`
	} `json:"inputs"`
	Substituted *text      `json:"substituted"`
	Want        *fxWant    `json:"want"`
	Selectors   []fxSpan   `json:"selectors"`
	Planned     *fxPlanned `json:"planned"`
	Error       *fxError   `json:"error"`
	ToSource    [][2]*int  `json:"to_source"`
}

func (c fxCase) inputs() Inputs {
	k := KindRange
	if c.Inputs.Kind == "volume" {
		k = KindVolume
	}
	return Inputs{Query: string(c.Inputs.Query), Vars: c.Inputs.Vars, Kind: k, StepMs: c.Inputs.StepMs}
}

type fxClassify struct {
	Name string            `json:"name"`
	Text text              `json:"text"`
	Vars map[string]string `json:"vars"`
	// PreparePosition is the offset at which Prepare refuses the text with row 9b (plan #121
	// §3.3): present on exactly the entries whose text holds a top-level '#'.
	PreparePosition *int `json:"prepare_position"`
	Want            struct {
		Class     string   `json:"class"`
		Reserved  []string `json:"reserved"`
		Selectors []struct {
			Reserved bool `json:"reserved"`
			Text     text `json:"text"`
		} `json:"selectors"`
	} `json:"want"`
}

type fxRateWindow struct {
	StepMs   int64  `json:"step_ms"`
	WindowMs int64  `json:"window_ms"`
	Text     string `json:"text"`
}

type fxDuration struct {
	Ms   int64  `json:"ms"`
	Text string `json:"text"`
}

type fixture struct {
	Version  int          `json:"version"`
	Classify []fxClassify `json:"classify"`
	Plan     []fxCase     `json:"plan"`
	Reserved []struct {
		Text text    `json:"text"`
		Want *string `json:"want"`
	} `json:"reserved"`
	RateWindow  []fxRateWindow `json:"rate_window"`
	Durations   []fxDuration   `json:"durations"`
	VolumeRange []struct {
		StepMs int64  `json:"step_ms"`
		Text   string `json:"text"`
	} `json:"volume_range"`
}

// readFixture reads the shared fixture; unknown members fail, so a typo never hides a case.
func readFixture() (fixture, error) {
	var f fixture
	b, err := os.ReadFile(fixturePath)
	if err != nil {
		return f, err
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&f); err != nil {
		return f, fmt.Errorf("fixture: %w", err)
	}
	return f, nil
}

// loadFixture is readFixture with its checks, for a test.
func loadFixture(t *testing.T) fixture {
	t.Helper()
	f, err := readFixture()
	if err != nil {
		t.Fatal(err)
	}
	if f.Version != 1 || len(f.Plan) == 0 || len(f.Classify) == 0 {
		t.Fatalf("fixture: version %d, %d plan cases, %d classify cases", f.Version, len(f.Plan), len(f.Classify))
	}
	return f
}

// promTables are the two tables of promql.json that logql.json repeats unchanged.
type promTables struct {
	RateWindow []fxRateWindow `json:"rate_window"`
	Durations  []fxDuration   `json:"durations"`
}

func loadPromTables(t *testing.T) promTables {
	t.Helper()
	b, err := os.ReadFile(promFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var p promTables
	if err := json.Unmarshal(b, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

// LoadFixture and ReadFixture export the loader to the external test package of selector_test.go.
// That file imports pulsusdb (its byte guard); an internal test that did would be an import cycle
// the moment a core package imported logs, as the logsInCore depguard fixture does.
func LoadFixture(t *testing.T) fixture { return loadFixture(t) }

// ReadFixture is readFixture, for the external test package.
func ReadFixture() (fixture, error) { return readFixture() }
