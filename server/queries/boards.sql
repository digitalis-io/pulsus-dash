-- Boards, folders, stars, recent views and audit events (plan #61 §3.2). Every query names
-- org_id = $1 explicitly (T11-002) in addition to the row-level security policies.

-- name: EnsureRootFolder :exec
INSERT INTO folders (org_id, id, uid, title, path) VALUES ($1, $2, 'root', 'Root', '/') ON CONFLICT (org_id, uid) DO NOTHING;

-- name: RootFolderID :one
SELECT id FROM folders WHERE org_id = $1 AND uid = 'root';

-- name: InsertBoard :one
INSERT INTO boards (org_id, id, uid, folder_id, title, head_version, etag) VALUES ($1, $2, $3, $4, $5, 1, 1)
ON CONFLICT (org_id, uid) DO NOTHING RETURNING id;

-- name: InsertBoardVersion :exec
INSERT INTO board_versions (org_id, board_id, version, spec, schema_version, content_hash, author_kind, author_id, message, source)
VALUES ($1, $2, $3, $4, $5, $6, $7, sqlc.narg(author_id), sqlc.narg(message), $8);

-- name: LockBoard :one
SELECT id, etag, head_version FROM boards WHERE org_id = $1 AND uid = $2 AND deleted_at IS NULL FOR UPDATE;

-- name: GetBoardHead :one
SELECT b.id, b.uid, b.title, b.head_version, b.etag, v.spec, v.schema_version, v.content_hash, v.created_at, v.author_kind, v.author_id
FROM boards b JOIN board_versions v ON v.org_id = b.org_id AND v.board_id = b.id AND v.version = b.head_version
WHERE b.org_id = $1 AND b.uid = $2 AND b.deleted_at IS NULL;

-- name: MoveBoardHead :exec
UPDATE boards SET head_version = $3, etag = etag + 1, title = $4 WHERE org_id = $1 AND id = $2;

-- name: SoftDeleteBoard :exec
UPDATE boards SET deleted_at = now(), etag = etag + 1 WHERE org_id = $1 AND id = $2;

-- name: ListBoards :many
SELECT b.id, b.uid, b.title, b.head_version, b.etag, v.schema_version, v.created_at, v.author_kind, v.author_id
FROM boards b JOIN board_versions v ON v.org_id = b.org_id AND v.board_id = b.id AND v.version = b.head_version
WHERE b.org_id = $1 AND b.deleted_at IS NULL ORDER BY v.created_at DESC, b.uid LIMIT 1001;

-- name: BoardIDByUID :one
SELECT id, title FROM boards WHERE org_id = $1 AND uid = $2 AND deleted_at IS NULL;

-- name: AuditLock :exec
SELECT pg_advisory_xact_lock(hashtext($1::uuid::text));

-- name: AuditChainHead :one
SELECT last_at, last_hash FROM audit_chain_heads WHERE org_id = $1 FOR UPDATE;

-- name: UpsertAuditChainHead :exec
INSERT INTO audit_chain_heads (org_id, last_at, last_id, last_hash) VALUES ($1, $2, $3, $4)
ON CONFLICT (org_id) DO UPDATE SET last_at = excluded.last_at, last_id = excluded.last_id, last_hash = excluded.last_hash;

-- name: InsertAudit :exec
INSERT INTO audit_events (org_id, rclass, at, id, actor_kind, actor_id, action, resource_kind, resource_id, diff, request_id, prev_hash, hash)
VALUES ($1, $2, $3, $4, $5, sqlc.narg(actor_id), $6, sqlc.narg(resource_kind), sqlc.narg(resource_id), sqlc.narg(diff), sqlc.narg(request_id), sqlc.narg(prev_hash), $7);

-- name: Star :exec
INSERT INTO stars (org_id, user_id, kind, object_id) VALUES ($1, $2, 'board', $3) ON CONFLICT DO NOTHING;

-- name: Unstar :exec
DELETE FROM stars WHERE org_id = $1 AND user_id = $2 AND kind = 'board' AND object_id = $3;

-- name: ListStarred :many
SELECT b.uid, b.title FROM stars s JOIN boards b ON b.org_id = s.org_id AND b.id = s.object_id
WHERE s.org_id = $1 AND s.user_id = $2 AND s.kind = 'board' AND b.deleted_at IS NULL ORDER BY lower(b.title), b.uid LIMIT 200;

-- name: RecentLock :exec
-- Serialises RecordView per (org, user) until commit (plan #61 review r1 #2).
SELECT pg_advisory_xact_lock(hashtext(sqlc.arg(org_id)::uuid::text || ':' || sqlc.arg(user_id)::uuid::text));

-- name: UpsertRecent :exec
-- viewed_at is the client's navigation time clamped to [now() - 1 day, now() + 5 minutes], or now();
-- the greater time wins, so a view that commits late never moves a board above a later view.
-- Tie: if another of the user's rows is in [v, v + 1 ms), v becomes its max + 1 µs, so the later
-- write (the later holder of the per-user advisory lock) sorts first.
WITH c AS (SELECT LEAST(GREATEST(COALESCE(sqlc.narg(at)::timestamptz, now()), now() - interval '1 day'), now() + interval '5 minutes') AS v)
INSERT INTO recent_views (org_id, user_id, kind, id, viewed_at)
SELECT sqlc.arg(org_id), sqlc.arg(user_id), 'board', sqlc.arg(id), GREATEST(c.v, (SELECT max(r.viewed_at) + interval '1 microsecond'
  FROM recent_views r WHERE r.org_id = sqlc.arg(org_id) AND r.user_id = sqlc.arg(user_id) AND r.kind = 'board'
  AND r.id <> sqlc.arg(id) AND r.viewed_at >= c.v AND r.viewed_at < c.v + interval '1 millisecond')) FROM c
ON CONFLICT (org_id, user_id, kind, id) DO UPDATE SET viewed_at = GREATEST(recent_views.viewed_at, excluded.viewed_at);

-- name: TrimRecent :exec
DELETE FROM recent_views d WHERE d.org_id = $1 AND d.user_id = $2 AND d.kind = 'board' AND d.id NOT IN (
  SELECT k.id FROM recent_views k WHERE k.org_id = $1 AND k.user_id = $2 AND k.kind = 'board' ORDER BY k.viewed_at DESC, k.id DESC LIMIT 200);

-- name: ListRecent :many
SELECT b.uid, b.title FROM recent_views r JOIN boards b ON b.org_id = r.org_id AND b.id = r.id
WHERE r.org_id = $1 AND r.user_id = $2 AND r.kind = 'board' AND b.deleted_at IS NULL ORDER BY r.viewed_at DESC, r.id DESC LIMIT $3;
