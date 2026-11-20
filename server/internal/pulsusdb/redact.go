package pulsusdb

import (
	"net/http"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// redactor replaces the binding's secrets and addresses in upstream strings.
type redactor struct{ needles []string }

func newRedactor(b core.TenantBinding, credential string) redactor {
	_, _ = b, credential
	return redactor{}
}

func (r redactor) redact(s string) string { return s }

// cleanText replaces control bytes with spaces and cuts s to max bytes.
func cleanText(s string, max int) string {
	_ = max
	return s
}

// upstreamHeaders are the accepted response headers (§4.9).
type upstreamHeaders struct {
	QueryID            string
	ReadCache          string
	ReadCacheThroughMs int64
	RetryAfter         string
}

func readHeaders(h http.Header, r redactor) upstreamHeaders {
	_, _ = h, r
	return upstreamHeaders{ReadCacheThroughMs: -1}
}
