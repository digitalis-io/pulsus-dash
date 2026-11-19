-- Database roles of Pulsus Dash (T11 §4.1). Run once per cluster by an operator (superuser);
-- idempotent. No passwords are set here: production sets them out of band, the dev stack uses
-- trust authentication on loopback. Existing roles are brought to these attributes; the script
-- fails if pulsus_app can still assume a role that bypasses row-level security.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulsus_owner') THEN
    CREATE ROLE pulsus_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulsus_app') THEN
    CREATE ROLE pulsus_app LOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulsus_maint') THEN
    CREATE ROLE pulsus_maint LOGIN BYPASSRLS;
  END IF;
  ALTER ROLE pulsus_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
  ALTER ROLE pulsus_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  ALTER ROLE pulsus_maint LOGIN NOSUPERUSER BYPASSRLS;
  IF EXISTS (SELECT 1 FROM pg_roles r
              WHERE r.rolname <> 'pulsus_app' AND (r.rolsuper OR r.rolbypassrls)
                AND pg_has_role('pulsus_app', r.oid, 'MEMBER')) THEN
    RAISE EXCEPTION 'pulsus_app is a member of a role that bypasses row-level security; revoke that membership (T11 §4.1)';
  END IF;
END $$;
