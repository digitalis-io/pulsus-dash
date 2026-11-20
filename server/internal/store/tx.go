package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/dbgen"
)

// ErrNoOrg is returned by Tx for the zero organisation; no connection is taken.
var ErrNoOrg = errors.New("store: transaction without an organisation")

// OrgTx is a transaction bound to one organisation: every tenant row it can see or write belongs
// to that organisation (T11-003).
type OrgTx struct {
	tx  pgx.Tx
	q   *dbgen.Queries
	org core.OrgID
}

func pgUUID(u [16]byte) pgtype.UUID { return pgtype.UUID{Bytes: u, Valid: true} }

// Tx is the only way to obtain a transaction (T11-003). It begins a READ COMMITTED transaction,
// sets pulsus.org_id transaction-locally (so a pooled connection carries no organisation after
// commit or rollback), runs fn, and commits; an error or panic in fn rolls back, and a panic is
// re-raised. Cancelling ctx cancels the statement in flight.
func (d *Db) Tx(ctx context.Context, org core.OrgID, fn func(ctx context.Context, tx *OrgTx) error) (err error) {
	if org.IsZero() {
		return ErrNoOrg
	}
	tx, err := d.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return fmt.Errorf("store: begin: %w", err)
	}
	committed := false
	defer func() {
		if committed {
			return
		}
		// Roll back even when ctx is already cancelled.
		_ = tx.Rollback(context.WithoutCancel(ctx))
	}()
	// Retention floors join this statement when the first retention domain lands (T11-010).
	if _, err := tx.Exec(ctx, "SELECT set_config('pulsus.org_id', $1, true)", org.String()); err != nil {
		return fmt.Errorf("store: bind organisation: %w", err)
	}
	if err := fn(ctx, &OrgTx{tx: tx, q: dbgen.New(tx), org: org}); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("store: commit: %w", err)
	}
	committed = true
	return nil
}

// Org returns the organisation the transaction is bound to.
func (t *OrgTx) Org() core.OrgID { return t.org }

func text(s pgtype.Text) string {
	if !s.Valid {
		return ""
	}
	return s.String
}

// TenantBindings returns the organisation's PulsusDB bindings ordered by slug. CredentialsRef is
// the stored reference string, never a resolved value (T19-010).
func (t *OrgTx) TenantBindings(ctx context.Context) ([]core.TenantBinding, error) {
	rows, err := t.q.ListTenantBindings(ctx, pgUUID(t.org))
	if err != nil {
		return nil, fmt.Errorf("store: tenant bindings: %w", err)
	}
	out := make([]core.TenantBinding, 0, len(rows))
	for _, r := range rows {
		out = append(out, core.TenantBinding{
			OrgID: core.OrgID(r.OrgID.Bytes), ID: uuid.UUID(r.ID.Bytes), Slug: r.Slug,
			DatasourceURL: r.DatasourceUrl, Database: text(r.Database), ScopeOrgID: text(r.ScopeOrgID),
			CredentialsRef: text(r.CredentialsRef), Kind: r.Kind,
		})
	}
	return out, nil
}
