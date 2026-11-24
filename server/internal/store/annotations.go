package store

import (
	"context"
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

// annotationOf converts a stored row: times in UTC, a NULL end_at as nil, tags never nil.
func annotationOf(id pgtype.UUID, at, end pgtype.Timestamptz, kind, text string, tags []string) core.Annotation {
	a := core.Annotation{ID: uuid.UUID(id.Bytes), At: at.Time.UTC(), Kind: core.AnnotationKind(kind), Text: text, Tags: tags}
	if end.Valid {
		e := end.Time.UTC()
		a.EndAt = &e
	}
	if a.Tags == nil {
		a.Tags = []string{}
	}
	return a
}

// InsertAnnotation stores a new annotation authored by author.
func (t *OrgTx) InsertAnnotation(ctx context.Context, a core.Annotation, author core.Actor) error {
	tags := a.Tags
	if tags == nil {
		tags = []string{}
	}
	err := t.q.InsertAnnotation(ctx, dbgen.InsertAnnotationParams{
		OrgID: pgUUID(t.org), ID: pgUUID(a.ID), At: stamp(a.At), Kind: string(a.Kind), Text: a.Text, Tags: tags,
		AuthorKind: string(author.Kind), EndAt: nullStamp(a.EndAt), AuthorID: nullUUID(author.ID),
	})
	if err != nil {
		return fmt.Errorf("store: insert annotation: %w", err)
	}
	return nil
}

// ListAnnotations returns at most limit annotations overlapping [from, to], newest first (at,
// then id, descending), and whether more exist (one more row is read).
func (t *OrgTx) ListAnnotations(ctx context.Context, from, to time.Time, limit int) ([]core.Annotation, bool, error) {
	limit = min(max(limit, 0), 1<<20)
	rows, err := t.q.ListAnnotations(ctx, dbgen.ListAnnotationsParams{
		OrgID: pgUUID(t.org), ToAt: stamp(to), FromAt: stamp(from), Lim: int32(limit + 1), //nolint:gosec // clamped above
	})
	if err != nil {
		return nil, false, fmt.Errorf("store: list annotations: %w", err)
	}
	truncated := len(rows) > limit
	if truncated {
		rows = rows[:limit]
	}
	out := make([]core.Annotation, 0, len(rows))
	for _, r := range rows {
		out = append(out, annotationOf(r.ID, r.At, r.EndAt, r.Kind, r.Text, r.Tags))
	}
	return out, truncated, nil
}

// DeleteAnnotation deletes an annotation and returns it as it was, or core.ErrNotFound.
func (t *OrgTx) DeleteAnnotation(ctx context.Context, id uuid.UUID) (core.Annotation, error) {
	r, err := t.q.DeleteAnnotation(ctx, dbgen.DeleteAnnotationParams{OrgID: pgUUID(t.org), ID: pgUUID(id)})
	if err != nil {
		return core.Annotation{}, notFound("delete annotation", err)
	}
	return annotationOf(r.ID, r.At, r.EndAt, r.Kind, r.Text, r.Tags), nil
}
