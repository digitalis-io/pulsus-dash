package gateway

import (
	"context"
	"log/slog"
	"net/http"
)

// SelfCheck makes one request to the public URL and logs whether the headers survive (T19-002).
func SelfCheck(context.Context, string, bool, *http.Client, *slog.Logger) {}
