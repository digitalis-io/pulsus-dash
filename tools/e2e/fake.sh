#!/usr/bin/env bash
# Starts the e2e PulsusDB fake (plan #63 §4.5): tools/e2e/fake.sh PORT. It serves the transcripts
# of client/e2e/transcripts with --control (GET /__fake/requests, POST /__fake/reset) and
# --clip-grid (a range transcript answers only its samples on the request's grid, #304). Needs
# make e2e-build (docs/development/build-and-ci.md#end-to-end-tests).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

port=${1:?usage: tools/e2e/fake.sh PORT}
bin=build/e2e-fake/pulsus-fake

if [ ! -x "$bin" ]; then
  echo "run make e2e-build first" >&2
  exit 1
fi

exec "$bin" --listen "localhost:$port" --transcripts client/e2e/transcripts --generate=false --control --clip-grid
