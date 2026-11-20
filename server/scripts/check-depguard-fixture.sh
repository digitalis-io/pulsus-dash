#!/usr/bin/env bash
# ci:go-lint depguard self-test (T05-002): each fixture imports a package outside the directory
# its depguard rule allows, so the lint must fail with that rule's desc (T11-023, T06-001). The
# lint runs on a copy of server/ in a temporary directory; the checkout is never written.
#
# Usage: check-depguard-fixture.sh   (from any directory inside the repository)
# Exit: 0 every fixture fails as expected, 1 otherwise.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
before=$(git -C "$ROOT" status --porcelain)

# check NAME FIXTURE RULE DESC
check() {
  local name=$1 fixture=$2 rule=$3 desc=$4 out
  T=$(mktemp -d)
  trap 'rm -rf "$T"' EXIT
  cp -a "$ROOT/server" "$T/server"
  cp "$ROOT/server/testdata/depguard/$fixture" "$T/server/internal/core/zz_fixture.go"
  if out=$(cd "$T/server" && golangci-lint run ./internal/core/... 2>&1); then
    echo "depguard fixture $name passed; rule $rule is not enforced"
    exit 1
  fi
  if ! grep -qF -- "$desc" <<<"$out"; then
    echo "$out"
    echo "depguard fixture $name failed without \"$desc\""
    exit 1
  fi
  echo "depguard fixture $name fails as expected"
  rm -rf "$T"
  trap - EXIT
}

check pgx pgx_outside_store.go.txt store-only "pgx is used only in internal/store (T11-023, ADR-0015)"
check chi chi_outside_gateway.go.txt gateway-only "the router is used only in internal/gateway (T06-001)"

if [ "$(git -C "$ROOT" status --porcelain)" != "$before" ]; then
  echo "the depguard self-test changed the checkout"
  exit 1
fi
