package gateway

import (
	"context"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
)

// localPrincipal is the fixed principal of every request until authentication lands (D12,
// M-UI6), built from core.LocalPrincipal so the two cannot drift. It cannot sign out.
var localPrincipal = api.Principal{Id: core.LocalPrincipal.ID, Name: core.LocalPrincipal.Name, Email: "",
	Role: api.PrincipalRole(core.LocalPrincipal.Role)}

// meta implements GET /api/dash/v1/version and GET /api/dash/v1/bootstrap.
type meta struct{ deps Deps }

func (m *meta) GetVersion(context.Context, api.GetVersionRequestObject) (api.GetVersionResponseObject, error) {
	return api.GetVersion200JSONResponse{Version: m.deps.Build.Version, Commit: m.deps.Build.Commit}, nil
}

func unavailable(msg string) api.GetBootstrap503JSONResponse {
	return api.GetBootstrap503JSONResponse{Error: api.ErrorBody{Code: api.Unavailable, Message: msg}}
}

// GetBootstrap returns the principal, the organisation, its tenants (slug and check state only,
// never a datasource URL, database, scope or credentials reference: T06-024) and the server
// version.
func (m *meta) GetBootstrap(ctx context.Context, _ api.GetBootstrapRequestObject) (api.GetBootstrapResponseObject, error) {
	if m.deps.Bootstrap == nil {
		return unavailable("configuration store unavailable"), nil
	}
	view, err := m.deps.Bootstrap(ctx)
	if err != nil {
		m.deps.Logger.WarnContext(ctx, "bootstrap", "error", err.Error())
		return unavailable("configuration store unavailable"), nil
	}
	if len(view.Bindings) == 0 {
		m.deps.Logger.WarnContext(ctx, "bootstrap", "error", "no tenant binding")
		return unavailable("no tenant binding"), nil
	}
	tenants := make([]api.TenantInfo, 0, len(view.Bindings))
	for _, b := range view.Bindings {
		tenants = append(tenants, api.TenantInfo{Slug: b.Slug, Name: b.Slug, Datasource: api.DatasourceStatus{State: api.DatasourceStatusStateNotChecked}})
	}
	return api.GetBootstrap200JSONResponse{
		Principal:     localPrincipal,
		Org:           api.OrgInfo{Slug: view.Org.Slug, Name: view.Org.Name},
		Tenants:       tenants,
		DefaultTenant: tenants[0].Slug,
		Server:        api.Version{Version: m.deps.Build.Version, Commit: m.deps.Build.Commit},
		CanSignOut:    false,
	}, nil
}
