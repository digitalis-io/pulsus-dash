-- +goose Up
-- The binding's scope sequence (#304 §A.2, ADR-0038): metadata-only. tenant_bindings.scope_seq
-- orders the scope epochs the BFF sends, so the browser never restores a narrower view's
-- predecessor. It comes from one global sequence and never goes down: every insert takes the next
-- value (a deleted and recreated binding never reuses a lower one), an update that changes an
-- access-determining column takes the next value too, and an update that would lower it is
-- refused. The default is a constant, so adding the column rewrites no row (T11-013); the
-- sequence starts above it. ADR-0038: any later access-determining change (roles, data scopes)
-- MUST take the next value in the same transaction.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
CREATE SEQUENCE tenant_binding_scope_seq AS bigint START WITH 2;
ALTER TABLE tenant_bindings ADD COLUMN scope_seq bigint NOT NULL DEFAULT 1;
GRANT USAGE ON SEQUENCE tenant_binding_scope_seq TO pulsus_app;
-- +goose StatementBegin
CREATE FUNCTION public.pulsus_scope_seq() RETURNS trigger LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.scope_seq := nextval('public.tenant_binding_scope_seq');
    RETURN NEW;
  END IF;
  IF NEW.scope_seq < OLD.scope_seq THEN
    RAISE EXCEPTION 'scope_seq_lowered: tenant_bindings.scope_seq never goes down (% to %)',
      OLD.scope_seq, NEW.scope_seq USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.datasource_url IS DISTINCT FROM OLD.datasource_url
     OR NEW.database IS DISTINCT FROM OLD.database
     OR NEW.scope_org_id IS DISTINCT FROM OLD.scope_org_id
     OR NEW.credentials_ref IS DISTINCT FROM OLD.credentials_ref
     OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    NEW.scope_seq := nextval('public.tenant_binding_scope_seq');
  END IF;
  RETURN NEW;
END
$$;
-- +goose StatementEnd
CREATE TRIGGER tenant_bindings_scope_seq BEFORE INSERT OR UPDATE ON tenant_bindings
  FOR EACH ROW EXECUTE FUNCTION public.pulsus_scope_seq();
