#!/usr/bin/env bash
# F1 (plan #59 §3.10): the binary make build produced starts against Postgres, verifies its
# assets, serves the document with the T18-002 headers and a br asset, and stops cleanly on TERM.
# Needs F1_OWNER_URL and F1_APP_URL (a database with server/deploy/postgres-roles.sql applied).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ -z "${F1_OWNER_URL:-}" ] || [ -z "${F1_APP_URL:-}" ]; then
  echo "F1_OWNER_URL and F1_APP_URL must be set" >&2
  exit 1
fi
export PULSUS_DASH_POSTGRES_OWNER_URL_REF=env:F1_OWNER_URL
export PULSUS_DASH_POSTGRES_APP_URL_REF=env:F1_APP_URL
export PULSUS_DASH_DATASOURCE_URL=http://localhost:3100
export PULSUS_DASH_SERVER_LISTEN=localhost:18080
export PULSUS_DASH_LOG_FORMAT=text

BASE=http://localhost:18080
OUT=build/f1
mkdir -p "$OUT"

fail() {
  echo "F1: $*" >&2
  exit 1
}

build/pulsus-dash migrate >"$OUT/migrate.out" 2>"$OUT/migrate.err" || { cat "$OUT/migrate.err" >&2; fail "migrate failed"; }
grep -qF 'seeded organisation "default" with tenant binding "default"' "$OUT/migrate.out" ||
  { cat "$OUT/migrate.out" >&2; fail "migrate did not seed the default organisation"; }

build/pulsus-dash serve 2>"$OUT/serve.err" &
SERVER_PID=$!
trap 'kill -TERM $SERVER_PID 2>/dev/null; wait $SERVER_PID' EXIT

ready=0
for _ in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/readyz" || true)" = 200 ]; then
    ready=1
    break
  fi
  sleep 0.5
done
[ "$ready" = 1 ] || { cat "$OUT/serve.err" >&2; fail "/readyz not 200 within 30 s"; }
grep -qF 'assets verified files=' "$OUT/serve.err" || { cat "$OUT/serve.err" >&2; fail "no 'assets verified files=' on stderr"; }

curl -s -D "$OUT/doc.headers" -o /dev/null -H 'Accept: text/html' "$BASE/"
grep -qi '^HTTP/1.1 200' "$OUT/doc.headers" || fail "GET / is not 200"
grep -qi "^content-security-policy: default-src 'none'; script-src 'self';" "$OUT/doc.headers" || fail "GET / lacks the CSP"
grep -qi '^cross-origin-embedder-policy: require-corp' "$OUT/doc.headers" || fail "GET / lacks COEP require-corp"

js=$(curl -s "$BASE/asset-manifest.json" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const p = JSON.parse(s).files.map((e) => e.path).find((x) => /^assets\/[^/]+\.js$/.test(x));
    if (p === undefined) process.exit(3);
    process.stdout.write(p);
  });') || fail "no assets/*.js in /asset-manifest.json"
curl -s -D "$OUT/asset.headers" -o /dev/null -H 'Accept-Encoding: br' "$BASE/$js"
grep -qi '^HTTP/1.1 200' "$OUT/asset.headers" || fail "GET /$js is not 200"
grep -qi '^content-encoding: br' "$OUT/asset.headers" || fail "GET /$js is not served br"

trap - EXIT
kill -TERM "$SERVER_PID"
code=0
wait "$SERVER_PID" || code=$?
[ "$code" -eq 0 ] || { cat "$OUT/serve.err" >&2; fail "serve exited $code on TERM, want 0"; }
echo "F1: ok"
