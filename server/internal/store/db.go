// Package store is the only Postgres access path of the BFF (T11-003, T11-023). Tenant data is
// read and written only inside Db.Tx, which binds the transaction to one organisation for the
// row-level security policies. The statements in this file are the only ones outside Tx; none
// reads a tenant table.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/dbgen"
)

// ErrNotInitialised is returned by InstallState when the first-run seed has not happened.
var ErrNotInitialised = errors.New("database is not initialised; run pulsus-dash migrate")

// sqlstateUndefinedTable is raised when a relation does not exist yet.
const sqlstateUndefinedTable = "42P01"

// Db is a pool of connections as one Postgres role.
type Db struct{ pool *pgxpool.Pool }

// InstallState is the record of the first-run seed (table install_state, non-tenant).
type InstallState struct {
	BootstrapOrg core.OrgID
	SeededAt     time.Time
}

// Open creates a pool of at most maxConns connections. It does not connect: the first statement
// (normally Ping) does.
func Open(ctx context.Context, url string, maxConns int32) (*Db, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("store: postgres URL: %w", err)
	}
	cfg.MaxConns = maxConns
	cfg.ConnConfig.RuntimeParams["application_name"] = "pulsus-dash"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("store: open pool: %w", err)
	}
	return &Db{pool: pool}, nil
}

// Close closes every connection of the pool.
func (d *Db) Close() { d.pool.Close() }

// Ping checks that Postgres answers.
func (d *Db) Ping(ctx context.Context) error { return d.pool.Ping(ctx) }

func isUndefinedTable(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == sqlstateUndefinedTable
}

// SchemaVersion returns the highest applied goose version, or 0 when goose_db_version is absent.
func (d *Db) SchemaVersion(ctx context.Context) (int64, error) {
	var v int64
	err := d.pool.QueryRow(ctx, "SELECT COALESCE(max(version_id), 0) FROM goose_db_version WHERE is_applied").Scan(&v)
	if isUndefinedTable(err) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("store: schema version: %w", err)
	}
	return v, nil
}

// RoleBypassesRLS reports the current role and whether it is a superuser or has BYPASSRLS, either
// of which would defeat the row-level security policies (T11 §4.1).
func (d *Db) RoleBypassesRLS(ctx context.Context) (string, bool, error) {
	var role string
	var bypass bool
	err := d.pool.QueryRow(ctx, "SELECT rolname::text, rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user").Scan(&role, &bypass)
	if err != nil {
		return "", false, fmt.Errorf("store: role attributes: %w", err)
	}
	return role, bypass, nil
}

// InstallState returns the first-run seed record, or ErrNotInitialised when there is none.
func (d *Db) InstallState(ctx context.Context) (InstallState, error) {
	row, err := dbgen.New(d.pool).GetInstallState(ctx)
	if errors.Is(err, pgx.ErrNoRows) || isUndefinedTable(err) {
		return InstallState{}, ErrNotInitialised
	}
	if err != nil {
		return InstallState{}, fmt.Errorf("store: install state: %w", err)
	}
	return InstallState{BootstrapOrg: core.OrgID(row.BootstrapOrgID.Bytes), SeededAt: row.SeededAt.Time}, nil
}
