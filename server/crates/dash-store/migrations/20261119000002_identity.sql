-- Identity and access (T11 §4.2, ENT-020). users.password_hash is not created: login is OIDC only
-- (T06-022, ENT-011).
CREATE TABLE orgs (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}', perms_epoch bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);

CREATE TABLE tenant_bindings (org_id uuid REFERENCES orgs, id uuid, slug text NOT NULL,
  datasource_url text NOT NULL, database text, scope_org_id text
    CHECK (scope_org_id ~ '^[A-Za-z0-9_.-]{1,150}$'),
  credentials_ref uuid,                         -- secrets(id): Basic pair / mTLS
  kind text NOT NULL DEFAULT 'pulsusdb',        -- 'prometheus' read-only (PRN-012)
  PRIMARY KEY (org_id, id), UNIQUE (org_id, slug));

CREATE TABLE users (org_id uuid, id uuid, email text NOT NULL, display_name text,
  idp_id uuid, external_id text, active bool NOT NULL DEFAULT true,
  last_login_at timestamptz,
  PRIMARY KEY (org_id, id), UNIQUE (org_id, idp_id, external_id));
CREATE UNIQUE INDEX ON users (org_id, lower(email));

CREATE TABLE teams (org_id uuid, id uuid, uid text, name text NOT NULL, external_id text,
  idp_managed bool NOT NULL DEFAULT false, working_hours jsonb,    -- out-of-hours pages (ALR-051)
  PRIMARY KEY (org_id, id), UNIQUE (org_id, uid));
CREATE TABLE memberships (org_id uuid, team_id uuid, user_id uuid, role text NOT NULL DEFAULT 'member',
  source text NOT NULL, PRIMARY KEY (org_id, team_id, user_id));          -- source: ui|scim|idp
CREATE INDEX ON memberships (org_id, user_id);

CREATE TABLE roles (org_id uuid, id uuid, name text, builtin bool NOT NULL,
  PRIMARY KEY (org_id, id), UNIQUE (org_id, name));          -- Viewer, Responder, Editor, Admin seeded
CREATE TABLE role_permissions (org_id uuid, role_id uuid, permission text,
  PRIMARY KEY (org_id, role_id, permission));
CREATE TABLE grants (org_id uuid, id uuid, subject_kind text, subject_id uuid, role_id uuid,
  resource_kind text NOT NULL,                  -- org|folder|team|object
  resource_id uuid, source text NOT NULL,       -- ui|api|idp|terraform; 'idp' rows are read-only in the UI
  PRIMARY KEY (org_id, id));
CREATE INDEX ON grants (org_id, subject_kind, subject_id);
CREATE INDEX ON grants (org_id, resource_kind, resource_id);

CREATE TABLE idps (org_id uuid, id uuid, kind text CHECK (kind IN ('oidc','saml')), config jsonb,
  client_secret_ref uuid, PRIMARY KEY (org_id, id));

CREATE TABLE sessions (sid_hash bytea PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL,
  idp_id uuid, auth_time timestamptz, amr text[], idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL, csrf_token bytea, idp_refresh_ref uuid,
  perms_epoch bigint NOT NULL, ip inet, ua_hash bytea);
CREATE INDEX ON sessions (org_id, user_id);     -- revoke-all on SCIM deprovision

-- Row-level security on every tenant table (T11-003). sessions: no app privileges (T11-027; #40
-- adds its definer lookup).
SELECT pulsus_tenant_table('orgs', 'id', true);
SELECT pulsus_tenant_table('tenant_bindings', 'org_id', true);
SELECT pulsus_tenant_table('users', 'org_id', true);
SELECT pulsus_tenant_table('teams', 'org_id', true);
SELECT pulsus_tenant_table('memberships', 'org_id', true);
SELECT pulsus_tenant_table('roles', 'org_id', true);
SELECT pulsus_tenant_table('role_permissions', 'org_id', true);
SELECT pulsus_tenant_table('grants', 'org_id', true);
SELECT pulsus_tenant_table('idps', 'org_id', true);
SELECT pulsus_tenant_table('sessions', 'org_id', false);

-- First-run seeding looks the default org up by slug before the org is known (T11-027).
CREATE FUNCTION bootstrap_find_org(p_slug text) RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp AS $$ SELECT id FROM orgs WHERE slug = p_slug AND deleted_at IS NULL $$;
REVOKE ALL ON FUNCTION bootstrap_find_org(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bootstrap_find_org(text) TO pulsus_app;

UPDATE pulsus_schema_level SET level = 1;
