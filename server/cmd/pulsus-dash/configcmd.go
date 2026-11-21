package main

import (
	"fmt"

	"github.com/digitalis-io/pulsus-dash/server/internal/config"
)

// cmdConfigCheck validates the configuration for a command without connecting to Postgres or
// PulsusDB: Load, Require, the roles and the PulsusDB credential strength (for serve, when the
// reference resolves), and Resolve of every set Postgres reference.
// With --for migrate, seed-setting errors are printed as warnings: they matter only when
// migrate seeds an empty database.
func cmdConfigCheck(e runEnv, args []string) int {
	fs := newFlags(e, "config check")
	path := fs.String("config", "", "configuration file")
	forCmd := fs.String("for", string(config.CommandServe), "command to check for: serve or migrate")
	if !parseFlags(e, fs, args) {
		return exitUsage
	}
	cmd := config.Command(*forCmd)
	if cmd != config.CommandServe && cmd != config.CommandMigrate {
		return fail(e, exitUsage, fmt.Sprintf("--for must be serve or migrate, not %q", *forCmd))
	}
	cfg, src, err := loadConfig(e, *path)
	if err != nil {
		return fail(e, exitUsage, err.Error())
	}
	if err := cfg.Require(cmd); err != nil {
		return fail(e, exitUsage, err.Error())
	}
	if cmd == config.CommandServe {
		if err := config.ValidateRoles(cfg.Server.Roles); err != nil {
			return fail(e, exitUsage, err.Error())
		}
		if err := cfg.CheckCredentials(); err != nil {
			return fail(e, exitUsage, err.Error())
		}
	}
	for _, r := range []struct {
		key string
		ref config.SecretRef
	}{{"postgres.app_url_ref", cfg.Postgres.AppURLRef}, {"postgres.owner_url_ref", cfg.Postgres.OwnerURLRef}} {
		if r.ref == "" {
			continue
		}
		if _, err := cfg.ResolveRef(r.key, r.ref, src); err != nil {
			return fail(e, exitUsage, err.Error())
		}
	}
	if cmd == config.CommandMigrate {
		if _, err := cfg.SeedSettings(); err != nil {
			_, _ = fmt.Fprintf(e.Stdout, "warning: %s (used only to seed a new database)\n", err)
		}
	}
	_, _ = fmt.Fprintf(e.Stdout, "config ok (for %s)\n", cmd)
	return exitOK
}
