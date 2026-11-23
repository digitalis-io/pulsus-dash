//go:build itest

package annotations

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
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
	return &core.RequestCtx{Org: org, Actor: core.LocalActor(), RequestID: "itest-1"}
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
	items, truncated, err := e.svc.ListAnnotations(itestCtx(t), e.rc(org), from, to, limit)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	return items, truncated
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
			a := `{"id":"` + x.ID.String() + `","at":1767227400000,"end_at":1767227460000,"kind":"config","text":"flags","tags":["ci"]}`
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
