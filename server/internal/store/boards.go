package store

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

var errStub = errors.New("store: not implemented")

// BoardHead is a board's head row joined with its head version.
type BoardHead struct {
	ID                           uuid.UUID
	UID, Title                   string
	Version, ETag, SchemaVersion int64
	Spec, ContentHash            []byte
	UpdatedAt                    time.Time
	Author                       core.Actor
}

// NewBoardVersion is one immutable board version.
type NewBoardVersion struct {
	BoardID                uuid.UUID
	Version, SchemaVersion int64
	Spec, ContentHash      []byte
	Author                 core.Actor
	Message                string
}

func (t *OrgTx) EnsureRootFolder(ctx context.Context) (uuid.UUID, error) { return uuid.UUID{}, errStub }
func (t *OrgTx) InsertBoard(ctx context.Context, id uuid.UUID, uid string, folder uuid.UUID, title string) (bool, error) {
	return false, errStub
}
func (t *OrgTx) InsertBoardVersion(ctx context.Context, v NewBoardVersion) error { return errStub }
func (t *OrgTx) LockBoard(ctx context.Context, uid string) (uuid.UUID, int64, int64, error) {
	return uuid.UUID{}, 0, 0, errStub
}
func (t *OrgTx) BoardHead(ctx context.Context, uid string) (BoardHead, error) {
	return BoardHead{}, errStub
}
func (t *OrgTx) MoveBoardHead(ctx context.Context, id uuid.UUID, version int64, title string) error {
	return errStub
}
func (t *OrgTx) SoftDeleteBoard(ctx context.Context, id uuid.UUID) error { return errStub }
func (t *OrgTx) ListBoards(ctx context.Context) ([]core.BoardSummary, bool, error) {
	return nil, false, errStub
}
func (t *OrgTx) BoardID(ctx context.Context, uid string) (uuid.UUID, string, error) {
	return uuid.UUID{}, "", errStub
}
func (t *OrgTx) Star(ctx context.Context, user, board uuid.UUID) error   { return errStub }
func (t *OrgTx) Unstar(ctx context.Context, user, board uuid.UUID) error { return errStub }
func (t *OrgTx) ListStarred(ctx context.Context, user uuid.UUID) ([]core.BoardRef, error) {
	return nil, errStub
}
func (t *OrgTx) RecordView(ctx context.Context, user, board uuid.UUID) error { return errStub }
func (t *OrgTx) ListRecent(ctx context.Context, user uuid.UUID, limit int) ([]core.BoardRef, error) {
	return nil, errStub
}
