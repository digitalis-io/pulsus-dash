#!/usr/bin/env bash
# ci:go-licenses self-test (T05-002, T18-026): the fixture module links a GPL-2.0-only module, so
# go-licenses check with the allowlist of go-licenses.sh must fail and name it. A control run with
# GPL-2.0 added to the allowlist must pass, which shows that the licence caused the failure.
#
# Usage: check-go-licenses-fixture.sh   (from any directory inside the repository)
# Exit: 0 the fixture fails as expected, 1 otherwise.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
GL="$ROOT/build/bin/go-licenses"
LICENCES=MIT,BSD-2-Clause,BSD-3-Clause,Apache-2.0,ISC,MPL-2.0,LGPL-2.1,LGPL-3.0
FIXTURE="$ROOT/server/testdata/licences/gpl"

if [ ! -x "$GL" ]; then
  go -C "$ROOT/server" build -o "$GL" github.com/google/go-licenses/v2
fi
GOROOT="$(go env GOROOT)"
export GOROOT

if out=$(cd "$FIXTURE" && "$GL" check ./... --ignore example.com/licfixture --allowed_licenses="$LICENCES" 2>&1); then
  echo "$out"
  echo "go-licenses fixture passed; the allowlist accepts GPL-2.0"
  exit 1
fi
if ! grep -qF example.com/gpl-dep <<<"$out" || ! grep -qF GPL-2.0 <<<"$out"; then
  echo "$out"
  echo "go-licenses fixture failed without naming example.com/gpl-dep and GPL-2.0"
  exit 1
fi
if ! control=$(cd "$FIXTURE" && "$GL" check ./... --ignore example.com/licfixture --allowed_licenses="$LICENCES,GPL-2.0" 2>&1); then
  echo "$control"
  echo "go-licenses fixture control (GPL-2.0 allowed) failed; the check run is broken"
  exit 1
fi
echo "go-licenses fixture fails as expected (example.com/gpl-dep, GPL-2.0)"
