package pulsusdb

import (
	"encoding/json"
	"errors"
	"os"
	"slices"
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

func loadStepCases(t *testing.T, name string, want int) []stepCase {
	t.Helper()
	b, err := os.ReadFile("../../../wire/fixtures/json/" + name)
	if err != nil {
		t.Fatal(err)
	}
	var cases []stepCase
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) != want {
		t.Fatalf("%s: %d cases, want %d", name, len(cases), want)
	}
	return cases
}

// checkStepCases runs grid over cases and reports whether the corpus has a refused range.
func checkStepCases(t *testing.T, cases []stepCase, grid func(int64, int64, int) (Grid, error)) (sawErr bool) {
	t.Helper()
	for _, c := range cases {
		g, err := grid(c.From, c.To, c.WidthPx)
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
	}
	return sawErr
}

// unit:promql-step (Go half): every case of wire/fixtures/json/promql-step.json (A.3, #303).
func TestPromGridCases(t *testing.T) {
	cases := loadStepCases(t, "promql-step.json", 21)
	if !checkStepCases(t, cases, PromGrid) {
		t.Error("the corpus lacks the 14 610-day case")
	}
	saw := false
	for _, c := range cases {
		if c.To-c.From == 21_600_000 && c.WidthPx == 560 && c.Step == 30_000 {
			saw = true
		}
	}
	if !saw {
		t.Error("the corpus lacks the 6 h at 560 px case (30 s, #303)")
	}
}

// #303: the step is the ladder entry nearest range / width, never below the scrape interval, and
// a grid never has more than 11 000 steps.
func TestPromGridProperties(t *testing.T) {
	if PromLadder[0] != 15_000 || PromLadder[len(PromLadder)-1] != 86_400_000 || !slices.IsSorted(PromLadder) {
		t.Fatalf("PromLadder %v: want 15 s … 1 d, ascending", PromLadder)
	}
	spans := []int64{1, 59_000, 900_000, 3_600_000, 21_600_000, 86_400_000, 604_800_000, 2_592_000_000, 31_536_000_000}
	for _, span := range spans {
		for _, w := range []int{1, 60, 280, 560, 1200, 1600, 3840, 10_000} {
			g, err := PromGrid(0, span, w)
			if errors.Is(err, ErrRangeTooLong) {
				continue
			}
			if err != nil {
				t.Fatalf("%d @%d: %v", span, w, err)
			}
			if g.Step < 15_000 || !slices.Contains(PromLadder, g.Step) {
				t.Errorf("%d @%d: step %d is not a ladder entry of at least 15 s", span, w, g.Step)
			}
			if n := (g.End - g.Start) / g.Step; n > maxSteps {
				t.Errorf("%d @%d: %d steps, over %d", span, w, n, maxSteps)
			}
			// Nearest: no other entry is closer to span / w, unless the step was raised for the
			// 11 000-step limit or the 15 s floor.
			i := slices.Index(PromLadder, g.Step)
			if i > 0 && (g.End-g.Start)/PromLadder[i-1] <= maxSteps && 2*span < (PromLadder[i-1]+g.Step)*int64(w) {
				t.Errorf("%d @%d: step %d, but %d is nearer", span, w, g.Step, PromLadder[i-1])
			}
			if i+1 < len(PromLadder) && 2*span >= (g.Step+PromLadder[i+1])*int64(w) {
				t.Errorf("%d @%d: step %d, but %d is nearer", span, w, g.Step, PromLadder[i+1])
			}
		}
	}
}

// unit:logql-step: LogGrid keeps the #62 rule (first entry of 1 s … 1 d at least range / width)
// for the log routes, whose pages, volume and transcripts sit on it (#303 leaves it unchanged).
func TestLogGridCases(t *testing.T) {
	if !checkStepCases(t, loadStepCases(t, "log-step.json", 14), LogGrid) {
		t.Error("the corpus lacks the 14 610-day case")
	}
}
