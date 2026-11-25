package arrowwire

import "github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"

// MaxGridLen is the most points of a grid (dash.grid.len).
const MaxGridLen = 1 << 22

// GridSpec describes one labels/1 + metric_matrix.grid/1 part pair.
type GridSpec struct {
	LabelsPart, DataPart uint32
	Rank                 uint16
	Volatile             bool
	Grid                 pulsusdb.Grid
	Result, Source, Unit string
	RequestedStartMs     int64
	Planned              []byte
}

// GridPart is an open grid part pair.
type GridPart struct{ w *Writer }

// Grid opens a part pair.
func (w *Writer) Grid(s GridSpec, planned Coverage) (*GridPart, error) {
	return nil, errNotImplemented
}

// Add adds one series.
func (p *GridPart) Add(s *pulsusdb.Series) error { return errNotImplemented }

// Flush sends the pending series.
func (p *GridPart) Flush() error { return errNotImplemented }

// Finish closes the part pair with c.
func (p *GridPart) Finish(c Coverage) error { return errNotImplemented }

// Fail closes the part pair with c (partial) and e.
func (p *GridPart) Fail(c Coverage, e ErrorRow) error { return errNotImplemented }
