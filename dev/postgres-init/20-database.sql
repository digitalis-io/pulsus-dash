-- The dev database (docs/development/dev-stack.md); roles come from 10-roles.sql.
CREATE DATABASE pulsus OWNER pulsus_owner;
GRANT CONNECT ON DATABASE pulsus TO pulsus_app, pulsus_maint;
