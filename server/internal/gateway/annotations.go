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
	"github.com/digitalis-io/pulsus-dash/server/internal/entity"
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
	// The list filters' bounds (T24 §5.9).
	maxKindFilter   = 4
	maxTagFilter    = 8
	maxEntityFilter = 16
	msgOutsideScope = "outside your data scope"
	msgScopeDenied  = "data scope denied"
)

var (
	epochPattern    = regexp.MustCompile(`^(0|[1-9][0-9]{0,14})$`)
	limitPattern    = regexp.MustCompile(`^[0-9]{1,4}$`)
	tagPattern      = regexp.MustCompile(`^[a-z0-9][a-z0-9_.:/-]{0,63}$`)
	annotationIDPat = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	// createKeys are the keys of AnnotationCreate.
	createKeys = []string{"at", "end_at", "kind", "text", "tags", "entity"}
	// entityKeys are the keys of AnnotationEntityCreate.
	entityKeys = []string{"attrs", "binding", "kind"}
)

// entityJSON is the AnnotationEntity schema: never binding_id or attrs (T12-018).
type entityJSON struct {
	ID      string    `json:"id"`
	Binding string    `json:"binding"`
	Kind    string    `json:"kind"`
	Ident   []*string `json:"ident"`
}

// annotationJSON is the Annotation schema.
type annotationJSON struct {
	ID     string      `json:"id"`
	At     int64       `json:"at"`
	EndAt  *int64      `json:"end_at"`
	Kind   string      `json:"kind"`
	Text   string      `json:"text"`
	Tags   []string    `json:"tags"`
	Entity *entityJSON `json:"entity"`
}

func toAnnotationJSON(a core.Annotation) annotationJSON {
	out := annotationJSON{ID: a.ID.String(), At: a.At.UnixMilli(), Kind: string(a.Kind), Text: a.Text, Tags: a.Tags}
	if e := a.Entity; e != nil {
		ident := e.Ident
		if ident == nil {
			ident = []*string{}
		}
		out.Entity = &entityJSON{ID: e.ID.String(), Binding: e.Binding, Kind: e.Kind, Ident: ident}
	}
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

// annotationRC is the request's core.RequestCtx with the fixed local principal and full scope:
// until authentication (D12) every request sees the whole organisation.
func annotationRC(ctx context.Context) *core.RequestCtx {
	rc := *rcFrom(ctx)
	rc.Principal, rc.Scope = core.LocalPrincipal, core.FullTenantScope()
	return &rc
}

// fail answers a service error (plan #222 §3.7): 400 for a core.InvalidError, 403 scope_denied for
// a core.ScopeError (with its field) or core.ErrScopeDenied, 404 for core.ErrNotFound, else 503
// (logged unless cancelled).
func (a *annotationRoutes) fail(ctx context.Context, w http.ResponseWriter, op string, err error) {
	var inv *core.InvalidError
	var se *core.ScopeError
	switch {
	case errors.As(err, &inv):
		writeReqError(w, fieldError(inv.Pointer, inv.Key, msgInvalidRequest))
		return
	case errors.As(err, &se):
		WriteErrorBody(w, http.StatusForbidden, api.ErrorBody{Code: api.ScopeDenied, Message: msgOutsideScope,
			Fields: &[]api.FieldError{{Pointer: se.Pointer, MessageKey: se.Key}}})
		return
	case errors.Is(err, core.ErrScopeDenied):
		WriteError(w, http.StatusForbidden, api.ScopeDenied, msgScopeDenied)
		return
	case errors.Is(err, core.ErrNotFound):
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

// listQuery is a valid list request: the window, the limit, the filter and what was applied.
type listQuery struct {
	from, to time.Time
	limit    int
	filter   core.AnnotationFilter
	applied  listApplied
}

// listApplied is the AnnotationListApplied schema: each given parameter as parsed, in request
// order.
type listApplied struct {
	Kinds   []string    `json:"kinds,omitempty"`
	Tags    []string    `json:"tags,omitempty"`
	Entity  []string    `json:"entity,omitempty"`
	OrgWide *bool       `json:"orgWide,omitempty"`
	Before  *cursorJSON `json:"before,omitempty"`
}

// cursorJSON is the AnnotationCursor schema.
type cursorJSON struct {
	At int64  `json:"at"`
	ID string `json:"id"`
}

// listValues validates a repeated parameter: absent, or 1 … max values, each valid, with no
// duplicate. ok is false for any failure.
func listValues(q map[string][]string, name string, maxN int, valid func(string) bool) (vals []string, ok bool) {
	vs, has := q[name]
	if !has {
		return nil, true
	}
	if len(vs) < 1 || len(vs) > maxN {
		return nil, false
	}
	for i, v := range vs {
		if !valid(v) || slices.Contains(vs[:i], v) {
			return nil, false
		}
	}
	return vs, true
}

// single is a parameter given at most once: its value, whether it was given, and false when it
// was repeated.
func single(q map[string][]string, name string) (string, bool, bool) {
	vs, has := q[name]
	if !has {
		return "", false, true
	}
	if len(vs) != 1 {
		return "", true, false
	}
	return vs[0], true, true
}

// listParams validates from, to, limit, kind, tag, entity, orgWide, beforeAt and beforeId in that
// order (plan #222 §3.7); the first failure is returned, with one field.
func listParams(r *http.Request) (listQuery, *reqError) {
	q := r.URL.Query()
	const window = "annotations.window.invalid"
	fail := func(pointer, key string) (listQuery, *reqError) {
		return listQuery{}, fieldError(pointer, key, msgInvalidRequest)
	}
	from, ok := epochParam(q.Get("from"))
	if !ok {
		return fail("/from", window)
	}
	to, ok := epochParam(q.Get("to"))
	if !ok || from >= to {
		return fail("/to", window)
	}
	out := listQuery{from: time.UnixMilli(from).UTC(), to: time.UnixMilli(to).UTC(), limit: annotationsMaxList}
	if q.Has("limit") {
		s := q.Get("limit")
		n, err := strconv.Atoi(s)
		if !limitPattern.MatchString(s) || err != nil || n < 1 || n > annotationsMaxList {
			return fail("/limit", "annotations.limit.range")
		}
		out.limit = n
	}
	kinds, ok := listValues(q, "kind", maxKindFilter, func(s string) bool { return core.AnnotationKind(s).Valid() })
	if !ok {
		return fail("/kind", "annotations.kind.invalid")
	}
	for _, k := range kinds {
		out.filter.Kinds = append(out.filter.Kinds, core.AnnotationKind(k))
	}
	out.applied.Kinds = kinds
	tags, ok := listValues(q, "tag", maxTagFilter, tagPattern.MatchString)
	if !ok {
		return fail("/tag", "annotations.tag.invalid")
	}
	out.filter.Tags, out.applied.Tags = tags, tags
	ents, ok := listValues(q, "entity", maxEntityFilter, annotationIDPat.MatchString)
	if !ok {
		return fail("/entity", "annotations.entity.invalid")
	}
	for _, e := range ents {
		id, err := uuid.Parse(e)
		if err != nil {
			return fail("/entity", "annotations.entity.invalid")
		}
		out.filter.Entities = append(out.filter.Entities, id)
	}
	out.applied.Entity = ents
	ow, has, ok := single(q, "orgWide")
	if has {
		if !ok || (ow != "true" && ow != "false") || len(ents) == 0 {
			return fail("/orgWide", "annotations.orgWide.invalid")
		}
		v := ow == "true"
		out.filter.OrgWide, out.applied.OrgWide = v, &v
	}
	atS, hasAt, okAt := single(q, "beforeAt")
	idS, hasID, okID := single(q, "beforeId")
	at, atValid := epochParam(atS)
	if (hasAt && (!okAt || !atValid)) || (!hasAt && hasID) {
		return fail("/beforeAt", "annotations.beforeAt.invalid")
	}
	id, err := uuid.Parse(idS)
	if (hasID && (!okID || !annotationIDPat.MatchString(idS) || err != nil)) || (!hasID && hasAt) {
		return fail("/beforeId", "annotations.beforeId.invalid")
	}
	if hasAt {
		out.filter.Before = &core.AnnotationCursor{At: time.UnixMilli(at).UTC(), ID: id}
		out.applied.Before = &cursorJSON{At: at, ID: idS}
	}
	return out, nil
}

// annotationListJSON is the AnnotationList schema.
type annotationListJSON struct {
	Items         []annotationJSON `json:"items"`
	Truncated     bool             `json:"truncated"`
	Applied       listApplied      `json:"applied"`
	Next          *cursorJSON      `json:"next"`
	OrgWideHidden *int64           `json:"orgWideHidden"`
}

func (a *annotationRoutes) list(w http.ResponseWriter, r *http.Request) {
	if !a.available(w) {
		return
	}
	lq, e := listParams(r)
	if e != nil {
		writeReqError(w, e)
		return
	}
	page, err := a.d.Annotations.ListAnnotations(r.Context(), annotationRC(r.Context()), lq.from, lq.to, lq.limit, lq.filter)
	if err != nil {
		a.fail(r.Context(), w, "list", err)
		return
	}
	out := annotationListJSON{Items: make([]annotationJSON, 0, len(page.Items)), Applied: lq.applied, OrgWideHidden: page.OrgWideHidden}
	for _, x := range page.Items {
		out.Items = append(out.Items, toAnnotationJSON(x))
	}
	if page.Next != nil {
		out.Next = &cursorJSON{At: page.Next.At.UnixMilli(), ID: page.Next.ID.String()}
		out.Truncated = true
	}
	writeJSON(w, http.StatusOK, out)
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
// the first failing rule: not one JSON object, then an unknown key, at, end_at, kind, text, tags,
// entity.
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
	if raw, has := m["entity"]; has && !isNull(raw) {
		e, pointer, key := parseEntity(raw)
		if key != "" {
			return field(pointer, key)
		}
		out.Entity = e
	}
	return out, nil
}

// parseEntity validates an AnnotationEntityCreate value and canonicalises it (T12-010): not an
// object with exactly binding, kind and attrs, a non-string binding or kind, or a non-object
// attrs → /entity annotations.entity.invalid; a binding that is not a slug → /entity/binding
// annotations.entity.binding; an entity that does not canonicalise → /entity
// annotations.entity.invalid.
func parseEntity(raw json.RawMessage) (*core.NewEntity, string, string) {
	const invalid = "annotations.entity.invalid"
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil || m == nil || len(m) != len(entityKeys) {
		return nil, "/entity", invalid
	}
	for _, k := range entityKeys {
		if _, ok := m[k]; !ok {
			return nil, "/entity", invalid
		}
	}
	var binding, kind string
	var attrs map[string]json.RawMessage
	if !isString(m["binding"]) || json.Unmarshal(m["binding"], &binding) != nil ||
		!isString(m["kind"]) || json.Unmarshal(m["kind"], &kind) != nil ||
		json.Unmarshal(m["attrs"], &attrs) != nil || attrs == nil {
		return nil, "/entity", invalid
	}
	if !tenantPattern.MatchString(binding) {
		return nil, "/entity/binding", "annotations.entity.binding"
	}
	c, err := entity.Canonicalise(kind, attrs)
	if err != nil {
		return nil, "/entity", invalid
	}
	return &core.NewEntity{Binding: binding, CanonicalEntity: c}, "", ""
}

func isString(raw json.RawMessage) bool { return bytes.HasPrefix(bytes.TrimSpace(raw), []byte(`"`)) }

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
	created, err := a.d.Annotations.CreateAnnotation(r.Context(), annotationRC(r.Context()), n)
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
	if err := a.d.Annotations.DeleteAnnotation(r.Context(), annotationRC(r.Context()), id); err != nil {
		a.fail(r.Context(), w, "delete", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
