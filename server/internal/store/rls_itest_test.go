//go:build itest

package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
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

// migrated returns a new database at the latest schema, seeded.
func migrated(t *testing.T, c storetest.Cluster) *storetest.TestDB {
	t.Helper()
	db := storetest.NewDB(t, c)
	if _, err := Migrate(itestCtx(t), db.OwnerURL, MigrateOptions{Seed: testSeed}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return db
}

// rlsFixture says how to insert one row of a tenant table for an org, and which column holds the org.
type rlsFixture struct {
	orgColumn string
	insert    string // $1 = org id, $2 = a fresh row id, $3 = a label
}

// fixtures has one entry per tenant table. A new tenant table without an entry fails I1.
var fixtures = map[string]rlsFixture{
	"orgs":              {"id", "INSERT INTO orgs (id, slug, name) VALUES ($1, $3, $3 || ' ' || $2::text)"},
	"tenant_bindings":   {"org_id", "INSERT INTO tenant_bindings (org_id, id, slug, datasource_url) VALUES ($1, $2, $3, 'http://localhost:9')"},
	"folders":           {"org_id", "INSERT INTO folders (org_id, id, uid, title, path) VALUES ($1, $2, $3, $3, '/')"},
	"boards":            {"org_id", "INSERT INTO boards (org_id, id, uid, folder_id, title, head_version, etag) SELECT $1, $2, $3, f.id, $3, 1, 1 FROM folders f WHERE f.org_id = $1"},
	"board_versions":    {"org_id", "INSERT INTO board_versions (org_id, board_id, version, spec, schema_version, content_hash, author_kind, source) SELECT $1, b.id, 1, '{}', 1, sha256($3::text::bytea), 'local', 'ui' FROM boards b WHERE b.org_id = $1 AND $2::uuid IS NOT NULL"},
	"audit_events":      {"org_id", "INSERT INTO audit_events (org_id, rclass, at, id, actor_kind, action, hash) VALUES ($1, 13, now(), $2, 'local', $3, sha256($3::text::bytea))"},
	"stars":             {"org_id", "INSERT INTO stars (org_id, user_id, kind, object_id) SELECT $1, $2, 'board', $2 WHERE $3::text IS NOT NULL"},
	"recent_views":      {"org_id", "INSERT INTO recent_views (org_id, user_id, kind, id, viewed_at) SELECT $1, $2, 'board', $2, now() WHERE $3::text IS NOT NULL"},
	"audit_chain_heads": {"org_id", "INSERT INTO audit_chain_heads (org_id, last_at, last_id, last_hash) VALUES ($1, now(), $2, sha256($3::text::bytea))"},
	"annotations":       {"org_id", "INSERT INTO annotations (org_id, id, at, kind, text, author_kind) VALUES ($1, $2, now(), 'deploy', $3, 'local')"},
}

// insertOrder respects foreign keys.
var insertOrder = []string{"orgs", "tenant_bindings", "folders", "boards", "board_versions", "audit_events", "audit_chain_heads", "stars", "recent_views", "annotations"}

// tenantTables lists every ordinary or partitioned table in public except the non-tenant ones and
// the partitions (reached only through their parent, T11-026).
func tenantTables(t *testing.T, superURL string) []string {
	t.Helper()
	conn, err := pgx.Connect(itestCtx(t), superURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	rows, err := conn.Query(itestCtx(t), `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
		AND c.relname NOT IN ('goose_db_version', 'install_state') ORDER BY 1`)
	if err != nil {
		t.Fatal(err)
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		t.Fatal(err)
	}
	return names
}

// twoOrgs inserts one row per tenant table for two new orgs, as the superuser.
func twoOrgs(t *testing.T, db *storetest.TestDB) (core.OrgID, core.OrgID) {
	t.Helper()
	a, _ := core.NewOrgID()
	b, _ := core.NewOrgID()
	for _, org := range []core.OrgID{a, b} {
		for _, table := range insertOrder {
			id, _ := core.NewID()
			storetest.Exec(t, db.SuperURL, fixtures[table].insert, uuid.UUID(org), id, "o-"+org.String()[24:])
		}
	}
	return a, b
}

func TestRLSCrossOrg(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			a, b := twoOrgs(t, db)
			tables := tenantTables(t, db.SuperURL)
			if len(tables) == 0 {
				t.Fatal("no tenant tables found")
			}
			for role, url := range map[string]string{"pulsus_app": db.AppURL, "pulsus_owner": db.OwnerURL} {
				d, err := Open(itestCtx(t), url, 2)
				if err != nil {
					t.Fatal(err)
				}
				for _, table := range tables {
					fx, ok := fixtures[table]
					if !ok {
						t.Errorf("no RLS fixture for table %s", table)
						continue
					}
					want := storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM "+table+" WHERE "+fx.orgColumn+" = $1", uuid.UUID(a))
					err := d.Tx(itestCtx(t), a, func(ctx context.Context, tx *OrgTx) error {
						var other, total int64
						if err := tx.tx.QueryRow(ctx, "SELECT count(*) FROM "+table+" WHERE "+fx.orgColumn+" = $1", uuid.UUID(b)).Scan(&other); err != nil {
							return err
						}
						if err := tx.tx.QueryRow(ctx, "SELECT count(*) FROM "+table).Scan(&total); err != nil {
							return err
						}
						if other != 0 {
							t.Errorf("%s: %s sees %d rows of org B, want 0", role, table, other)
						}
						if total != want || want == 0 {
							t.Errorf("%s: %s total %d, want org A's %d (> 0)", role, table, total, want)
						}
						return nil
					})
					if err != nil {
						t.Errorf("%s: %v", table, err)
					}
				}
				d.Close()
			}
		})
	}
}

func TestRLSNoOrg(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			twoOrgs(t, db)
			tables := tenantTables(t, db.SuperURL)
			for role, url := range map[string]string{"pulsus_app": db.AppURL, "pulsus_owner": db.OwnerURL} {
				conn, err := pgx.Connect(itestCtx(t), url)
				if err != nil {
					t.Fatal(err)
				}
				tx, err := conn.Begin(itestCtx(t))
				if err != nil {
					t.Fatal(err)
				}
				for _, table := range tables {
					var n int64
					if err := tx.QueryRow(itestCtx(t), "SELECT count(*) FROM "+table).Scan(&n); err != nil {
						t.Fatalf("%s: %v", table, err)
					}
					if n != 0 {
						t.Errorf("%s: %s without an org sees %d rows, want 0", role, table, n)
					}
				}
				_ = tx.Rollback(itestCtx(t))
				_ = conn.Close(itestCtx(t))
			}
		})
	}
}

func TestRLSWithCheck(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			a, b := twoOrgs(t, db)
			d, err := Open(itestCtx(t), db.AppURL, 2)
			if err != nil {
				t.Fatal(err)
			}
			defer d.Close()
			err = d.Tx(itestCtx(t), a, func(ctx context.Context, tx *OrgTx) error {
				id, _ := core.NewID()
				_, err := tx.tx.Exec(ctx, "INSERT INTO tenant_bindings (org_id, id, slug, datasource_url) VALUES ($1, $2, 'x', 'http://localhost:9')", uuid.UUID(b), id)
				return err
			})
			var pg *pgconn.PgError
			if !errors.As(err, &pg) || pg.Code != "42501" {
				t.Fatalf("insert for another org: %v, want SQLSTATE 42501", err)
			}
		})
	}
}

func TestPooledConnCarriesNoOrg(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			a, _ := twoOrgs(t, db)
			d, err := Open(itestCtx(t), db.AppURL, 1)
			if err != nil {
				t.Fatal(err)
			}
			defer d.Close()
			if err := d.Tx(itestCtx(t), a, func(context.Context, *OrgTx) error { return nil }); err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"pulsus.org_id", "pulsus.floor.audit"} {
				var v *string
				if err := d.pool.QueryRow(itestCtx(t), "SELECT current_setting($1, true)", name).Scan(&v); err != nil {
					t.Fatal(err)
				}
				if v == nil || *v != "" {
					t.Errorf("%s after commit = %v, want ''", name, v)
				}
			}
		})
	}
}

// T11-026: the audit partitions are reachable only through audit_events.
func TestPartitionsUnreachable(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			children := storetest.QueryRows(t, db.SuperURL, `WITH RECURSIVE ch(oid) AS (
				SELECT inhrelid FROM pg_inherits WHERE inhparent = 'public.audit_events'::regclass
				UNION ALL SELECT i.inhrelid FROM pg_inherits i JOIN ch ON i.inhparent = ch.oid)
				SELECT c.relname::text, c.relkind::text FROM ch JOIN pg_class c ON c.oid = ch.oid ORDER BY 1`)
			if len(children) < 5 {
				t.Fatalf("%d audit partitions, want at least 5 (r13 and 4 leaves): %v", len(children), children)
			}
			for _, ch := range children {
				if code := storetest.ExecCode(t, db.AppURL, "SELECT 1 FROM public."+ch[0]); code != "42501" {
					t.Errorf("SELECT from %s as pulsus_app: SQLSTATE %q, want 42501", ch[0], code)
				}
				if ch[1] != "r" {
					continue
				}
				if code := storetest.ExecCode(t, db.AppURL, "INSERT INTO public."+ch[0]+" DEFAULT VALUES"); code != "42501" {
					t.Errorf("INSERT into %s as pulsus_app: SQLSTATE %q, want 42501", ch[0], code)
				}
			}
		})
	}
}
