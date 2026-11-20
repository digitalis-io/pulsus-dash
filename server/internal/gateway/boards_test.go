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
}

func (f *fakeBoards) record(call string, rc *core.RequestCtx) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
	f.rc = rc
}

func (f *fakeBoards) ListBoards(_ context.Context, rc *core.RequestCtx) ([]core.BoardSummary, bool, error) {
	f.record("list", rc)
	return []core.BoardSummary{f.board.BoardSummary}, false, f.err
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

func (f *fakeBoards) ListStarred(_ context.Context, rc *core.RequestCtx) ([]core.BoardRef, error) {
	f.record("starred", rc)
	return []core.BoardRef{{UID: "u1", Title: "One"}}, f.err
}

func (f *fakeBoards) SetStarred(_ context.Context, rc *core.RequestCtx, uid string, starred bool) error {
	if starred {
		f.record("star "+uid, rc)
	} else {
		f.record("unstar "+uid, rc)
	}
	return f.err
}

func (f *fakeBoards) ListRecent(_ context.Context, rc *core.RequestCtx, limit int) ([]core.BoardRef, error) {
	f.record("recent", rc)
	f.mu.Lock()
	f.limit = limit
	f.mu.Unlock()
	return []core.BoardRef{}, f.err
}

func (f *fakeBoards) RecordView(_ context.Context, rc *core.RequestCtx, uid string) error {
	f.record("view "+uid, rc)
	return f.err
}

var testOrg = core.OrgID{1}

func sampleBoard(version, etag int64) core.Board {
	return core.Board{
		BoardSummary: core.BoardSummary{UID: "abc", Title: "T", Version: version,
			UpdatedAt: time.Date(2026, 11, 20, 10, 0, 0, 0, time.UTC), UpdatedBy: core.LocalActor()},
		ETag: etag, SchemaVersion: 1, Spec: []byte(`{"panels":[],"sections":[],"title":"T"}`),
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
		if r.body["etag"] != "3" || r.body["schema_version"] != float64(1) || r.body["version"] != float64(3) {
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
		if r := call(t, h, http.MethodGet, "/api/dash/v1/me/starred-boards", nil); r.code != 200 || !jsonEqual(t, r.body, map[string]any{"items": []map[string]string{{"uid": "u1", "title": "One"}}}) {
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
