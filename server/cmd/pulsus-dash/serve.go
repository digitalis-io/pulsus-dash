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

	"github.com/digitalis-io/pulsus-dash/server/internal/annotations"
	"github.com/digitalis-io/pulsus-dash/server/internal/boards"
	"github.com/digitalis-io/pulsus-dash/server/internal/config"
	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/gateway"
	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/static"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	"github.com/digitalis-io/pulsus-dash/server/internal/store"
	"github.com/digitalis-io/pulsus-dash/server/internal/telemetry"
)

// startupPingTimeout bounds the first contact with Postgres.
const startupPingTimeout = 5 * time.Second

// cmdServe runs the server (§4.1). PulsusDB is contacted only by the data routes, never at
// start-up or by readiness (T06-026).
func cmdServe(ctx context.Context, e runEnv, args []string) int {
	fs := newFlags(e, "serve")
	path := fs.String("config", "", "configuration file")
	roleFlag := fs.String("role", "", "comma-separated roles (overrides server.roles)")
	apiOnly := fs.Bool("api-only", false, "development only: serve the API and no client assets")
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
	// 3b. The client assets, verified before Postgres is contacted or a listener opens (ADR-0016).
	set, code, msg := loadAssets(e, logger, *apiOnly)
	if code != exitOK {
		return fail(e, code, msg)
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
	install, code, msg := checkDatabase(ctx, db)
	if code != exitOK {
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
	// The PulsusDB client (T06-005): the binding's credentials reference is resolved per request
	// in this process's environment; inline references are never accepted in a binding.
	pdb := pulsusdb.New(pulsusdb.Options{
		TenantConcurrency: int(cfg.Pulsusdb.TenantConcurrency), Logger: logger, Now: time.Now,
		Secrets: func(ref string) (string, error) {
			return config.SecretRef(ref).Resolve(config.Sources{Environ: e.Environ}, false)
		},
	})
	partitions := &core.PartitionState{}
	srv := &http.Server{
		Handler: gateway.New(gateway.Deps{
			Logger: logger, Probe: db, SchemaLatest: store.SchemaLatest(),
			Assets: set, Build: core.Build(store.SchemaLatest()), Bootstrap: db.BootstrapView,
			Now: time.Now, PulsusDB: pdb,
			Boards: boards.New(db, logger), Annotations: annotations.New(db), Org: install.BootstrapOrg, AuditPartitions: partitions,
		}),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}
	addr := ln.Addr().String()
	serveErr := make(chan error, 1)
	go func() { serveErr <- srv.Serve(ln) }()
	logger.Info("listening", "addr", addr)
	// 8a. Audit partitions (plan #61 §4.4): now, then every 24 h (1 h after a failure).
	maintCtx, stopMaint := context.WithCancel(ctx)
	maintDone := make(chan struct{})
	go func() {
		defer close(maintDone)
		maintainAuditPartitions(maintCtx, db, logger, partitions, e.AuditEvery, e.AuditRetry, e.AuditRan)
	}()
	defer func() {
		stopMaint()
		<-maintDone
	}()
	// 8b. The public-URL self-check (T19-002): one request, never fatal, cancelled with ctx.
	if cfg.Server.PublicURL != "" {
		go gateway.SelfCheck(ctx, cfg.Server.PublicURL, set != nil, selfCheckClient(), logger)
	}
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

// selfCheckClient is the public-URL self-check's client: a 2 s budget and no redirects.
func selfCheckClient() *http.Client {
	return &http.Client{
		Timeout:       2 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

// errNoAssets is the refusal of a binary built without -tags embedassets (plan #59 §3.3).
const errNoAssets = "no embedded client assets: this binary was built without -tags embedassets; use make build, or serve --api-only for development"

// loadAssets is start-up step 3b. It returns the verified set, or nil with --api-only, or the
// exit code and message of the refusal.
func loadAssets(e runEnv, logger *slog.Logger, apiOnly bool) (*static.Set, int, string) {
	if apiOnly {
		logger.Warn("serving the API only (development); no client assets are served")
		return nil, exitOK, ""
	}
	fsys := e.Assets
	if fsys == nil {
		fsys = static.Embedded()
	}
	if fsys == nil {
		return nil, exitRuntime, errNoAssets
	}
	keys := e.AssetKeys
	if keys == nil {
		var err error
		if keys, err = static.PublicKeys(); err != nil {
			return nil, exitRuntime, err.Error()
		}
	}
	set, err := static.Verify(fsys, keys)
	if err != nil {
		var ie *static.IntegrityError
		if errors.As(err, &ie) {
			logger.Error("asset_integrity_failed", "reason", ie.Reason, "path", ie.Path, "expected", ie.Expected, "actual", ie.Actual)
		}
		return nil, exitRuntime, err.Error()
	}
	logger.Info("assets verified", "files", set.Len())
	return set, exitOK, ""
}

// checkDatabase runs start-up steps 4-7. It returns the install state (the organisation every
// request is bound to until authentication lands, D12), or the exit code and message of the
// first failure.
func checkDatabase(ctx context.Context, db *store.Db) (store.InstallState, int, string) {
	pingCtx, cancel := context.WithTimeout(ctx, startupPingTimeout)
	err := db.Ping(pingCtx)
	cancel()
	if err != nil {
		return store.InstallState{}, exitRuntime, "postgres unreachable: " + err.Error()
	}
	role, bypass, err := db.RoleBypassesRLS(ctx)
	if err != nil {
		return store.InstallState{}, exitRuntime, err.Error()
	}
	if bypass {
		return store.InstallState{}, exitRuntime, fmt.Sprintf("postgres role %q bypasses row-level security; serve must connect as pulsus_app", role)
	}
	v, err := db.SchemaVersion(ctx)
	if err != nil {
		return store.InstallState{}, exitRuntime, err.Error()
	}
	if err := store.CheckServeSchema(v, store.SchemaLatest()); err != nil {
		return store.InstallState{}, exitRuntime, err.Error()
	}
	st, err := db.InstallState(ctx)
	if err != nil {
		return store.InstallState{}, exitRuntime, err.Error()
	}
	return st, exitOK, ""
}
