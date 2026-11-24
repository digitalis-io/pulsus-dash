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
}

// NewAnnotation is an annotation to create; the service assigns its id.
type NewAnnotation struct {
	At    time.Time
	EndAt *time.Time
	Kind  AnnotationKind
	Text  string
	Tags  []string
}

// Annotations is the annotations service (internal/annotations). Every method runs in one
// organisation-bound transaction (T11-023); writes append one audit event in it (T11-017).
type Annotations interface {
	CreateAnnotation(ctx context.Context, rc *RequestCtx, a NewAnnotation) (Annotation, error)
	// ListAnnotations returns at most limit annotations overlapping [from, to] (at <= to AND
	// coalesce(end_at, at) >= from), newest first, and whether more exist.
	ListAnnotations(ctx context.Context, rc *RequestCtx, from, to time.Time, limit int) ([]Annotation, bool, error)
	// DeleteAnnotation deletes the annotation, or returns ErrNotFound.
	DeleteAnnotation(ctx context.Context, rc *RequestCtx, id uuid.UUID) error
}
