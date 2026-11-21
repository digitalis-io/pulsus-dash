# Server (BFF)

The Pulsus Dash server is one Go binary, `pulsus-dash`, in `server/`
([ADR-0015](../../designs/adr/0015-go-bff.md)). It loads a strict configuration, checks
Postgres, applies migrations and seeds the first organisation, verifies and serves the embedded
web client, and serves health, readiness, the version, the client's bootstrap, CSP reports and the
[boards API](boards-api.md) (boards with versions and an audit trail, starred and recent boards).
It serves the PromQL query, completion and data-source check routes from PulsusDB through its one
client ([the PulsusDB page](pulsusdb.md)); start-up and readiness never contact PulsusDB
([T06-026](../../designs/technical/T06-bff-architecture.md)). Authentication comes in a later issue.

The HTTP contract is spec-first: `api/openapi.yaml` is the source, the Go server code
(`server/internal/gateway/api/api.gen.go`) and the TypeScript client types
(`client/src/api/gen/schema.d.ts`) are generated from it and committed, and `ci:api-gen` fails
when either is stale. See [build and CI](../development/build-and-ci.md#server).

Postgres roles, the schema, row-level security and migrations are described in
[the database page](database.md).

## Build and run

```bash
make build                             # build/pulsus-dash with the client embedded (release)
make server-build                      # build/pulsus-dash without the client (serve --api-only)
build/pulsus-dash version
build/pulsus-dash config check --config server/config.example.yaml
build/pulsus-dash migrate --config my.yaml   # as pulsus_owner; once per release
build/pulsus-dash serve --config my.yaml     # as pulsus_app
```

`make build VERSION=1.2.3` (or `make server-build VERSION=1.2.3`) stamps the version
(`-X …/internal/core.Version`). The commit is the VCS revision Go records at build time, or
`unknown`. `make build` is described in [Serving the client](#serving-the-client); a binary from
`make server-build` has no client and refuses to `serve` unless `--api-only` is given.

For a local server with Postgres in containers, use the dev stack: create `dev/local.env`, then
`make dev-up` starts Postgres, migrates and serves in the foreground
([dev stack page](../development/dev-stack.md)).

**Third-party notices.** `make go-licenses` checks that every module linked into `pulsus-dash` has an
AGPL-3.0-compatible licence and writes `build/THIRD_PARTY_NOTICES.txt` with their licence and
notice files ([`ci:go-licenses`](../development/build-and-ci.md#licences-cigo-licenses)). CI keeps
the file as the `third-party-notices` artifact.

## Commands

| Command | Flags | Exit 0 | Exit 1 (runtime) | Exit 2 (usage or configuration) |
|---|---|---|---|---|
| `serve` | `--config PATH`, `--role LIST` (overrides `server.roles`), `--api-only` (development only: no client) | clean shutdown after SIGINT or SIGTERM | no embedded client, asset integrity failure, Postgres unreachable, role bypasses RLS, schema outside the window, database not seeded, listen failure, shutdown timeout | configuration error, unknown or unavailable role |
| `migrate` | `--config PATH`, `--dry-run` | applied, or nothing to apply | Postgres, lock or schema-ahead failure | configuration error, including invalid seed settings on an unseeded database |
| `config check` | `--config PATH`, `--for serve\|migrate` (default `serve`) | prints `config ok (for <command>)` | — | any configuration error |
| `version` | `--json` | prints the version | — | bad flag |

Errors go to stderr, prefixed `pulsus-dash: `. With no command or an unknown one, the binary
prints `usage: pulsus-dash <serve|migrate|config check|version> [flags]` and exits 2.

**`version`** prints `pulsus-dash 0.1.0-dev (commit <sha>, go1.27.4, schema 2)`. With `--json` it
prints `{"version":…,"commit":…,"go":…,"schema":2}`, where `schema` is the latest migration
embedded in the binary.

**`serve`** start-up steps, in order. The first failure ends the process.

1. Load the configuration and require `postgres.app_url_ref` (exit 2).
2. The roles must be exactly `[all]` (T06-003); an empty list (`no role given: only "all" is
   supported`) or a repeated one (`roles must be exactly "all" in this release, not "all,all"`)
   exits 2. `api`, `worker`, `evaluator`, `notifier` and `ai` are
   named but not available in this release:
   `role "api" is not available in this release: only "all" is supported`. Any other value is
   `unknown role "bogus" (want all, api, worker, evaluator, notifier or ai)`. Both exit 2.
3. Build the logger and resolve the app role's URL (exit 2).
4. Verify the client assets before Postgres is contacted or a listener opens
   ([ADR-0016](../../designs/adr/0016-asset-integrity-verified-by-bff.md)); see
   [start-up verification](#start-up-verification). A binary without embedded assets exits 1 with
   `no embedded client assets: this binary was built without -tags embedassets; use make build, or
   serve --api-only for development`. With `--api-only` this step only logs a warning.
5. Ping Postgres with a 5 s timeout: `postgres unreachable: <driver error>` (exit 1). The driver's
   message never contains the password.
6. Refuse a role that is a superuser or has `BYPASSRLS`:
   `postgres role "postgres" bypasses row-level security; serve must connect as pulsus_app`.
7. The schema version must be the binary's latest or one newer (T11-015, T19-007). Otherwise the
   message is `database schema version 1 is older than this binary requires (2); run pulsus-dash
   migrate` or `database schema version 4 is newer than this binary supports (latest 2, window +1)`.
   A database at version 2 or 3 is accepted.
8. The first-run seed must exist: `database is not initialised; run pulsus-dash migrate`.
9. Listen on `server.listen`, then log `msg=listening addr=…`. If `server.public_url` is set,
   start the [public-URL self-check](#public-url-self-check).
10. Serve until SIGINT or SIGTERM, then drain for at most `server.shutdown_grace`. Exit 1 if the
   drain times out.

**`migrate`** connects as the owner role and prints its progress on stdout. See
[the database page](database.md#migrate) for the lock, the N+1 window and the seed.

| Situation | Output |
|---|---|
| Migrations applied | one `applied <file>` per file (`applied 00001_tenancy.sql`, `applied 00002_boards.sql` from empty), then `schema at version 2` |
| Nothing to apply | `schema at version 2; nothing to apply` |
| Database one version ahead | `schema at version 3 (one ahead of this binary); nothing to apply` |
| Seed written / already present | `seeded organisation "default" with tenant binding "default"` / `organisation already seeded` |
| `--dry-run` | one `pending <file>` per migration; `would seed …` when unseeded; last line `dry run: nothing changed` |
| Another migrate holds the lock | `waiting for migration lock` (once). It waits for at most 5 minutes, then fails with `timed out after 5m0s waiting for the migration lock` |
| Database more than one version ahead | `database schema version 4 is ahead of this binary (latest 2); refusing to migrate outside the N+1 window` (exit 1) |

**`config check`** runs the same loading and validation as the command named by `--for`. It also
resolves every set Postgres reference and checks the roles for `serve`. It never connects to
anything. With `--for migrate` it also checks the seed settings and prints problems as
`warning: <message> (used only to seed a new database)` without failing, because they matter only
when `migrate` meets an empty database.

## Configuration

Values are applied in this order: defaults, then one YAML file (`--config`), then environment
variables. [`server/config.example.yaml`](../../server/config.example.yaml) lists every key with
its default.

| Key | Default | Rule | Needed by |
|---|---|---|---|
| `server.roles` | `[all]` | only `all` in this release | — |
| `server.listen` | `0.0.0.0:8080` | `host:port` | — |
| `server.shutdown_grace` | `15s` | 1 s to 30 s | — |
| `server.public_url` | `""` | optional: an absolute `http` or `https` URL with a host and no credentials, query or fragment; a trailing `/` is removed. Errors: `must be an absolute http or https URL`, `must not contain credentials, a query or a fragment` | the [self-check](#public-url-self-check) |
| `postgres.app_url_ref` | — | secret reference | `serve` |
| `postgres.owner_url_ref` | — | secret reference | `migrate` |
| `postgres.pool_max` | `32` | 1 to 512 | — |
| `datasource.url` | — | seed only: `http`/`https`, a host, no credentials, no query or fragment | `migrate` on an empty database |
| `datasource.slug` | `default` | seed only: `^[a-z0-9-]{1,40}$` | — |
| `datasource.database` | `""` | seed only: `^[A-Za-z0-9_.-]{1,150}$` when set | — |
| `datasource.scope_org_id` | `""` | seed only: same pattern | — |
| `datasource.credentials_ref` | `""` | seed only: `env:NAME` or `file:/path`, stored as the reference string. When it resolves, the secret must be `user:password` with a password of at least 8 characters that is not a number ([credentials](pulsusdb.md#credentials)) | — |
| `pulsusdb.tenant_concurrency` | `16` | 1 to 1024: PulsusDB calls in flight per tenant binding ([tenant concurrency](pulsusdb.md#tenant-concurrency)) | `serve` |
| `bootstrap.org_slug` | `default` | seed only: `^[a-z0-9-]{1,40}$` | — |
| `bootstrap.org_name` | `Default organisation` | seed only: 1 to 200 characters | — |
| `log.level` | `info` | `debug`, `info`, `warn`, `error` | — |
| `log.format` | `json` | `json`, `text` | — |
| `allow_inline_secrets` | `false` | `true` or `false` | — |

Errors read `config: <key>: <message>`, for example `config: postgres.pool_max: must be between 1
and 512`.

### Strictness (T06-019)

- **YAML.** The file must hold exactly one document
  (`config: the file must contain one YAML document`). An unknown key is an error with its line:
  `config: unknown key "server.lisen" (line 2)`. So is a repeated key:
  `config: duplicate key "server.listen" (line 3)`. A wrong shape is an error too, for example
  `config: server: must be a mapping (line 1)` or
  `config: server.listen: must be a string (line 2)`.
- **Environment.** The variable name is `PULSUS_DASH_` plus the key path in upper case with `.`
  replaced by `_`, for example `PULSUS_DASH_SERVER_LISTEN` or `PULSUS_DASH_POSTGRES_POOL_MAX`.
  `PULSUS_DASH_SERVER_ROLES` takes a comma list. Any other `PULSUS_DASH_*` variable is an error
  (`config: unknown environment variable PULSUS_DASH_SERVER_LISEN`), except the ones the client
  tooling reads (`PULSUS_DASH_DEV_BFF`), which the server accepts and ignores. A value that does
  not parse names the variable: `config: PULSUS_DASH_POSTGRES_POOL_MAX: must be an integer`.
  Variables named by secret references should not start with `PULSUS_DASH_`.

### Secret references (T19-010)

Keys ending in `_ref` hold a reference, not a secret:

| Reference | Resolves to | Errors |
|---|---|---|
| `env:NAME` (`NAME` matches `^[A-Za-z_][A-Za-z0-9_]{0,127}$`) | the variable's value | `environment variable NAME is not set` |
| `file:/absolute/path` (the path is 1 to 1023 bytes, with no ASCII whitespace or control character) | the file's contents, one trailing newline removed | `cannot read file PATH`; `file PATH is larger than 64 KiB` |
| `vault://…` | — | `vault references are not supported in this release` |
| anything else | a literal | refused with `inline secrets are refused; use env:NAME or file:PATH (or set allow_inline_secrets: true for development)`. With `allow_inline_secrets: true` it is used and logged once at `warn` as `inline secret used key=<key>` |

A malformed reference is `must be env:NAME or file:/absolute/path`. No message or log line contains
a resolved value or a literal.

### Seed settings

`datasource.*` and `bootstrap.*` describe the first organisation and its PulsusDB binding.
`config.Load` checks only their keys and types. Their values are checked by `SeedSettings`, which
`migrate` calls only when the database has no seed yet. After the seed, the binding stored in
Postgres is authoritative: `migrate` and `serve` never read these keys again, so stale or invalid
values there are ignored. `datasource.credentials_ref` is stored as the reference string. When it
resolves in `migrate`'s environment, `SeedSettings` also refuses a weak password with
`config: datasource.credentials_ref: the PulsusDB password must be at least 8 characters and must
not be a number`; an unresolvable reference is accepted, since `serve` resolves it later.
`config check` (for `serve`) applies the same check. A literal is refused with
`an inline secret cannot be stored in the tenant binding; use env:NAME or file:PATH`, even with
`allow_inline_secrets`.

## HTTP routes

Requests are matched in this order:

| Request | Response |
|---|---|
| `GET /healthz`, `/startupz`, `/readyz`, `GET /api/dash/v1/version`, `GET /api/dash/v1/bootstrap` | the API routes below |
| `/api/dash/v1/boards…`, `/api/dash/v1/me/starred-boards…`, `/api/dash/v1/me/recent-boards…` | the [boards API](boards-api.md) |
| `POST /api/dash/v1/csp-report` | [CSP reports](#csp-reports) |
| `POST /api/dash/v1/query/promql/{range,instant}`, `GET /api/dash/v1/prom/{labels,label/{name}/values,series,metadata}`, `GET /api/dash/v1/datasource/check` | [the PulsusDB routes](pulsusdb.md#routes) |
| `GET`/`HEAD /assets/*` | the file from the verified set with the asset headers; not in the set, or no set → 404 envelope |
| `/api` or any path under `/api/`, any method | 404 envelope |
| any path under `/auth/`, any method | 404 envelope (there is no authentication yet, D12) |
| `GET`/`HEAD /asset-manifest.json`, `/asset-manifest.sig` | the exact bytes that were verified, `Cache-Control: no-cache`, `application/json` / `application/octet-stream` |
| `GET`/`HEAD` of another root file of the set (not `index.html`) | that file with the asset headers and `Cache-Control: no-cache` |
| `GET`/`HEAD` whose `Accept` contains `text/html` | `index.html` with the document headers: client-side routes such as `/t/demo/boards` deep-link (ADR-0014 §6) |
| anything else | 404 envelope `{"error":{"code":"not_found","message":"not found"}}` |

Under `serve --api-only` there is no set, so every row that serves a file is a 404 envelope.

| API request | Status | Body |
|---|---|---|
| `GET /healthz`, `GET /startupz` | 200 | `{"status":"ok"}` |
| `GET /readyz`, Postgres answers and the schema is in the window | 200 | `{"status":"ready","checks":{"postgres":"ok","schema":"ok","audit_partitions":"ok"}}` |
| `GET /readyz`, ping fails or takes over 1 s | 503 | `{"status":"not_ready","checks":{"postgres":"unreachable","schema":"unknown","audit_partitions":"…"}}` |
| `GET /readyz`, schema behind or more than one ahead | 503 | `"schema":"behind"` or `"ahead"` |
| `GET /readyz`, the schema query fails or takes over 1 s | 503 | `"schema":"error"` or `"timeout"`, logged at `warn` as `msg=readyz check=schema` |
| `GET /readyz`, audit partitions `low` or `unknown` | 200 | `"audit_partitions":"low"` or `"unknown"` ([audit partitions](database.md#audit-partitions)) |
| `GET /readyz`, audit partitions `error` | 503 | `{"status":"not_ready","checks":{"postgres":"ok","schema":"ok","audit_partitions":"error"}}` |
| a `POST` or `PUT` body over 2 MiB (not `csp-report`) | 413 | `{"error":{"code":"invalid","message":"request body too large"}}` (T06-021) |
| `GET /api/dash/v1/version` | 200 | `{"version":"0.1.0-dev","commit":"<sha>"}` |
| `GET /api/dash/v1/bootstrap` | 200 | see [bootstrap](#bootstrap) |
| `GET /api/dash/v1/bootstrap`, the store fails | 503 | `{"error":{"code":"unavailable","message":"configuration store unavailable"}}`, logged at `warn` as `msg=bootstrap` |
| `GET /api/dash/v1/bootstrap`, the organisation has no binding | 503 | `{"error":{"code":"unavailable","message":"no tenant binding"}}` |
| `POST …/query/promql/range`, `…/instant` | 200; 400, 404, 413, 422, 429, 502, 503, 504 | frames and completeness; the error envelope ([PulsusDB routes](pulsusdb.md#errors-t06-52)) |
| `GET …/prom/labels`, `…/label/{name}/values`, `…/series`, `…/metadata` | 200; 400, 404, 422, 429 (with `Retry-After`), 502, 503, 504 | values, series or metadata with completeness; the error envelope |
| `GET /api/dash/v1/datasource/check` | 200; 400, 404, 503, 504 | `{"state":"ok\|unreachable\|unauthorised\|error","checked_at":<ms>}` ([check](pulsusdb.md#data-source-check-t06-025)) |
| known path, wrong method | 405 | `{"error":{"code":"invalid","message":"method not allowed"}}` |
| handler panic | 500 | `{"error":{"code":"internal","message":"internal error"}}`, stack logged at `error` |

`/startupz` is 200 as soon as the listener is open, because there is no cache to warm yet
(T19-006). `/readyz` never contacts PulsusDB, so it stays 200 while PulsusDB is down. It returns
503 while Postgres is down, but the process keeps running. Every response, also a 503, reports
`audit_partitions`, the health of the audit partitions (T11-021); alert on any value other than
`ok`.

Every API response carries `Content-Type: application/json`, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff` and `X-Request-Id`; documents and assets replace
`Content-Type` and `Cache-Control` with their own. An incoming `X-Request-Id` that matches
`^[A-Za-z0-9-]{1,64}$` is kept; otherwise the server generates a UUIDv7. The HTTP server uses
`ReadHeaderTimeout` 10 s, `IdleTimeout` 120 s and `MaxHeaderBytes` 1 MiB.

### Bootstrap

`GET /api/dash/v1/bootstrap` is the client's first call in `VITE_API_MODE=http`:

```json
{"principal": {"id": "local", "name": "Local user", "email": "", "role": "admin"},
 "org": {"slug": "default", "name": "Default organisation"},
 "tenants": [{"slug": "default", "name": "default", "datasource": {"state": "not_checked"}}],
 "default_tenant": "default",
 "server": {"version": "0.1.0-dev", "commit": "<sha>"},
 "can_sign_out": false}
```

- **Principal.** There is no authentication yet (decision D12). Every request is the fixed local
  principal `local`, an administrator, which cannot sign out (`can_sign_out: false`). This lasts
  until authentication lands (M-UI6).
- **Organisation and tenants.** The bootstrap organisation (`install_state`) and its tenant
  bindings, ordered by slug, read in one organisation-bound transaction under row-level security.
  `default_tenant` is the first binding.
- **Data source.** Only the binding's slug and the state `not_checked` are returned. The
  datasource URL, database, scope and credentials reference are never returned (T06-024). The
  data-source check is `GET /api/dash/v1/datasource/check`
  ([check](pulsusdb.md#data-source-check-t06-025)); the client calls it for the sidebar.

### CSP reports

`POST /api/dash/v1/csp-report` receives the reports the documents' `Reporting-Endpoints` and
`report-to csp` ask browsers to send (T18-003). The operation is in `api/openapi.yaml` (so the
client types cover it) but excluded from Go generation and handled by hand
(`internal/gateway/cspreport.go`).

| Aspect | Behaviour |
|---|---|
| Media type | `application/reports+json` (an array; only `type: "csp-violation"` entries are used) or `application/csp-report` (`{"csp-report": {…}}`); anything else → 415 `unsupported media type` |
| Rate | one process-wide token bucket, 10 per second with a burst of 20, and at most 8 reports read at once; checked before the body is read. Empty bucket or no free slot → 429 `unavailable` `rate limited` with `Retry-After: 1` |
| Body | at most 64 KiB (413 `payload too large`), read under a 5 s read deadline (408 `request timeout`). The body is never read without a deadline: if the connection cannot take one, the request fails with 500 `internal error` and `msg=csp_report_no_deadline` at `error` |
| Parse | invalid JSON → 400 `bad request`; at most 20 reports per request are used, and `msg=csp_report_truncated ignored=<n>` is logged for the rest |
| Success | 204, no body |

Every refusal before the body is fully read also closes the connection. Each used report writes
one `warn` record `msg=csp_violation` with allowlisted values only:

| Attribute | Value |
|---|---|
| `directive` | the effective (else violated) directive up to the first space, if it is a known CSP directive; else `other` |
| `disposition` | `enforce`, `report` or `other` |
| `route` | the client route pattern the document path matches (`/`, `/signed-out`, `/t/:tenant`, `/t/:tenant/boards`, `/t/:tenant/board/:uid`, `/t/:tenant/explore/metrics`, `/t/:tenant/explore/logs`, `/t/:tenant/admin`), else `unknown` |
| `blocked` | `inline`, `eval`, `wasm-eval`, `trusted-types-policy`, `trusted-types-sink`, `data`, `blob`, `url` (any other value) or `none` |

URLs, hosts, paths, tenant slugs, queries, samples, source files, line and column numbers are
never logged. This record is the self-telemetry of CSP violations until OTel export exists.

## Serving the client

The release binary embeds the client build and serves it with the security headers itself, so the
headers do not depend on a proxy (T18-001, T18-002, T19-002, ADR-0014 §9).

### Build

`make build` runs three steps:

1. `make client-build`: `VITE_API_MODE=$(API_MODE) VITE_GIT_SHA=$(GIT_SHA) npm --prefix client
   run build`, with `API_MODE ?= http` and `GIT_SHA ?=` the current commit.
2. `make assets-pack`: `node client/scripts/pack-assets.ts --gen-key build/keys` writes a fresh
   Ed25519 key pair, then `pack-assets.ts --in client/dist --out
   server/internal/gateway/static/dist --key build/keys/asset-signing.key` packs the build (below).
3. `go build -tags embedassets` with the build's public key in
   `-X …/internal/gateway/static.releasePublicKeys=…`, into `$(OUT)` (default
   `build/pulsus-dash`).

`server/internal/gateway/static/dist/` and `build/` are gitignored. Without `-tags embedassets`
(`make server-build`, `go test`), the binary has no embedded tree.

### Packing and the manifest

`client/scripts/pack-assets.ts` (Node, no dependencies):

- copies every file of the build except `.vite/` (the Vite manifest is a build artefact). A
  symlink or another non-regular entry fails with `pack: symlink in build output: <path>` (exit 2);
- writes `<file>.br` (brotli quality 11) and `<file>.gz` (gzip level 9) for each `.html`, `.js`,
  `.mjs`, `.css`, `.svg`, `.json`, `.txt`, `.map`, `.wasm` or `.xml` file of at least 256 bytes,
  and keeps a variant only if it is smaller;
- writes `asset-manifest.json`: `{"version": 1, "files": [{"path", "sha384", "size"}]}` for
  every file except the manifest and its signature (variants and `index.html` included), sorted
  by path, `sha384` in standard base64, two-space indented with a final newline;
- writes `asset-manifest.sig`: the 64-byte raw Ed25519 signature over the manifest's exact bytes;
- prints `packed <n> files (<m> compressed variants) into <out>`.

The output is byte-identical for the same build and key. Errors print `pack: <reason>` and exit 2;
no message contains key material.

**Keys.** Each `make build` generates a new key pair (decision Q3): the private key stays in
`build/keys/asset-signing.key` (mode 0600) and is never embedded or printed; the public key is
compiled into that binary only. `releasePublicKeys` takes a comma-separated list, so a release
key and a rotation key can both be accepted (T18-006). Signing with a long-lived release key (KMS)
belongs to the release pipeline and is not built yet; until then the signature proves that the
served bytes are the ones this build packed.

### Start-up verification

`serve` verifies the embedded tree before it contacts Postgres or opens a listener, and refuses to
start on any failure (ADR-0016). In order:

1. at least one public key (`no_public_key`);
2. `asset-manifest.json` and `asset-manifest.sig` exist (`missing_manifest`, `missing_signature`);
3. the signature is 64 bytes and verifies under one of the keys (`bad_signature`);
4. the manifest is one strict JSON value with `version: 1`, valid, unique and sorted paths, no
   `..`, sizes ≥ 0, 48-byte digests, and no `.br`/`.gz` entry without its base file
   (`bad_manifest <path>`);
5. the tree holds only directories and listed regular files (`walk_error`, `unexpected_entry`,
   `unlisted_file <path>`);
6. every listed file exists and is regular (`missing_file`, `read_error`, `unexpected_entry`), has
   the listed size (`size_mismatch`, checked before hashing) and the listed SHA-384
   (`hash_mismatch`).

A failure logs `msg=asset_integrity_failed reason=… path=… expected=… actual=…` at `error`,
prints `pulsus-dash: asset integrity check failed: <reason>[ <path>]` and exits 1. Success logs
`msg="assets verified" files=<n>` (logical files, variants not counted). After verification the
set is held in memory and shared read-only; nothing is read from disk at run time.

`serve --api-only` is for development only, next to `VITE_API_MODE=http npm run dev`, which serves
the client itself. It
logs `msg="serving the API only (development); no client assets are served"` at `warn`, skips the
assets (even an embedded set), and answers every document request with the 404 envelope. It
therefore never serves anything unverified.

### Headers, caching and encoding

Documents (`index.html`) carry, in this order:

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types pulsus-sanitised; report-to csp` (ADR-0014 §9; identical to `CSP` in `client/config/headers.ts`) |
| `Reporting-Endpoints` | `csp="/api/dash/v1/csp-report"` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Embedder-Policy` | `require-corp` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` (ignored by browsers over plain HTTP) |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), geolocation=(), microphone=(self), usb=(), payment=(), gamepad=(self)` |
| `Cache-Control` | `no-cache` |
| `Content-Type` | `text/html; charset=utf-8` |

Other files carry `Cross-Origin-Resource-Policy: same-origin`, `X-Content-Type-Options: nosniff`,
the content type of their extension, an `ETag`, and `Cache-Control: public, max-age=31536000,
immutable` under `/assets/` (the names are content-hashed) or `no-cache` elsewhere. They carry no
CSP.

- **Encoding.** `Accept-Encoding` is parsed with q-values (`q=0` refuses a coding). The `br`
  variant is sent if accepted and present, else `gzip`, else the file itself. `Vary:
  Accept-Encoding` is set when a variant exists; `Content-Encoding` only for `br` and `gzip`.
- **Validators.** Each representation (identity, br, gzip) has its own strong ETag, so a validator
  of one encoding never produces a 304 for another.
- **Ranges.** The identity representation supports `HEAD`, `Range` (206) and `If-None-Match` (304).
  Encoded variants send `Accept-Ranges: none` and ignore `Range`.

### Public-URL self-check

When `server.public_url` is set, `serve` makes one request right after the listener opens
(T19-002), with a 2 s timeout and no redirects: `GET <public_url>/` with `Accept: text/html`, or
`GET <public_url>/healthz` under `--api-only`. It checks that a proxy in front of the BFF keeps the
document headers:

| Outcome | Log (`msg=public_url_self_check`) |
|---|---|
| 200 and, with assets, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` and the exact CSP | `info` `result=ok` |
| transport error or timeout | `warn` `result=unreachable` |
| another status | `warn` `result=status status=<code>` |
| a header missing or changed | `warn` `result=headers_stripped header=<the first one found>` |

It never retries, never fails start-up, never logs the URL, and is cancelled on shutdown.

## Logs

Logs are structured (`log/slog`) on stderr, JSON by default. Each request writes one `msg=http`
record with `method`, `route` (the route pattern, never the raw path or query; `unmatched` for a
404), `status`, `duration_ms` and `request_id`. A request whose client went away before any
header was written is logged with `status=499`. PulsusDB calls add one `msg=pulsusdb` record each
([logs](pulsusdb.md#logs)).

## Code layout

| Package | Role |
|---|---|
| `cmd/pulsus-dash` | the CLI; `run(ctx, runEnv)` makes every command testable in-process |
| `internal/config` | loading, strictness, secret references, seed settings |
| `internal/core` | shared types: `OrgID`, tenant bindings, build info, the actor and `RequestCtx` (with the tenant, principal and data scope of PulsusDB calls), the password rule, the `Boards` service interface, `PartitionState` |
| `internal/spec` | the board spec v1: strict decoding, validation, the upcaster, canonical JSON and the JSON Patch ([boards API](boards-api.md#board-spec-v1)) |
| `internal/boards` | the boards service: versions, ETags, audit events, starred and recent boards |
| `internal/gateway` | router, error envelope, headers, access log, panic recovery, body limit, health, version and bootstrap routes, board routes, the PulsusDB routes and JSON frames, CSP reports, asset and document serving, the public-URL self-check; `api/` is generated |
| `internal/keyhash` | the series key (T04-004) |
| `internal/pulsusdb` | the only PulsusDB client ([PulsusDB page](pulsusdb.md)) |
| `internal/pulsusfake`, `cmd/pulsus-fake` | the PulsusDB stand-in for tests and the dev stack ([testing against PulsusDB](../development/testing-pulsusdb.md)) |
| `internal/gateway/static` | the embedded client tree (`-tags embedassets`), the release public keys and start-up verification; `statictest/` builds signed trees for tests |
| `internal/store` | the only Postgres access path ([database page](database.md)); `dbgen/` is generated by sqlc |
| `internal/telemetry` | the logger |

Lint rules (`server/.golangci.yml`) keep `pgx`, `goose` and the sqlc output inside
`internal/store` (T11-023), `chi` and the generated server inside `internal/gateway` (T06-001),
outbound HTTP inside `internal/pulsusdb` (`pulsusdb-only`, T06-005), and upstream body decoding
inside its tokenizer (`pulsusdb-decoder`). A self-test with failing fixtures proves these rules are
enforced
([build and CI](../development/build-and-ci.md#make-targets)).

## Designs

T06-001, T06-003, T06-016, T06-019, T06-021 (CSP report limits and the 2 MiB body limit, also on the
query routes), T06-024 and T06-026 in
[T06](../../designs/technical/T06-bff-architecture.md); T18-001, T18-002, T18-003, T18-006 and
T18-007 and T18-026 (`ci:go-licenses`) in [T18](../../designs/technical/T18-security.md); T19-002, T19-003, T19-005, T19-006,
T19-007 and T19-010 in [T19](../../designs/technical/T19-deployment.md); T03-022 in
[T03](../../designs/technical/T03-browser-runtime.md);
[ADR-0014](../../designs/adr/0014-typescript-react-web-client.md) §6 and §9,
[ADR-0015](../../designs/adr/0015-go-bff.md),
[ADR-0016](../../designs/adr/0016-asset-integrity-verified-by-bff.md).
