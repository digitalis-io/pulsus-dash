// Package annotations is the annotations service (plan #64 Part C §3.3).
package annotations

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store"
)

var errTODO = errors.New("annotations: not implemented")

// Service implements core.Annotations over the store.
type Service struct{ db *store.Db }

var _ core.Annotations = (*Service)(nil)

// New returns the service over db (the pulsus_app pool).
func New(db *store.Db) *Service { return &Service{db: db} }

// CreateAnnotation is not implemented yet.
func (s *Service) CreateAnnotation(context.Context, *core.RequestCtx, core.NewAnnotation) (core.Annotation, error) {
	return core.Annotation{}, errTODO
}

// ListAnnotations is not implemented yet.
func (s *Service) ListAnnotations(context.Context, *core.RequestCtx, time.Time, time.Time, int) ([]core.Annotation, bool, error) {
	return nil, false, errTODO
}

// DeleteAnnotation is not implemented yet.
func (s *Service) DeleteAnnotation(context.Context, *core.RequestCtx, uuid.UUID) error {
	return errTODO
}
