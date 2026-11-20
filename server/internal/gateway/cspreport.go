package gateway

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
)

// csp-report limits (plan #59 §3.6, T18-003, T06-021).
const (
	cspMaxBody         = 64 << 10
	cspMaxReports      = 20
	cspSlots           = 8
	cspRatePerSecond   = 10
	cspBurst           = 20
	cspDefaultDeadline = 5 * time.Second
)

// cspDirectives are the directive names logged as themselves; any other value is "other".
var cspDirectives = []string{
	"default-src", "script-src", "script-src-elem", "script-src-attr", "style-src", "style-src-elem",
	"style-src-attr", "img-src", "font-src", "connect-src", "worker-src", "manifest-src", "media-src",
	"frame-src", "child-src", "base-uri", "form-action", "object-src", "frame-ancestors",
	"require-trusted-types-for", "trusted-types",
}

// cspRoutes are the client's route patterns; a report's document path is logged as the pattern it
// matches, never as the path.
var cspRoutes = []string{
	"/", "/signed-out", "/t/:tenant", "/t/:tenant/boards", "/t/:tenant/board/:uid",
	"/t/:tenant/explore/metrics", "/t/:tenant/explore/logs", "/t/:tenant/admin",
}

// cspBlockedKeywords are blockedURL values that name a category rather than a URL.
var cspBlockedKeywords = []string{"inline", "eval", "wasm-eval", "trusted-types-policy", "trusted-types-sink"}

// cspReport is the POST /api/dash/v1/csp-report handler. Reports are logged only as allowlisted
// values (directive, disposition, route pattern, blocked category) until OTel export exists.
type cspReport struct {
	log      *slog.Logger
	now      func() time.Time
	deadline time.Duration
	slots    chan struct{}

	mu     sync.Mutex // guards the bucket; held only for the arithmetic
	tokens float64
	last   time.Time
}

// newCSPReport returns the handler with its own process-wide bucket and slots.
func newCSPReport(d Deps) http.Handler {
	c := &cspReport{log: d.Logger, now: d.Now, deadline: d.CSPReadTimeout, slots: make(chan struct{}, cspSlots), tokens: cspBurst}
	if c.log == nil {
		c.log = slog.New(slog.DiscardHandler)
	}
	if c.now == nil {
		c.now = time.Now
	}
	if c.deadline <= 0 {
		c.deadline = cspDefaultDeadline
	}
	return c
}

// take reports whether the token bucket (10 per second, burst 20) has a token, and spends it.
func (c *cspReport) take() bool {
	now := c.now()
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.last.IsZero() {
		if dt := now.Sub(c.last).Seconds(); dt > 0 {
			c.tokens = min(cspBurst, c.tokens+dt*cspRatePerSecond)
		}
	}
	c.last = now
	if c.tokens < 1 {
		return false
	}
	c.tokens--
	return true
}

// refuse writes an error envelope and closes the connection, so that the server never reads the
// rest of an unread body.
func refuse(w http.ResponseWriter, status int, code api.ErrorCode, msg string) {
	w.Header().Set("Connection", "close")
	WriteError(w, status, code, msg)
}

func (c *cspReport) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	// The rate and the slots are checked before any byte of the body is read.
	if !c.take() {
		c.rateLimited(w)
		return
	}
	select {
	case c.slots <- struct{}{}:
		defer func() { <-c.slots }()
	default:
		c.rateLimited(w)
		return
	}
	legacy, ok := cspMediaType(r.Header.Get("Content-Type"))
	if !ok {
		refuse(w, http.StatusUnsupportedMediaType, api.Invalid, "unsupported media type")
		return
	}
	// The body is never read without a deadline. The deadline is on the real connection, so it is
	// wall-clock time, not the rate limiter's clock.
	if err := http.NewResponseController(w).SetReadDeadline(time.Now().Add(c.deadline)); err != nil {
		c.log.ErrorContext(ctx, "csp_report_no_deadline", "error", err.Error())
		refuse(w, http.StatusInternalServerError, api.Internal, "internal error")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, cspMaxBody))
	if err != nil {
		var tooLarge *http.MaxBytesError
		switch {
		case errors.As(err, &tooLarge):
			refuse(w, http.StatusRequestEntityTooLarge, api.Invalid, "payload too large")
		case errors.Is(err, os.ErrDeadlineExceeded):
			refuse(w, http.StatusRequestTimeout, api.Invalid, "request timeout")
		default:
			refuse(w, http.StatusBadRequest, api.Invalid, "bad request")
		}
		return
	}
	reports, ok := parseCSPReports(body, legacy)
	if !ok {
		WriteError(w, http.StatusBadRequest, api.Invalid, "bad request")
		return
	}
	if len(reports) > cspMaxReports {
		c.log.WarnContext(ctx, "csp_report_truncated", "ignored", len(reports)-cspMaxReports)
		reports = reports[:cspMaxReports]
	}
	for _, rep := range reports {
		c.log.WarnContext(ctx, "csp_violation",
			"directive", rep.directive(), "disposition", rep.disposition(),
			"route", rep.route(), "blocked", rep.blocked())
	}
	w.WriteHeader(http.StatusNoContent)
}

func (c *cspReport) rateLimited(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "1")
	refuse(w, http.StatusTooManyRequests, api.Unavailable, "rate limited")
}

// cspMediaType reports whether ct is accepted, and whether it is the legacy report format.
func cspMediaType(ct string) (legacy, ok bool) {
	mt, _, err := mime.ParseMediaType(ct)
	if err != nil {
		return false, false
	}
	switch mt {
	case "application/reports+json":
		return false, true
	case "application/csp-report":
		return true, true
	}
	return false, false
}

// cspFields are the fields of one report in either format; only the allowlisted ones are read.
type cspFields map[string]json.RawMessage

func (f cspFields) str(key string) string {
	var s string
	if raw, ok := f[key]; ok && json.Unmarshal(raw, &s) == nil {
		return s
	}
	return ""
}

// cspViolation is one report, with the field names of its format.
type cspViolation struct {
	f      cspFields
	legacy bool
}

// get reads the field named modern (Reporting API) or old (application/csp-report).
func (v cspViolation) get(modern, old string) string {
	if v.legacy {
		return v.f.str(old)
	}
	return v.f.str(modern)
}

// parseCSPReports returns the csp-violation reports of body, or false for invalid JSON.
func parseCSPReports(body []byte, legacy bool) ([]cspViolation, bool) {
	if legacy {
		var doc struct {
			Report cspFields `json:"csp-report"`
		}
		if json.Unmarshal(body, &doc) != nil {
			return nil, false
		}
		if doc.Report == nil {
			return nil, true
		}
		return []cspViolation{{f: doc.Report, legacy: true}}, true
	}
	var list []struct {
		Type string    `json:"type"`
		Body cspFields `json:"body"`
	}
	if json.Unmarshal(body, &list) != nil {
		return nil, false
	}
	out := make([]cspViolation, 0, len(list))
	for _, e := range list {
		if e.Type == "csp-violation" && e.Body != nil {
			out = append(out, cspViolation{f: e.Body})
		}
	}
	return out, true
}

func (v cspViolation) directive() string {
	d := v.get("effectiveDirective", "effective-directive")
	if d == "" {
		d = v.get("violatedDirective", "violated-directive")
	}
	d, _, _ = strings.Cut(d, " ")
	if slices.Contains(cspDirectives, d) {
		return d
	}
	return "other"
}

func (v cspViolation) disposition() string {
	switch d := v.get("disposition", "disposition"); d {
	case "enforce", "report":
		return d
	}
	return "other"
}

func (v cspViolation) route() string {
	u, err := url.Parse(v.get("documentURL", "document-uri"))
	if err != nil {
		return "unknown"
	}
	for _, pattern := range cspRoutes {
		if routeMatches(pattern, u.Path) {
			return pattern
		}
	}
	return "unknown"
}

// routeMatches matches path against pattern: equal segment counts, literal segments equal, and
// one non-empty segment per parameter.
func routeMatches(pattern, path string) bool {
	if pattern == "/" {
		return path == "/"
	}
	ps, xs := strings.Split(pattern, "/"), strings.Split(path, "/")
	if len(ps) != len(xs) {
		return false
	}
	for i := range ps {
		switch {
		case strings.HasPrefix(ps[i], ":"):
			if xs[i] == "" {
				return false
			}
		case ps[i] != xs[i]:
			return false
		}
	}
	return true
}

// blocked is the category of blockedURL: a keyword, data, blob, url, or none when absent.
func (v cspViolation) blocked() string {
	b := v.get("blockedURL", "blocked-uri")
	switch {
	case b == "":
		return "none"
	case slices.Contains(cspBlockedKeywords, b):
		return b
	case b == "data" || strings.HasPrefix(b, "data:"):
		return "data"
	case b == "blob" || strings.HasPrefix(b, "blob:"):
		return "blob"
	}
	return "url"
}
