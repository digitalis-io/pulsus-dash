//go:build itest

package main

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

const aheadText = "pulsus-dash: database schema version 3 is ahead of this binary (latest 1); refusing to migrate outside the N+1 window\n"

func itestCtx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	t.Cleanup(cancel)
	return ctx
}

// dbConfig writes a config whose Postgres refs point at env variables holding db's URLs, plus
// extra YAML. It returns the config path and the environment.
func dbConfig(t *testing.T, db *storetest.TestDB, extra string) (string, []string) {
	t.Helper()
	yml := "postgres:\n  owner_url_ref: env:PG_OWNER\n  app_url_ref: env:PG_APP\n" + extra
	return writeConfig(t, yml), []string{"PG_OWNER=" + db.OwnerURL, "PG_APP=" + db.AppURL}
}

const seedYAML = "datasource:\n  url: http://localhost:9\n"

func migrateCLI(t *testing.T, cfg string, env []string, flags ...string) result {
	t.Helper()
	return runCLI(t, itestCtx(t), env, append([]string{"migrate", "--config", cfg}, flags...)...)
}

func wantLines(t *testing.T, what, out string, lines ...string) {
	t.Helper()
	for _, l := range lines {
		if !strings.Contains(out, l+"\n") {
			t.Errorf("%s output %q lacks line %q", what, out, l)
		}
	}
}

func staticSeed() (core.BootstrapSeed, error) {
	return core.BootstrapSeed{OrgSlug: "default", OrgName: "Default organisation",
		Binding: core.BindingSeed{Slug: "default", DatasourceURL: "http://localhost:9"}}, nil
}

func versionOf(t *testing.T, db *storetest.TestDB) int64 {
	t.Helper()
	return storetest.QueryInt(t, db.SuperURL, "SELECT max(version_id) FROM goose_db_version WHERE is_applied")
}

func TestMigrateFromEmpty(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := storetest.NewDB(t, c)
			cfg, env := dbConfig(t, db, seedYAML)
			r := migrateCLI(t, cfg, env)
			if r.code != 0 {
				t.Fatalf("exit %d stderr %q", r.code, r.stderr)
			}
			wantLines(t, "migrate", r.stdout, "applied 00001_tenancy.sql", "schema at version 1",
				`seeded organisation "default" with tenant binding "default"`)
			if n := storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM orgs WHERE slug = 'default'"); n != 1 {
				t.Errorf("%d default orgs, want 1", n)
			}
			if n := storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM orgs"); n != 1 {
				t.Errorf("%d orgs, want 1", n)
			}
			if n := storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM tenant_bindings WHERE slug = 'default'"); n != 1 {
				t.Errorf("%d default bindings, want 1", n)
			}
		})
	}
}

func TestMigrateIdempotent(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := storetest.NewDB(t, c)
			cfg, env := dbConfig(t, db, seedYAML)
			if r := migrateCLI(t, cfg, env); r.code != 0 {
				t.Fatalf("first: exit %d stderr %q", r.code, r.stderr)
			}
			r := migrateCLI(t, cfg, env)
			if r.code != 0 {
				t.Fatalf("second: exit %d stderr %q", r.code, r.stderr)
			}
			wantLines(t, "second migrate", r.stdout, "schema at version 1; nothing to apply", "organisation already seeded")
			if n := storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM orgs"); n != 1 {
				t.Errorf("%d orgs, want 1", n)
			}
		})
	}
}

func TestMigrateDryRun(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := storetest.NewDB(t, c)
			cfg, env := dbConfig(t, db, seedYAML)
			r := migrateCLI(t, cfg, env, "--dry-run")
			if r.code != 0 {
				t.Fatalf("exit %d stderr %q", r.code, r.stderr)
			}
			wantLines(t, "dry run", r.stdout, "pending 00001_tenancy.sql",
				`would seed organisation "default" with tenant binding "default"`)
			if !strings.HasSuffix(r.stdout, "dry run: nothing changed\n") {
				t.Errorf("last line of %q is not the dry-run line", r.stdout)
			}
			if v := storetest.QueryString(t, db.SuperURL, "SELECT to_regclass('public.goose_db_version')::text"); v != "" {
				t.Errorf("goose_db_version exists after a dry run")
			}
		})
	}
}

func TestMigrateRefusesAhead(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := storetest.NewDB(t, c)
			if _, err := store.Migrate(itestCtx(t), db.OwnerURL, store.MigrateOptions{FS: storetest.AheadFS(t, 3), Seed: staticSeed}); err != nil {
				t.Fatalf("migrate to v3: %v", err)
			}
			cfg, env := dbConfig(t, db, seedYAML)
			r := migrateCLI(t, cfg, env)
			if r.code != 1 || r.stderr != aheadText {
				t.Errorf("exit %d stderr %q, want 1 %q", r.code, r.stderr, aheadText)
			}
			if v := versionOf(t, db); v != 3 {
				t.Errorf("version %d, want 3", v)
			}
		})
	}
}

func TestNPlusOneAccepted(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := storetest.NewDB(t, c)
			if _, err := store.Migrate(itestCtx(t), db.OwnerURL, store.MigrateOptions{FS: storetest.AheadFS(t, 2), Seed: staticSeed}); err != nil {
				t.Fatalf("migrate to v2: %v", err)
			}
			cfg, env := dbConfig(t, db, seedYAML)
			r := migrateCLI(t, cfg, env)
			if r.code != 0 {
				t.Fatalf("exit %d stderr %q", r.code, r.stderr)
			}
			wantLines(t, "migrate", r.stdout, "schema at version 2 (one ahead of this binary); nothing to apply")
			s := startServe(t, cfg, env)
			s.waitReady(t)
			s.stop(t)
		})
	}
}

func TestConcurrentMigrate(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := storetest.NewDB(t, c)
			cfg, env := dbConfig(t, db, seedYAML)
			results := make(chan result, 2)
			for range 2 {
				go func() { results <- migrateCLI(t, cfg, env) }()
			}
			for range 2 {
				if r := <-results; r.code != 0 {
					t.Errorf("exit %d stderr %q", r.code, r.stderr)
				}
			}
			if v := versionOf(t, db); v != 1 {
				t.Errorf("version %d, want 1", v)
			}
			for _, table := range []string{"orgs", "install_state"} {
				if n := storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM "+table); n != 1 {
					t.Errorf("%d rows in %s, want 1", n, table)
				}
			}
		})
	}
}

func TestMigrateSchemaAdvancedWhileWaiting(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := storetest.NewDB(t, c)
			locked := make(chan struct{})
			release := make(chan struct{})
			bDone := make(chan error, 1)
			go func() {
				_, err := store.Migrate(itestCtx(t), db.OwnerURL, store.MigrateOptions{
					FS: storetest.AheadFS(t, 3), Seed: staticSeed,
					AfterLock: func() { close(locked); <-release },
				})
				bDone <- err
			}()
			select {
			case <-locked:
			case err := <-bDone:
				t.Fatalf("B finished before taking the lock: %v", err)
			case <-time.After(time.Minute):
				t.Fatal("B never took the lock")
			}

			cfg, env := dbConfig(t, db, seedYAML)
			var out, errb lockedBuffer
			aDone := make(chan int, 1)
			go func() {
				aDone <- run(itestCtx(t), runEnv{Args: []string{"migrate", "--config", cfg}, Environ: env, Stdout: &out, Stderr: &errb})
			}()
			deadline := time.Now().Add(time.Minute)
			for !strings.Contains(out.String(), "waiting for migration lock") {
				if time.Now().After(deadline) {
					close(release)
					t.Fatalf("A never waited for the lock; stdout %q stderr %q", out.String(), errb.String())
				}
				time.Sleep(20 * time.Millisecond)
			}
			close(release)
			if err := <-bDone; err != nil {
				t.Fatalf("B: %v", err)
			}
			if code := <-aDone; code != 1 || errb.String() != aheadText {
				t.Errorf("A: exit %d stderr %q, want 1 %q", code, errb.String(), aheadText)
			}
			if strings.Contains(out.String(), "applied") || strings.Contains(out.String(), "seeded") {
				t.Errorf("A applied or seeded: %q", out.String())
			}
			if v := versionOf(t, db); v != 3 {
				t.Errorf("version %d, want 3", v)
			}
			if n := storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM orgs"); n != 1 {
				t.Errorf("%d orgs, want 1", n)
			}
		})
	}
}

func TestSeedValuesCheckedWhenUnseeded(t *testing.T) {
	const refusal = "config: datasource.credentials_ref: an inline secret cannot be stored in the tenant binding; use env:NAME or file:PATH"
	cases := []struct{ name, extra, want string }{
		{"no url", "", "config: datasource.url is required to seed the first organisation"},
		{"scope", seedYAML + "  scope_org_id: \"a b\"\n", "config: datasource.scope_org_id: must match ^[A-Za-z0-9_.-]{1,150}$"},
		{"inline", "allow_inline_secrets: true\n" + seedYAML + "  credentials_ref: u:p\n", refusal},
	}
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := storetest.NewDB(t, c)
			for _, tc := range cases {
				cfg, env := dbConfig(t, db, tc.extra)
				for _, flags := range [][]string{nil, {"--dry-run"}} {
					r := migrateCLI(t, cfg, env, flags...)
					want := "pulsus-dash: " + tc.want + "\n"
					if r.code != 2 || r.stderr != want {
						t.Errorf("%s %v: exit %d stderr %q, want 2 %q", tc.name, flags, r.code, r.stderr, want)
					}
				}
			}
			for _, rel := range []string{"goose_db_version", "orgs"} {
				if v := storetest.QueryString(t, db.SuperURL, "SELECT to_regclass('public."+rel+"')::text"); v != "" {
					t.Errorf("%s exists after refused seeds", rel)
				}
			}
		})
	}
}

const bindingRow = "SELECT row_to_json(b)::text FROM tenant_bindings b"

func TestSeedValuesIgnoredWhenSeeded(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := storetest.NewDB(t, c)
			cfg, env := dbConfig(t, db, seedYAML)
			if r := migrateCLI(t, cfg, env); r.code != 0 {
				t.Fatalf("seed: exit %d stderr %q", r.code, r.stderr)
			}
			before := storetest.QueryString(t, db.SuperURL, bindingRow)
			bad := "datasource:\n  url: ftp://x\n  scope_org_id: \"a b\"\n  credentials_ref: %s\nbootstrap:\n  org_slug: Bad\n"
			ownerOnly := writeConfig(t, "postgres:\n  owner_url_ref: env:PG_OWNER\n")
			for _, extra := range []string{
				strings.Replace(bad, "%s", "env:1X", 1),
				strings.Replace(bad, "%s", "u:p", 1),
				"", // a config with only owner_url_ref
			} {
				cfg, env := dbConfig(t, db, extra)
				if extra == "" {
					cfg = ownerOnly
				}
				r := migrateCLI(t, cfg, env)
				if r.code != 0 {
					t.Errorf("plain: exit %d stderr %q", r.code, r.stderr)
				}
				wantLines(t, "plain", r.stdout, "schema at version 1; nothing to apply", "organisation already seeded")
				r = migrateCLI(t, cfg, env, "--dry-run")
				if r.code != 0 || !strings.Contains(r.stdout, "dry run: nothing changed\n") || strings.Contains(r.stdout, "would seed") {
					t.Errorf("dry run: exit %d stdout %q stderr %q", r.code, r.stdout, r.stderr)
				}
			}
			if after := storetest.QueryString(t, db.SuperURL, bindingRow); after != before {
				t.Errorf("binding changed:\n%s\n%s", before, after)
			}
		})
	}
}

func TestCredentialsRefInBinding(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := storetest.NewDB(t, c)
			cfg, env := dbConfig(t, db, seedYAML+"  credentials_ref: env:PDB_CREDS\n")
			env = append(env, "PDB_CREDS=u:s3cr3t-val")
			var outputs []string
			r := migrateCLI(t, cfg, env)
			if r.code != 0 {
				t.Fatalf("migrate: exit %d stderr %q", r.code, r.stderr)
			}
			outputs = append(outputs, r.stdout, r.stderr)
			if v := storetest.QueryString(t, db.SuperURL, "SELECT credentials_ref FROM tenant_bindings"); v != "env:PDB_CREDS" {
				t.Errorf("credentials_ref = %q, want env:PDB_CREDS", v)
			}

			s := startServe(t, cfg, env)
			s.waitReady(t)
			s.stop(t)
			outputs = append(outputs, s.stdout.String(), s.stderr.String())

			d, err := store.Open(itestCtx(t), db.AppURL, 2)
			if err != nil {
				t.Fatal(err)
			}
			st, err := d.InstallState(itestCtx(t))
			if err != nil {
				t.Fatal(err)
			}
			var bindings []core.TenantBinding
			err = d.Tx(itestCtx(t), st.BootstrapOrg, func(ctx context.Context, tx *store.OrgTx) error {
				var err error
				bindings, err = tx.TenantBindings(ctx)
				return err
			})
			d.Close()
			if err != nil || len(bindings) != 1 || bindings[0].CredentialsRef != "env:PDB_CREDS" {
				t.Errorf("TenantBindings = %+v, %v; want one with CredentialsRef env:PDB_CREDS", bindings, err)
			}

			cfg2, env2 := dbConfig(t, db, "datasource:\n  url: http://localhost:9999\n  credentials_ref: file:/run/other\n")
			r = migrateCLI(t, cfg2, append(env2, "PDB_CREDS=u:s3cr3t-val"))
			if r.code != 0 {
				t.Fatalf("second migrate: exit %d stderr %q", r.code, r.stderr)
			}
			outputs = append(outputs, r.stdout, r.stderr)
			row := storetest.QueryString(t, db.SuperURL, "SELECT credentials_ref || ' ' || datasource_url FROM tenant_bindings")
			if row != "env:PDB_CREDS http://localhost:9" {
				t.Errorf("binding after second migrate = %q, want unchanged", row)
			}
			outputs = append(outputs, storetest.QueryString(t, db.SuperURL, "SELECT string_agg(row_to_json(b)::text, ',') FROM tenant_bindings b"))
			for _, o := range outputs {
				if strings.Contains(o, "s3cr3t") {
					t.Errorf("output or row contains the resolved credential: %q", o)
				}
			}
			if code := storetest.ExecCode(t, db.SuperURL, "UPDATE tenant_bindings SET credentials_ref = 'u:p'"); code != "23514" {
				t.Errorf("literal credentials_ref: SQLSTATE %q, want 23514", code)
			}
		})
	}
}
