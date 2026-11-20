//go:build itest

// Package storetest is the integration-test harness: throwaway databases on real PostgreSQL
// clusters, a stoppable TCP proxy and a few superuser query helpers. It is compiled only with
// -tags itest.
package storetest

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/digitalis-io/pulsus-dash/server/migrations"
)

// rolesLockID serialises the roles script across parallel test binaries on one cluster.
const rolesLockID int64 = 8103502347670585346

// Cluster is one PostgreSQL server reachable as a superuser.
type Cluster struct{ Name, SuperURL string }

// Clusters parses DASH_ITEST_PG_URLS ("pg16=postgres://…,pg15=postgres://…").
func Clusters(t testing.TB) []Cluster {
	t.Helper()
	v := os.Getenv("DASH_ITEST_PG_URLS")
	if v == "" {
		t.Fatal("DASH_ITEST_PG_URLS is not set; run make itest")
	}
	var out []Cluster
	for _, part := range strings.Split(v, ",") {
		name, u, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok || name == "" || u == "" {
			t.Fatalf("DASH_ITEST_PG_URLS: entry %d is not name=url", len(out)+1)
		}
		out = append(out, Cluster{Name: name, SuperURL: u})
	}
	return out
}

// TestDB is a fresh database owned by pulsus_owner, with a URL per role.
type TestDB struct{ Name, SuperURL, OwnerURL, AppURL, MaintURL string }

func ctx(t testing.TB) context.Context {
	c, cancel := context.WithTimeout(context.Background(), time.Minute)
	t.Cleanup(cancel)
	return c
}

// withUserDB returns base with its database replaced and, when user is not "", its user.
func withUserDB(t testing.TB, base, user, db string) string {
	t.Helper()
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("cluster URL does not parse")
	}
	if user != "" {
		u.User = url.User(user)
	}
	u.Path = "/" + db
	return u.String()
}

func rolesScript(t testing.TB) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate storetest.go")
	}
	b, err := os.ReadFile(filepath.Join(filepath.Dir(file), "..", "..", "..", "deploy", "postgres-roles.sql"))
	if err != nil {
		t.Fatalf("read deploy/postgres-roles.sql: %v", err)
	}
	return string(b)
}

// NewDB creates the roles (idempotently) and a new database itest_<16 hex> owned by pulsus_owner.
// The database is dropped when the test ends.
func NewDB(t testing.TB, c Cluster) *TestDB {
	t.Helper()
	script := rolesScript(t)
	conn, err := pgx.Connect(ctx(t), c.SuperURL)
	if err != nil {
		t.Fatalf("%s: connect as superuser: %v", c.Name, err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	if _, err := conn.Exec(ctx(t), "SELECT pg_advisory_lock($1)", rolesLockID); err != nil {
		t.Fatalf("%s: roles lock: %v", c.Name, err)
	}
	_, err = conn.Exec(ctx(t), script)
	_, uerr := conn.Exec(ctx(t), "SELECT pg_advisory_unlock($1)", rolesLockID)
	if err != nil {
		t.Fatalf("%s: postgres-roles.sql: %v", c.Name, err)
	}
	if uerr != nil {
		t.Fatalf("%s: roles unlock: %v", c.Name, uerr)
	}

	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatal(err)
	}
	name := "itest_" + hex.EncodeToString(b[:])
	if _, err := conn.Exec(ctx(t), "CREATE DATABASE "+name+" OWNER pulsus_owner"); err != nil {
		t.Fatalf("%s: create database: %v", c.Name, err)
	}
	t.Cleanup(func() {
		cctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		dc, err := pgx.Connect(cctx, c.SuperURL)
		if err != nil {
			t.Errorf("%s: cleanup connect: %v", c.Name, err)
			return
		}
		defer func() { _ = dc.Close(context.Background()) }()
		if _, err := dc.Exec(cctx, "DROP DATABASE "+name+" WITH (FORCE)"); err != nil {
			t.Errorf("%s: drop %s: %v", c.Name, name, err)
		}
	})
	return &TestDB{
		Name:     name,
		SuperURL: withUserDB(t, c.SuperURL, "", name),
		OwnerURL: withUserDB(t, c.SuperURL, "pulsus_owner", name),
		AppURL:   withUserDB(t, c.SuperURL, "pulsus_app", name),
		MaintURL: withUserDB(t, c.SuperURL, "pulsus_maint", name),
	}
}

// NewProxy forwards TCP from a local port to the host of target and returns target's URL rewritten
// to the proxy. stop closes the listener and every open connection.
func NewProxy(t testing.TB, target string) (string, func()) {
	t.Helper()
	u, err := url.Parse(target)
	if err != nil {
		t.Fatal("proxy target does not parse")
	}
	upstream := u.Host
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	conns := map[net.Conn]struct{}{}
	stopped := false
	track := func(c net.Conn) bool {
		mu.Lock()
		defer mu.Unlock()
		if stopped {
			_ = c.Close()
			return false
		}
		conns[c] = struct{}{}
		return true
	}
	go func() {
		for {
			down, err := ln.Accept()
			if err != nil {
				return
			}
			up, err := net.Dial("tcp", upstream)
			if err != nil {
				_ = down.Close()
				continue
			}
			if !track(down) || !track(up) {
				_ = down.Close()
				_ = up.Close()
				continue
			}
			go func() { _, _ = io.Copy(up, down); _ = up.Close(); _ = down.Close() }()
			go func() { _, _ = io.Copy(down, up); _ = up.Close(); _ = down.Close() }()
		}
	}()
	var once sync.Once
	stop := func() {
		once.Do(func() {
			_ = ln.Close()
			mu.Lock()
			stopped = true
			for c := range conns {
				_ = c.Close()
			}
			mu.Unlock()
		})
	}
	t.Cleanup(stop)
	u.Host = ln.Addr().String()
	return u.String(), stop
}

// QueryString runs a one-row, one-column query and returns the value as text ("" for NULL).
func QueryString(t testing.TB, dsn, sql string, args ...any) string {
	t.Helper()
	conn, err := pgx.Connect(ctx(t), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	var v *string
	if err := conn.QueryRow(ctx(t), sql, args...).Scan(&v); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	if v == nil {
		return ""
	}
	return *v
}

// QueryInt runs a one-row, one-column query whose value converts to int64.
func QueryInt(t testing.TB, dsn, sql string, args ...any) int64 {
	t.Helper()
	s := QueryString(t, dsn, "SELECT ("+sql+")::text", args...)
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		t.Fatalf("%s returned %q, not an integer", sql, s)
	}
	return n
}

// QueryRows runs a query whose columns are all text (cast them in SQL) and returns the rows; a
// NULL is returned as "NULL".
func QueryRows(t testing.TB, dsn, sql string, args ...any) [][]string {
	t.Helper()
	conn, err := pgx.Connect(ctx(t), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	rows, err := conn.Query(ctx(t), sql, args...)
	if err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	defer rows.Close()
	var out [][]string
	for rows.Next() {
		vals := make([]*string, len(rows.FieldDescriptions()))
		ptrs := make([]any, len(vals))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			t.Fatalf("%s: %v", sql, err)
		}
		row := make([]string, len(vals))
		for i, v := range vals {
			row[i] = "NULL"
			if v != nil {
				row[i] = *v
			}
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return out
}

// OrgQueryInt runs a one-row integer query in a transaction bound to org with the audit floor
// set as store.Db.Tx binds it (for tests outside the store package, which cannot use pgx).
func OrgQueryInt(t testing.TB, dsn string, org [16]byte, floor time.Time, sql string, args ...any) int64 {
	t.Helper()
	conn, err := pgx.Connect(ctx(t), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	tx, err := conn.Begin(ctx(t))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx(t), "SELECT set_config('pulsus.org_id', $1, true), set_config('pulsus.floor.audit', $2, true)",
		uuidString(org), floor.UTC().Format("2006-01-02T15:04:05.000000Z07:00")); err != nil {
		t.Fatal(err)
	}
	var n int64
	if err := tx.QueryRow(ctx(t), sql, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", sql, err)
	}
	return n
}

func uuidString(u [16]byte) string {
	h := hex.EncodeToString(u[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// Exec runs a statement and fails the test on error.
func Exec(t testing.TB, dsn, sql string, args ...any) {
	t.Helper()
	if code := ExecCode(t, dsn, sql, args...); code != "" {
		t.Fatalf("%s: SQLSTATE %s", sql, code)
	}
}

// ExecCode runs a statement and returns its SQLSTATE, or "" when it succeeds.
func ExecCode(t testing.TB, dsn, sql string, args ...any) string {
	t.Helper()
	code, _ := ExecErr(t, dsn, sql, args...)
	return code
}

// ExecErr runs a statement and returns its SQLSTATE and message, or two empty strings when it
// succeeds.
func ExecErr(t testing.TB, dsn, sql string, args ...any) (string, string) {
	t.Helper()
	conn, err := pgx.Connect(ctx(t), dsn)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer func() { _ = conn.Close(context.Background()) }()
	_, err = conn.Exec(ctx(t), sql, args...)
	if err == nil {
		return "", ""
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg.Code, pg.Message
	}
	t.Fatalf("%s: %v", sql, err)
	return "", ""
}

// Code returns the SQLSTATE of a Postgres error anywhere in err's chain, or "".
func Code(err error) string {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return pg.Code
	}
	return ""
}

// Leaf returns the name of the class-13 audit leaf k months after the current UTC month, and the
// bounds of its range as Postgres timestamptz literals.
func Leaf(k int) (name, from, to string) {
	now := time.Now().UTC()
	m := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, k, 0)
	return "audit_events_r13_" + m.Format("2006_01"), m.Format("2006-01-02 15:04:05+00"), m.AddDate(0, 1, 0).Format("2006-01-02 15:04:05+00")
}

// CreateLeaf creates the leaf k months after the current month on dsn's connection role, as
// maintenance would, but without RLS (tests only).
func CreateLeaf(t testing.TB, dsn string, k int) string {
	t.Helper()
	name, from, to := Leaf(k)
	Exec(t, dsn, "CREATE TABLE public."+name+" PARTITION OF public.audit_events_r13 FOR VALUES FROM ('"+from+"') TO ('"+to+"')")
	return name
}

// AheadFS returns the embedded migrations plus testdata/ahead migrations up to version upTo,
// simulating a newer binary's migration set.
func AheadFS(t testing.TB, upTo int64) fs.FS {
	t.Helper()
	out := fstest.MapFS{}
	add := func(fsys fs.FS) {
		entries, err := fs.ReadDir(fsys, ".")
		if err != nil {
			t.Fatal(err)
		}
		for _, e := range entries {
			v, err := strconv.ParseInt(strings.SplitN(e.Name(), "_", 2)[0], 10, 64)
			if err != nil || !strings.HasSuffix(e.Name(), ".sql") || v > upTo {
				continue
			}
			b, err := fs.ReadFile(fsys, e.Name())
			if err != nil {
				t.Fatal(err)
			}
			out[e.Name()] = &fstest.MapFile{Data: b, Mode: 0o644}
		}
	}
	add(migrations.FS)
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate storetest.go")
	}
	add(os.DirFS(filepath.Join(filepath.Dir(file), "..", "testdata", "ahead")))
	return out
}
