//go:build itest

package main

import (
	"context"
	"net"
	"net/http"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/store"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

// seedBoards is the number of schema-3 boards seeded in each organisation.
const seedBoards = 5000

// oldBinary returns DASH_OLD_BINARY, the previous release's binary that make itest-old-binary
// builds. Unset, the test skips (plain make itest); set, a missing binary fails it.
func oldBinary(t *testing.T) string {
	t.Helper()
	p := os.Getenv("DASH_OLD_BINARY")
	if p == "" {
		t.Skip("DASH_OLD_BINARY is not set; run make itest-old-binary")
	}
	if st, err := os.Stat(p); err != nil || st.IsDir() { //nolint:gosec // the test's own build of the previous release (make itest-old-binary)
		t.Fatalf("DASH_OLD_BINARY %q is not a file: %v", p, err)
	}
	return p
}

// seedOrg inserts the organisation's root folder and seedBoards boards at schema 3, as the
// previous release would have written them (superuser SQL).
func seedOrg(t *testing.T, db *storetest.TestDB, org uuid.UUID) {
	t.Helper()
	folder := uuid.New()
	storetest.Exec(t, db.SuperURL, "INSERT INTO folders (org_id, id, uid, title, path) VALUES ($1, $2, 'root', 'Root', '/') ON CONFLICT (org_id, uid) DO NOTHING", org, folder)
	storetest.Exec(t, db.SuperURL, `INSERT INTO boards (org_id, id, uid, folder_id, title, head_version, etag)
		SELECT $1, gen_random_uuid(), 'seed-' || g, f.id, 'seed ' || g, 1, 1 FROM generate_series(1, $2::int) g, folders f
		WHERE f.org_id = $1 AND f.uid = 'root'`, org, seedBoards)
	storetest.Exec(t, db.SuperURL, `INSERT INTO board_versions (org_id, board_id, version, spec, schema_version, content_hash, author_kind, source, created_at)
		SELECT b.org_id, b.id, 1, jsonb_build_object('title', b.title, 'panels', '[]'::jsonb, 'sections', '[]'::jsonb), 3,
		sha256(convert_to(b.uid, 'UTF8')), 'local', 'ui', '2026-01-01T00:00:00Z'::timestamptz + substring(b.uid from 6)::int * interval '1 second'
		FROM boards b WHERE b.org_id = $1`, org)
}

// staleCount is the organisation's live boards whose tags cache is stale.
func staleCount(t *testing.T, db *storetest.TestDB, org uuid.UUID) int64 {
	t.Helper()
	return storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM boards WHERE org_id = $1 AND deleted_at IS NULL AND tags_version <> head_version", org)
}

// startOld runs the previous release as serve --api-only on a free loopback port and waits for
// /readyz. It returns the address.
func startOld(t *testing.T, bin string, db *storetest.TestDB) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	if err := ln.Close(); err != nil {
		t.Fatal(err)
	}
	cfg, env := dbConfig(t, db, seedYAML+"server:\n  listen: "+addr+"\n")
	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, bin, "serve", "--api-only", "--config", cfg) //nolint:gosec // the test's own build of the previous release
	cmd.Env = env
	var out lockedBuffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Start(); err != nil {
		cancel()
		t.Fatalf("start the previous release: %v", err)
	}
	t.Cleanup(func() {
		cancel()
		_ = cmd.Wait()
	})
	c := http.Client{Timeout: 2 * time.Second}
	deadline := time.Now().Add(30 * time.Second)
	for {
		resp, err := c.Get("http://" + addr + "/readyz")
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == 200 {
				return addr
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("the previous release is not ready after 30 s; output %q", out.String())
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// itest:board-tags-old-binary (T11-012, T11-013, T11-015; plan #215 §5): migration 4 on a seeded
// schema-3 database is metadata only, the previous release keeps working beside this one, its
// head moves go stale and are repaired, and it cannot move a head this release saved.
func TestBoardTagsOldBinary(t *testing.T) {
	bin := oldBinary(t)
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			ctx := itestCtx(t)
			db := storetest.NewDB(t, c)
			if _, err := store.Migrate(ctx, db.OwnerURL, store.MigrateOptions{FS: storetest.AheadFS(t, 3), Seed: staticSeed}); err != nil {
				t.Fatalf("migrate to 3: %v", err)
			}
			org1, err := uuid.Parse(storetest.QueryString(t, db.SuperURL, "SELECT bootstrap_org_id::text FROM install_state"))
			if err != nil {
				t.Fatal(err)
			}
			org2 := uuid.New()
			storetest.Exec(t, db.SuperURL, "INSERT INTO orgs (id, slug, name) VALUES ($1, 'org-2', 'Org 2')", org2)
			seedOrg(t, db, org1)
			seedOrg(t, db, org2)
			relfile := func() string {
				return storetest.QueryString(t, db.SuperURL, "SELECT relfilenode::text FROM pg_class WHERE oid = 'boards'::regclass")
			}
			before := relfile()

			// A reader beside the migration: its longest wait is the migration's lock.
			stop := make(chan struct{})
			type waited struct {
				max time.Duration
				err error
			}
			done := make(chan waited, 1)
			go func() {
				m, err := storetest.Reader(db.SuperURL, "SELECT count(*) FROM boards", stop)
				done <- waited{m, err}
			}()
			time.Sleep(200 * time.Millisecond)
			if _, err := store.Migrate(ctx, db.OwnerURL, store.MigrateOptions{Seed: staticSeed}); err != nil {
				close(stop)
				t.Fatalf("migrate to 4: %v", err)
			}
			time.Sleep(200 * time.Millisecond)
			close(stop)
			r := <-done
			if r.err != nil {
				t.Fatalf("reader: %v", r.err)
			}
			maxWait := r.max
			t.Logf("reader's longest wait during migration 4: %v", maxWait)
			if maxWait > time.Second {
				t.Errorf("reader waited %v during migration 4, want ≤ 1 s", maxWait)
			}
			if after := relfile(); after != before {
				t.Errorf("boards relfilenode %s → %s: migration 4 rewrote the table", before, after)
			}
			if code := storetest.OrgExecCode(t, db.AppURL, org1, "UPDATE boards SET tags = array_fill('t'::text, ARRAY[17]) WHERE uid = 'seed-1'"); code != "23514" {
				t.Errorf("17 tags: SQLSTATE %q, want 23514", code)
			}
			if n := staleCount(t, db, org1); n != seedBoards {
				t.Fatalf("org 1: %d stale after migration 4, want %d", n, seedBoards)
			}

			old := startOld(t, bin, db)
			boardCRUD(t, old, nil)

			cfg, env := dbConfig(t, db, seedYAML)
			n := startServe(t, cfg, env)
			n.waitReady(t)
			listStale := func(query string) (map[string]any, int64) {
				t.Helper()
				code, _, b := do(t, n, "GET", boardsURL+query, nil)
				if code != 200 {
					t.Fatalf("N list %s = %d %s", query, code, b)
				}
				m := obj(t, b)
				s, ok := m["tagsStale"].(float64)
				if !ok {
					t.Fatalf("N list %s: no tagsStale in %s", query, b)
				}
				return m, int64(s)
			}
			var got, want []int64
			for i := 1; i <= seedBoards/200; i++ {
				_, s := listStale("")
				got, want = append(got, s), append(want, int64(seedBoards-200*i))
			}
			if !slices.Equal(got, want) {
				t.Errorf("tagsStale over %d lists = %v, want %v", len(want), got, want)
			}
			if s := staleCount(t, db, org2); s != seedBoards {
				t.Errorf("org 2: %d stale, want %d (org 1's lists repair only org 1)", s, seedBoards)
			}

			// The previous release creates Y and saves Z; this release saves X with a tag.
			code, _, b := doAt(t, old, "POST", boardsURL, []byte(`{"spec":{"title":"Y","panels":[],"sections":[]}}`))
			if code != 201 {
				t.Fatalf("old create Y = %d %s", code, b)
			}
			y := obj(t, b)["uid"].(string)
			if code, _, b := doAt(t, old, "PUT", boardsURL+"/seed-1", []byte(`{"spec":{"title":"Z","panels":[],"sections":[]}}`), "If-Match", `"1"`); code != 200 {
				t.Fatalf("old save Z = %d %s", code, b)
			}
			if code, _, b := do(t, n, "PUT", boardsURL+"/seed-2", []byte(`{"spec":{"title":"X","tags":["a"],"panels":[],"sections":[]}}`), "If-Match", `"1"`); code != 200 {
				t.Fatalf("N save X = %d %s", code, b)
			}
			if s := staleCount(t, db, org1); s != 2 {
				t.Errorf("org 1: %d stale after the old create and save, want 2", s)
			}
			versions := func() int64 {
				return storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM board_versions v JOIN boards b ON b.org_id = v.org_id AND b.id = v.board_id WHERE b.uid = 'seed-2' AND b.org_id = $1", org1)
			}
			if code, _, b := doAt(t, old, "PUT", boardsURL+"/seed-2", []byte(`{"spec":{"title":"X old","panels":[],"sections":[]}}`), "If-Match", `"2"`); code != 503 || errMsg(t, b) != "board saved by a newer server version" {
				t.Errorf("old save of X = %d %s, want 503 board saved by a newer server version", code, b)
			}
			if v := versions(); v != 2 {
				t.Errorf("X has %d versions, want 2", v)
			}

			m, s := listStale("")
			if s != 0 {
				t.Errorf("tagsStale after the next list = %d, want 0", s)
			}
			tagsOf := map[string]string{}
			items, _ := m["items"].([]any)
			for _, it := range items {
				o, _ := it.(map[string]any)
				tagsOf[o["uid"].(string)] = string(raw(o, "tags"))
			}
			for uid, want := range map[string]string{y: "[]", "seed-1": "[]", "seed-2": `["a"]`} {
				if tagsOf[uid] != want {
					t.Errorf("%s tags = %q, want %s", uid, tagsOf[uid], want)
				}
			}
			m, _ = listStale("?tag=a")
			var tagged []string
			items, _ = m["items"].([]any)
			for _, it := range items {
				tagged = append(tagged, it.(map[string]any)["uid"].(string))
			}
			if got := strings.Join(tagged, ","); got != "seed-2" {
				t.Errorf("tag=a = %s, want [seed-2]", got)
			}
			n.stop(t)
		})
	}
}

func errMsg(t *testing.T, b []byte) string {
	t.Helper()
	e, _ := obj(t, b)["error"].(map[string]any)
	m, _ := e["message"].(string)
	return m
}
