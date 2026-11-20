-- Pulsus Dash Postgres roles (T11 §4.1). Run once per cluster by a database administrator,
-- before the first migrate. Idempotent. No passwords: set them with ALTER ROLE … PASSWORD or use
-- another authentication method.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulsus_owner') THEN
    CREATE ROLE pulsus_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulsus_app') THEN
    CREATE ROLE pulsus_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulsus_maint') THEN
    CREATE ROLE pulsus_maint LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS; END IF;
END $$;
