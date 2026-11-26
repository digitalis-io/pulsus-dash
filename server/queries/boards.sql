-- Boards, folders, stars, recent views and audit events (plan #61 §3.2). Every query names
-- org_id = $1 explicitly (T11-002) in addition to the row-level security policies.

-- name: EnsureRootFolder :exec
INSERT INTO folders (org_id, id, uid, title, path) VALUES ($1, $2, 'root', 'Root', '/') ON CONFLICT (org_id, uid) DO NOTHING;

-- name: RootFolderID :one
SELECT id FROM folders WHERE org_id = $1 AND uid = 'root';

-- name: InsertBoard :one
-- The head at version 1 with its tags cache fresh (tags_version = head_version, T24-029).
INSERT INTO boards (org_id, id, uid, folder_id, title, head_version, etag, tags, tags_version)
VALUES ($1, $2, $3, $4, $5, 1, 1, sqlc.arg(tags)::text[], 1) ON CONFLICT (org_id, uid) DO NOTHING RETURNING id;

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
-- Every head move by this binary refreshes the tags cache (T24-029).
UPDATE boards SET head_version = $3, etag = etag + 1, title = $4, tags = sqlc.arg(tags)::text[], tags_version = $3
WHERE org_id = $1 AND id = $2;

-- name: SoftDeleteBoard :exec
UPDATE boards SET deleted_at = now(), etag = etag + 1 WHERE org_id = $1 AND id = $2;

-- name: RepairBoardTags :execrows
-- Refreshes at most 200 stale cache rows of the organisation from their head specs (T24-029); rows
-- a save holds (FOR UPDATE) are skipped, never waited for. No audit event, no ETag change.
WITH s AS (SELECT id FROM boards WHERE org_id = $1 AND deleted_at IS NULL AND tags_version <> head_version
           ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED)
UPDATE boards b SET tags = coalesce(ARRAY(SELECT jsonb_array_elements_text(v.spec->'tags')), '{}'), tags_version = b.head_version
FROM s, board_versions v
WHERE b.org_id = $1 AND b.id = s.id AND v.org_id = $1 AND v.board_id = b.id AND v.version = b.head_version;

-- name: ListBoards :many
-- One statement (T24-029): the matching boards (at most 1001, most recently updated first), and
-- tagsStale, the organisation's live stale rows. With no match it returns one row with found false.
-- q is a title substring (strpos: % and _ are literal) or an exact fresh tag, folded ASCII-only
-- (COLLATE "C"); tag is an exact fresh tag; "" is absent. A stale row matches by title only.
WITH m AS (
  SELECT b.uid, b.title, b.tags, b.tags_version = b.head_version AS fresh, b.head_version, v.created_at, v.author_kind, v.author_id,
         (sqlc.arg(q)::text = '' OR strpos(lower(b.title COLLATE "C"), lower(sqlc.arg(q)::text COLLATE "C")) > 0
            OR (b.tags_version = b.head_version AND lower(sqlc.arg(q)::text COLLATE "C") = ANY (b.tags)))
     AND (sqlc.arg(tag)::text = '' OR (b.tags_version = b.head_version AND sqlc.arg(tag)::text = ANY (b.tags))) AS hit
  FROM boards b JOIN board_versions v ON v.org_id = b.org_id AND v.board_id = b.id AND v.version = b.head_version
  WHERE b.org_id = sqlc.arg(org_id) AND b.deleted_at IS NULL),
st AS (SELECT count(*) FILTER (WHERE NOT fresh) AS tags_stale FROM m)
SELECT st.tags_stale, (h.uid IS NOT NULL)::boolean AS found, coalesce(h.uid, '')::text AS uid, coalesce(h.title, '')::text AS title,
       coalesce(h.fresh, false)::boolean AS fresh, coalesce(CASE WHEN h.fresh THEN h.tags END, '{}')::text[] AS tags,
       coalesce(h.head_version, 0)::bigint AS head_version, h.created_at, coalesce(h.author_kind, '')::text AS author_kind, h.author_id
FROM st LEFT JOIN LATERAL (SELECT * FROM m WHERE hit ORDER BY created_at DESC, uid LIMIT 1001) h ON true
ORDER BY h.created_at DESC NULLS LAST, h.uid;

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
WHERE s.org_id = $1 AND s.user_id = $2 AND s.kind = 'board' AND b.deleted_at IS NULL ORDER BY lower(b.title), b.uid LIMIT 201;

-- name: RecentLock :exec
-- Serialises RecordView per (org, user) until commit (plan #61 review r1 #2).
SELECT pg_advisory_xact_lock(hashtext(sqlc.arg(org_id)::uuid::text || ':' || sqlc.arg(user_id)::uuid::text));

-- name: UpsertRecent :exec
-- viewed_at is the client's navigation time clamped to [now() - 1 day, now() + 5 minutes], or now()
-- (transaction start, not commit order, for nil and clamped stamps); the greater stored time wins,
-- so within one app instance (monotonic stamps) a view inside the window that commits late never
-- moves a board above a later in-window view. Clamped views order by transaction start, best
-- effort; across app instances the order is best effort (clock skew) (D-RECENT-window).
-- Tie: the user's other rows in v's millisecond m are renumbered, in their order, to m + 998 µs,
-- m + 997 µs, …, and v becomes m + 999 µs, so the later write (the later holder of the per-user
-- advisory lock) sorts first. A tie never leaves m and never runs out: the trim keeps at most
-- 201 rows per user, fewer than the 999 slots below m + 999 µs.
WITH c AS (SELECT LEAST(GREATEST(COALESCE(sqlc.narg(at)::timestamptz, now()), now() - interval '1 day'), now() + interval '5 minutes') AS v),
m AS (SELECT c.v, date_trunc('milliseconds', c.v) AS lo FROM c),
t AS (SELECT r.id, row_number() OVER (ORDER BY r.viewed_at DESC, r.id DESC) AS k FROM recent_views r, m
  WHERE r.org_id = sqlc.arg(org_id) AND r.user_id = sqlc.arg(user_id) AND r.kind = 'board' AND r.id <> sqlc.arg(id)
  AND r.viewed_at >= m.lo AND r.viewed_at < m.lo + interval '1 millisecond'),
renumbered AS (UPDATE recent_views r SET viewed_at = m.lo + (999 - t.k) * interval '1 microsecond' FROM t, m
  WHERE r.org_id = sqlc.arg(org_id) AND r.user_id = sqlc.arg(user_id) AND r.kind = 'board' AND r.id = t.id)
INSERT INTO recent_views (org_id, user_id, kind, id, viewed_at)
SELECT sqlc.arg(org_id), sqlc.arg(user_id), 'board', sqlc.arg(id),
  CASE WHEN EXISTS (SELECT 1 FROM t) THEN m.lo + interval '999 microseconds' ELSE m.v END FROM m
ON CONFLICT (org_id, user_id, kind, id) DO UPDATE SET viewed_at = GREATEST(recent_views.viewed_at, excluded.viewed_at);

-- name: TrimRecent :exec
DELETE FROM recent_views d WHERE d.org_id = $1 AND d.user_id = $2 AND d.kind = 'board' AND d.id NOT IN (
  SELECT k.id FROM recent_views k WHERE k.org_id = $1 AND k.user_id = $2 AND k.kind = 'board' ORDER BY k.viewed_at DESC, k.id DESC LIMIT 200);

-- name: ListRecent :many
SELECT b.uid, b.title FROM recent_views r JOIN boards b ON b.org_id = r.org_id AND b.id = r.id
WHERE r.org_id = $1 AND r.user_id = $2 AND r.kind = 'board' AND b.deleted_at IS NULL ORDER BY r.viewed_at DESC, r.id DESC LIMIT $3;
