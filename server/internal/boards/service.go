// Package boards is the boards service (plan #61 §3.6).
package boards

import (
	"context"
	"errors"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store"
)

var errStub = errors.New("boards: not implemented")

// Service implements core.Boards over the store.
type Service struct {
	db     *store.Db
	now    func() time.Time
	newUID func() (string, error)
}

var _ core.Boards = (*Service)(nil)

// New returns the service.
func New(db *store.Db) *Service { return &Service{db: db, now: time.Now, newUID: NewUID} }

func (s *Service) ListBoards(ctx context.Context, rc *core.RequestCtx) ([]core.BoardSummary, bool, error) {
	return nil, false, errStub
}
func (s *Service) GetBoard(ctx context.Context, rc *core.RequestCtx, uid string) (core.Board, error) {
	return core.Board{}, errStub
}
func (s *Service) CreateBoard(ctx context.Context, rc *core.RequestCtx, spec []byte) (core.Board, error) {
	return core.Board{}, errStub
}
func (s *Service) SaveBoard(ctx context.Context, rc *core.RequestCtx, uid string, ifMatch int64, spec []byte, message string) (core.SaveResult, error) {
	return core.SaveResult{}, errStub
}
func (s *Service) DeleteBoard(ctx context.Context, rc *core.RequestCtx, uid string, ifMatch int64) error {
	return errStub
}
func (s *Service) ListStarred(ctx context.Context, rc *core.RequestCtx) ([]core.BoardRef, error) {
	return nil, errStub
}
func (s *Service) SetStarred(ctx context.Context, rc *core.RequestCtx, uid string, starred bool) error {
	return errStub
}
func (s *Service) ListRecent(ctx context.Context, rc *core.RequestCtx, limit int) ([]core.BoardRef, error) {
	return nil, errStub
}
func (s *Service) RecordView(ctx context.Context, rc *core.RequestCtx, uid string) error {
	return errStub
}
