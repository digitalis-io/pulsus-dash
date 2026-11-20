package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
)

// lockedBuffer is a bytes.Buffer safe for concurrent writes and reads.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

type result struct {
	code           int
	stdout, stderr string
}

// runCLI runs the CLI in-process with only the given environment.
func runCLI(t *testing.T, ctx context.Context, env []string, args ...string) result {
	t.Helper()
	var out, errb lockedBuffer
	code := run(ctx, runEnv{Args: args, Environ: env, Stdout: &out, Stderr: &errb})
	return result{code, out.String(), errb.String()}
}

// writeConfig writes a YAML config into a temporary directory and returns its path.
func writeConfig(t *testing.T, yml string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "pulsus-dash.yaml")
	if err := os.WriteFile(p, []byte(yml), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestVersion(t *testing.T) {
	r := runCLI(t, context.Background(), nil, "version", "--json")
	if r.code != 0 {
		t.Fatalf("version --json exit %d, stderr %q", r.code, r.stderr)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(r.stdout), &m); err != nil {
		t.Fatalf("version --json output %q: %v", r.stdout, err)
	}
	var keys []string
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "commit,go,schema,version" {
		t.Errorf("keys = %v, want exactly commit, go, schema, version", keys)
	}
	if m["schema"] != float64(1) {
		t.Errorf("schema = %v, want 1", m["schema"])
	}
	if m["go"] != runtime.Version() {
		t.Errorf("go = %v, want %s", m["go"], runtime.Version())
	}

	r = runCLI(t, context.Background(), nil, "version")
	if r.code != 0 {
		t.Fatalf("version exit %d", r.code)
	}
	if !regexp.MustCompile(`^pulsus-dash \S+ \(commit \S+, go\S+, schema 1\)\n$`).MatchString(r.stdout) {
		t.Errorf("version output %q", r.stdout)
	}
}

func TestServeRoles(t *testing.T) {
	cfg := writeConfig(t, "postgres:\n  app_url_ref: env:PG_APP\n")
	env := []string{"PG_APP=postgres://pulsus_app@localhost:1/none"}
	for _, role := range []string{"api", "worker", "evaluator", "notifier", "ai"} {
		r := runCLI(t, context.Background(), env, "serve", "--config", cfg, "--role", role)
		want := `pulsus-dash: role "` + role + `" is not available in this release: only "all" is supported` + "\n"
		if r.code != 2 || r.stderr != want {
			t.Errorf("--role %s: exit %d stderr %q, want 2 %q", role, r.code, r.stderr, want)
		}
	}
	r := runCLI(t, context.Background(), env, "serve", "--config", cfg, "--role", "bogus")
	want := "pulsus-dash: unknown role \"bogus\" (want all, api, worker, evaluator, notifier or ai)\n"
	if r.code != 2 || r.stderr != want {
		t.Errorf("--role bogus: exit %d stderr %q, want 2 %q", r.code, r.stderr, want)
	}
	r = runCLI(t, context.Background(), append(env, "PULSUS_DASH_SERVER_ROLES=all,api"), "serve", "--config", cfg)
	want = `pulsus-dash: role "api" is not available in this release: only "all" is supported` + "\n"
	if r.code != 2 || r.stderr != want {
		t.Errorf("env roles: exit %d stderr %q, want 2 %q", r.code, r.stderr, want)
	}
}

func TestConfigCheck(t *testing.T) {
	cfg := writeConfig(t, "postgres:\n  app_url_ref: env:PG_APP\n  owner_url_ref: env:PG_OWNER\n")
	env := []string{"PG_APP=postgres://a@localhost/x", "PG_OWNER=postgres://o@localhost/x"}
	r := runCLI(t, context.Background(), env, "config", "check", "--config", cfg)
	if r.code != 0 || r.stdout != "config ok (for serve)\n" {
		t.Fatalf("exit %d stdout %q stderr %q", r.code, r.stdout, r.stderr)
	}
}

func TestConfigCheckErrors(t *testing.T) {
	r := runCLI(t, context.Background(), nil, "config", "check", "--config", writeConfig(t, "server:\n  lisen: x\n"))
	if r.code != 2 || !strings.Contains(r.stderr, `"server.lisen"`) {
		t.Errorf("unknown key: exit %d stderr %q", r.code, r.stderr)
	}

	r = runCLI(t, context.Background(), nil, "config", "check", "--for", "migrate", "--config", writeConfig(t, "log:\n  level: info\n"))
	if r.code != 2 || r.stderr != "pulsus-dash: config: postgres.owner_url_ref is required for migrate\n" {
		t.Errorf("no owner ref: exit %d stderr %q", r.code, r.stderr)
	}

	cfg := writeConfig(t, "postgres:\n  owner_url_ref: env:PG_OWNER\n")
	r = runCLI(t, context.Background(), []string{"PG_OWNER=postgres://o@localhost/x"}, "config", "check", "--for", "migrate", "--config", cfg)
	want := "warning: config: datasource.url is required to seed the first organisation (used only to seed a new database)\nconfig ok (for migrate)\n"
	if r.code != 0 || r.stdout != want {
		t.Errorf("no datasource.url: exit %d stdout %q, want 0 %q", r.code, r.stdout, want)
	}
}

func TestUsage(t *testing.T) {
	const usage = "pulsus-dash: usage: pulsus-dash <serve|migrate|config check|version> [flags]\n"
	for _, args := range [][]string{nil, {"frobnicate"}} {
		r := runCLI(t, context.Background(), nil, args...)
		if r.code != 2 || r.stderr != usage {
			t.Errorf("args %v: exit %d stderr %q, want 2 %q", args, r.code, r.stderr, usage)
		}
	}
}
