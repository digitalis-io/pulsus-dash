package core

import (
	"context"
	"time"

	"github.com/google/uuid"
)

// AnnotationKind is what an annotation marks (plan #64 Part C §3.3, T11 §4.4).
type AnnotationKind string

// The four annotation kinds; the database CHECK and the gateway accept no other.
const (
	AnnotationDeploy AnnotationKind = "deploy"
	AnnotationConfig AnnotationKind = "config"
	AnnotationFlag   AnnotationKind = "flag"
	AnnotationNote   AnnotationKind = "annotation"
)

// AnnotationKinds are the kinds in their documented order.
var AnnotationKinds = []AnnotationKind{AnnotationDeploy, AnnotationConfig, AnnotationFlag, AnnotationNote}

// Valid reports whether k is one of the four kinds.
func (k AnnotationKind) Valid() bool {
	for _, x := range AnnotationKinds {
		if k == x {
			return true
		}
	}
	return false
}

// Annotation is one stored event marker. Times are UTC with millisecond precision; EndAt nil is a
// point; Tags is never nil.
type Annotation struct {
	ID    uuid.UUID
	At    time.Time
	EndAt *time.Time
	Kind  AnnotationKind
	Text  string
	Tags  []string
	// Entity is the canonical entity the change is about, or nil (organisation-wide).
	Entity *AnnotationEntity
}

// NewAnnotation is an annotation to create; the service assigns its id.
type NewAnnotation struct {
	At    time.Time
	EndAt *time.Time
	Kind  AnnotationKind
	Text  string
	Tags  []string
	// Entity is the submitted entity, already canonical (entity.Canonicalise), or nil.
	Entity *NewEntity
}

// CanonicalEntity is an entity in canonical form (T12-010, T12 §4.5): the kind, the identifying
// values in schema order (nil = an absent optional position) and the canonical map (each present
// position under its first alternative's name).
type CanonicalEntity struct {
	Kind  string
	Ident []*string
	Attrs map[string]string
}

// NewEntity is a submitted entity: the slug of a tenant binding of the organisation and the
// canonical entity.
type NewEntity struct {
	Binding string
	CanonicalEntity
}

// AnnotationEntity is a stored entity: its EntityId, its binding (id and slug) and the canonical
// entity.
type AnnotationEntity struct {
	ID, BindingID uuid.UUID
	Binding       string
	CanonicalEntity
}

// AnnotationCursor is a keyset position (T24-032): the rows older than it are (at, id) < (At, ID).
type AnnotationCursor struct {
	At time.Time
	ID uuid.UUID
}

// AnnotationFilter is a list's filters (T24 §5.9): kinds any-of, tags all-of, entities any-of
// (OrgWide also lists the organisation-wide rows), and the cursor. Empty slices filter nothing.
type AnnotationFilter struct {
	Kinds    []AnnotationKind
	Tags     []string
	Entities []uuid.UUID
	OrgWide  bool
	Before   *AnnotationCursor
}

// AnnotationPage is one page of a list: the items, the cursor of the next page (nil when none),
// and the organisation-wide rows the entity filter excluded (nil when the scope is not full).
type AnnotationPage struct {
	Items         []Annotation
	Next          *AnnotationCursor
	OrgWideHidden *int64
}

// InvalidError is a 400 invalid found by a service, with one field.
type InvalidError struct{ Pointer, Key string }

func (e *InvalidError) Error() string { return "invalid: " + e.Pointer + " " + e.Key }

// ScopeError is a 403 scope_denied with one field: the write is outside the data scope.
type ScopeError struct{ Pointer, Key string }

func (e *ScopeError) Error() string { return "outside the data scope: " + e.Pointer + " " + e.Key }

// Is makes a ScopeError match ErrScopeDenied.
func (e *ScopeError) Is(target error) bool { return target == ErrScopeDenied }

// Annotations is the annotations service (internal/annotations). Every method runs in one
// organisation-bound transaction (T11-023); writes append one audit event in it (T11-017).
type Annotations interface {
	CreateAnnotation(ctx context.Context, rc *RequestCtx, a NewAnnotation) (Annotation, error)
	// ListAnnotations returns a page of at most limit annotations overlapping [from, to] (at <= to
	// AND coalesce(end_at, at) >= from), inside the data scope and the filter, newest first.
	ListAnnotations(ctx context.Context, rc *RequestCtx, from, to time.Time, limit int, f AnnotationFilter) (AnnotationPage, error)
	// DeleteAnnotation deletes the annotation, or returns ErrNotFound (absent or outside the scope).
	DeleteAnnotation(ctx context.Context, rc *RequestCtx, id uuid.UUID) error
}
