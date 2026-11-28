package gateway

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// M1
func TestVersionRoute(t *testing.T) {
	h := New(Deps{Probe: &fakeProbe{version: 1}, Build: core.BuildInfo{Version: "1.2.3", Commit: "abc"}})
	wantJSON(t, do(h, http.MethodGet, "/api/dash/v1/version"), http.StatusOK, `{"version":"1.2.3","commit":"abc"}`)
}

func bootstrapHandler(view core.BootstrapView, err error) (http.Handler, *syncBuffer) {
	logs := &syncBuffer{}
	return New(Deps{
		Logger: slog.New(slog.NewJSONHandler(logs, nil)),
		Probe:  &fakeProbe{version: 1},
		Build:  core.BuildInfo{Version: "0.1.0-dev", Commit: "abc"},
		Bootstrap: func(context.Context) (core.BootstrapView, error) {
			return view, err
		},
	}), logs
}

// M2
func TestBootstrapRoute(t *testing.T) {
	view := core.BootstrapView{
		Org: core.Org{Slug: "default", Name: "Default organisation"},
		Bindings: []core.TenantBinding{
			{Slug: "demo", DatasourceURL: "http://ds-one.invalid:3100", Database: "db1", ScopeOrgID: "scope1", CredentialsRef: "env:PDB_CREDS", Kind: "pulsusdb"}, //nolint:gosec // a reference string, not a credential

			{Slug: "zeta", DatasourceURL: "http://ds-two.invalid:3100", Kind: "pulsusdb", ScopeSeq: 3},
		},
	}
	h, _ := bootstrapHandler(view, nil)
	rec := do(h, http.MethodGet, "/api/dash/v1/bootstrap")
	// The scope epoch and sequence of each binding for the session principal (#304 §A.2).
	e0 := core.ScopeEpoch(core.LocalPrincipal.ID, view.Bindings[0], core.FullTenantScope())
	e1 := core.ScopeEpoch(core.LocalPrincipal.ID, view.Bindings[1], core.FullTenantScope())
	wantJSON(t, rec, http.StatusOK, `{
		"principal": {"id": "local", "name": "Local user", "email": "", "role": "admin"},
		"org": {"slug": "default", "name": "Default organisation"},
		"tenants": [
			{"slug": "demo", "name": "demo", "datasource": {"state": "not_checked"}, "scope_epoch": "`+e0+`", "scope_seq": 0},
			{"slug": "zeta", "name": "zeta", "datasource": {"state": "not_checked"}, "scope_epoch": "`+e1+`", "scope_seq": 3}
		],
		"default_tenant": "demo",
		"server": {"version": "0.1.0-dev", "commit": "abc"},
		"can_sign_out": false}`)
	body := rec.Body.String()
	for _, leak := range []string{"datasource_url", "invalid", "db1", "scope1", "PDB_CREDS", "pulsusdb"} {
		if strings.Contains(body, leak) {
			t.Errorf("bootstrap body contains %q: %s", leak, body)
		}
	}
}

// M3
func TestBootstrapErrors(t *testing.T) {
	h, logs := bootstrapHandler(core.BootstrapView{}, errors.New("store: begin: connection refused"))
	wantJSON(t, do(h, http.MethodGet, "/api/dash/v1/bootstrap"), http.StatusServiceUnavailable,
		`{"error":{"code":"unavailable","message":"configuration store unavailable"}}`)
	warned := false
	for _, r := range logs.records(t) {
		if r["level"] == "WARN" && r["msg"] == "bootstrap" {
			warned = true
		}
	}
	if !warned {
		t.Error("no warn record msg=bootstrap for the store error")
	}

	h, _ = bootstrapHandler(core.BootstrapView{Org: core.Org{Slug: "default", Name: "Default organisation"}}, nil)
	wantJSON(t, do(h, http.MethodGet, "/api/dash/v1/bootstrap"), http.StatusServiceUnavailable,
		`{"error":{"code":"unavailable","message":"no tenant binding"}}`)
}
