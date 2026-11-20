package pulsusdb

import (
	"encoding/json"
	"errors"
	"os"
	"testing"
)

type stepCase struct {
	From    int64  `json:"from"`
	To      int64  `json:"to"`
	WidthPx int    `json:"width_px"`
	Step    int64  `json:"step"`
	Start   int64  `json:"start"`
	End     int64  `json:"end"`
	Error   string `json:"error"`
}

// unit:promql-step (Go half): every case of wire/fixtures/json/promql-step.json (A.3).
func TestPromGridCases(t *testing.T) {
	b, err := os.ReadFile("../../../wire/fixtures/json/promql-step.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []stepCase
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) != 14 {
		t.Fatalf("%d cases, want 14", len(cases))
	}
	sawErr, saw5s := false, false
	for _, c := range cases {
		g, err := PromGrid(c.From, c.To, c.WidthPx)
		if c.Error == "range" {
			sawErr = true
			if !errors.Is(err, ErrRangeTooLong) {
				t.Errorf("%d..%d @%d: err %v, want ErrRangeTooLong", c.From, c.To, c.WidthPx, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%d..%d @%d: %v", c.From, c.To, c.WidthPx, err)
			continue
		}
		if g != (Grid{Start: c.Start, End: c.End, Step: c.Step}) {
			t.Errorf("%d..%d @%d: %+v, want step %d start %d end %d", c.From, c.To, c.WidthPx, g, c.Step, c.Start, c.End)
		}
		if c.To-c.From == 3_600_000 && c.WidthPx == 1200 && g.Step == 5000 {
			saw5s = true
		}
	}
	if !sawErr || !saw5s {
		t.Error("the corpus lacks the 14 610-day case or the 1 h at 1 200 px case")
	}
}
