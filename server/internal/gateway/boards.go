package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
	"github.com/digitalis-io/pulsus-dash/server/internal/spec"
)

// Board route rules (plan #61 §3.7).
var (
	uidPattern     = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)
	ifMatchPattern = regexp.MustCompile(`^"([1-9][0-9]{0,18})"$`)
)

const (
	recentDefault = 5
	recentMax     = 50
	// maxSearchRunes bounds GET /boards q (T24-021).
	maxSearchRunes    = 100
	maxMessageRunes   = 500
	msgUnavailable    = "configuration store unavailable"
	msgNotFound       = "board not found"
	msgTooNew         = "board saved by a newer server version"
	msgInvalidBoard   = "invalid board"
	msgInvalidRequest = "invalid request"
	// maxViewAtMs is 9999-12-31T23:59:59.999Z, the largest `at` of PUT /me/recent-boards/{uid}.
	maxViewAtMs      = 253402300799999
	msgIfMatchNeeded = "If-Match is required"
	msgIfMatchBad    = "If-Match must be an ETag from this API"
)

// boards implements the board, starred and recent routes over Deps.Boards.
type boards struct{ deps Deps }

type requestCtxKey struct{}

// boardRequest returns the envelope a request's body must have: POST /api/dash/v1/boards is a
// BoardCreate and PUT /api/dash/v1/boards/{uid} a BoardUpdate.
func boardRequest(r *http.Request) (spec.Envelope, bool) {
	const prefix = "/api/dash/v1/boards"
	switch {
	case r.Method == http.MethodPost && r.URL.Path == prefix:
		return spec.CreateEnvelope, true
	case r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, prefix+"/") && !strings.Contains(r.URL.Path[len(prefix)+1:], "/"):
		return spec.UpdateEnvelope, true
	}
	return 0, false
}

// boardBody validates the whole body of a board create or update before the generated decoder
// sees it (plan #61 review r1 #1). The generated decoder reads one JSON value into a struct, so it
// would accept unknown, wrongly cased or repeated envelope keys and trailing data, and could stop
// before the 2 MiB limit. boardBody reads the body to its end through bodyLimit's MaxBytesReader
// (413 when it is longer), checks it with the spec's shape rules (400 invalid "invalid request"
// with fields), and hands the same bytes on.
func boardBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e, ok := boardRequest(r)
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		body, err := io.ReadAll(r.Body)
		var tooLarge *http.MaxBytesError
		switch {
		case errors.As(err, &tooLarge):
			WriteError(w, http.StatusRequestEntityTooLarge, api.Invalid, "request body too large")
			return
		case err != nil:
			WriteError(w, http.StatusBadRequest, api.Invalid, "bad request")
			return
		}
		if fields := spec.CheckEnvelope(body, e); len(fields) > 0 {
			writeFields(w, msgInvalidRequest, fields)
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		next.ServeHTTP(w, r)
	})
}

func apiFields(fields []spec.FieldError) *[]api.FieldError {
	out := make([]api.FieldError, 0, len(fields))
	for _, f := range fields {
		out = append(out, api.FieldError{Pointer: f.Pointer, MessageKey: f.MessageKey})
	}
	return &out
}

// writeFields writes a 400 invalid envelope with field errors.
func writeFields(w http.ResponseWriter, msg string, fields []spec.FieldError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusBadRequest)
	_ = json.NewEncoder(w).Encode(api.ErrorEnvelope{Error: api.ErrorBody{Code: api.Invalid, Message: msg, Fields: apiFields(fields)}})
}

// requestCtx puts the request's core.RequestCtx in its context: the configured organisation, the
// fixed local principal (D12) and the request ID.
func requestCtx(d Deps) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			id, _ := r.Context().Value(requestIDKey{}).(string)
			rc := &core.RequestCtx{Org: d.Org, Actor: core.LocalActor(), RequestID: id}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestCtxKey{}, rc)))
		})
	}
}

// rcFrom returns the request's core.RequestCtx.
func rcFrom(ctx context.Context) *core.RequestCtx {
	if rc, ok := ctx.Value(requestCtxKey{}).(*core.RequestCtx); ok {
		return rc
	}
	return &core.RequestCtx{Actor: core.LocalActor()}
}

// errResponse is an error answer of any board operation: the error envelope, or the
// BoardConflict body for 409.
type errResponse struct {
	status int
	body   any
}

func (e errResponse) write(w http.ResponseWriter) error {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.status)
	return json.NewEncoder(w).Encode(e.body)
}

func (e errResponse) VisitListBoardsResponse(w http.ResponseWriter) error        { return e.write(w) }
func (e errResponse) VisitCreateBoardResponse(w http.ResponseWriter) error       { return e.write(w) }
func (e errResponse) VisitGetBoardResponse(w http.ResponseWriter) error          { return e.write(w) }
func (e errResponse) VisitUpdateBoardResponse(w http.ResponseWriter) error       { return e.write(w) }
func (e errResponse) VisitDeleteBoardResponse(w http.ResponseWriter) error       { return e.write(w) }
func (e errResponse) VisitListStarredBoardsResponse(w http.ResponseWriter) error { return e.write(w) }
func (e errResponse) VisitStarBoardResponse(w http.ResponseWriter) error         { return e.write(w) }
func (e errResponse) VisitUnstarBoardResponse(w http.ResponseWriter) error       { return e.write(w) }
func (e errResponse) VisitListRecentBoardsResponse(w http.ResponseWriter) error  { return e.write(w) }
func (e errResponse) VisitRecordBoardViewResponse(w http.ResponseWriter) error   { return e.write(w) }

func envelope(status int, code api.ErrorCode, msg string) errResponse {
	return errResponse{status: status, body: api.ErrorEnvelope{Error: api.ErrorBody{Code: code, Message: msg}}}
}

var (
	errUnavailable = envelope(http.StatusServiceUnavailable, api.Unavailable, msgUnavailable)
	errNotFound    = envelope(http.StatusNotFound, api.NotFound, msgNotFound)
)

// available reports whether the routes have a service and an organisation.
func (b *boards) available() bool { return b.deps.Boards != nil && !b.deps.Org.IsZero() }

// parseIfMatch returns the ETag of an If-Match value, or the status (428 absent, 400 malformed)
// and message of its refusal. Only a single strong tag of this API ("<n>", n ≥ 1) is accepted:
// no W/, no *, no list.
func parseIfMatch(v *string) (int64, int, string) {
	if v == nil || *v == "" {
		return 0, http.StatusPreconditionRequired, msgIfMatchNeeded
	}
	m := ifMatchPattern.FindStringSubmatch(*v)
	if m == nil {
		return 0, http.StatusBadRequest, msgIfMatchBad
	}
	n, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return 0, http.StatusBadRequest, msgIfMatchBad
	}
	return n, 0, ""
}

func etag(n int64) string { return `"` + strconv.FormatInt(n, 10) + `"` }

func author(a core.Actor) api.Author {
	return api.Author{Kind: api.AuthorKind(a.Kind), Name: a.DisplayName()}
}

func toAPIBoard(b core.Board) api.Board {
	return api.Board{Uid: b.UID, Title: b.Title, Version: b.Version, UpdatedAt: b.UpdatedAt, UpdatedBy: author(b.UpdatedBy),
		Etag: strconv.FormatInt(b.ETag, 10), SchemaVersion: b.SchemaVersion, Spec: json.RawMessage(b.Spec)}
}

func toAPIRefs(refs []core.BoardRef, truncated bool) api.BoardRefList {
	items := make([]api.BoardRef, 0, len(refs))
	for _, r := range refs {
		items = append(items, api.BoardRef{Uid: r.UID, Title: r.Title})
	}
	return api.BoardRefList{Items: items, Applied: api.BoardRefApplied{}, Truncated: truncated}
}

// validSearch reports whether q is a valid GET /boards q: UTF-8 of 1 to 100 code points with no
// C0 or C1 control character (Cc: U+0000–001F, U+007F–009F).
func validSearch(q string) bool {
	if !utf8.ValidString(q) {
		return false
	}
	n := 0
	for _, r := range q {
		if r <= 0x1f || (r >= 0x7f && r <= 0x9f) {
			return false
		}
		n++
	}
	return n >= 1 && n <= maxSearchRunes
}

// boardFilter checks the q and tag of GET /boards (plan #215 §3.6): the first invalid one is a
// 400 before any service call, /q before /tag. A valid value is kept as sent (no trim).
func boardFilter(p api.ListBoardsParams) (core.BoardFilter, api.BoardListApplied, *errResponse) {
	var f core.BoardFilter
	var applied api.BoardListApplied
	invalid := func(pointer, key string) *errResponse {
		e := errResponse{status: http.StatusBadRequest, body: api.ErrorEnvelope{Error: api.ErrorBody{Code: api.Invalid, Message: msgInvalidRequest,
			Fields: &[]api.FieldError{{Pointer: pointer, MessageKey: key}}}}}
		return &e
	}
	if p.Q != nil {
		if !validSearch(*p.Q) {
			return f, applied, invalid("/q", "boards.q.invalid")
		}
		f.Q, applied.Q = *p.Q, p.Q
	}
	if p.Tag != nil {
		if !tagPattern.MatchString(*p.Tag) {
			return f, applied, invalid("/tag", "boards.tag.invalid")
		}
		f.Tag, applied.Tag = *p.Tag, p.Tag
	}
	return f, applied, nil
}

// summaryTags is a list row's tags: the tags when known ([] when there are none), else null.
func summaryTags(s core.BoardSummary) *[]api.AnnotationTag {
	if !s.TagsFresh {
		return nil
	}
	tags := make([]api.AnnotationTag, 0, len(s.Tags))
	tags = append(tags, s.Tags...)
	return &tags
}

// fail maps a service error to its answer (plan #61 §3.7). submitted is the request's spec for
// the 409 body of a save, nil otherwise.
func (b *boards) fail(ctx context.Context, op string, err error, submitted json.RawMessage) errResponse {
	var ve *spec.ValidationError
	var ce *core.ConflictError
	switch {
	case errors.As(err, &ve):
		return errResponse{status: http.StatusBadRequest, body: api.ErrorEnvelope{Error: api.ErrorBody{Code: api.Invalid, Message: msgInvalidBoard, Fields: apiFields(ve.Fields)}}}
	case errors.Is(err, core.ErrNotFound):
		return errNotFound
	case errors.As(err, &ce):
		body := api.BoardConflict{Error: api.ErrorBody{Code: api.Conflict, Message: ce.Error()}, Current: toAPIBoard(ce.Current)}
		if submitted != nil {
			body.Submitted = &submitted
		}
		return errResponse{status: http.StatusConflict, body: body}
	case errors.Is(err, spec.ErrSchemaTooNew):
		b.deps.Logger.WarnContext(ctx, "boards", "op", op, "error", err.Error(), "request_id", rcFrom(ctx).RequestID)
		return envelope(http.StatusServiceUnavailable, api.Unavailable, msgTooNew)
	case errors.Is(err, context.Canceled):
		return errUnavailable
	}
	b.deps.Logger.ErrorContext(ctx, "boards", "op", op, "error", err.Error(), "request_id", rcFrom(ctx).RequestID)
	return errUnavailable
}

// ListBoards answers GET /boards (T24-021, T24-029): q and tag are checked first, then the
// service lists; applied echoes the filters given, and tags is null for a row not yet known.
func (b *boards) ListBoards(ctx context.Context, req api.ListBoardsRequestObject) (api.ListBoardsResponseObject, error) {
	f, applied, bad := boardFilter(req.Params)
	if bad != nil {
		return *bad, nil
	}
	if !b.available() {
		return errUnavailable, nil
	}
	page, err := b.deps.Boards.ListBoards(ctx, rcFrom(ctx), f)
	if err != nil {
		return b.fail(ctx, "list", err, nil), nil
	}
	out := make([]api.BoardSummary, 0, len(page.Items))
	for _, s := range page.Items {
		out = append(out, api.BoardSummary{Uid: s.UID, Title: s.Title, Version: s.Version, UpdatedAt: s.UpdatedAt, UpdatedBy: author(s.UpdatedBy),
			Tags: summaryTags(s)})
	}
	return api.ListBoards200JSONResponse{Items: out, Truncated: page.Truncated, Applied: applied, TagsStale: page.TagsStale}, nil
}

func (b *boards) CreateBoard(ctx context.Context, req api.CreateBoardRequestObject) (api.CreateBoardResponseObject, error) {
	if !b.available() {
		return errUnavailable, nil
	}
	board, err := b.deps.Boards.CreateBoard(ctx, rcFrom(ctx), req.Body.Spec)
	if err != nil {
		return b.fail(ctx, "create", err, nil), nil
	}
	tag, loc := etag(board.ETag), "/api/dash/v1/boards/"+board.UID
	return api.CreateBoard201JSONResponse{Body: toAPIBoard(board), Headers: api.CreateBoard201ResponseHeaders{ETag: &tag, Location: &loc}}, nil
}

func (b *boards) GetBoard(ctx context.Context, req api.GetBoardRequestObject) (api.GetBoardResponseObject, error) {
	if !b.available() {
		return errUnavailable, nil
	}
	if !uidPattern.MatchString(req.Uid) {
		return errNotFound, nil
	}
	board, err := b.deps.Boards.GetBoard(ctx, rcFrom(ctx), req.Uid)
	if err != nil {
		return b.fail(ctx, "get", err, nil), nil
	}
	tag := etag(board.ETag)
	return api.GetBoard200JSONResponse{Body: toAPIBoard(board), Headers: api.GetBoard200ResponseHeaders{ETag: &tag}}, nil
}

func (b *boards) UpdateBoard(ctx context.Context, req api.UpdateBoardRequestObject) (api.UpdateBoardResponseObject, error) {
	if !b.available() {
		return errUnavailable, nil
	}
	if !uidPattern.MatchString(req.Uid) {
		return errNotFound, nil
	}
	ifMatch, status, msg := parseIfMatch(req.Params.IfMatch)
	if status != 0 {
		return envelope(status, api.Invalid, msg), nil
	}
	message := ""
	if req.Body.Message != nil {
		message = *req.Body.Message
	}
	if utf8.RuneCountInString(message) > maxMessageRunes || !utf8.ValidString(message) || containsNUL(message) {
		return envelope(http.StatusBadRequest, api.Invalid, "message must be valid text of at most 500 characters"), nil
	}
	res, err := b.deps.Boards.SaveBoard(ctx, rcFrom(ctx), req.Uid, ifMatch, req.Body.Spec, message)
	if err != nil {
		return b.fail(ctx, "save", err, req.Body.Spec), nil
	}
	tag := etag(res.Board.ETag)
	return api.UpdateBoard200JSONResponse{Body: api.BoardSaveResult{Board: toAPIBoard(res.Board), Changed: res.Changed},
		Headers: api.UpdateBoard200ResponseHeaders{ETag: &tag}}, nil
}

func containsNUL(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] == 0 {
			return true
		}
	}
	return false
}

func (b *boards) DeleteBoard(ctx context.Context, req api.DeleteBoardRequestObject) (api.DeleteBoardResponseObject, error) {
	if !b.available() {
		return errUnavailable, nil
	}
	if !uidPattern.MatchString(req.Uid) {
		return errNotFound, nil
	}
	ifMatch, status, msg := parseIfMatch(req.Params.IfMatch)
	if status != 0 {
		return envelope(status, api.Invalid, msg), nil
	}
	if err := b.deps.Boards.DeleteBoard(ctx, rcFrom(ctx), req.Uid, ifMatch); err != nil {
		return b.fail(ctx, "delete", err, nil), nil
	}
	return api.DeleteBoard204Response{}, nil
}

func (b *boards) ListStarredBoards(ctx context.Context, _ api.ListStarredBoardsRequestObject) (api.ListStarredBoardsResponseObject, error) {
	if !b.available() {
		return errUnavailable, nil
	}
	refs, more, err := b.deps.Boards.ListStarred(ctx, rcFrom(ctx))
	if err != nil {
		return b.fail(ctx, "list_starred", err, nil), nil
	}
	return api.ListStarredBoards200JSONResponse(toAPIRefs(refs, more)), nil
}

func (b *boards) StarBoard(ctx context.Context, req api.StarBoardRequestObject) (api.StarBoardResponseObject, error) {
	if !b.available() {
		return errUnavailable, nil
	}
	if !uidPattern.MatchString(req.Uid) {
		return errNotFound, nil
	}
	if err := b.deps.Boards.SetStarred(ctx, rcFrom(ctx), req.Uid, true); err != nil {
		return b.fail(ctx, "star", err, nil), nil
	}
	return api.StarBoard204Response{}, nil
}

// UnstarBoard is idempotent: an unknown board, or a uid no board can have, is not starred.
func (b *boards) UnstarBoard(ctx context.Context, req api.UnstarBoardRequestObject) (api.UnstarBoardResponseObject, error) {
	if !b.available() {
		return errUnavailable, nil
	}
	if !uidPattern.MatchString(req.Uid) {
		return api.UnstarBoard204Response{}, nil
	}
	if err := b.deps.Boards.SetStarred(ctx, rcFrom(ctx), req.Uid, false); err != nil {
		return b.fail(ctx, "unstar", err, nil), nil
	}
	return api.UnstarBoard204Response{}, nil
}

func (b *boards) ListRecentBoards(ctx context.Context, req api.ListRecentBoardsRequestObject) (api.ListRecentBoardsResponseObject, error) {
	if !b.available() {
		return errUnavailable, nil
	}
	limit := recentDefault
	if req.Params.Limit != nil {
		limit = min(max(*req.Params.Limit, 1), recentMax)
	}
	refs, more, err := b.deps.Boards.ListRecent(ctx, rcFrom(ctx), limit)
	if err != nil {
		return b.fail(ctx, "list_recent", err, nil), nil
	}
	return api.ListRecentBoards200JSONResponse(toAPIRefs(refs, more)), nil
}

// RecordBoardView records a view, at the client's navigation time `at` when given (0 …
// 253402300799999 ms; else 400 invalid before any store call).
func (b *boards) RecordBoardView(ctx context.Context, req api.RecordBoardViewRequestObject) (api.RecordBoardViewResponseObject, error) {
	if !b.available() {
		return errUnavailable, nil
	}
	if !uidPattern.MatchString(req.Uid) {
		return errNotFound, nil
	}
	// `at`: the client's navigation time in ms since the Unix epoch (plan #61 Part C §3.9).
	var at *time.Time
	if req.Params.At != nil {
		ms := *req.Params.At
		if ms < 0 || ms > maxViewAtMs {
			return envelope(http.StatusBadRequest, api.Invalid, msgInvalidRequest), nil
		}
		t := time.UnixMilli(ms).UTC()
		at = &t
	}
	if err := b.deps.Boards.RecordView(ctx, rcFrom(ctx), req.Uid, at); err != nil {
		return b.fail(ctx, "record_view", err, nil), nil
	}
	return api.RecordBoardView204Response{}, nil
}
