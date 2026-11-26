package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/spec"
)

// fakeBoards is a scripted core.Boards. err, when set, is returned by every method.
type fakeBoards struct {
	mu    sync.Mutex
	calls []string
	err   error
	board core.Board
	saved core.SaveResult
	limit int
	rc    *core.RequestCtx
	at    []*time.Time
	// filters are the filters ListBoards was called with; page, when set, is its answer.
	filters     []core.BoardFilter
	page        *core.BoardPage
	starredMore bool
	recentMore  bool
}

func (f *fakeBoards) record(call string, rc *core.RequestCtx) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
	f.rc = rc
}

func (f *fakeBoards) ListBoards(_ context.Context, rc *core.RequestCtx, filter core.BoardFilter) (core.BoardPage, error) {
	f.record("list", rc)
	f.mu.Lock()
	f.filters = append(f.filters, filter)
	f.mu.Unlock()
	if f.page != nil {
		return *f.page, f.err
	}
	return core.BoardPage{Items: []core.BoardSummary{f.board.BoardSummary}}, f.err
}

func (f *fakeBoards) GetBoard(_ context.Context, rc *core.RequestCtx, uid string) (core.Board, error) {
	f.record("get "+uid, rc)
	return f.board, f.err
}

func (f *fakeBoards) CreateBoard(_ context.Context, rc *core.RequestCtx, _ []byte) (core.Board, error) {
	f.record("create", rc)
	return f.board, f.err
}

func (f *fakeBoards) SaveBoard(_ context.Context, rc *core.RequestCtx, uid string, ifMatch int64, _ []byte, _ string) (core.SaveResult, error) {
	f.record("save "+uid, rc)
	return f.saved, f.err
}

func (f *fakeBoards) DeleteBoard(_ context.Context, rc *core.RequestCtx, uid string, _ int64) error {
	f.record("delete "+uid, rc)
	return f.err
}

func (f *fakeBoards) ListStarred(_ context.Context, rc *core.RequestCtx) ([]core.BoardRef, bool, error) {
	f.record("starred", rc)
	return []core.BoardRef{{UID: "u1", Title: "One"}}, f.starredMore, f.err
}

func (f *fakeBoards) SetStarred(_ context.Context, rc *core.RequestCtx, uid string, starred bool) error {
	if starred {
		f.record("star "+uid, rc)
	} else {
		f.record("unstar "+uid, rc)
	}
	return f.err
}

func (f *fakeBoards) ListRecent(_ context.Context, rc *core.RequestCtx, limit int) ([]core.BoardRef, bool, error) {
	f.record("recent", rc)
	f.mu.Lock()
	f.limit = limit
	f.mu.Unlock()
	return []core.BoardRef{}, f.recentMore, f.err
}

func (f *fakeBoards) RecordView(_ context.Context, rc *core.RequestCtx, uid string, at *time.Time) error {
	f.record("view "+uid, rc)
	f.mu.Lock()
	f.at = append(f.at, at)
	f.mu.Unlock()
	return f.err
}

var testOrg = core.OrgID{1}

func sampleBoard(version, etag int64) core.Board {
	return core.Board{
		BoardSummary: core.BoardSummary{UID: "abc", Title: "T", Version: version,
			UpdatedAt: time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC), UpdatedBy: core.LocalActor()},
		ETag: etag, SchemaVersion: 2, Spec: []byte(`{"panels":[],"sections":[],"title":"T"}`),
	}
}

type resp struct {
	code int
	hdr  http.Header
	body map[string]any
	raw  []byte
}

func call(t *testing.T, h http.Handler, method, path string, body []byte, hdr ...string) resp {
	t.Helper()
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req := httptest.NewRequest(method, path, r)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	out := resp{code: rec.Code, hdr: rec.Header(), raw: rec.Body.Bytes()}
	if len(out.raw) > 0 {
		if err := json.Unmarshal(out.raw, &out.body); err != nil {
			t.Fatalf("%s %s: body %q is not a JSON object: %v", method, path, out.raw, err)
		}
	}
	return out
}

func errCode(r resp) string {
	e, _ := r.body["error"].(map[string]any)
	c, _ := e["code"].(string)
	return c
}

func errMessage(r resp) string {
	e, _ := r.body["error"].(map[string]any)
	m, _ := e["message"].(string)
	return m
}

func jsonEqual(t *testing.T, a, b any) bool {
	t.Helper()
	norm := func(v any) string {
		raw, ok := v.([]byte)
		if !ok {
			raw, _ = json.Marshal(v)
		}
		var x any
		if err := json.Unmarshal(raw, &x); err != nil {
			t.Fatalf("%s: %v", raw, err)
		}
		out, _ := json.Marshal(x)
		return string(out)
	}
	return norm(a) == norm(b)
}

const boardsPath = "/api/dash/v1/boards"

func TestBoardRoutes(t *testing.T) {
	sent := []byte(`{"title":"T","panels":[],"sections":[]}`)
	body := []byte(`{"spec":` + string(sent) + `}`)
	newH := func(f *fakeBoards) http.Handler {
		return New(Deps{Probe: &fakeProbe{version: 1}, SchemaLatest: 1, Boards: f, Org: testOrg})
	}
	t.Run("1 list", func(t *testing.T) {
		f := &fakeBoards{board: sampleBoard(3, 3)}
		r := call(t, newH(f), http.MethodGet, boardsPath, nil, "X-Request-Id", "req-1")
		items, _ := r.body["items"].([]any)
		if r.code != 200 || len(items) != 1 || r.body["truncated"] != false {
			t.Fatalf("list = %d %s", r.code, r.raw)
		}
		by, _ := items[0].(map[string]any)["updated_by"].(map[string]any)
		if by["name"] != "Local user" || by["kind"] != "local" {
			t.Errorf("updated_by = %v, want local / Local user", by)
		}
		if f.rc == nil || f.rc.Org != testOrg || f.rc.Actor != core.LocalActor() || f.rc.RequestID != "req-1" {
			t.Errorf("RequestCtx = %+v", f.rc)
		}
	})
	t.Run("2 get", func(t *testing.T) {
		r := call(t, newH(&fakeBoards{board: sampleBoard(3, 3)}), http.MethodGet, boardsPath+"/abc", nil)
		if r.code != 200 || r.hdr.Get("ETag") != `"3"` {
			t.Fatalf("get = %d ETag %q %s", r.code, r.hdr.Get("ETag"), r.raw)
		}
		if _, ok := r.body["spec"].(map[string]any); !ok {
			t.Errorf("spec = %T, want a JSON object", r.body["spec"])
		}
		if r.body["etag"] != "3" || r.body["schema_version"] != float64(2) || r.body["version"] != float64(3) {
			t.Errorf("body = %s", r.raw)
		}
	})
	t.Run("3 get unknown", func(t *testing.T) {
		r := call(t, newH(&fakeBoards{err: core.ErrNotFound}), http.MethodGet, boardsPath+"/abc", nil)
		if r.code != 404 || errCode(r) != "not_found" || errMessage(r) != "board not found" {
			t.Errorf("get unknown = %d %s", r.code, r.raw)
		}
	})
	t.Run("4 get bad uid", func(t *testing.T) {
		f := &fakeBoards{}
		r := call(t, newH(f), http.MethodGet, boardsPath+"/A_b", nil)
		if r.code != 404 || errCode(r) != "not_found" || len(f.calls) != 0 {
			t.Errorf("get A_b = %d %s, calls %v", r.code, r.raw, f.calls)
		}
	})
	t.Run("5 post", func(t *testing.T) {
		r := call(t, newH(&fakeBoards{board: sampleBoard(1, 1)}), http.MethodPost, boardsPath, body)
		if r.code != 201 || r.hdr.Get("Location") != boardsPath+"/abc" || r.hdr.Get("ETag") != `"1"` {
			t.Errorf("post = %d Location %q ETag %q %s", r.code, r.hdr.Get("Location"), r.hdr.Get("ETag"), r.raw)
		}
	})
	t.Run("6 post invalid", func(t *testing.T) {
		f := &fakeBoards{err: &spec.ValidationError{Fields: []spec.FieldError{{Pointer: "/title", MessageKey: "board.title.required"}}}}
		r := call(t, newH(f), http.MethodPost, boardsPath, body)
		e, _ := r.body["error"].(map[string]any)
		if r.code != 400 || errCode(r) != "invalid" || !jsonEqual(t, e["fields"], []map[string]string{{"pointer": "/title", "message_key": "board.title.required"}}) {
			t.Errorf("post invalid = %d %s", r.code, r.raw)
		}
	})
	t.Run("7 put without If-Match", func(t *testing.T) {
		f := &fakeBoards{}
		r := call(t, newH(f), http.MethodPut, boardsPath+"/abc", body)
		if r.code != 428 || errCode(r) != "invalid" || errMessage(r) != "If-Match is required" || len(f.calls) != 0 {
			t.Errorf("put = %d %s, calls %v", r.code, r.raw, f.calls)
		}
	})
	t.Run("8 put weak If-Match", func(t *testing.T) {
		r := call(t, newH(&fakeBoards{}), http.MethodPut, boardsPath+"/abc", body, "If-Match", `W/"1"`)
		if r.code != 400 || errMessage(r) != "If-Match must be an ETag from this API" {
			t.Errorf("put W/ = %d %s", r.code, r.raw)
		}
	})
	t.Run("9 put conflict", func(t *testing.T) {
		f := &fakeBoards{err: &core.ConflictError{Current: sampleBoard(2, 2)}}
		r := call(t, newH(f), http.MethodPut, boardsPath+"/abc", body, "If-Match", `"1"`)
		cur, _ := r.body["current"].(map[string]any)
		if r.code != 409 || errCode(r) != "conflict" || cur["version"] != float64(2) || !jsonEqual(t, r.body["submitted"], sent) {
			t.Errorf("put conflict = %d %s", r.code, r.raw)
		}
	})
	t.Run("10 put ok", func(t *testing.T) {
		f := &fakeBoards{saved: core.SaveResult{Board: sampleBoard(2, 2), Changed: true}}
		r := call(t, newH(f), http.MethodPut, boardsPath+"/abc", body, "If-Match", `"1"`)
		if r.code != 200 || r.body["changed"] != true || r.hdr.Get("ETag") != `"2"` {
			t.Errorf("put = %d ETag %q %s", r.code, r.hdr.Get("ETag"), r.raw)
		}
	})
	t.Run("11 delete", func(t *testing.T) {
		r := call(t, newH(&fakeBoards{}), http.MethodDelete, boardsPath+"/abc", nil, "If-Match", `"2"`)
		if r.code != 204 {
			t.Errorf("delete = %d %s", r.code, r.raw)
		}
	})
	t.Run("12 delete conflict", func(t *testing.T) {
		f := &fakeBoards{err: &core.ConflictError{Current: sampleBoard(3, 3)}}
		r := call(t, newH(f), http.MethodDelete, boardsPath+"/abc", nil, "If-Match", `"2"`)
		if _, has := r.body["submitted"]; r.code != 409 || errCode(r) != "conflict" || has {
			t.Errorf("delete conflict = %d %s", r.code, r.raw)
		}
	})
	t.Run("13 store error", func(t *testing.T) {
		r := call(t, newH(&fakeBoards{err: errors.New("x")}), http.MethodGet, boardsPath+"/abc", nil)
		if r.code != 503 || errCode(r) != "unavailable" || errMessage(r) != "configuration store unavailable" {
			t.Errorf("get = %d %s", r.code, r.raw)
		}
	})
	t.Run("14 schema too new", func(t *testing.T) {
		r := call(t, newH(&fakeBoards{err: spec.ErrSchemaTooNew}), http.MethodGet, boardsPath+"/abc", nil)
		if r.code != 503 || errMessage(r) != "board saved by a newer server version" {
			t.Errorf("get = %d %s", r.code, r.raw)
		}
	})
	t.Run("15 no service", func(t *testing.T) {
		h := New(Deps{Probe: &fakeProbe{version: 1}, SchemaLatest: 1})
		for _, p := range []struct{ method, path string }{{"GET", boardsPath}, {"GET", boardsPath + "/abc"}, {"GET", "/api/dash/v1/me/starred-boards"}, {"PUT", "/api/dash/v1/me/recent-boards/abc"}} {
			if r := call(t, h, p.method, p.path, nil); r.code != 503 || errCode(r) != "unavailable" {
				t.Errorf("%s %s without a service = %d %s", p.method, p.path, r.code, r.raw)
			}
		}
	})
	t.Run("16 body too large", func(t *testing.T) {
		f := &fakeBoards{}
		prefix, suffix := `{"spec":{"title":"`, `","panels":[],"sections":[]}}`
		big := []byte(prefix + strings.Repeat("a", 2<<20+1-len(prefix)-len(suffix)) + suffix)
		if len(big) != 2<<20+1 {
			t.Fatalf("body is %d bytes", len(big))
		}
		r := call(t, newH(f), http.MethodPost, boardsPath, big)
		if r.code != 413 || errCode(r) != "invalid" || errMessage(r) != "request body too large" || len(f.calls) != 0 {
			t.Errorf("post 2 MiB + 1 = %d %s, calls %v", r.code, r.raw, f.calls)
		}
	})
	t.Run("17 starred and recent", func(t *testing.T) {
		f := &fakeBoards{}
		h := newH(f)
		if r := call(t, h, http.MethodPut, "/api/dash/v1/me/starred-boards/u1", nil); r.code != 204 {
			t.Errorf("star = %d %s", r.code, r.raw)
		}
		if r := call(t, h, http.MethodDelete, "/api/dash/v1/me/starred-boards/u1", nil); r.code != 204 {
			t.Errorf("unstar = %d %s", r.code, r.raw)
		}
		if r := call(t, h, http.MethodGet, "/api/dash/v1/me/recent-boards?limit=60", nil); r.code != 200 || f.limit != 50 {
			t.Errorf("recent = %d %s, limit %d; want 200 and 50", r.code, r.raw, f.limit)
		}
		for q, want := range map[string]int{"": 5, "?limit=0": 1, "?limit=7": 7} {
			if call(t, h, http.MethodGet, "/api/dash/v1/me/recent-boards"+q, nil); f.limit != want {
				t.Errorf("recent%s: limit %d, want %d", q, f.limit, want)
			}
		}
		if r := call(t, h, http.MethodGet, "/api/dash/v1/me/starred-boards", nil); r.code != 200 || !jsonEqual(t, r.body, map[string]any{"items": []map[string]string{{"uid": "u1", "title": "One"}}, "applied": map[string]any{}, "truncated": false}) {
			t.Errorf("starred = %d %s", r.code, r.raw)
		}
		if r := call(t, h, http.MethodPut, "/api/dash/v1/me/recent-boards/u1", nil); r.code != 204 {
			t.Errorf("record view = %d %s", r.code, r.raw)
		}
		want := "star u1,unstar u1,recent,recent,recent,recent,starred,view u1"
		if got := strings.Join(f.calls, ","); got != want {
			t.Errorf("calls = %s, want %s", got, want)
		}
	})
}

// Plan #61 Part C §3.9: the optional `at` (ms since the Unix epoch) of PUT /me/recent-boards/{uid}.
func TestRecordViewAt(t *testing.T) {
	newH := func(f *fakeBoards) http.Handler {
		return New(Deps{Probe: &fakeProbe{version: 1}, SchemaLatest: 1, Boards: f, Org: testOrg})
	}
	const path = "/api/dash/v1/me/recent-boards/u1"
	f := &fakeBoards{}
	h := newH(f)
	if r := call(t, h, http.MethodPut, path+"?at=1700000000000", nil); r.code != 204 {
		t.Fatalf("at=1700000000000: %d %s", r.code, r.raw)
	}
	if r := call(t, h, http.MethodPut, path, nil); r.code != 204 {
		t.Fatalf("no at: %d %s", r.code, r.raw)
	}
	want := time.UnixMilli(1700000000000).UTC()
	if len(f.at) != 2 || f.at[0] == nil || !f.at[0].Equal(want) || f.at[0].Location() != time.UTC || f.at[1] != nil {
		t.Errorf("at = %v, want [%v <nil>]", f.at, want)
	}
	for _, q := range []string{"?at=-1", "?at=253402300800000", "?at=x"} {
		f := &fakeBoards{}
		r := call(t, newH(f), http.MethodPut, path+q, nil)
		if r.code != 400 || errCode(r) != "invalid" || len(f.calls) != 0 {
			t.Errorf("%s = %d %s, calls %v; want 400 invalid and no store call", q, r.code, r.raw, f.calls)
		}
	}
	if r := call(t, newH(&fakeBoards{}), http.MethodPut, path+"?at=-1", nil); errMessage(r) != "invalid request" {
		t.Errorf("at=-1 message = %q, want %q", errMessage(r), "invalid request")
	}
	if r := call(t, newH(&fakeBoards{}), http.MethodPut, path+"?at=253402300799999", nil); r.code != 204 {
		t.Errorf("at=253402300799999 = %d %s, want 204", r.code, r.raw)
	}
}

func TestIfMatch(t *testing.T) {
	cases := []struct {
		in     string
		want   int64
		status int
	}{
		{`"1"`, 1, 0},
		{`"9223372036854775807"`, 9223372036854775807, 0},
		{``, 0, 428},
		{`1`, 0, 400},
		{`"01"`, 0, 400},
		{`W/"1"`, 0, 400},
		{`*`, 0, 400},
		{`"1", "2"`, 0, 400},
		{`"9223372036854775808"`, 0, 400},
		{`""`, 0, 400},
		{`"0"`, 0, 400},
	}
	for _, tc := range cases {
		v := &tc.in
		if tc.in == "" {
			v = nil
		}
		got, status, _ := parseIfMatch(v)
		if got != tc.want || status != tc.status {
			t.Errorf("parseIfMatch(%q) = %d, %d; want %d, %d", tc.in, got, status, tc.want, tc.status)
		}
	}
	empty := ""
	if _, status, _ := parseIfMatch(&empty); status != 428 {
		t.Errorf("parseIfMatch(empty value) status %d, want 428", status)
	}
}

// Review r1 #1: the whole body of a create or update is checked before the generated decoder.
func TestBoardRequestEnvelope(t *testing.T) {
	spec := `{"title":"T","panels":[],"sections":[]}`
	cases := []struct {
		name, method, path, body string
		status                   int
		fields                   string // JSON of error.fields, "" = not checked
	}{
		{"unknown key", "POST", boardsPath, `{"spec":` + spec + `,"extra":1}`, 400, `[{"pointer":"/extra","message_key":"board.json.unknownKey"}]`},
		{"wrong case", "POST", boardsPath, `{"Spec":` + spec + `}`, 400, `[{"pointer":"/Spec","message_key":"board.json.unknownKey"},{"pointer":"/spec","message_key":"board.json.required"}]`},
		{"duplicate spec", "POST", boardsPath, `{"spec":` + spec + `,"spec":` + spec + `}`, 400, `[{"pointer":"/spec","message_key":"board.json.duplicateKey"}]`},
		{"trailing value", "POST", boardsPath, `{"spec":` + spec + `}{"spec":` + spec + `}`, 400, `[{"pointer":"","message_key":"board.json.invalid"}]`},
		{"missing spec", "POST", boardsPath, `{}`, 400, `[{"pointer":"/spec","message_key":"board.json.required"}]`},
		{"not JSON", "POST", boardsPath, `{"spec":`, 400, `[{"pointer":"","message_key":"board.json.invalid"}]`},
		{"message on create", "POST", boardsPath, `{"spec":` + spec + `,"message":"m"}`, 400, `[{"pointer":"/message","message_key":"board.json.unknownKey"}]`},
		{"put unknown key", "PUT", boardsPath + "/abc", `{"spec":` + spec + `,"Message":"m"}`, 400, `[{"pointer":"/Message","message_key":"board.json.unknownKey"}]`},
		{"put message type", "PUT", boardsPath + "/abc", `{"spec":` + spec + `,"message":5}`, 400, `[{"pointer":"/message","message_key":"board.json.type"}]`},
		{"put duplicate message", "PUT", boardsPath + "/abc", `{"spec":` + spec + `,"message":"a","message":"b"}`, 400, `[{"pointer":"/message","message_key":"board.json.duplicateKey"}]`},
		{"put trailing data", "PUT", boardsPath + "/abc", `{"spec":` + spec + `} x`, 400, `[{"pointer":"","message_key":"board.json.invalid"}]`},
		{"oversized trailing whitespace", "POST", boardsPath, `{"spec":` + spec + `}` + strings.Repeat(" ", 2<<20), 413, ""},
		{"oversized trailing value", "PUT", boardsPath + "/abc", `{"spec":` + spec + `}` + `[` + strings.Repeat("1,", 1<<20) + `1]`, 413, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeBoards{board: sampleBoard(1, 1), saved: core.SaveResult{Board: sampleBoard(2, 2), Changed: true}}
			h := New(Deps{Probe: &fakeProbe{version: 1}, SchemaLatest: 1, Boards: f, Org: testOrg})
			r := call(t, h, tc.method, tc.path, []byte(tc.body), "If-Match", `"1"`)
			if r.code != tc.status || errCode(r) != "invalid" || len(f.calls) != 0 {
				t.Fatalf("%d %s, calls %v; want %d invalid and no call", r.code, r.raw, f.calls, tc.status)
			}
			if tc.fields != "" {
				e, _ := r.body["error"].(map[string]any)
				if e["message"] != "invalid request" || !jsonEqual(t, e["fields"], []byte(tc.fields)) {
					t.Errorf("error = %v, want invalid request with fields %s", e, tc.fields)
				}
			}
		})
	}
	// A valid envelope still reaches the service, with the same bytes.
	f := &fakeBoards{board: sampleBoard(1, 1), saved: core.SaveResult{Board: sampleBoard(2, 2), Changed: true}}
	h := New(Deps{Probe: &fakeProbe{version: 1}, SchemaLatest: 1, Boards: f, Org: testOrg})
	if r := call(t, h, "PUT", boardsPath+"/abc", []byte(`{"spec":`+spec+`,"message":"m"}`+"\n"), "If-Match", `"1"`); r.code != 200 {
		t.Errorf("valid update = %d %s", r.code, r.raw)
	}
	if r := call(t, h, "POST", boardsPath, []byte(`{"spec":`+spec+`}`)); r.code != 201 {
		t.Errorf("valid create = %d %s", r.code, r.raw)
	}
}

func listHandler(f *fakeBoards) http.Handler {
	return New(Deps{Probe: &fakeProbe{version: 1}, SchemaLatest: 1, Boards: f, Org: testOrg})
}

func fieldsOf(r resp) []any {
	e, _ := r.body["error"].(map[string]any)
	fs, _ := e["fields"].([]any)
	return fs
}

// TestListBoardsParams: q and tag of GET /boards (plan #215 §3.6, T24-021). Every 400 is answered
// before any service call; a valid filter reaches the service unchanged and is echoed in applied.
func TestListBoardsParams(t *testing.T) {
	type field struct{ pointer, key string }
	for _, tc := range []struct {
		name, query string
		status      int
		fields      []field
		filter      core.BoardFilter
		applied     string
	}{
		{name: "q", query: "q=Checkout", status: 200, filter: core.BoardFilter{Q: "Checkout"}, applied: `{"q":"Checkout"}`},
		{name: "none", query: "", status: 200, applied: `{}`},
		{name: "q empty", query: "q=", status: 400, fields: []field{{"/q", "boards.q.invalid"}}},
		{name: "q 101", query: "q=" + strings.Repeat("a", 101), status: 400, fields: []field{{"/q", "boards.q.invalid"}}},
		{name: "q 100 runes", query: "q=" + strings.Repeat("%C3%A9", 100), status: 200, filter: core.BoardFilter{Q: strings.Repeat("é", 100)}, applied: `{"q":"` + strings.Repeat("é", 100) + `"}`},
		{name: "q tab", query: "q=a%09b", status: 400, fields: []field{{"/q", "boards.q.invalid"}}},
		{name: "q del", query: "q=a%7Fb", status: 400, fields: []field{{"/q", "boards.q.invalid"}}},
		{name: "q nel", query: "q=a%C2%85b", status: 400, fields: []field{{"/q", "boards.q.invalid"}}},
		{name: "q not utf-8", query: "q=%FF", status: 400, fields: []field{{"/q", "boards.q.invalid"}}},
		{name: "q kept untrimmed", query: "q=+a+", status: 200, filter: core.BoardFilter{Q: " a "}, applied: `{"q":" a "}`},
		{name: "tag", query: "tag=team:payments", status: 200, filter: core.BoardFilter{Tag: "team:payments"}, applied: `{"tag":"team:payments"}`},
		{name: "tag bad", query: "tag=Bad%20Tag", status: 400, fields: []field{{"/tag", "boards.tag.invalid"}}},
		{name: "tag empty", query: "tag=", status: 400, fields: []field{{"/tag", "boards.tag.invalid"}}},
		{name: "both invalid", query: "q=%09&tag=Bad", status: 400, fields: []field{{"/q", "boards.q.invalid"}}},
		{name: "both", query: "q=a&tag=b", status: 200, filter: core.BoardFilter{Q: "a", Tag: "b"}, applied: `{"q":"a","tag":"b"}`},
		{name: "q repeated", query: "q=a&q=b", status: 400, fields: []field{{"/q", "field.type"}}},
		{name: "tag repeated", query: "tag=a&tag=b", status: 400, fields: []field{{"/tag", "field.type"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeBoards{board: sampleBoard(1, 1)}
			path := boardsPath
			if tc.query != "" {
				path += "?" + tc.query
			}
			r := call(t, listHandler(f), http.MethodGet, path, nil)
			if r.code != tc.status {
				t.Fatalf("GET %s = %d %s, want %d", path, r.code, r.raw, tc.status)
			}
			if tc.status != 200 {
				want := make([]map[string]string, 0, len(tc.fields))
				for _, fe := range tc.fields {
					want = append(want, map[string]string{"pointer": fe.pointer, "message_key": fe.key})
				}
				if errCode(r) != "invalid" || !jsonEqual(t, fieldsOf(r), want) {
					t.Errorf("GET %s = %s, want invalid with fields %v", path, r.raw, want)
				}
				if tc.fields[0].key != "field.type" && errMessage(r) != "invalid request" {
					t.Errorf("message = %q, want %q", errMessage(r), "invalid request")
				}
				if len(f.calls) != 0 {
					t.Errorf("service called on a 400: %v", f.calls)
				}
				return
			}
			if len(f.filters) != 1 || f.filters[0] != tc.filter {
				t.Errorf("filters = %+v, want [%+v]", f.filters, tc.filter)
			}
			if !jsonEqual(t, r.body["applied"], []byte(tc.applied)) {
				t.Errorf("applied = %v, want %s", r.body["applied"], tc.applied)
			}
		})
	}
}

// TestListBoardsShape: tags ([] when fresh and empty, null when stale), tagsStale, truncated and
// applied of the board and ref lists (T24-021, T24-029).
func TestListBoardsShape(t *testing.T) {
	at := time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC)
	sum := func(uid string, tags []string, fresh bool) core.BoardSummary {
		return core.BoardSummary{UID: uid, Title: uid, Version: 1, UpdatedAt: at, UpdatedBy: core.LocalActor(), Tags: tags, TagsFresh: fresh}
	}
	page := core.BoardPage{Items: []core.BoardSummary{sum("a", nil, true), sum("b", []string{"a"}, true), sum("c", nil, false)},
		Truncated: true, TagsStale: 1}
	f := &fakeBoards{page: &page, starredMore: true}
	h := listHandler(f)
	r := call(t, h, http.MethodGet, boardsPath, nil)
	if r.code != 200 {
		t.Fatalf("list = %d %s", r.code, r.raw)
	}
	items, _ := r.body["items"].([]any)
	if len(items) != 3 {
		t.Fatalf("items = %s", r.raw)
	}
	for i, want := range []string{`[]`, `["a"]`, `null`} {
		it, _ := items[i].(map[string]any)
		got, ok := it["tags"]
		if !ok || !jsonEqual(t, got, []byte(want)) {
			t.Errorf("items[%d].tags = %v (present %v), want %s", i, got, ok, want)
		}
	}
	if r.body["tagsStale"] != float64(1) || r.body["truncated"] != true || !jsonEqual(t, r.body["applied"], []byte(`{}`)) {
		t.Errorf("list = %s, want tagsStale 1, truncated, applied {}", r.raw)
	}
	for _, tc := range []struct {
		path      string
		truncated bool
	}{{"/api/dash/v1/me/starred-boards", true}, {"/api/dash/v1/me/recent-boards", false}} {
		r := call(t, h, http.MethodGet, tc.path, nil)
		applied, ok := r.body["applied"]
		if r.code != 200 || !ok || !jsonEqual(t, applied, []byte(`{}`)) || r.body["truncated"] != tc.truncated {
			t.Errorf("GET %s = %d %s, want applied {} and truncated %v", tc.path, r.code, r.raw, tc.truncated)
		}
	}
}
