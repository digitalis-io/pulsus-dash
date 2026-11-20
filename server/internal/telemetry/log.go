// Package telemetry builds the structured logger.
package telemetry

import (
	"io"
	"log/slog"
)

// NewLogger is not implemented yet.
func NewLogger(level, format string, w io.Writer) (*slog.Logger, error) {
	return slog.New(slog.NewTextHandler(io.Discard, nil)), nil
}
