#!/usr/bin/env bash
# ci:api-gen (ADR-0015): regenerates the Go server, the TypeScript client types and the sqlc code
# into a temporary directory and compares them with the committed files. It never writes inside
# the checked tree.
#
# Usage: api-gen-check.sh [--root DIR] [--spec PATH]
#   --root  repository root (default: the checkout this script is in)
#   --spec  OpenAPI document (default: <root>/api/openapi.yaml)
# Exit: 0 up to date, 1 stale (each stale path printed as error[api-gen] …), 2 usage.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SPEC=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT=$(cd "$2" && pwd); shift 2 ;;
    --spec) SPEC=$2; shift 2 ;;
    *) echo "usage: api-gen-check.sh [--root DIR] [--spec PATH]" >&2; exit 2 ;;
  esac
done
SPEC=${SPEC:-$ROOT/api/openapi.yaml}

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

stale=0
report() { echo "error[api-gen] $1 is stale: run make api-gen"; stale=1; }

# Go server: the committed generator configuration with the output moved into $T.
sed "s|^output:.*|output: $T/api.gen.go|" "$ROOT/server/oapi-codegen.yaml" > "$T/oapi.yaml"
go -C "$ROOT/server" tool oapi-codegen -config "$T/oapi.yaml" "$SPEC"

# TypeScript client types.
"$ROOT/tools/api-gen/node_modules/.bin/openapi-typescript" "$SPEC" -o "$T/schema.d.ts" > /dev/null 2>&1

cmp -s "$T/api.gen.go" "$ROOT/server/internal/gateway/api/api.gen.go" || report server/internal/gateway/api/api.gen.go
cmp -s "$T/schema.d.ts" "$ROOT/client/src/api/gen/schema.d.ts" || report client/src/api/gen/schema.d.ts

# sqlc compares in memory.
go -C "$ROOT/server" tool sqlc diff > /dev/null 2>&1 || report server/internal/store/dbgen

exit "$stale"
