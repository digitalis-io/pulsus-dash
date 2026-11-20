package store

import (
	"fmt"
	"io/fs"
	"regexp"
	"sort"
	"strconv"

	"github.com/digitalis-io/pulsus-dash/server/migrations"
)

// SchemaError reports a database schema outside the window this binary accepts (T11-015,
// T19-007): serve accepts latest and latest+1; migrate accepts anything up to latest+1.
type SchemaError struct {
	DB, Latest int64
	Ahead      bool
	Migrate    bool
}

func (e *SchemaError) Error() string {
	switch {
	case e.Migrate:
		return fmt.Sprintf("database schema version %d is ahead of this binary (latest %d); refusing to migrate outside the N+1 window", e.DB, e.Latest)
	case e.Ahead:
		return fmt.Sprintf("database schema version %d is newer than this binary supports (latest %d, window +1)", e.DB, e.Latest)
	default:
		return fmt.Sprintf("database schema version %d is older than this binary requires (%d); run pulsus-dash migrate", e.DB, e.Latest)
	}
}

// CheckServeSchema returns nil iff latest <= db <= latest+1.
func CheckServeSchema(db, latest int64) error {
	if db < latest {
		return &SchemaError{DB: db, Latest: latest}
	}
	if db > latest+1 {
		return &SchemaError{DB: db, Latest: latest, Ahead: true}
	}
	return nil
}

// CheckMigrateSchema returns nil iff db <= latest+1.
func CheckMigrateSchema(db, latest int64) error {
	if db > latest+1 {
		return &SchemaError{DB: db, Latest: latest, Ahead: true, Migrate: true}
	}
	return nil
}

var migrationName = regexp.MustCompile(`^(\d{5})_[a-z0-9_]+\.sql$`)

type migrationFile struct {
	Version int64
	Name    string
}

// migrationFiles lists the migrations of fsys in version order.
func migrationFiles(fsys fs.FS) ([]migrationFile, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, fmt.Errorf("store: read migrations: %w", err)
	}
	var out []migrationFile
	for _, e := range entries {
		m := migrationName.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		v, err := strconv.ParseInt(m[1], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("store: migration %s: %w", e.Name(), err)
		}
		out = append(out, migrationFile{Version: v, Name: e.Name()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	return out, nil
}

func latestOf(files []migrationFile) int64 {
	if len(files) == 0 {
		return 0
	}
	return files[len(files)-1].Version
}

// SchemaLatest is the highest migration version embedded in this binary. The embedded set is
// fixed at build time and checked by TestMigrationFiles, so reading it cannot fail at run time;
// should it, the result is 0 and serve refuses every database as "ahead".
func SchemaLatest() int64 {
	files, err := migrationFiles(migrations.FS)
	if err != nil {
		return 0
	}
	return latestOf(files)
}
