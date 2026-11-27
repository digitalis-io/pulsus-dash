package pulsusdb

import (
	"errors"
	"slices"
)

// Grid is the aligned request grid, in ms: Start, Start+Step, …, End.
type Grid struct{ Start, End, Step int64 }

// PromLadder is the PromQL step ladder in ms (#303): T07's NICE ladder from the 15 s scrape
// interval up to 1 d, so a step is never below the scrape interval.
var PromLadder = []int64{15e3, 30e3, 60e3, 120e3, 300e3, 600e3, 720e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3,
	21600e3, 43200e3, 86400e3}

// Ladder is the log routes' step ladder in ms (#62's step rule, kept by #303 for LogGrid).
var Ladder = []int64{1e3, 5e3, 10e3, 15e3, 30e3, 60e3, 300e3, 900e3, 3600e3, 21600e3, 86400e3}

// maxSteps bounds the number of steps of a grid.
const maxSteps = 11000

// ErrRangeTooLong is returned when the range needs more than 11000 steps of 1 d.
var ErrRangeTooLong = errors.New("the range needs more than 11000 steps of 1 d")

// PromGrid returns the PromQL grid of a chart widthPx wide over [fromMs, toMs] (#303): about one
// point per CSS pixel. The step is the PromLadder entry nearest to (toMs − fromMs) / widthPx,
// the larger of two neighbours from their midpoint up (2 × span ≥ (lo + hi) × width), so a chart
// gets 0.7 to 1.75 points per pixel; it is at least 15 s and is raised to the next entry while
// the grid would have more than 11 000 steps. Start is fromMs floored to the step and end is
// toMs raised to it (alignment as T07-003). Integer arithmetic only.
func PromGrid(fromMs, toMs int64, widthPx int) (Grid, error) {
	span := max(toMs-fromMs, 0)
	w := int64(max(widthPx, 1))
	i := 0
	for i+1 < len(PromLadder) && 2*span >= (PromLadder[i]+PromLadder[i+1])*w {
		i++
	}
	for ; ; i++ {
		g := align(fromMs, toMs, PromLadder[i])
		if (g.End-g.Start)/g.Step <= maxSteps {
			return g, nil
		}
		if i+1 == len(PromLadder) {
			return Grid{}, ErrRangeTooLong
		}
	}
}

// ErrStepNotOnLadder is returned for a requested step that is not a PromLadder entry (#304 §A.1).
var ErrStepNotOnLadder = errors.New("step_ms must be a step of the ladder")

// PromGridStep is the PromQL grid at a step the client chose (#304 §A.1): stepMs must be a
// PromLadder entry (else ErrStepNotOnLadder); start is fromMs floored to it and end toMs raised to
// it, as PromGrid aligns; more than 11 000 steps is ErrRangeTooLong. The range store asks for
// bucket-aligned runs, so its grids are exactly the points it asked for.
func PromGridStep(fromMs, toMs, stepMs int64) (Grid, error) {
	if !slices.Contains(PromLadder, stepMs) {
		return Grid{}, ErrStepNotOnLadder
	}
	g := align(fromMs, toMs, stepMs)
	if (g.End-g.Start)/g.Step > maxSteps {
		return Grid{}, ErrRangeTooLong
	}
	return g, nil
}

// LogGrid returns the grid of the log routes (#62's rule, unchanged by #303): the step is the
// first Ladder entry with entry × widthPx ≥ toMs − fromMs (else 1 d), start is fromMs floored to
// the step and end is toMs raised to it. Integer arithmetic only.
func LogGrid(fromMs, toMs int64, widthPx int) (Grid, error) {
	span := max(toMs-fromMs, 0)
	w := int64(max(widthPx, 1))
	step := Ladder[len(Ladder)-1]
	for _, e := range Ladder {
		if e*w >= span {
			step = e
			break
		}
	}
	g := align(fromMs, toMs, step)
	if (g.End-g.Start)/step > maxSteps {
		return Grid{}, ErrRangeTooLong
	}
	return g, nil
}

// align floors fromMs and raises toMs to step.
func align(fromMs, toMs, step int64) Grid {
	return Grid{Start: floorDiv(fromMs, step) * step, End: -floorDiv(-toMs, step) * step, Step: step}
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if (a%b != 0) && ((a < 0) != (b < 0)) {
		q--
	}
	return q
}

// points is the number of grid points.
func (g Grid) points() int { return int((g.End-g.Start)/g.Step) + 1 }
