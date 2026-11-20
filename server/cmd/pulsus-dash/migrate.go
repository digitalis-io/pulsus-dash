package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/digitalis-io/pulsus-dash/server/internal/config"
	"github.com/digitalis-io/pulsus-dash/server/internal/store"
	"github.com/digitalis-io/pulsus-dash/server/internal/telemetry"
)

// cmdMigrate applies the embedded migrations and the first-run seed (§4.2).
func cmdMigrate(ctx context.Context, e runEnv, args []string) int {
	fs := newFlags(e, "migrate")
	path := fs.String("config", "", "configuration file")
	dryRun := fs.Bool("dry-run", false, "print what would be done and change nothing")
	if !parseFlags(e, fs, args) {
		return exitUsage
	}
	cfg, src, err := loadConfig(e, *path)
	if err != nil {
		return fail(e, exitUsage, err.Error())
	}
	if err := cfg.Require(config.CommandMigrate); err != nil {
		return fail(e, exitUsage, err.Error())
	}
	logger, err := telemetry.NewLogger(cfg.Log.Level, cfg.Log.Format, e.Stderr)
	if err != nil {
		return fail(e, exitUsage, err.Error())
	}
	ownerURL, err := cfg.ResolveRef("postgres.owner_url_ref", cfg.Postgres.OwnerURLRef, src)
	if err != nil {
		return fail(e, exitUsage, err.Error())
	}
	if cfg.Postgres.OwnerURLRef.IsInline() {
		logger.Warn("inline secret used", "key", "postgres.owner_url_ref")
	}

	res, err := store.Migrate(ctx, ownerURL, store.MigrateOptions{DryRun: *dryRun, Seed: cfg.SeedSettings, Out: e.Stdout})
	if errors.Is(err, store.ErrSeedConfig) {
		return fail(e, exitUsage, err.Error())
	}
	if err != nil {
		return fail(e, exitRuntime, err.Error())
	}

	out := func(format string, a ...any) { _, _ = fmt.Fprintf(e.Stdout, format+"\n", a...) }
	seedLine := fmt.Sprintf("organisation %q with tenant binding %q", cfg.Bootstrap.OrgSlug, cfg.Datasource.Slug)
	if *dryRun {
		for _, p := range res.Pending {
			out("pending %s", p)
		}
		if res.WouldSeed {
			out("would seed %s", seedLine)
		}
		out("dry run: nothing changed")
		return exitOK
	}
	for _, a := range res.Applied {
		out("applied %s", a)
	}
	switch latest := store.SchemaLatest(); {
	case len(res.Applied) > 0:
		out("schema at version %d", res.To)
	case res.To > latest:
		out("schema at version %d (one ahead of this binary); nothing to apply", res.To)
	default:
		out("schema at version %d; nothing to apply", res.To)
	}
	if res.Seeded {
		out("seeded %s", seedLine)
		logger.Info("seeded", "org_id", res.Org.String(), "org_slug", cfg.Bootstrap.OrgSlug)
	} else {
		out("organisation already seeded")
	}
	logger.Debug("migrate done", slog.Int64("from", res.From), slog.Int64("to", res.To), slog.Int("applied", len(res.Applied)))
	return exitOK
}
