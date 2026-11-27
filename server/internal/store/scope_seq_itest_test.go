//go:build itest

package store

import (
	"testing"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

// itest:scope-seq (#304 §A.2, ADR-0038): tenant_bindings.scope_seq comes from one global sequence
// and never goes down. A change of an access-determining column raises it; the slug and an equal
// credentials_ref (a credential rotated under the same reference) do not; a direct lowering update
// is refused; a deleted and recreated binding gets a higher value than any before it.
func TestScopeSeq(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			org := storetest.QueryString(t, db.SuperURL, "SELECT bootstrap_org_id::text FROM install_state")
			id, _ := core.NewID()
			storetest.Exec(t, db.SuperURL,
				"INSERT INTO tenant_bindings (org_id, id, slug, datasource_url, credentials_ref) VALUES ($1::uuid, $2, 'seq', 'http://localhost:9', 'env:TOKEN')",
				org, id)
			seq := func() int64 {
				return storetest.QueryInt(t, db.SuperURL, "SELECT scope_seq FROM tenant_bindings WHERE id = $1", id)
			}
			s0 := seq()
			if s0 < 2 {
				t.Fatalf("a new binding's scope_seq %d, want from the sequence (≥ 2)", s0)
			}
			last := s0
			for _, u := range []struct {
				name, sql string
				raises    bool
			}{
				{"slug", "UPDATE tenant_bindings SET slug = 'seq2' WHERE id = $1", false},
				{"same credentials_ref", "UPDATE tenant_bindings SET credentials_ref = 'env:TOKEN' WHERE id = $1", false},
				{"datasource_url", "UPDATE tenant_bindings SET datasource_url = 'http://localhost:10' WHERE id = $1", true},
				{"database", "UPDATE tenant_bindings SET database = 'db2' WHERE id = $1", true},
				{"scope_org_id", "UPDATE tenant_bindings SET scope_org_id = 'org-2' WHERE id = $1", true},
				{"credentials_ref", "UPDATE tenant_bindings SET credentials_ref = 'env:OTHER' WHERE id = $1", true},
				{"kind", "UPDATE tenant_bindings SET kind = 'other' WHERE id = $1", true},
			} {
				storetest.Exec(t, db.SuperURL, u.sql, id)
				got := seq()
				if u.raises && got <= last {
					t.Errorf("%s: scope_seq %d, want > %d", u.name, got, last)
				}
				if !u.raises && got != last {
					t.Errorf("%s: scope_seq %d, want %d", u.name, got, last)
				}
				last = got
			}
			if code := storetest.ExecCode(t, db.SuperURL, "UPDATE tenant_bindings SET scope_seq = scope_seq - 1 WHERE id = $1", id); code == "" {
				t.Error("a lowering update of scope_seq was accepted")
			}
			if seq() != last {
				t.Errorf("scope_seq %d after the refused update, want %d", seq(), last)
			}
			// The application role cannot lower it either (RLS bound to the organisation).
			if code := storetest.OrgExecCode(t, db.AppURL, orgOf(t, org), "UPDATE tenant_bindings SET scope_seq = 1 WHERE id = $1", id); code == "" {
				t.Error("pulsus_app lowered scope_seq")
			}
			storetest.Exec(t, db.SuperURL, "DELETE FROM tenant_bindings WHERE id = $1", id)
			storetest.Exec(t, db.SuperURL,
				"INSERT INTO tenant_bindings (org_id, id, slug, datasource_url, scope_seq) VALUES ($1::uuid, $2, 'seq', 'http://localhost:9', 1)",
				org, id)
			if got := seq(); got <= last {
				t.Errorf("recreated binding scope_seq %d, want > %d", got, last)
			}
			// The store reads it.
			d, err := Open(itestCtx(t), db.AppURL, 2)
			if err != nil {
				t.Fatal(err)
			}
			defer d.Close()
			view, err := d.BootstrapView(itestCtx(t))
			if err != nil {
				t.Fatal(err)
			}
			for _, b := range view.Bindings {
				if b.ID == id && b.ScopeSeq != seq() {
					t.Errorf("TenantBindings ScopeSeq %d, want %d", b.ScopeSeq, seq())
				}
			}
		})
	}
}

func orgOf(t *testing.T, s string) [16]byte {
	t.Helper()
	u, err := uuid.Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	return u
}
