// Package annotations is the annotations service (plan #64 Part C §3.3): event markers in
// Postgres, read for a time window and written with one hash-chained audit event per write in the
// same organisation-bound transaction (T11-017, T11-023).
package annotations

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/entity"
	"github.com/digitalis-io/pulsus-dash/server/internal/spec"
	"github.com/digitalis-io/pulsus-dash/server/internal/store"
)

// resourceKind is the audit resource kind of every annotation event.
const resourceKind = "annotation"

// Service implements core.Annotations over the store.
type Service struct {
	db    *store.Db
	now   func() time.Time
	newID func() (uuid.UUID, error)
}

var _ core.Annotations = (*Service)(nil)

// New returns the service over db (the pulsus_app pool).
func New(db *store.Db) *Service { return &Service{db: db, now: time.Now, newID: core.NewID} }

// JSON is the annotation as the API sends it (plan #64 Part C §3.4, plan #222 §3.6), the value
// of its audit diffs: times in ms since the Unix epoch, a point's end_at null, tags never null,
// entity null (organisation-wide) or {id, binding, kind, ident}; never binding_id or attrs.
func JSON(a core.Annotation) map[string]any {
	var end any
	if a.EndAt != nil {
		end = a.EndAt.UnixMilli()
	}
	tags := a.Tags
	if tags == nil {
		tags = []string{}
	}
	var ent any
	if e := a.Entity; e != nil {
		ident := make([]any, 0, len(e.Ident))
		for _, v := range e.Ident {
			if v == nil {
				ident = append(ident, nil)
				continue
			}
			ident = append(ident, *v)
		}
		ent = map[string]any{"id": e.ID.String(), "binding": e.Binding, "kind": e.Kind, "ident": ident}
	}
	return map[string]any{"id": a.ID.String(), "at": a.At.UnixMilli(), "end_at": end, "kind": string(a.Kind), "text": a.Text,
		"tags": tags, "entity": ent}
}

// scope is the request's data scope for the annotations paths (step 1 of every path, plan #222
// §3.6): full, or compiled. An unset or uncompilable scope is core.ErrScopeDenied, before any
// statement.
func scope(rc *core.RequestCtx) (bool, entity.Compiled, store.ScopeParam, error) {
	full, clauses, err := rc.Scope.AnnotationScope()
	if err != nil {
		return false, nil, store.ScopeParam{}, err
	}
	if full {
		return true, nil, store.ScopeParam{Full: true, JSON: []byte("[]")}, nil
	}
	c, err := entity.CompileScope(clauses)
	if err != nil {
		return false, nil, store.ScopeParam{}, fmt.Errorf("annotations: %w: %w", core.ErrScopeDenied, err)
	}
	return false, c, store.ScopeParam{JSON: c.JSON()}, nil
}

func (s *Service) event(rc *core.RequestCtx, action string, a core.Annotation, ops []map[string]any) (core.AuditEvent, error) {
	diff, err := spec.Canonical(ops)
	if err != nil {
		return core.AuditEvent{}, fmt.Errorf("annotations: audit diff: %w", err)
	}
	id, err := core.NewID()
	if err != nil {
		return core.AuditEvent{}, fmt.Errorf("annotations: new audit id: %w", err)
	}
	return core.AuditEvent{ID: id, At: s.now(), Actor: rc.Actor, Action: action, ResourceKind: resourceKind,
		ResourceID: a.ID.String(), RequestID: rc.RequestID, Diff: diff}, nil
}

// utcMs is t in UTC at millisecond precision, as stored and sent.
func utcMs(t time.Time) time.Time { return t.UTC().Truncate(time.Millisecond) }

// CreateAnnotation stores n under a new id, with an annotation.create audit event whose diff adds
// it, and returns it as stored. The entity's binding slug must name a binding of the organisation
// (else InvalidError /entity/binding), and the scope must cover the canonical entity (else
// ScopeError /entity); without an entity the scope must be full.
func (s *Service) CreateAnnotation(ctx context.Context, rc *core.RequestCtx, n core.NewAnnotation) (core.Annotation, error) {
	full, compiled, _, err := scope(rc)
	if err != nil {
		return core.Annotation{}, err
	}
	if n.Entity == nil && !full {
		return core.Annotation{}, &core.ScopeError{Pointer: "/entity", Key: "annotations.scope"}
	}
	id, err := s.newID()
	if err != nil {
		return core.Annotation{}, fmt.Errorf("annotations: new id: %w", err)
	}
	a := core.Annotation{ID: id, At: utcMs(n.At), Kind: n.Kind, Text: n.Text, Tags: n.Tags}
	if n.EndAt != nil {
		e := utcMs(*n.EndAt)
		a.EndAt = &e
	}
	if a.Tags == nil {
		a.Tags = []string{}
	}
	err = s.db.Tx(ctx, rc.Org, func(ctx context.Context, tx *store.OrgTx) error {
		if n.Entity != nil {
			binding, err := tx.TenantBindingIDBySlug(ctx, n.Entity.Binding)
			if errors.Is(err, core.ErrNotFound) {
				return &core.InvalidError{Pointer: "/entity/binding", Key: "annotations.entity.binding"}
			}
			if err != nil {
				return fmt.Errorf("annotations: binding: %w", err)
			}
			a.Entity = &core.AnnotationEntity{ID: entity.ID(binding, n.Entity.CanonicalEntity), BindingID: binding,
				Binding: n.Entity.Binding, CanonicalEntity: n.Entity.CanonicalEntity}
			if !entity.ScopeCovers(full, compiled, a.Entity) {
				return &core.ScopeError{Pointer: "/entity", Key: "annotations.entity.scope"}
			}
		}
		ev, err := s.event(rc, "annotation.create", a, []map[string]any{{"op": "add", "path": "", "value": JSON(a)}})
		if err != nil {
			return err
		}
		if err := tx.InsertAnnotation(ctx, a, rc.Actor); err != nil {
			return err
		}
		_, err = tx.AppendAudit(ctx, ev)
		return err
	})
	if err != nil {
		return core.Annotation{}, err
	}
	return a, nil
}

// ListAnnotations returns a page of at most limit annotations overlapping [from, to], inside the
// scope and the filter, newest first. OrgWideHidden is nil unless the scope is full.
func (s *Service) ListAnnotations(ctx context.Context, rc *core.RequestCtx, from, to time.Time, limit int, f core.AnnotationFilter) (core.AnnotationPage, error) {
	full, _, sp, err := scope(rc)
	if err != nil {
		return core.AnnotationPage{}, err
	}
	var page core.AnnotationPage
	err = s.db.Tx(ctx, rc.Org, func(ctx context.Context, tx *store.OrgTx) error {
		var err error
		page, err = tx.ListAnnotations(ctx, from, to, limit, f, sp)
		return err
	})
	if err != nil {
		return core.AnnotationPage{}, err
	}
	if !full {
		page.OrgWideHidden = nil
	}
	return page, nil
}

// DeleteAnnotation deletes the annotation inside the scope with an annotation.delete audit event
// whose diff tests and removes it. An absent id and a row outside the scope are both
// core.ErrNotFound and append no audit event.
func (s *Service) DeleteAnnotation(ctx context.Context, rc *core.RequestCtx, id uuid.UUID) error {
	_, _, sp, err := scope(rc)
	if err != nil {
		return err
	}
	return s.db.Tx(ctx, rc.Org, func(ctx context.Context, tx *store.OrgTx) error {
		a, err := tx.DeleteAnnotation(ctx, id, sp)
		if err != nil {
			return err
		}
		ev, err := s.event(rc, "annotation.delete", a, []map[string]any{
			{"op": "test", "path": "", "value": JSON(a)}, {"op": "remove", "path": ""}})
		if err != nil {
			return err
		}
		_, err = tx.AppendAudit(ctx, ev)
		return err
	})
}
