//go:build itest

package store

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/dbgen"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

// T24-032: the rows, the cursor and orgWideHidden of a list come from one statement, with every
// filter and the cursor set.
func TestListAnnotationsOneStatement(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			d, err := Open(itestCtx(t), db.AppURL, 2)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(d.Close)
			st, err := d.InstallState(itestCtx(t))
			if err != nil {
				t.Fatal(err)
			}
			from := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
			f := core.AnnotationFilter{Kinds: []core.AnnotationKind{core.AnnotationDeploy}, Tags: []string{"a"},
				Entities: []uuid.UUID{uuid.MustParse("bb7487bd-100d-a998-e0f0-3c65f11da1a7")}, OrgWide: true,
				Before: &core.AnnotationCursor{At: from.Add(30 * time.Minute), ID: uuid.MustParse("00000000-0000-4000-8000-000000000003")}}
			err = d.Tx(itestCtx(t), st.BootstrapOrg, func(ctx context.Context, tx *OrgTx) error {
				counter := &countingDBTX{db: tx.tx}
				counted := &OrgTx{tx: tx.tx, q: dbgen.New(counter), org: tx.org}
				page, err := counted.ListAnnotations(ctx, from, from.Add(time.Hour), 3, f, ScopeParam{Full: true, JSON: []byte("[]")})
				if err != nil {
					return err
				}
				if n := counter.n.Load(); n != 1 {
					t.Errorf("ListAnnotations sent %d statements, want 1", n)
				}
				if page.Items == nil || len(page.Items) != 0 || page.Next != nil || page.OrgWideHidden == nil || *page.OrgWideHidden != 0 {
					t.Errorf("ListAnnotations = %+v, want [] (non-nil), no next, orgWideHidden 0", page)
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}

// T11-013: annotations_entity_pair holds for new rows (entity and entity_key are set or NULL
// together) and is NOT VALID until I7 (#224).
func TestAnnotationEntityPair(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			org, err := uuid.Parse(storetest.QueryString(t, db.SuperURL, "SELECT bootstrap_org_id::text FROM install_state"))
			if err != nil {
				t.Fatal(err)
			}
			const ent = `{"id":"bb7487bd-100d-a998-e0f0-3c65f11da1a7","kind":"service"}`
			if code := storetest.OrgExecCode(t, db.AppURL, org, `INSERT INTO annotations (org_id, id, at, kind, text, author_kind, entity_key)
				VALUES ($1, gen_random_uuid(), '2026-11-26T12:00:00Z', 'deploy', 'x', 'local', 'bb7487bd-100d-a998-e0f0-3c65f11da1a7')`, org); code != "23514" {
				t.Errorf("entity_key only: SQLSTATE %q, want 23514", code)
			}
			if code := storetest.OrgExecCode(t, db.AppURL, org, `INSERT INTO annotations (org_id, id, at, kind, text, author_kind, entity)
				VALUES ($1, gen_random_uuid(), '2026-11-26T12:00:00Z', 'deploy', 'x', 'local', $2::jsonb)`, org, ent); code != "23514" {
				t.Errorf("entity only: SQLSTATE %q, want 23514", code)
			}
			if code := storetest.OrgExecCode(t, db.AppURL, org, `INSERT INTO annotations (org_id, id, at, kind, text, author_kind, entity_key, entity)
				VALUES ($1, gen_random_uuid(), '2026-11-26T12:00:00Z', 'deploy', 'x', 'local', 'bb7487bd-100d-a998-e0f0-3c65f11da1a7', $2::jsonb)`, org, ent); code != "" {
				t.Errorf("both: SQLSTATE %q, want success", code)
			}
			if v := storetest.QueryString(t, db.SuperURL, "SELECT coalesce((SELECT convalidated::text FROM pg_constraint WHERE conname = 'annotations_entity_pair'), 'absent')"); v != "false" {
				t.Errorf("annotations_entity_pair convalidated = %s, want false", v)
			}
		})
	}
}
