package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/migrations"
)

// MigrationLockID is the session advisory lock that serialises migrate runs on one database:
// 0x70756c7375730001 ("pulsus" + 1).
const MigrationLockID int64 = 8103502347670585345

// migrationLockWait bounds the wait for the lock; pg_try_advisory_lock is retried every second.
const migrationLockWait = 5 * time.Minute

// ErrSeedConfig matches (errors.Is) a seed-settings error returned by Migrate; its message is the
// configuration error itself.
var ErrSeedConfig = errors.New("seed configuration")

type seedConfigError struct{ err error }

func (e *seedConfigError) Error() string        { return e.err.Error() }
func (e *seedConfigError) Unwrap() error        { return e.err }
func (e *seedConfigError) Is(target error) bool { return target == ErrSeedConfig }

// MigrateOptions configure Migrate.
type MigrateOptions struct {
	DryRun bool
	FS     fs.FS // nil = migrations.FS
	// Seed returns the first organisation and binding (cfg.SeedSettings). It is called only when
	// install_state has no row; its error is returned wrapped so that errors.Is(err, ErrSeedConfig).
	Seed func() (core.BootstrapSeed, error)
	// Out receives progress: "waiting for migration lock", printed once. nil = discarded.
	Out io.Writer
	// AfterLock runs right after the lock is taken. Tests only; nil in production.
	AfterLock func()
}

// MigrateResult reports what Migrate did, or in a dry run what it would do.
type MigrateResult struct {
	From, To          int64
	Applied, Pending  []string
	Seeded, WouldSeed bool
	Org               core.OrgID
}

// Migrate applies the pending migrations and the first-run seed as the owner role (T11-015). It
// takes MigrationLockID before reading anything and holds it through the migrations and the seed,
// so concurrent runs serialise and a run never acts on a schema version read before the lock.
// A database more than one version ahead is refused; one version ahead (N+1) is left alone.
// Seed settings are checked before anything is written, in dry runs too.
// A URL that does not parse returns ErrInvalidConnString; no returned error contains the password.
func Migrate(ctx context.Context, ownerURL string, o MigrateOptions) (MigrateResult, error) {
	cfg, err := pgx.ParseConfig(ownerURL)
	if err != nil {
		return MigrateResult{}, ErrInvalidConnString
	}
	res, err := migrate(ctx, cfg, ownerURL, o)
	return res, scrub(err, cfg.Password)
}

func migrate(ctx context.Context, cfg *pgx.ConnConfig, ownerURL string, o MigrateOptions) (MigrateResult, error) {
	fsys := o.FS
	if fsys == nil {
		fsys = migrations.FS
	}
	out := o.Out
	if out == nil {
		out = io.Discard
	}
	files, err := migrationFiles(fsys)
	if err != nil {
		return MigrateResult{}, err
	}
	latest := latestOf(files)

	cfg.RuntimeParams["application_name"] = "pulsus-dash"
	db := stdlib.OpenDB(*cfg)
	defer func() { _ = db.Close() }()
	if err := db.PingContext(ctx); err != nil {
		return MigrateResult{}, fmt.Errorf("postgres unreachable: %w", err)
	}

	lockConn, err := db.Conn(ctx)
	if err != nil {
		return MigrateResult{}, fmt.Errorf("postgres unreachable: %w", err)
	}
	defer func() { _ = lockConn.Close() }()
	if err := acquireLock(ctx, lockConn, out); err != nil {
		return MigrateResult{}, err
	}
	// A session lock: also released if the process dies.
	defer func() {
		_, _ = lockConn.ExecContext(context.WithoutCancel(ctx), "SELECT pg_advisory_unlock($1)", MigrationLockID)
	}()
	if o.AfterLock != nil {
		o.AfterLock()
	}

	v, err := lockedVersion(ctx, lockConn)
	if err != nil {
		return MigrateResult{}, err
	}
	if err := CheckMigrateSchema(v, latest); err != nil {
		return MigrateResult{}, err
	}
	seeded, err := isSeeded(ctx, lockConn)
	if err != nil {
		return MigrateResult{}, err
	}
	var seed core.BootstrapSeed
	if !seeded {
		if o.Seed == nil {
			return MigrateResult{}, &seedConfigError{errors.New("store: no seed settings for an unseeded database")}
		}
		if seed, err = o.Seed(); err != nil {
			return MigrateResult{}, &seedConfigError{err}
		}
	}

	res := MigrateResult{From: v, To: v, WouldSeed: !seeded}
	for _, f := range files {
		if f.Version > v {
			res.Pending = append(res.Pending, f.Name)
		}
	}
	if o.DryRun {
		return res, nil
	}

	if v <= latest && len(res.Pending) > 0 {
		// No goose session locker: this function already holds the migration lock.
		p, err := goose.NewProvider(goose.DialectPostgres, db, fsys, goose.WithDisableGlobalRegistry(true))
		if err != nil {
			return res, fmt.Errorf("store: migrations: %w", err)
		}
		results, err := p.Up(ctx)
		for _, r := range results {
			if r.Error == nil {
				res.Applied = append(res.Applied, path.Base(r.Source.Path))
			}
		}
		if err != nil {
			return res, fmt.Errorf("store: migrate: %w", err)
		}
		if res.To, err = lockedVersion(ctx, lockConn); err != nil {
			return res, err
		}
	}

	if !seeded {
		org, wrote, err := seedBootstrap(ctx, ownerURL, seed)
		if err != nil {
			return res, err
		}
		res.Seeded, res.Org = wrote, org
	}
	return res, nil
}

func acquireLock(ctx context.Context, conn *sql.Conn, out io.Writer) error {
	deadline := time.Now().Add(migrationLockWait)
	waiting := false
	for {
		var ok bool
		if err := conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", MigrationLockID).Scan(&ok); err != nil {
			return fmt.Errorf("store: migration lock: %w", err)
		}
		if ok {
			return nil
		}
		if !waiting {
			_, _ = fmt.Fprintln(out, "waiting for migration lock")
			waiting = true
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("timed out after %s waiting for the migration lock", migrationLockWait)
		}
		t := time.NewTimer(time.Second)
		select {
		case <-ctx.Done():
			t.Stop()
			return ctx.Err()
		case <-t.C:
		}
	}
}

// lockedVersion reads the applied schema version without creating anything (0 = no goose table).
func lockedVersion(ctx context.Context, conn *sql.Conn) (int64, error) {
	var present bool
	if err := conn.QueryRowContext(ctx, "SELECT to_regclass('public.goose_db_version') IS NOT NULL").Scan(&present); err != nil {
		return 0, fmt.Errorf("store: schema version: %w", err)
	}
	if !present {
		return 0, nil
	}
	var v int64
	if err := conn.QueryRowContext(ctx, "SELECT COALESCE(max(version_id), 0) FROM goose_db_version WHERE is_applied").Scan(&v); err != nil {
		return 0, fmt.Errorf("store: schema version: %w", err)
	}
	return v, nil
}

func isSeeded(ctx context.Context, conn *sql.Conn) (bool, error) {
	var present bool
	if err := conn.QueryRowContext(ctx, "SELECT to_regclass('public.install_state') IS NOT NULL").Scan(&present); err != nil {
		return false, fmt.Errorf("store: install state: %w", err)
	}
	if !present {
		return false, nil
	}
	var seeded bool
	if err := conn.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM install_state)").Scan(&seeded); err != nil {
		return false, fmt.Errorf("store: install state: %w", err)
	}
	return seeded, nil
}
