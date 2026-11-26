-- +goose Up
-- Board tags cache (T24 §6, T11 §4.3, #215): metadata-only; boards_tags_max is validated by I4 (#218).
-- tags caches the head spec's tags; a row is fresh iff tags_version = head_version (T24-029). The
-- defaults are constants, so adding the columns rewrites no row (T11-013), and NOT VALID skips
-- the scan; new and updated rows are checked at once.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
ALTER TABLE boards ADD COLUMN tags text[] NOT NULL DEFAULT '{}', ADD COLUMN tags_version bigint NOT NULL DEFAULT 0;
ALTER TABLE boards ADD CONSTRAINT boards_tags_max CHECK (cardinality(tags) <= 16) NOT VALID;
