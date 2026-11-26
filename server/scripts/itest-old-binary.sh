#!/usr/bin/env bash
# The old-binary gate (plan #215 §5, plan #198 Part 1 §3.4, T05 §7.1): builds the previous release
# (the merge-base of HEAD with OLD_BINARY_REF, default origin/main) in a git worktree under
# build/old-binary/, removed on every exit, and runs every Test*OldBinary test with DASH_OLD_BINARY
# set to it, DASH_OLD_SPEC_VERSION to its board spec version, DASH_OLD_FIXTURE to its own fixture
# of that version (the first, by name, of api/fixtures/board-spec/v<P>-*.json in its tree) and
# DASH_OLD_SCHEMA to its highest migration number (plan #222). The
# tests never skip for a missing binary here: a missing or failing binary fails them. A test may
# skip when the previous release does not apply to it (itest:board-tags-old-binary needs one before
# board spec 4). This script passes only when the run exits 0, no test fails, at least one test
# passes, TestBoardSpecOldBinary passes whenever the previous release's spec version is older
# than this one's, and TestAnnotationsOldBinary passes whenever the previous release predates
# migration 5 and this one has it. A required local gate for every change to the board schema or spec (hosted CI is
# not a gate).
#
# Usage: server/scripts/itest-old-binary.sh   (make itest-old-binary; needs DASH_ITEST_PG_URLS)
#        server/scripts/itest-old-binary.sh --self-test   (the selector and pass patterns only)
# Exit: 0 the gate passed, 1 otherwise.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)

# RUN_PATTERN selects every Test*OldBinary test (any valid Go identifier between Test and
# OldBinary, digits and _ included); PASS_PATTERN is a top-level PASS line of one of them.
# The selector assumes ASCII Test*OldBinary names (the repository's test names are ASCII).
RUN_PATTERN='^Test[A-Za-z0-9_]*OldBinary$'
PASS_PATTERN='^--- PASS: Test[A-Za-z0-9_]*OldBinary \('

# self_test checks both patterns: Go's -run selection over a fixture package of test names (in
# build/, removed on exit), and the PASS lines over sample go test output.
self_test() {
  SELFTEST_DIR="$ROOT/build/old-binary-selftest"
  local dir="$SELFTEST_DIR"
  rm -rf "$dir"
  mkdir -p "$dir"
  trap 'rm -rf "$SELFTEST_DIR"' EXIT
  printf 'module selftest\n\ngo 1.21\n' >"$dir/go.mod"
  {
    echo 'package selftest'
    echo 'import "testing"'
    for n in TestBoardSpecOldBinary TestBoardV5OldBinary Test_tags2OldBinary TestOldBinary \
      TestOldBinaryX TestBoardOldBinaryLater TestOther; do
      echo "func $n(t *testing.T) {}"
    done
  } >"$dir/x_test.go"
  local got want
  got=$(go -C "$dir" test -list "$RUN_PATTERN" . | grep '^Test' | LC_ALL=C sort | tr '\n' ' ')
  want='TestBoardSpecOldBinary TestBoardV5OldBinary TestOldBinary Test_tags2OldBinary '
  if [ "$got" != "$want" ]; then
    echo "itest-old-binary self-test: FAIL (-run selects '$got', want '$want')"
    exit 1
  fi
  local line
  for line in '--- PASS: TestBoardV5OldBinary (0.10s)' '--- PASS: Test_tags2OldBinary (1.00s)'; do
    grep -qE -- "$PASS_PATTERN" <<<"$line" || { echo "itest-old-binary self-test: FAIL (no PASS match: $line)"; exit 1; }
  done
  for line in '--- PASS: TestBoardOldBinaryLater (0.10s)' '    --- PASS: TestBoardV5OldBinary/pg16 (0.10s)' \
    '--- SKIP: TestBoardV5OldBinary (0.00s)'; do
    if grep -qE -- "$PASS_PATTERN" <<<"$line"; then echo "itest-old-binary self-test: FAIL (PASS match: $line)"; exit 1; fi
  done
  echo "itest-old-binary self-test: PASS"
}
if [ "${1:-}" = "--self-test" ]; then
  self_test
  exit 0
fi
: "${DASH_ITEST_PG_URLS:?DASH_ITEST_PG_URLS is not set}"
BASE_REF=${OLD_BINARY_REF:-origin/main}
REF=$(git -C "$ROOT" merge-base HEAD "$BASE_REF")
DIR="$ROOT/build/old-binary"
SRC="$DIR/src-$$"
cleanup() {
  git -C "$ROOT" worktree remove --force "$SRC" >/dev/null 2>&1 || true
  git -C "$ROOT" worktree prune
}
trap cleanup EXIT
mkdir -p "$DIR"
git -C "$ROOT" worktree add --quiet --detach "$SRC" "$REF"
echo "itest-old-binary: building the previous release at $(git -C "$ROOT" rev-parse --short "$REF")"
CGO_ENABLED=0 go -C "$SRC/server" build -trimpath -o "$DIR/pulsus-dash" ./cmd/pulsus-dash

# spec_of prints the board spec version of a source tree (spec.BoardSchemaVersion).
spec_of() {
  grep -oE 'BoardSchemaVersion int64 = [0-9]+' "$1/server/internal/spec/board.go" | grep -oE '[0-9]+$' || true
}
OLD_SPEC=$(spec_of "$SRC")
CUR_SPEC=$(spec_of "$ROOT")
if [ -z "$OLD_SPEC" ] || [ -z "$CUR_SPEC" ]; then
  echo "itest-old-binary: FAIL (no BoardSchemaVersion: previous '$OLD_SPEC', current '$CUR_SPEC')"
  exit 1
fi
# schema_of prints the highest migration number of a source tree (server/migrations/NNNNN_*.sql).
schema_of() {
  find "$1/server/migrations" -maxdepth 1 -name '[0-9]*_*.sql' -printf '%f\n' | sed -E 's/^0*([0-9]+)_.*/\1/' | LC_ALL=C sort -n | tail -n 1
}
OLD_SCHEMA=$(schema_of "$SRC")
CUR_SCHEMA=$(schema_of "$ROOT")
if [ -z "$OLD_SCHEMA" ] || [ -z "$CUR_SCHEMA" ]; then
  echo "itest-old-binary: FAIL (no migrations: previous '$OLD_SCHEMA', current '$CUR_SCHEMA')"
  exit 1
fi
OLD_FIXTURE=$(find "$SRC/api/fixtures/board-spec" -maxdepth 1 -name "v${OLD_SPEC}-*.json" | LC_ALL=C sort | head -n 1)
echo "itest-old-binary: previous board spec $OLD_SPEC (fixture ${OLD_FIXTURE#"$SRC"/}), current $CUR_SPEC"
echo "itest-old-binary: previous schema $OLD_SCHEMA, current $CUR_SCHEMA"

LOG="$DIR/test.log"
rc=0
DASH_OLD_BINARY="$DIR/pulsus-dash" DASH_OLD_SPEC_VERSION="$OLD_SPEC" DASH_OLD_FIXTURE="$OLD_FIXTURE" DASH_OLD_SCHEMA="$OLD_SCHEMA" \
  CGO_ENABLED=1 go -C "$ROOT/server" test -race -tags itest -count=1 -v \
  -run "$RUN_PATTERN" ./cmd/pulsus-dash >"$LOG" 2>&1 || rc=$?
cat "$LOG"
fail() {
  echo "itest-old-binary: FAIL ($1)"
  exit 1
}
[ "$rc" -eq 0 ] || fail "exit $rc"
! grep -q -- '^--- FAIL' "$LOG" || fail "a test failed"
grep -qE -- "$PASS_PATTERN" "$LOG" || fail "no old-binary test passed"
if [ "$OLD_SPEC" -lt "$CUR_SPEC" ] && ! grep -qE -- '^--- PASS: TestBoardSpecOldBinary \(' "$LOG"; then
  fail "TestBoardSpecOldBinary did not pass for board spec $OLD_SPEC < $CUR_SPEC"
fi
if [ "$OLD_SCHEMA" -lt 5 ] && [ "$CUR_SCHEMA" -ge 5 ] && ! grep -qE -- '^--- PASS: TestAnnotationsOldBinary \(' "$LOG"; then
  fail "TestAnnotationsOldBinary did not pass for schema $OLD_SCHEMA < 5 <= $CUR_SCHEMA"
fi
echo "itest-old-binary: PASS"
