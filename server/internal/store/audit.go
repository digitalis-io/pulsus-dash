package store

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/spec"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/dbgen"
)

// auditClass is the default audit retention class (T11 Table 4.11a): every row is stamped 13
// until retention_policies exists.
const auditClass = 13

// auditTimeFormat is the at field of the audit hash input: UTC with microseconds, as stored.
const auditTimeFormat = "2006-01-02T15:04:05.000000Z"

// PartitionReport is the result of one audit partition maintenance run: leaves created and
// dropped, and the horizon in whole months after the current one (−1 when the current month has
// no valid leaf).
type PartitionReport struct{ Created, Dropped, Horizon int }

// AppendAudit appends ev to the organisation's hash chain inside the caller's transaction
// (T11-017): it takes the organisation's audit lock, reads the chain head, stamps at strictly
// after the previous event, inserts the row and moves the head. A rollback undoes both. It
// returns the event as stored.
func (t *OrgTx) AppendAudit(ctx context.Context, ev core.AuditEvent) (core.AuditEvent, error) {
	if err := t.q.AuditLock(ctx, pgUUID(t.org)); err != nil {
		return ev, fmt.Errorf("store: audit lock: %w", err)
	}
	var prev []byte
	var prevAt time.Time
	head, err := t.q.AuditChainHead(ctx, pgUUID(t.org))
	switch {
	case err == nil:
		prev, prevAt = head.LastHash, head.LastAt.Time
	case !errors.Is(err, pgx.ErrNoRows):
		return ev, fmt.Errorf("store: audit chain head: %w", err)
	}
	ev.At = ev.At.UTC().Truncate(time.Microsecond)
	if !prevAt.IsZero() {
		if next := prevAt.UTC().Add(time.Microsecond); ev.At.Before(next) {
			ev.At = next
		}
	}
	hash, err := AuditHash(prev, t.org, ev)
	if err != nil {
		return ev, err
	}
	err = t.q.InsertAudit(ctx, dbgen.InsertAuditParams{
		OrgID: pgUUID(t.org), Rclass: auditClass, At: pgtype.Timestamptz{Time: ev.At, Valid: true}, ID: pgUUID(ev.ID),
		ActorKind: string(ev.Actor.Kind), Action: ev.Action, Hash: hash[:], ActorID: nullUUID(ev.Actor.ID),
		ResourceKind: nullText(ev.ResourceKind), ResourceID: nullText(ev.ResourceID), Diff: ev.Diff,
		RequestID: nullText(ev.RequestID), PrevHash: prev,
	})
	if err != nil {
		return ev, fmt.Errorf("store: insert audit event: %w", err)
	}
	err = t.q.UpsertAuditChainHead(ctx, dbgen.UpsertAuditChainHeadParams{
		OrgID: pgUUID(t.org), LastAt: pgtype.Timestamptz{Time: ev.At, Valid: true}, LastID: pgUUID(ev.ID), LastHash: hash[:]})
	if err != nil {
		return ev, fmt.Errorf("store: audit chain head: %w", err)
	}
	return ev, nil
}

// AuditHash is sha256(prev ‖ Canonical(event)) over the fields action, actor_id, actor_kind, at,
// diff, id, org_id, request_id, resource_id and resource_kind; at is UTC with microseconds, and an
// absent actor_id, request_id or diff is JSON null (T11-017).
func AuditHash(prev []byte, org core.OrgID, ev core.AuditEvent) ([32]byte, error) {
	var actorID, requestID any
	if ev.Actor.ID != uuid.Nil {
		actorID = ev.Actor.ID.String()
	}
	if ev.RequestID != "" {
		requestID = ev.RequestID
	}
	var diff any
	if ev.Diff != nil {
		diff = json.RawMessage(ev.Diff)
	}
	canon, err := spec.Canonical(map[string]any{
		"action": ev.Action, "actor_id": actorID, "actor_kind": string(ev.Actor.Kind),
		"at": ev.At.UTC().Format(auditTimeFormat), "diff": diff, "id": ev.ID.String(), "org_id": org.String(),
		"request_id": requestID, "resource_id": ev.ResourceID, "resource_kind": ev.ResourceKind,
	})
	if err != nil {
		return [32]byte{}, fmt.Errorf("store: audit hash: %w", err)
	}
	h := sha256.New()
	h.Write(prev)
	h.Write(canon)
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out, nil
}
