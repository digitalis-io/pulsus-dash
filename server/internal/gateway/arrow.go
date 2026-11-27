package gateway

import (
	"net/http"

	"github.com/digitalis-io/pulsus-dash/server/internal/arrowwire"
	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	promplan "github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/prom"
)

// Test seams of the range route's DSF tests (arrow_test.go): the writer's limits and the read of
// the next upstream series.
var (
	arrowLimits = arrowwire.DefaultLimits
	nextSeries  = (*pulsusdb.ResultStream).Next
)

// wantsArrow reports whether the request's Accept asks for a DSF body.
func wantsArrow(r *http.Request) bool {
	_ = r
	return false
}

// streamArrow is serveRange's DSF branch.
func (q *dataRoutes) streamArrow(w http.ResponseWriter, r *http.Request, rc *core.RequestCtx, h streamHead,
	planned promplan.Planned, rs *pulsusdb.ResultStream, g pulsusdb.Grid, from int64, first *pulsusdb.Series) {
}

// mapPosition maps PulsusDB's position from the sent text to the raw text.
func mapPosition(err error, p promplan.Planned) error {
	_ = p
	return err
}
