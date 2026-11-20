// Package config loads the BFF configuration (T06 §4.9, T06-019).
package config

import (
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
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
}

// Postgres holds the database references.
type Postgres struct {
	AppURLRef   SecretRef `yaml:"app_url_ref"`
	OwnerURLRef SecretRef `yaml:"owner_url_ref"`
	PoolMax     int32     `yaml:"pool_max"`
}

// Datasource is the seed of the first tenant binding.
type Datasource struct {
	URL            string    `yaml:"url"`
	Slug           string    `yaml:"slug"`
	Database       string    `yaml:"database"`
	ScopeOrgID     string    `yaml:"scope_org_id"`
	CredentialsRef SecretRef `yaml:"credentials_ref"`
}

// Bootstrap is the seed of the first organisation.
type Bootstrap struct {
	OrgSlug string `yaml:"org_slug"`
	OrgName string `yaml:"org_name"`
}

// Log configures the structured logger.
type Log struct {
	Level  string `yaml:"level"`
	Format string `yaml:"format"`
}

// Duration is a time.Duration written as a Go duration string.
type Duration time.Duration

// SecretRef is a reference to a secret.
type SecretRef string

// Sources are the inputs of Load.
type Sources struct {
	ConfigPath string
	Environ    []string
	ReadFile   func(string) ([]byte, error)
}

// Command names a command whose required keys Require checks.
type Command string

// Error is a configuration error.
type Error struct {
	Key  string
	Line int
	Msg  string
}

func (e *Error) Error() string { return "config: " + e.Key + ": " + e.Msg }

// ClientVars are PULSUS_DASH_* variables read by the client tooling, accepted and ignored here.
var ClientVars = []string{"PULSUS_DASH_DEV_BFF"}

var _ = core.BootstrapSeed{}
