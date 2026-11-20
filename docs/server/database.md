# Server database

Pulsus Dash keeps its configuration and derived state in Postgres
([ADR-0012](../../designs/adr/0012-derived-state-in-postgres.md),
[T11](../../designs/technical/T11-postgres-schema.md)). This page covers the roles, the first
migration, the row-level security model, how migrations run and are checked, and the integration
tests. PostgreSQL 15 or newer is required, and no extension is needed (T11-001).

## Roles

`server/deploy/postgres-roles.sql` creates three roles. A database administrator runs it once
per cluster, before the first `migrate`. It is idempotent and sets no passwords: set them with
`ALTER ROLE … PASSWORD`, or use another authentication method.

| Role | Attributes | Used by |
|---|---|---|
| `pulsus_owner` | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS` | `migrate`; owns the database and every table |
| `pulsus_app` | same | `serve`; DML on the tenant tables, `SELECT` on `install_state` and `goose_db_version` |
| `pulsus_maint` | same, but `BYPASSRLS` | future maintenance jobs; `SELECT` on `install_state` and `goose_db_version` only, for now |

Create the database owned by the owner role, so that it may create objects in `public`:

```sql
\i server/deploy/postgres-roles.sql
CREATE DATABASE pulsus_dash OWNER pulsus_owner;
```

`serve` refuses to start as a role that is a superuser or has `BYPASSRLS`, because either would
defeat row-level security.

## Schema (migration 1)

`server/migrations/00001_tenancy.sql` creates the tenancy subset of T11 §4.2:

| Table | Tenant | Key | Contents |
|---|---|---|---|
| `orgs` | yes (the root: `id` is the organisation) | `id`; `slug` unique | `name`, `settings`, `perms_epoch`, `created_at`, `deleted_at` |
| `tenant_bindings` | yes | `(org_id, id)`; `(org_id, slug)` unique | the organisation's PulsusDB binding: `datasource_url`, `database`, `scope_org_id`, `credentials_ref`, `kind` (`pulsusdb`) |
| `install_state` | no (one row) | `singleton` | `bootstrap_org_id`, `seeded_at`: the record of the first-run seed |

It also creates two functions. `pulsus_org()` returns the current organisation from the
`pulsus.org_id` setting. `pulsus_floor(domain)` returns a retention floor, which is used once
retention domains exist.

`tenant_bindings.credentials_ref` holds a secret **reference** (`env:NAME` or `file:/path`), never
a value (T11-004, T19-010). A CHECK constraint enforces this: `env:` followed by a name matching
`[A-Za-z_][A-Za-z0-9_]{0,127}`, or `file:/` followed by 1 to 1023 non-space characters. The length
is a separate `char_length` test, because Postgres regular expressions cap repeat counts at 255.

The identity tables (`users`, `teams`, `memberships`, `roles`, `role_permissions`, `grants`,
`idps`, `sessions`) arrive with authentication at M-UI6. Until then, decision D12 in
[the designs README](../../designs/README.md) applies.

## Row-level security

Every tenant table has the same template (T11-003):

```sql
ALTER TABLE t ENABLE ROW LEVEL SECURITY;
ALTER TABLE t FORCE ROW LEVEL SECURITY;     -- also binds the table owner
CREATE POLICY org_isolation ON t USING (org_id = pulsus_org()) WITH CHECK (org_id = pulsus_org());
```

(`orgs` uses `id` instead of `org_id`.) Access fails closed. A transaction that has not set
`pulsus.org_id` sees no rows and can write none. A transaction bound to organisation A cannot read
B's rows, and an insert for B is refused with SQLSTATE `42501`.

In Go, `internal/store` is the only package that talks to Postgres (T06-016, T11-023, enforced by
lint). `Db.Tx(ctx, org, fn)` is the only way to get a transaction:

1. The zero organisation is refused with `ErrNoOrg` before a connection is taken.
2. It begins a `READ COMMITTED` transaction.
3. It runs `SELECT set_config('pulsus.org_id', $1, true)`. The setting is transaction-local, so a
   pooled connection carries no organisation after commit or rollback.
4. It runs `fn`. An error or panic rolls back, and a panic is re-raised. Otherwise it commits.

Cancelling `ctx` cancels the statement in flight. Outside `Tx`, the store runs only four
statements, none of which reads a tenant table: `Ping`, `SchemaVersion`, `RoleBypassesRLS` and
`InstallState`. Queries are written in `server/queries/*.sql` and compiled by sqlc into
`internal/store/dbgen`.

## Migrations

- **Files.** `server/migrations/NNNNN_name.sql` holds goose SQL migrations, embedded in the binary,
  with contiguous versions. Each file has a `-- +goose Up` section and no Down section (T11-012).
  Each file runs in one transaction and sets `lock_timeout` and `statement_timeout` locally.
- **Append-only, expand-only.** A merged migration is never edited, deleted or renamed. CI fails a
  pull request that does (`ci:migrations`, append-only step). Contract changes wait one release.
- **Lint.** squawk (`make migrations-lint`, configured by `server/.squawk.toml`) rejects locking
  DDL (T11-013). The fixture `server/testdata/squawk/create_index_not_concurrently.sql` must fail
  with `require-concurrent-index-creation`, which proves the rule is active.

### Migrate

`pulsus-dash migrate` connects as `pulsus_owner` and:

1. takes the session advisory lock `8103502347670585345` (`pg_try_advisory_lock` every second, for
   at most 5 minutes; `waiting for migration lock` is printed once);
2. reads the applied version without creating anything (0 when `goose_db_version` is absent);
3. refuses a database more than one version ahead of the binary (exit 1). A database exactly one
   ahead (N+1, a newer release already migrated) is left alone (T11-015, T19-007);
4. checks whether `install_state` has a row. If it does not, it validates the seed settings, and an
   invalid or missing `datasource.url` fails with exit 2 before anything is written, in dry runs
   too;
5. with `--dry-run`, prints the pending files and whether it would seed, then stops;
6. applies the pending migrations;
7. if the database was unseeded, it writes the seed in one `Db.Tx` bound to a new organisation:
   the `orgs` row, the `tenant_bindings` row and `install_state`;
8. releases the lock. A session lock is also released if the process dies.

The lock is taken before the version is read and held until the seed commits. Concurrent runs
therefore apply each migration once and seed once, and a run that waited never acts on a version
it read before another run advanced the schema.

A failure between step 6 and the seed's commit leaves the schema migrated and `install_state`
empty. Running `migrate` again seeds it, and `serve` refuses to start until then
(`database is not initialised; run pulsus-dash migrate`).

`serve` accepts a schema at the binary's latest version or one newer, and refuses older or newer
ones at start-up. `/readyz` reports the same window while running.

## Integration tests

The `itest` tests (build tag `itest`) run against real PostgreSQL 15 and 16. Set
`DASH_ITEST_PG_URLS` to one superuser URL per cluster and run `make itest`:

```bash
DASH_ITEST_PG_URLS='pg16=postgres://postgres@localhost:55432/postgres?sslmode=disable,pg15=postgres://postgres@localhost:55433/postgres?sslmode=disable' make itest
```

For each test, the harness (`internal/store/storetest`) runs `postgres-roles.sql` and creates a
database `itest_<random>` owned by `pulsus_owner`. It drops the database afterwards. The tests
cover:

- isolation for every tenant table, as `pulsus_app` and as `pulsus_owner`; a table without a test
  fixture fails the test (`itest:rls-isolation`);
- the absence of extensions (`itest:no-extensions`);
- the migrate cases, including concurrent runs and the N+1 window (`itest:migrations`);
- the start-up refusals of `serve`;
- `/readyz` with PulsusDB absent and with Postgres stopped (through a TCP proxy).

CI runs them in the `itest` job of `.github/workflows/server.yml` with both versions as service
containers.

## Designs

T11-001, T11-002, T11-003, T11-012, T11-013, T11-015 and T11-023 in
[T11](../../designs/technical/T11-postgres-schema.md); T06-016 in
[T06](../../designs/technical/T06-bff-architecture.md);
[ADR-0012](../../designs/adr/0012-derived-state-in-postgres.md),
[ADR-0006](../../designs/adr/0006-pulsusdb-and-postgres.md).
