#!/usr/bin/env bash
# ci:dev-stack self-test (T05-002): dev/smoke.sh must leave nothing behind, after a normal run and
# after a failure injected with the server running (SMOKE_FAIL_AT=3): no listener on port 58080, no
# pulsus-dash-smoke container and no pulsus-dash-smoke_pg16-data volume.
#
# Usage: dev/smoke-selftest.sh   (run after dev/smoke.sh, as make dev-smoke does)
# Exit: 0 clean on both paths, 1 otherwise.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

assert_clean() {
  local when=$1 rc=0
  curl -sS -o /dev/null --max-time 5 http://localhost:58080/healthz 2>/dev/null || rc=$?
  if [ "$rc" -ne 7 ]; then
    echo "smoke selftest: port 58080 still answers or did not refuse the connection after $when (curl exit $rc)"
    exit 1
  fi
  if [ -n "$(docker ps -aq --filter label=com.docker.compose.project=pulsus-dash-smoke)" ]; then
    echo "smoke selftest: a pulsus-dash-smoke container is left after $when"
    exit 1
  fi
  if docker volume inspect pulsus-dash-smoke_pg16-data >/dev/null 2>&1; then
    echo "smoke selftest: the pulsus-dash-smoke_pg16-data volume is left after $when"
    exit 1
  fi
  echo "smoke selftest: nothing left after $when"
}

assert_clean "the normal run"

rc=0
SMOKE_FAIL_AT=3 dev/smoke.sh || rc=$?
if [ "$rc" -ne 1 ]; then
  echo "smoke selftest: SMOKE_FAIL_AT=3 dev/smoke.sh exited $rc, want 1"
  exit 1
fi
assert_clean "the injected failure at step 3"
