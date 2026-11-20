-- +goose Up
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

-- +goose StatementBegin
CREATE FUNCTION pulsus_org() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('pulsus.org_id', true), '')::uuid $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE FUNCTION pulsus_floor(domain text) RETURNS timestamptz LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('pulsus.floor.' || domain, true), '')::timestamptz $$;
-- +goose StatementEnd

CREATE TABLE orgs (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}', perms_epoch bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);
CREATE TABLE tenant_bindings (org_id uuid REFERENCES orgs (id), id uuid, slug text NOT NULL,
  datasource_url text NOT NULL, database text,
  scope_org_id text CHECK (scope_org_id ~ '^[A-Za-z0-9_.-]{1,150}$'),
  -- ◆ a reference, never a value: env:NAME, or file:/ and 1 to 1023 non-space characters
  -- (the length is a separate test because Postgres regular expressions cap repeats at 255)
  credentials_ref text CHECK (credentials_ref IS NULL
    OR (credentials_ref ~ '^(env:[A-Za-z_][A-Za-z0-9_]{0,127}|file:/[^[:space:]]+)$'
        AND char_length(credentials_ref) <= 1029)),
  kind text NOT NULL DEFAULT 'pulsusdb',
  PRIMARY KEY (org_id, id), UNIQUE (org_id, slug));
-- ◆ non-tenant: written once by the first-run seed (migrate), read by serve
CREATE TABLE install_state (singleton bool PRIMARY KEY DEFAULT true CHECK (singleton),
  bootstrap_org_id uuid NOT NULL REFERENCES orgs (id), seeded_at timestamptz NOT NULL DEFAULT now());

-- RLS template (T11-003), one block per tenant table
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON orgs USING (id = pulsus_org()) WITH CHECK (id = pulsus_org());
ALTER TABLE tenant_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON tenant_bindings
  USING (org_id = pulsus_org()) WITH CHECK (org_id = pulsus_org());

GRANT USAGE ON SCHEMA public TO pulsus_app, pulsus_maint;
GRANT SELECT, INSERT, UPDATE, DELETE ON orgs, tenant_bindings TO pulsus_app;
GRANT SELECT ON install_state, goose_db_version TO pulsus_app, pulsus_maint;
