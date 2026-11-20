# Server (BFF)

The Pulsus Dash server is one Go binary, `pulsus-dash`, in `server/`
([ADR-0015](../../designs/adr/0015-go-bff.md)). This release is the server core. It loads a
strict configuration, checks Postgres, applies migrations and seeds the first organisation, and
serves health and readiness. It never contacts PulsusDB
([T06-026](../../designs/technical/T06-bff-architecture.md)). Serving the web client, the
bootstrap API and the PulsusDB data plane come in later issues.

The HTTP contract is spec-first: `api/openapi.yaml` is the source, the Go server code
(`server/internal/gateway/api/api.gen.go`) and the TypeScript client types
(`client/src/api/gen/schema.d.ts`) are generated from it and committed, and `ci:api-gen` fails
when either is stale. See [build and CI](../development/build-and-ci.md#server).

Postgres roles, the schema, row-level security and migrations are described in
[the database page](database.md).

## Build and run

```bash
make server-build                      # build/pulsus-dash, CGO_ENABLED=0, version from VERSION
build/pulsus-dash version
build/pulsus-dash config check --config server/config.example.yaml
build/pulsus-dash migrate --config my.yaml   # as pulsus_owner; once per release
build/pulsus-dash serve --config my.yaml     # as pulsus_app
```

`make server-build VERSION=1.2.3` stamps the version (`-X …/internal/core.Version`). The commit
is the VCS revision Go records at build time, or `unknown`.

## Commands

| Command | Flags | Exit 0 | Exit 1 (runtime) | Exit 2 (usage or configuration) |
|---|---|---|---|---|
| `serve` | `--config PATH`, `--role LIST` (overrides `server.roles`) | clean shutdown after SIGINT or SIGTERM | Postgres unreachable, role bypasses RLS, schema outside the window, database not seeded, listen failure, shutdown timeout | configuration error, unknown or unavailable role |
| `migrate` | `--config PATH`, `--dry-run` | applied, or nothing to apply | Postgres, lock or schema-ahead failure | configuration error, including invalid seed settings on an unseeded database |
| `config check` | `--config PATH`, `--for serve\|migrate` (default `serve`) | prints `config ok (for <command>)` | — | any configuration error |
| `version` | `--json` | prints the version | — | bad flag |

Errors go to stderr, prefixed `pulsus-dash: `. With no command or an unknown one, the binary
prints `usage: pulsus-dash <serve|migrate|config check|version> [flags]` and exits 2.

**`version`** prints `pulsus-dash 0.1.0-dev (commit <sha>, go1.27.4, schema 1)`. With `--json` it
prints `{"version":…,"commit":…,"go":…,"schema":1}`, where `schema` is the latest migration
embedded in the binary.

**`serve`** start-up steps, in order. The first failure ends the process.

1. Load the configuration and require `postgres.app_url_ref` (exit 2).
2. The roles must be `[all]` (T06-003). `api`, `worker`, `evaluator`, `notifier` and `ai` are
   named but not available in this release:
   `role "api" is not available in this release: only "all" is supported`. Any other value is
   `unknown role "bogus" (want all, api, worker, evaluator, notifier or ai)`. Both exit 2.
3. Build the logger and resolve the app role's URL (exit 2).
4. Ping Postgres with a 5 s timeout: `postgres unreachable: <driver error>` (exit 1). The driver's
   message never contains the password.
5. Refuse a role that is a superuser or has `BYPASSRLS`:
   `postgres role "postgres" bypasses row-level security; serve must connect as pulsus_app`.
6. The schema version must be the binary's latest or one newer (T11-015, T19-007). Otherwise the
   message is `database schema version 0 is older than this binary requires (1); run pulsus-dash
   migrate` or `database schema version 3 is newer than this binary supports (latest 1, window +1)`.
7. The first-run seed must exist: `database is not initialised; run pulsus-dash migrate`.
8. Listen on `server.listen`, then log `msg=listening addr=…`.
9. Serve until SIGINT or SIGTERM, then drain for at most `server.shutdown_grace`. Exit 1 if the
   drain times out.

**`migrate`** connects as the owner role and prints its progress on stdout. See
[the database page](database.md#migrate) for the lock, the N+1 window and the seed.

| Situation | Output |
|---|---|
| Migrations applied | one `applied 00001_tenancy.sql` per file, then `schema at version 1` |
| Nothing to apply | `schema at version 1; nothing to apply` |
| Database one version ahead | `schema at version 2 (one ahead of this binary); nothing to apply` |
| Seed written / already present | `seeded organisation "default" with tenant binding "default"` / `organisation already seeded` |
| `--dry-run` | one `pending <file>` per migration; `would seed …` when unseeded; last line `dry run: nothing changed` |
| Another migrate holds the lock | `waiting for migration lock` (once). It waits for at most 5 minutes, then fails with `timed out after 5m0s waiting for the migration lock` |
| Database more than one version ahead | `database schema version 3 is ahead of this binary (latest 1); refusing to migrate outside the N+1 window` (exit 1) |

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
| `postgres.app_url_ref` | — | secret reference | `serve` |
| `postgres.owner_url_ref` | — | secret reference | `migrate` |
| `postgres.pool_max` | `32` | 1 to 512 | — |
| `datasource.url` | — | seed only: `http`/`https`, a host, no credentials, no query or fragment | `migrate` on an empty database |
| `datasource.slug` | `default` | seed only: `^[a-z0-9-]{1,40}$` | — |
| `datasource.database` | `""` | seed only: `^[A-Za-z0-9_.-]{1,150}$` when set | — |
| `datasource.scope_org_id` | `""` | seed only: same pattern | — |
| `datasource.credentials_ref` | `""` | seed only: `env:NAME` or `file:/path`, stored as the reference string | — |
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
| `file:/absolute/path` (1 to 1023 characters after `file:/`, no whitespace) | the file's contents, one trailing newline removed | `cannot read file PATH`; `file PATH is larger than 64 KiB` |
| `vault://…` | — | `vault references are not supported in this release` |
| anything else | a literal | refused with `inline secrets are refused; use env:NAME or file:PATH (or set allow_inline_secrets: true for development)`. With `allow_inline_secrets: true` it is used and logged once at `warn` as `inline secret used key=<key>` |

A malformed reference is `must be env:NAME or file:/absolute/path`. No message or log line contains
a resolved value or a literal.

### Seed settings

`datasource.*` and `bootstrap.*` describe the first organisation and its PulsusDB binding.
`config.Load` checks only their keys and types. Their values are checked by `SeedSettings`, which
`migrate` calls only when the database has no seed yet. After the seed, the binding stored in
Postgres is authoritative: `migrate` and `serve` never read these keys again, so stale or invalid
values there are ignored. `datasource.credentials_ref` is stored as the reference string and never
resolved by `migrate`. A literal is refused with
`an inline secret cannot be stored in the tenant binding; use env:NAME or file:PATH`, even with
`allow_inline_secrets`.

## HTTP routes

| Request | Status | Body |
|---|---|---|
| `GET /healthz`, `GET /startupz` | 200 | `{"status":"ok"}` |
| `GET /readyz`, Postgres answers and the schema is in the window | 200 | `{"status":"ready","checks":{"postgres":"ok","schema":"ok"}}` |
| `GET /readyz`, ping fails or takes over 1 s | 503 | `{"status":"not_ready","checks":{"postgres":"unreachable","schema":"unknown"}}` |
| `GET /readyz`, schema behind or more than one ahead | 503 | `"schema":"behind"` or `"ahead"` |
| `GET /readyz`, the schema query fails or takes over 1 s | 503 | `"schema":"error"` or `"timeout"`, logged at `warn` as `msg=readyz check=schema` |
| any other path | 404 | `{"error":{"code":"not_found","message":"not found"}}` |
| known path, wrong method | 405 | `{"error":{"code":"invalid","message":"method not allowed"}}` |
| handler panic | 500 | `{"error":{"code":"internal","message":"internal error"}}`, stack logged at `error` |

`/startupz` is 200 as soon as the listener is open, because there is no cache to warm yet
(T19-006). `/readyz` never contacts PulsusDB, so it stays 200 while PulsusDB is down. It returns
503 while Postgres is down, but the process keeps running.

Every response carries `Content-Type: application/json`, `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff` and `X-Request-Id`. An incoming `X-Request-Id` that matches
`^[A-Za-z0-9-]{1,64}$` is kept; otherwise the server generates a UUIDv7. The HTTP server uses
`ReadHeaderTimeout` 10 s, `IdleTimeout` 120 s and `MaxHeaderBytes` 1 MiB.

## Logs

Logs are structured (`log/slog`) on stderr, JSON by default. Each request writes one `msg=http`
record with `method`, `route` (the route pattern, never the raw path or query; `unmatched` for a
404), `status`, `duration_ms` and `request_id`.

## Code layout

| Package | Role |
|---|---|
| `cmd/pulsus-dash` | the CLI; `run(ctx, runEnv)` makes every command testable in-process |
| `internal/config` | loading, strictness, secret references, seed settings |
| `internal/core` | shared types: `OrgID`, tenant bindings, build info |
| `internal/gateway` | router, error envelope, headers, access log, panic recovery, health routes; `api/` is generated |
| `internal/store` | the only Postgres access path ([database page](database.md)); `dbgen/` is generated by sqlc |
| `internal/telemetry` | the logger |

Lint rules (`server/.golangci.yml`) keep `pgx`, `goose` and the sqlc output inside
`internal/store` (T11-023), and `chi` and the generated server inside `internal/gateway` (T06-001).

## Designs

T06-001, T06-003, T06-016, T06-019 and T06-026 in
[T06](../../designs/technical/T06-bff-architecture.md); T19-006, T19-007 and T19-010 in
[T19](../../designs/technical/T19-deployment.md);
[ADR-0015](../../designs/adr/0015-go-bff.md).
