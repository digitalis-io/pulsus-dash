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

	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
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
}

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// New returns the HTTP handler of every route.
func New(d Deps) http.Handler {
	if d.Logger == nil {
		d.Logger = slog.New(slog.DiscardHandler)
	}
	r := chi.NewRouter()
	r.Use(commonHeaders, accessLog(d.Logger), recoverer(d.Logger))
	r.NotFound(func(w http.ResponseWriter, _ *http.Request) {
		WriteError(w, http.StatusNotFound, api.NotFound, "not found")
	})
	r.MethodNotAllowed(func(w http.ResponseWriter, _ *http.Request) {
		WriteError(w, http.StatusMethodNotAllowed, api.Invalid, "method not allowed")
	})
	badRequest := func(w http.ResponseWriter, _ *http.Request, _ error) {
		WriteError(w, http.StatusBadRequest, api.Invalid, "bad request")
	}
	strict := api.NewStrictHandlerWithOptions(&health{deps: d}, nil, api.StrictHTTPServerOptions{
		RequestErrorHandlerFunc: badRequest,
		ResponseErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			d.Logger.ErrorContext(r.Context(), "response error", "error", err.Error())
			WriteError(w, http.StatusInternalServerError, api.Internal, "internal error")
		},
	})
	return api.HandlerWithOptions(strict, api.ChiServerOptions{BaseRouter: r, ErrorHandlerFunc: badRequest})
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
