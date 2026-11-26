package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"reflect"
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
	filter   core.AnnotationFilter
	known    uuid.UUID
	rc       *core.RequestCtx
	page     *core.AnnotationPage // nil: an empty page with orgWideHidden 0
	err      error                // returned by every call when set
}

var (
	fakeAnnotationID = uuid.MustParse("01900000-0000-7000-8000-000000000001")
	fakeEntityID     = uuid.MustParse("bb7487bd-100d-a998-e0f0-3c65f11da1a7")
)

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
	if f.err != nil {
		return core.Annotation{}, f.err
	}
	out := core.Annotation{ID: fakeAnnotationID, At: a.At, EndAt: a.EndAt, Kind: a.Kind, Text: a.Text, Tags: a.Tags}
	if a.Entity != nil {
		out.Entity = &core.AnnotationEntity{ID: fakeEntityID, BindingID: fakeAnnotationID, Binding: a.Entity.Binding, CanonicalEntity: a.Entity.CanonicalEntity}
	}
	return out, nil
}

func (f *fakeAnnotations) ListAnnotations(_ context.Context, rc *core.RequestCtx, from, to time.Time, limit int, filter core.AnnotationFilter) (core.AnnotationPage, error) {
	f.record("list", rc)
	f.mu.Lock()
	f.from, f.to, f.limit, f.filter = from, to, limit, filter
	f.mu.Unlock()
	if f.err != nil {
		return core.AnnotationPage{}, f.err
	}
	if f.page != nil {
		return *f.page, nil
	}
	zero := int64(0)
	return core.AnnotationPage{Items: []core.Annotation{}, OrgWideHidden: &zero}, nil
}

func (f *fakeAnnotations) DeleteAnnotation(_ context.Context, rc *core.RequestCtx, id uuid.UUID) error {
	f.record("delete "+id.String(), rc)
	if f.err != nil {
		return f.err
	}
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
	want := `{"id":"` + fakeAnnotationID.String() + `","at":1767227400000,"end_at":null,"kind":"deploy","text":"v2.31","tags":["ci"],"entity":null}`
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
	want = `{"id":"` + fakeAnnotationID.String() + `","at":5,"end_at":7,"kind":"annotation","text":"m","tags":[],"entity":null}`
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
		{"from=0&to=10&kind=release", "/kind annotations.kind.invalid"},
		{"from=0&to=10&kind=deploy&kind=config&kind=flag&kind=annotation&kind=deploy", "/kind annotations.kind.invalid"},
		{"from=0&to=10&kind=deploy&kind=deploy", "/kind annotations.kind.invalid"},
		{"from=0&to=10&kind=", "/kind annotations.kind.invalid"},
		{"from=0&to=10&tag=Bad", "/tag annotations.tag.invalid"},
		{"from=0&to=10&" + repeat("tag", 9), "/tag annotations.tag.invalid"},
		{"from=0&to=10&tag=a&tag=a", "/tag annotations.tag.invalid"},
		{"from=0&to=10&entity=checkout", "/entity annotations.entity.invalid"},
		{"from=0&to=10&entity=BB7487BD-100D-A998-E0F0-3C65F11DA1A7", "/entity annotations.entity.invalid"},
		{"from=0&to=10&" + repeat("entity", 17), "/entity annotations.entity.invalid"},
		{"from=0&to=10&entity=" + entE + "&entity=" + entE, "/entity annotations.entity.invalid"},
		{"from=0&to=10&entity=" + entE + "&orgWide=yes", "/orgWide annotations.orgWide.invalid"},
		{"from=0&to=10&orgWide=true", "/orgWide annotations.orgWide.invalid"},
		{"from=0&to=10&entity=" + entE + "&orgWide=true&orgWide=true", "/orgWide annotations.orgWide.invalid"},
		{"from=0&to=10&beforeId=" + entE, "/beforeAt annotations.beforeAt.invalid"},
		{"from=0&to=10&beforeAt=-1&beforeId=" + entE, "/beforeAt annotations.beforeAt.invalid"},
		{"from=0&to=10&beforeAt=5&beforeAt=5&beforeId=" + entE, "/beforeAt annotations.beforeAt.invalid"},
		{"from=0&to=10&beforeAt=5", "/beforeId annotations.beforeId.invalid"},
		{"from=0&to=10&beforeAt=5&beforeId=" + strings.ToUpper(entE), "/beforeId annotations.beforeId.invalid"},
		{"from=0&to=10&kind=release&tag=Bad", "/kind annotations.kind.invalid"},
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
		if r.code != 200 || !jsonEqual(t, r.raw, []byte(`{"items":[],"truncated":false,"applied":{},"next":null,"orgWideHidden":0}`)) {
			t.Fatalf("= %d %s", r.code, r.raw)
		}
		if f.rc == nil || !f.rc.Scope.IsFullTenant() || f.rc.Principal != core.LocalPrincipal {
			t.Errorf("RequestCtx = %+v, want the local principal with full scope", f.rc)
		}
		if !reflect.DeepEqual(f.filter, core.AnnotationFilter{}) {
			t.Errorf("filter = %+v, want none", f.filter)
		}
		if !f.from.Equal(time.UnixMilli(0)) || !f.to.Equal(time.UnixMilli(10)) || f.limit != 500 {
			t.Errorf("service got (%v, %v, %d), want (0 ms, 10 ms, 500)", f.from, f.to, f.limit)
		}
	})
	t.Run("every filter", func(t *testing.T) {
		f := &fakeAnnotations{}
		c3 := "00000000-0000-4000-8000-000000000003"
		r := call(t, annotationsHandler(f), http.MethodGet, annotationsPath+"?from=0&to=10&kind=flag&kind=deploy&tag=a&entity="+entE+"&orgWide=true&beforeAt=5&beforeId="+c3, nil)
		want := `{"kinds":["flag","deploy"],"tags":["a"],"entity":["` + entE + `"],"orgWide":true,"before":{"at":5,"id":"` + c3 + `"}}`
		if r.code != 200 || !jsonEqual(t, raw(t, r, "applied"), []byte(want)) {
			t.Fatalf("= %d %s, want applied %s", r.code, r.raw, want)
		}
		wantF := core.AnnotationFilter{Kinds: []core.AnnotationKind{core.AnnotationFlag, core.AnnotationDeploy}, Tags: []string{"a"},
			Entities: []uuid.UUID{uuid.MustParse(entE)}, OrgWide: true, Before: &core.AnnotationCursor{At: time.UnixMilli(5).UTC(), ID: uuid.MustParse(c3)}}
		if !reflect.DeepEqual(f.filter, wantF) {
			t.Errorf("filter = %+v, want %+v", f.filter, wantF)
		}
		if f.rc == nil || !f.rc.Scope.IsFullTenant() {
			t.Errorf("RequestCtx scope is not full: %+v", f.rc)
		}
	})
	t.Run("orgWide false", func(t *testing.T) {
		f := &fakeAnnotations{}
		r := call(t, annotationsHandler(f), http.MethodGet, annotationsPath+"?from=0&to=10&entity="+entE+"&orgWide=false", nil)
		if r.code != 200 || !jsonEqual(t, raw(t, r, "applied"), []byte(`{"entity":["`+entE+`"],"orgWide":false}`)) || f.filter.OrgWide {
			t.Errorf("= %d %s filter %+v", r.code, r.raw, f.filter)
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

// entE is checkout@e1's EntityId.
const entE = "bb7487bd-100d-a998-e0f0-3c65f11da1a7"

// repeat is n distinct values of a list parameter: tags t0, t1, … or EntityIds.
func repeat(name string, n int) string {
	parts := make([]string, 0, n)
	for i := range n {
		v := fmt.Sprintf("t%d", i)
		if name == "entity" {
			v = fmt.Sprintf("00000000-0000-4000-8000-%012d", i)
		}
		parts = append(parts, name+"="+v)
	}
	return strings.Join(parts, "&")
}

// raw is the JSON of one key of the response body.
func raw(t *testing.T, r resp, key string) []byte {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(r.raw, &m); err != nil {
		t.Fatalf("%s: %v", r.raw, err)
	}
	return m[key]
}

func str(s string) *string { return &s }

func TestListAnnotationsShape(t *testing.T) {
	at := time.UnixMilli(1764158400000).UTC()
	c3 := uuid.MustParse("00000000-0000-4000-8000-000000000003")
	three := int64(3)
	item := core.Annotation{ID: c3, At: at, Kind: core.AnnotationFlag, Text: "x", Tags: []string{},
		Entity: &core.AnnotationEntity{ID: uuid.MustParse(entE), BindingID: uuid.MustParse("00000000-0000-4000-8000-0000000000e1"), Binding: "prod-eu",
			CanonicalEntity: core.CanonicalEntity{Kind: "service", Ident: []*string{nil, str("checkout")}, Attrs: map[string]string{"service.name": "checkout"}}}}
	orgWide := core.Annotation{ID: fakeAnnotationID, At: at, Kind: core.AnnotationNote, Text: "y", Tags: []string{}}
	f := &fakeAnnotations{page: &core.AnnotationPage{Items: []core.Annotation{item, orgWide}, Next: &core.AnnotationCursor{At: at, ID: c3}, OrgWideHidden: &three}}
	r := call(t, annotationsHandler(f), http.MethodGet, annotationsPath+"?from=0&to=10", nil)
	want := `{"items":[{"id":"` + c3.String() + `","at":1764158400000,"end_at":null,"kind":"flag","text":"x","tags":[],` +
		`"entity":{"id":"` + entE + `","binding":"prod-eu","kind":"service","ident":[null,"checkout"]}},` +
		`{"id":"` + fakeAnnotationID.String() + `","at":1764158400000,"end_at":null,"kind":"annotation","text":"y","tags":[],"entity":null}],` +
		`"truncated":true,"applied":{},"next":{"at":1764158400000,"id":"` + c3.String() + `"},"orgWideHidden":3}`
	if r.code != 200 || !jsonEqual(t, r.raw, []byte(want)) {
		t.Errorf("= %d %s, want %s", r.code, r.raw, want)
	}
	f = &fakeAnnotations{page: &core.AnnotationPage{Items: []core.Annotation{}}}
	r = call(t, annotationsHandler(f), http.MethodGet, annotationsPath+"?from=0&to=10", nil)
	if want := `{"items":[],"truncated":false,"applied":{},"next":null,"orgWideHidden":null}`; r.code != 200 || !jsonEqual(t, r.raw, []byte(want)) {
		t.Errorf("scoped = %d %s, want %s", r.code, r.raw, want)
	}
}

// entityFixture is wire/fixtures/json/entity-id.json's invalid cases.
func entityFixture(t *testing.T) []struct {
	Name  string          `json:"name"`
	Kind  string          `json:"kind"`
	Attrs json.RawMessage `json:"attrs"`
} {
	t.Helper()
	b, err := os.ReadFile("../../../wire/fixtures/json/entity-id.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Invalid []struct {
			Name  string          `json:"name"`
			Kind  string          `json:"kind"`
			Attrs json.RawMessage `json:"attrs"`
		} `json:"invalid"`
	}
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f.Invalid
}

func TestCreateAnnotationEntity(t *testing.T) {
	const head = `{"at":1,"kind":"deploy","text":"x","entity":`
	t.Run("checkout@prod-eu", func(t *testing.T) {
		f := &fakeAnnotations{}
		r := call(t, annotationsHandler(f), http.MethodPost, annotationsPath, []byte(head+`{"binding":"prod-eu","kind":"service","attrs":{"service.name":"checkout"}}}`))
		if r.code != http.StatusCreated || len(f.created) != 1 {
			t.Fatalf("= %d %s, want 201", r.code, r.raw)
		}
		want := &core.NewEntity{Binding: "prod-eu", CanonicalEntity: core.CanonicalEntity{Kind: "service", Ident: []*string{nil, str("checkout")}, Attrs: map[string]string{"service.name": "checkout"}}}
		if got := f.created[0].Entity; !reflect.DeepEqual(got, want) {
			t.Errorf("service got %+v, want %+v", got, want)
		}
		if !jsonEqual(t, raw(t, r, "entity"), []byte(`{"id":"`+entE+`","binding":"prod-eu","kind":"service","ident":[null,"checkout"]}`)) {
			t.Errorf("answer entity = %s", raw(t, r, "entity"))
		}
	})
	t.Run("null is absent", func(t *testing.T) {
		f := &fakeAnnotations{}
		r := call(t, annotationsHandler(f), http.MethodPost, annotationsPath, []byte(head+`null}`))
		if r.code != http.StatusCreated || len(f.created) != 1 || f.created[0].Entity != nil {
			t.Errorf("= %d %s, want 201 without an entity", r.code, r.raw)
		}
	})
	cases := []struct{ name, entity, want string }{
		{"array", `[]`, "/entity annotations.entity.invalid"},
		{"string", `"checkout"`, "/entity annotations.entity.invalid"},
		{"extra key", `{"binding":"prod-eu","kind":"service","attrs":{"service.name":"checkout"},"id":"x"}`, "/entity annotations.entity.invalid"},
		{"missing attrs", `{"binding":"prod-eu","kind":"service"}`, "/entity annotations.entity.invalid"},
		{"attrs string", `{"binding":"prod-eu","kind":"service","attrs":"a"}`, "/entity annotations.entity.invalid"},
		{"attrs null", `{"binding":"prod-eu","kind":"service","attrs":null}`, "/entity annotations.entity.invalid"},
		{"kind number", `{"binding":"prod-eu","kind":1,"attrs":{"service.name":"checkout"}}`, "/entity annotations.entity.invalid"},
		{"binding number", `{"binding":1,"kind":"service","attrs":{"service.name":"checkout"}}`, "/entity annotations.entity.invalid"},
		{"binding Bad", `{"binding":"Bad","kind":"service","attrs":{"service.name":"checkout"}}`, "/entity/binding annotations.entity.binding"},
	}
	for _, inv := range entityFixture(t) {
		kind, _ := json.Marshal(inv.Kind)
		cases = append(cases, struct{ name, entity, want string }{"fixture " + inv.Name,
			`{"binding":"prod-eu","kind":` + string(kind) + `,"attrs":` + string(inv.Attrs) + `}`, "/entity annotations.entity.invalid"})
	}
	cases = append(cases, struct{ name, entity, want string }{"unknown top key", `null,"colour":1`, "/colour annotation.unknown"})
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := &fakeAnnotations{}
			wantField(t, call(t, annotationsHandler(f), http.MethodPost, annotationsPath, []byte(head+c.entity+`}`)), c.want)
			if len(f.calls) != 0 {
				t.Errorf("service called: %v", f.calls)
			}
		})
	}
}

func TestAnnotationErrorMapping(t *testing.T) {
	type answer struct {
		status        int
		code, message string
		fields        []string
	}
	cases := []struct {
		name string
		err  error
		want answer
	}{
		{"invalid", &core.InvalidError{Pointer: "/entity/binding", Key: "annotations.entity.binding"},
			answer{400, "invalid", "invalid request", []string{"/entity/binding annotations.entity.binding"}}},
		{"scope error", &core.ScopeError{Pointer: "/entity", Key: "annotations.entity.scope"},
			answer{403, "scope_denied", "outside your data scope", []string{"/entity annotations.entity.scope"}}},
		{"scope denied", core.ErrScopeDenied, answer{403, "scope_denied", "data scope denied", []string{}}},
		{"wrapped scope denied", fmt.Errorf("annotations: %w", core.ErrScopeDenied), answer{403, "scope_denied", "data scope denied", []string{}}},
		{"not found", core.ErrNotFound, answer{404, "not_found", "annotation not found", []string{}}},
		{"other", errors.New("boom"), answer{503, "unavailable", msgUnavailable, []string{}}},
	}
	routes := []struct{ method, path, body string }{
		{http.MethodGet, annotationsPath + "?from=0&to=10", ""},
		{http.MethodPost, annotationsPath, `{"at":1,"kind":"deploy","text":"x"}`},
		{http.MethodDelete, annotationsPath + "/01900000-0000-7000-8000-0000000000aa", ""},
	}
	for _, c := range cases {
		for _, rt := range routes {
			t.Run(c.name+" "+rt.method, func(t *testing.T) {
				f := &fakeAnnotations{err: c.err}
				var body []byte
				if rt.body != "" {
					body = []byte(rt.body)
				}
				r := call(t, annotationsHandler(f), rt.method, rt.path, body)
				got := answer{r.code, errCode(r), errMessage(r), fields(r)}
				if !reflect.DeepEqual(got, c.want) {
					t.Errorf("= %+v (%s), want %+v", got, r.raw, c.want)
				}
			})
		}
	}
}
