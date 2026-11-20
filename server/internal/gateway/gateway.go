// Package gateway is the HTTP edge of the BFF (T06-001): the chi router generated from
// api/openapi.yaml, the error envelope (T06 §5.2), common headers, request IDs, the access log and
// panic recovery.
package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"runtime/debug"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/static"
)

// Probe is the readiness view of Postgres; *store.Db implements it.
type Probe interface {
	Ping(ctx context.Context) error
	SchemaVersion(ctx context.Context) (int64, error)
}

// Deps are the gateway's dependencies.
type Deps struct {
	Logger       *slog.Logger
	Probe        Probe
	SchemaLatest int64
	// Assets is the verified client build; nil serves the API only.
	Assets *static.Set
	Build  core.BuildInfo
	// Bootstrap reads the organisation and its tenant bindings (store.Db.BootstrapView).
	Bootstrap func(ctx context.Context) (core.BootstrapView, error)
	// Now is the csp-report rate limiter's clock; nil means time.Now.
	Now func() time.Time
	// CSPReadTimeout is the csp-report body deadline; 0 means 5 s.
	CSPReadTimeout time.Duration
	// Boards is the boards service; nil (or a zero Org) answers every board route with 503.
	Boards core.Boards
	// Org is the organisation of every request until authentication lands (D12).
	Org core.OrgID
	// AuditPartitions is the audit partition health for /readyz; nil reports unknown.
	AuditPartitions interface{ Check() string }
}

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// New returns the HTTP handler of every route: the generated operations, POST csp-report, the
// verified client assets and the document fallback (plan #59 §3.4).
func New(d Deps) http.Handler {
	if d.Logger == nil {
		d.Logger = slog.New(slog.DiscardHandler)
	}
	r := chi.NewRouter()
	r.Use(commonHeaders, accessLog(d.Logger), recoverer(d.Logger))
	a := assets{set: d.Assets}
	r.NotFound(a.fallback)
	r.Handle("/assets/*", http.HandlerFunc(a.serveAsset))
	r.Method(http.MethodPost, "/api/dash/v1/csp-report", newCSPReport(d))
	r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
		WriteError(w, http.StatusMethodNotAllowed, api.Invalid, "method not allowed")
	})
	badRequest := func(w http.ResponseWriter, _ *http.Request, _ error) {
		WriteError(w, http.StatusBadRequest, api.Invalid, "bad request")
	}
	strict := api.NewStrictHandlerWithOptions(&routes{health: health{deps: d}, meta: meta{deps: d}, boards: boards{deps: d}}, nil, api.StrictHTTPServerOptions{
		RequestErrorHandlerFunc: badRequest,
		ResponseErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			d.Logger.ErrorContext(r.Context(), "response error", "error", err.Error())
			WriteError(w, http.StatusInternalServerError, api.Internal, "internal error")
		},
	})
	return api.HandlerWithOptions(strict, api.ChiServerOptions{BaseRouter: r, ErrorHandlerFunc: badRequest})
}

// routes implements every generated operation: the probes and the meta routes.
type routes struct {
	health
	meta
	boards
}

// WriteError writes the error envelope {"error":{"code":…,"message":…}} (T06 §5.2).
func WriteError(w http.ResponseWriter, status int, code api.ErrorCode, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(api.ErrorEnvelope{Error: api.ErrorBody{Code: code, Message: message}})
}

// commonHeaders sets the headers every gateway response carries, and the request ID.
func commonHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-Id")
		if !requestIDPattern.MatchString(id) {
			id = newRequestID()
		}
		h := w.Header()
		h.Set("Content-Type", "application/json")
		h.Set("Cache-Control", "no-store")
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id)))
	})
}

type requestIDKey struct{}

func newRequestID() string {
	u, err := uuid.NewV7()
	if err != nil {
		// crypto/rand does not fail on supported platforms; keep the header well-formed anyway.
		return uuid.Nil.String()
	}
	return u.String()
}

// statusWriter records the status code for the access log.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

// Unwrap lets http.ResponseController reach the connection (the csp-report read deadline).
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func (s *statusWriter) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

// accessLog writes one msg=http record per request: method, route (the chi pattern, never the
// raw path or query), status, duration_ms and request_id.
func accessLog(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			sw := &statusWriter{ResponseWriter: w}
			next.ServeHTTP(sw, r)
			route := "unmatched"
			if rc := chi.RouteContext(r.Context()); rc != nil && rc.RoutePattern() != "" {
				route = rc.RoutePattern()
			}
			id, _ := r.Context().Value(requestIDKey{}).(string)
			log.InfoContext(r.Context(), "http", "method", r.Method, "route", route, "status", sw.status,
				"duration_ms", time.Since(start).Milliseconds(), "request_id", id)
		})
	}
}

// recoverer turns a handler panic into a 500 envelope and logs the stack at error level.
func recoverer(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				v := recover()
				if v == nil {
					return
				}
				if err, ok := v.(error); ok && errors.Is(err, http.ErrAbortHandler) {
					panic(v)
				}
				log.ErrorContext(r.Context(), "panic", "panic", v, "stack", string(debug.Stack()))
				WriteError(w, http.StatusInternalServerError, api.Internal, "internal error")
			}()
			next.ServeHTTP(w, r)
		})
	}
}
