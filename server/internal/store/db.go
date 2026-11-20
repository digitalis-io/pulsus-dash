// Package store is the only Postgres access path of the BFF (T11-003, T11-023).
package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// ErrNotInitialised is returned when install_state has no row.
var ErrNotInitialised = errors.New("database is not initialised; run pulsus-dash migrate")

// Db is a connection pool.
type Db struct{ pool *pgxpool.Pool }

// InstallState is the first-run seed record.
type InstallState struct {
	BootstrapOrg core.OrgID
	SeededAt     time.Time
}

var errStub = errors.New("not implemented")

// Open is not implemented yet.
func Open(ctx context.Context, url string, maxConns int32) (*Db, error) { return nil, errStub }

// Close is not implemented yet.
func (d *Db) Close() {}

// Ping is not implemented yet.
func (d *Db) Ping(ctx context.Context) error { return errStub }

// SchemaVersion is not implemented yet.
func (d *Db) SchemaVersion(ctx context.Context) (int64, error) { return 0, errStub }

// RoleBypassesRLS is not implemented yet.
func (d *Db) RoleBypassesRLS(ctx context.Context) (string, bool, error) { return "", false, errStub }

// InstallState is not implemented yet.
func (d *Db) InstallState(ctx context.Context) (InstallState, error) { return InstallState{}, errStub }
