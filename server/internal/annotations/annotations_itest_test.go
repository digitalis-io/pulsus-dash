//go:build itest

package annotations

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/entity"
	"github.com/digitalis-io/pulsus-dash/server/internal/store"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

// T is 2026-01-01T00:30:00Z (plan #64 Part C §5).
var T = time.Date(2026, 1, 1, 0, 30, 0, 0, time.UTC)

func itestCtx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	t.Cleanup(cancel)
	return ctx
}

func testSeed() (core.BootstrapSeed, error) {
	return core.BootstrapSeed{OrgSlug: "default", OrgName: "Default organisation",
		Binding: core.BindingSeed{Slug: "default", DatasourceURL: "http://localhost:9"}}, nil
}

// env is a migrated, seeded database and the service over its app role.
type env struct {
	db  *storetest.TestDB
	svc *Service
	org core.OrgID
}

func newEnv(t *testing.T, c storetest.Cluster) *env {
	t.Helper()
	db := storetest.NewDB(t, c)
	if _, err := store.Migrate(itestCtx(t), db.OwnerURL, store.MigrateOptions{Seed: testSeed}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	d, err := store.Open(itestCtx(t), db.AppURL, 8)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	st, err := d.InstallState(itestCtx(t))
	if err != nil {
		t.Fatal(err)
	}
	return &env{db: db, svc: New(d), org: st.BootstrapOrg}
}

func (e *env) rc(org core.OrgID) *core.RequestCtx {
	return &core.RequestCtx{Org: org, Actor: core.LocalActor(), RequestID: "itest-1", Scope: core.FullTenantScope()}
}

func (e *env) newOrg(t *testing.T, slug string) core.OrgID {
	t.Helper()
	org, _ := core.NewOrgID()
	storetest.Exec(t, e.db.SuperURL, "INSERT INTO orgs (id, slug, name) VALUES ($1, $2, $2)", uuid.UUID(org), slug)
	return org
}

func (e *env) create(t *testing.T, org core.OrgID, a core.NewAnnotation) core.Annotation {
	t.Helper()
	if a.Kind == "" {
		a.Kind = core.AnnotationDeploy
	}
	if a.Tags == nil {
		a.Tags = []string{}
	}
	got, err := e.svc.CreateAnnotation(itestCtx(t), e.rc(org), a)
	if err != nil {
		t.Fatalf("create %+v: %v", a, err)
	}
	return got
}

func (e *env) list(t *testing.T, org core.OrgID, from, to time.Time, limit int) ([]core.Annotation, bool) {
	t.Helper()
	page, err := e.svc.ListAnnotations(itestCtx(t), e.rc(org), from, to, limit, core.AnnotationFilter{})
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	return page.Items, page.Next != nil
}

func ids(items []core.Annotation) []uuid.UUID {
	out := make([]uuid.UUID, 0, len(items))
	for _, a := range items {
		out = append(out, a.ID)
	}
	return out
}

func ptr(t time.Time) *time.Time { return &t }

func TestAnnotationsRoundTrip(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			p1 := e.create(t, e.org, core.NewAnnotation{At: T.Add(7 * time.Millisecond), Text: "v2.31", Tags: []string{"ci", "web"}})
			r := e.create(t, e.org, core.NewAnnotation{At: T.Add(-2 * time.Hour), EndAt: ptr(T.Add(-40 * time.Minute)),
				Kind: core.AnnotationNote, Text: "maintenance"})
			p2 := e.create(t, e.org, core.NewAnnotation{At: T.Add(2 * time.Hour), Kind: core.AnnotationFlag, Text: "later"})
			items, truncated := e.list(t, e.org, T.Add(-time.Hour), T.Add(time.Hour), 500)
			if !reflect.DeepEqual(ids(items), []uuid.UUID{p1.ID, r.ID}) || truncated {
				t.Fatalf("[T−1h, T+1h] = %v truncated %v, want [P1 R] (P2 %v) not truncated", ids(items), truncated, p2.ID)
			}
			got := items[0]
			if !got.At.Equal(T.Add(7*time.Millisecond)) || got.At.Location() != time.UTC || got.EndAt != nil ||
				got.Kind != core.AnnotationDeploy || got.Text != "v2.31" || !reflect.DeepEqual(got.Tags, []string{"ci", "web"}) {
				t.Errorf("P1 = %+v", got)
			}
			if items[1].EndAt == nil || !items[1].EndAt.Equal(T.Add(-40*time.Minute)) || items[1].Kind != core.AnnotationNote ||
				items[1].Tags == nil || len(items[1].Tags) != 0 {
				t.Errorf("R = %+v", items[1])
			}
			if !reflect.DeepEqual(got, p1) {
				t.Errorf("created %+v, listed %+v", p1, got)
			}
			if items, _ := e.list(t, e.org, T.Add(3*time.Hour), T.Add(4*time.Hour), 500); len(items) != 0 {
				t.Errorf("[T+3h, T+4h] = %v, want []", ids(items))
			}
		})
	}
}

func TestAnnotationsTruncate(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			for i := range 501 {
				e.create(t, e.org, core.NewAnnotation{At: T.Add(time.Duration(i) * time.Millisecond), Text: "p"})
			}
			items, truncated := e.list(t, e.org, T, T.Add(time.Second), 500)
			if len(items) != 500 || !truncated {
				t.Fatalf("limit 500 = %d items truncated %v, want 500 and true", len(items), truncated)
			}
			if !items[0].At.Equal(T.Add(500*time.Millisecond)) || !items[499].At.Equal(T.Add(time.Millisecond)) {
				t.Errorf("first %v last %v, want T+500 ms and T+1 ms", items[0].At, items[499].At)
			}
			if items, truncated := e.list(t, e.org, T, T.Add(time.Second), 501); len(items) != 501 || truncated {
				t.Errorf("limit 501 = %d items truncated %v, want 501 and false", len(items), truncated)
			}
		})
	}
}

func TestAnnotationsOrgIsolation(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			a1 := e.create(t, e.org, core.NewAnnotation{At: T, Text: "a1"})
			b := e.newOrg(t, "org-b")
			if items, _ := e.list(t, b, T.Add(-time.Hour), T.Add(time.Hour), 500); len(items) != 0 {
				t.Errorf("org B lists %v, want []", ids(items))
			}
			if err := e.svc.DeleteAnnotation(itestCtx(t), e.rc(b), a1.ID); !errors.Is(err, core.ErrNotFound) {
				t.Errorf("org B delete = %v, want ErrNotFound", err)
			}
			if items, _ := e.list(t, e.org, T.Add(-time.Hour), T.Add(time.Hour), 500); !reflect.DeepEqual(ids(items), []uuid.UUID{a1.ID}) {
				t.Errorf("org A lists %v, want [A1]", ids(items))
			}
		})
	}
}

// auditRows returns the stored audit events of org in chain order, with prev_hash and hash.
func auditRows(t *testing.T, e *env, org core.OrgID) ([]core.AuditEvent, [][]byte, [][]byte) {
	t.Helper()
	rows := storetest.QueryRows(t, e.db.SuperURL, `SELECT id::text,
		to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'), actor_kind, actor_id::text, action,
		resource_kind, resource_id, request_id, diff::text, encode(prev_hash, 'hex'), encode(hash, 'hex')
		FROM audit_events WHERE org_id = $1 ORDER BY at, id`, uuid.UUID(org))
	var evs []core.AuditEvent
	var prevs, hashes [][]byte
	for _, r := range rows {
		at, err := time.Parse("2006-01-02T15:04:05.000000Z", r[1])
		if err != nil {
			t.Fatal(err)
		}
		ev := core.AuditEvent{ID: uuid.MustParse(r[0]), At: at, Actor: core.Actor{Kind: core.ActorKind(r[2])},
			Action: r[4], ResourceKind: r[5], ResourceID: r[6]}
		if r[3] != "NULL" {
			ev.Actor.ID = uuid.MustParse(r[3])
		}
		if r[7] != "NULL" {
			ev.RequestID = r[7]
		}
		if r[8] != "NULL" {
			ev.Diff = []byte(r[8])
		}
		var prev []byte
		if r[9] != "NULL" {
			prev, _ = hex.DecodeString(r[9])
		}
		h, _ := hex.DecodeString(r[10])
		evs, prevs, hashes = append(evs, ev), append(prevs, prev), append(hashes, h)
	}
	return evs, prevs, hashes
}

func sameJSON(t *testing.T, got []byte, want string) bool {
	t.Helper()
	var a, b any
	if err := json.Unmarshal(got, &a); err != nil {
		t.Fatalf("%s: %v", got, err)
	}
	if err := json.Unmarshal([]byte(want), &b); err != nil {
		t.Fatalf("%s: %v", want, err)
	}
	return reflect.DeepEqual(a, b)
}

func TestAnnotationsAudit(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			x := e.create(t, e.org, core.NewAnnotation{At: T, EndAt: ptr(T.Add(time.Minute)), Kind: core.AnnotationConfig, Text: "flags", Tags: []string{"ci"}})
			if err := e.svc.DeleteAnnotation(itestCtx(t), e.rc(e.org), x.ID); err != nil {
				t.Fatalf("delete: %v", err)
			}
			if err := e.svc.DeleteAnnotation(itestCtx(t), e.rc(e.org), x.ID); !errors.Is(err, core.ErrNotFound) {
				t.Fatalf("second delete = %v, want ErrNotFound", err)
			}
			evs, prevs, hashes := auditRows(t, e, e.org)
			var actions []string
			for _, ev := range evs {
				actions = append(actions, ev.Action)
			}
			if got := strings.Join(actions, ","); got != "annotation.create,annotation.delete" {
				t.Fatalf("actions = %s, want annotation.create,annotation.delete", got)
			}
			a := `{"id":"` + x.ID.String() + `","at":1767227400000,"end_at":1767227460000,"kind":"config","text":"flags","tags":["ci"],"entity":null}`
			if !sameJSON(t, evs[0].Diff, `[{"op":"add","path":"","value":`+a+`}]`) {
				t.Errorf("create diff = %s", evs[0].Diff)
			}
			if !sameJSON(t, evs[1].Diff, `[{"op":"test","path":"","value":`+a+`},{"op":"remove","path":""}]`) {
				t.Errorf("delete diff = %s", evs[1].Diff)
			}
			for i, ev := range evs {
				if i > 0 && hex.EncodeToString(prevs[i]) != hex.EncodeToString(hashes[i-1]) {
					t.Errorf("row %d prev_hash %x, want %x", i, prevs[i], hashes[i-1])
				}
				h, err := store.AuditHash(prevs[i], e.org, ev)
				if err != nil {
					t.Fatal(err)
				}
				if hex.EncodeToString(h[:]) != hex.EncodeToString(hashes[i]) {
					t.Errorf("row %d hash %x, recomputed %x", i, hashes[i], h)
				}
				if ev.Actor != core.LocalActor() || ev.ResourceKind != "annotation" || ev.ResourceID != x.ID.String() || ev.RequestID != "itest-1" {
					t.Errorf("row %d = %+v", i, ev)
				}
			}
		})
	}
}

// appInsertCode inserts one annotation row as pulsus_app in a transaction bound to org and
// returns the SQLSTATE ("" on success).
func appInsertCode(t *testing.T, dsn string, org core.OrgID, end string, kind string) string {
	t.Helper()
	id, _ := core.NewID()
	return storetest.OrgExecCode(t, dsn, org, `INSERT INTO annotations (org_id, id, at, end_at, kind, text, author_kind)
		VALUES ($1, $2, '2026-01-01T00:30:00Z', $3::timestamptz, $4, 'x', 'local')`, uuid.UUID(org), id, end, kind)
}

func TestAnnotationsChecks(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			if code := appInsertCode(t, e.db.AppURL, e.org, "2026-02-02T00:30:00Z", "deploy"); code != "23514" {
				t.Errorf("32-day span: SQLSTATE %q, want 23514 check_violation", code)
			}
			if code := appInsertCode(t, e.db.AppURL, e.org, "2026-01-01T00:31:00Z", "x"); code != "23514" {
				t.Errorf("kind 'x': SQLSTATE %q, want 23514 check_violation", code)
			}
			if code := appInsertCode(t, e.db.AppURL, e.org, "2026-01-01T00:31:00Z", "deploy"); code != "" {
				t.Errorf("valid row: SQLSTATE %q, want success", code)
			}
		})
	}
}

// The T24 §10.2 fixtures: bindings, entities, the changes of fixture C and the scopes.
var (
	winFrom = time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	winTo   = winFrom.Add(time.Hour)
	bindE1  = uuid.MustParse("00000000-0000-4000-8000-0000000000e1")
	bindE2  = uuid.MustParse("00000000-0000-4000-8000-0000000000e2")
)

// cid is change cN's id: 00000000-0000-4000-8000- + N as 12 decimal digits.
func cid(n int) uuid.UUID { return uuid.MustParse(fmt.Sprintf("00000000-0000-4000-8000-%012d", n)) }

type fixtureEntity struct {
	binding string
	kind    string
	attrs   map[string]string
}

var fixtureEntities = map[string]fixtureEntity{
	"checkout@e1": {"prod-eu", "service", map[string]string{"service.name": "checkout"}},
	"checkout@e2": {"prod-us", "service", map[string]string{"service.name": "checkout"}},
	"payments@e1": {"prod-eu", "service", map[string]string{"service.name": "payments", "service.namespace": "shop"}},
	"gateway@e1":  {"prod-eu", "service", map[string]string{"service.name": "gateway"}},
	"pod":         {"prod-eu", "pod", map[string]string{"k8s.cluster.name": "prod-eu-1", "k8s.namespace.name": "shop", "k8s.pod.name": "checkout-7d9f"}},
	"env prod":    {"prod-eu", "environment", map[string]string{"deployment.environment.name": "prod"}},
	"env stage":   {"prod-eu", "environment", map[string]string{"deployment.environment": "stage"}},
	"cluster A":   {"prod-eu", "cluster", map[string]string{"k8s.cluster.name": "prod-eu-1"}},
	"cluster B":   {"prod-eu", "cluster", map[string]string{"k8s.cluster.uid": "c-9f2"}},
}

// newEntity canonicalises a fixture entity as the gateway does.
func newEntity(t *testing.T, f fixtureEntity) *core.NewEntity {
	t.Helper()
	raw := map[string]json.RawMessage{}
	for k, v := range f.attrs {
		b, _ := json.Marshal(v)
		raw[k] = b
	}
	c, err := entity.Canonicalise(f.kind, raw)
	if err != nil {
		t.Fatalf("canonicalise %+v: %v", f, err)
	}
	return &core.NewEntity{Binding: f.binding, CanonicalEntity: c}
}

type change struct {
	n       int
	kind    core.AnnotationKind
	at, end string // HH:MM:SS on 2026-11-26; end "" = a point
	text    string
	tags    []string
	entity  string // a fixtureEntities name, "" = organisation-wide
}

func hms(s string) time.Time {
	t, err := time.Parse("2006-01-02 15:04:05", "2026-11-26 "+s)
	if err != nil {
		panic(err)
	}
	return t.UTC()
}

var fixtureC = []change{
	{1, core.AnnotationDeploy, "12:10:00", "", "checkout v2.31", []string{"pr:4402"}, "checkout@e1"},
	{2, core.AnnotationConfig, "12:19:02", "", "payments.psp.timeout 5000→2000", []string{"pr:4411"}, "payments@e1"},
	{3, core.AnnotationFlag, "12:21:30", "", "new-checkout-flow 10%→50%", nil, "checkout@e2"},
	{4, core.AnnotationNote, "12:23:00", "12:40:00", "INC-2041 mitigation window", nil, ""},
	{5, core.AnnotationDeploy, "11:50:00", "12:05:00", "gateway v1.8 rollout", nil, "gateway@e1"},
	{6, core.AnnotationConfig, "12:19:02", "", "payments.retry 3→1", nil, "payments@e1"},
	{7, core.AnnotationNote, "12:30:00", "", `=HYPERLINK("a")`, nil, ""},
	{8, core.AnnotationDeploy, "11:20:00", "11:40:00", "checkout v2.30", nil, "checkout@e1"},
	{9, core.AnnotationConfig, "11:30:00", "12:00:00", "edge cache ttl 60→30", nil, ""},
}

var scopeAdds = []change{
	{10, core.AnnotationNote, "12:35:00", "", "rollback near checkout@e2", nil, ""},
	{11, core.AnnotationConfig, "12:33:00", "", "retries raised after checkout@e2 timeouts", []string{"rel:checkout-prod-us"}, "payments@e1"},
}

func shopClause() core.ScopeClause {
	return core.ScopeClause{Attrs: map[string][]string{"service.namespace": {"shop"}}}
}

var (
	scopeEU   = core.ScopedTenant(core.ScopeClause{Bindings: []uuid.UUID{bindE1}})
	scopeShop = core.ScopedTenant(shopClause())
)

// seedBindings inserts the fixture bindings e1 (prod-eu) and, with both, e2 (prod-us) into org
// (superuser SQL).
func (e *env) seedBindings(t *testing.T, org core.OrgID, both bool) {
	t.Helper()
	ins := "INSERT INTO tenant_bindings (org_id, id, slug, datasource_url) VALUES ($1, $2, $3, 'http://pulsusdb.test')"
	storetest.Exec(t, e.db.SuperURL, ins, uuid.UUID(org), bindE1, "prod-eu")
	if both {
		storetest.Exec(t, e.db.SuperURL, ins, uuid.UUID(org), bindE2, "prod-us")
	}
}

// rcScope is a request context of org with the given scope.
func (e *env) rcScope(org core.OrgID, s core.DataScope) *core.RequestCtx {
	rc := e.rc(org)
	rc.Scope = s
	return rc
}

// createChange creates c through the service with full scope, under cN's id.
func (e *env) createChange(t *testing.T, org core.OrgID, c change) core.Annotation {
	t.Helper()
	n := core.NewAnnotation{At: hms(c.at), Kind: c.kind, Text: c.text, Tags: c.tags}
	if n.Tags == nil {
		n.Tags = []string{}
	}
	if c.end != "" {
		n.EndAt = ptr(hms(c.end))
	}
	if c.entity != "" {
		n.Entity = newEntity(t, fixtureEntities[c.entity])
	}
	id := cid(c.n)
	e.svc.newID = func() (uuid.UUID, error) { return id, nil }
	defer func() { e.svc.newID = core.NewID }()
	got, err := e.svc.CreateAnnotation(itestCtx(t), e.rc(org), n)
	if err != nil {
		t.Fatalf("create c%d: %v", c.n, err)
	}
	return got
}

// fixtureEnv is a migrated database with the bindings in org A and fixture C (plus extra).
func fixtureEnv(t *testing.T, c storetest.Cluster, extra ...change) *env {
	t.Helper()
	e := newEnv(t, c)
	e.seedBindings(t, e.org, true)
	for _, ch := range append(append([]change{}, fixtureC...), extra...) {
		e.createChange(t, e.org, ch)
	}
	return e
}

func (e *env) page(t *testing.T, rc *core.RequestCtx, limit int, f core.AnnotationFilter) core.AnnotationPage {
	t.Helper()
	p, err := e.svc.ListAnnotations(itestCtx(t), rc, winFrom, winTo, limit, f)
	if err != nil {
		t.Fatalf("list %+v: %v", f, err)
	}
	return p
}

// names is the items as c‹N› (n‹N› for the keyset inserts), in order.
func names(items []core.Annotation) string {
	out := make([]string, 0, len(items))
	for _, a := range items {
		v, _ := strconv.Atoi(a.ID.String()[24:])
		switch v {
		case 20:
			out = append(out, "n1")
		case 21:
			out = append(out, "n2")
		default:
			out = append(out, fmt.Sprintf("c%d", v))
		}
	}
	return "[" + strings.Join(out, ", ") + "]"
}

func entID(name string) uuid.UUID {
	return map[string]uuid.UUID{
		"checkout@e1": uuid.MustParse("bb7487bd-100d-a998-e0f0-3c65f11da1a7"),
		"checkout@e2": uuid.MustParse("3d1d4695-d757-d5f8-d6bf-c1b134128742"),
		"payments@e1": uuid.MustParse("854bc89f-5785-b55c-398b-87a03d62a7d9"),
	}[name]
}

func hidden(p core.AnnotationPage) string {
	if p.OrgWideHidden == nil {
		return "nil"
	}
	return fmt.Sprint(*p.OrgWideHidden)
}

// itest:annotations-entity (T24-030, T24-031): the entity, organisation-wide, kind and tag
// filters over fixture C, and tenancy.
func TestAnnotationsEntity(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := fixtureEnv(t, c)
			b := e.newOrg(t, "org-b")
			e.seedBindings(t, b, false)
			e.createChange(t, b, change{50, core.AnnotationDeploy, "12:10:00", "", "org b checkout", nil, "checkout@e1"})
			rc := e.rc(e.org)
			ents := func(n ...string) []uuid.UUID {
				out := []uuid.UUID{}
				for _, x := range n {
					out = append(out, entID(x))
				}
				return out
			}
			cases := []struct {
				name   string
				f      core.AnnotationFilter
				want   string
				hidden string
			}{
				{"checkout@e1", core.AnnotationFilter{Entities: ents("checkout@e1")}, "[c1]", "3"},
				{"checkout@e2", core.AnnotationFilter{Entities: ents("checkout@e2")}, "[c3]", "3"},
				{"+ payments@e1", core.AnnotationFilter{Entities: ents("checkout@e1", "payments@e1")}, "[c6, c2, c1]", "3"},
				{"checkout@e1 + orgWide", core.AnnotationFilter{Entities: ents("checkout@e1"), OrgWide: true}, "[c7, c4, c1, c9]", "0"},
				{"deploy + config", core.AnnotationFilter{Kinds: []core.AnnotationKind{core.AnnotationDeploy, core.AnnotationConfig}}, "[c6, c2, c1, c5, c9]", "0"},
				{"tag pr:4411", core.AnnotationFilter{Tags: []string{"pr:4411"}}, "[c2]", "0"},
				{"payments@e1 + flag", core.AnnotationFilter{Entities: ents("payments@e1"), Kinds: []core.AnnotationKind{core.AnnotationFlag}}, "[]", "0"},
				{"unfiltered", core.AnnotationFilter{}, "[c7, c4, c3, c6, c2, c1, c5, c9]", "0"},
			}
			for _, tc := range cases {
				p := e.page(t, rc, 500, tc.f)
				if got := names(p.Items); got != tc.want || hidden(p) != tc.hidden || p.Next != nil {
					t.Errorf("%s = %s orgWideHidden %s next %v, want %s and %s, no next", tc.name, got, hidden(p), p.Next, tc.want, tc.hidden)
				}
			}
			p := e.page(t, e.rc(b), 500, core.AnnotationFilter{})
			if got := names(p.Items); got != "[c50]" {
				t.Errorf("org B = %s, want only its row [c50]", got)
			}
			p = e.page(t, e.rc(b), 500, core.AnnotationFilter{Entities: ents("checkout@e1")})
			if got := names(p.Items); got != "[c50]" || p.Items[0].Entity == nil || p.Items[0].Entity.ID != entID("checkout@e1") {
				t.Errorf("org B checkout@e1 = %s, want [c50] with the same EntityId", got)
			}
		})
	}
}

// T12-010, T12-018: with full scope an entity-backed create is stored and listed canonical.
func TestAnnotationsFullScopeEntity(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			e.seedBindings(t, e.org, true)
			got := e.createChange(t, e.org, change{1, core.AnnotationDeploy, "12:10:00", "", "checkout v2.31", nil, "checkout@e1"})
			want := `{"id":"bb7487bd-100d-a998-e0f0-3c65f11da1a7","binding":"prod-eu","kind":"service","ident":[null,"checkout"]}`
			if b, _ := json.Marshal(JSON(got)["entity"]); !sameJSON(t, b, want) {
				t.Errorf("created entity = %s, want %s", b, want)
			}
			if got.Entity == nil || got.Entity.BindingID != bindE1 {
				t.Errorf("created entity %+v, want binding id e1", got.Entity)
			}
			p := e.page(t, e.rc(e.org), 500, core.AnnotationFilter{})
			if len(p.Items) != 1 {
				t.Fatalf("listed %s, want [c1]", names(p.Items))
			}
			if b, _ := json.Marshal(JSON(p.Items[0])["entity"]); !sameJSON(t, b, want) {
				t.Errorf("listed entity = %s, want %s", b, want)
			}
			if k := storetest.QueryString(t, e.db.SuperURL, "SELECT coalesce(entity_key, 'NULL') FROM annotations WHERE id = $1", cid(1)); k != "bb7487bd-100d-a998-e0f0-3c65f11da1a7" {
				t.Errorf("entity_key = %s", k)
			}
			if n := storetest.QueryInt(t, e.db.SuperURL, "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'annotation.create'", uuid.UUID(e.org)); n != 1 {
				t.Errorf("%d annotation.create events, want 1", n)
			}
		})
	}
}

// counts is the organisation's annotation rows and audit events.
func (e *env) counts(t *testing.T) string {
	t.Helper()
	return storetest.QueryString(t, e.db.SuperURL, "SELECT (SELECT count(*) FROM annotations WHERE org_id = $1) || '/' || (SELECT count(*) FROM audit_events WHERE org_id = $1)", uuid.UUID(e.org))
}

// body is a page as the gateway would answer it, the structured fields only once c11's free text
// and tags are blanked.
func body(t *testing.T, p core.AnnotationPage) string {
	t.Helper()
	items := []map[string]any{}
	for _, a := range p.Items {
		m := JSON(a)
		if a.ID == cid(11) {
			m["text"], m["tags"] = "", []string{}
		}
		items = append(items, m)
	}
	var next any
	if p.Next != nil {
		next = map[string]any{"at": p.Next.At.UnixMilli(), "id": p.Next.ID.String()}
	}
	b, err := json.Marshal(map[string]any{"items": items, "next": next, "orgWideHidden": p.OrgWideHidden})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// itest:annotations-scope (T12-018): scoped lists, pages and creates over C + c10 + c11.
func TestAnnotationsScope(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := fixtureEnv(t, c, scopeAdds...)
			if p := e.page(t, e.rc(e.org), 500, core.AnnotationFilter{}); len(p.Items) != 10 {
				t.Errorf("full scope = %s, want 10 rows", names(p.Items))
			}
			eu := e.rcScope(e.org, scopeEU)
			p1 := e.page(t, eu, 3, core.AnnotationFilter{})
			if got := names(p1.Items); got != "[c11, c6, c2]" || p1.Next == nil || !p1.Next.At.Equal(hms("12:19:02")) || p1.Next.ID != cid(2) {
				t.Fatalf("P_eu p1 = %s next %+v, want [c11, c6, c2] next (12:19:02, c2)", got, p1.Next)
			}
			p2 := e.page(t, eu, 3, core.AnnotationFilter{Before: p1.Next})
			if got := names(p2.Items); got != "[c1, c5]" || p2.Next != nil {
				t.Errorf("P_eu p2 = %s next %+v, want [c1, c5] next null", got, p2.Next)
			}
			shop := e.rcScope(e.org, scopeShop)
			ps := e.page(t, shop, 500, core.AnnotationFilter{})
			if got := names(ps.Items); got != "[c11, c6, c2]" || ps.OrgWideHidden != nil {
				t.Errorf("P_shop = %s orgWideHidden %s, want [c11, c6, c2] nil", got, hidden(ps))
			} else if c11 := ps.Items[0]; c11.Text != scopeAdds[1].text || !reflect.DeepEqual(c11.Tags, scopeAdds[1].tags) {
				t.Errorf("c11 = %q %v, want its text and tags as authored", c11.Text, c11.Tags)
			}
			pe := e.page(t, shop, 500, core.AnnotationFilter{Entities: []uuid.UUID{entID("checkout@e1")}})
			if got := names(pe.Items); got != "[]" || pe.OrgWideHidden != nil {
				t.Errorf("P_shop checkout@e1 = %s orgWideHidden %s, want [] nil", got, hidden(pe))
			}
			for name, b := range map[string]string{"P_eu p1": body(t, p1), "P_eu p2": body(t, p2), "P_shop": body(t, ps), "P_shop e": body(t, pe)} {
				for _, banned := range []string{"3d1d4695-d757-d5f8-d6bf-c1b134128742", cid(10).String(), "prod-us"} {
					if strings.Contains(b, banned) {
						t.Errorf("%s body holds %s: %s", name, banned, b)
					}
				}
			}
			if _, err := e.svc.ListAnnotations(itestCtx(t), e.rcScope(e.org, core.DataScope{}), winFrom, winTo, 500, core.AnnotationFilter{}); !errors.Is(err, core.ErrScopeDenied) {
				t.Errorf("unset list = %v, want ErrScopeDenied", err)
			}
			before := e.counts(t)
			n := core.NewAnnotation{At: hms("12:50:00"), Kind: core.AnnotationDeploy, Text: "x", Tags: []string{}}
			n.Entity = newEntity(t, fixtureEntities["checkout@e1"])
			_, err := e.svc.CreateAnnotation(itestCtx(t), shop, n)
			var se *core.ScopeError
			if !errors.As(err, &se) || se.Pointer != "/entity" || se.Key != "annotations.entity.scope" {
				t.Errorf("P_shop create checkout@e1 = %v, want ScopeError /entity annotations.entity.scope", err)
			}
			n.Entity = nil
			if _, err := e.svc.CreateAnnotation(itestCtx(t), shop, n); !errors.As(err, &se) || se.Key != "annotations.scope" {
				t.Errorf("P_shop create without an entity = %v, want ScopeError annotations.scope", err)
			}
			if after := e.counts(t); after != before {
				t.Errorf("rows/audit %s → %s after refused creates", before, after)
			}
			n.Entity = newEntity(t, fixtureEntities["payments@e1"])
			if got, err := e.svc.CreateAnnotation(itestCtx(t), shop, n); err != nil || got.Entity == nil || got.Entity.ID != entID("payments@e1") {
				t.Errorf("P_shop create payments@e1 = %+v, %v; want created", got, err)
			}
		})
	}
}

// compileScopes are the T24 §10.2 scopes S1–S5, T1–T3, P_eu and P_shop with the entities each
// covers.
var compileScopes = []struct {
	name   string
	scope  core.DataScope
	covers []string
}{
	{"S1", core.ScopedTenant(core.ScopeClause{Bindings: []uuid.UUID{bindE2}}, shopClause()), []string{"checkout@e2", "payments@e1"}},
	{"S2", core.ScopedTenant(core.ScopeClause{Bindings: []uuid.UUID{bindE1}, Attrs: map[string][]string{"service.name": {"checkout", "gateway"}}}), []string{"checkout@e1", "gateway@e1"}},
	{"S3", core.ScopedTenant(core.ScopeClause{Attrs: map[string][]string{"k8s.namespace.name": {"shop"}}}), []string{"pod"}},
	{"S4", core.ScopedTenant(core.ScopeClause{Attrs: map[string][]string{"service.namespace": {"shop", ""}}}), []string{"payments@e1"}},
	{"S5", core.ScopedTenant(core.ScopeClause{Attrs: map[string][]string{"service.name": {"checkout"}}}), []string{"checkout@e1", "checkout@e2"}},
	{"T1", core.ScopedTenant(core.ScopeClause{Attrs: map[string][]string{"deployment.environment.name": {"prod"}, "deployment.environment": {"stage"}}}), []string{}},
	{"T2", core.ScopedTenant(core.ScopeClause{Attrs: map[string][]string{"deployment.environment.name": {"prod", "stage"}, "deployment.environment": {"prod", "dev"}}}), []string{"env prod"}},
	{"T3", core.ScopedTenant(core.ScopeClause{Attrs: map[string][]string{"k8s.cluster.name": {"prod-eu-1"}}}), []string{"pod", "cluster A"}},
	{"P_eu", scopeEU, []string{"checkout@e1", "payments@e1", "gateway@e1", "pod", "env prod", "env stage", "cluster A", "cluster B"}},
	{"P_shop", scopeShop, []string{"payments@e1"}},
}

// entityOrder is the order of the entities' rows in the window (newest first).
var entityOrder = []string{"checkout@e1", "checkout@e2", "payments@e1", "gateway@e1", "pod", "env prod", "env stage", "cluster A", "cluster B"}

// itest:annotations-scope-compile (T12-010, T12-018): each scope lists, creates and deletes
// exactly the entities it covers, and the SQL predicate agrees with ScopeCovers.
func TestAnnotationsScopeCompile(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			e.seedBindings(t, e.org, true)
			// One row per entity, one minute apart, newest first in entityOrder; env prod three
			// more times, via each attribute and both.
			byID := map[uuid.UUID]string{}
			for i, name := range entityOrder {
				a := e.createChange(t, e.org, change{i + 1, core.AnnotationDeploy, fmt.Sprintf("12:%02d:00", 50-i), "", name, nil, name})
				byID[a.ID] = name
			}
			for i, attrs := range []map[string]string{{"deployment.environment.name": "prod"}, {"deployment.environment": "prod"},
				{"deployment.environment.name": "prod", "deployment.environment": "prod"}} {
				n := core.NewAnnotation{At: hms(fmt.Sprintf("12:0%d:30", 5-i)), Kind: core.AnnotationNote, Text: "env", Tags: []string{}}
				n.Entity = newEntity(t, fixtureEntity{"prod-eu", "environment", attrs})
				got, err := e.svc.CreateAnnotation(itestCtx(t), e.rc(e.org), n)
				if err != nil {
					t.Fatal(err)
				}
				if got.Entity == nil || got.Entity.ID != uuid.MustParse("f8bdae9d-e739-228c-dd0e-317933242944") ||
					!reflect.DeepEqual(got.Entity.Attrs, map[string]string{"deployment.environment.name": "prod"}) {
					t.Errorf("env prod via %v = %+v", attrs, got.Entity)
				}
				byID[got.ID] = "env prod"
			}
			for _, s := range compileScopes {
				rc := e.rcScope(e.org, s.scope)
				_, clauses, _ := s.scope.AnnotationScope()
				compiled, err := entity.CompileScope(clauses)
				if err != nil {
					t.Fatalf("%s: %v", s.name, err)
				}
				p := e.page(t, rc, 500, core.AnnotationFilter{})
				listed := map[string]int{}
				for _, a := range p.Items {
					listed[byID[a.ID]]++
					if !entity.ScopeCovers(false, compiled, a.Entity) {
						t.Errorf("%s lists %s, which ScopeCovers does not cover", s.name, byID[a.ID])
					}
				}
				want := map[string]int{}
				for _, n := range s.covers {
					want[n] = 1
					if n == "env prod" {
						want[n] = 4
					}
				}
				if !reflect.DeepEqual(listed, want) {
					t.Errorf("%s lists %v, want %v", s.name, listed, want)
				}
				for _, name := range entityOrder {
					covered := slices.Contains(s.covers, name)
					n := core.NewAnnotation{At: hms("12:58:00"), Kind: core.AnnotationFlag, Text: "probe", Tags: []string{}, Entity: newEntity(t, fixtureEntities[name])}
					got, err := e.svc.CreateAnnotation(itestCtx(t), rc, n)
					var se *core.ScopeError
					switch {
					case covered && err != nil:
						t.Errorf("%s create %s = %v, want created", s.name, name, err)
					case !covered && (!errors.As(err, &se) || se.Key != "annotations.entity.scope"):
						t.Errorf("%s create %s = %v, want annotations.entity.scope", s.name, name, err)
					}
					if covered && err == nil {
						if !entity.ScopeCovers(false, compiled, got.Entity) {
							t.Errorf("%s created %s, which ScopeCovers does not cover", s.name, name)
						}
						if err := e.svc.DeleteAnnotation(itestCtx(t), rc, got.ID); err != nil {
							t.Errorf("%s delete its %s = %v", s.name, name, err)
						}
					}
					if !covered {
						var base uuid.UUID
						for id, n := range byID {
							if n == name {
								base = id
								break
							}
						}
						if err := e.svc.DeleteAnnotation(itestCtx(t), rc, base); !errors.Is(err, core.ErrNotFound) {
							t.Errorf("%s delete %s = %v, want ErrNotFound", s.name, name, err)
						}
					}
				}
			}
			if n := storetest.QueryInt(t, e.db.SuperURL, "SELECT count(*) FROM annotations WHERE (entity_key IS NULL) <> (entity IS NULL)"); n != 0 {
				t.Errorf("%d unpaired rows, want 0", n)
			}
		})
	}
}

// itest:annotations-delete-scope (T12-018, T11-017): a delete outside the scope is the same 404
// as an absent id, with no audit; inside it deletes with one audit event.
func TestAnnotationsDeleteScope(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := fixtureEnv(t, c)
			shop := e.rcScope(e.org, scopeShop)
			before := e.counts(t)
			err1 := e.svc.DeleteAnnotation(itestCtx(t), shop, cid(1))
			fresh, _ := core.NewID()
			err2 := e.svc.DeleteAnnotation(itestCtx(t), shop, fresh)
			if !errors.Is(err1, core.ErrNotFound) || !errors.Is(err2, core.ErrNotFound) || err1.Error() != err2.Error() {
				t.Errorf("P_shop delete c1 = %v, absent = %v; want the same ErrNotFound", err1, err2)
			}
			if after := e.counts(t); after != before {
				t.Errorf("rows/audit %s → %s after refused deletes", before, after)
			}
			if err := e.svc.DeleteAnnotation(itestCtx(t), shop, cid(2)); err != nil {
				t.Fatalf("P_shop delete c2 = %v, want nil", err)
			}
			rows := storetest.QueryRows(t, e.db.SuperURL, "SELECT diff::text FROM audit_events WHERE org_id = $1 AND action = 'annotation.delete'", uuid.UUID(e.org))
			if len(rows) != 1 || !strings.Contains(rows[0][0], "854bc89f-5785-b55c-398b-87a03d62a7d9") {
				t.Errorf("annotation.delete events = %v, want one with c2's entity", rows)
			}
			before = e.counts(t)
			if err := e.svc.DeleteAnnotation(itestCtx(t), e.rcScope(e.org, core.DataScope{}), cid(1)); !errors.Is(err, core.ErrScopeDenied) {
				t.Errorf("unset delete = %v, want ErrScopeDenied", err)
			}
			if after := e.counts(t); after != before {
				t.Errorf("rows/audit %s → %s after an unset delete", before, after)
			}
		})
	}
}

// itest:annotations-keyset (T24-032): pages by (at, id) over fixture C under inserts and deletes.
func TestAnnotationsKeyset(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := fixtureEnv(t, c)
			rc := e.rc(e.org)
			p1 := e.page(t, rc, 3, core.AnnotationFilter{})
			if got := names(p1.Items); got != "[c7, c4, c3]" || p1.Next == nil || !p1.Next.At.Equal(hms("12:21:30")) || p1.Next.ID != cid(3) {
				t.Fatalf("(a) p1 = %s next %+v, want [c7, c4, c3] next (12:21:30, c3)", got, p1.Next)
			}
			e.createChange(t, e.org, change{20, core.AnnotationDeploy, "12:45:00", "", "n1", nil, ""})
			e.createChange(t, e.org, change{21, core.AnnotationDeploy, "12:05:00", "", "n2", nil, ""})
			p2 := e.page(t, rc, 3, core.AnnotationFilter{Before: p1.Next})
			p3 := e.page(t, rc, 3, core.AnnotationFilter{Before: p2.Next})
			if got := names(p2.Items); got != "[c6, c2, c1]" || p2.Next == nil {
				t.Errorf("(a) p2 = %s next %+v, want [c6, c2, c1] with a next", got, p2.Next)
			}
			if got := names(p3.Items); got != "[n2, c5, c9]" || p3.Next != nil {
				t.Errorf("(a) p3 = %s next %+v, want [n2, c5, c9] next null", got, p3.Next)
			}
			seen := map[uuid.UUID]bool{}
			for _, a := range append(append(append([]core.Annotation{}, p1.Items...), p2.Items...), p3.Items...) {
				if seen[a.ID] || a.ID == cid(20) {
					t.Errorf("(a) %s twice or n1 listed", a.ID)
				}
				seen[a.ID] = true
			}

			f := fixtureEnv(t, c)
			rc = f.rc(f.org)
			if all := f.page(t, rc, 500, core.AnnotationFilter{}); len(all.Items) != 8 || all.Next != nil {
				t.Errorf("(c) limit 500 = %s next %+v, want 8 rows next null", names(all.Items), all.Next)
			}
			q1 := f.page(t, rc, 3, core.AnnotationFilter{})
			q2 := f.page(t, rc, 3, core.AnnotationFilter{Before: q1.Next})
			if err := f.svc.DeleteAnnotation(itestCtx(t), rc, cid(5)); err != nil {
				t.Fatal(err)
			}
			if q2.Next == nil {
				t.Fatalf("(b) p2 = %s without a next", names(q2.Items))
			}
			if q3 := f.page(t, rc, 3, core.AnnotationFilter{Before: q2.Next}); names(q3.Items) != "[c9]" || q3.Next != nil {
				t.Errorf("(b) p3 = %s next %+v, want [c9] next null", names(q3.Items), q3.Next)
			}

		})
	}
}
