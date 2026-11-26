//go:build itest

package main

import (
	"os"
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/store"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

// seedAnnotations is the number of schema-4 annotations seeded in each organisation.
const seedAnnotations = 2000

// oldSchema is DASH_OLD_SCHEMA, the highest migration of the previous release (make
// itest-old-binary sets it).
func oldSchema(t *testing.T) int64 {
	t.Helper()
	v, err := strconv.ParseInt(os.Getenv("DASH_OLD_SCHEMA"), 10, 64)
	if err != nil || v < 1 {
		t.Fatalf("DASH_OLD_SCHEMA %q is not a positive integer; run make itest-old-binary", os.Getenv("DASH_OLD_SCHEMA"))
	}
	return v
}

func keysOf(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

// itest:annotations-old-binary (T24-038, T11-012, T11-013, T11-015; plan #222 §5): migration 5 on
// a seeded schema-4 database is metadata only, and the previous release keeps working beside this
// one: it refuses `entity`, answers without `applied`, and lists this release's entity rows. It
// needs a previous release before migration 5, so it skips against a later one.
func TestAnnotationsOldBinary(t *testing.T) {
	bin := oldBinary(t)
	if oldSchema(t) >= 5 {
		t.Skip("the annotation entity transition needs a previous release before migration 5")
	}
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			ctx := itestCtx(t)
			db := storetest.NewDB(t, c)
			if _, err := store.Migrate(ctx, db.OwnerURL, store.MigrateOptions{FS: storetest.AheadFS(t, 4), Seed: staticSeed}); err != nil {
				t.Fatalf("migrate to 4: %v", err)
			}
			org1, err := uuid.Parse(storetest.QueryString(t, db.SuperURL, "SELECT bootstrap_org_id::text FROM install_state"))
			if err != nil {
				t.Fatal(err)
			}
			org2 := uuid.New()
			storetest.Exec(t, db.SuperURL, "INSERT INTO orgs (id, slug, name) VALUES ($1, 'org-2', 'Org 2')", org2)
			for _, org := range []uuid.UUID{org1, org2} {
				storetest.Exec(t, db.SuperURL, `INSERT INTO annotations (org_id, id, at, kind, text, author_kind)
					SELECT $1, gen_random_uuid(), '2026-01-01T00:00:00Z'::timestamptz + g * interval '1 second', 'deploy', 'seed ' || g, 'local'
					FROM generate_series(1, $2::int) g`, org, seedAnnotations)
			}
			relfile := func() string {
				return storetest.QueryString(t, db.SuperURL, "SELECT relfilenode::text FROM pg_class WHERE oid = 'annotations'::regclass")
			}
			before := relfile()

			stop := make(chan struct{})
			type waited struct {
				max time.Duration
				err error
			}
			done := make(chan waited, 1)
			go func() {
				m, err := storetest.Reader(db.SuperURL, "SELECT count(*) FROM annotations", stop)
				done <- waited{m, err}
			}()
			time.Sleep(200 * time.Millisecond)
			if _, err := store.Migrate(ctx, db.OwnerURL, store.MigrateOptions{Seed: staticSeed}); err != nil {
				close(stop)
				t.Fatalf("migrate to 5: %v", err)
			}
			time.Sleep(200 * time.Millisecond)
			close(stop)
			r := <-done
			if r.err != nil {
				t.Fatalf("reader: %v", r.err)
			}
			t.Logf("reader's longest wait during migration 5: %v", r.max)
			if r.max > time.Second {
				t.Errorf("reader waited %v during migration 5, want ≤ 1 s", r.max)
			}
			if after := relfile(); after != before {
				t.Errorf("annotations relfilenode %s → %s: migration 5 rewrote the table", before, after)
			}

			old := startOld(t, bin, db)
			code, _, b := doAt(t, old, "POST", annotationsURL, []byte(`{"at":1767225600500,"kind":"config","text":"old write"}`))
			if code != 201 {
				t.Fatalf("old POST = %d %s, want 201", code, b)
			}
			withEntity := []byte(`{"at":1764159000000,"kind":"deploy","text":"x","entity":{"binding":"default","kind":"service","attrs":{"service.name":"checkout"}}}`)
			code, _, b = doAt(t, old, "POST", annotationsURL, withEntity)
			if code != 400 || !sameJSON(t, raw(obj(t, b), "error"), []byte(`{"code":"invalid","message":"invalid request","fields":[{"pointer":"/entity","message_key":"annotation.unknown"}]}`)) {
				t.Errorf("old POST with entity = %d %s, want 400 /entity annotation.unknown", code, b)
			}
			code, _, b = doAt(t, old, "GET", annotationsURL+"?from=1767225600000&to=1767232800000", nil)
			if m := obj(t, b); code != 200 || !slices.Equal(keysOf(m), []string{"items", "truncated"}) {
				t.Errorf("old GET = %d keys %v, want exactly items, truncated", code, keysOf(m))
			}

			cfg, env := dbConfig(t, db, seedYAML)
			n := startServe(t, cfg, env)
			n.waitReady(t)
			code, _, b = do(t, n, "GET", annotationsURL+"?from=1767225600000&to=1767232800000&limit=3", nil)
			m := obj(t, b)
			if code != 200 || string(raw(m, "applied")) != "{}" {
				t.Errorf("N GET = %d %s, want applied {}", code, b)
			}
			for _, it := range m["items"].([]any) {
				if e, ok := it.(map[string]any)["entity"]; !ok || e != nil {
					t.Errorf("N lists an old row with entity %v, want null", e)
				}
			}
			if code, _, b := do(t, n, "POST", annotationsURL, withEntity); code != 201 {
				t.Fatalf("N POST with entity = %d %s, want 201", code, b)
			}
			code, _, b = doAt(t, old, "GET", annotationsURL+"?from=1764158400000&to=1764162000000", nil)
			if items, _ := obj(t, b)["items"].([]any); code != 200 || len(items) != 1 {
				t.Errorf("old GET of N's entity row = %d %s, want it listed", code, b)
			}
			if k := storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM annotations WHERE (entity_key IS NULL) <> (entity IS NULL)"); k != 0 {
				t.Errorf("%d unpaired rows, want 0", k)
			}
			n.stop(t)
		})
	}
}
