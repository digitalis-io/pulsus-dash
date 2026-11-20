//go:build itest

package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

// served is a serve process running in-process on a loopback listener.
type served struct {
	cancel         context.CancelFunc
	ready          chan string
	done           chan int
	addr           string
	stdout, stderr *lockedBuffer
}

func startServe(t *testing.T, cfg string, env []string) *served {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &served{cancel: cancel, ready: make(chan string, 1), done: make(chan int, 1), stdout: &lockedBuffer{}, stderr: &lockedBuffer{}}
	go func() {
		s.done <- run(ctx, runEnv{Args: []string{"serve", "--config", cfg}, Environ: env,
			Stdout: s.stdout, Stderr: s.stderr, Listener: ln, Ready: s.ready})
	}()
	t.Cleanup(func() {
		cancel()
		_ = ln.Close()
	})
	return s
}

func (s *served) waitReady(t *testing.T) {
	t.Helper()
	select {
	case s.addr = <-s.ready:
	case code := <-s.done:
		s.done <- code
		t.Fatalf("serve exited %d before Ready; stderr %q", code, s.stderr.String())
	case <-time.After(30 * time.Second):
		t.Fatal("serve not ready after 30s")
	}
}

// exit waits for serve to exit by itself.
func (s *served) exit(t *testing.T) int {
	t.Helper()
	select {
	case code := <-s.done:
		select {
		case <-s.ready:
			t.Error("serve sent Ready before failing")
		default:
		}
		return code
	case <-time.After(30 * time.Second):
		t.Fatal("serve still running after 30s")
		return -1
	}
}

func (s *served) stop(t *testing.T) {
	t.Helper()
	s.cancel()
	select {
	case code := <-s.done:
		if code != 0 {
			t.Errorf("serve exit %d after cancel; stderr %q", code, s.stderr.String())
		}
	case <-time.After(20 * time.Second):
		t.Fatal("serve did not stop")
	}
}

func (s *served) get(t *testing.T, path string) (int, map[string]any) {
	t.Helper()
	c := http.Client{Timeout: 5 * time.Second}
	resp, err := c.Get("http://" + s.addr + path)
	if err != nil {
		t.Fatalf("GET %s: %v", path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("GET %s body %q: %v", path, b, err)
	}
	return resp.StatusCode, m
}

func checks(m map[string]any) string {
	c, _ := m["checks"].(map[string]any)
	return m["status"].(string) + " postgres=" + c["postgres"].(string) + " schema=" + c["schema"].(string)
}

// migratedDB returns a migrated, seeded database and a config for it.
func migratedDB(t *testing.T, c storetest.Cluster, extra string) (*storetest.TestDB, string, []string) {
	t.Helper()
	db := storetest.NewDB(t, c)
	cfg, env := dbConfig(t, db, seedYAML+extra)
	if r := migrateCLI(t, cfg, env); r.code != 0 {
		t.Fatalf("migrate: exit %d stderr %q", r.code, r.stderr)
	}
	return db, cfg, env
}

func TestServeRefusesOlderSchema(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db := storetest.NewDB(t, c)
			cfg, env := dbConfig(t, db, "")
			s := startServe(t, cfg, env)
			want := "pulsus-dash: database schema version 0 is older than this binary requires (1); run pulsus-dash migrate\n"
			if code := s.exit(t); code != 1 || !strings.HasSuffix(s.stderr.String(), want) {
				t.Errorf("exit %d stderr %q, want 1 ending %q", code, s.stderr.String(), want)
			}
		})
	}
}

func TestServeRefusesBypassRole(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db, cfg, _ := migratedDB(t, c, "")
			s := startServe(t, cfg, []string{"PG_OWNER=" + db.OwnerURL, "PG_APP=" + db.SuperURL})
			want := "pulsus-dash: postgres role \"postgres\" bypasses row-level security; serve must connect as pulsus_app\n"
			if code := s.exit(t); code != 1 || !strings.HasSuffix(s.stderr.String(), want) {
				t.Errorf("exit %d stderr %q, want 1 ending %q", code, s.stderr.String(), want)
			}
		})
	}
}

func TestReadyzIgnoresPulsusDB(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			_, cfg, env := migratedDB(t, c, "")
			s := startServe(t, cfg, env)
			s.waitReady(t)
			if code, m := s.get(t, "/readyz"); code != 200 || checks(m) != "ready postgres=ok schema=ok" {
				t.Errorf("/readyz %d %v", code, m)
			}
			if code, _ := s.get(t, "/healthz"); code != 200 {
				t.Errorf("/healthz %d", code)
			}
			s.stop(t)
		})
	}
}

func TestReadyzPostgresStopped(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db, cfg, _ := migratedDB(t, c, "")
			proxied, stop := storetest.NewProxy(t, db.AppURL)
			s := startServe(t, cfg, []string{"PG_OWNER=" + db.OwnerURL, "PG_APP=" + proxied})
			s.waitReady(t)
			stop()
			deadline := time.Now().Add(3 * time.Second)
			for {
				code, m := s.get(t, "/readyz")
				if code == 503 && checks(m) == "not_ready postgres=unreachable schema=unknown" {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("/readyz still %d %v after 3s", code, m)
				}
				time.Sleep(100 * time.Millisecond)
			}
			if code, _ := s.get(t, "/healthz"); code != 200 {
				t.Errorf("/healthz %d with Postgres stopped", code)
			}
			s.stop(t)
		})
	}
}

func TestServeRefusesUnseeded(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			db, cfg, env := migratedDB(t, c, "")
			storetest.Exec(t, db.SuperURL, "DELETE FROM install_state")
			s := startServe(t, cfg, env)
			want := "pulsus-dash: database is not initialised; run pulsus-dash migrate\n"
			if code := s.exit(t); code != 1 || !strings.HasSuffix(s.stderr.String(), want) {
				t.Errorf("exit %d stderr %q, want 1 ending %q", code, s.stderr.String(), want)
			}
		})
	}
}

func TestServeGracefulShutdown(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			_, cfg, env := migratedDB(t, c, "")
			s := startServe(t, cfg, env)
			s.waitReady(t)
			start := time.Now()
			s.stop(t)
			if d := time.Since(start); d >= 15*time.Second {
				t.Errorf("shutdown took %v, want < shutdown_grace (15s)", d)
			}
		})
	}
}
