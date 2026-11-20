#!/usr/bin/env bash
# Starts an e2e BFF (plan #59 §3.7): tools/e2e/serve.sh MODE PORT, MODE = stub or http.
# Needs make e2e-build, and E2E_PG_APP_URL / E2E_PG_OWNER_URL pointing at a database with the
# roles of server/deploy/postgres-roles.sql (docs/development/build-and-ci.md#end-to-end-tests).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

mode=${1:?usage: tools/e2e/serve.sh MODE PORT}
port=${2:?usage: tools/e2e/serve.sh MODE PORT}
bin=build/e2e-$mode/pulsus-dash

if [ ! -x "$bin" ]; then
  echo "run make e2e-build first" >&2
  exit 1
fi
if [ -z "${E2E_PG_APP_URL:-}" ] || [ -z "${E2E_PG_OWNER_URL:-}" ]; then
  echo "E2E_PG_APP_URL and E2E_PG_OWNER_URL must be set (docs/development/build-and-ci.md#end-to-end-tests)" >&2
  exit 1
fi

export PULSUS_DASH_POSTGRES_APP_URL_REF=env:E2E_PG_APP_URL
export PULSUS_DASH_POSTGRES_OWNER_URL_REF=env:E2E_PG_OWNER_URL
export PULSUS_DASH_DATASOURCE_URL=http://localhost:9
export PULSUS_DASH_DATASOURCE_SLUG=demo
export PULSUS_DASH_SERVER_LISTEN=localhost:$port
export PULSUS_DASH_LOG_FORMAT=text

# migrate is idempotent; two servers starting together serialise on its advisory lock.
"$bin" migrate
exec "$bin" serve
