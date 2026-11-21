-- Dev stack only (dev/compose.yaml): the application database, owned by the migration role.
-- Runs after 10-roles.sql (server/deploy/postgres-roles.sql), and only on an empty volume.
CREATE DATABASE pulsus_dash OWNER pulsus_owner;
