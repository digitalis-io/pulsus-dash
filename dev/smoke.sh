#!/usr/bin/env bash
# ci:dev-stack (ADR-0015, T05 §7.1): the dev stack starts, migrates and seeds, serves /readyz,
# stops cleanly, keeps its data across dev-down, and dev-reset removes it. It uses its own compose
# project and ports, so a developer's stack is never touched, and removes everything on exit.
#
# Usage: dev/smoke.sh   (COMPOSE overrides the compose command, default "docker compose")
# Exit: 0 every step passed, 1 a step failed ("smoke step <n> failed").
# SMOKE_FAIL_AT=<n> (tests only) exits 1 right after step <n> passes.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
compose() { ${COMPOSE:-docker compose} -f "$ROOT/dev/compose.yaml" -p pulsus-dash-smoke "$@"; }

T=$(mktemp -d)
export DEV_PROJECT=pulsus-dash-smoke DEV_PG16_PORT=56432 DEV_ENV_FILE="$T/local.env"
SERVER_PID=""

cleanup() {
  local status=$?
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if ! compose --profile itest down -v; then
    echo "smoke cleanup: compose down failed"
    status=1
  fi
  rm -rf "$T"
  exit "$status"
}
trap cleanup EXIT

fail() {
  echo "smoke step $1 failed"
  exit 1
}
passed() {
  echo "smoke step $1 passed"
  if [ "${SMOKE_FAIL_AT:-}" = "$1" ]; then
    echo "smoke: injected failure after step $1 (SMOKE_FAIL_AT)"
    exit 1
  fi
}

cat >"$DEV_ENV_FILE" <<'EOF'
PG_APP_URL=postgres://pulsus_app@localhost:56432/pulsus_dash?sslmode=disable
PG_OWNER_URL=postgres://pulsus_owner@localhost:56432/pulsus_dash?sslmode=disable
PULSUS_DASH_POSTGRES_APP_URL_REF=env:PG_APP_URL
PULSUS_DASH_POSTGRES_OWNER_URL_REF=env:PG_OWNER_URL
PULSUS_DASH_DATASOURCE_URL=http://localhost:9
PULSUS_DASH_SERVER_LISTEN=localhost:58080
PULSUS_DASH_LOG_FORMAT=text
EOF

# 1. Postgres 16 starts and is healthy.
make dev-db || fail 1
passed 1

# 2. Migrations apply and the first organisation is seeded.
out=$(make dev-migrate) || { echo "$out"; fail 2; }
echo "$out"
grep -qF 'seeded organisation "default" with tenant binding "default"' <<<"$out" || fail 2
passed 2

# 3. The server, started directly (never through make), becomes ready. A server-build binary has no
# embedded client, so it serves --api-only.
(
  set -a
  # shellcheck disable=SC1090
  . "$DEV_ENV_FILE"
  set +a
  exec build/pulsus-dash serve --api-only
) &
SERVER_PID=$!
ready=""
for _ in $(seq 1 30); do
  if body=$(curl -fsS http://localhost:58080/readyz 2>/dev/null) && grep -qF '"status":"ready"' <<<"$body"; then
    ready=1
    break
  fi
  sleep 1
done
[ -n "$ready" ] || fail 3
passed 3

# 4. SIGTERM stops the server cleanly within 20 s and the listener is gone.
kill -TERM "$SERVER_PID"
for _ in $(seq 1 20); do
  kill -0 "$SERVER_PID" 2>/dev/null || break
  sleep 1
done
kill -0 "$SERVER_PID" 2>/dev/null && fail 4
if wait "$SERVER_PID"; then rc=0; else rc=$?; fi
[ "$rc" -eq 0 ] || fail 4
if curl -sS -o /dev/null http://localhost:58080/healthz 2>/dev/null; then fail 4; fi
SERVER_PID=""
passed 4

# 5. dev-down removes the containers and keeps the data volume.
make dev-down || fail 5
[ -z "$(docker ps -aq --filter label=com.docker.compose.project=pulsus-dash-smoke)" ] || fail 5
docker volume inspect pulsus-dash-smoke_pg16-data >/dev/null || fail 5
passed 5

# 6. The data persisted: migrate again finds the seeded organisation.
make dev-db || fail 6
out=$(make dev-migrate) || { echo "$out"; fail 6; }
echo "$out"
grep -qF 'organisation already seeded' <<<"$out" || fail 6
passed 6

# 7. dev-reset removes the data volume.
make dev-reset || fail 7
if docker volume inspect pulsus-dash-smoke_pg16-data >/dev/null 2>&1; then fail 7; fi
passed 7

echo "dev stack smoke passed"
