package store

import (
	"context"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/migrations"
)

func errText(err error) string {
	if err == nil {
		return "<nil>"
	}
	return err.Error()
}

func TestCheckServeSchema(t *testing.T) {
	cases := []struct {
		db   int64
		want string
	}{
		{0, "database schema version 0 is older than this binary requires (1); run pulsus-dash migrate"},
		{1, "<nil>"},
		{2, "<nil>"},
		{3, "database schema version 3 is newer than this binary supports (latest 1, window +1)"},
	}
	for _, tc := range cases {
		if got := errText(CheckServeSchema(tc.db, 1)); got != tc.want {
			t.Errorf("CheckServeSchema(%d, 1) = %q, want %q", tc.db, got, tc.want)
		}
	}
}

func TestCheckMigrateSchema(t *testing.T) {
	cases := []struct {
		db   int64
		want string
	}{
		{0, "<nil>"},
		{2, "<nil>"},
		{3, "database schema version 3 is ahead of this binary (latest 1); refusing to migrate outside the N+1 window"},
	}
	for _, tc := range cases {
		if got := errText(CheckMigrateSchema(tc.db, 1)); got != tc.want {
			t.Errorf("CheckMigrateSchema(%d, 1) = %q, want %q", tc.db, got, tc.want)
		}
	}
}

func TestMigrationFiles(t *testing.T) {
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatalf("read migrations: %v", err)
	}
	name := regexp.MustCompile(`^\d{5}_[a-z0-9_]+\.sql$`)
	want := int64(1)
	for _, e := range entries {
		if !name.MatchString(e.Name()) {
			t.Errorf("migration %q does not match %s", e.Name(), name)
			continue
		}
		v, _ := strconv.ParseInt(e.Name()[:5], 10, 64)
		if v != want {
			t.Errorf("migration %q has version %d, want %d (versions are contiguous)", e.Name(), v, want)
		}
		want = v + 1
		b, err := fs.ReadFile(migrations.FS, e.Name())
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(b), "-- +goose Up") {
			t.Errorf("%s has no -- +goose Up", e.Name())
		}
		if strings.Contains(string(b), "-- +goose Down") {
			t.Errorf("%s has a -- +goose Down section (T11-012)", e.Name())
		}
	}
	if got := SchemaLatest(); got != 6 {
		t.Errorf("SchemaLatest() = %d, want 6", got)
	}
}

// T12-018: the data scope predicate P is byte-identical in the list and the delete statement, so
// the two paths cannot disagree on which rows a scope covers.
func TestScopePredicateShared(t *testing.T) {
	b, err := os.ReadFile("../../queries/annotations.sql")
	if err != nil {
		t.Fatal(err)
	}
	blocks := regexp.MustCompile(`(?s)-- P begin\n(.*?)\n[ \t]*-- P end`).FindAllStringSubmatch(string(b), -1)
	if len(blocks) != 2 {
		t.Fatalf("queries/annotations.sql has %d P blocks, want 2", len(blocks))
	}
	if blocks[0][1] != blocks[1][1] {
		t.Errorf("the P blocks differ:\n%s\n---\n%s", blocks[0][1], blocks[1][1])
	}
	if !strings.Contains(blocks[0][1], "sqlc.arg(scope_full)") || !strings.Contains(blocks[0][1], "sqlc.arg(scope)::jsonb") {
		t.Errorf("the P block does not read scope_full and scope:\n%s", blocks[0][1])
	}
}

func TestSingleTransactionPath(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	fset := token.NewFileSet()
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		src, err := os.ReadFile(path) //nolint:gosec // paths come from Glob over this package
		if err != nil {
			t.Fatal(err)
		}
		f, err := parser.ParseFile(fset, path, src, 0)
		if err != nil {
			t.Fatal(err)
		}
		seen++
		ast.Inspect(f, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.CallExpr:
				if sel, ok := n.Fun.(*ast.SelectorExpr); ok {
					if (sel.Sel.Name == "Begin" || sel.Sel.Name == "BeginTx") && path != "tx.go" {
						t.Errorf("%s: %s call outside tx.go (T11-003)", fset.Position(n.Pos()), sel.Sel.Name)
					}
				}
			case *ast.SelectorExpr:
				if n.Sel.Name == "pool" && path != "db.go" && path != "tx.go" {
					t.Errorf("%s: .pool used outside db.go and tx.go", fset.Position(n.Pos()))
				}
			}
			return true
		})
	}
	for _, need := range []string{"db.go", "tx.go", "migrate.go", "schema.go", "bootstrap.go"} {
		if _, err := os.Stat(need); err != nil {
			t.Errorf("store file %s is missing", need)
		}
	}
	if seen == 0 {
		t.Fatal("no store source files parsed")
	}
}

func TestTxRefusesZeroOrg(t *testing.T) {
	called := false
	err := (&Db{}).Tx(context.Background(), core.OrgID{}, func(context.Context, *OrgTx) error {
		called = true
		return nil
	})
	if err != ErrNoOrg {
		t.Errorf("Tx(zero org) = %v, want ErrNoOrg", err)
	}
	if called {
		t.Error("fn was called for the zero organisation")
	}
}

func TestOpenInvalidConnString(t *testing.T) {
	for _, v := range []string{"postgres://u:MARKERz9q@h:notaport/db", "MARKERz9q nonsense"} {
		_, err := Open(context.Background(), v, 1)
		if err != ErrInvalidConnString || strings.Contains(err.Error(), "MARKER") {
			t.Errorf("Open(%q) = %v, want ErrInvalidConnString", v, err)
		}
		_, err = Migrate(context.Background(), v, MigrateOptions{})
		if err != ErrInvalidConnString {
			t.Errorf("Migrate(%q) = %v, want ErrInvalidConnString", v, err)
		}
	}
}

func TestScrub(t *testing.T) {
	err := scrub(fmt.Errorf("connect failed for pw MARKERz9q: %w", context.DeadlineExceeded), "MARKERz9q")
	if strings.Contains(err.Error(), "MARKERz9q") {
		t.Errorf("scrubbed error %q still contains the password", err)
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Error("scrub broke errors.Is")
	}
	if scrub(nil, "x") != nil {
		t.Error("scrub(nil) != nil")
	}
}
