// Package store is the only Postgres access path of the BFF (T11-003, T11-023). Tenant data is
// read and written only inside Db.Tx, which binds the transaction to one organisation for the
// row-level security policies. The statements in this file are the only ones outside Tx; none
// reads a tenant table.
package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/dbgen"
)

// ErrNotInitialised is returned by InstallState when the first-run seed has not happened.
var ErrNotInitialised = errors.New("database is not initialised; run pulsus-dash migrate")

// ErrInvalidConnString is returned when a Postgres URL does not parse. It never carries the value
// or the parser's message, either of which could contain the password.
var ErrInvalidConnString = errors.New("invalid connection string")

// sqlstateUndefinedTable is raised when a relation does not exist yet.
const sqlstateUndefinedTable = "42P01"

// Db is a pool of connections as one Postgres role. password is kept only to scrub it from errors.
type Db struct {
	pool     *pgxpool.Pool
	password string
}

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
		return nil, ErrInvalidConnString
	}
	cfg.MaxConns = maxConns
	cfg.ConnConfig.RuntimeParams["application_name"] = "pulsus-dash"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, scrub(fmt.Errorf("store: open pool: %w", err), cfg.ConnConfig.Password)
	}
	return &Db{pool: pool, password: cfg.ConnConfig.Password}, nil
}

// Close closes every connection of the pool.
func (d *Db) Close() { d.pool.Close() }

// Ping checks that Postgres answers.
func (d *Db) Ping(ctx context.Context) error { return scrub(d.pool.Ping(ctx), d.password) }

// scrubbedError replaces the password in an error's text; Unwrap keeps errors.Is working.
type scrubbedError struct {
	msg string
	err error
}

func (e *scrubbedError) Error() string { return e.msg }
func (e *scrubbedError) Unwrap() error { return e.err }

// scrub returns err with every occurrence of password replaced by "xxxxx". The driver omits the
// password from its messages; this guarantees it.
func scrub(err error, password string) error {
	if err == nil || password == "" || !strings.Contains(err.Error(), password) {
		return err
	}
	return &scrubbedError{msg: strings.ReplaceAll(err.Error(), password, "xxxxx"), err: err}
}

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
		return 0, scrub(fmt.Errorf("store: schema version: %w", err), d.password)
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
		return "", false, scrub(fmt.Errorf("store: role attributes: %w", err), d.password)
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
		return InstallState{}, scrub(fmt.Errorf("store: install state: %w", err), d.password)
	}
	return InstallState{BootstrapOrg: core.OrgID(row.BootstrapOrgID.Bytes), SeededAt: row.SeededAt.Time}, nil
}
