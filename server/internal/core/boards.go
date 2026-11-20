package core

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

// ErrNotFound is returned when a board does not exist, is deleted, or belongs to another
// organisation.
var ErrNotFound = errors.New("not found")

// BoardSummary is a board's head as the list shows it.
type BoardSummary struct {
	UID, Title string
	Version    int64
	UpdatedAt  time.Time
	UpdatedBy  Actor
}

// Board is a board's head with its spec: canonical JSON at the current schema version (upcast on
// read, T11 §4.0).
type Board struct {
	BoardSummary
	ETag          int64
	SchemaVersion int64
	Spec          []byte
}

// SaveResult is the outcome of a save. Changed is false when the spec equals the head (no
// version, no audit event, ETag unchanged).
type SaveResult struct {
	Board   Board
	Changed bool
}

// BoardRef names a board in the starred and recent lists.
type BoardRef struct{ UID, Title string }

// ConflictError is returned when If-Match does not equal the board's ETag (T11-005). Current is
// the head the caller must merge with.
type ConflictError struct{ Current Board }

func (e *ConflictError) Error() string { return "board changed since it was read" }

// Boards is the boards service (internal/boards). Every write runs in one organisation-bound
// transaction and appends one audit event (T11-006).
type Boards interface {
	ListBoards(ctx context.Context, rc *RequestCtx) (items []BoardSummary, truncated bool, err error)
	GetBoard(ctx context.Context, rc *RequestCtx, uid string) (Board, error)
	CreateBoard(ctx context.Context, rc *RequestCtx, spec []byte) (Board, error)
	SaveBoard(ctx context.Context, rc *RequestCtx, uid string, ifMatch int64, spec []byte, message string) (SaveResult, error)
	DeleteBoard(ctx context.Context, rc *RequestCtx, uid string, ifMatch int64) error
	ListStarred(ctx context.Context, rc *RequestCtx) ([]BoardRef, error)
	SetStarred(ctx context.Context, rc *RequestCtx, uid string, starred bool) error
	ListRecent(ctx context.Context, rc *RequestCtx, limit int) ([]BoardRef, error)
	RecordView(ctx context.Context, rc *RequestCtx, uid string) error
}

// AuditEvent is one row of audit_events (T11-017). Diff is canonical JSON (an RFC 6902 patch) or
// nil.
type AuditEvent struct {
	ID                                          uuid.UUID
	At                                          time.Time
	Actor                                       Actor
	Action, ResourceKind, ResourceID, RequestID string
	Diff                                        []byte
}

// AuditRetentionMonths is the retention of the default audit class (rclass 13) until
// retention_policies exists (T11-009).
const AuditRetentionMonths = 13
