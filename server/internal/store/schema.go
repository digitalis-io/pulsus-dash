package store

import (
	"context"
	"io"
	"io/fs"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// SchemaLatest is not implemented yet.
func SchemaLatest() int64 { return 0 }

// CheckServeSchema is not implemented yet.
func CheckServeSchema(db, latest int64) error { return nil }

// CheckMigrateSchema is not implemented yet.
func CheckMigrateSchema(db, latest int64) error { return nil }

// MigrateOptions configure Migrate.
type MigrateOptions struct {
	DryRun    bool
	FS        fs.FS
	Seed      func() (core.BootstrapSeed, error)
	Out       io.Writer
	AfterLock func()
}

// MigrateResult reports what Migrate did.
type MigrateResult struct {
	From, To          int64
	Applied, Pending  []string
	Seeded, WouldSeed bool
	Org               core.OrgID
}

// Migrate is not implemented yet.
func Migrate(ctx context.Context, ownerURL string, o MigrateOptions) (MigrateResult, error) {
	return MigrateResult{}, errStub
}
