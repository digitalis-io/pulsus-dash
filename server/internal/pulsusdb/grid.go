package pulsusdb

import "errors"

// Grid is the aligned request grid, in ms.
type Grid struct{ Start, End, Step int64 }

// Ladder is the step ladder in ms.
var Ladder = []int64{1e3, 5e3, 10e3, 15e3, 30e3, 60e3, 300e3, 900e3, 3600e3, 21600e3, 86400e3}

// ErrRangeTooLong is returned when the range needs more than 11000 steps of 1 d.
var ErrRangeTooLong = errors.New("the range needs more than 11000 steps of 1 d")

// PromGrid returns the step and the aligned range for a chart width_px wide.
func PromGrid(fromMs, toMs int64, widthPx int) (Grid, error) {
	_, _, _ = fromMs, toMs, widthPx
	return Grid{}, nil
}
