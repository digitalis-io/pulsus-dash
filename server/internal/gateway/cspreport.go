package gateway

import (
	"net/http"

	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
)

// newCSPReport returns the POST /api/dash/v1/csp-report handler (T18-003).
func newCSPReport(Deps) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		WriteError(w, http.StatusNotFound, api.NotFound, "not found")
	})
}
