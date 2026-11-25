//go:build itest

package boards

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/spec"
	"github.com/digitalis-io/pulsus-dash/server/internal/store"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

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

// newOrg inserts an organisation with no folder, as the superuser.
func (e *env) newOrg(t *testing.T, slug string) core.OrgID {
	t.Helper()
	org, _ := core.NewOrgID()
	storetest.Exec(t, e.db.SuperURL, "INSERT INTO orgs (id, slug, name) VALUES ($1, $2, $2)", uuid.UUID(org), slug)
	return org
}

func (e *env) count(t *testing.T, table string) int64 {
	t.Helper()
	return storetest.QueryInt(t, e.db.SuperURL, "SELECT count(*) FROM "+table)
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "api", "fixtures", "board-spec", name)) //nolint:gosec // fixture names are constants of the tests
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func titled(t *testing.T, title string) []byte {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"title": title, "panels": []any{}, "sections": []any{}})
	return b
}

func TestCreateEnsuresRootFolder(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			b := e.newOrg(t, "org-b")
			for i := range 2 {
				if _, err := e.svc.CreateBoard(itestCtx(t), e.rc(b), titled(t, "B")); err != nil {
					t.Fatalf("create %d: %v", i, err)
				}
			}
			folders := storetest.QueryRows(t, e.db.SuperURL, "SELECT id::text FROM folders WHERE org_id = $1", uuid.UUID(b))
			if len(folders) != 1 {
				t.Fatalf("%d folders in org B, want 1", len(folders))
			}
			if n := storetest.QueryInt(t, e.db.SuperURL, "SELECT count(*) FROM boards WHERE org_id = $1 AND folder_id = $2::uuid", uuid.UUID(b), folders[0][0]); n != 2 {
				t.Errorf("%d boards in the root folder, want 2", n)
			}
		})
	}
}

func TestConcurrentSaves(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			b, err := e.svc.CreateBoard(itestCtx(t), e.rc(e.org), titled(t, "Start"))
			if err != nil {
				t.Fatal(err)
			}
			if b.ETag != 1 {
				t.Fatalf("ETag after create = %d, want 1", b.ETag)
			}
			var wg sync.WaitGroup
			start := make(chan struct{})
			type out struct {
				res core.SaveResult
				err error
			}
			results := make(chan out, 2)
			for _, title := range []string{"One", "Two"} {
				wg.Add(1)
				go func() {
					defer wg.Done()
					<-start
					res, err := e.svc.SaveBoard(itestCtx(t), e.rc(e.org), b.UID, 1, titled(t, title), "")
					results <- out{res, err}
				}()
			}
			close(start)
			wg.Wait()
			close(results)
			saved, conflicts := 0, 0
			for r := range results {
				var ce *core.ConflictError
				switch {
				case r.err == nil && r.res.Changed && r.res.Board.Version == 2:
					saved++
				case errors.As(r.err, &ce) && ce.Current.Version == 2:
					conflicts++
				default:
					t.Errorf("unexpected result %+v, %v", r.res, r.err)
				}
			}
			if saved != 1 || conflicts != 1 {
				t.Errorf("saved %d, conflicts %d; want 1 and 1", saved, conflicts)
			}
			if n := e.count(t, "board_versions"); n != 2 {
				t.Errorf("%d versions, want 2", n)
			}
			if n := e.count(t, "audit_events"); n != 2 {
				t.Errorf("%d audit rows, want 2", n)
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

func TestAuditChain(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			ctx, rc := itestCtx(t), e.rc(e.org)
			b, err := e.svc.CreateBoard(ctx, rc, fixture(t, "v1-minimal.json"))
			if err != nil {
				t.Fatal(err)
			}
			r1, err := e.svc.SaveBoard(ctx, rc, b.UID, 1, fixture(t, "v1-full.json"), "first")
			if err != nil || !r1.Changed {
				t.Fatalf("save 1 = %+v, %v", r1, err)
			}
			r2, err := e.svc.SaveBoard(ctx, rc, b.UID, 2, fixture(t, "v1-full.json"), "")
			if err != nil || r2.Changed {
				t.Fatalf("save 2 (unchanged) = %+v, %v", r2, err)
			}
			r3, err := e.svc.SaveBoard(ctx, rc, b.UID, 2, titled(t, "Renamed"), "")
			if err != nil || !r3.Changed {
				t.Fatalf("save 3 = %+v, %v", r3, err)
			}
			if err := e.svc.DeleteBoard(ctx, rc, b.UID, 3); err != nil {
				t.Fatalf("delete: %v", err)
			}
			evs, prevs, hashes := auditRows(t, e, e.org)
			var actions []string
			for _, ev := range evs {
				actions = append(actions, ev.Action)
			}
			if got := strings.Join(actions, ","); got != "board.create,board.update,board.update,board.delete" {
				t.Fatalf("actions = %s", got)
			}
			for i, ev := range evs {
				if i == 0 && prevs[0] != nil {
					t.Errorf("row 0 prev_hash = %x, want NULL", prevs[0])
				}
				if i > 0 {
					if hex.EncodeToString(prevs[i]) != hex.EncodeToString(hashes[i-1]) {
						t.Errorf("row %d prev_hash %x, want the previous hash %x", i, prevs[i], hashes[i-1])
					}
					if !ev.At.After(evs[i-1].At) {
						t.Errorf("row %d at %v not after %v", i, ev.At, evs[i-1].At)
					}
				}
				h, err := store.AuditHash(prevs[i], e.org, ev)
				if err != nil {
					t.Fatal(err)
				}
				if hex.EncodeToString(h[:]) != hex.EncodeToString(hashes[i]) {
					t.Errorf("row %d hash %x, recomputed %x", i, hashes[i], h)
				}
				if ev.Actor != core.LocalActor() || ev.ResourceKind != "board" || ev.ResourceID != b.UID || ev.RequestID != "itest-1" {
					t.Errorf("row %d = %+v", i, ev)
				}
			}
			var create []map[string]any
			if err := json.Unmarshal(evs[0].Diff, &create); err != nil || len(create) != 1 || create[0]["op"] != "add" || create[0]["path"] != "" {
				t.Errorf("create diff = %s, want one add \"\" op", evs[0].Diff)
			}
			for _, i := range []int{1, 2} {
				var ops []any
				if err := json.Unmarshal(evs[i].Diff, &ops); err != nil || len(ops) == 0 {
					t.Errorf("update diff %d = %s, want a non-empty array", i, evs[i].Diff)
				}
			}
			if evs[3].Diff != nil {
				t.Errorf("delete diff = %s, want NULL", evs[3].Diff)
			}
			head := storetest.QueryRows(t, e.db.SuperURL, `SELECT to_char(last_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
				last_id::text, encode(last_hash, 'hex') FROM audit_chain_heads WHERE org_id = $1`, uuid.UUID(e.org))
			last := evs[3]
			if len(head) != 1 || head[0][0] != last.At.Format("2006-01-02T15:04:05.000000Z") || head[0][1] != last.ID.String() || head[0][2] != hex.EncodeToString(hashes[3]) {
				t.Errorf("chain head = %v, want the last event %v %v %x", head, last.At, last.ID, hashes[3])
			}
		})
	}
}

// T11-017 across T11-010: the chain continues from an event that is below the floor.
func TestAuditChainAcrossFloor(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			storetest.CreateLeaf(t, e.db.OwnerURL, -14)
			now := time.Now().UTC()
			at := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, -14, 1)
			id, _ := core.NewID()
			ev := core.AuditEvent{ID: id, At: at, Actor: core.LocalActor(), Action: "board.create", ResourceKind: "board", ResourceID: "old"}
			h, err := store.AuditHash(nil, e.org, ev)
			if err != nil {
				t.Fatal(err)
			}
			storetest.Exec(t, e.db.SuperURL, `INSERT INTO audit_events (org_id, rclass, at, id, actor_kind, actor_id, action, resource_kind, resource_id, hash)
				VALUES ($1, 13, $2, $3, 'local', $4, 'board.create', 'board', 'old', $5)`, uuid.UUID(e.org), at, id, core.LocalPrincipalID, h[:])
			storetest.Exec(t, e.db.SuperURL, "INSERT INTO audit_chain_heads (org_id, last_at, last_id, last_hash) VALUES ($1, $2, $3, $4)",
				uuid.UUID(e.org), at, id, h[:])
			floor := time.Now().UTC().AddDate(0, -core.AuditRetentionMonths, 0)
			if n := storetest.OrgQueryInt(t, e.db.AppURL, e.org, floor, "SELECT count(*) FROM audit_events"); n != 0 {
				t.Errorf("app sees %d events below the floor, want 0", n)
			}
			if _, err := e.svc.CreateBoard(itestCtx(t), e.rc(e.org), titled(t, "After")); err != nil {
				t.Fatal(err)
			}
			rows := storetest.QueryRows(t, e.db.SuperURL, "SELECT encode(prev_hash, 'hex'), (at > $2)::text FROM audit_events WHERE org_id = $1 AND resource_id <> 'old'", uuid.UUID(e.org), at)
			if len(rows) != 1 || rows[0][0] != hex.EncodeToString(h[:]) || rows[0][1] != "true" {
				t.Errorf("new event prev_hash, at > E = %v, want %x true", rows, h)
			}
		})
	}
}

func TestUIDCollisionRetry(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			queue := []string{"dup00000000000", "dup00000000000", "uniq0000000000"}
			e.svc.newUID = func() (string, error) {
				if len(queue) == 0 {
					return "dup00000000000", nil
				}
				u := queue[0]
				queue = queue[1:]
				return u, nil
			}
			ctx, rc := itestCtx(t), e.rc(e.org)
			first, err := e.svc.CreateBoard(ctx, rc, titled(t, "A"))
			if err != nil || first.UID != "dup00000000000" {
				t.Fatalf("first = %q, %v; want dup00000000000", first.UID, err)
			}
			second, err := e.svc.CreateBoard(ctx, rc, titled(t, "B"))
			if err != nil || second.UID != "uniq0000000000" {
				t.Fatalf("second = %q, %v; want uniq0000000000", second.UID, err)
			}
			if _, err := e.svc.CreateBoard(ctx, rc, titled(t, "C")); err == nil || err.Error() != "boards: no free uid" {
				t.Errorf("after 5 collisions: %v, want boards: no free uid", err)
			}
			for table, want := range map[string]int64{"boards": 2, "board_versions": 2, "audit_events": 2} {
				if n := e.count(t, table); n != want {
					t.Errorf("%d rows in %s, want %d", n, table, want)
				}
			}
		})
	}
}

func TestNewerSchemaVersion(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			ctx, rc := itestCtx(t), e.rc(e.org)
			b, err := e.svc.CreateBoard(ctx, rc, titled(t, "A"))
			if err != nil {
				t.Fatal(err)
			}
			storetest.Exec(t, e.db.SuperURL, "UPDATE board_versions SET schema_version = 4")
			if _, err := e.svc.GetBoard(ctx, rc, b.UID); !errors.Is(err, spec.ErrSchemaTooNew) {
				t.Errorf("GetBoard = %v, want ErrSchemaTooNew", err)
			}
			if _, err := e.svc.SaveBoard(ctx, rc, b.UID, 1, titled(t, "B"), ""); !errors.Is(err, spec.ErrSchemaTooNew) {
				t.Errorf("SaveBoard = %v, want ErrSchemaTooNew", err)
			}
			if n := e.count(t, "board_versions"); n != 1 {
				t.Errorf("%d versions, want 1", n)
			}
		})
	}
}

// The previous release (schema 2) meets a row this release wrote (plan #64 Part B §4.7, R1; #173
// Part 1: board spec v3).
func TestPreviousServerRefusesNewerRow(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			ctx, rc := itestCtx(t), e.rc(e.org)
			b, err := e.svc.CreateBoard(ctx, rc, fixture(t, "v3-full.json"))
			if err != nil {
				t.Fatal(err)
			}
			if v := storetest.QueryInt(t, e.db.SuperURL, "SELECT max(schema_version) FROM board_versions"); v != 3 {
				t.Fatalf("schema_version = %d, want 3", v)
			}
			hash := func() string {
				rows := storetest.QueryRows(t, e.db.SuperURL, "SELECT encode(content_hash, 'hex') FROM board_versions ORDER BY version DESC LIMIT 1")
				return rows[0][0]
			}
			before := hash()
			old := newServiceWithSchemaMax(e.svc.db, 2)
			if _, err := old.GetBoard(ctx, rc, b.UID); !errors.Is(err, spec.ErrSchemaTooNew) {
				t.Errorf("GetBoard = %v, want ErrSchemaTooNew", err)
			}
			if _, err := old.SaveBoard(ctx, rc, b.UID, 1, fixture(t, "v2-full.json"), ""); !errors.Is(err, spec.ErrSchemaTooNew) {
				t.Errorf("SaveBoard = %v, want ErrSchemaTooNew", err)
			}
			if n := e.count(t, "board_versions"); n != 1 {
				t.Errorf("%d versions, want 1", n)
			}
			if after := hash(); after != before {
				t.Errorf("head content_hash = %s, want %s (unchanged)", after, before)
			}
		})
	}
}

func TestSaveWritesSchemaV3(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			ctx, rc := itestCtx(t), e.rc(e.org)
			b, err := e.svc.CreateBoard(ctx, rc, titled(t, "A"))
			if err != nil {
				t.Fatal(err)
			}
			raw := fixture(t, "v3-full.json")
			res, err := e.svc.SaveBoard(ctx, rc, b.UID, 1, raw, "")
			if err != nil {
				t.Fatal(err)
			}
			if !res.Changed {
				t.Errorf("Changed = false, want true")
			}
			if v := storetest.QueryInt(t, e.db.SuperURL, "SELECT schema_version FROM board_versions WHERE version = 2"); v != 3 {
				t.Errorf("stored schema_version = %d, want 3", v)
			}
			got, err := e.svc.GetBoard(ctx, rc, b.UID)
			if err != nil {
				t.Fatal(err)
			}
			want, err := spec.Canonical(raw)
			if err != nil {
				t.Fatal(err)
			}
			if string(got.Spec) != string(want) {
				t.Errorf("GET spec = %s, want %s", got.Spec, want)
			}
			if got.SchemaVersion != 3 {
				t.Errorf("GET schema_version = %d, want 3", got.SchemaVersion)
			}
		})
	}
}

func TestBoardsCrossOrg(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			ctx := itestCtx(t)
			b, err := e.svc.CreateBoard(ctx, e.rc(e.org), titled(t, "A"))
			if err != nil {
				t.Fatal(err)
			}
			rb := e.rc(e.newOrg(t, "org-b"))
			if _, err := e.svc.GetBoard(ctx, rb, b.UID); !errors.Is(err, core.ErrNotFound) {
				t.Errorf("GetBoard from B = %v, want ErrNotFound", err)
			}
			if items, _, err := e.svc.ListBoards(ctx, rb); err != nil || len(items) != 0 {
				t.Errorf("ListBoards from B = %v, %v; want empty", items, err)
			}
			if _, err := e.svc.SaveBoard(ctx, rb, b.UID, 1, titled(t, "X"), ""); !errors.Is(err, core.ErrNotFound) {
				t.Errorf("SaveBoard from B = %v, want ErrNotFound", err)
			}
			if err := e.svc.SetStarred(ctx, rb, b.UID, true); !errors.Is(err, core.ErrNotFound) {
				t.Errorf("SetStarred from B = %v, want ErrNotFound", err)
			}
		})
	}
}

func TestRecentTrim(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			ctx, rc := itestCtx(t), e.rc(e.org)
			b, err := e.svc.CreateBoard(ctx, rc, titled(t, "Seen"))
			if err != nil {
				t.Fatal(err)
			}
			storetest.Exec(t, e.db.SuperURL, `INSERT INTO recent_views (org_id, user_id, kind, id, viewed_at)
				SELECT $1, $2, 'board', gen_random_uuid(), now() - make_interval(secs => n) FROM generate_series(1, 205) n`,
				uuid.UUID(e.org), core.LocalPrincipalID)
			if err := e.svc.RecordView(ctx, rc, b.UID, nil); err != nil {
				t.Fatal(err)
			}
			if n := e.count(t, "recent_views"); n != 200 {
				t.Errorf("%d recent views, want 200", n)
			}
			if n := storetest.QueryInt(t, e.db.SuperURL, "SELECT count(*) FROM recent_views r JOIN boards b ON b.id = r.id WHERE b.uid = $1", b.UID); n != 1 {
				t.Errorf("the viewed board has %d rows, want 1", n)
			}
			refs, err := e.svc.ListRecent(ctx, rc, 5)
			if err != nil || len(refs) == 0 || refs[0].UID != b.UID {
				t.Errorf("ListRecent(5) = %v, %v; want %s first", refs, err, b.UID)
			}
		})
	}
}

// recentEnv is a fresh database with boards A and B and an empty Recent.
func recentEnv(t *testing.T, c storetest.Cluster) (*env, context.Context, *core.RequestCtx, map[string]string) {
	t.Helper()
	e := newEnv(t, c)
	ctx, rc := itestCtx(t), e.rc(e.org)
	uids := map[string]string{}
	for _, name := range []string{"A", "B"} {
		b, err := e.svc.CreateBoard(ctx, rc, titled(t, name))
		if err != nil {
			t.Fatal(err)
		}
		uids[name] = b.UID
	}
	return e, ctx, rc, uids
}

// recentNames lists the user's Recent by board title.
func recentNames(t *testing.T, e *env, ctx context.Context, rc *core.RequestCtx) string {
	t.Helper()
	refs, err := e.svc.ListRecent(ctx, rc, 50)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, r := range refs {
		out = append(out, r.Title)
	}
	return strings.Join(out, ",")
}

func (e *env) view(t *testing.T, ctx context.Context, rc *core.RequestCtx, uid string, at *time.Time) {
	t.Helper()
	if err := e.svc.RecordView(ctx, rc, uid, at); err != nil {
		t.Fatalf("RecordView(%s, %v): %v", uid, at, err)
	}
}

// viewedAt is the stored viewed_at of uid, and the database's now().
func (e *env) viewedAt(t *testing.T, uid string) (viewed, now time.Time) {
	t.Helper()
	rows := storetest.QueryRows(t, e.db.SuperURL, `SELECT (extract(epoch FROM r.viewed_at) * 1000000)::bigint::text,
		(extract(epoch FROM now()) * 1000000)::bigint::text FROM recent_views r JOIN boards b ON b.id = r.id WHERE b.uid = $1`, uid)
	if len(rows) != 1 || len(rows[0]) != 2 {
		t.Fatalf("viewed_at of %s: %v", uid, rows)
	}
	us := func(s string) time.Time {
		n, err := strconv.ParseInt(s, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		return time.UnixMicro(n)
	}
	return us(rows[0][0]), us(rows[0][1])
}

func at(t time.Time) *time.Time { return &t }

// Plan #61 Part C §3.9 (review c-r2 R1-3): in-window navigation times of one client order Recent,
// and a late commit of an older in-window view never moves a board above a later view
// (D-RECENT-window; clamped views are covered by TestClampedViewsOrderByTransactionStart).
func TestRecentOrderByClientTime(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e, ctx, rc, uids := recentEnv(t, c)
			t0 := time.Now()
			e.view(t, ctx, rc, uids["B"], at(t0.Add(2*time.Second)))
			e.view(t, ctx, rc, uids["A"], at(t0.Add(time.Second))) // A commits after B
			if got := recentNames(t, e, ctx, rc); got != "B,A" {
				t.Errorf("after B(t0+2s), A(t0+1s): %s, want B,A", got)
			}
			e.view(t, ctx, rc, uids["A"], at(t0.Add(3*time.Second)))
			e.view(t, ctx, rc, uids["A"], at(t0.Add(time.Second))) // late and older
			if got := recentNames(t, e, ctx, rc); got != "A,B" {
				t.Errorf("after A(t0+3s), late A(t0+1s): %s, want A,B", got)
			}

			e.view(t, ctx, rc, uids["B"], at(time.Now().Add(time.Hour)))
			if v, now := e.viewedAt(t, uids["B"]); v.After(now.Add(5 * time.Minute)) {
				t.Errorf("at now+1h stored %v, after now()+5min (%v)", v, now.Add(5*time.Minute))
			}
			e2, ctx2, rc2, uids2 := recentEnv(t, c)
			e2.view(t, ctx2, rc2, uids2["A"], at(time.Now().Add(-7*24*time.Hour)))
			// now() is read in a later transaction: allow it 1 s.
			if v, now := e2.viewedAt(t, uids2["A"]); v.Before(now.Add(-24*time.Hour - time.Second)) {
				t.Errorf("at now-7d stored %v, before now()-1day (%v)", v, now.Add(-24*time.Hour))
			}
			e2.view(t, ctx2, rc2, uids2["B"], nil)
			if v, now := e2.viewedAt(t, uids2["B"]); v.Sub(now).Abs() > time.Second {
				t.Errorf("nil stored %v, not within 1 s of now() %v", v, now)
			}
		})
	}
}

// Plan #61 Part C §3.9 (D-RECENT-window, review c-r3 R1-3): stamps outside the window clamp to its
// edge; such views order by transaction start (`now()`), best effort. No commit-order claim.
func TestClampedViewsOrderByTransactionStart(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			for _, tc := range []struct {
				name   string
				offset time.Duration
			}{{"slow clock", -2 * 24 * time.Hour}, {"fast clock", time.Hour}} {
				t.Run(tc.name, func(t *testing.T) {
					e, ctx, rc, uids := recentEnv(t, c)
					base := time.Now().Add(tc.offset)
					a, b := base, base.Add(time.Second)
					e.view(t, ctx, rc, uids["B"], &b)
					time.Sleep(20 * time.Millisecond)
					e.view(t, ctx, rc, uids["A"], &a) // A's transaction starts later
					if got := recentNames(t, e, ctx, rc); got != "A,B" {
						t.Errorf("%s: %s, want A,B (transaction start order)", tc.name, got)
					}
					for _, name := range []string{"A", "B"} {
						v, now := e.viewedAt(t, uids[name])
						if v.Before(now.Add(-24*time.Hour-time.Second)) || v.After(now.Add(5*time.Minute+time.Second)) {
							t.Errorf("%s: %s stored %v, outside [now()-1day, now()+5min] of %v", tc.name, name, v, now)
						}
					}
				})
			}
		})
	}
}

// Plan #61 Part C §3.9 (D-RECENT-window, review c-r4 R1-3): on an equal timestamp the later write
// wins.
func TestRecentEqualTimestamps(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e, ctx, rc, uids := recentEnv(t, c)
			ts := time.Now().Add(-time.Minute).Truncate(time.Millisecond)
			e.view(t, ctx, rc, uids["A"], &ts)
			e.view(t, ctx, rc, uids["B"], &ts)
			if got := recentNames(t, e, ctx, rc); got != "B,A" {
				t.Errorf("A(t), then B(t): %s, want B,A", got)
			}
			e.view(t, ctx, rc, uids["A"], &ts)
			if got := recentNames(t, e, ctx, rc); got != "A,B" {
				t.Errorf("then A(t): %s, want A,B", got)
			}
		})
	}
}

// inMilli fails unless the stored viewed_at of every board in names is inside the millisecond of
// ts: a tie never moves a view into a later millisecond, where it would beat a later navigation.
func (e *env) inMilli(t *testing.T, uids map[string]string, ts time.Time, label string, names ...string) {
	t.Helper()
	for _, name := range names {
		if v, _ := e.viewedAt(t, uids[name]); v.Before(ts) || !v.Before(ts.Add(time.Millisecond)) {
			t.Fatalf("%s: %s stored %v, outside [%v, +1 ms)", label, name, v, ts)
		}
	}
}

// Review code c-r1 #1: the tie-break has no limit. More than 1,001 alternating writes of one
// timestamp still let each later write win, and no stored time leaves the millisecond.
func TestRecentEqualTimestampsRepeated(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e, ctx, rc, uids := recentEnv(t, c)
			ts := time.Now().Add(-time.Minute).Truncate(time.Millisecond)
			const writes = 1205
			for i := range writes {
				name, other := "A", "B"
				if i%2 == 1 {
					name, other = "B", "A"
				}
				e.view(t, ctx, rc, uids[name], &ts)
				if i == 0 {
					continue
				}
				if got := recentNames(t, e, ctx, rc); got != name+","+other {
					t.Fatalf("write %d (%s at t): %s, want %s,%s", i+1, name, got, name, other)
				}
			}
			e.inMilli(t, uids, ts, "after the writes", "A", "B")
			// A genuinely later navigation still wins over the tied pair.
			next := ts.Add(time.Millisecond)
			e.view(t, ctx, rc, uids["A"], &next)
			e.view(t, ctx, rc, uids["B"], &ts)
			if got := recentNames(t, e, ctx, rc); got != "A,B" {
				t.Errorf("A(t+1ms), then B(t): %s, want A,B", got)
			}
		})
	}
}

// waitLockWaiters waits until n sessions wait for an advisory lock in the test database.
func waitLockWaiters(t *testing.T, e *env, n int64) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for storetest.QueryInt(t, e.db.SuperURL, `SELECT count(*) FROM pg_locks l JOIN pg_database d ON d.oid = l.database
		WHERE l.locktype = 'advisory' AND NOT l.granted AND d.datname = current_database()`) < n {
		if time.Now().After(deadline) {
			t.Fatalf("fewer than %d advisory-lock waiters after 30 s", n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// Review code c-r1 #1: concurrent views of one timestamp. Free-running pairs keep a strict order
// inside the millisecond past the old limit; views queued on the per-user lock are applied in lock
// order, so the one that takes the lock last is first.
func TestRecentEqualTimestampsConcurrent(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e, ctx, rc, uids := recentEnv(t, c)
			ts := time.Now().Add(-time.Minute).Truncate(time.Millisecond)
			const rounds = 800 // about 1,200 alternations: past the old limit of 1,000
			for r := range rounds {
				start := make(chan struct{})
				errs := make(chan error, 2)
				for _, name := range []string{"A", "B"} {
					go func() {
						<-start
						errs <- e.svc.RecordView(ctx, rc, uids[name], &ts)
					}()
				}
				close(start)
				for range 2 {
					if err := <-errs; err != nil {
						t.Fatal(err)
					}
				}
				if r%20 == 19 {
					e.inMilli(t, uids, ts, fmt.Sprintf("round %d", r+1), "A", "B")
				}
			}
			e.inMilli(t, uids, ts, "after the rounds", "A", "B")
			va, _ := e.viewedAt(t, uids["A"])
			vb, _ := e.viewedAt(t, uids["B"])
			if va.Equal(vb) {
				t.Errorf("A and B stored the same time %v; want a strict order", va)
			}

			for _, order := range [][2]string{{"A", "B"}, {"B", "A"}, {"A", "B"}} {
				release := storetest.InTx(t, e.db.SuperURL, "SELECT pg_advisory_xact_lock(hashtext($1::uuid::text || ':' || $2::uuid::text))",
					uuid.UUID(e.org), core.LocalPrincipalID)
				errs := make(chan error, 2)
				for i, name := range order {
					go func() { errs <- e.svc.RecordView(ctx, rc, uids[name], &ts) }()
					waitLockWaiters(t, e, int64(i+1))
				}
				release()
				for range 2 {
					if err := <-errs; err != nil {
						t.Fatal(err)
					}
				}
				if got, want := recentNames(t, e, ctx, rc), order[1]+","+order[0]; got != want {
					t.Errorf("%s then %s queued on the lock: %s, want %s", order[0], order[1], got, want)
				}
				e.inMilli(t, uids, ts, "queued", "A", "B")
			}
		})
	}
}

// Review r1 #2: concurrent views of different boards keep at most 200 recent views per user.
func TestRecentTrimConcurrent(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			ctx, rc := itestCtx(t), e.rc(e.org)
			storetest.Exec(t, e.db.SuperURL, `INSERT INTO recent_views (org_id, user_id, kind, id, viewed_at)
				SELECT $1, $2, 'board', gen_random_uuid(), now() - interval '1 day' - make_interval(secs => n) FROM generate_series(1, 200) n`,
				uuid.UUID(e.org), core.LocalPrincipalID)
			const rounds = 20
			var uids []string
			for i := range 2 * rounds {
				b, err := e.svc.CreateBoard(ctx, rc, titled(t, fmt.Sprintf("B%d", i)))
				if err != nil {
					t.Fatal(err)
				}
				uids = append(uids, b.UID)
			}
			for r := range rounds {
				start := make(chan struct{})
				errs := make(chan error, 2)
				for _, uid := range uids[2*r : 2*r+2] {
					go func() {
						<-start
						errs <- e.svc.RecordView(ctx, rc, uid, nil)
					}()
				}
				close(start)
				for range 2 {
					if err := <-errs; err != nil {
						t.Fatal(err)
					}
				}
				if n := e.count(t, "recent_views"); n != 200 {
					t.Fatalf("round %d: %d recent views, want 200", r, n)
				}
			}
		})
	}
}
