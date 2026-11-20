// Package telemetry builds the structured logger of the BFF.
package telemetry

import (
	"fmt"
	"io"
	"log/slog"
)

// NewLogger returns a slog logger writing to w at level (debug, info, warn, error) in format
// (json, text).
func NewLogger(level, format string, w io.Writer) (*slog.Logger, error) {
	var l slog.Level
	switch level {
	case "debug":
		l = slog.LevelDebug
	case "info":
		l = slog.LevelInfo
	case "warn":
		l = slog.LevelWarn
	case "error":
		l = slog.LevelError
	default:
		return nil, fmt.Errorf("invalid log level %q (want debug, info, warn or error)", level)
	}
	opts := &slog.HandlerOptions{Level: l}
	switch format {
	case "json":
		return slog.New(slog.NewJSONHandler(w, opts)), nil
	case "text":
		return slog.New(slog.NewTextHandler(w, opts)), nil
	default:
		return nil, fmt.Errorf("invalid log format %q (want json or text)", format)
	}
}
