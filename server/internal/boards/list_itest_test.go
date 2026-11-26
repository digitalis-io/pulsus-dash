//go:build itest

package boards

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

// tagged is a board spec with a title and, unless tags is nil, a tags member.
func tagged(t *testing.T, title string, tags []string) []byte {
	t.Helper()
	m := map[string]any{"title": title, "panels": []any{}, "sections": []any{}}
	if tags != nil {
		m["tags"] = tags
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func (e *env) create(t *testing.T, org core.OrgID, title string, tags []string) core.Board {
	t.Helper()
	b, err := e.svc.CreateBoard(itestCtx(t), e.rc(org), tagged(t, title, tags))
	if err != nil {
		t.Fatalf("create %q: %v", title, err)
	}
	return b
}

func titles(p core.BoardPage) []string {
	out := []string{}
	for _, it := range p.Items {
		out = append(out, it.Title)
	}
	return out
}

func find(p core.BoardPage, uid string) (core.BoardSummary, bool) {
	for _, it := range p.Items {
		if it.UID == uid {
			return it, true
		}
	}
	return core.BoardSummary{}, false
}

func list(t *testing.T, s *Service, rc *core.RequestCtx, f core.BoardFilter) core.BoardPage {
	t.Helper()
	p, err := s.ListBoards(itestCtx(t), rc, f)
	if err != nil {
		t.Fatalf("ListBoards(%+v): %v", f, err)
	}
	return p
}

// itest:board-find (T24 §10.1 fixture S plus "Ledger"): title substring with ASCII-only folding,
// the exact fresh tag through q, tag, q AND tag, the 1 000 cap and org isolation.
func TestBoardFind(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			orgB := e.newOrg(t, "org-b")
			for i := 1; i <= 1002; i++ {
				e.create(t, e.org, fmt.Sprintf("bulk-%d", i), nil)
			}
			named := []struct {
				title string
				tags  []string
			}{
				{"Checkout overview", []string{"team:payments"}},
				{"CHECKOUT latency", nil},
				{"Zürich edge", nil},
				{"ZÜRICH core", nil},
				{"payments", []string{"payments"}},
				{"Ledger", []string{"finance", "team:payments"}},
			}
			for _, n := range named {
				e.create(t, e.org, n.title, n.tags)
			}
			e.create(t, orgB, "checkout b", nil)
			// bulk-n at 2026-01-01Z + n s; the named boards at + 2001 … 2006 s, in order.
			storetest.Exec(t, e.db.SuperURL, `UPDATE board_versions v SET created_at = '2026-01-01T00:00:00Z'::timestamptz + substring(b.title from 6)::int * interval '1 second'
				FROM boards b WHERE b.org_id = v.org_id AND b.id = v.board_id AND b.title LIKE 'bulk-%'`)
			for i, n := range named {
				storetest.Exec(t, e.db.SuperURL, `UPDATE board_versions v SET created_at = '2026-01-01T00:00:00Z'::timestamptz + $2::int * interval '1 second'
					FROM boards b WHERE b.org_id = v.org_id AND b.id = v.board_id AND b.title = $1`, n.title, 2001+i)
			}
			rcA, rcB := e.rc(e.org), e.rc(orgB)
			for _, tc := range []struct {
				rc   *core.RequestCtx
				f    core.BoardFilter
				want []string
			}{
				{rcA, core.BoardFilter{Q: "checkout"}, []string{"CHECKOUT latency", "Checkout overview"}},
				{rcA, core.BoardFilter{Q: "zürich"}, []string{"Zürich edge"}},
				{rcA, core.BoardFilter{Q: "ZÜRICH"}, []string{"ZÜRICH core"}},
				{rcA, core.BoardFilter{Q: "payments"}, []string{"payments"}},
				{rcA, core.BoardFilter{Q: "finance"}, []string{"Ledger"}},
				{rcA, core.BoardFilter{Q: "FINANCE"}, []string{"Ledger"}},
				{rcA, core.BoardFilter{Q: "fin"}, []string{}},
				{rcA, core.BoardFilter{Q: "%"}, []string{}},
				{rcA, core.BoardFilter{Tag: "team:payments"}, []string{"Ledger", "Checkout overview"}},
				{rcA, core.BoardFilter{Q: "checkout", Tag: "team:payments"}, []string{"Checkout overview"}},
				{rcA, core.BoardFilter{Q: "ledger", Tag: "payments"}, []string{}},
				{rcB, core.BoardFilter{Q: "checkout"}, []string{"checkout b"}},
			} {
				p := list(t, e.svc, tc.rc, tc.f)
				if got := titles(p); !slices.Equal(got, tc.want) || p.Truncated || p.TagsStale != 0 {
					t.Errorf("%+v = %q truncated %v stale %d, want %q, false, 0", tc.f, got, p.Truncated, p.TagsStale, tc.want)
				}
			}
			p := list(t, e.svc, rcA, core.BoardFilter{Q: "bulk"})
			got := titles(p)
			if len(got) != 1000 || got[0] != "bulk-1002" || got[999] != "bulk-3" || !p.Truncated || p.TagsStale != 0 {
				t.Errorf("bulk: %d items %q … %q, truncated %v, stale %d; want 1000, bulk-1002 … bulk-3, true, 0",
					len(got), first(got), last(got), p.Truncated, p.TagsStale)
			}
			if slices.Contains(got, "bulk-1") || slices.Contains(got, "bulk-2") {
				t.Errorf("bulk: bulk-1 or bulk-2 listed")
			}
		})
	}
}

func first(s []string) string {
	if len(s) == 0 {
		return ""
	}
	return s[0]
}

func last(s []string) string {
	if len(s) == 0 {
		return ""
	}
	return s[len(s)-1]
}

// cacheRow is a board's tags cache as the superuser reads it: tags and fresh.
func (e *env) cacheRow(t *testing.T, uid string) string {
	t.Helper()
	rows := storetest.QueryRows(t, e.db.SuperURL, "SELECT tags::text, (tags_version = head_version)::text FROM boards WHERE uid = $1", uid)
	if len(rows) != 1 {
		t.Fatalf("%d rows for %s", len(rows), uid)
	}
	return rows[0][0] + "/" + rows[0][1]
}

func (e *env) save(t *testing.T, org core.OrgID, b core.Board, spec []byte) core.Board {
	t.Helper()
	res, err := e.svc.SaveBoard(itestCtx(t), e.rc(org), b.UID, b.ETag, spec, "")
	if err != nil {
		t.Fatalf("save %s: %v", b.UID, err)
	}
	return res.Board
}

// itest:board-tags (T24-029, T11-013, T11-003): every head move by this binary keeps the cache
// fresh, the repair is organisation-bound, and the constraint and defaults are as migrated.
func TestBoardTags(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			rc := e.rc(e.org)
			c1 := e.create(t, e.org, "C1", nil)
			c2 := e.create(t, e.org, "C2", []string{})
			v1 := tagged(t, "C3", []string{"a", "b"})
			c3, err := e.svc.CreateBoard(itestCtx(t), rc, v1)
			if err != nil {
				t.Fatal(err)
			}
			listTags := func(uid string) string {
				t.Helper()
				it, ok := find(list(t, e.svc, rc, core.BoardFilter{}), uid)
				if !ok {
					t.Fatalf("%s not listed", uid)
				}
				if !it.TagsFresh {
					return "null"
				}
				return "{" + strings.Join(it.Tags, ",") + "}"
			}
			for _, b := range []core.Board{c1, c2} {
				if got := e.cacheRow(t, b.UID); got != "{}/true" {
					t.Errorf("%s cache = %s, want {}/true", b.Title, got)
				}
				if got := listTags(b.UID); got != "{}" {
					t.Errorf("%s list tags = %s, want {}", b.Title, got)
				}
			}
			if got := e.cacheRow(t, c3.UID); got != "{a,b}/true" {
				t.Errorf("C3 cache = %s, want {a,b}/true", got)
			}
			if got := listTags(c3.UID); got != "{a,b}" {
				t.Errorf("C3 list tags = %s, want {a,b}", got)
			}
			c3 = e.save(t, e.org, c3, tagged(t, "C3", nil))
			if got := e.cacheRow(t, c3.UID); got != "{}/true" {
				t.Errorf("C3 cache after a save without tags = %s, want {}/true", got)
			}
			c3 = e.save(t, e.org, c3, v1)
			if got := e.cacheRow(t, c3.UID); got != "{a,b}/true" {
				t.Errorf("C3 cache after a save of v1 = %s, want {a,b}/true", got)
			}
			if got := listTags(c3.UID); got != "{a,b}" {
				t.Errorf("C3 list tags = %s, want {a,b}", got)
			}
			c1 = e.save(t, e.org, c1, tagged(t, "C1 renamed", nil))
			if got := e.cacheRow(t, c1.UID); got != "{}/true" {
				t.Errorf("C1 cache after save = %s, want {}/true", got)
			}
			if got := listTags(c1.UID); got != "{}" {
				t.Errorf("C1 list tags after save = %s, want {}", got)
			}
			if got := titles(list(t, e.svc, rc, core.BoardFilter{Tag: "a"})); !slices.Equal(got, []string{"C3"}) {
				t.Errorf("tag=a = %q, want [C3]", got)
			}

			// Organisation B cannot move A's head, and its list repairs only its own rows.
			orgB := e.newOrg(t, "org-b")
			rcB := e.rc(orgB)
			if _, err := e.svc.SaveBoard(itestCtx(t), rcB, c3.UID, c3.ETag, v1, ""); !errors.Is(err, core.ErrNotFound) {
				t.Errorf("SaveBoard from B = %v, want ErrNotFound", err)
			}
			storetest.Exec(t, e.db.SuperURL, "UPDATE boards SET tags_version = 0 WHERE uid = $1", c3.UID) // fault injection: stale
			if p := list(t, e.svc, rcB, core.BoardFilter{}); len(p.Items) != 0 || p.TagsStale != 0 {
				t.Errorf("B's list = %q stale %d, want [] 0", titles(p), p.TagsStale)
			}
			if got := e.cacheRow(t, c3.UID); got != "{a,b}/false" {
				t.Errorf("C3 cache after B's list = %s, want {a,b}/false (untouched)", got)
			}
			if p := list(t, e.svc, rcB, core.BoardFilter{Tag: "a"}); len(p.Items) != 0 {
				t.Errorf("B tag=a = %q, want []", titles(p))
			}

			if code := storetest.OrgExecCode(t, e.db.AppURL, e.org, "UPDATE boards SET tags = array_fill('t'::text, ARRAY[17]) WHERE uid = $1", c3.UID); code != "23514" {
				t.Errorf("17 tags as the app role: SQLSTATE %q, want 23514", code)
			}
			if v := storetest.QueryString(t, e.db.SuperURL, "SELECT convalidated::text FROM pg_constraint WHERE conname = 'boards_tags_max'"); v != "false" {
				t.Errorf("boards_tags_max convalidated = %q, want false (NOT VALID until #218)", v)
			}
			for col, want := range map[string]string{"tags": "'{}'::text[]", "tags_version": "0"} {
				if v := storetest.QueryString(t, e.db.SuperURL, "SELECT column_default FROM information_schema.columns WHERE table_name = 'boards' AND column_name = $1", col); v != want {
					t.Errorf("default of boards.%s = %q, want %q", col, v, want)
				}
			}
		})
	}
}

// syncBuffer is a log sink safe for concurrent writes.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// warns returns the WARN records of the log with op=repair_tags.
func warns(t *testing.T, log string) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(log), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("log line %q: %v", line, err)
		}
		if m["level"] == "WARN" && m["op"] == "repair_tags" {
			out = append(out, m)
		}
	}
	return out
}

// itest:board-list-snapshot (T24-029, plan #215 §4): the repair is bounded and committed on its
// own; the rows, the truncation and tagsStale come from one statement; a failed repair never fails
// the list and logs only its SQLSTATE; a cancelled list stops.
func TestBoardListSnapshot(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			e := newEnv(t, c)
			logs := &syncBuffer{}
			svc := New(e.svc.db, slog.New(slog.NewJSONHandler(logs, nil)))
			rc := e.rc(e.org)
			x := e.create(t, e.org, "X checkout", []string{"a"})
			z := e.create(t, e.org, "Z", nil)
			stale := func(uid string) {
				t.Helper()
				// Fault injection (superuser): the cache row as an old binary's head move leaves it.
				storetest.Exec(t, e.db.SuperURL, "UPDATE boards SET tags_version = 0 WHERE uid = $1", uid)
			}
			lock := func(uid string) func() {
				t.Helper()
				return storetest.InTx(t, e.db.SuperURL, "SELECT 1 FROM boards WHERE uid = $1 FOR UPDATE", uid)
			}

			// (1) X is stale and locked: the repair skips it, so tag=a finds nothing.
			stale(x.UID)
			release := lock(x.UID)
			if p := list(t, svc, rc, core.BoardFilter{Tag: "a"}); len(p.Items) != 0 || p.TagsStale != 1 {
				t.Errorf("(1) locked: tag=a = %q stale %d, want [] 1", titles(p), p.TagsStale)
			}
			release()
			p := list(t, svc, rc, core.BoardFilter{Tag: "a"})
			if it, ok := find(p, x.UID); len(p.Items) != 1 || !ok || !it.TagsFresh || !slices.Equal(it.Tags, []string{"a"}) || p.TagsStale != 0 {
				t.Errorf("(1) released: tag=a = %+v stale %d, want [X [a]] 0", p.Items, p.TagsStale)
			}

			// (2) A schema-3 head move on Z between the two transactions: the list sees it stale.
			svc.setAfterRepair(func() {
				storetest.Exec(t, e.db.SuperURL, `INSERT INTO board_versions (org_id, board_id, version, spec, schema_version, content_hash, author_kind, source)
					SELECT v.org_id, v.board_id, 2, v.spec, 3, v.content_hash, v.author_kind, 'ui' FROM board_versions v JOIN boards b
					ON b.org_id = v.org_id AND b.id = v.board_id WHERE b.uid = $1 AND v.version = 1`, z.UID)
				storetest.Exec(t, e.db.SuperURL, "UPDATE boards SET head_version = 2, etag = etag + 1 WHERE uid = $1", z.UID)
			})
			p = list(t, svc, rc, core.BoardFilter{})
			svc.setAfterRepair(nil)
			if it, ok := find(p, z.UID); !ok || it.TagsFresh || it.Tags != nil || p.TagsStale != 1 {
				t.Errorf("(2) Z = %+v (listed %v) stale %d, want TagsFresh false, no tags, stale 1", it, ok, p.TagsStale)
			}
			p = list(t, svc, rc, core.BoardFilter{})
			if it, ok := find(p, z.UID); !ok || !it.TagsFresh || len(it.Tags) != 0 || p.TagsStale != 0 {
				t.Errorf("(2) next list: Z = %+v stale %d, want fresh [] 0", it, p.TagsStale)
			}

			// (3) X stale and locked: no match is an empty, non-nil page.
			stale(x.UID)
			release = lock(x.UID)
			p = list(t, svc, rc, core.BoardFilter{Tag: "zzz"})
			if p.Items == nil || len(p.Items) != 0 || p.Truncated || p.TagsStale != 1 {
				t.Errorf("(3) tag=zzz = %#v truncated %v stale %d, want [] (non-nil) false 1", p.Items, p.Truncated, p.TagsStale)
			}
			// (4) Same: X is listed by title with its tags unknown.
			for _, f := range []core.BoardFilter{{}, {Q: "checkout"}} {
				p = list(t, svc, rc, f)
				if it, ok := find(p, x.UID); !ok || it.TagsFresh || p.TagsStale != 1 {
					t.Errorf("(4) %+v: X = %+v (listed %v) stale %d, want TagsFresh false, stale 1", f, it, ok, p.TagsStale)
				}
			}
			release()

			// (5) A failing repair: the list still answers, with one WARN carrying only the SQLSTATE.
			trigger := func(body string) {
				t.Helper()
				storetest.Exec(t, e.db.SuperURL, "CREATE OR REPLACE FUNCTION itest_repair_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN "+body+" END$$")
				storetest.Exec(t, e.db.SuperURL, "DROP TRIGGER IF EXISTS itest_repair_fault ON boards")
				storetest.Exec(t, e.db.SuperURL, "CREATE TRIGGER itest_repair_fault BEFORE UPDATE ON boards FOR EACH ROW EXECUTE FUNCTION itest_repair_fault()")
			}
			for i, tc := range []struct {
				body, sqlstate string
			}{
				{"RAISE EXCEPTION 'itest checkout fault';", "P0001"},
				{"PERFORM pg_sleep(3); RETURN NEW;", "57014"},
			} {
				trigger(tc.body)
				start := time.Now()
				p = list(t, svc, rc, core.BoardFilter{})
				took := time.Since(start)
				if it, ok := find(p, x.UID); !ok || it.TagsFresh || p.TagsStale != 1 {
					t.Errorf("(5) %s: X = %+v stale %d, want listed stale, 1", tc.sqlstate, it, p.TagsStale)
				}
				w := warns(t, logs.String())
				if len(w) != i+1 || w[i]["sqlstate"] != tc.sqlstate || w[i]["msg"] != "boards: tag repair failed" || w[i]["request_id"] != "itest-1" {
					t.Errorf("(5) %s: repair WARNs %v, want %d, the last with sqlstate %s", tc.sqlstate, w, i+1, tc.sqlstate)
				}
				if tc.sqlstate == "57014" && took >= 2900*time.Millisecond {
					t.Errorf("(5) the timed-out list took %v, want < 2.9 s", took)
				}
			}
			if strings.Contains(logs.String(), "checkout") {
				t.Errorf("(5) the log names a title or the error text: %s", logs.String())
			}

			// (6) Cancelled during the repair: context.Canceled, nothing repaired, nothing logged.
			trigger("PERFORM pg_sleep(1.5); RETURN NEW;")
			before := len(warns(t, logs.String()))
			ctx, cancel := context.WithCancel(itestCtx(t))
			timer := time.AfterFunc(300*time.Millisecond, cancel)
			_, err := svc.ListBoards(ctx, rc, core.BoardFilter{})
			timer.Stop()
			cancel()
			if !errors.Is(err, context.Canceled) {
				t.Errorf("(6) cancelled list = %v, want context.Canceled", err)
			}
			if got := e.cacheRow(t, x.UID); got != "{a}/false" {
				t.Errorf("(6) X cache = %s, want {a}/false", got)
			}
			if n := len(warns(t, logs.String())); n != before {
				t.Errorf("(6) %d repair WARNs after the cancel, want %d", n, before)
			}
			storetest.Exec(t, e.db.SuperURL, "DROP TRIGGER itest_repair_fault ON boards")
		})
	}
}
