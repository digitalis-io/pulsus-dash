-- Annotations (plan #64 Part C §3.2). Every query names org_id = $1 explicitly (T11-002) in
-- addition to the row-level security policy.

-- name: InsertAnnotation :exec
INSERT INTO annotations (org_id, id, at, end_at, kind, text, tags, author_kind, author_id)
VALUES ($1, $2, $3, sqlc.narg(end_at), $4, $5, $6, $7, sqlc.narg(author_id));

-- name: ListAnnotations :many
-- Overlapping [from_at, to_at]: at <= to AND coalesce(end_at, at) >= from. A range is at most 31
-- days (the table CHECK), so the lower bound on `at` is exact and keeps the index scan bounded.
SELECT id, at, end_at, kind, text, tags FROM annotations
WHERE org_id = $1 AND at <= sqlc.arg(to_at)::timestamptz
  AND at >= sqlc.arg(from_at)::timestamptz - interval '31 days'
  AND coalesce(end_at, at) >= sqlc.arg(from_at)::timestamptz
ORDER BY at DESC, id DESC LIMIT sqlc.arg(lim);

-- name: DeleteAnnotation :one
DELETE FROM annotations WHERE org_id = $1 AND id = $2 RETURNING id, at, end_at, kind, text, tags;
