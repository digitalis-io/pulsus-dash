-- Foundation (T11-003, T11-015): the org context function, the schema level and the tenant-table
-- template. Runs as pulsus_owner; sqlx creates _sqlx_migrations before this file.
CREATE FUNCTION pulsus_org() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('pulsus.org_id', true), '')::uuid $$;

CREATE TABLE pulsus_schema_level (singleton bool PRIMARY KEY DEFAULT true CHECK (singleton), level bigint NOT NULL);
INSERT INTO pulsus_schema_level VALUES (true, 0);

GRANT USAGE ON SCHEMA public TO pulsus_app, pulsus_maint;
GRANT SELECT ON pulsus_schema_level, _sqlx_migrations TO pulsus_app, pulsus_maint;

-- Every tenant table: RLS enabled and forced, one org_isolation policy, no PUBLIC access.
CREATE FUNCTION pulsus_tenant_table(tbl regclass, org_col text, app_dml bool) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('CREATE POLICY org_isolation ON %s USING (%I = pulsus_org()) WITH CHECK (%I = pulsus_org())', tbl, org_col, org_col);
  EXECUTE format('REVOKE ALL ON %s FROM PUBLIC', tbl);
  IF app_dml THEN EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO pulsus_app', tbl); END IF;
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO pulsus_maint', tbl);
END $$;
REVOKE ALL ON FUNCTION pulsus_tenant_table(regclass, text, bool) FROM PUBLIC;
