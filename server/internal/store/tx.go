package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// ErrNoOrg is returned by Tx for the zero organisation.
var ErrNoOrg = errors.New("store: transaction without an organisation")

// OrgTx is a transaction bound to one organisation.
type OrgTx struct {
	tx  pgx.Tx
	org core.OrgID
}

// Tx is not implemented yet.
func (d *Db) Tx(ctx context.Context, org core.OrgID, fn func(ctx context.Context, tx *OrgTx) error) error {
	return errStub
}

// Org is not implemented yet.
func (t *OrgTx) Org() core.OrgID { return t.org }

// TenantBindings is not implemented yet.
func (t *OrgTx) TenantBindings(ctx context.Context) ([]core.TenantBinding, error) {
	return nil, errStub
}
