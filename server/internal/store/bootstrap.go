package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/dbgen"
)

var errAlreadySeeded = errors.New("already seeded")

func nullText(s string) pgtype.Text { return pgtype.Text{String: s, Valid: s != ""} }

// seedBootstrap writes the first organisation, its tenant binding and install_state in one
// organisation-bound transaction (pulsus_owner is subject to FORCE RLS; WITH CHECK passes because
// Tx binds the new organisation first). It reports false, writing nothing, when a seed exists.
// Migrate calls it under the migration lock.
func seedBootstrap(ctx context.Context, ownerURL string, seed core.BootstrapSeed) (core.OrgID, bool, error) {
	d, err := Open(ctx, ownerURL, 2)
	if err != nil {
		return core.OrgID{}, false, err
	}
	defer d.Close()
	org, err := core.NewOrgID()
	if err != nil {
		return core.OrgID{}, false, fmt.Errorf("store: new organisation id: %w", err)
	}
	bindingID, err := core.NewID()
	if err != nil {
		return core.OrgID{}, false, fmt.Errorf("store: new binding id: %w", err)
	}
	err = d.Tx(ctx, org, func(ctx context.Context, tx *OrgTx) error {
		_, err := tx.q.GetInstallState(ctx)
		if err == nil {
			return errAlreadySeeded
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		if err := tx.q.InsertOrg(ctx, dbgen.InsertOrgParams{ID: pgUUID(org), Slug: seed.OrgSlug, Name: seed.OrgName}); err != nil {
			return err
		}
		b := seed.Binding
		if err := tx.q.InsertTenantBinding(ctx, dbgen.InsertTenantBindingParams{
			OrgID: pgUUID(org), ID: pgUUID(bindingID), Slug: b.Slug, DatasourceUrl: b.DatasourceURL,
			Database: nullText(b.Database), ScopeOrgID: nullText(b.ScopeOrgID), CredentialsRef: nullText(b.CredentialsRef),
		}); err != nil {
			return err
		}
		return tx.q.InsertInstallState(ctx, pgUUID(org))
	})
	if errors.Is(err, errAlreadySeeded) {
		return core.OrgID{}, false, nil
	}
	if err != nil {
		return core.OrgID{}, false, fmt.Errorf("store: seed: %w", err)
	}
	return org, true, nil
}

// BootstrapView reads the bootstrap organisation (install_state) and its tenant bindings in one
// organisation-bound transaction, for GET /api/dash/v1/bootstrap.
func (d *Db) BootstrapView(ctx context.Context) (core.BootstrapView, error) {
	st, err := d.InstallState(ctx)
	if err != nil {
		return core.BootstrapView{}, err
	}
	var view core.BootstrapView
	err = d.Tx(ctx, st.BootstrapOrg, func(ctx context.Context, tx *OrgTx) error {
		org, err := tx.Org(ctx)
		if err != nil {
			return err
		}
		bindings, err := tx.TenantBindings(ctx)
		if err != nil {
			return err
		}
		view = core.BootstrapView{Org: org, Bindings: bindings}
		return nil
	})
	if err != nil {
		return core.BootstrapView{}, err
	}
	return view, nil
}
