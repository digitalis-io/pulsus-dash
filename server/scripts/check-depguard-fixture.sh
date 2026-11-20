#!/usr/bin/env bash
# ci:go-lint depguard self-test (T05-002): each fixture uses a package outside the directory its
# depguard or forbidigo rule allows, so the lint must fail with that rule's message (T11-023,
# T06-001, T06-005, plan #62 §4.9). The lint runs on a copy of server/ in a temporary directory;
# the checkout is never written.
#
# Usage: check-depguard-fixture.sh   (from any directory inside the repository)
# Exit: 0 every fixture fails as expected, 1 otherwise.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
before=$(git -C "$ROOT" status --porcelain)

# check NAME FIXTURE RULE DESC [PACKAGE]: the fixture is copied into internal/PACKAGE (default core).
check() {
  local name=$1 fixture=$2 rule=$3 desc=$4 pkg=${5:-core} out
  T=$(mktemp -d)
  trap 'rm -rf "$T"' EXIT
  cp -a "$ROOT/server" "$T/server"
  cp "$ROOT/server/testdata/depguard/$fixture" "$T/server/internal/$pkg/zz_fixture.go"
  if out=$(cd "$T/server" && golangci-lint run "./internal/$pkg/..." 2>&1); then
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
check httpclient http_client_outside_pulsusdb.go.txt pulsusdb-only "pulsusdb-only: outbound HTTP is made only in internal/pulsusdb and the allowed packages (T06-005)"
check jsondecoder json_outside_updec.go.txt pulsusdb-decoder "pulsusdb-decoder: upstream bodies are decoded only by updec.go, which redacts every string (§4.9)" pulsusdb

if [ "$(git -C "$ROOT" status --porcelain)" != "$before" ]; then
  echo "the depguard self-test changed the checkout"
  exit 1
fi
