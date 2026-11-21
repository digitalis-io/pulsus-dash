-- +goose Up
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
-- Untrusted roles cannot create objects in public (definer-function safety, review r1 #1). On
-- PG ≥ 15 public is owned by pg_database_owner, i.e. pulsus_owner (T11 §4.1).
REVOKE CREATE ON SCHEMA public FROM PUBLIC, pulsus_app, pulsus_maint;
-- +goose StatementBegin
-- No other role may hold CREATE on public (review r2 #1). Repeated by store.Migrate on every run.
DO $$
DECLARE bad text;
BEGIN
  SELECT pg_catalog.string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::pg_catalog.regrole::text END, ', ')
    INTO bad
    FROM pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
   WHERE n.nspname = 'public' AND a.privilege_type = 'CREATE'
     AND a.grantee NOT IN (n.nspowner, 'pulsus_owner'::pg_catalog.regrole);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'schema_create_grant: roles other than pulsus_owner hold CREATE on schema public: %', bad
      USING ERRCODE = 'PD002', HINT = 'REVOKE CREATE ON SCHEMA public FROM <role>, then rerun migrate';
  END IF;
END $$;
-- +goose StatementEnd

CREATE TABLE folders (org_id uuid NOT NULL REFERENCES orgs (id), id uuid NOT NULL,
  uid text NOT NULL CHECK (uid ~ '^[a-z0-9-]{1,40}$'), title text NOT NULL, path text NOT NULL,
  owner_team_id uuid, managed_by text, PRIMARY KEY (org_id, id), UNIQUE (org_id, uid));
CREATE TABLE boards (org_id uuid NOT NULL REFERENCES orgs (id), id uuid NOT NULL,
  uid text NOT NULL CHECK (uid ~ '^[a-z0-9-]{1,40}$'), folder_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  head_version bigint NOT NULL CHECK (head_version >= 1), etag bigint NOT NULL CHECK (etag >= 1),
  deleted_at timestamptz, PRIMARY KEY (org_id, id), UNIQUE (org_id, uid),
  FOREIGN KEY (org_id, folder_id) REFERENCES folders (org_id, id));
CREATE TABLE board_versions (org_id uuid NOT NULL, board_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version >= 1), spec jsonb NOT NULL,
  schema_version bigint NOT NULL CHECK (schema_version >= 1),
  content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  author_kind text NOT NULL CHECK (author_kind IN ('local', 'user', 'service_account')), author_id uuid,
  message text CHECK (char_length(message) <= 500),
  source text NOT NULL CHECK (source IN ('ui','api','git','terraform','import','ai','restore','provisioning')),
  source_ref text, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, board_id, version), FOREIGN KEY (org_id, board_id) REFERENCES boards (org_id, id));
CREATE TABLE audit_events (org_id uuid NOT NULL, rclass bigint NOT NULL, at timestamptz NOT NULL,
  id uuid NOT NULL, actor_kind text NOT NULL, actor_id uuid, on_behalf_of uuid, action text NOT NULL,
  resource_kind text, resource_id text, reason jsonb, diff jsonb, ip inet, request_id text,
  prev_hash bytea, hash bytea NOT NULL CHECK (octet_length(hash) = 32),
  PRIMARY KEY (org_id, rclass, at, id)) PARTITION BY LIST (rclass);
CREATE TABLE audit_events_r13 PARTITION OF audit_events FOR VALUES IN (13) PARTITION BY RANGE (at);
CREATE INDEX audit_events_actor ON audit_events (org_id, actor_id, at);
CREATE INDEX audit_events_action ON audit_events (org_id, action, at);
CREATE INDEX audit_events_resource ON audit_events (org_id, resource_kind, resource_id, at);
-- Per-org chain head (T11-017): not under the retention floor, so the chain never restarts.
CREATE TABLE audit_chain_heads (org_id uuid PRIMARY KEY REFERENCES orgs (id), last_at timestamptz NOT NULL,
  last_id uuid NOT NULL, last_hash bytea NOT NULL CHECK (octet_length(last_hash) = 32));
CREATE TABLE stars (org_id uuid NOT NULL REFERENCES orgs (id), user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('board')), object_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (org_id, user_id, kind, object_id));
CREATE TABLE recent_views (org_id uuid NOT NULL REFERENCES orgs (id), user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('board')), id uuid NOT NULL, viewed_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, user_id, kind, id));
CREATE INDEX recent_views_by_time ON recent_views (org_id, user_id, kind, viewed_at);

-- RLS template (T11-003)
ALTER TABLE folders ENABLE ROW LEVEL SECURITY;  ALTER TABLE folders FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON folders USING (org_id = pulsus_org()) WITH CHECK (org_id = pulsus_org());
ALTER TABLE boards ENABLE ROW LEVEL SECURITY;  ALTER TABLE boards FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON boards USING (org_id = pulsus_org()) WITH CHECK (org_id = pulsus_org());
ALTER TABLE board_versions ENABLE ROW LEVEL SECURITY;  ALTER TABLE board_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON board_versions USING (org_id = pulsus_org()) WITH CHECK (org_id = pulsus_org());
ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY;  ALTER TABLE audit_chain_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON audit_chain_heads USING (org_id = pulsus_org()) WITH CHECK (org_id = pulsus_org());
ALTER TABLE stars ENABLE ROW LEVEL SECURITY;  ALTER TABLE stars FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON stars USING (org_id = pulsus_org()) WITH CHECK (org_id = pulsus_org());
ALTER TABLE recent_views ENABLE ROW LEVEL SECURITY;  ALTER TABLE recent_views FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON recent_views USING (org_id = pulsus_org()) WITH CHECK (org_id = pulsus_org());
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;  ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON audit_events
  USING (org_id = pulsus_org() AND at >= pulsus_floor('audit')) WITH CHECK (org_id = pulsus_org());
ALTER TABLE audit_events_r13 ENABLE ROW LEVEL SECURITY;  ALTER TABLE audit_events_r13 FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON audit_events_r13
  USING (org_id = pulsus_org() AND at >= pulsus_floor('audit')) WITH CHECK (org_id = pulsus_org());

-- +goose StatementBegin
-- The state of the class-13 leaf for month m (review r2 #1): a relation is accepted only if it is
-- an ordinary table, a direct child of public.audit_events_r13, owned by pulsus_owner, with exactly
-- the bounds [m, m + 1 month) in UTC. TimeZone and DateStyle are pinned so pg_get_expr is stable.
CREATE FUNCTION public.pulsus_audit_leaf_state(m date) RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp SET "TimeZone" = 'UTC' SET "DateStyle" = 'ISO, YMD' AS $$
DECLARE
  leaf text := 'audit_events_r13_' || pg_catalog.to_char(m, 'YYYY_MM');
  rel regclass := pg_catalog.to_regclass('public.' || leaf);
  want text := pg_catalog.format('FOR VALUES FROM (%L) TO (%L)',
    pg_catalog.to_char(m, 'YYYY-MM-DD') || ' 00:00:00+00',
    pg_catalog.to_char(m + interval '1 month', 'YYYY-MM-DD') || ' 00:00:00+00');
  ok boolean;
BEGIN
  IF rel IS NULL THEN RETURN 'absent'; END IF;
  SELECT c.relkind = 'r' AND c.relispartition
     AND c.relowner = 'pulsus_owner'::pg_catalog.regrole
     AND i.inhparent = 'public.audit_events_r13'::pg_catalog.regclass
     AND pg_catalog.pg_get_expr(c.relpartbound, c.oid) = want
    INTO ok
    FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_inherits i ON i.inhrelid = c.oid
   WHERE c.oid = rel;
  RETURN CASE WHEN ok THEN 'ok' ELSE 'collision' END;     -- NULL (no pg_inherits row) → collision
END $$;
-- +goose StatementEnd
-- +goose StatementBegin
-- Definer: trusted search_path, every object schema-qualified (review r1 #1).
CREATE FUNCTION public.pulsus_audit_partitions_maintain(months_ahead int,
    OUT created int, OUT dropped int, OUT horizon int)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s' AS $$
DECLARE
  first date := pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'UTC')::date;
  m date; leaf text; st text; r record;
BEGIN
  created := 0; dropped := 0;
  IF months_ahead IS NULL OR months_ahead < 1 OR months_ahead > 12 THEN
    RAISE EXCEPTION 'months_ahead must be between 1 and 12' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(8103502347670585347);   -- "pulsus" + 3
  FOR i IN 0..months_ahead LOOP                                     -- create ahead (T11-021)
    m := (first + pg_catalog.make_interval(months => i))::date;
    leaf := 'audit_events_r13_' || pg_catalog.to_char(m, 'YYYY_MM');
    st := public.pulsus_audit_leaf_state(m);
    IF st = 'collision' THEN
      RAISE EXCEPTION 'audit_partition_collision: public.% exists but is not the expected partition', leaf
        USING ERRCODE = 'PD001';
    END IF;
    CONTINUE WHEN st = 'ok';
    EXECUTE pg_catalog.format('CREATE TABLE public.%I PARTITION OF public.audit_events_r13 FOR VALUES FROM (%L) TO (%L)',
      leaf, m::timestamp AT TIME ZONE 'UTC', (m + interval '1 month')::timestamp AT TIME ZONE 'UTC');
    EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', leaf);
    EXECUTE pg_catalog.format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', leaf);
    EXECUTE pg_catalog.format('CREATE POLICY org_isolation ON public.%I USING (org_id = public.pulsus_org() AND at >= public.pulsus_floor(%L)) WITH CHECK (org_id = public.pulsus_org())', leaf, 'audit');
    EXECUTE pg_catalog.format('REVOKE ALL ON public.%I FROM PUBLIC, pulsus_app', leaf);
    created := created + 1;
  END LOOP;
  FOR r IN SELECT c.relname FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
           WHERE i.inhparent = 'public.audit_events_r13'::pg_catalog.regclass
             AND c.relname ~ '^audit_events_r13_[0-9]{4}_[0-9]{2}$' LOOP          -- drop expired (T11-008)
    m := pg_catalog.to_date(pg_catalog.right(r.relname, 7), 'YYYY_MM');
    CONTINUE WHEN (m + interval '1 month')::timestamp AT TIME ZONE 'UTC'
                  > pg_catalog.now() - pg_catalog.make_interval(months => 13);   -- whole range older than class 13
    IF public.pulsus_audit_leaf_state(m) <> 'ok' THEN
      RAISE EXCEPTION 'audit_partition_collision: public.% exists but is not the expected partition', r.relname
        USING ERRCODE = 'PD001';
    END IF;
    EXECUTE pg_catalog.format('ALTER TABLE public.audit_events_r13 DETACH PARTITION public.%I', r.relname);
    EXECUTE pg_catalog.format('DROP TABLE public.%I', r.relname);
    dropped := dropped + 1;
  END LOOP;
  horizon := public.pulsus_audit_partition_horizon();
END $$;
-- +goose StatementEnd
-- +goose StatementBegin
-- Whole months after the current UTC month covered by consecutive valid leaves (0 … 12), or −1
-- when the current month's leaf is not valid. A collision ends the count; it is never counted.
CREATE FUNCTION public.pulsus_audit_partition_horizon() RETURNS int
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE first date := pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'UTC')::date; n int := -1;
BEGIN
  WHILE n < 12 AND public.pulsus_audit_leaf_state((first + pg_catalog.make_interval(months => n + 1))::date) = 'ok' LOOP
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;
-- +goose StatementEnd

REVOKE ALL ON audit_events_r13 FROM PUBLIC, pulsus_app;
REVOKE ALL ON FUNCTION public.pulsus_audit_partitions_maintain(int), public.pulsus_audit_partition_horizon(),
  public.pulsus_audit_leaf_state(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pulsus_audit_partitions_maintain(int), public.pulsus_audit_partition_horizon(),
  public.pulsus_audit_leaf_state(date) TO pulsus_app;
GRANT SELECT, INSERT, UPDATE ON folders, boards TO pulsus_app;          -- soft delete only
GRANT SELECT, INSERT ON board_versions, audit_events TO pulsus_app;      -- T11-006, T11-017
GRANT SELECT, INSERT, UPDATE ON audit_chain_heads TO pulsus_app;    -- no DELETE
GRANT SELECT, INSERT, DELETE ON stars TO pulsus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON recent_views TO pulsus_app;
