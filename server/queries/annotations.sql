-- Annotations (plan #64 Part C §3.2, plan #222 §3.3). Every query names org_id explicitly
-- (T11-002) in addition to the row-level security policy. The data scope predicate P (T24 §5.9,
-- T12-018) is byte-identical in ListAnnotations and DeleteAnnotation between its markers
-- (TestScopePredicateShared): full scope, or an entity row that a compiled clause matches.
-- Organisation-wide rows (entity_key NULL) pass P only with full scope.

-- name: InsertAnnotation :exec
INSERT INTO annotations (org_id, id, at, end_at, kind, text, tags, author_kind, author_id, entity_key, entity)
VALUES ($1, $2, $3, sqlc.narg(end_at), $4, $5, $6, $7, sqlc.narg(author_id), sqlc.narg(entity_key), sqlc.narg(entity)::jsonb);

-- name: TenantBindingIDBySlug :one
SELECT id FROM tenant_bindings WHERE org_id = $1 AND slug = $2;

-- name: ListAnnotations :many
-- ONE statement (T24-032): the rows, the next cursor and org_wide_hidden are one snapshot. It
-- always returns at least one row: with no match the joined columns are NULL and found is false.
-- lim is limit + 1. Overlapping [from_at, to_at]: at <= to AND coalesce(end_at, at) >= from; a
-- range is at most 31 days (the table CHECK), so the lower bound on `at` is exact.
WITH base AS (
  SELECT a.id, a.at, a.end_at, a.kind, a.text, a.tags, a.entity_key, a.entity FROM annotations a
  WHERE a.org_id = sqlc.arg(org_id)
    AND a.at <= sqlc.arg(to_at)::timestamptz AND a.at >= sqlc.arg(from_at)::timestamptz - interval '31 days'
    AND coalesce(a.end_at, a.at) >= sqlc.arg(from_at)::timestamptz
    AND (cardinality(sqlc.arg(kinds)::text[]) = 0 OR a.kind = ANY (sqlc.arg(kinds)::text[]))
    AND a.tags @> sqlc.arg(tags)::text[]
    -- P begin
    AND (sqlc.arg(scope_full)::boolean OR (a.entity_key IS NOT NULL AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(sqlc.arg(scope)::jsonb) c
      WHERE c->>'k' = a.entity->>'kind'
        AND (c->'b' IS NULL OR c->'b' @> jsonb_build_array(a.entity->>'binding_id'))
        AND NOT EXISTS (SELECT 1 FROM jsonb_each(c->'a') kv
                        WHERE NOT kv.value @> jsonb_build_array(a.entity->'attrs'->>kv.key)))))
    -- P end
),
f AS (SELECT * FROM base WHERE cardinality(sqlc.arg(ents)::text[]) = 0 OR entity_key = ANY (sqlc.arg(ents)::text[])
        OR (sqlc.arg(org_wide)::boolean AND entity_key IS NULL)),
st AS (SELECT count(*) FILTER (WHERE cardinality(sqlc.arg(ents)::text[]) > 0 AND NOT sqlc.arg(org_wide)::boolean
        AND entity_key IS NULL)::bigint AS org_wide_hidden FROM base)
SELECT st.org_wide_hidden, (h.id IS NOT NULL)::boolean AS found, h.id, h.at, h.end_at,
       coalesce(h.kind, '')::text AS kind, coalesce(h.text, '')::text AS text, coalesce(h.tags, '{}')::text[] AS tags,
       h.entity_key, h.entity
FROM st LEFT JOIN LATERAL (SELECT * FROM f
  WHERE NOT sqlc.arg(has_before)::boolean OR (f.at, f.id) < (sqlc.arg(before_at)::timestamptz, sqlc.arg(before_id)::uuid)
  ORDER BY f.at DESC, f.id DESC LIMIT sqlc.arg(lim)::int) h ON true
ORDER BY h.at DESC NULLS LAST, h.id DESC;

-- name: DeleteAnnotation :one
-- A row outside P matches nothing: the same no-row answer as an absent id (T24 §5.9).
DELETE FROM annotations a WHERE a.org_id = sqlc.arg(org_id) AND a.id = sqlc.arg(id)
    -- P begin
    AND (sqlc.arg(scope_full)::boolean OR (a.entity_key IS NOT NULL AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(sqlc.arg(scope)::jsonb) c
      WHERE c->>'k' = a.entity->>'kind'
        AND (c->'b' IS NULL OR c->'b' @> jsonb_build_array(a.entity->>'binding_id'))
        AND NOT EXISTS (SELECT 1 FROM jsonb_each(c->'a') kv
                        WHERE NOT kv.value @> jsonb_build_array(a.entity->'attrs'->>kv.key)))))
    -- P end
RETURNING a.id, a.at, a.end_at, a.kind, a.text, a.tags, a.entity_key, a.entity;
