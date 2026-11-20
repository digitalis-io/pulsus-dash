// Package boards is the boards service (plan #61 §3.6, §4.1): boards as versioned documents in
// Postgres, saved with optimistic concurrency (T11-005), an immutable version per change and one
// hash-chained audit event per write in the same transaction (T11-006, T11-017), plus the starred
// and recent boards of the principal.
package boards

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/spec"
	"github.com/digitalis-io/pulsus-dash/server/internal/store"
)

// uidAttempts bounds the retries of CreateBoard when a new uid is taken.
const uidAttempts = 5

// Recent list bounds (the gateway clamps first).
const (
	recentMin = 1
	recentMax = 50
)

// errNoFreeUID is returned when uidAttempts fresh uids were all taken.
var errNoFreeUID = errors.New("boards: no free uid")

// Service implements core.Boards over the store.
type Service struct {
	db     *store.Db
	now    func() time.Time
	newUID func() (string, error)
}

var _ core.Boards = (*Service)(nil)

// New returns the service over db (the pulsus_app pool).
func New(db *store.Db) *Service { return &Service{db: db, now: time.Now, newUID: NewUID} }

// toBoard converts a head into the API's board: the spec upcast to the current version and in
// canonical form (T11 §4.0: upcast on read, persisted on the next write).
func toBoard(h store.BoardHead) (core.Board, error) {
	b, err := spec.DecodeBoard(h.Spec, h.SchemaVersion)
	if err != nil {
		return core.Board{}, err
	}
	canon, err := spec.Canonical(b)
	if err != nil {
		return core.Board{}, err
	}
	return core.Board{
		BoardSummary:  core.BoardSummary{UID: h.UID, Title: h.Title, Version: h.Version, UpdatedAt: h.UpdatedAt, UpdatedBy: h.Author},
		ETag:          h.ETag,
		SchemaVersion: spec.BoardSchemaVersion,
		Spec:          canon,
	}, nil
}

func (s *Service) event(rc *core.RequestCtx, action, uid string, diff []byte) (core.AuditEvent, error) {
	id, err := core.NewID()
	if err != nil {
		return core.AuditEvent{}, fmt.Errorf("boards: new audit id: %w", err)
	}
	return core.AuditEvent{ID: id, At: s.now(), Actor: rc.Actor, Action: action, ResourceKind: "board",
		ResourceID: uid, RequestID: rc.RequestID, Diff: diff}, nil
}

// ListBoards returns at most 1000 boards of the organisation and whether more exist.
func (s *Service) ListBoards(ctx context.Context, rc *core.RequestCtx) ([]core.BoardSummary, bool, error) {
	var items []core.BoardSummary
	var truncated bool
	err := s.db.Tx(ctx, rc.Org, func(ctx context.Context, tx *store.OrgTx) error {
		var err error
		items, truncated, err = tx.ListBoards(ctx)
		return err
	})
	return items, truncated, err
}

// GetBoard returns a live board, or core.ErrNotFound.
func (s *Service) GetBoard(ctx context.Context, rc *core.RequestCtx, uid string) (core.Board, error) {
	var b core.Board
	err := s.db.Tx(ctx, rc.Org, func(ctx context.Context, tx *store.OrgTx) error {
		h, err := tx.BoardHead(ctx, uid)
		if err != nil {
			return err
		}
		b, err = toBoard(h)
		return err
	})
	return b, err
}

// CreateBoard validates spec and writes the board at version 1 in the organisation's root folder,
// with a board.create audit event whose diff adds the whole spec.
func (s *Service) CreateBoard(ctx context.Context, rc *core.RequestCtx, raw []byte) (core.Board, error) {
	b, err := spec.ParseBoard(raw)
	if err != nil {
		return core.Board{}, err
	}
	canon, err := spec.Canonical(b)
	if err != nil {
		return core.Board{}, err
	}
	hash := spec.ContentHash(canon)
	diff, err := spec.Diff(nil, canon)
	if err != nil {
		return core.Board{}, err
	}
	var out core.Board
	err = s.db.Tx(ctx, rc.Org, func(ctx context.Context, tx *store.OrgTx) error {
		folder, err := tx.EnsureRootFolder(ctx)
		if err != nil {
			return err
		}
		id, err := core.NewID()
		if err != nil {
			return fmt.Errorf("boards: new board id: %w", err)
		}
		uid := ""
		for range uidAttempts {
			candidate, err := s.newUID()
			if err != nil {
				return err
			}
			ok, err := tx.InsertBoard(ctx, id, candidate, folder, b.Title)
			if err != nil {
				return err
			}
			if ok {
				uid = candidate
				break
			}
		}
		if uid == "" {
			return errNoFreeUID
		}
		if err := tx.InsertBoardVersion(ctx, store.NewBoardVersion{BoardID: id, Version: 1, SchemaVersion: spec.BoardSchemaVersion,
			Spec: canon, ContentHash: hash[:], Author: rc.Actor}); err != nil {
			return err
		}
		ev, err := s.event(rc, "board.create", uid, diff)
		if err != nil {
			return err
		}
		if _, err := tx.AppendAudit(ctx, ev); err != nil {
			return err
		}
		h, err := tx.BoardHead(ctx, uid)
		if err != nil {
			return err
		}
		out, err = toBoard(h)
		return err
	})
	if err != nil {
		return core.Board{}, err
	}
	return out, nil
}

// SaveBoard saves spec as the next version when ifMatch equals the board's ETag (plan #61 §4.1).
// An unchanged spec is a no-op (Changed false); a stale ifMatch is a *core.ConflictError with the
// current head; a spec stored by a newer server is spec.ErrSchemaTooNew and nothing is written.
func (s *Service) SaveBoard(ctx context.Context, rc *core.RequestCtx, uid string, ifMatch int64, raw []byte, message string) (core.SaveResult, error) {
	b, err := spec.ParseBoard(raw)
	if err != nil {
		return core.SaveResult{}, err
	}
	canon, err := spec.Canonical(b)
	if err != nil {
		return core.SaveResult{}, err
	}
	hash := spec.ContentHash(canon)
	var res core.SaveResult
	err = s.db.Tx(ctx, rc.Org, func(ctx context.Context, tx *store.OrgTx) error {
		id, etag, _, err := tx.LockBoard(ctx, uid)
		if err != nil {
			return err
		}
		head, err := tx.BoardHead(ctx, uid)
		if err != nil {
			return err
		}
		if etag != ifMatch {
			cur, err := toBoard(head)
			if err != nil {
				return err
			}
			return &core.ConflictError{Current: cur}
		}
		old, err := spec.DecodeBoard(head.Spec, head.SchemaVersion)
		if err != nil {
			return err
		}
		if bytes.Equal(hash[:], head.ContentHash) {
			res.Board, err = toBoard(head)
			return err
		}
		oldCanon, err := spec.Canonical(old)
		if err != nil {
			return err
		}
		diff, err := spec.Diff(oldCanon, canon)
		if err != nil {
			return err
		}
		next := head.Version + 1
		if err := tx.InsertBoardVersion(ctx, store.NewBoardVersion{BoardID: id, Version: next, SchemaVersion: spec.BoardSchemaVersion,
			Spec: canon, ContentHash: hash[:], Author: rc.Actor, Message: message}); err != nil {
			return err
		}
		if err := tx.MoveBoardHead(ctx, id, next, b.Title); err != nil {
			return err
		}
		ev, err := s.event(rc, "board.update", uid, diff)
		if err != nil {
			return err
		}
		if _, err := tx.AppendAudit(ctx, ev); err != nil {
			return err
		}
		h, err := tx.BoardHead(ctx, uid)
		if err != nil {
			return err
		}
		res.Board, err = toBoard(h)
		res.Changed = true
		return err
	})
	if err != nil {
		return core.SaveResult{}, err
	}
	return res, nil
}

// DeleteBoard soft-deletes a board when ifMatch equals its ETag, with a board.delete audit event.
func (s *Service) DeleteBoard(ctx context.Context, rc *core.RequestCtx, uid string, ifMatch int64) error {
	return s.db.Tx(ctx, rc.Org, func(ctx context.Context, tx *store.OrgTx) error {
		id, etag, _, err := tx.LockBoard(ctx, uid)
		if err != nil {
			return err
		}
		if etag != ifMatch {
			head, err := tx.BoardHead(ctx, uid)
			if err != nil {
				return err
			}
			cur, err := toBoard(head)
			if err != nil {
				return err
			}
			return &core.ConflictError{Current: cur}
		}
		if err := tx.SoftDeleteBoard(ctx, id); err != nil {
			return err
		}
		ev, err := s.event(rc, "board.delete", uid, nil)
		if err != nil {
			return err
		}
		_, err = tx.AppendAudit(ctx, ev)
		return err
	})
}

// ListStarred returns the boards the principal starred.
func (s *Service) ListStarred(ctx context.Context, rc *core.RequestCtx) ([]core.BoardRef, error) {
	var out []core.BoardRef
	err := s.db.Tx(ctx, rc.Org, func(ctx context.Context, tx *store.OrgTx) error {
		var err error
		out, err = tx.ListStarred(ctx, rc.Actor.ID)
		return err
	})
	return out, err
}

// SetStarred stars or unstars a board for the principal. Starring an unknown or deleted board is
// core.ErrNotFound; unstarring one is a no-op.
func (s *Service) SetStarred(ctx context.Context, rc *core.RequestCtx, uid string, starred bool) error {
	return s.db.Tx(ctx, rc.Org, func(ctx context.Context, tx *store.OrgTx) error {
		id, _, err := tx.BoardID(ctx, uid)
		if errors.Is(err, core.ErrNotFound) && !starred {
			return nil
		}
		if err != nil {
			return err
		}
		if starred {
			return tx.Star(ctx, rc.Actor.ID, id)
		}
		return tx.Unstar(ctx, rc.Actor.ID, id)
	})
}

// ListRecent returns the boards the principal viewed most recently, limit clamped to 1…50.
func (s *Service) ListRecent(ctx context.Context, rc *core.RequestCtx, limit int) ([]core.BoardRef, error) {
	limit = min(max(limit, recentMin), recentMax)
	var out []core.BoardRef
	err := s.db.Tx(ctx, rc.Org, func(ctx context.Context, tx *store.OrgTx) error {
		var err error
		out, err = tx.ListRecent(ctx, rc.Actor.ID, limit)
		return err
	})
	return out, err
}

// RecordView records that the principal viewed a live board, or returns core.ErrNotFound.
func (s *Service) RecordView(ctx context.Context, rc *core.RequestCtx, uid string) error {
	return s.db.Tx(ctx, rc.Org, func(ctx context.Context, tx *store.OrgTx) error {
		id, _, err := tx.BoardID(ctx, uid)
		if err != nil {
			return err
		}
		return tx.RecordView(ctx, rc.Actor.ID, id)
	})
}
