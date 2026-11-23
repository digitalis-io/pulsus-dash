package gateway

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// fakeAnnotations is a recording core.Annotations: Create echoes its input with a fixed id, List
// records its window and limit, Delete knows only `known`.
type fakeAnnotations struct {
	mu       sync.Mutex
	calls    []string
	created  []core.NewAnnotation
	from, to time.Time
	limit    int
	known    uuid.UUID
	rc       *core.RequestCtx
}

var fakeAnnotationID = uuid.MustParse("01900000-0000-7000-8000-000000000001")

func (f *fakeAnnotations) record(call string, rc *core.RequestCtx) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
	f.rc = rc
}

func (f *fakeAnnotations) CreateAnnotation(_ context.Context, rc *core.RequestCtx, a core.NewAnnotation) (core.Annotation, error) {
	f.record("create", rc)
	f.mu.Lock()
	f.created = append(f.created, a)
	f.mu.Unlock()
	return core.Annotation{ID: fakeAnnotationID, At: a.At, EndAt: a.EndAt, Kind: a.Kind, Text: a.Text, Tags: a.Tags}, nil
}

func (f *fakeAnnotations) ListAnnotations(_ context.Context, rc *core.RequestCtx, from, to time.Time, limit int) ([]core.Annotation, bool, error) {
	f.record("list", rc)
	f.mu.Lock()
	f.from, f.to, f.limit = from, to, limit
	f.mu.Unlock()
	return []core.Annotation{}, false, nil
}

func (f *fakeAnnotations) DeleteAnnotation(_ context.Context, rc *core.RequestCtx, id uuid.UUID) error {
	f.record("delete "+id.String(), rc)
	if id != f.known {
		return core.ErrNotFound
	}
	return nil
}

const annotationsPath = "/api/dash/v1/annotations"

func annotationsHandler(f core.Annotations) http.Handler {
	return New(Deps{Probe: &fakeProbe{version: 1}, SchemaLatest: 1, Annotations: f, Org: testOrg})
}

// fields returns the response's field errors as "pointer messageKey" strings.
func fields(r resp) []string {
	e, _ := r.body["error"].(map[string]any)
	list, _ := e["fields"].([]any)
	out := make([]string, 0, len(list))
	for _, x := range list {
		m, _ := x.(map[string]any)
		p, _ := m["pointer"].(string)
		k, _ := m["message_key"].(string)
		out = append(out, p+" "+k)
	}
	return out
}

func wantField(t *testing.T, r resp, want string) {
	t.Helper()
	got := fields(r)
	if r.code != http.StatusBadRequest || errCode(r) != "invalid" || len(got) != 1 || got[0] != want {
		t.Errorf("= %d %s, want 400 invalid with exactly [%s]", r.code, r.raw, want)
	}
}

func TestCreateAnnotationValidation(t *testing.T) {
	tags17 := `["a","b","c","d","e","f","g","h","i","j","k","l","m","n","o","p","q"]`
	cases := []struct {
		name, body, want string
	}{
		{"unknown key", `{"at":1,"kind":"deploy","text":"x","colour":1}`, "/colour annotation.unknown"},
		{"unknown before at", `{"kind":"deploy","text":"x","colour":1}`, "/colour annotation.unknown"},
		{"at absent", `{"kind":"deploy","text":"x"}`, "/at annotation.at.range"},
		{"at negative", `{"at":-1,"kind":"deploy","text":"x"}`, "/at annotation.at.range"},
		{"at too large", `{"at":253402300800000,"kind":"deploy","text":"x"}`, "/at annotation.at.range"},
		{"at fraction", `{"at":1.5,"kind":"deploy","text":"x"}`, "/at annotation.at.range"},
		{"at string", `{"at":"1","kind":"deploy","text":"x"}`, "/at annotation.at.range"},
		{"end before at", `{"at":10,"end_at":9,"kind":"deploy","text":"x"}`, "/end_at annotation.end.order"},
		{"end span", `{"at":0,"end_at":2678400001,"kind":"deploy","text":"x"}`, "/end_at annotation.end.span"},
		{"kind absent", `{"at":1,"text":"x"}`, "/kind annotation.kind.invalid"},
		{"kind other", `{"at":1,"kind":"alert","text":"x"}`, "/kind annotation.kind.invalid"},
		{"text absent", `{"at":1,"kind":"deploy"}`, "/text annotation.text.length"},
		{"text blank", `{"at":1,"kind":"deploy","text":" 　\t"}`, "/text annotation.text.length"},
		{"text long", `{"at":1,"kind":"deploy","text":"` + strings.Repeat("é", 501) + `"}`, "/text annotation.text.length"},
		{"tags count", `{"at":1,"kind":"deploy","text":"x","tags":` + tags17 + `}`, "/tags annotation.tags.count"},
		{"tag invalid", `{"at":1,"kind":"deploy","text":"x","tags":["ok","Bad"]}`, "/tags/1 annotation.tags.invalid"},
		{"tag duplicate", `{"at":1,"kind":"deploy","text":"x","tags":["ci","ci"]}`, "/tags/1 annotation.tags.duplicate"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &fakeAnnotations{}
			wantField(t, call(t, annotationsHandler(f), http.MethodPost, annotationsPath, []byte(c.body)), c.want)
			if len(f.calls) != 0 {
				t.Errorf("service called: %v", f.calls)
			}
		})
	}
	t.Run("500 code points pass", func(t *testing.T) {
		f := &fakeAnnotations{}
		r := call(t, annotationsHandler(f), http.MethodPost, annotationsPath, []byte(`{"at":1,"kind":"deploy","text":"`+strings.Repeat("é", 500)+`"}`))
		if r.code != http.StatusCreated {
			t.Errorf("= %d %s, want 201", r.code, r.raw)
		}
	})
	t.Run("too large", func(t *testing.T) {
		f := &fakeAnnotations{}
		pad := strings.Repeat(" ", 16385-len(`{"at":1,"kind":"deploy","text":"x"}`))
		body := `{"at":1,"kind":"deploy","text":"x"}` + pad
		if len(body) != 16385 {
			t.Fatalf("body is %d bytes", len(body))
		}
		r := call(t, annotationsHandler(f), http.MethodPost, annotationsPath, []byte(body))
		if r.code != http.StatusRequestEntityTooLarge || len(f.calls) != 0 {
			t.Errorf("= %d %s calls %v, want 413 and no call", r.code, r.raw, f.calls)
		}
	})
	for _, body := range []string{`{"at":1,"kind":"deploy","text":"x"}{}`, `[]`, `"x"`, `{`, ``} {
		t.Run("not one object "+body, func(t *testing.T) {
			f := &fakeAnnotations{}
			r := call(t, annotationsHandler(f), http.MethodPost, annotationsPath, []byte(body))
			if r.code != http.StatusBadRequest || errCode(r) != "invalid" || errMessage(r) != "invalid request" || len(fields(r)) != 0 || len(f.calls) != 0 {
				t.Errorf("= %d %s calls %v, want 400 invalid request without fields", r.code, r.raw, f.calls)
			}
		})
	}
}

func TestCreateAnnotationOK(t *testing.T) {
	f := &fakeAnnotations{}
	h := annotationsHandler(f)
	body := `{"at":1767227400000,"kind":"deploy","text":"v2.31","tags":["ci"]}`
	r := call(t, h, http.MethodPost, annotationsPath, []byte(body), "X-Request-Id", "req-a")
	want := `{"id":"` + fakeAnnotationID.String() + `","at":1767227400000,"end_at":null,"kind":"deploy","text":"v2.31","tags":["ci"]}`
	if r.code != http.StatusCreated || !jsonEqual(t, r.raw, []byte(want)) {
		t.Fatalf("= %d %s, want 201 %s", r.code, r.raw, want)
	}
	if f.rc == nil || f.rc.Org != testOrg || f.rc.Actor != core.LocalActor() || f.rc.RequestID != "req-a" {
		t.Errorf("RequestCtx = %+v", f.rc)
	}
	if a := f.created[0]; !a.At.Equal(time.UnixMilli(1767227400000)) || a.At.Location() != time.UTC || a.EndAt != nil {
		t.Errorf("created %+v", a)
	}
	r = call(t, h, http.MethodPost, annotationsPath, []byte(`{"at":5,"end_at":7,"kind":"annotation","text":"m"}`))
	want = `{"id":"` + fakeAnnotationID.String() + `","at":5,"end_at":7,"kind":"annotation","text":"m","tags":[]}`
	if r.code != http.StatusCreated || !jsonEqual(t, r.raw, []byte(want)) {
		t.Errorf("no tags = %d %s, want 201 %s", r.code, r.raw, want)
	}
	if tags := f.created[1].Tags; tags == nil || len(tags) != 0 {
		t.Errorf("service tags = %#v, want an empty non-nil slice", tags)
	}
}

func TestListAnnotationsParams(t *testing.T) {
	cases := []struct{ query, want string }{
		{"to=10", "/from annotations.window.invalid"},
		{"from=5", "/to annotations.window.invalid"},
		{"from=05&to=10", "/from annotations.window.invalid"},
		{"from=-1&to=10", "/from annotations.window.invalid"},
		{"from=0&to=253402300800000", "/to annotations.window.invalid"},
		{"from=5&to=5", "/to annotations.window.invalid"},
		{"from=6&to=5", "/to annotations.window.invalid"},
		{"from=0&to=10&limit=0", "/limit annotations.limit.range"},
		{"from=0&to=10&limit=501", "/limit annotations.limit.range"},
		{"from=0&to=10&limit=x", "/limit annotations.limit.range"},
	}
	for _, c := range cases {
		t.Run(c.query, func(t *testing.T) {
			f := &fakeAnnotations{}
			wantField(t, call(t, annotationsHandler(f), http.MethodGet, annotationsPath+"?"+c.query, nil), c.want)
			if len(f.calls) != 0 {
				t.Errorf("service called: %v", f.calls)
			}
		})
	}
	t.Run("defaults", func(t *testing.T) {
		f := &fakeAnnotations{}
		r := call(t, annotationsHandler(f), http.MethodGet, annotationsPath+"?from=0&to=10", nil)
		if r.code != 200 || !jsonEqual(t, r.raw, []byte(`{"items":[],"truncated":false}`)) {
			t.Fatalf("= %d %s", r.code, r.raw)
		}
		if !f.from.Equal(time.UnixMilli(0)) || !f.to.Equal(time.UnixMilli(10)) || f.limit != 500 {
			t.Errorf("service got (%v, %v, %d), want (0 ms, 10 ms, 500)", f.from, f.to, f.limit)
		}
	})
	t.Run("limit", func(t *testing.T) {
		f := &fakeAnnotations{}
		if r := call(t, annotationsHandler(f), http.MethodGet, annotationsPath+"?from=0&to=10&limit=7", nil); r.code != 200 || f.limit != 7 {
			t.Errorf("= %d limit %d, want 200 and 7", r.code, f.limit)
		}
	})
}

func TestDeleteAnnotation(t *testing.T) {
	known := uuid.MustParse("01900000-0000-7000-8000-0000000000aa")
	f := &fakeAnnotations{known: known}
	h := annotationsHandler(f)
	r := call(t, h, http.MethodDelete, annotationsPath+"/"+strings.ToUpper(known.String()), nil)
	wantField(t, r, "/id annotation.id.invalid")
	if len(f.calls) != 0 {
		t.Errorf("service called for an invalid id: %v", f.calls)
	}
	r = call(t, h, http.MethodDelete, annotationsPath+"/01900000-0000-7000-8000-0000000000bb", nil)
	if r.code != http.StatusNotFound || errCode(r) != "not_found" || errMessage(r) != "annotation not found" {
		t.Errorf("unknown = %d %s, want 404 not_found", r.code, r.raw)
	}
	r = call(t, h, http.MethodDelete, annotationsPath+"/"+known.String(), nil)
	if r.code != http.StatusNoContent || len(r.raw) != 0 {
		t.Errorf("known = %d %s, want 204", r.code, r.raw)
	}
	nilH := New(Deps{Probe: &fakeProbe{version: 1}, SchemaLatest: 1, Org: testOrg})
	for _, c := range []struct{ method, path, body string }{
		{http.MethodGet, annotationsPath + "?from=0&to=10", ""},
		{http.MethodPost, annotationsPath, `{"at":1,"kind":"deploy","text":"x"}`},
		{http.MethodDelete, annotationsPath + "/" + known.String(), ""},
	} {
		var body []byte
		if c.body != "" {
			body = []byte(c.body)
		}
		if r := call(t, nilH, c.method, c.path, body); r.code != http.StatusServiceUnavailable || errCode(r) != "unavailable" {
			t.Errorf("nil service %s = %d %s, want 503 unavailable", c.method, r.code, r.raw)
		}
	}
}
