//go:build itest

package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

func openApp(t *testing.T, db *storetest.TestDB) *Db {
	t.Helper()
	d, err := Open(itestCtx(t), db.AppURL, 4)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(d.Close)
	return d
}

func bootstrapOrg(t *testing.T, db *storetest.TestDB) core.OrgID {
	t.Helper()
	u, err := uuid.Parse(storetest.QueryString(t, db.SuperURL, "SELECT bootstrap_org_id::text FROM install_state"))
	if err != nil {
		t.Fatal(err)
	}
	return core.OrgID(u)
}

func leafState(t *testing.T, db *storetest.TestDB, k int) string {
	t.Helper()
	_, from, _ := storetest.Leaf(k)
	return storetest.QueryString(t, db.SuperURL, "SELECT public.pulsus_audit_leaf_state(($1::timestamptz AT TIME ZONE 'UTC')::date)", from)
}

func pgCode(err error) (string, string) {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg.Code, pg.Message
	}
	return "", ""
}

func leafCount(t *testing.T, db *storetest.TestDB) int64 {
	t.Helper()
	return storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM pg_inherits WHERE inhparent = 'public.audit_events_r13'::regclass")
}

func TestAuditPartitionsMaintain(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			for k := 0; k <= 3; k++ {
				if st := leafState(t, db, k); st != "ok" {
					name, _, _ := storetest.Leaf(k)
					t.Errorf("leaf %s after migrate: %s, want ok", name, st)
				}
			}
			d := openApp(t, db)
			rep, err := d.MaintainAuditPartitions(itestCtx(t), 3)
			if err != nil || rep != (PartitionReport{Created: 0, Dropped: 0, Horizon: 3}) {
				t.Errorf("maintain as app = %+v, %v; want {0 0 3}", rep, err)
			}
			if _, err := d.MaintainAuditPartitions(itestCtx(t), 0); storetest.Code(err) != "22023" {
				t.Errorf("maintain(0) = %v, want SQLSTATE 22023", err)
			}
			if n := storetest.QueryInt(t, db.SuperURL, `SELECT count(*) FROM pg_partitioned_table
				WHERE partrelid IN ('public.audit_events'::regclass, 'public.audit_events_r13'::regclass) AND partdefid = 0`); n != 2 {
				t.Errorf("%d parents without a default partition, want 2 (T11-021)", n)
			}
			leaf3, _, _ := storetest.Leaf(3)
			storetest.Exec(t, db.SuperURL, "DROP TABLE public."+leaf3)
			rep, err = d.MaintainAuditPartitions(itestCtx(t), 3)
			if err != nil || rep != (PartitionReport{Created: 1, Dropped: 0, Horizon: 3}) {
				t.Errorf("maintain after dropping +3 = %+v, %v; want {1 0 3}", rep, err)
			}
		})
	}
}

// insertAuditRow inserts one class-13 audit row at at for org, as the superuser.
func insertAuditRow(t *testing.T, db *storetest.TestDB, org core.OrgID, at time.Time) {
	t.Helper()
	id, _ := core.NewID()
	storetest.Exec(t, db.SuperURL, `INSERT INTO audit_events (org_id, rclass, at, id, actor_kind, action, hash)
		VALUES ($1, 13, $2, $3, 'local', 'test', sha256('x'::bytea))`, uuid.UUID(org), at, id)
}

func monthStart(k int) time.Time {
	now := time.Now().UTC()
	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, k, 0)
}

func TestAuditRetentionDrop(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			org := bootstrapOrg(t, db)
			names := map[int]string{}
			for _, k := range []int{-15, -13, -12} {
				names[k] = storetest.CreateLeaf(t, db.OwnerURL, k)
				insertAuditRow(t, db, org, monthStart(k).Add(24*time.Hour))
			}
			rep, err := openApp(t, db).MaintainAuditPartitions(itestCtx(t), 3)
			if err != nil || rep.Dropped != 1 {
				t.Fatalf("maintain = %+v, %v; want Dropped 1", rep, err)
			}
			if v := storetest.QueryString(t, db.SuperURL, "SELECT to_regclass('public."+names[-15]+"')::text"); v != "" {
				t.Errorf("the 15-month leaf %s still exists", names[-15])
			}
			if n := storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM audit_events WHERE at < $1", monthStart(-14)); n != 0 {
				t.Errorf("%d rows of the 15-month leaf remain, want 0", n)
			}
			for _, k := range []int{-13, -12} {
				if v := storetest.QueryString(t, db.SuperURL, "SELECT to_regclass('public."+names[k]+"')::text"); v == "" {
					t.Errorf("leaf %s (%d months) was dropped; its upper bound is not 13 months old", names[k], k)
				}
			}
		})
	}
}

func TestAuditHorizon(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			d := openApp(t, db)
			horizon := func() int {
				t.Helper()
				h, err := d.AuditPartitionHorizon(itestCtx(t))
				if err != nil {
					t.Fatal(err)
				}
				return h
			}
			for k := 1; k <= 3; k++ {
				name, _, _ := storetest.Leaf(k)
				storetest.Exec(t, db.SuperURL, "DROP TABLE public."+name)
			}
			if h := horizon(); h != 0 {
				t.Errorf("horizon without +1…+3 = %d, want 0", h)
			}
			name := storetest.CreateLeaf(t, db.SuperURL, 1)
			storetest.Exec(t, db.SuperURL, "ALTER TABLE public."+name+" OWNER TO pulsus_owner")
			if h := horizon(); h != 1 {
				t.Errorf("horizon with +1 = %d, want 1", h)
			}
			cur, _, _ := storetest.Leaf(0)
			storetest.Exec(t, db.SuperURL, "DROP TABLE public."+cur)
			if h := horizon(); h != -1 {
				t.Errorf("horizon without the current leaf = %d, want -1", h)
			}
			if rep, err := d.MaintainAuditPartitions(itestCtx(t), 3); err != nil || rep.Horizon != 3 {
				t.Errorf("maintain = %+v, %v; want horizon 3", rep, err)
			}
		})
	}
}

// Review r2 #1: a relation with a leaf's name is accepted only with the right parent, bounds,
// owner and kind.
func TestLeafCollision(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			d := openApp(t, db)
			name, from, to := storetest.Leaf(2)
			storetest.Exec(t, db.SuperURL, "DROP TABLE public."+name)
			shifted := strings.Replace(from, "-01 ", "-02 ", 1)
			variants := []struct {
				name    string
				plant   []string
				cleanup []string
			}{
				{"plain table", []string{"CREATE TABLE public." + name + " (i int)", "ALTER TABLE public." + name + " OWNER TO pulsus_owner"},
					[]string{"DROP TABLE public." + name}},
				{"shifted bounds", []string{"CREATE TABLE public." + name + " PARTITION OF public.audit_events_r13 FOR VALUES FROM ('" + shifted + "') TO ('" + to + "')",
					"ALTER TABLE public." + name + " OWNER TO pulsus_owner"}, []string{"DROP TABLE public." + name}},
				{"wrong owner", []string{"CREATE TABLE public." + name + " PARTITION OF public.audit_events_r13 FOR VALUES FROM ('" + from + "') TO ('" + to + "')"},
					[]string{"DROP TABLE public." + name}},
				{"wrong parent", []string{"CREATE TABLE public.scratch_r13 (LIKE public.audit_events) PARTITION BY RANGE (at)",
					"CREATE TABLE public." + name + " PARTITION OF public.scratch_r13 FOR VALUES FROM ('" + from + "') TO ('" + to + "')",
					"ALTER TABLE public." + name + " OWNER TO pulsus_owner"}, []string{"DROP TABLE public.scratch_r13 CASCADE"}},
			}
			for _, v := range variants {
				for _, s := range v.plant {
					storetest.Exec(t, db.SuperURL, s)
				}
				before := leafCount(t, db)
				if h, err := d.AuditPartitionHorizon(itestCtx(t)); err != nil || h != 1 {
					t.Errorf("%s: horizon = %d, %v; want 1", v.name, h, err)
				}
				_, err := d.MaintainAuditPartitions(itestCtx(t), 3)
				code, msg := pgCode(err)
				if code != "PD001" || !strings.HasPrefix(msg, "audit_partition_collision: public.audit_events_r13_") {
					t.Errorf("%s: maintain = %v, want PD001 audit_partition_collision", v.name, err)
				}
				if after := leafCount(t, db); after != before {
					t.Errorf("%s: leaves %d → %d, want unchanged", v.name, before, after)
				}
				for _, s := range v.cleanup {
					storetest.Exec(t, db.SuperURL, s)
				}
			}
		})
	}
}

func TestPlantedLeafBeforeMigrate(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := storetest.NewDB(t, c)
			storetest.Exec(t, db.SuperURL, "GRANT CREATE ON SCHEMA public TO PUBLIC")
			cur, _, _ := storetest.Leaf(0)
			storetest.Exec(t, db.AppURL, "CREATE TABLE public."+cur+" (i int)")
			_, err := Migrate(itestCtx(t), db.OwnerURL, MigrateOptions{Seed: testSeed})
			if err == nil || !strings.Contains(err.Error(), "audit_partition_collision: public."+cur) {
				t.Errorf("migrate = %v, want audit_partition_collision: public.%s", err, cur)
			}
			if v := storetest.QueryString(t, db.SuperURL, "SELECT has_schema_privilege('pulsus_app', 'public', 'CREATE')::text"); v != "false" {
				t.Errorf("pulsus_app CREATE on public = %s, want false", v)
			}
		})
	}
}

func TestDirectCreateGrant(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := storetest.NewDB(t, c)
			role := "itest_untrusted_" + strings.TrimPrefix(db.Name, "itest_")
			storetest.Exec(t, db.SuperURL, "CREATE ROLE "+role+" NOLOGIN")
			t.Cleanup(func() {
				storetest.Exec(t, db.SuperURL, "DROP OWNED BY "+role)
				storetest.Exec(t, db.SuperURL, "DROP ROLE "+role)
			})
			storetest.Exec(t, db.SuperURL, "GRANT CREATE ON SCHEMA public TO pulsus_app, "+role)
			want := "schema_create_grant: roles other than pulsus_owner hold CREATE on schema public: " + role
			if _, err := Migrate(itestCtx(t), db.OwnerURL, MigrateOptions{Seed: testSeed}); err == nil || !strings.Contains(err.Error(), want) {
				t.Errorf("migrate with a direct grant = %v, want %q", err, want)
			}
			if v := storetest.QueryInt(t, db.SuperURL, "SELECT max(version_id) FROM goose_db_version WHERE is_applied"); v != 1 {
				t.Errorf("schema version %d, want 1 (migration 2 rolled back)", v)
			}
			storetest.Exec(t, db.SuperURL, "REVOKE CREATE ON SCHEMA public FROM "+role)
			if _, err := Migrate(itestCtx(t), db.OwnerURL, MigrateOptions{Seed: testSeed}); err != nil {
				t.Fatalf("migrate after the revoke: %v", err)
			}
			if v := storetest.QueryInt(t, db.SuperURL, "SELECT max(version_id) FROM goose_db_version WHERE is_applied"); v != 2 {
				t.Errorf("schema version %d, want 2", v)
			}
			for _, r := range []string{"pulsus_app", "pulsus_maint"} {
				if v := storetest.QueryString(t, db.SuperURL, "SELECT has_schema_privilege($1, 'public', 'CREATE')::text", r); v != "false" {
					t.Errorf("%s CREATE on public = %s, want false", r, v)
				}
			}
			storetest.Exec(t, db.SuperURL, "GRANT CREATE ON SCHEMA public TO "+role)
			if _, err := Migrate(itestCtx(t), db.OwnerURL, MigrateOptions{Seed: testSeed}); err == nil || !strings.Contains(err.Error(), want) {
				t.Errorf("migrate with nothing pending and a direct grant = %v, want %q", err, want)
			}
		})
	}
}

// Review r1 #1: the definer function cannot be steered by objects an untrusted role plants.
func TestDefinerSafety(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := storetest.NewDB(t, c)
			storetest.Exec(t, db.SuperURL, "GRANT CREATE ON SCHEMA public TO PUBLIC")
			storetest.Exec(t, db.AppURL, "CREATE FUNCTION public.make_interval(months int) RETURNS interval LANGUAGE sql AS 'SELECT interval ''100 years'''")
			storetest.Exec(t, db.AppURL, "CREATE TABLE public.audit_events_r13_shadow (x int)")
			if _, err := Migrate(itestCtx(t), db.OwnerURL, MigrateOptions{Seed: testSeed}); err != nil {
				t.Fatalf("migrate: %v", err)
			}
			if v := storetest.QueryString(t, db.SuperURL, "SELECT has_schema_privilege('pulsus_app', 'public', 'CREATE')::text"); v != "false" {
				t.Errorf("(a) pulsus_app CREATE on public = %s, want false", v)
			}
			if code := storetest.ExecCode(t, db.AppURL, "CREATE TABLE public.x (i int)"); code != "42501" {
				t.Errorf("(b) CREATE TABLE as app: SQLSTATE %q, want 42501", code)
			}
			for _, fn := range []string{"pulsus_audit_partitions_maintain", "pulsus_audit_partition_horizon", "pulsus_audit_leaf_state"} {
				if v := storetest.QueryString(t, db.SuperURL, "SELECT proconfig[1] FROM pg_proc WHERE proname = $1", fn); v != "search_path=pg_catalog, pg_temp" {
					t.Errorf("(c) %s proconfig[1] = %q, want search_path=pg_catalog, pg_temp", fn, v)
				}
			}
			// (d) a temporary table with the leaf's name does not shadow public.
			conn, err := pgx.Connect(itestCtx(t), db.AppURL)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = conn.Close(context.Background()) }()
			leaf3, _, _ := storetest.Leaf(3)
			if _, err := conn.Exec(itestCtx(t), "CREATE TEMP TABLE "+leaf3+" (i int)"); err != nil {
				t.Fatal(err)
			}
			storetest.Exec(t, db.SuperURL, "DROP TABLE public."+leaf3)
			var created, dropped, horizon int
			if err := conn.QueryRow(itestCtx(t), "SELECT * FROM public.pulsus_audit_partitions_maintain(3)").Scan(&created, &dropped, &horizon); err != nil {
				t.Fatalf("(d) maintain: %v", err)
			}
			if created != 1 {
				t.Errorf("(d) created %d, want 1", created)
			}
			if v := storetest.QueryString(t, db.SuperURL, "SELECT relispartition::text FROM pg_class WHERE oid = to_regclass('public."+leaf3+"')"); v != "true" {
				t.Errorf("(d) public.%s relispartition = %q, want true", leaf3, v)
			}
			if n := storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM pg_class WHERE relname LIKE 'audit_events_r13_21%'"); n != 0 {
				t.Errorf("(d) %d leaves 100 years ahead, want 0", n)
			}
		})
	}
}

// seedBoard writes one row in every board table for org through the store's own methods.
func seedBoard(t *testing.T, d *Db, org core.OrgID) {
	t.Helper()
	err := d.Tx(itestCtx(t), org, func(ctx context.Context, tx *OrgTx) error {
		folder, err := tx.EnsureRootFolder(ctx)
		if err != nil {
			return err
		}
		id, _ := core.NewID()
		if ok, err := tx.InsertBoard(ctx, id, "b1", folder, "B"); err != nil || !ok {
			return errors.Join(err, errors.New("insert board"))
		}
		spec := []byte(`{"panels":[],"sections":[],"title":"B"}`)
		hash := make([]byte, 32)
		if err := tx.InsertBoardVersion(ctx, NewBoardVersion{BoardID: id, Version: 1, SchemaVersion: 1, Spec: spec, ContentHash: hash, Author: core.LocalActor()}); err != nil {
			return err
		}
		evID, _ := core.NewID()
		if _, err := tx.AppendAudit(ctx, core.AuditEvent{ID: evID, At: time.Now(), Actor: core.LocalActor(), Action: "board.create", ResourceKind: "board", ResourceID: "b1"}); err != nil {
			return err
		}
		if err := tx.Star(ctx, core.LocalPrincipalID, id); err != nil {
			return err
		}
		return tx.RecordView(ctx, core.LocalPrincipalID, id)
	})
	if err != nil {
		t.Fatalf("seed board: %v", err)
	}
}

// T11-017, T11-006, T06-004: audit events, versions and boards are append-only for the app role.
func TestAppendOnly(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			d := openApp(t, db)
			org := bootstrapOrg(t, db)
			seedBoard(t, d, org)
			run := func(stmt string) error {
				return d.Tx(itestCtx(t), org, func(ctx context.Context, tx *OrgTx) error {
					_, err := tx.tx.Exec(ctx, stmt)
					return err
				})
			}
			for _, stmt := range []string{
				"UPDATE audit_events SET action = 'x'",
				"DELETE FROM audit_events",
				"TRUNCATE audit_events",
				"UPDATE board_versions SET message = 'x'",
				"DELETE FROM board_versions",
				"DELETE FROM boards",
				"DELETE FROM audit_chain_heads",
			} {
				if code, _ := pgCode(run(stmt)); code != "42501" {
					t.Errorf("%s: SQLSTATE %q, want 42501", stmt, code)
				}
			}
			if err := run("SELECT count(*) FROM audit_events"); err != nil {
				t.Errorf("control SELECT: %v", err)
			}
		})
	}
}

// T11-010: rows older than the retention floor are invisible to the app.
func TestAuditFloor(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			org := bootstrapOrg(t, db)
			storetest.CreateLeaf(t, db.SuperURL, -14)
			insertAuditRow(t, db, org, monthStart(-14).Add(24*time.Hour))
			insertAuditRow(t, db, org, time.Now())
			var n int64
			err := openApp(t, db).Tx(itestCtx(t), org, func(ctx context.Context, tx *OrgTx) error {
				return tx.tx.QueryRow(ctx, "SELECT count(*) FROM audit_events").Scan(&n)
			})
			if err != nil || n != 1 {
				t.Errorf("visible audit rows = %d, %v; want 1", n, err)
			}
		})
	}
}

func TestSeedCreatesRootFolder(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			org := bootstrapOrg(t, db)
			if n := storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM folders WHERE uid = 'root' AND path = '/' AND org_id = $1", uuid.UUID(org)); n != 1 {
				t.Errorf("%d root folders for the bootstrap org, want 1", n)
			}
		})
	}
}
