//go:build itest

package store

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/dbgen"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

// countingDBTX counts the statements sent through it.
type countingDBTX struct {
	db dbgen.DBTX
	n  atomic.Int64
}

func (c *countingDBTX) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	c.n.Add(1)
	return c.db.Exec(ctx, sql, args...)
}

func (c *countingDBTX) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	c.n.Add(1)
	return c.db.Query(ctx, sql, args...)
}

func (c *countingDBTX) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	c.n.Add(1)
	return c.db.QueryRow(ctx, sql, args...)
}

// T24-029: the rows, the truncation and tagsStale of a list come from one statement, so they are
// one snapshot even under READ COMMITTED.
func TestListBoardsOneStatement(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := migrated(t, c)
			d, err := Open(itestCtx(t), db.AppURL, 2)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(d.Close)
			st, err := d.InstallState(itestCtx(t))
			if err != nil {
				t.Fatal(err)
			}
			err = d.Tx(itestCtx(t), st.BootstrapOrg, func(ctx context.Context, tx *OrgTx) error {
				counter := &countingDBTX{db: tx.tx}
				counted := &OrgTx{tx: tx.tx, q: dbgen.New(counter), org: tx.org}
				items, truncated, stale, err := counted.ListBoards(ctx, core.BoardFilter{Q: "x"})
				if err != nil {
					return err
				}
				if n := counter.n.Load(); n != 1 {
					t.Errorf("ListBoards sent %d statements, want 1", n)
				}
				if items == nil || len(items) != 0 || truncated || stale != 0 {
					t.Errorf("ListBoards = %v %v %d, want [] (non-nil) false 0", items, truncated, stale)
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
}
