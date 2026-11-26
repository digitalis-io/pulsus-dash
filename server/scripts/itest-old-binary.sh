#!/usr/bin/env bash
# itest:board-tags-old-binary (plan #215 §5, T05 §7.1): builds the previous release (the merge-base
# of HEAD with OLD_BINARY_REF, default origin/main) in a git worktree under build/old-binary/,
# removed on every exit, and runs TestBoardTagsOldBinary with DASH_OLD_BINARY set to it. The test
# never skips here: a missing or failing binary fails it, and this script fails unless the test
# reports PASS. A required local gate for every change to the board schema or spec (hosted CI is
# not a gate).
#
# Usage: server/scripts/itest-old-binary.sh   (make itest-old-binary; needs DASH_ITEST_PG_URLS)
# Exit: 0 the test passed, 1 otherwise.
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

LOG="$DIR/test.log"
rc=0
DASH_OLD_BINARY="$DIR/pulsus-dash" CGO_ENABLED=1 go -C "$ROOT/server" test -race -tags itest -count=1 -v \
  -run '^TestBoardTagsOldBinary$' ./cmd/pulsus-dash >"$LOG" 2>&1 || rc=$?
cat "$LOG"
if [ "$rc" -ne 0 ] || ! grep -q -- '^--- PASS: TestBoardTagsOldBinary' "$LOG"; then
  echo "itest-old-binary: FAIL (exit $rc)"
  exit 1
fi
echo "itest-old-binary: PASS"
