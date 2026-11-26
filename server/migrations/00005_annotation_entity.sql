-- +goose Up
-- Annotation entity (T24 §6, T11 §4.4, #222): metadata-only; NOT VALID, I7 (#224) validates.
-- entity is the canonical entity {id, binding, binding_id, kind, ident, attrs} whose EntityId is
-- entity_key; the two are set or NULL together. Adding a nullable column without a default
-- rewrites no row (T11-013), and NOT VALID skips the scan of existing rows (all NULL/NULL); new
-- and updated rows are checked at once, so a schema-4 binary's writes (NULL/NULL) pass.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
ALTER TABLE annotations ADD COLUMN entity jsonb;
ALTER TABLE annotations ADD CONSTRAINT annotations_entity_pair CHECK ((entity_key IS NULL) = (entity IS NULL)) NOT VALID;
