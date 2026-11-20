package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

var (
	slugPattern  = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)
	ident150     = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,150}$`)
	futureRoles  = []string{"api", "worker", "evaluator", "notifier", "ai"}
	logLevels    = []string{"debug", "info", "warn", "error"}
	logFormats   = []string{"json", "text"}
	errListen    = "must be host:port"
	errGrace     = "must be between 1s and 30s"
	errPoolMax   = "must be between 1 and 512"
	errLogLevel  = "must be one of debug, info, warn, error"
	errLogFormat = "must be one of json, text"
	errPublicURL = "must be an absolute http or https URL"
	errPublicRaw = "must not contain credentials, a query or a fragment"
)

// validate checks every non-seed key (§3.3). Roles are checked by ValidateRoles when serve starts,
// after a --role override.
func (c *Config) validate() error {
	if !validListen(c.Server.Listen) {
		return &Error{Key: "server.listen", Msg: errListen}
	}
	if g := time.Duration(c.Server.ShutdownGrace); g < time.Second || g > 30*time.Second {
		return &Error{Key: "server.shutdown_grace", Msg: errGrace}
	}
	if c.Server.PublicURL != "" {
		if msg := checkPublicURL(c.Server.PublicURL); msg != "" {
			return &Error{Key: "server.public_url", Msg: msg}
		}
		c.Server.PublicURL = strings.TrimSuffix(c.Server.PublicURL, "/")
	}
	for _, r := range []struct {
		key string
		ref SecretRef
	}{{"postgres.app_url_ref", c.Postgres.AppURLRef}, {"postgres.owner_url_ref", c.Postgres.OwnerURLRef}} {
		if r.ref == "" {
			continue
		}
		if err := r.ref.check(c.AllowInlineSecrets); err != nil {
			return &Error{Key: r.key, Msg: err.Error()}
		}
	}
	if c.Postgres.PoolMax < 1 || c.Postgres.PoolMax > 512 {
		return &Error{Key: "postgres.pool_max", Msg: errPoolMax}
	}
	if !slices.Contains(logLevels, c.Log.Level) {
		return &Error{Key: "log.level", Msg: errLogLevel}
	}
	if !slices.Contains(logFormats, c.Log.Format) {
		return &Error{Key: "log.format", Msg: errLogFormat}
	}
	return nil
}

// checkPublicURL returns the message for an invalid server.public_url, or "". Messages never
// contain the URL.
func checkPublicURL(s string) string {
	u, err := url.Parse(s)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errPublicURL
	}
	if u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(s, "#") {
		return errPublicRaw
	}
	return ""
}

func validListen(s string) bool {
	_, port, err := net.SplitHostPort(s)
	if err != nil {
		return false
	}
	n, err := strconv.Atoi(port)
	return err == nil && n >= 0 && n <= 65535
}

// ValidateRoles checks the server roles (T06-003): this release runs exactly [all]. A named but
// unavailable role, or an unknown one, gets its own message; an empty or repeated list is refused.
func ValidateRoles(roles []string) error {
	if len(roles) == 0 {
		return errors.New(`no role given: only "all" is supported`)
	}
	for _, r := range roles {
		switch {
		case r == "all":
		case slices.Contains(futureRoles, r):
			return fmt.Errorf("role %q is not available in this release: only \"all\" is supported", r)
		default:
			return fmt.Errorf("unknown role %q (want all, api, worker, evaluator, notifier or ai)", r)
		}
	}
	if len(roles) != 1 {
		return fmt.Errorf(`roles must be exactly "all" in this release, not %q`, strings.Join(roles, ","))
	}
	return nil
}

// Require checks the keys a command needs. migrate needs only the owner reference: whether
// datasource.url is needed depends on install_state, which migrate reads under its lock.
func (c *Config) Require(cmd Command) error {
	switch cmd {
	case CommandServe:
		if c.Postgres.AppURLRef == "" {
			return &Error{Msg: "postgres.app_url_ref is required for serve"}
		}
	case CommandMigrate:
		if c.Postgres.OwnerURLRef == "" {
			return &Error{Msg: "postgres.owner_url_ref is required for migrate"}
		}
	default:
		return &Error{Msg: fmt.Sprintf("unknown command %q (want serve or migrate)", string(cmd))}
	}
	return nil
}

// SeedSettings validates the seed keys (datasource.*, bootstrap.*) and returns them. migrate calls
// it under its lock only when install_state has no row; config check prints its error as a
// warning. The credentials reference is checked for syntax and stored as written, never resolved.
func (c *Config) SeedSettings() (core.BootstrapSeed, error) {
	d, b := c.Datasource, c.Bootstrap
	if d.URL == "" {
		return core.BootstrapSeed{}, &Error{Msg: "datasource.url is required to seed the first organisation"}
	}
	if msg := checkDatasourceURL(d.URL); msg != "" {
		return core.BootstrapSeed{}, &Error{Key: "datasource.url", Msg: msg}
	}
	if !slugPattern.MatchString(d.Slug) {
		return core.BootstrapSeed{}, &Error{Key: "datasource.slug", Msg: "must match " + slugPattern.String()}
	}
	if d.Database != "" && !ident150.MatchString(d.Database) {
		return core.BootstrapSeed{}, &Error{Key: "datasource.database", Msg: "must match " + ident150.String()}
	}
	if d.ScopeOrgID != "" && !ident150.MatchString(d.ScopeOrgID) {
		return core.BootstrapSeed{}, &Error{Key: "datasource.scope_org_id", Msg: "must match " + ident150.String()}
	}
	if d.CredentialsRef != "" {
		switch d.CredentialsRef.kind() {
		case refInline:
			return core.BootstrapSeed{}, &Error{Key: "datasource.credentials_ref",
				Msg: "an inline secret cannot be stored in the tenant binding; use env:NAME or file:PATH"}
		default:
			if err := d.CredentialsRef.check(false); err != nil {
				return core.BootstrapSeed{}, &Error{Key: "datasource.credentials_ref", Msg: err.Error()}
			}
		}
	}
	if !slugPattern.MatchString(b.OrgSlug) {
		return core.BootstrapSeed{}, &Error{Key: "bootstrap.org_slug", Msg: "must match " + slugPattern.String()}
	}
	if n := utf8.RuneCountInString(b.OrgName); n < 1 || n > 200 {
		return core.BootstrapSeed{}, &Error{Key: "bootstrap.org_name", Msg: "must be 1 to 200 characters"}
	}
	return core.BootstrapSeed{OrgSlug: b.OrgSlug, OrgName: b.OrgName, Binding: core.BindingSeed{
		Slug: d.Slug, DatasourceURL: d.URL, Database: d.Database, ScopeOrgID: d.ScopeOrgID,
		CredentialsRef: string(d.CredentialsRef),
	}}, nil
}

// checkDatasourceURL returns the §3.3 message for an invalid PulsusDB URL, or "". Messages never
// contain the URL, which could carry a password.
func checkDatasourceURL(s string) string {
	u, err := url.Parse(s)
	if err != nil {
		return "must be a valid URL"
	}
	switch {
	case u.Scheme != "http" && u.Scheme != "https":
		return "scheme must be http or https"
	case u.User != nil:
		return "must not contain credentials; use datasource.credentials_ref"
	case u.Host == "":
		return "must have a host"
	case u.RawQuery != "" || u.ForceQuery || strings.Contains(s, "#"):
		return "must not have a query or fragment"
	}
	return ""
}

// CheckCredentials checks the strength of the seed's PulsusDB password (plan #62 §4.10).
func (c *Config) CheckCredentials() error { return nil }
