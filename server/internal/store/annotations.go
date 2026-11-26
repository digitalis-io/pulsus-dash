package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/dbgen"
)

func stamp(t time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: t, Valid: true} }

func nullStamp(t *time.Time) pgtype.Timestamptz {
	if t == nil {
		return pgtype.Timestamptz{}
	}
	return stamp(*t)
}

// ScopeParam is the data scope of a statement (the predicate P, T24 §5.9): full, or the compiled
// clauses' JSON (entity.Compiled.JSON(); "[]" when full).
type ScopeParam struct {
	Full bool
	JSON []byte
}

// scopeJSON is the scope parameter, never NULL: a NULL $scope would make P NULL, not false.
func (s ScopeParam) scopeJSON() []byte {
	if len(s.JSON) == 0 {
		return []byte("[]")
	}
	return s.JSON
}

// storedEntity is the stored image of an annotation's entity (the entity column).
type storedEntity struct {
	ID        uuid.UUID         `json:"id"`
	Binding   string            `json:"binding"`
	BindingID uuid.UUID         `json:"binding_id"`
	Kind      string            `json:"kind"`
	Ident     []*string         `json:"ident"`
	Attrs     map[string]string `json:"attrs"`
}

// errStoredEntity is a stored entity that does not decode or does not match its entity_key.
var errStoredEntity = errors.New("store: stored annotation entity is malformed")

// entityOf decodes a stored entity; NULL is nil. A row whose entity does not decode is an error.
func entityOf(key pgtype.Text, raw []byte) (*core.AnnotationEntity, error) {
	if raw == nil && !key.Valid {
		return nil, nil
	}
	var s storedEntity
	if err := json.Unmarshal(raw, &s); err != nil {
		return nil, fmt.Errorf("%w: %w", errStoredEntity, err)
	}
	if !key.Valid || key.String != s.ID.String() || s.Kind == "" || s.Attrs == nil || s.Ident == nil {
		return nil, errStoredEntity
	}
	return &core.AnnotationEntity{ID: s.ID, BindingID: s.BindingID, Binding: s.Binding,
		CanonicalEntity: core.CanonicalEntity{Kind: s.Kind, Ident: s.Ident, Attrs: s.Attrs}}, nil
}

// annotationOf converts a stored row: times in UTC, a NULL end_at as nil, tags never nil, the
// entity decoded (nil when organisation-wide).
func annotationOf(id pgtype.UUID, at, end pgtype.Timestamptz, kind, text string, tags []string, key pgtype.Text, ent []byte) (core.Annotation, error) {
	a := core.Annotation{ID: uuid.UUID(id.Bytes), At: at.Time.UTC(), Kind: core.AnnotationKind(kind), Text: text, Tags: tags}
	if end.Valid {
		e := end.Time.UTC()
		a.EndAt = &e
	}
	if a.Tags == nil {
		a.Tags = []string{}
	}
	e, err := entityOf(key, ent)
	if err != nil {
		return core.Annotation{}, fmt.Errorf("annotation %s: %w", a.ID, err)
	}
	a.Entity = e
	return a, nil
}

// TenantBindingIDBySlug returns the id of the organisation's tenant binding with the slug, or
// core.ErrNotFound.
func (t *OrgTx) TenantBindingIDBySlug(ctx context.Context, slug string) (uuid.UUID, error) {
	id, err := t.q.TenantBindingIDBySlug(ctx, dbgen.TenantBindingIDBySlugParams{OrgID: pgUUID(t.org), Slug: slug})
	if err != nil {
		return uuid.UUID{}, notFound("tenant binding by slug", err)
	}
	return uuid.UUID(id.Bytes), nil
}

// InsertAnnotation stores a new annotation authored by author, with its entity (entity_key and
// entity set together) or organisation-wide (both NULL).
func (t *OrgTx) InsertAnnotation(ctx context.Context, a core.Annotation, author core.Actor) error {
	tags := a.Tags
	if tags == nil {
		tags = []string{}
	}
	p := dbgen.InsertAnnotationParams{
		OrgID: pgUUID(t.org), ID: pgUUID(a.ID), At: stamp(a.At), Kind: string(a.Kind), Text: a.Text, Tags: tags,
		AuthorKind: string(author.Kind), EndAt: nullStamp(a.EndAt), AuthorID: nullUUID(author.ID),
	}
	if e := a.Entity; e != nil {
		b, err := json.Marshal(storedEntity{ID: e.ID, Binding: e.Binding, BindingID: e.BindingID, Kind: e.Kind, Ident: e.Ident, Attrs: e.Attrs})
		if err != nil {
			return fmt.Errorf("store: insert annotation: entity: %w", err)
		}
		p.EntityKey, p.Entity = pgtype.Text{String: e.ID.String(), Valid: true}, b
	}
	if err := t.q.InsertAnnotation(ctx, p); err != nil {
		return fmt.Errorf("store: insert annotation: %w", err)
	}
	return nil
}

// ListAnnotations returns a page of at most limit annotations overlapping [from, to] inside the
// scope and the filter, newest first (at, then id, descending), from one statement: one more row
// is read, and when it exists Next is the last kept row's (at, id). OrgWideHidden is the
// organisation-wide rows the entity filter excluded (the service drops it unless the scope is
// full).
func (t *OrgTx) ListAnnotations(ctx context.Context, from, to time.Time, limit int, f core.AnnotationFilter, s ScopeParam) (core.AnnotationPage, error) {
	limit = min(max(limit, 0), 1<<20)
	// Never nil: pgx sends a nil slice as NULL, and tags @> NULL drops every row.
	kinds, tags, ents := make([]string, 0, len(f.Kinds)), make([]string, 0, len(f.Tags)), make([]string, 0, len(f.Entities))
	for _, k := range f.Kinds {
		kinds = append(kinds, string(k))
	}
	tags = append(tags, f.Tags...)
	for _, e := range f.Entities {
		ents = append(ents, e.String())
	}
	p := dbgen.ListAnnotationsParams{
		OrgID: pgUUID(t.org), ToAt: stamp(to), FromAt: stamp(from), Lim: int32(limit + 1), //nolint:gosec // clamped above
		Kinds: kinds, Tags: tags, Ents: ents, OrgWide: f.OrgWide, ScopeFull: s.Full, Scope: s.scopeJSON(),
	}
	if f.Before != nil {
		p.HasBefore, p.BeforeAt, p.BeforeID = true, stamp(f.Before.At), pgUUID(f.Before.ID)
	}
	rows, err := t.q.ListAnnotations(ctx, p)
	if err != nil {
		return core.AnnotationPage{}, fmt.Errorf("store: list annotations: %w", err)
	}
	if len(rows) == 0 {
		return core.AnnotationPage{}, errors.New("store: list annotations: no summary row")
	}
	hidden := rows[0].OrgWideHidden
	page := core.AnnotationPage{Items: make([]core.Annotation, 0, min(len(rows), limit)), OrgWideHidden: &hidden}
	for _, r := range rows {
		if !r.Found {
			break
		}
		if len(page.Items) == limit {
			last := page.Items[len(page.Items)-1]
			page.Next = &core.AnnotationCursor{At: last.At, ID: last.ID}
			break
		}
		a, err := annotationOf(r.ID, r.At, r.EndAt, r.Kind, r.Text, r.Tags, r.EntityKey, r.Entity)
		if err != nil {
			return core.AnnotationPage{}, fmt.Errorf("store: list annotations: %w", err)
		}
		page.Items = append(page.Items, a)
	}
	return page, nil
}

// DeleteAnnotation deletes an annotation inside the scope and returns it as it was, or
// core.ErrNotFound for an absent row and a row outside the scope alike.
func (t *OrgTx) DeleteAnnotation(ctx context.Context, id uuid.UUID, s ScopeParam) (core.Annotation, error) {
	r, err := t.q.DeleteAnnotation(ctx, dbgen.DeleteAnnotationParams{OrgID: pgUUID(t.org), ID: pgUUID(id), ScopeFull: s.Full, Scope: s.scopeJSON()})
	if err != nil {
		return core.Annotation{}, notFound("delete annotation", err)
	}
	a, err := annotationOf(r.ID, r.At, r.EndAt, r.Kind, r.Text, r.Tags, r.EntityKey, r.Entity)
	if err != nil {
		return core.Annotation{}, fmt.Errorf("store: delete annotation: %w", err)
	}
	return a, nil
}
