// Package config loads the BFF configuration (T06 §4.9, T06-019): defaults, then one YAML file,
// then PULSUS_DASH_* environment variables. Unknown keys and variables are errors. Secrets are
// given as references (T19-010) and resolved only by the command that needs them.
package config

import (
	"fmt"
	"strconv"
	"time"

	"go.yaml.in/yaml/v3"
)

// Config is the whole configuration.
type Config struct {
	Server             Server     `yaml:"server"`
	Postgres           Postgres   `yaml:"postgres"`
	Datasource         Datasource `yaml:"datasource"`
	Bootstrap          Bootstrap  `yaml:"bootstrap"`
	Log                Log        `yaml:"log"`
	AllowInlineSecrets bool       `yaml:"allow_inline_secrets"`
}

// Server holds process settings.
type Server struct {
	Roles         []string `yaml:"roles"`
	Listen        string   `yaml:"listen"`
	ShutdownGrace Duration `yaml:"shutdown_grace"`
	// PublicURL is the externally visible base URL for the start-up self-check (T19-002); ""
	// disables the check.
	PublicURL string `yaml:"public_url"`
}

// Postgres holds the database references.
type Postgres struct {
	AppURLRef   SecretRef `yaml:"app_url_ref"`
	OwnerURLRef SecretRef `yaml:"owner_url_ref"`
	PoolMax     int32     `yaml:"pool_max"`
}

// Datasource is the seed of the first tenant binding. Its values are checked only by
// SeedSettings, and read only when migrate seeds an empty database; afterwards the binding in
// Postgres is authoritative.
type Datasource struct {
	URL            string    `yaml:"url"`
	Slug           string    `yaml:"slug"`
	Database       string    `yaml:"database"`
	ScopeOrgID     string    `yaml:"scope_org_id"`
	CredentialsRef SecretRef `yaml:"credentials_ref"`
}

// Bootstrap is the seed of the first organisation (checked and read like Datasource).
type Bootstrap struct {
	OrgSlug string `yaml:"org_slug"`
	OrgName string `yaml:"org_name"`
}

// Log configures the structured logger.
type Log struct {
	Level  string `yaml:"level"`
	Format string `yaml:"format"`
}

// Duration is a time.Duration written as a Go duration string ("15s"), in YAML and in env.
type Duration time.Duration

// UnmarshalYAML parses a duration string.
func (d *Duration) UnmarshalYAML(n *yaml.Node) error {
	v, err := time.ParseDuration(n.Value)
	if err != nil {
		return fmt.Errorf("line %d: cannot parse %s as a duration", n.Line, strconv.Quote(n.Value))
	}
	*d = Duration(v)
	return nil
}

// SecretRef is a reference to a secret: env:NAME, file:/absolute/path, or (refused unless
// allow_inline_secrets) a literal value.
type SecretRef string

// Sources are the inputs of Load and Resolve. ConfigPath "" means no file; ReadFile nil means the
// operating system's files.
type Sources struct {
	ConfigPath string
	Environ    []string
	ReadFile   func(string) ([]byte, error)
}

// Command names a command whose required keys Require checks.
type Command string

// The commands with required keys.
const (
	CommandServe   Command = "serve"
	CommandMigrate Command = "migrate"
)

// Error is a configuration error: "config: <Key>: <Msg>", or "config: <Msg>" without a key, with
// " (line N)" when the YAML line is known. No message contains a secret value.
type Error struct {
	Key  string
	Line int
	Msg  string
}

func (e *Error) Error() string {
	s := "config: "
	if e.Key != "" {
		s += e.Key + ": "
	}
	s += e.Msg
	if e.Line > 0 {
		s += fmt.Sprintf(" (line %d)", e.Line)
	}
	return s
}

// ClientVars are PULSUS_DASH_* variables read by the client tooling, accepted and ignored here.
var ClientVars = []string{"PULSUS_DASH_DEV_BFF"}

// defaults returns the configuration before any file or variable is applied (§3.3).
func defaults() *Config {
	return &Config{
		Server:     Server{Roles: []string{"all"}, Listen: "0.0.0.0:8080", ShutdownGrace: Duration(15 * time.Second)},
		Postgres:   Postgres{PoolMax: 32},
		Datasource: Datasource{Slug: "default"},
		Bootstrap:  Bootstrap{OrgSlug: "default", OrgName: "Default organisation"},
		Log:        Log{Level: "info", Format: "json"},
	}
}
