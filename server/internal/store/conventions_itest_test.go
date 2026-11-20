//go:build itest

package store

import (
	"context"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

func superQuery(t *testing.T, url, sql string) [][]string {
	t.Helper()
	conn, err := pgx.Connect(itestCtx(t), url)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	rows, err := conn.Query(itestCtx(t), sql)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out [][]string
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			t.Fatal(err)
		}
		row := make([]string, len(vals))
		for i, v := range vals {
			switch v := v.(type) {
			case string:
				row[i] = v
			case bool:
				if v {
					row[i] = "t"
				} else {
					row[i] = "f"
				}
			}
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestSchemaConventions(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			tables := superQuery(t, db.SuperURL, `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
				EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'org_isolation')
				FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
				WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`)
			if len(tables) == 0 {
				t.Fatal("no tables")
			}
			for _, r := range tables {
				if r[0] == "goose_db_version" || r[0] == "install_state" {
					continue
				}
				if r[1] != "t" || r[2] != "t" || r[3] != "t" {
					t.Errorf("table %s: rowsecurity=%s force=%s org_isolation=%s, want all true", r[0], r[1], r[2], r[3])
				}
			}
			idx := superQuery(t, db.SuperURL, `SELECT i.relname, a.attname
				FROM pg_index x
				JOIN pg_class i ON i.oid = x.indexrelid
				JOIN pg_class t ON t.oid = x.indrelid
				JOIN pg_namespace n ON n.oid = t.relnamespace
				JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.indkey[0]
				WHERE n.nspname = 'public' ORDER BY 1`)
			var exceptions []string
			for _, r := range idx {
				if r[1] != "org_id" {
					exceptions = append(exceptions, r[0])
				}
			}
			sort.Strings(exceptions)
			want := "goose_db_version_pkey,install_state_pkey,orgs_pkey,orgs_slug_key"
			if got := strings.Join(exceptions, ","); got != want {
				t.Errorf("indexes not leading with org_id = %s, want exactly %s", got, want)
			}
		})
	}
}

func TestNoExtensions(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			if n := storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM pg_extension WHERE extname <> 'plpgsql'"); n != 0 {
				t.Fatalf("%d extensions besides plpgsql, want 0 (T11-001)", n)
			}
		})
	}
}

func TestRoleAttributes(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := storetest.NewDB(t, c)
			rows := superQuery(t, db.SuperURL, `SELECT rolname, rolbypassrls, rolsuper FROM pg_roles
				WHERE rolname IN ('pulsus_app', 'pulsus_owner', 'pulsus_maint') ORDER BY 1`)
			got := map[string][2]string{}
			for _, r := range rows {
				got[r[0]] = [2]string{r[1], r[2]}
			}
			want := map[string][2]string{"pulsus_app": {"f", "f"}, "pulsus_maint": {"t", "f"}, "pulsus_owner": {"f", "f"}}
			for role, w := range want {
				if got[role] != w {
					t.Errorf("%s: bypassrls,super = %v, want %v", role, got[role], w)
				}
			}
		})
	}
}
