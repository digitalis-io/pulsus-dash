package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/config"
	"github.com/digitalis-io/pulsus-dash/server/internal/gateway"
	"github.com/digitalis-io/pulsus-dash/server/internal/store"
	"github.com/digitalis-io/pulsus-dash/server/internal/telemetry"
)

// startupPingTimeout bounds the first contact with Postgres.
const startupPingTimeout = 5 * time.Second

// cmdServe runs the server (§4.1). PulsusDB is never contacted (T06-026).
func cmdServe(ctx context.Context, e runEnv, args []string) int {
	fs := newFlags(e, "serve")
	path := fs.String("config", "", "configuration file")
	roleFlag := fs.String("role", "", "comma-separated roles (overrides server.roles)")
	if !parseFlags(e, fs, args) {
		return exitUsage
	}

	// 1. Configuration.
	cfg, src, err := loadConfig(e, *path)
	if err != nil {
		return fail(e, exitUsage, err.Error())
	}
	if err := cfg.Require(config.CommandServe); err != nil {
		return fail(e, exitUsage, err.Error())
	}
	// 2. Roles (T06-003).
	roles := cfg.Server.Roles
	if *roleFlag != "" {
		roles = nil
		for _, r := range strings.Split(*roleFlag, ",") {
			if r = strings.TrimSpace(r); r != "" {
				roles = append(roles, r)
			}
		}
	}
	if err := config.ValidateRoles(roles); err != nil {
		return fail(e, exitUsage, err.Error())
	}
	// 3. Logger and the app role's URL.
	logger, err := telemetry.NewLogger(cfg.Log.Level, cfg.Log.Format, e.Stderr)
	if err != nil {
		return fail(e, exitUsage, err.Error())
	}
	appURL, err := cfg.ResolveRef("postgres.app_url_ref", cfg.Postgres.AppURLRef, src)
	if err != nil {
		return fail(e, exitUsage, err.Error())
	}
	if cfg.Postgres.AppURLRef.IsInline() {
		logger.Warn("inline secret used", "key", "postgres.app_url_ref")
	}

	// 4-7. Postgres: reachable, subject to RLS, schema in the window, seeded.
	db, err := store.Open(ctx, appURL, cfg.Postgres.PoolMax)
	if errors.Is(err, store.ErrInvalidConnString) {
		// Value-free: neither the URL nor the parser's message is printed.
		return fail(e, exitUsage, "config: postgres.app_url_ref: invalid connection string")
	}
	if err != nil {
		return fail(e, exitRuntime, err.Error())
	}
	defer db.Close()
	if code, msg := checkDatabase(ctx, db); code != exitOK {
		return fail(e, code, msg)
	}

	// 8. Listen.
	ln := e.Listener
	if ln == nil {
		var lc net.ListenConfig
		if ln, err = lc.Listen(ctx, "tcp", cfg.Server.Listen); err != nil {
			return fail(e, exitRuntime, "listen: "+err.Error())
		}
	}
	srv := &http.Server{
		Handler:           gateway.New(gateway.Deps{Logger: logger, Probe: db, SchemaLatest: store.SchemaLatest()}),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}
	addr := ln.Addr().String()
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()
	logger.Info("listening", "addr", addr)
	if e.Ready != nil {
		select {
		case e.Ready <- addr:
		case <-ctx.Done():
		}
	}

	// 9. Serve until cancelled, then drain.
	select {
	case <-ctx.Done():
	case err := <-serveErr:
		return fail(e, exitRuntime, "serve: "+err.Error())
	}
	grace := time.Duration(cfg.Server.ShutdownGrace)
	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), grace)
	defer cancel()
	logger.Info("shutting down", "grace", grace.String())
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fail(e, exitRuntime, "shutdown: "+err.Error())
	}
	if err := <-serveErr; err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fail(e, exitRuntime, "serve: "+err.Error())
	}
	return exitOK
}

// checkDatabase runs start-up steps 4-7 and returns the exit code and message of the first failure.
func checkDatabase(ctx context.Context, db *store.Db) (int, string) {
	pingCtx, cancel := context.WithTimeout(ctx, startupPingTimeout)
	err := db.Ping(pingCtx)
	cancel()
	if err != nil {
		return exitRuntime, "postgres unreachable: " + err.Error()
	}
	role, bypass, err := db.RoleBypassesRLS(ctx)
	if err != nil {
		return exitRuntime, err.Error()
	}
	if bypass {
		return exitRuntime, fmt.Sprintf("postgres role %q bypasses row-level security; serve must connect as pulsus_app", role)
	}
	v, err := db.SchemaVersion(ctx)
	if err != nil {
		return exitRuntime, err.Error()
	}
	if err := store.CheckServeSchema(v, store.SchemaLatest()); err != nil {
		return exitRuntime, err.Error()
	}
	if _, err := db.InstallState(ctx); err != nil {
		return exitRuntime, err.Error()
	}
	return exitOK, ""
}
