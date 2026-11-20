#!/usr/bin/env bash
# itest-local self-test (T05-002): when compose up --wait fails, make itest-local must fail, must
# never run make itest (the tests would otherwise run against whatever else answers on the ports),
# and must still run its cleanup (compose ... --profile itest down -v). Needs no container runtime:
# compose and make are replaced by stand-ins that record their arguments.
#
# Each case runs twice: with the Makefile's own .SHELLFLAGS (-euo pipefail), the real behaviour, and
# with .SHELLFLAGS=-c, which proves that the recipe's own && chaining stops it, without set -e.
#
# Usage: dev/itest-local-selftest.sh   (from any directory inside the repository)
# Exit: 0 every case behaves, 1 otherwise.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

# compose stand-in: records every call; "up" fails, everything else succeeds.
cat >"$T/compose" <<EOF
#!/bin/sh
echo "\$*" >>"$T/compose.log"
case " \$* " in *" up "*) echo "stand-in: up --wait failed" >&2; exit 1 ;; esac
exit 0
EOF
# make stand-in for the recipe's \$(MAKE): records the call; it must never happen.
cat >"$T/make" <<EOF
#!/bin/sh
echo "\$*" >>"$T/make.log"
exit 0
EOF
chmod +x "$T/compose" "$T/make"

failed=0
check() {
  local label=$1 rc=0
  shift
  rm -f "$T/compose.log" "$T/make.log"
  make -C "$ROOT" itest-local COMPOSE="$T/compose" MAKE="$T/make" "$@" >"$T/out.txt" 2>&1 || rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "itest-local selftest ($label): make itest-local exited 0 after a failed up --wait"
    failed=1
  fi
  if [ -s "$T/make.log" ]; then
    echo "itest-local selftest ($label): make itest ran after a failed up --wait ($(cat "$T/make.log"))"
    failed=1
  fi
  if ! grep -q -- ' up -d --wait pg16 pg15' "$T/compose.log" 2>/dev/null; then
    echo "itest-local selftest ($label): compose up was never called"
    failed=1
  fi
  if ! grep -q -- '--profile itest down -v' "$T/compose.log" 2>/dev/null; then
    echo "itest-local selftest ($label): the cleanup (down -v) did not run"
    failed=1
  fi
  if [ "$failed" -eq 0 ]; then
    echo "itest-local selftest ($label): fails (exit $rc), runs no test, cleans up"
  fi
}

check "Makefile shell flags"
check ".SHELLFLAGS=-c" .SHELLFLAGS=-c
exit "$failed"
