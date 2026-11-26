package annotations

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// guarded runs fn and turns a panic (a nil database touched) into an error.
func guarded(fn func() error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("touched the database: %v", r)
		}
	}()
	return fn()
}

// T12-018: an unset or uncompilable scope is ErrScopeDenied before any statement, and a scoped
// create without an entity is refused before any statement.
func TestScopeDeniedBeforeSQL(t *testing.T) {
	svc := New(nil)
	ctx := context.Background()
	org := core.OrgID(uuid.MustParse("00000000-0000-4000-8000-0000000000aa"))
	at := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)
	n := core.NewAnnotation{At: at, Kind: core.AnnotationDeploy, Text: "x", Tags: []string{}}
	s6 := core.ScopedTenant(core.ScopeClause{Bindings: []uuid.UUID{}})
	for name, scope := range map[string]core.DataScope{"unset": {}, "S6": s6} {
		rc := &core.RequestCtx{Org: org, Actor: core.LocalActor(), Scope: scope}
		calls := map[string]func() error{
			"list": func() error {
				_, err := svc.ListAnnotations(ctx, rc, at, at.Add(time.Hour), 500, core.AnnotationFilter{})
				return err
			},
			"create": func() error { _, err := svc.CreateAnnotation(ctx, rc, n); return err },
			"delete": func() error {
				return svc.DeleteAnnotation(ctx, rc, uuid.MustParse("00000000-0000-4000-8000-000000000001"))
			},
		}
		for op, call := range calls {
			if err := guarded(call); !errors.Is(err, core.ErrScopeDenied) {
				t.Errorf("%s %s = %v, want ErrScopeDenied without touching the database", name, op, err)
			}
		}
	}
	shop := core.ScopedTenant(core.ScopeClause{Attrs: map[string][]string{"service.namespace": {"shop"}}})
	err := guarded(func() error {
		_, err := svc.CreateAnnotation(ctx, &core.RequestCtx{Org: org, Actor: core.LocalActor(), Scope: shop}, n)
		return err
	})
	var se *core.ScopeError
	if !errors.As(err, &se) || se.Pointer != "/entity" || se.Key != "annotations.scope" || !errors.Is(err, core.ErrScopeDenied) {
		t.Errorf("P_shop create without an entity = %v, want ScopeError /entity annotations.scope", err)
	}
	if core.ScopedTenant().IsFullTenant() || !core.FullTenantScope().IsFullTenant() {
		t.Error("ScopedTenant() is the full tenant, or FullTenantScope() is not")
	}
}
