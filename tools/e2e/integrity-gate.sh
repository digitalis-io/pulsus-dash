#!/usr/bin/env bash
# ci:asset-integrity (plan #59 §4.3, ADR-0016 at binary level): a binary whose embedded client
# was altered after signing must refuse to start, before it opens a listener or contacts
# Postgres. Builds once with make build, then rebuilds one gate binary per case with the same
# public key. No database is needed: verification runs first.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

DIST=server/internal/gateway/static/dist
GATE=build/gate
PKG=github.com/digitalis-io/pulsus-dash/server/internal/gateway/static

make build
rm -rf "$GATE"
mkdir -p "$GATE"
cp -a "$DIST" "$GATE/pristine"
cp build/pulsus-dash "$GATE/pulsus-dash.release"
PUB=$(cat build/keys/asset-signing.pub)

restore() {
  rm -rf "$DIST"
  cp -a "$GATE/pristine" "$DIST"
  # Copy, then rename: the old file may still be mapped by an exiting process.
  if [ -f "$GATE/pulsus-dash.release" ]; then
    cp "$GATE/pulsus-dash.release" build/pulsus-dash.restore && mv -f build/pulsus-dash.restore build/pulsus-dash
  fi
}
trap restore EXIT

fail() {
  echo "ci:asset-integrity: $*" >&2
  exit 1
}

# fresh: the untouched packed tree.
fresh() {
  rm -rf "$DIST"
  cp -a "$GATE/pristine" "$DIST"
}

CURDIR_ABS=$(pwd)

# build_gate [KEY]: the gate binary over the current tree, with KEY as its public key ("" = none).
build_gate() {
  local ldflags=""
  if [ -n "${1:-}" ]; then ldflags="-X $PKG.releasePublicKeys=$1"; fi
  CGO_ENABLED=0 go -C server build -tags embedassets -trimpath -ldflags "$ldflags" \
    -o "$CURDIR_ABS/$GATE/pulsus-dash" ./cmd/pulsus-dash
}

# run_gate BIN: serve with nothing listening at the Postgres URL; prints stderr, returns the exit code.
run_gate() {
  local code=0
  env -i PATH="$PATH" HOME="${HOME:-/}" \
    PULSUS_DASH_POSTGRES_APP_URL_REF=env:GATE_PG_URL \
    GATE_PG_URL='postgres://pulsus_app@localhost:1/x?sslmode=disable' \
    PULSUS_DASH_SERVER_LISTEN=localhost:0 \
    timeout 10 "$1" serve 2>"$GATE/stderr" >/dev/null || code=$?
  cat "$GATE/stderr"
  return "$code"
}

# expect_refusal NAME TEXT: the gate binary exits 1 within 10 s with TEXT on stderr.
expect_refusal() {
  local name=$1 text=$2 code=0 out
  out=$(run_gate "$GATE/pulsus-dash") || code=$?
  if [ "$code" -ne 1 ]; then
    echo "$out" >&2
    fail "$name: exit $code, want 1"
  fi
  if ! grep -qF -- "$text" <<<"$out"; then
    echo "$out" >&2
    fail "$name: stderr lacks \"$text\""
  fi
  echo "ci:asset-integrity: $name refused as expected ($text)"
}

# manifest_path FILTER: the first path in the packed manifest matching the JS predicate FILTER(p).
manifest_path() {
  node -e '
    const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const f = new Function("p", "return " + process.argv[2]);
    const hit = m.files.map((e) => e.path).find((p) => f(p));
    if (hit === undefined) process.exit(3);
    process.stdout.write(hit);
  ' "$DIST/asset-manifest.json" "$1"
}

# Control: the untouched tree verifies, then serve fails only on Postgres.
fresh
build_gate "$PUB"
code=0
out=$(run_gate "$GATE/pulsus-dash") || code=$?
grep -qF 'assets verified' <<<"$out" || { echo "$out" >&2; fail "control: no 'assets verified'"; }
grep -qF 'postgres unreachable' <<<"$out" || { echo "$out" >&2; fail "control: did not stop at Postgres"; }
if grep -qF 'asset integrity check failed' <<<"$out"; then echo "$out" >&2; fail "control: integrity failure"; fi
[ "$code" -eq 1 ] || fail "control: exit $code, want 1"
echo "ci:asset-integrity: control verified, then stopped at Postgres"

# G1: flip one byte of the largest assets/*.js.
fresh
largest=$(node -e '
  const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const js = m.files.filter((e) => /^assets\/[^/]+\.js$/.test(e.path)).sort((a, b) => b.size - a.size);
  if (js.length === 0) process.exit(3);
  process.stdout.write(js[0].path);
' "$DIST/asset-manifest.json") || fail "G1: no assets/*.js in the manifest"
node -e '
  const fs = require("node:fs");
  const b = fs.readFileSync(process.argv[1]);
  b[Math.floor(b.length / 2)] ^= 1;
  fs.writeFileSync(process.argv[1], b);
' "$DIST/$largest"
build_gate "$PUB"
# Gate proof (do not merge): the expected exit of G1 is inverted, so the refusal fails the gate.
code=0
out=$(run_gate "$GATE/pulsus-dash") || code=$?
[ "$code" -eq 0 ] || { echo "$out" >&2; fail "G1 (gate proof, expected exit inverted): exit $code, want 0"; }

# G2: an unlisted file.
fresh
echo 'console.log(1);' >"$DIST/assets/extra.js"
build_gate "$PUB"
expect_refusal G2 "unlisted_file assets/extra.js"

# G3: delete the first .br variant the manifest lists.
fresh
br=$(manifest_path 'p.endsWith(".br")') || fail "G3: no .br variant to delete"
rm "$DIST/$br"
build_gate "$PUB"
expect_refusal G3 "missing_file $br"

# G4: change one byte of the manifest.
fresh
node -e '
  const fs = require("node:fs");
  const b = fs.readFileSync(process.argv[1]);
  const i = b.indexOf(0x22); // the first quote
  b[i + 1] ^= 1;
  fs.writeFileSync(process.argv[1], b);
' "$DIST/asset-manifest.json"
build_gate "$PUB"
expect_refusal G4 "bad_signature"

# G5: no public key in the binary.
fresh
build_gate ""
expect_refusal G5 "no_public_key"

# A binary from make server-build (no embedded assets) refuses by default.
make server-build
code=0
out=$(run_gate build/pulsus-dash) || code=$?
want='pulsus-dash: no embedded client assets: this binary was built without -tags embedassets; use make build, or serve --api-only for development'
grep -qF "$want" <<<"$out" || { echo "$out" >&2; fail "server-build: no refusal message"; }
[ "$code" -eq 1 ] || fail "server-build: exit $code, want 1"
echo "ci:asset-integrity: make server-build binary refused as expected"
echo "ci:asset-integrity: ok"
