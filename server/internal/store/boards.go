package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/dbgen"
)

// listBoardsMax is the most boards ListBoards returns; one more row is read to report truncation.
const listBoardsMax = 1000

// BoardHead is a board's head row joined with its head version.
type BoardHead struct {
	ID                           uuid.UUID
	UID, Title                   string
	Version, ETag, SchemaVersion int64
	Spec, ContentHash            []byte
	UpdatedAt                    time.Time
	Author                       core.Actor
}

// NewBoardVersion is one immutable board version, written with source 'ui'.
type NewBoardVersion struct {
	BoardID                uuid.UUID
	Version, SchemaVersion int64
	Spec, ContentHash      []byte
	Author                 core.Actor
	Message                string
}

// notFound maps pgx.ErrNoRows to core.ErrNotFound and wraps any other error.
func notFound(op string, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return core.ErrNotFound
	}
	return fmt.Errorf("store: %s: %w", op, err)
}

func nullUUID(u uuid.UUID) pgtype.UUID { return pgtype.UUID{Bytes: u, Valid: u != uuid.Nil} }

func actorOf(kind string, id pgtype.UUID) core.Actor {
	a := core.Actor{Kind: core.ActorKind(kind)}
	if id.Valid {
		a.ID = uuid.UUID(id.Bytes)
	}
	return a
}

// EnsureRootFolder creates the organisation's root folder (uid root, path /) unless it exists,
// and returns its id.
func (t *OrgTx) EnsureRootFolder(ctx context.Context) (uuid.UUID, error) {
	id, err := core.NewID()
	if err != nil {
		return uuid.UUID{}, fmt.Errorf("store: new folder id: %w", err)
	}
	if err := t.q.EnsureRootFolder(ctx, dbgen.EnsureRootFolderParams{OrgID: pgUUID(t.org), ID: pgUUID(id)}); err != nil {
		return uuid.UUID{}, fmt.Errorf("store: ensure root folder: %w", err)
	}
	got, err := t.q.RootFolderID(ctx, pgUUID(t.org))
	if err != nil {
		return uuid.UUID{}, fmt.Errorf("store: root folder: %w", err)
	}
	return uuid.UUID(got.Bytes), nil
}

// InsertBoard inserts a board head at version 1 and ETag 1. It returns false, writing nothing,
// when the uid is taken in the organisation.
func (t *OrgTx) InsertBoard(ctx context.Context, id uuid.UUID, uid string, folder uuid.UUID, title string) (bool, error) {
	_, err := t.q.InsertBoard(ctx, dbgen.InsertBoardParams{OrgID: pgUUID(t.org), ID: pgUUID(id), Uid: uid, FolderID: pgUUID(folder), Title: title})
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("store: insert board: %w", err)
	}
	return true, nil
}

// InsertBoardVersion appends an immutable version (T11-006).
func (t *OrgTx) InsertBoardVersion(ctx context.Context, v NewBoardVersion) error {
	err := t.q.InsertBoardVersion(ctx, dbgen.InsertBoardVersionParams{
		OrgID: pgUUID(t.org), BoardID: pgUUID(v.BoardID), Version: v.Version, Spec: v.Spec,
		SchemaVersion: v.SchemaVersion, ContentHash: v.ContentHash, AuthorKind: string(v.Author.Kind),
		Source: "ui", AuthorID: nullUUID(v.Author.ID), Message: nullText(v.Message),
	})
	if err != nil {
		return fmt.Errorf("store: insert board version: %w", err)
	}
	return nil
}

// LockBoard locks a live board's head row (FOR UPDATE) and returns its id, ETag and head
// version, or core.ErrNotFound.
func (t *OrgTx) LockBoard(ctx context.Context, uid string) (uuid.UUID, int64, int64, error) {
	r, err := t.q.LockBoard(ctx, dbgen.LockBoardParams{OrgID: pgUUID(t.org), Uid: uid})
	if err != nil {
		return uuid.UUID{}, 0, 0, notFound("lock board", err)
	}
	return uuid.UUID(r.ID.Bytes), r.Etag, r.HeadVersion, nil
}

// BoardHead reads a live board's head with its head version, or core.ErrNotFound.
func (t *OrgTx) BoardHead(ctx context.Context, uid string) (BoardHead, error) {
	r, err := t.q.GetBoardHead(ctx, dbgen.GetBoardHeadParams{OrgID: pgUUID(t.org), Uid: uid})
	if err != nil {
		return BoardHead{}, notFound("board head", err)
	}
	return BoardHead{
		ID: uuid.UUID(r.ID.Bytes), UID: r.Uid, Title: r.Title, Version: r.HeadVersion, ETag: r.Etag,
		SchemaVersion: r.SchemaVersion, Spec: r.Spec, ContentHash: r.ContentHash,
		UpdatedAt: r.CreatedAt.Time, Author: actorOf(r.AuthorKind, r.AuthorID),
	}, nil
}

// MoveBoardHead points the board at version, sets its title and increments its ETag.
func (t *OrgTx) MoveBoardHead(ctx context.Context, id uuid.UUID, version int64, title string) error {
	if err := t.q.MoveBoardHead(ctx, dbgen.MoveBoardHeadParams{OrgID: pgUUID(t.org), ID: pgUUID(id), HeadVersion: version, Title: title}); err != nil {
		return fmt.Errorf("store: move board head: %w", err)
	}
	return nil
}

// SoftDeleteBoard marks the board deleted and increments its ETag; its versions are kept.
func (t *OrgTx) SoftDeleteBoard(ctx context.Context, id uuid.UUID) error {
	if err := t.q.SoftDeleteBoard(ctx, dbgen.SoftDeleteBoardParams{OrgID: pgUUID(t.org), ID: pgUUID(id)}); err != nil {
		return fmt.Errorf("store: delete board: %w", err)
	}
	return nil
}

// ListBoards returns at most 1000 live boards, most recently updated first, and whether more
// exist.
func (t *OrgTx) ListBoards(ctx context.Context) ([]core.BoardSummary, bool, error) {
	rows, err := t.q.ListBoards(ctx, pgUUID(t.org))
	if err != nil {
		return nil, false, fmt.Errorf("store: list boards: %w", err)
	}
	truncated := len(rows) > listBoardsMax
	if truncated {
		rows = rows[:listBoardsMax]
	}
	out := make([]core.BoardSummary, 0, len(rows))
	for _, r := range rows {
		out = append(out, core.BoardSummary{UID: r.Uid, Title: r.Title, Version: r.HeadVersion,
			UpdatedAt: r.CreatedAt.Time, UpdatedBy: actorOf(r.AuthorKind, r.AuthorID)})
	}
	return out, truncated, nil
}

// BoardID returns a live board's id and title, or core.ErrNotFound.
func (t *OrgTx) BoardID(ctx context.Context, uid string) (uuid.UUID, string, error) {
	r, err := t.q.BoardIDByUID(ctx, dbgen.BoardIDByUIDParams{OrgID: pgUUID(t.org), Uid: uid})
	if err != nil {
		return uuid.UUID{}, "", notFound("board id", err)
	}
	return uuid.UUID(r.ID.Bytes), r.Title, nil
}

// Star stars the board for user; starring twice is a no-op.
func (t *OrgTx) Star(ctx context.Context, user, board uuid.UUID) error {
	if err := t.q.Star(ctx, dbgen.StarParams{OrgID: pgUUID(t.org), UserID: pgUUID(user), ObjectID: pgUUID(board)}); err != nil {
		return fmt.Errorf("store: star: %w", err)
	}
	return nil
}

// Unstar removes the star; unstarring a board that is not starred is a no-op.
func (t *OrgTx) Unstar(ctx context.Context, user, board uuid.UUID) error {
	if err := t.q.Unstar(ctx, dbgen.UnstarParams{OrgID: pgUUID(t.org), UserID: pgUUID(user), ObjectID: pgUUID(board)}); err != nil {
		return fmt.Errorf("store: unstar: %w", err)
	}
	return nil
}

func refs(op string, uids, titles []string, err error) ([]core.BoardRef, error) {
	if err != nil {
		return nil, fmt.Errorf("store: %s: %w", op, err)
	}
	out := make([]core.BoardRef, 0, len(uids))
	for i := range uids {
		out = append(out, core.BoardRef{UID: uids[i], Title: titles[i]})
	}
	return out, nil
}

// ListStarred returns at most 200 live boards the user starred, ordered by title.
func (t *OrgTx) ListStarred(ctx context.Context, user uuid.UUID) ([]core.BoardRef, error) {
	rows, err := t.q.ListStarred(ctx, dbgen.ListStarredParams{OrgID: pgUUID(t.org), UserID: pgUUID(user)})
	var uids, titles []string
	for _, r := range rows {
		uids, titles = append(uids, r.Uid), append(titles, r.Title)
	}
	return refs("list starred", uids, titles, err)
}

// RecordView records that user viewed the board now and keeps the user's 200 most recent views
// (T11 §4.3). A transaction-scoped advisory lock on (org, user) serialises concurrent views, so
// that each trim sees the other's insert and the limit holds.
func (t *OrgTx) RecordView(ctx context.Context, user, board uuid.UUID, at *time.Time) error {
	_ = at
	if err := t.q.RecentLock(ctx, dbgen.RecentLockParams{OrgID: pgUUID(t.org), UserID: pgUUID(user)}); err != nil {
		return fmt.Errorf("store: recent lock: %w", err)
	}
	if err := t.q.UpsertRecent(ctx, dbgen.UpsertRecentParams{OrgID: pgUUID(t.org), UserID: pgUUID(user), ID: pgUUID(board)}); err != nil {
		return fmt.Errorf("store: record view: %w", err)
	}
	if err := t.q.TrimRecent(ctx, dbgen.TrimRecentParams{OrgID: pgUUID(t.org), UserID: pgUUID(user)}); err != nil {
		return fmt.Errorf("store: trim recent: %w", err)
	}
	return nil
}

// ListRecent returns at most limit live boards the user viewed, most recent first.
func (t *OrgTx) ListRecent(ctx context.Context, user uuid.UUID, limit int) ([]core.BoardRef, error) {
	rows, err := t.q.ListRecent(ctx, dbgen.ListRecentParams{OrgID: pgUUID(t.org), UserID: pgUUID(user), Limit: int32(min(max(limit, 0), 200))}) //nolint:gosec // clamped to 0…200
	var uids, titles []string
	for _, r := range rows {
		uids, titles = append(uids, r.Uid), append(titles, r.Title)
	}
	return refs("list recent", uids, titles, err)
}
