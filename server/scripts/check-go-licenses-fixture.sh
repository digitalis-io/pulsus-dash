#!/usr/bin/env bash
# ci:go-licenses self-test (T05-002, T18-026): the fixture module links a GPL-2.0-only module, so the
# production licence check (go-licenses.sh --check, with the gate's own allowlist) must fail and
# name it. A control run with GPL-2.0 added on top of that allowlist must pass, which shows that the
# licence caused the failure. There is no second copy of the allowlist: changing the gate's list
# changes what this test sees.
#
# Usage: check-go-licenses-fixture.sh   (from any directory inside the repository)
# Exit: 0 the fixture fails as expected, 1 otherwise.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
GATE="$ROOT/server/scripts/go-licenses.sh"
FIXTURE="$ROOT/server/testdata/licences/gpl"

if out=$("$GATE" --check "$FIXTURE" ./... example.com/licfixture 2>&1); then
  echo "$out"
  echo "go-licenses fixture passed; the gate's allowlist accepts GPL-2.0"
  exit 1
fi
if ! grep -qF example.com/gpl-dep <<<"$out" || ! grep -qF GPL-2.0 <<<"$out"; then
  echo "$out"
  echo "go-licenses fixture failed without naming example.com/gpl-dep and GPL-2.0"
  exit 1
fi
if ! control=$("$GATE" --check "$FIXTURE" ./... example.com/licfixture GPL-2.0 2>&1); then
  echo "$control"
  echo "go-licenses fixture control (GPL-2.0 allowed) failed; the check run is broken"
  exit 1
fi
echo "go-licenses fixture fails as expected (example.com/gpl-dep, GPL-2.0)"
