-- +goose Up
-- Event markers (plan #64 Part C §3.1, T11 §4.4): the M-UI1 source of `events/1` (T04 §11). A new,
-- empty table: no backfill and no lock on an existing table (T11-012, T11-013). entity_key stays
-- NULL until M-UI3. Unpartitioned (low volume); ranges are capped at 31 days, so the list query's
-- lower bound on `at` is exact.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
CREATE TABLE annotations (org_id uuid NOT NULL REFERENCES orgs (id), id uuid NOT NULL,
  at timestamptz NOT NULL, end_at timestamptz,
  kind text NOT NULL CHECK (kind IN ('deploy', 'config', 'flag', 'annotation')),
  entity_key text, text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 500),
  tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 16),
  author_kind text NOT NULL CHECK (author_kind IN ('local', 'user', 'service_account')), author_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at IS NULL OR (end_at >= at AND end_at - at <= interval '31 days')),
  PRIMARY KEY (org_id, id));
CREATE INDEX annotations_at ON annotations (org_id, at);
ALTER TABLE annotations ENABLE ROW LEVEL SECURITY;  ALTER TABLE annotations FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON annotations USING (org_id = pulsus_org()) WITH CHECK (org_id = pulsus_org());
GRANT SELECT, INSERT, DELETE ON annotations TO pulsus_app;
