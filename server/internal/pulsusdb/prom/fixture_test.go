package prom

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

// fixturePath is the shared planner fixture (plan #112 §3.5), run here and by the client's
// StubApi mirror.
const fixturePath = "../../../../wire/fixtures/plan/promql.json"

// text is a fixture Text: a JSON string or {"concat": [string | {"repeat": Text, "count": n}]}.
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
	Query         text   `json:"query"`
	Expanded      text   `json:"expanded"`
	Bytes         int    `json:"bytes"`
	ValueType     string `json:"value_type"`
	RateCandidate bool   `json:"rate_candidate"`
	RateApplied   bool   `json:"rate_applied"`
	Histogram     bool   `json:"histogram"`
	StepMs        int64  `json:"step_ms"`
	RateWindowMs  int64  `json:"rate_window_ms"`
}

func (p fxPlanned) wire() PlannedWire {
	return PlannedWire{Query: string(p.Query), Expanded: string(p.Expanded), Bytes: p.Bytes, ValueType: p.ValueType,
		RateCandidate: p.RateCandidate, RateApplied: p.RateApplied, Histogram: p.Histogram, StepMs: p.StepMs, RateWindowMs: p.RateWindowMs}
}

type fxField struct {
	Pointer    string `json:"pointer"`
	MessageKey string `json:"message_key"`
}

type fxError struct {
	Status  int        `json:"status"`
	Message string     `json:"message"`
	Fields  []fxField  `json:"fields"`
	Hint    *fxHint    `json:"hint"`
	Planned *fxPlanned `json:"planned"`
}

type fxHint struct {
	Reason string `json:"reason"`
}

type fxShape struct {
	Bare *struct {
		Metric text `json:"metric"`
		From   int  `json:"from"`
		To     int  `json:"to"`
	} `json:"bare"`
	Metrics              []text `json:"metrics"`
	HasHistogramQuantile bool   `json:"has_histogram_quantile"`
	ValueType            string `json:"value_type"`
}

func (s fxShape) shape() Shape {
	out := Shape{Metrics: make([]string, 0, len(s.Metrics)), HasHistogramQuantile: s.HasHistogramQuantile, ValueType: ValueType(s.ValueType)}
	for _, m := range s.Metrics {
		out.Metrics = append(out.Metrics, string(m))
	}
	if s.Bare != nil {
		out.Bare = &BareSelector{Metric: string(s.Bare.Metric), From: s.Bare.From, To: s.Bare.To}
	}
	return out
}

type fxClass struct {
	Source   string   `json:"source"`
	Reserved []string `json:"reserved"`
	FloorMs  int64    `json:"floor_ms"`
}

type fxCase struct {
	Name   string `json:"name"`
	From   string `json:"from"`
	Inputs struct {
		Query  text              `json:"query"`
		Vars   map[string]string `json:"vars"`
		Kind   string            `json:"kind"`
		StepMs int64             `json:"step_ms"`
		// RangeMs is the request window (to − from); 0 or absent = none.
		RangeMs int64 `json:"range_ms"`
		Rate    bool  `json:"rate"`
	} `json:"inputs"`
	Types      map[string]MetricKind `json:"types"`
	NeedsTypes *bool                 `json:"needs_types"`
	Shape      *fxShape              `json:"shape"`
	Group      string                `json:"group"`
	Classify   *fxClass              `json:"classify"`
	Resolve    *struct {
		GridStepMs int64 `json:"grid_step_ms"`
		StepMs     int64 `json:"step_ms"`
	} `json:"resolve"`
	Planned  *fxPlanned `json:"planned"`
	Error    *fxError   `json:"error"`
	ToSource [][2]*int  `json:"to_source"`
}

func (c fxCase) inputs() Inputs {
	k := KindRange
	if c.Inputs.Kind == "instant" {
		k = KindInstant
	}
	return Inputs{Query: string(c.Inputs.Query), Vars: c.Inputs.Vars, Kind: k, Rate: c.Inputs.Rate, StepMs: c.Inputs.StepMs, RangeMs: c.Inputs.RangeMs}
}

type fxFunction struct {
	Name     string   `json:"name"`
	ArgTypes []string `json:"arg_types"`
	Variadic int      `json:"variadic"`
	Return   string   `json:"return"`
}

type fixture struct {
	Version int      `json:"version"`
	Plan    []fxCase `json:"plan"`
	KindOf  []struct {
		Name  string      `json:"name"`
		Types MetricTypes `json:"types"`
		Want  MetricKind  `json:"want"`
	} `json:"kind_of"`
	FromMetadata []struct {
		Metadata map[string][]struct {
			Type string `json:"type"`
			Help string `json:"help"`
			Unit string `json:"unit"`
		} `json:"metadata"`
		Types MetricTypes `json:"types"`
	} `json:"from_metadata"`
	RateWindow []struct {
		StepMs   int64  `json:"step_ms"`
		WindowMs int64  `json:"window_ms"`
		Text     string `json:"text"`
	} `json:"rate_window"`
	Durations []struct {
		Ms   int64  `json:"ms"`
		Text string `json:"text"`
	} `json:"durations"`
	Bytes []struct {
		Text  text `json:"text"`
		Bytes int  `json:"bytes"`
	} `json:"bytes"`
	Reserved []struct {
		Text text    `json:"text"`
		Want *string `json:"want"`
	} `json:"reserved"`
	Functions []fxFunction `json:"functions"`
}

// loadFixture reads the shared fixture; unknown members fail, so a typo never hides a case.
func loadFixture(t *testing.T) fixture {
	t.Helper()
	b, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var f fixture
	if err := dec.Decode(&f); err != nil {
		t.Fatalf("fixture: %v", err)
	}
	if f.Version != 1 || len(f.Plan) == 0 {
		t.Fatalf("fixture: version %d, %d cases", f.Version, len(f.Plan))
	}
	return f
}
