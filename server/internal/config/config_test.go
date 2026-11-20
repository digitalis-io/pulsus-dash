package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// load runs Load over an in-memory YAML file (yml == "" means no file) and the given environment.
func load(t *testing.T, yml string, env ...string) (*Config, error) {
	t.Helper()
	src := Sources{Environ: env, ReadFile: func(string) ([]byte, error) { return []byte(yml), nil }}
	if yml != "" {
		src.ConfigPath = "pulsus-dash.yaml"
	}
	return Load(src)
}

func wantErr(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("got no error, want %q", want)
	}
	if err.Error() != want {
		t.Fatalf("error:\n got %q\nwant %q", err.Error(), want)
	}
}

func mustLoad(t *testing.T, yml string, env ...string) *Config {
	t.Helper()
	c, err := load(t, yml, env...)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c == nil {
		t.Fatal("Load returned a nil config")
	}
	return c
}

func TestUnknownYAMLKey(t *testing.T) {
	_, err := load(t, "server:\n  lisen: x\n")
	wantErr(t, err, `config: unknown key "server.lisen" (line 2)`)
	_, err = load(t, "postgress: {}\n")
	wantErr(t, err, `config: unknown key "postgress" (line 1)`)
}

func TestUnknownEnvVar(t *testing.T) {
	_, err := load(t, "", "PULSUS_DASH_SERVER_LISEN=x")
	wantErr(t, err, "config: unknown environment variable PULSUS_DASH_SERVER_LISEN")
}

func TestClientVarAccepted(t *testing.T) {
	mustLoad(t, "", "PULSUS_DASH_DEV_BFF=http://localhost:8080")
}

func TestPrecedence(t *testing.T) {
	yml := "server:\n  listen: localhost:9000\n"
	if got := mustLoad(t, yml, "PULSUS_DASH_SERVER_LISTEN=localhost:9001").Server.Listen; got != "localhost:9001" {
		t.Errorf("env over YAML: Listen = %q, want localhost:9001", got)
	}
	if got := mustLoad(t, yml).Server.Listen; got != "localhost:9000" {
		t.Errorf("YAML over default: Listen = %q, want localhost:9000", got)
	}
	if got := mustLoad(t, "").Server.Listen; got != "0.0.0.0:8080" {
		t.Errorf("default: Listen = %q, want 0.0.0.0:8080", got)
	}
}

func checkDefaults(t *testing.T, c *Config) {
	t.Helper()
	if len(c.Server.Roles) != 1 || c.Server.Roles[0] != "all" {
		t.Errorf("server.roles = %v, want [all]", c.Server.Roles)
	}
	if c.Server.ShutdownGrace != Duration(15*time.Second) {
		t.Errorf("server.shutdown_grace = %v, want 15s", time.Duration(c.Server.ShutdownGrace))
	}
	if c.Postgres.AppURLRef != "" || c.Postgres.OwnerURLRef != "" {
		t.Errorf("postgres refs = %q %q, want empty", c.Postgres.AppURLRef, c.Postgres.OwnerURLRef)
	}
	if c.Postgres.PoolMax != 32 {
		t.Errorf("postgres.pool_max = %d, want 32", c.Postgres.PoolMax)
	}
	d := c.Datasource
	if d.URL != "" || d.Slug != "default" || d.Database != "" || d.ScopeOrgID != "" || d.CredentialsRef != "" {
		t.Errorf("datasource = %+v, want url \"\", slug default, rest empty", d)
	}
	if c.Bootstrap.OrgSlug != "default" || c.Bootstrap.OrgName != "Default organisation" {
		t.Errorf("bootstrap = %+v", c.Bootstrap)
	}
	if c.Log.Level != "info" || c.Log.Format != "json" {
		t.Errorf("log = %+v, want info/json", c.Log)
	}
	if c.AllowInlineSecrets {
		t.Error("allow_inline_secrets = true, want false")
	}
}

func TestDefaults(t *testing.T) {
	c := mustLoad(t, "")
	if c.Server.Listen != "0.0.0.0:8080" {
		t.Errorf("server.listen = %q, want 0.0.0.0:8080", c.Server.Listen)
	}
	checkDefaults(t, c)
}

func TestTypeErrors(t *testing.T) {
	_, err := load(t, "server:\n  listen: [1]\n")
	wantErr(t, err, "config: server.listen: must be a string (line 2)")
	_, err = load(t, "server: 3\n")
	wantErr(t, err, "config: server: must be a mapping (line 1)")
	_, err = load(t, "", "PULSUS_DASH_POSTGRES_POOL_MAX=x")
	wantErr(t, err, "config: PULSUS_DASH_POSTGRES_POOL_MAX: must be an integer")
}

func TestValidation(t *testing.T) {
	cases := []struct {
		name, yml string
		env       []string
		want      string
	}{
		{"listen", "server:\n  listen: nope\n", nil, "config: server.listen: must be host:port"},
		{"grace low", "server:\n  shutdown_grace: 500ms\n", nil, "config: server.shutdown_grace: must be between 1s and 30s"},
		{"grace high", "server:\n  shutdown_grace: 31s\n", nil, "config: server.shutdown_grace: must be between 1s and 30s"},
		{"app ref", "postgres:\n  app_url_ref: env:1X\n", nil, "config: postgres.app_url_ref: must be env:NAME or file:/absolute/path"},
		{"owner ref", "postgres:\n  owner_url_ref: file:relative\n", nil, "config: postgres.owner_url_ref: must be env:NAME or file:/absolute/path"},
		{"pool low", "postgres:\n  pool_max: 0\n", nil, "config: postgres.pool_max: must be between 1 and 512"},
		{"pool high", "postgres:\n  pool_max: 513\n", nil, "config: postgres.pool_max: must be between 1 and 512"},
		{"log level", "log:\n  level: loud\n", nil, "config: log.level: must be one of debug, info, warn, error"},
		{"log format", "log:\n  format: xml\n", nil, "config: log.format: must be one of json, text"},
		{"inline bool", "", []string{"PULSUS_DASH_ALLOW_INLINE_SECRETS=maybe"}, "config: PULSUS_DASH_ALLOW_INLINE_SECRETS: must be true or false"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := load(t, tc.yml, tc.env...)
			wantErr(t, err, tc.want)
		})
	}
	// Seed keys are checked only by SeedSettings: Load accepts invalid values.
	for _, yml := range []string{
		"datasource:\n  url: ftp://x\n",
		"datasource:\n  scope_org_id: \"a b\"\n",
		"bootstrap:\n  org_slug: Bad\n",
		"datasource:\n  credentials_ref: env:1X\n",
		"datasource:\n  credentials_ref: u:p\n",
	} {
		if _, err := load(t, yml); err != nil {
			t.Errorf("Load(%q) = %v, want success (seed keys are not value-checked by Load)", yml, err)
		}
	}
}

func TestInlineSecret(t *testing.T) {
	const refusal = "config: postgres.app_url_ref: inline secrets are refused; use env:NAME or file:PATH (or set allow_inline_secrets: true for development)"
	_, err := load(t, "postgres:\n  app_url_ref: \"postgres://u:hunter2@h/db\"\n")
	wantErr(t, err, refusal)
	if strings.Contains(err.Error(), "hunter2") {
		t.Fatal("error contains the literal secret")
	}
	_, err = SecretRef("postgres://u:hunter2@h/db").Resolve(Sources{}, false)
	if err == nil || strings.Contains(err.Error(), "hunter2") {
		t.Fatalf("Resolve without allow: err = %v, want a refusal without the secret", err)
	}
	c := mustLoad(t, "allow_inline_secrets: true\npostgres:\n  app_url_ref: \"postgres://u:hunter2@h/db\"\n")
	v, err := c.Postgres.AppURLRef.Resolve(Sources{}, c.AllowInlineSecrets)
	if err != nil || v != "postgres://u:hunter2@h/db" {
		t.Fatalf("Resolve with allow = %q, %v; want the literal", v, err)
	}
}

func TestSecretRefEnvFile(t *testing.T) {
	dir := t.TempDir()
	small := filepath.Join(dir, "small")
	big := filepath.Join(dir, "big")
	if err := os.WriteFile(small, []byte("v\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(big, make([]byte, 65*1024), 0o600); err != nil {
		t.Fatal(err)
	}
	src := Sources{Environ: []string{"PG_URL=v"}}

	got, err := SecretRef("env:PG_URL").Resolve(src, false)
	if err != nil || got != "v" {
		t.Errorf("env set: %q, %v", got, err)
	}
	c := mustLoad(t, "postgres:\n  app_url_ref: env:PG_URL\n")
	_, err = c.ResolveRef("postgres.app_url_ref", c.Postgres.AppURLRef, Sources{})
	wantErr(t, err, "config: postgres.app_url_ref: environment variable PG_URL is not set")

	got, err = SecretRef("file:"+small).Resolve(Sources{}, false)
	if err != nil || got != "v" {
		t.Errorf("file: %q, %v", got, err)
	}
	_, err = SecretRef("file:"+filepath.Join(dir, "missing")).Resolve(Sources{}, false)
	if err == nil || !strings.Contains(err.Error(), "cannot read file "+filepath.Join(dir, "missing")) {
		t.Errorf("missing file: %v", err)
	}
	_, err = SecretRef("file:"+big).Resolve(Sources{}, false)
	if err == nil || !strings.Contains(err.Error(), "larger than 64 KiB") {
		t.Errorf("big file: %v", err)
	}
	_, err = SecretRef("vault://x").Resolve(Sources{}, false)
	if err == nil || err.Error() != "vault references are not supported in this release" {
		t.Errorf("vault: %v", err)
	}
	_, err = SecretRef("env:1X").Resolve(src, false)
	if err == nil || err.Error() != "must be env:NAME or file:/absolute/path" {
		t.Errorf("env:1X: %v", err)
	}
}

func TestSeedSettings(t *testing.T) {
	const valid = "datasource:\n  url: http://localhost:3100\n"
	cases := []struct{ name, yml, want string }{
		{"no url", "", "config: datasource.url is required to seed the first organisation"},
		{"scheme", "datasource:\n  url: ftp://x\n", "config: datasource.url: scheme must be http or https"},
		{"credentials", "datasource:\n  url: https://u:hunter2@h\n", "config: datasource.url: must not contain credentials; use datasource.credentials_ref"},
		{"host", "datasource:\n  url: \"http:///x\"\n", "config: datasource.url: must have a host"},
		{"query", "datasource:\n  url: http://h/?a=1\n", "config: datasource.url: must not have a query or fragment"},
		{"fragment", "datasource:\n  url: http://h/#f\n", "config: datasource.url: must not have a query or fragment"},
		{"slug", valid + "  slug: Bad\n", "config: datasource.slug: must match ^[a-z0-9-]{1,40}$"},
		{"database", valid + "  database: \"a b\"\n", "config: datasource.database: must match ^[A-Za-z0-9_.-]{1,150}$"},
		{"scope", valid + "  scope_org_id: \"a b\"\n", "config: datasource.scope_org_id: must match ^[A-Za-z0-9_.-]{1,150}$"},
		{"inline creds", "allow_inline_secrets: true\n" + valid + "  credentials_ref: u:p\n", "config: datasource.credentials_ref: an inline secret cannot be stored in the tenant binding; use env:NAME or file:PATH"},
		{"env syntax", valid + "  credentials_ref: env:1X\n", "config: datasource.credentials_ref: must be env:NAME or file:/absolute/path"},
		{"file syntax", valid + "  credentials_ref: file:rel\n", "config: datasource.credentials_ref: must be env:NAME or file:/absolute/path"},
		{"org slug", valid + "bootstrap:\n  org_slug: Bad\n", "config: bootstrap.org_slug: must match ^[a-z0-9-]{1,40}$"},
		{"org name", valid + "bootstrap:\n  org_name: \"\"\n", "config: bootstrap.org_name: must be 1 to 200 characters"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := mustLoad(t, tc.yml)
			_, err := c.SeedSettings()
			wantErr(t, err, tc.want)
			if strings.Contains(err.Error(), "hunter2") {
				t.Fatal("error contains the URL password")
			}
		})
	}
	// Valid: the reference is returned as written; the environment is never read.
	c := mustLoad(t, valid+"  database: db1\n  scope_org_id: tenant-1\n  credentials_ref: env:PDB_CREDS\n")
	seed, err := c.SeedSettings()
	if err != nil {
		t.Fatalf("SeedSettings: %v", err)
	}
	want := "env:PDB_CREDS"
	if seed.Binding.CredentialsRef != want || seed.Binding.DatasourceURL != "http://localhost:3100" ||
		seed.Binding.Slug != "default" || seed.Binding.Database != "db1" || seed.Binding.ScopeOrgID != "tenant-1" ||
		seed.OrgSlug != "default" || seed.OrgName != "Default organisation" {
		t.Fatalf("seed = %+v", seed)
	}
}

func TestRequire(t *testing.T) {
	a := mustLoad(t, "postgres:\n  app_url_ref: env:A\n")
	if err := a.Require("serve"); err != nil {
		t.Errorf("(a) serve: %v", err)
	}
	wantErr(t, a.Require("migrate"), "config: postgres.owner_url_ref is required for migrate")

	b := mustLoad(t, "")
	wantErr(t, b.Require("serve"), "config: postgres.app_url_ref is required for serve")

	c := mustLoad(t, "postgres:\n  owner_url_ref: env:O\n")
	if err := c.Require("migrate"); err != nil {
		t.Errorf("(c) migrate: %v", err)
	}

	d := mustLoad(t, "postgres:\n  owner_url_ref: env:O\ndatasource:\n  url: http://localhost:3100\n")
	if err := d.Require("migrate"); err != nil {
		t.Errorf("(d) migrate: %v", err)
	}
	wantErr(t, d.Require("serve"), "config: postgres.app_url_ref is required for serve")
}

func TestYAMLPasses(t *testing.T) {
	_, err := load(t, "datasource:\n  url: http://x\n  creds: y\n")
	wantErr(t, err, `config: unknown key "datasource.creds" (line 3)`)
	_, err = load(t, "server:\n  listen: a\n  listen: b\n")
	wantErr(t, err, `config: duplicate key "server.listen" (line 3)`)
	_, err = load(t, "a: 1\n---\nb: 2\n")
	wantErr(t, err, "config: the file must contain one YAML document")

	c := mustLoad(t, "server:\n  listen: \"localhost:1\"\n")
	if c.Server.Listen != "localhost:1" {
		t.Errorf("Listen = %q, want localhost:1", c.Server.Listen)
	}
	checkDefaults(t, c)
}

func TestValidateRoles(t *testing.T) {
	if err := ValidateRoles([]string{"all"}); err != nil {
		t.Errorf("[all]: %v", err)
	}
	for _, r := range []string{"api", "worker", "evaluator", "notifier", "ai"} {
		err := ValidateRoles([]string{r})
		wantErr(t, err, `role "`+r+`" is not available in this release: only "all" is supported`)
	}
	wantErr(t, ValidateRoles([]string{"bogus"}), `unknown role "bogus" (want all, api, worker, evaluator, notifier or ai)`)
}
