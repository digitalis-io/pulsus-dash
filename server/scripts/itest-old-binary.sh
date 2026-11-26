#!/usr/bin/env bash
# The old-binary gate (plan #215 §5, plan #198 Part 1 §3.4, T05 §7.1): builds the previous release
# (the merge-base of HEAD with OLD_BINARY_REF, default origin/main) in a git worktree under
# build/old-binary/, removed on every exit, and runs every Test*OldBinary test with DASH_OLD_BINARY
# set to it, DASH_OLD_SPEC_VERSION to its board spec version and DASH_OLD_FIXTURE to its own fixture
# of that version (the first, by name, of api/fixtures/board-spec/v<P>-*.json in its tree). The
# tests never skip for a missing binary here: a missing or failing binary fails them. A test may
# skip when the previous release does not apply to it (itest:board-tags-old-binary needs one before
# board spec 4). This script passes only when the run exits 0, no test fails, at least one test
# passes, and TestBoardSpecOldBinary passes whenever the previous release's spec version is older
# than this one's. A required local gate for every change to the board schema or spec (hosted CI is
# not a gate).
#
# Usage: server/scripts/itest-old-binary.sh   (make itest-old-binary; needs DASH_ITEST_PG_URLS)
# Exit: 0 the gate passed, 1 otherwise.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
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
OLD_FIXTURE=$(find "$SRC/api/fixtures/board-spec" -maxdepth 1 -name "v${OLD_SPEC}-*.json" | LC_ALL=C sort | head -n 1)
echo "itest-old-binary: previous board spec $OLD_SPEC (fixture ${OLD_FIXTURE#"$SRC"/}), current $CUR_SPEC"

LOG="$DIR/test.log"
rc=0
DASH_OLD_BINARY="$DIR/pulsus-dash" DASH_OLD_SPEC_VERSION="$OLD_SPEC" DASH_OLD_FIXTURE="$OLD_FIXTURE" \
  CGO_ENABLED=1 go -C "$ROOT/server" test -race -tags itest -count=1 -v \
  -run '^Test[A-Za-z]*OldBinary$' ./cmd/pulsus-dash >"$LOG" 2>&1 || rc=$?
cat "$LOG"
fail() {
  echo "itest-old-binary: FAIL ($1)"
  exit 1
}
[ "$rc" -eq 0 ] || fail "exit $rc"
! grep -q -- '^--- FAIL' "$LOG" || fail "a test failed"
grep -qE -- '^--- PASS: Test[A-Za-z]*OldBinary' "$LOG" || fail "no old-binary test passed"
if [ "$OLD_SPEC" -lt "$CUR_SPEC" ] && ! grep -q -- '^--- PASS: TestBoardSpecOldBinary' "$LOG"; then
  fail "TestBoardSpecOldBinary did not pass for board spec $OLD_SPEC < $CUR_SPEC"
fi
echo "itest-old-binary: PASS"
