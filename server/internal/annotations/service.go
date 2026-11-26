// Package annotations is the annotations service (plan #64 Part C §3.3): event markers in
// Postgres, read for a time window and written with one hash-chained audit event per write in the
// same organisation-bound transaction (T11-017, T11-023).
package annotations

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
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

// JSON is the annotation as the API sends it (plan #64 Part C §3.4), the value of its audit diffs:
// times in ms since the Unix epoch, a point's end_at null, tags never null.
func JSON(a core.Annotation) map[string]any {
	var end any
	if a.EndAt != nil {
		end = a.EndAt.UnixMilli()
	}
	tags := a.Tags
	if tags == nil {
		tags = []string{}
	}
	return map[string]any{"id": a.ID.String(), "at": a.At.UnixMilli(), "end_at": end, "kind": string(a.Kind), "text": a.Text, "tags": tags}
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
// it, and returns it as stored.
func (s *Service) CreateAnnotation(ctx context.Context, rc *core.RequestCtx, n core.NewAnnotation) (core.Annotation, error) {
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
	ev, err := s.event(rc, "annotation.create", a, []map[string]any{{"op": "add", "path": "", "value": JSON(a)}})
	if err != nil {
		return core.Annotation{}, err
	}
	err = s.db.Tx(ctx, rc.Org, func(ctx context.Context, tx *store.OrgTx) error {
		if err := tx.InsertAnnotation(ctx, a, rc.Actor); err != nil {
			return err
		}
		_, err := tx.AppendAudit(ctx, ev)
		return err
	})
	if err != nil {
		return core.Annotation{}, err
	}
	return a, nil
}

// ListAnnotations returns at most limit annotations overlapping [from, to], newest first, and
// whether more exist.
func (s *Service) ListAnnotations(ctx context.Context, rc *core.RequestCtx, from, to time.Time, limit int, f core.AnnotationFilter) (core.AnnotationPage, error) {
	var page core.AnnotationPage
	err := s.db.Tx(ctx, rc.Org, func(ctx context.Context, tx *store.OrgTx) error {
		var err error
		page, err = tx.ListAnnotations(ctx, from, to, limit, f, store.ScopeParam{Full: true, JSON: []byte("[]")})
		return err
	})
	return page, err
}

// DeleteAnnotation deletes the annotation with an annotation.delete audit event whose diff tests
// and removes it. An absent id is core.ErrNotFound and appends no audit event.
func (s *Service) DeleteAnnotation(ctx context.Context, rc *core.RequestCtx, id uuid.UUID) error {
	return s.db.Tx(ctx, rc.Org, func(ctx context.Context, tx *store.OrgTx) error {
		a, err := tx.DeleteAnnotation(ctx, id, store.ScopeParam{Full: true, JSON: []byte("[]")})
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
