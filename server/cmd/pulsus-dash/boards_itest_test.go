//go:build itest

package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/static/statictest"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

var requestSeq atomic.Int64

// do sends one request to s with X-Request-Id itest-<n> and returns the status, headers and body.
func do(t *testing.T, s *served, method, path string, body []byte, hdr ...string) (int, http.Header, []byte) {
	t.Helper()
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, "http://"+s.addr+path, r)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("X-Request-Id", fmt.Sprintf("itest-%d", requestSeq.Add(1)))
	for i := 0; i+1 < len(hdr); i += 2 {
		req.Header.Set(hdr[i], hdr[i+1])
	}
	c := http.Client{Timeout: 10 * time.Second}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	resp.Header.Set("X-Request-Id", req.Header.Get("X-Request-Id"))
	return resp.StatusCode, resp.Header, b
}

func obj(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("body %q: %v", b, err)
	}
	return m
}

func specFixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "api", "fixtures", "board-spec", name)) //nolint:gosec // fixture names are constants of the tests
	if err != nil {
		t.Fatal(err)
	}
	return bytes.TrimSpace(b)
}

func sameJSON(t *testing.T, a, b []byte) bool {
	t.Helper()
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	xa, _ := json.Marshal(x)
	ya, _ := json.Marshal(y)
	return bytes.Equal(xa, ya)
}

func raw(m map[string]any, key string) []byte {
	b, _ := json.Marshal(m[key])
	return b
}

func boardCounts(t *testing.T, db *storetest.TestDB) string {
	t.Helper()
	return fmt.Sprintf("versions %d audit %d",
		storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM board_versions"),
		storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM audit_events"))
}

const boardsURL = "/api/dash/v1/boards"

func TestBoardCRUD(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db, cfg, env := migratedDB(t, c, "")
			s := startServe(t, cfg, env)
			s.waitReady(t)
			minimal, full := specFixture(t, "v1-minimal.json"), specFixture(t, "v1-full.json")
			canonMinimal := []byte(`{"panels":[],"sections":[],"title":"New board"}`)
			var reqIDs []string

			// 1 create
			code, hdr, b := do(t, s, "POST", boardsURL, []byte(`{"spec":`+string(minimal)+`}`))
			reqIDs = append(reqIDs, hdr.Get("X-Request-Id"))
			m := obj(t, b)
			uid, _ := m["uid"].(string)
			if code != 201 || hdr.Get("ETag") != `"1"` || !regexp.MustCompile(`^[0-9a-z]{14}$`).MatchString(uid) {
				t.Fatalf("1 create = %d ETag %q %s", code, hdr.Get("ETag"), b)
			}
			if got := boardCounts(t, db); got != "versions 1 audit 1" {
				t.Errorf("1: %s", got)
			}
			path := boardsURL + "/" + uid
			// 2 get
			code, hdr, b = do(t, s, "GET", path, nil)
			if m = obj(t, b); code != 200 || hdr.Get("ETag") != `"1"` || string(raw(m, "spec")) != string(canonMinimal) {
				t.Errorf("2 get = %d ETag %q %s", code, hdr.Get("ETag"), b)
			}
			// 3 save full
			code, hdr, b = do(t, s, "PUT", path, []byte(`{"spec":`+string(full)+`}`), "If-Match", `"1"`)
			reqIDs = append(reqIDs, hdr.Get("X-Request-Id"))
			m = obj(t, b)
			board, _ := m["board"].(map[string]any)
			if code != 200 || m["changed"] != true || board["version"] != float64(2) || hdr.Get("ETag") != `"2"` || !sameJSON(t, raw(board, "spec"), full) {
				t.Errorf("3 save = %d ETag %q %s", code, hdr.Get("ETag"), b)
			}
			if got := boardCounts(t, db); got != "versions 2 audit 2" {
				t.Errorf("3: %s", got)
			}
			// 4 same body: no-op
			code, hdr, b = do(t, s, "PUT", path, []byte(`{"spec":`+string(full)+`}`), "If-Match", `"2"`)
			m = obj(t, b)
			board, _ = m["board"].(map[string]any)
			if code != 200 || m["changed"] != false || board["version"] != float64(2) || hdr.Get("ETag") != `"2"` {
				t.Errorf("4 unchanged save = %d ETag %q %s", code, hdr.Get("ETag"), b)
			}
			if got := boardCounts(t, db); got != "versions 2 audit 2" {
				t.Errorf("4: %s", got)
			}
			// 5 stale If-Match
			code, _, b = do(t, s, "PUT", path, []byte(`{"spec":`+string(minimal)+`}`), "If-Match", `"1"`)
			m = obj(t, b)
			e, _ := m["error"].(map[string]any)
			cur, _ := m["current"].(map[string]any)
			if code != 409 || e["code"] != "conflict" || cur["version"] != float64(2) || !sameJSON(t, raw(cur, "spec"), full) || !sameJSON(t, raw(m, "submitted"), minimal) {
				t.Errorf("5 conflict = %d %s", code, b)
			}
			if got := boardCounts(t, db); got != "versions 2 audit 2" {
				t.Errorf("5: %s", got)
			}
			// 6 no If-Match
			if code, _, b = do(t, s, "PUT", path, []byte(`{"spec":`+string(minimal)+`}`)); code != 428 {
				t.Errorf("6 = %d %s, want 428", code, b)
			}
			// 7 list
			code, _, b = do(t, s, "GET", boardsURL, nil)
			items, _ := obj(t, b)["items"].([]any)
			if code != 200 || len(items) != 1 {
				t.Fatalf("7 list = %d %s", code, b)
			}
			it, _ := items[0].(map[string]any)
			if it["title"] != "Service overview" || string(raw(it, "updated_by")) != `{"kind":"local","name":"Local user"}` {
				t.Errorf("7 item = %v", it)
			}
			// 8 delete
			code, hdr, b = do(t, s, "DELETE", path, nil, "If-Match", `"2"`)
			reqIDs = append(reqIDs, hdr.Get("X-Request-Id"))
			if code != 204 {
				t.Errorf("8 delete = %d %s", code, b)
			}
			if code, _, _ = do(t, s, "GET", path, nil); code != 404 {
				t.Errorf("8 get after delete = %d, want 404", code)
			}
			if _, _, b = do(t, s, "GET", boardsURL, nil); string(raw(obj(t, b), "items")) != "[]" {
				t.Errorf("8 list after delete = %s", b)
			}
			if got := boardCounts(t, db); got != "versions 2 audit 3" {
				t.Errorf("8: %s", got)
			}
			rows := storetest.QueryRows(t, db.SuperURL, "SELECT actor_kind, actor_id::text, resource_id, request_id, action FROM audit_events ORDER BY at, id")
			wantActions := []string{"board.create", "board.update", "board.delete"}
			for i, r := range rows {
				want := []string{"local", core.LocalPrincipalID.String(), uid, reqIDs[i], wantActions[i]}
				if strings.Join(r, " ") != strings.Join(want, " ") {
					t.Errorf("audit row %d = %v, want %v", i, r, want)
				}
			}
			s.stop(t)
		})
	}
}

func TestBoardInvalidWritesNothing(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db, cfg, env := migratedDB(t, c, "")
			s := startServe(t, cfg, env)
			s.waitReady(t)
			code, _, b := do(t, s, "POST", boardsURL, []byte(`{"spec":{"title":"","panels":[],"sections":[]}}`))
			e, _ := obj(t, b)["error"].(map[string]any)
			fields, _ := e["fields"].([]any)
			if code != 400 || len(fields) == 0 || !sameJSON(t, raw(map[string]any{"f": fields[0]}, "f"), []byte(`{"pointer":"/title","message_key":"board.title.required"}`)) {
				t.Errorf("invalid create = %d %s", code, b)
			}
			if n := storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM boards"); n != 0 {
				t.Errorf("%d boards, want 0", n)
			}
			if n := storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM audit_events"); n != 0 {
				t.Errorf("%d audit rows, want 0", n)
			}
			s.stop(t)
		})
	}
}

func refUIDs(t *testing.T, b []byte) string {
	t.Helper()
	items, _ := obj(t, b)["items"].([]any)
	var out []string
	for _, it := range items {
		out = append(out, it.(map[string]any)["uid"].(string))
	}
	return strings.Join(out, ",")
}

func TestBoardPrefs(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			_, cfg, env := migratedDB(t, c, "")
			s := startServe(t, cfg, env)
			s.waitReady(t)
			uids := map[string]string{}
			for _, name := range []string{"A", "B", "C"} {
				code, _, b := do(t, s, "POST", boardsURL, []byte(`{"spec":{"title":"`+name+`","panels":[],"sections":[]}}`))
				if code != 201 {
					t.Fatalf("create %s = %d %s", name, code, b)
				}
				uids[name] = obj(t, b)["uid"].(string)
			}
			const starred, recent = "/api/dash/v1/me/starred-boards", "/api/dash/v1/me/recent-boards"
			for range 2 {
				if code, _, b := do(t, s, "PUT", starred+"/"+uids["A"], nil); code != 204 {
					t.Errorf("star A = %d %s", code, b)
				}
			}
			if _, _, b := do(t, s, "GET", starred, nil); refUIDs(t, b) != uids["A"] {
				t.Errorf("starred = %s, want [A]", b)
			}
			if code, _, _ := do(t, s, "DELETE", starred+"/"+uids["A"], nil); code != 204 {
				t.Errorf("unstar A = %d", code)
			}
			if _, _, b := do(t, s, "GET", starred, nil); refUIDs(t, b) != "" {
				t.Errorf("starred after unstar = %s, want []", b)
			}
			if code, _, _ := do(t, s, "PUT", starred+"/zzz", nil); code != 404 {
				t.Errorf("star zzz = %d, want 404", code)
			}
			for _, name := range []string{"A", "B", "C"} {
				if code, _, b := do(t, s, "PUT", recent+"/"+uids[name], nil); code != 204 {
					t.Errorf("view %s = %d %s", name, code, b)
				}
			}
			list := func(name ...string) string {
				var out []string
				for _, n := range name {
					out = append(out, uids[n])
				}
				return strings.Join(out, ",")
			}
			if _, _, b := do(t, s, "GET", recent, nil); refUIDs(t, b) != list("C", "B", "A") {
				t.Errorf("recent = %s, want [C B A]", b)
			}
			if _, _, b := do(t, s, "GET", recent+"?limit=2", nil); refUIDs(t, b) != list("C", "B") {
				t.Errorf("recent?limit=2 = %s, want [C B]", b)
			}
			if code, _, _ := do(t, s, "DELETE", boardsURL+"/"+uids["B"], nil, "If-Match", `"1"`); code != 204 {
				t.Errorf("delete B = %d", code)
			}
			if _, _, b := do(t, s, "GET", recent, nil); refUIDs(t, b) != list("C", "A") {
				t.Errorf("recent after deleting B = %s, want [C A]", b)
			}
			do(t, s, "PUT", starred+"/"+uids["A"], nil)
			if code, _, _ := do(t, s, "DELETE", boardsURL+"/"+uids["A"], nil, "If-Match", `"1"`); code != 204 {
				t.Errorf("delete A = %d", code)
			}
			if _, _, b := do(t, s, "GET", starred, nil); refUIDs(t, b) != "" {
				t.Errorf("starred after deleting A = %s, want []", b)
			}
			s.stop(t)
		})
	}
}

// startServeHooked runs serve with the audit maintenance hooks set.
func startServeHooked(t *testing.T, cfg string, env []string, every time.Duration, ran func(error)) *served {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &served{cancel: cancel, ready: make(chan string, 1), done: make(chan int, 1), stdout: &lockedBuffer{}, stderr: &lockedBuffer{}}
	go func() {
		s.done <- run(ctx, runEnv{Args: []string{"serve", "--config", cfg}, Environ: env, Stdout: s.stdout, Stderr: s.stderr,
			Listener: ln, Ready: s.ready, Assets: statictest.Default(), AssetKeys: []ed25519.PublicKey{statictest.Public(statictest.Key())},
			AuditEvery: every, AuditRetry: every, AuditRan: ran})
	}()
	t.Cleanup(func() {
		cancel()
		_ = ln.Close()
	})
	return s
}

func TestServeMaintainsAuditPartitions(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db, cfg, env := migratedDB(t, c, "")
			leaf3, _, _ := storetest.Leaf(3)
			storetest.Exec(t, db.SuperURL, "DROP TABLE public."+leaf3)
			old := storetest.CreateLeaf(t, db.OwnerURL, -15)
			ran := make(chan error, 16)
			s := startServeHooked(t, cfg, env, 0, func(err error) { ran <- err })
			s.waitReady(t)
			select {
			case err := <-ran:
				if err != nil {
					t.Fatalf("run 1: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("no maintenance run within 5 s")
			}
			if v := storetest.QueryString(t, db.SuperURL, "SELECT to_regclass('public."+leaf3+"')::text"); v == "" {
				t.Errorf("the +3 leaf was not created")
			}
			if v := storetest.QueryString(t, db.SuperURL, "SELECT to_regclass('public."+old+"')::text"); v != "" {
				t.Errorf("the 15-month leaf was not dropped")
			}
			found := false
			for _, line := range strings.Split(s.stderr.String(), "\n") {
				if strings.Contains(line, `"msg":"audit partitions"`) && strings.Contains(line, `"created":1`) && strings.Contains(line, `"dropped":1`) {
					found = true
				}
			}
			if !found {
				t.Errorf("no audit partitions record with created 1 and dropped 1; stderr %q", s.stderr.String())
			}
			s.stop(t)
		})
	}
}

func TestServeReadyzAuditPartitions(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db, cfg, env := migratedDB(t, c, "")
			ran, proceed, done := make(chan error), make(chan struct{}), make(chan struct{})
			s := startServeHooked(t, cfg, env, 100*time.Millisecond, func(err error) {
				select {
				case ran <- err:
				case <-done:
					return
				}
				select {
				case <-proceed:
				case <-done:
				}
			})
			var once sync.Once
			finish := func() { once.Do(func() { close(done) }) }
			defer finish()
			s.waitReady(t)
			leaf2, _, _ := storetest.Leaf(2)
			step := func(n int, wantErr bool, status int, state string) {
				t.Helper()
				select {
				case err := <-ran:
					if (err != nil) != wantErr {
						t.Fatalf("run %d: err %v, want error %v", n, err, wantErr)
					}
				case <-time.After(5 * time.Second):
					t.Fatalf("run %d did not happen within 5 s", n)
				}
				deadline := time.Now().Add(5 * time.Second)
				for {
					code, m := s.get(t, "/readyz")
					c, _ := m["checks"].(map[string]any)
					if code == status && c["audit_partitions"] == state {
						return
					}
					if time.Now().After(deadline) {
						t.Fatalf("run %d: /readyz %d %v, want %d audit_partitions=%s", n, code, m, status, state)
					}
					time.Sleep(20 * time.Millisecond)
				}
			}
			step(1, false, 200, "ok")
			storetest.Exec(t, db.SuperURL, "DROP TABLE public."+leaf2)
			storetest.Exec(t, db.SuperURL, "CREATE TABLE public."+leaf2+" (i int)")
			proceed <- struct{}{}
			step(2, true, 200, "low")
			proceed <- struct{}{}
			step(3, true, 200, "low")
			proceed <- struct{}{}
			step(4, true, 503, "error")
			storetest.Exec(t, db.SuperURL, "DROP TABLE public."+leaf2)
			proceed <- struct{}{}
			step(5, false, 200, "ok")
			finish()
			s.stop(t)
		})
	}
}
