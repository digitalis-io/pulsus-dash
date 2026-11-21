#!/usr/bin/env bash
# bench:cpu-instr (T05-006, T05 §7.1; plan #62 §8.1, A.11): PR-level CPU regressions of the BFF,
# gated by instruction counts. The upstream bodies are written first by the test binary without
# valgrind (TestCPUInstrBodies), so building the 10⁶-point input is never counted. Each workload
# test of internal/gateway (TestCPUInstrW1, ...W2) then runs once under cachegrind with
# GOMAXPROCS=1 GOGC=off and reads its body from those files; its total "I refs" minus that of
# TestCPUInstrEmpty (the same harness and the same file reads, a 0-series answer) is compared with
# the committed baseline server/testdata/bench/cpu-instr.json. W1 − Empty is the A.11 boundary:
# from the first read of the upstream body to the last byte of the response.
#
# Usage: cpu-instr.sh            check: a count above 1.03 x its baseline fails
#        cpu-instr.sh --update   rewrite the baseline (run in CI; commit it with the change)
# Exit: 0 within budget (or baseline written), 1 over budget, a Go or valgrind version other
#       than the baseline's ("rebaseline"), no baseline, or a workload failed; 2 usage or no
#       valgrind.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
BASELINE="$ROOT/server/testdata/bench/cpu-instr.json"
case "${1:-}" in
  "") update=0 ;;
  --update) update=1 ;;
  *) echo "usage: cpu-instr.sh [--update]"; exit 2 ;;
esac
if ! command -v valgrind >/dev/null; then
  echo "bench:cpu-instr needs valgrind (CI installs the Ubuntu 24.04 package)"
  exit 2
fi

go_version=$(go -C "$ROOT/server" env GOVERSION)
vg_version=$(valgrind --version | sed -n 's/^valgrind-\([0-9]*\.[0-9]*\).*/\1/p')
mkdir -p "$ROOT/build"
go -C "$ROOT/server" test -c -o "$ROOT/build/gateway.test" ./internal/gateway

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir "$T/bodies"
if ! out=$(CPU_INSTR_WRITE="$T/bodies" "$ROOT/build/gateway.test" -test.run '^TestCPUInstrBodies$' -test.count=1 -test.v 2>&1) ||
  ! grep -q -- "--- PASS: TestCPUInstrBodies " <<<"$out"; then
  echo "$out" | tail -20 >&2
  echo "bench:cpu-instr: writing the workload bodies failed" >&2
  exit 1
fi

# refs WORKLOAD prints the total instruction count of one test run.
refs() {
  local out n
  if ! out=$(CPU_INSTR=1 CPU_INSTR_BODIES="$T/bodies" GOMAXPROCS=1 GOGC=off valgrind --tool=cachegrind --cache-sim=no \
    --cachegrind-out-file="$T/cachegrind.$1" "$ROOT/build/gateway.test" \
    -test.run "^TestCPUInstr$1\$" -test.count=1 -test.v 2>&1); then
    echo "$out" | tail -20 >&2
    echo "bench:cpu-instr: workload $1 failed" >&2
    exit 1
  fi
  if ! grep -q -- "--- PASS: TestCPUInstr$1 " <<<"$out"; then
    echo "$out" | tail -20 >&2
    echo "bench:cpu-instr: workload $1 did not run" >&2
    exit 1
  fi
  n=$(sed -n 's/.*I *refs: *\([0-9,]*\).*/\1/p' <<<"$out" | tail -1 | tr -d ,)
  if [ -z "$n" ]; then
    echo "bench:cpu-instr: no I refs for workload $1" >&2
    exit 1
  fi
  echo "$n"
}

empty=$(refs Empty)
w1=$(( $(refs W1) - empty ))
w2=$(( $(refs W2) - empty ))
echo "bench:cpu-instr: W1 $w1, W2 $w2 instructions (empty run $empty; $go_version, valgrind $vg_version)"

if [ "$update" = 1 ]; then
  mkdir -p "$(dirname "$BASELINE")"
  printf '{"W1": %s, "W2": %s, "go": "%s", "valgrind": "%s"}\n' "$w1" "$w2" "$go_version" "$vg_version" >"$BASELINE"
  echo "bench:cpu-instr: wrote server/testdata/bench/cpu-instr.json"
  cat "$BASELINE"
  exit 0
fi
if [ ! -f "$BASELINE" ]; then
  echo "bench:cpu-instr: no baseline; run make cpu-instr-update in CI and commit it"
  exit 1
fi

python3 -I - "$BASELINE" "$w1" "$w2" "$go_version" "$vg_version" <<'PY'
import json, sys
path, w1, w2, go, vg = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], sys.argv[5]
base = json.load(open(path))
if base.get("go") != go or base.get("valgrind") != vg:
    print(f"bench:cpu-instr: the baseline is for {base.get('go')} and valgrind {base.get('valgrind')}, "
          f"this run {go} and valgrind {vg}: rebaseline (make cpu-instr-update in CI)")
    sys.exit(1)
failed = False
for name, got in (("W1", w1), ("W2", w2)):
    want = int(base[name])
    if got > 1.03 * want:
        print(f"bench:cpu-instr: {name} {got} instructions, baseline {want}: more than +3 %")
        failed = True
    elif got < 0.90 * want:
        print(f"bench:cpu-instr: {name} {got} instructions, baseline {want}: more than 10 % below; "
              "consider make cpu-instr-update")
    else:
        print(f"bench:cpu-instr: {name} {got} instructions, baseline {want}: within +3 %")
sys.exit(1 if failed else 0)
PY
