// Package gateway is the HTTP edge of the BFF (T06-001).
package gateway

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
)

// Probe is the readiness view of Postgres.
type Probe interface {
	Ping(ctx context.Context) error
	SchemaVersion(ctx context.Context) (int64, error)
}

// Deps are the gateway's dependencies.
type Deps struct {
	Logger       *slog.Logger
	Probe        Probe
	SchemaLatest int64
}

// New is not implemented yet.
func New(d Deps) http.Handler { return http.NotFoundHandler() }

// WriteError is not implemented yet.
func WriteError(w http.ResponseWriter, status int, code api.ErrorCode, message string) {}
