package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
)

// The annotations routes (plan #64 Part C §3.4): hand-written, described in api/openapi.yaml and
// excluded from the generated server. Organisation-scoped (D12): no tenant parameter.
const (
	annotationsRoute   = "/api/dash/v1/annotations"
	annotationMaxBody  = 16 << 10
	annotationsMaxList = 500
	// maxEpochMs is 9999-12-31T23:59:59.999Z.
	maxEpochMs = 253402300799999
	// maxSpanMs is 31 days, the longest range (the table CHECK).
	maxSpanMs        = 31 * 24 * 3600 * 1000
	annotationMaxLen = 500
	annotationMaxTag = 16
	msgNoAnnotation  = "annotation not found"
)

var (
	epochPattern    = regexp.MustCompile(`^(0|[1-9][0-9]{0,14})$`)
	limitPattern    = regexp.MustCompile(`^[0-9]{1,4}$`)
	tagPattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9_.:/-]{0,63}$`)
	annotationIDPat = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	// createKeys are the keys of AnnotationCreate.
	createKeys = []string{"at", "end_at", "kind", "text", "tags"}
)

// annotationJSON is the Annotation schema.
type annotationJSON struct {
	ID    string   `json:"id"`
	At    int64    `json:"at"`
	EndAt *int64   `json:"end_at"`
	Kind  string   `json:"kind"`
	Text  string   `json:"text"`
	Tags  []string `json:"tags"`
}

func toAnnotationJSON(a core.Annotation) annotationJSON {
	out := annotationJSON{ID: a.ID.String(), At: a.At.UnixMilli(), Kind: string(a.Kind), Text: a.Text, Tags: a.Tags}
	if a.EndAt != nil {
		e := a.EndAt.UnixMilli()
		out.EndAt = &e
	}
	if out.Tags == nil {
		out.Tags = []string{}
	}
	return out
}

// annotationRoutes serves the three annotation routes over Deps.Annotations.
type annotationRoutes struct{ d Deps }

func (a *annotationRoutes) mount(r chi.Router) {
	r.Get(annotationsRoute, a.list)
	r.Post(annotationsRoute, a.create)
	r.Delete(annotationsRoute+"/{id}", a.remove)
}

// available writes 503 and returns false without a service or an organisation.
func (a *annotationRoutes) available(w http.ResponseWriter) bool {
	if a.d.Annotations != nil && !a.d.Org.IsZero() {
		return true
	}
	WriteError(w, http.StatusServiceUnavailable, api.Unavailable, msgUnavailable)
	return false
}

// fail answers a service error: 404 for core.ErrNotFound, else 503 (logged unless cancelled).
func (a *annotationRoutes) fail(ctx context.Context, w http.ResponseWriter, op string, err error) {
	if errors.Is(err, core.ErrNotFound) {
		WriteError(w, http.StatusNotFound, api.NotFound, msgNoAnnotation)
		return
	}
	if !errors.Is(err, context.Canceled) {
		a.d.Logger.ErrorContext(ctx, "annotations", "op", op, "error", err.Error(), "request_id", rcFrom(ctx).RequestID)
	}
	WriteError(w, http.StatusServiceUnavailable, api.Unavailable, msgUnavailable)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// epochParam is a window bound: a canonical decimal integer 0 … maxEpochMs.
func epochParam(s string) (int64, bool) {
	if !epochPattern.MatchString(s) {
		return 0, false
	}
	n, err := strconv.ParseInt(s, 10, 64)
	return n, err == nil && n <= maxEpochMs
}

// listParams validates from, to and limit in that order (§3.4); the first failure is returned.
func listParams(r *http.Request) (time.Time, time.Time, int, *reqError) {
	q := r.URL.Query()
	const window = "annotations.window.invalid"
	from, ok := epochParam(q.Get("from"))
	if !ok {
		return time.Time{}, time.Time{}, 0, fieldError("/from", window, msgInvalidRequest)
	}
	to, ok := epochParam(q.Get("to"))
	if !ok || from >= to {
		return time.Time{}, time.Time{}, 0, fieldError("/to", window, msgInvalidRequest)
	}
	limit := annotationsMaxList
	if q.Has("limit") {
		s := q.Get("limit")
		n, err := strconv.Atoi(s)
		if !limitPattern.MatchString(s) || err != nil || n < 1 || n > annotationsMaxList {
			return time.Time{}, time.Time{}, 0, fieldError("/limit", "annotations.limit.range", msgInvalidRequest)
		}
		limit = n
	}
	return time.UnixMilli(from).UTC(), time.UnixMilli(to).UTC(), limit, nil
}

func (a *annotationRoutes) list(w http.ResponseWriter, r *http.Request) {
	if !a.available(w) {
		return
	}
	from, to, limit, e := listParams(r)
	if e != nil {
		writeReqError(w, e)
		return
	}
	items, truncated, err := a.d.Annotations.ListAnnotations(r.Context(), rcFrom(r.Context()), from, to, limit)
	if err != nil {
		a.fail(r.Context(), w, "list", err)
		return
	}
	out := make([]annotationJSON, 0, len(items))
	for _, x := range items {
		out = append(out, toAnnotationJSON(x))
	}
	writeJSON(w, http.StatusOK, struct {
		Items     []annotationJSON `json:"items"`
		Truncated bool             `json:"truncated"`
	}{out, truncated})
}

// pointerOf is the JSON pointer of an object key (RFC 6901 escaping).
func pointerOf(key string) string {
	return "/" + strings.ReplaceAll(strings.ReplaceAll(key, "~", "~0"), "/", "~1")
}

// epochValue is a JSON value that is an integer literal 0 … maxEpochMs.
func epochValue(raw json.RawMessage) (int64, bool) {
	return epochParam(string(bytes.TrimSpace(raw)))
}

func isNull(raw json.RawMessage) bool { return string(bytes.TrimSpace(raw)) == "null" }

// validText is 1 … 500 code points, not only white space, with no NUL.
func validText(s string) bool {
	n := utf8.RuneCountInString(s)
	if n < 1 || n > annotationMaxLen || strings.ContainsRune(s, 0) {
		return false
	}
	return strings.IndexFunc(s, func(r rune) bool { return !unicode.IsSpace(r) }) >= 0
}

// parseCreate validates an AnnotationCreate body (§3.4) and returns the annotation, or the 400 of
// the first failing rule: not one JSON object, then an unknown key, at, end_at, kind, text, tags.
func parseCreate(body []byte) (core.NewAnnotation, *reqError) {
	invalid := &reqError{status: http.StatusBadRequest, body: api.ErrorBody{Code: api.Invalid, Message: msgInvalidRequest}}
	dec := json.NewDecoder(bytes.NewReader(body))
	var m map[string]json.RawMessage
	if err := dec.Decode(&m); err != nil || m == nil {
		return core.NewAnnotation{}, invalid
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return core.NewAnnotation{}, invalid
	}
	field := func(pointer, key string) (core.NewAnnotation, *reqError) {
		return core.NewAnnotation{}, fieldError(pointer, key, msgInvalidRequest)
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	for _, k := range keys {
		if !slices.Contains(createKeys, k) {
			return field(pointerOf(k), "annotation.unknown")
		}
	}
	at, ok := epochValue(m["at"])
	if !ok {
		return field("/at", "annotation.at.range")
	}
	out := core.NewAnnotation{At: time.UnixMilli(at).UTC(), Tags: []string{}}
	if raw, has := m["end_at"]; has && !isNull(raw) {
		end, ok := epochValue(raw)
		switch {
		case !ok || end < at:
			return field("/end_at", "annotation.end.order")
		case end-at > maxSpanMs:
			return field("/end_at", "annotation.end.span")
		}
		e := time.UnixMilli(end).UTC()
		out.EndAt = &e
	}
	var kind string
	if err := json.Unmarshal(m["kind"], &kind); err != nil || !core.AnnotationKind(kind).Valid() {
		return field("/kind", "annotation.kind.invalid")
	}
	out.Kind = core.AnnotationKind(kind)
	raw, has := m["text"]
	if !has || json.Unmarshal(raw, &out.Text) != nil || !validText(out.Text) {
		return field("/text", "annotation.text.length")
	}
	if raw, has := m["tags"]; has {
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil || items == nil {
			return field("/tags", "annotation.tags.invalid")
		}
		if len(items) > annotationMaxTag {
			return field("/tags", "annotation.tags.count")
		}
		for i, it := range items {
			var tag string
			p := "/tags/" + strconv.Itoa(i)
			if err := json.Unmarshal(it, &tag); err != nil || !tagPattern.MatchString(tag) {
				return field(p, "annotation.tags.invalid")
			}
			if slices.Contains(out.Tags, tag) {
				return field(p, "annotation.tags.duplicate")
			}
			out.Tags = append(out.Tags, tag)
		}
	}
	return out, nil
}

func (a *annotationRoutes) create(w http.ResponseWriter, r *http.Request) {
	if !a.available(w) {
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, annotationMaxBody))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			WriteError(w, http.StatusRequestEntityTooLarge, api.Invalid, "request body too large")
			return
		}
		WriteError(w, http.StatusBadRequest, api.Invalid, "bad request")
		return
	}
	n, e := parseCreate(body)
	if e != nil {
		writeReqError(w, e)
		return
	}
	created, err := a.d.Annotations.CreateAnnotation(r.Context(), rcFrom(r.Context()), n)
	if err != nil {
		a.fail(r.Context(), w, "create", err)
		return
	}
	writeJSON(w, http.StatusCreated, toAnnotationJSON(created))
}

func (a *annotationRoutes) remove(w http.ResponseWriter, r *http.Request) {
	if !a.available(w) {
		return
	}
	s := chi.URLParam(r, "id")
	id, err := uuid.Parse(s)
	if !annotationIDPat.MatchString(s) || err != nil {
		writeReqError(w, fieldError("/id", "annotation.id.invalid", msgInvalidRequest))
		return
	}
	if err := a.d.Annotations.DeleteAnnotation(r.Context(), rcFrom(r.Context()), id); err != nil {
		a.fail(r.Context(), w, "delete", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
