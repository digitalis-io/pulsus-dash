# Server database

Pulsus Dash keeps its configuration and derived state in Postgres
([ADR-0012](../../designs/adr/0012-derived-state-in-postgres.md),
[T11](../../designs/technical/T11-postgres-schema.md)). This page covers the roles, the
migrations, the row-level security model, the audit partitions, how migrations run and are checked, and the integration
tests. PostgreSQL 15 or newer is required, and no extension is needed (T11-001).

## Roles

`server/deploy/postgres-roles.sql` creates three roles. A database administrator runs it once
per cluster, before the first `migrate`. It is idempotent and sets no passwords: set them with
`ALTER ROLE … PASSWORD`, or use another authentication method.

| Role | Attributes | Used by |
|---|---|---|
| `pulsus_owner` | `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS` | `migrate`; owns the database and every table |
| `pulsus_app` | same | `serve`; DML on the tenant tables as [granted below](#grants), `SELECT` on `install_state` and `goose_db_version`, `EXECUTE` on the audit partition functions |
| `pulsus_maint` | same, but `BYPASSRLS` | future maintenance jobs; `SELECT` on `install_state` and `goose_db_version` only, for now |

Create the database owned by the owner role, so that it may create objects in `public`:

```sql
\i server/deploy/postgres-roles.sql
CREATE DATABASE pulsus_dash OWNER pulsus_owner;
```

`serve` refuses to start as a role that is a superuser or has `BYPASSRLS`, because either would
defeat row-level security.

No role other than `pulsus_owner` (and the schema's owner, `pg_database_owner` on PostgreSQL 15
and newer) may hold `CREATE` on schema `public`. Migration 2 revokes it from `PUBLIC`,
`pulsus_app` and `pulsus_maint`, and fails, as does every later `migrate`, while any other role
holds it:

```
schema_create_grant: roles other than pulsus_owner hold CREATE on schema public: <roles>
```

(SQLSTATE `PD002` inside the migration.) Fix it with `REVOKE CREATE ON SCHEMA public FROM <role>`
and rerun `migrate`. The reason: a role that can create relations in `public` could plant a table
with the name of an audit partition before the partition function looks for it.

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
`[A-Za-z_][A-Za-z0-9_]{0,127}`, or `file:PATH` with an absolute `PATH` of 1 to 1023 **bytes**
containing no ASCII whitespace or control character (bytes 0x01–0x20 and 0x7F; multibyte UTF-8 is
allowed). The rule is byte-wise and independent of the database locale: `octet_length` bounds the
length (Postgres regular expressions cap repeat counts at 255) and an explicit byte class
`[\x01-\x20\x7f]` excludes the characters. The server's configuration check applies the same
rule, and both are tested against one shared case list
(`server/internal/config/testdata/credentials_refs.json`).

The identity tables (`users`, `teams`, `memberships`, `roles`, `role_permissions`, `grants`,
`idps`, `sessions`) arrive with authentication at M-UI6. Until then, decision D12 in
[the designs README](../../designs/README.md) applies.

## Schema (migration 2)

`server/migrations/00002_boards.sql` adds boards, their versions, the audit trail and the
principal's starred and recent boards (T11 §4.3, §4.7). Every table is tenant-scoped, every key
leads with `org_id`, and every integer column is `bigint`.

| Table | Key | Contents |
|---|---|---|
| `folders` | `(org_id, id)`; `(org_id, uid)` unique | `uid`, `title`, `path`, `owner_team_id`, `managed_by`. Every organisation has a root folder (`uid` `root`, path `/`), written by the seed and ensured by the first board |
| `boards` | `(org_id, id)`; `(org_id, uid)` unique | the head: `uid` (`^[a-z0-9-]{1,40}$`), `folder_id`, `title` (1–200 characters), `head_version`, `etag`, `deleted_at` (soft delete) |
| `board_versions` | `(org_id, board_id, version)` | immutable versions (T11-006): `spec` (canonical JSON, `jsonb`), `schema_version`, `content_hash` (SHA-256, 32 bytes), `author_kind` (`local`, `user`, `service_account`), `author_id`, `message` (≤ 500), `source` (`ui` for now), `source_ref`, `created_at` |
| `audit_events` | `(org_id, rclass, at, id)` | partitioned, see [audit partitions](#audit-partitions): `actor_kind`, `actor_id`, `on_behalf_of`, `action`, `resource_kind`, `resource_id`, `reason`, `diff` (an RFC 6902 patch), `ip`, `request_id`, `prev_hash`, `hash`. Indexed on `(org_id, actor_id, at)`, `(org_id, action, at)` and `(org_id, resource_kind, resource_id, at)` |
| `audit_chain_heads` | `org_id` | the organisation's hash-chain head: `last_at`, `last_id`, `last_hash` (T11-017) |
| `stars` | `(org_id, user_id, kind, object_id)` | starred objects (`kind` `board`), `created_at` |
| `recent_views` | `(org_id, user_id, kind, id)` | `viewed_at`: the client's navigation time when given (clamped to `now()` − 1 day … `now()` + 5 min), else `now()`; an upsert keeps the greater time, and a time within 1 ms of another row of the user becomes that row's + 1 µs (the later write first); indexed on `(org_id, user_id, kind, viewed_at)`; kept to 200 per user (each view's upsert and trim hold `pg_advisory_xact_lock(hashtext(org_id ‖ ':' ‖ user_id))`) |

The boards API that uses these tables is described in [the boards API page](boards-api.md).

### Grants

| Relation | `pulsus_app` |
|---|---|
| `folders`, `boards` | `SELECT`, `INSERT`, `UPDATE` (a delete is a soft delete) |
| `board_versions`, `audit_events` | `SELECT`, `INSERT`: append-only (T11-006, T11-017) |
| `audit_chain_heads` | `SELECT`, `INSERT`, `UPDATE` |
| `stars` | `SELECT`, `INSERT`, `DELETE` |
| `recent_views` | `SELECT`, `INSERT`, `UPDATE`, `DELETE` |
| `audit_events_r13` and every leaf partition | none: partitions are reached only through `audit_events`, where RLS applies (T11-026) |
| `pulsus_audit_partitions_maintain`, `pulsus_audit_partition_horizon`, `pulsus_audit_leaf_state` | `EXECUTE` (revoked from `PUBLIC`) |

`pulsus_maint` has no privilege on the new tables yet. `pulsus_owner` owns everything.

### Audit partitions

`audit_events` is partitioned the way T11 specifies for retention-managed tables (T11-008,
T11-009): `PARTITION BY LIST (rclass)`, then each class `PARTITION BY RANGE (at)` monthly. Only the
default audit class, 13 months, exists (`audit_events_r13`); every row is stamped `rclass` 13 until
per-organisation retention policies exist. Leaves are named `audit_events_r13_YYYY_MM` and span
`[YYYY-MM-01 00:00 UTC, next month)`. There is no `DEFAULT` partition (T11-021): an insert whose
month has no leaf fails with SQLSTATE `23514`, and the save that caused it answers 503.

Three functions in `public`, all with `search_path = pg_catalog, pg_temp` and every name
schema-qualified, manage the leaves:

| Function | What it does |
|---|---|
| `pulsus_audit_partitions_maintain(months_ahead)` | `SECURITY DEFINER`, owned by `pulsus_owner` (creating and detaching a partition needs the parent's owner). Takes an advisory lock, so concurrent callers serialise. Creates the leaves of the current UTC month and the next `months_ahead` months (1–12, else SQLSTATE `22023`), each with RLS enabled, forced and the `org_isolation` policy, and no privilege for `PUBLIC` or `pulsus_app`. Then detaches and drops every leaf whose upper bound is more than 13 months old. Returns `created`, `dropped` and `horizon`. Lock timeout 5 s |
| `pulsus_audit_partition_horizon()` | The number of consecutive valid leaves after the current month (0–12), or −1 when the current month has no valid leaf |
| `pulsus_audit_leaf_state(month)` | `ok`, `absent` or `collision` for one month's leaf name |

A leaf is never trusted by its name. It is `ok` only if it is an ordinary table, a direct child of
`public.audit_events_r13`, owned by `pulsus_owner`, with exactly the bounds of its month. Any other
relation with that name is a collision: `maintain` fails with

```
audit_partition_collision: public.audit_events_r13_YYYY_MM exists but is not the expected partition
```

(SQLSTATE `PD001`), and the horizon stops counting at that month. Drop or rename the relation, then
let the next run create the leaf. A leaf is dropped only once every row in it is older than 13
months, so up to one month of expired rows can remain on disk; the retention floor hides them.

**Who calls it.** `migrate` runs `maintain(3)` after the migrations on every run that is not a dry
run, also when nothing was pending; an error fails `migrate` (exit 1). `serve` runs it right after
the listener opens, then every 24 hours after a successful run or every hour after a failed one,
and stops with the server. There is no maintenance role pool yet; the worker's partition job (T11-008)
replaces this when it lands.

**Readiness and alerting.** Each run in `serve` logs, and `/readyz` reports the state as
`checks.audit_partitions` on every response:

| `audit_partitions` | When (first match) | `/readyz` |
|---|---|---|
| `unknown` | no run yet | from the other checks |
| `error` | 3 or more consecutive failed runs (about 2 hours of failures), or the current month has no valid leaf (audited saves fail now) | 503 `not_ready` |
| `low` | 1 or 2 consecutive failed runs, or a horizon of 0 or 1 month (below the 2 months T11-021 requires) | 200 `ready` |
| `ok` | no failed run and a horizon of 2 months or more (3 after every successful run) | 200 `ready` |

| Record | Level | Fields | When |
|---|---|---|---|
| `audit partitions` | info | `created`, `dropped`, `horizon_months` | a successful run |
| `audit_partitions_failed` | error | `error` (a collision names the relation) | a failed run |
| `audit_partition_horizon_low` | error | `state`, `horizon_months` (`unknown` when not known), `failures` | after any run whose state is `low` or `error` |

Alert on `audit_partitions != ok` in the `/readyz` body and on the `audit_partition_horizon_low`
record. This is the observable alert until the self-telemetry exporter publishes the same state
(T19 §4.10).

### Retention floor

`Db.Tx` binds the transaction with one statement:

```sql
SELECT set_config('pulsus.org_id', $1, true), set_config('pulsus.floor.audit', $2, true)
```

`$2` is the current time minus 13 months, in UTC. The audit policy is
`org_id = pulsus_org() AND at >= pulsus_floor('audit')` on `audit_events`, `audit_events_r13` and
every leaf, so the app never sees an audit row older than the retention (T11-010). An unset floor
hides every row. The chain head lives in `audit_chain_heads`, which has no floor, so the hash chain
continues across it (T11-017).

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
3. It runs `SELECT set_config('pulsus.org_id', $1, true), set_config('pulsus.floor.audit', $2,
   true)` (see [retention floor](#retention-floor)). The settings are transaction-local, so a pooled
   connection carries no organisation and no floor after commit or rollback.
4. It runs `fn`. An error or panic rolls back, and a panic is re-raised. Otherwise it commits.

Cancelling `ctx` cancels the statement in flight. Outside `Tx`, the store runs only six
statements, none of which reads a tenant row: `Ping`, `SchemaVersion`, `RoleBypassesRLS`,
`InstallState`, `MaintainAuditPartitions` and `AuditPartitionHorizon`. Queries are written in `server/queries/*.sql` and compiled by sqlc into
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
7. fails if a role other than `pulsus_owner` holds `CREATE` on `public` (`schema_create_grant`),
   then runs `pulsus_audit_partitions_maintain(3)` ([audit partitions](#audit-partitions)); both
   also run when nothing was pending;
8. if the database was unseeded, it writes the seed in one `Db.Tx` bound to a new organisation:
   the `orgs` row, the `tenant_bindings` row, the root folder and `install_state`;
9. releases the lock. A session lock is also released if the process dies.

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
  fixture fails the test; every audit partition carries RLS and refuses `SELECT` and `INSERT` by
  `pulsus_app` (`itest:rls-isolation`);
- append-only audit events, versions and boards for `pulsus_app`, the retention floor, and the
  hash chain across it (`itest:audit-append-only`);
- audit partition maintenance: leaves ahead, the 13-month drop, the horizon, collisions of every
  kind, a relation planted before `migrate`, direct `CREATE` grants, and the definer function's
  `search_path`;
- the absence of extensions (`itest:no-extensions`);
- the migrate cases, including concurrent runs and the N+1 window (`itest:migrations`);
- the start-up refusals of `serve`;
- `/readyz` with PulsusDB absent and with Postgres stopped (through a TCP proxy).

CI runs them in the `itest` job of `.github/workflows/server.yml` with both versions as service
containers.

## Designs

T11-001, T11-002, T11-003, T11-006, T11-008, T11-010, T11-012, T11-013, T11-015, T11-017,
T11-021, T11-023 and T11-026 in [T11](../../designs/technical/T11-postgres-schema.md); T19-006
(the `audit_partitions` check) in [T19](../../designs/technical/T19-deployment.md); T06-016 in
[T06](../../designs/technical/T06-bff-architecture.md);
[ADR-0012](../../designs/adr/0012-derived-state-in-postgres.md),
[ADR-0006](../../designs/adr/0006-pulsusdb-and-postgres.md).
