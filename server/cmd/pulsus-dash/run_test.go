package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"

	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/static/statictest"
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
	if m["schema"] != float64(3) {
		t.Errorf("schema = %v, want 3", m["schema"])
	}
	if m["go"] != runtime.Version() {
		t.Errorf("go = %v, want %s", m["go"], runtime.Version())
	}

	r = runCLI(t, context.Background(), nil, "version")
	if r.code != 0 {
		t.Fatalf("version exit %d", r.code)
	}
	if !regexp.MustCompile(`^pulsus-dash \S+ \(commit \S+, go\S+, schema 3\)\n$`).MatchString(r.stdout) {
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
	for _, tc := range []struct{ roleEnv, want string }{
		{"PULSUS_DASH_SERVER_ROLES=all,all", `pulsus-dash: roles must be exactly "all" in this release, not "all,all"` + "\n"},
		{"PULSUS_DASH_SERVER_ROLES=", `pulsus-dash: no role given: only "all" is supported` + "\n"},
	} {
		r := runCLI(t, context.Background(), append(env, tc.roleEnv), "serve", "--config", cfg)
		if r.code != 2 || r.stderr != tc.want {
			t.Errorf("%s: exit %d stderr %q, want 2 %q", tc.roleEnv, r.code, r.stderr, tc.want)
		}
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

// unit:credential-strength (config check half, §4.10).
func TestConfigCheckCredentialStrength(t *testing.T) {
	cfg := writeConfig(t, "postgres:\n  app_url_ref: env:PG_APP\n  owner_url_ref: env:PG_OWNER\n"+
		"datasource:\n  url: http://localhost:9\n  credentials_ref: env:PW\n")
	env := []string{"PG_APP=postgres://a@localhost/x", "PG_OWNER=postgres://o@localhost/x"}
	const msg = "config: datasource.credentials_ref: the PulsusDB password must be at least 8 characters and must not be a number"
	for _, pw := range []string{"u:1234567", "u:-1234567", "u:  12345678  ", ":abcdefgh"} {
		r := runCLI(t, context.Background(), append(env, "PW="+pw), "config", "check", "--config", cfg)
		if r.code != 2 || r.stderr != "pulsus-dash: "+msg+"\n" {
			t.Errorf("serve, %q: exit %d stderr %q", pw, r.code, r.stderr)
		}
		r = runCLI(t, context.Background(), append(env, "PW="+pw), "config", "check", "--for", "migrate", "--config", cfg)
		if r.code != 0 || r.stdout != "warning: "+msg+" (used only to seed a new database)\nconfig ok (for migrate)\n" {
			t.Errorf("migrate, %q: exit %d stdout %q", pw, r.code, r.stdout)
		}
	}
	for _, e := range [][]string{append(env, "PW=u:abcd1234"), env} {
		if r := runCLI(t, context.Background(), e, "config", "check", "--config", cfg); r.code != 0 {
			t.Errorf("strong or unset: exit %d stderr %q", r.code, r.stderr)
		}
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

// TestConnStringNeverPrinted: a Postgres URL that does not parse, or that points nowhere, is never
// echoed (review r1 #1). Each value carries a marker in the position of the password.
func TestConnStringNeverPrinted(t *testing.T) {
	const marker = "MARKERz9q"
	malformed := []string{
		"postgres://u:" + marker + "@h:notaport/db",
		"postgres://u:" + marker + "@[::1/db",
		"host=h password=" + marker + " port=notaport",
		marker + " is not a connection string",
	}
	unreachable := []string{
		"postgres://u:" + marker + "@127.0.0.1:1/db?connect_timeout=2",
		"host=127.0.0.1 port=1 user=u password=" + marker + " dbname=d connect_timeout=2",
	}
	type cmd struct{ name, key string }
	for _, c := range []cmd{{"serve", "app_url_ref"}, {"migrate", "owner_url_ref"}} {
		for _, inline := range []bool{false, true} {
			check := func(value string, wantCode int, wantSuffix string) {
				t.Helper()
				yml := "postgres:\n  " + c.key + ": env:PG_URL\n"
				env := []string{"PG_URL=" + value}
				if inline {
					yml = "allow_inline_secrets: true\npostgres:\n  " + c.key + ": " + strconv.Quote(value) + "\n"
					env = nil
				}
				args := []string{c.name, "--config", writeConfig(t, yml+seedYAMLUnit)}
				if c.name == "serve" {
					args = append(args, "--api-only") // reach Postgres without embedded assets
				}
				r := runCLI(t, context.Background(), env, args...)
				if strings.Contains(r.stderr+r.stdout, marker) {
					t.Errorf("%s inline=%v %q: output contains the value: %q", c.name, inline, value, r.stderr)
				}
				if r.code != wantCode || !strings.HasSuffix(r.stderr, wantSuffix) {
					t.Errorf("%s inline=%v %q: exit %d stderr %q, want %d ending %q", c.name, inline, value, r.code, r.stderr, wantCode, wantSuffix)
				}
			}
			for _, v := range malformed {
				check(v, 2, "pulsus-dash: config: postgres."+c.key+": invalid connection string\n")
			}
			for _, v := range unreachable {
				check(v, 1, "\n")
			}
		}
	}
}

const seedYAMLUnit = "datasource:\n  url: http://localhost:9\n"

// serveUnit runs serve in-process with a Ready channel and returns the result and whether Ready
// ever received.
func serveUnit(t *testing.T, e runEnv) (result, bool) {
	t.Helper()
	var out, errb lockedBuffer
	ready := make(chan string, 1)
	e.Stdout, e.Stderr, e.Ready = &out, &errb, ready
	code := run(context.Background(), e)
	select {
	case <-ready:
		return result{code, out.String(), errb.String()}, true
	default:
		return result{code, out.String(), errb.String()}, false
	}
}

// unreachablePG points serve at a port where nothing listens; asset checks run before Postgres.
var unreachablePG = []string{
	"PULSUS_DASH_POSTGRES_APP_URL_REF=env:PG_APP_URL",
	"PG_APP_URL=postgres://pulsus_app@localhost:1/x?sslmode=disable",
}

// S1
func TestServeRefusesAlteredAssets(t *testing.T) {
	fsys := statictest.Default()
	b := bytes.Clone(statictest.AppJS)
	b[0] ^= 1
	fsys["assets/app.js"] = &fstest.MapFile{Data: b}
	r, ready := serveUnit(t, runEnv{Args: []string{"serve"}, Environ: unreachablePG, Assets: fsys,
		AssetKeys: []ed25519.PublicKey{statictest.Public(statictest.Key())}})
	want := "pulsus-dash: asset integrity check failed: hash_mismatch assets/app.js\n"
	if r.code != 1 || !strings.HasSuffix(r.stderr, want) {
		t.Errorf("exit %d stderr %q, want 1 ending %q", r.code, r.stderr, want)
	}
	if !strings.Contains(r.stderr, "asset_integrity_failed") {
		t.Errorf("no asset_integrity_failed record in %q", r.stderr)
	}
	if ready {
		t.Error("Ready received: a listener opened")
	}
}

// S2
func TestServeRefusesWithoutAssets(t *testing.T) {
	r, ready := serveUnit(t, runEnv{Args: []string{"serve"}, Environ: unreachablePG})
	want := "pulsus-dash: no embedded client assets: this binary was built without -tags embedassets; use make build, or serve --api-only for development\n"
	if r.code != 1 || r.stderr != want {
		t.Errorf("exit %d stderr %q, want 1 %q", r.code, r.stderr, want)
	}
	if ready {
		t.Error("Ready received: a listener opened")
	}
}
