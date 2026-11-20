#!/usr/bin/env bash
# Self-test of api-gen-check.sh (ci:api-gen; plan tests F5-F7). Works only in a temporary copy of
# the inputs and checks afterwards that the real checkout is unchanged.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
CHECK="$HERE/api-gen-check.sh"
GENERATED=(api/openapi.yaml server/internal/gateway/api/api.gen.go client/src/api/gen/schema.d.ts server/internal/store/dbgen)

W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

fingerprint() { # sha256 of the spec and the generated paths of a tree
  (cd "$1" && find "${GENERATED[@]}" -type f -print0 | sort -z | xargs -0 sha256sum)
}

before_status=$(git -C "$ROOT" status --porcelain)
before_sums=$(fingerprint "$ROOT")

# The copy: the spec, the server module (without build output), the generated client types and
# the generator package, whose node_modules is shared through a symlink.
mkdir -p "$W/client/src/api" "$W/tools"
cp -R "$ROOT/api" "$W/api"
tar -C "$ROOT" --exclude=server/build -cf - server | tar -C "$W" -xf -
cp -R "$ROOT/client/src/api/gen" "$W/client/src/api/gen"
tar -C "$ROOT/tools" --exclude=api-gen/node_modules -cf - api-gen | tar -C "$W/tools" -xf -
ln -s "$ROOT/tools/api-gen/node_modules" "$W/tools/api-gen/node_modules"

failed=0
pass() { echo "ok   $1"; }
fail() { echo "FAIL $1: $2"; failed=1; }

# F5: a spec with one more path makes both generated files stale.
awk '{ print } /^paths:/ { print "  /drift-probe:"; print "    get: { operationId: getDriftProbe, responses: { '"'"'200'"'"': { description: Probe } } }" }' \
  "$W/api/openapi.yaml" > "$W/drift.yaml"
set +e
out=$("$CHECK" --root "$W" --spec "$W/drift.yaml" 2>&1); code=$?
set -e
if [[ $code -eq 1 && $out == *"client/src/api/gen/schema.d.ts"* && $out == *"server/internal/gateway/api/api.gen.go"* ]]; then
  pass "F5 drift is reported"
else
  fail "F5 drift is reported" "exit $code, output: $out"
fi

# F6: an edit to the spec that does not change the output passes and is kept.
echo "# local edit" >> "$W/api/openapi.yaml"
spec_sum=$(sha256sum < "$W/api/openapi.yaml")
set +e
out=$("$CHECK" --root "$W" 2>&1); code=$?
set -e
if [[ $code -eq 0 && $(sha256sum < "$W/api/openapi.yaml") == "$spec_sum" ]]; then
  pass "F6 a neutral spec edit passes and is kept"
else
  fail "F6 a neutral spec edit passes and is kept" "exit $code, output: $out"
fi

# F7: an edit to a generated file fails and is kept.
echo "// local edit" >> "$W/client/src/api/gen/schema.d.ts"
ts_sum=$(sha256sum < "$W/client/src/api/gen/schema.d.ts")
set +e
out=$("$CHECK" --root "$W" 2>&1); code=$?
set -e
if [[ $code -eq 1 && $out == *"schema.d.ts"* && $(sha256sum < "$W/client/src/api/gen/schema.d.ts") == "$ts_sum" &&
  $(tail -n 1 "$W/client/src/api/gen/schema.d.ts") == "// local edit" ]]; then
  pass "F7 an edited generated file fails and is kept"
else
  fail "F7 an edited generated file fails and is kept" "exit $code, output: $out"
fi

if [[ $(git -C "$ROOT" status --porcelain) == "$before_status" && $(fingerprint "$ROOT") == "$before_sums" ]]; then
  pass "the real checkout is unchanged"
else
  fail "the real checkout is unchanged" "git status or generated files differ"
fi

exit "$failed"
