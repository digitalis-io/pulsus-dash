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

// BoardSummary is a board's head as the list shows it. Tags are the head spec's tags when
// TagsFresh (T24-029); a stale cache row has TagsFresh false and no tags (JSON null: not yet
// known).
type BoardSummary struct {
	UID, Title string
	Version    int64
	UpdatedAt  time.Time
	UpdatedBy  Actor
	Tags       []string
	TagsFresh  bool
}

// BoardFilter is the search of GET /boards (T24-021): Q a title substring or an exact fresh tag
// (ASCII case-insensitive), Tag an exact fresh tag; "" is absent, and both must match.
type BoardFilter struct{ Q, Tag string }

// BoardPage is one answer of ListBoards: at most 1000 boards, whether more matched, and the
// organisation's live boards whose tags are not yet known (T24-029).
type BoardPage struct {
	Items     []BoardSummary
	Truncated bool
	TagsStale int64
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
	ListBoards(ctx context.Context, rc *RequestCtx, f BoardFilter) (BoardPage, error)
	GetBoard(ctx context.Context, rc *RequestCtx, uid string) (Board, error)
	CreateBoard(ctx context.Context, rc *RequestCtx, spec []byte) (Board, error)
	SaveBoard(ctx context.Context, rc *RequestCtx, uid string, ifMatch int64, spec []byte, message string) (SaveResult, error)
	DeleteBoard(ctx context.Context, rc *RequestCtx, uid string, ifMatch int64) error
	// ListStarred returns at most 200 starred boards and whether more exist.
	ListStarred(ctx context.Context, rc *RequestCtx) ([]BoardRef, bool, error)
	SetStarred(ctx context.Context, rc *RequestCtx, uid string, starred bool) error
	// ListRecent returns at most limit recently viewed boards and whether more exist.
	ListRecent(ctx context.Context, rc *RequestCtx, limit int) ([]BoardRef, bool, error)
	// RecordView records a view at the client's navigation time `at` (nil: the server's now()).
	RecordView(ctx context.Context, rc *RequestCtx, uid string, at *time.Time) error
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
