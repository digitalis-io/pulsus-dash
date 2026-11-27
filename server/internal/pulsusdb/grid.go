package pulsusdb

import "errors"

// Grid is the aligned request grid, in ms: Start, Start+Step, …, End.
type Grid struct{ Start, End, Step int64 }

// Ladder is the step ladder in ms (the issue's step rule).
var Ladder = []int64{1e3, 5e3, 10e3, 15e3, 30e3, 60e3, 300e3, 900e3, 3600e3, 21600e3, 86400e3}

// PromLadder is the PromQL step ladder (stub, #303).
var PromLadder = Ladder

// LogGrid is the log routes' grid (stub, #303).
func LogGrid(fromMs, toMs int64, widthPx int) (Grid, error) { return PromGrid(fromMs, toMs, widthPx) }

// maxSteps bounds the number of steps of a grid.
const maxSteps = 11000

// ErrRangeTooLong is returned when the range needs more than 11000 steps of 1 d.
var ErrRangeTooLong = errors.New("the range needs more than 11000 steps of 1 d")

// PromGrid returns the grid of a chart widthPx wide over [fromMs, toMs]: the step is the first
// Ladder entry with entry × widthPx ≥ toMs − fromMs (else 1 d), start is fromMs floored to the
// step and end is toMs raised to it (alignment as T07-003). Integer arithmetic only.
func PromGrid(fromMs, toMs int64, widthPx int) (Grid, error) {
	span := max(toMs-fromMs, 0)
	w := int64(max(widthPx, 1))
	step := Ladder[len(Ladder)-1]
	for _, e := range Ladder {
		if e*w >= span {
			step = e
			break
		}
	}
	start := floorDiv(fromMs, step) * step
	end := -floorDiv(-toMs, step) * step
	if (end-start)/step > maxSteps {
		return Grid{}, ErrRangeTooLong
	}
	return Grid{Start: start, End: end, Step: step}, nil
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
