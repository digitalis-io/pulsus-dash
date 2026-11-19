# Server architecture: the `pulsus-dash` binary

What the BFF skeleton is: one binary that serves the browser runtime under the production
security headers, reports health, and owns the Postgres schema under row-level security. There is
no PulsusDB client, login or data route yet (#40, #41).

Implements [T06-001, T06-003, T06-016, T06-017, T06-019, T06-026](../../designs/technical/T06-bff-architecture.md),
[T11-001, T11-002, T11-003, T11-012, T11-013, T11-015, T11-023, T11-026, T11-027](../../designs/technical/T11-postgres-schema.md),
[T18-001, T18-002, T18-003, T18-005](../../designs/technical/T18-security.md),
[T19-002, T19-006, T19-007, T19-010](../../designs/technical/T19-deployment.md), T03-022 and the
identity tables of [ENT-020](../../designs/product/11-enterprise.md), following
[ADR-0006](../../designs/adr/0006-pulsusdb-and-postgres.md) and
[ADR-0012](../../designs/adr/0012-derived-state-in-postgres.md). Configuration is on its own page:
[Server configuration](configuration.md). Running it locally: [Dev stack](../development/dev-stack.md).

## Crates

| Crate | Path | Role |
|---|---|---|
| `dash-core` | `server/crates/dash-core` | `RequestCtx`, `TenantCtx`, `TenantBinding`, `Principal`, `Deadline`, UUIDv7 id newtypes, `ScopeOrgId` (`X-Scope-OrgID`), the JSON error envelope, `HealthProbe`, `Secret` (prints `***`) |
| `dash-config` | `server/crates/dash-config` | Strict layered configuration (YAML, `PULSUS_DASH_*`, CLI) and secret references |
| `dash-store` | `server/crates/dash-store` | The only Postgres path: `Db::tx(org)`, migrations, repositories, first-run seeding, `StoreHealth` |
| `dash-gateway` | `server/crates/dash-gateway` | The only axum crate: health routes, the CSP report endpoint, static assets with headers |
| `pulsus-dash` | `server/bin/pulsus-dash` | The binary: CLI, start-up, signals, the public-URL self-check |

`ci:dep-audit` enforces the dependency rule (T06-001, T11-023) on the direct normal dependencies
of every member under `server/` (`[server]` in `ci/dep-audit.toml`):

| Rule | Fails when |
|---|---|
| `server-framework-outside-gateway` | a crate other than `dash-gateway` depends on `axum`, `axum-core`, `axum-extra`, `tower-http`, `actix-web`, `warp`, `poem`, `rocket`, `salvo` or `tide` |
| `sql-crate-outside-store` | a crate other than `dash-store` depends on `sqlx*`, `tokio-postgres`, `postgres`, `diesel` or `sea-orm` |
| `http-client-outside-allowed` | a crate outside `pulsusdb-client`, `dash-notify`, `dash-ai`, `dash-telemetry` and `pulsus-dash` depends on `hyper`, `hyper-util`, `hyper-rustls`, `reqwest`, `ureq` or `isahc` (`pulsus-dash` only for its self-check of its own public URL) |
| `sql-outside-store` | a `.rs` file under `server/` or `crates/` outside `server/crates/dash-store/` contains `sqlx::` |

## Commands and exit codes

```
pulsus-dash [--config PATH] [--role ROLES]     # serve; ROLES is a comma list, only `all` today
pulsus-dash migrate [--config PATH]            # apply the embedded migrations, then exit
```

| Code | Meaning |
|---|---|
| 0 | clean shutdown (SIGINT/SIGTERM), or `migrate` done |
| 1 | fatal runtime error: cannot bind, seeding failed, an unexpected database error; `migrate`: Postgres unreachable or a migration failed (logged as error kind and SQLSTATE) |
| 2 | usage or configuration error (`pulsus-dash: configuration error: …` on stderr) |
| 3 | schema incompatible: not migrated, older than required, or beyond the N+1 window |

`--role api` (or any role other than `all`) exits 2: ``role `api` is not implemented in this
build; only `all` is supported (T06-003)``.

## Start-up

1. Load and validate the configuration, resolve secret references in memory (exit 2 on any
   error, before any connection is attempted).
2. Initialise logging (to stderr, `log.format` text or JSON).
3. Bind the listen address and log `pulsus-dash listening on http://<bound addr>`.
4. Create the lazy Postgres pool and start serving. Static assets, `/healthz` and the CSP report
   endpoint work from here; `/startupz` and `/readyz` answer 503 until step 6.
5. If `public_url` is set, run the self-check once in the background.
6. The start-up task: read the schema status (Postgres unavailable → warn `waiting for postgres`
   and retry every 2 s, unbounded; not migrated, too old or too new → exit 3), then seed the
   default org (unavailable → retry every 2 s; any other error → exit 1), then mark the server
   started.

SIGINT or SIGTERM stops accepting connections and drains in-flight requests for at most 30 s,
then exits 0.

## Health

Readiness never depends on PulsusDB (T06-026).

| Route | 200 | 503 |
|---|---|---|
| `GET /healthz` | `{"status":"ok"}` (always, from bind) | — |
| `GET /startupz` | `{"status":"started"}` | `{"error":{"code":"unavailable","message":"starting","hint":{"check":"startup"}}}` |
| `GET /readyz` | `{"status":"ready","schema_level":1}` | `{"error":{"code":"unavailable","message":"<message>","hint":{"check":"startup"\|"postgres"\|"schema"}}}` |

`/readyz` runs one schema-status query bounded by 1 s: `postgres` when Postgres cannot answer in
time, `schema` when the schema left the compatibility window. Health responses carry
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, CORP `same-origin` and
`Content-Type: application/json`. Errors use the T06 §5.2 envelope.

## Static assets and security headers

Everything that is not a route is served from `assets.dir` (`index.html` for directories).
Traversal (`..`, also percent-encoded) and missing files answer 404 `not found`; methods other than
GET and HEAD answer 405.

| Response | Headers |
|---|---|
| HTML documents | CSP (below); `Reporting-Endpoints: csp="/api/dash/v1/csp-report"`; COOP `same-origin`; COEP `require-corp`; CORP `same-origin`; `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: strict-origin-when-cross-origin`; `Permissions-Policy: camera=(), geolocation=(), microphone=(self), usb=(), payment=(), gamepad=(self)`; `Cache-Control: no-cache` |
| Other files | CSP, `Reporting-Endpoints`, COOP, COEP, CORP, `nosniff` (workers take CSP and COEP from their own response, T03-022); `Cache-Control: public, max-age=31536000, immutable` when the name contains `.<12+ hex digits>.`, else `no-cache` |

Content types: `.html` `text/html; charset=utf-8`; `.js`/`.mjs` `text/javascript; charset=utf-8`;
`.wasm` `application/wasm`; `.css` `text/css; charset=utf-8`; `.json`, `.svg`, `.png`, `.woff2`,
`.ico`; anything else `application/octet-stream`.

The Content-Security-Policy (T18-002), exactly:

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types pulsus-sanitised; report-to csp
```

When `public_url` is `https`, `upgrade-insecure-requests; ` is inserted before `report-to csp`
(not on plain-http dev and e2e servers, where it would break same-origin loads). No inline script
or style is allowed: the runtime page loads `shell.css`.

**Trusted Types (T18-005).** `web/shim/boot.js` creates the one allowed policy,
`pulsus-sanitised`: `createHTML` passes its input through (the Rust-side `SanitisedHtml` type is
the guard) and `createScriptURL` accepts only same-origin URLs (T18-007). The workers are created
through it. Any other DOM sink, a second policy or a cross-origin worker URL throws `TypeError`.

### CSP reports

`POST /api/dash/v1/csp-report` accepts `application/reports+json` (Reporting API; entries with
`type: "csp-violation"`, their `body` is read) and `application/csp-report` (`{"csp-report":{…}}`).

| Case | Answer |
|---|---|
| Accepted | 204; each violation logged at `warn` with target `csp` and fields `effective_directive`, `disposition`, `blocked`, `document`. URLs are reduced to their origin (`https://host:port`, or `data:`); keywords such as `inline` or `eval` are kept |
| Other content type | 415 `invalid` |
| Body over 16 KiB | 413 `invalid` |
| Malformed JSON or shape | 400 `invalid` |
| Over the global budget (10 per second, burst 20) | 429 `budget_exhausted` with `Retry-After: 1`; drops are logged at most once per second |

## Public-URL self-check (T19-002)

With `public_url` set, the binary sends one `GET` to it after it starts serving (no redirects
followed, the whole exchange bounded by 5 s, the body discarded) and logs once; it is never fatal:

| Outcome | Log |
|---|---|
| 2xx with COOP `same-origin` and COEP `require-corp` | info `public URL self-check: cross-origin isolation headers present` |
| 2xx without them | warn `public URL self-check: <origin> strips Cross-Origin-Opener-Policy, Cross-Origin-Embedder-Policy; an ingress is removing headers the binary sets (T19-002)` (only the missing names) |
| Other status | warn `public URL self-check: <origin> answered <code>` |
| No answer | warn `public URL self-check skipped: <origin> unreachable (connect\|tls\|timeout\|protocol)` |

`<origin>` is `scheme://host:port`; the configured path is never logged.

## Store and row-level security

`dash-store` is the only crate that talks to Postgres (T06-016, T11-023). The pool connects as
`pulsus_app` (`application_name` `pulsus-dash`, acquire timeout = `postgres.connect_timeout_ms`).

- **One transaction path (T11-003).** `Db::tx(org)` begins a transaction and runs
  `SELECT set_config('pulsus.org_id', <org>, true)`; dropping the `OrgTx` rolls back. Every
  repository function takes an `OrgTx` and reads the org only from `OrgTx::org()`. All SQL uses
  `sqlx::query!`/`query_as!`, checked at compile time against the committed `.sqlx/` cache
  (`SQLX_OFFLINE=true` in `.cargo/config.toml`).
- **Forced RLS.** Every tenant table has RLS enabled and forced, one policy
  `org_isolation` (`USING`/`WITH CHECK` `<org column> = pulsus_org()`), and no `PUBLIC` access.
  `pulsus_org()` is `NULL` when no org is set, so a missing context sees zero rows (fail closed).
- **Tables (ENT-020, T11 §4.2):** `orgs`, `tenant_bindings`, `users` (no `password_hash`: login is
  OIDC only), `teams`, `memberships`, `roles`, `role_permissions`, `grants`, `idps`, `sessions`.
  `org_id` leads every key (T11-002) except the global lookup keys `orgs.slug` and the `sessions`
  primary key. `pulsus_app` has no privilege on `sessions` (T11-027; #40 adds its definer lookup).
- **Roles (T11 §4.1)**, created by an operator with `server/crates/dash-store/sql/roles.sql`
  (idempotent, superuser, no passwords):

  | Role | Attributes | Used by |
  |---|---|---|
  | `pulsus_owner` | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS`; owns the schema | `pulsus-dash migrate` only |
  | `pulsus_app` | `LOGIN NOBYPASSRLS`; DML on tenant tables except `sessions` | every request path |
  | `pulsus_maint` | `LOGIN BYPASSRLS` | maintenance jobs (later) |

- **Errors** are `StoreError`: `Unavailable` (I/O, TLS, pool timeout, 57P01, 08xxx), `NotMigrated`
  (42P01), `SchemaTooNew`, `Conflict` (23505), `Rls` (42501), `Other`. Logs carry the kind and
  SQLSTATE, never a URL or the driver's message.

The isolation is proven on real Postgres by `itest:rls-isolation` (every repository function and
every table under the wrong org, `WITH CHECK` on foreign-org inserts, an unset org, the catalogue)
and `itest:no-extensions` (the full suite on Postgres 15 with only `plpgsql` available, T11-001);
see [Build, test and CI](../development/build-and-ci.md).

## Migrations (T11-012, T11-013, T11-015)

`pulsus-dash migrate` (`dash_store::migrate::run`) connects as the owner on its own connection,
sets `lock_timeout = '5s'`, takes `pg_advisory_lock` on the constant `"PULSMIGR"`, and:

- on a fresh database (no `pulsus_schema_level`) applies everything;
- otherwise reads `pulsus_schema_level.level` (any error stops before anything is applied) and
  refuses (exit 3) a level more than one ahead of the binary's `SCHEMA_LEVEL` (the N+1 window);
- applies missing embedded migrations, ignoring applied versions the binary does not know.

`serve` requires the newest embedded migration applied and a level of `SCHEMA_LEVEL` or
`SCHEMA_LEVEL + 1` (T19-007); otherwise it exits 3. Migrations are expand-only and checked by
`ci:squawk-migrations`.

| Database | `serve` | `migrate` |
|---|---|---|
| fresh | exit 3 (`schema not migrated`) | applies both |
| level 1 | ready | nothing to do |
| level 2 (a newer binary migrated) | ready | nothing (unknown versions ignored) |
| level ≥ 3, or a required migration missing | exit 3 | exit 3 |
| Postgres unreachable | retries every 2 s | exit 1 |

`SCHEMA_LEVEL` is 1. Migration 1 creates `pulsus_org()`, `pulsus_schema_level` and the tenant-table
template; migration 2 the identity tables, their RLS, and `bootstrap_find_org(slug)` (a
`SECURITY DEFINER` lookup executable by `pulsus_app`, T11-027).

## First-run seeding (T06 §4.9)

After the schema check, the binary seeds `datasources_bootstrap[0]` once: under
`pg_advisory_xact_lock` (`"PULSBOOT"`) it looks the org slug up with `bootstrap_find_org`; if absent
it creates the org, its four built-in roles (`Viewer`, `Responder`, `Editor`, `Admin`,
`builtin = true`) and the binding (`kind 'pulsusdb'`, `credentials_ref` NULL) in one transaction.
After that Postgres owns the binding: a changed configuration is warned
(`datasources_bootstrap[0] differs from the stored binding …`), never applied. Credentials are
never stored (see [configuration](configuration.md#credentials)).

## Limits

- Only `--role all`; no login, sessions, PulsusDB client or data routes yet.
- One bootstrap datasource; no secrets store (`vault:` and other stores are refused).
- The startup budget (PRF-008) is reported, not enforced, until the reference lab exists.

## Design mapping

| Code | Design |
|---|---|
| `dash-core` | T06 §4.1, §4.3, §5.2; T06-002 |
| `dash-config` | T06-019, T06 §4.9, T19-010, T18-030 |
| `dash-store` (`db`, `repo`, `bootstrap`, `migrate`), migrations, `sql/roles.sql` | T06-016, T11-001/002/003/012/013/015/023/026/027, ENT-020 |
| `dash-gateway` | T06-026, T18-001, T18-002, T18-003, T19-006, T03-022 |
| `pulsus-dash` (`startup`, `selfcheck`) | T06-003, T19-002, T19-007 |
| `web/shim/boot.js` policy, `web/shell.css` | T18-005, T18-007 |
