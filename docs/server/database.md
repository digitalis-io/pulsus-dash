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
| `recent_views` | `(org_id, user_id, kind, id)` | `viewed_at`: the client's navigation time when given (clamped to `now()` − 1 day … `now()` + 5 min), else `now()`; an upsert keeps the greater time; on a tie (a time in the same millisecond as other rows of the user) those rows are renumbered, in order, to the millisecond's microseconds 998, 997, … and the new time becomes its microsecond 999 (the later write first, never leaving the millisecond); indexed on `(org_id, user_id, kind, viewed_at)`; kept to 200 per user (each view's upsert and trim hold `pg_advisory_xact_lock(hashtext(org_id ‖ ':' ‖ user_id))`) |

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

## Schema (migration 3)

`server/migrations/00003_annotations.sql` (#64 Part C) adds the events that boards draw as markers
on their time panels (T11 §4.4,
[ADR-0023](../../designs/adr/0023-chart-event-markers.md)). It creates one new, empty table, with
no backfill and no lock on an existing table (T11-012, T11-013).

| Table | Key | Contents |
|---|---|---|
| `annotations` | `(org_id, id)`; indexed on `(org_id, at)` (`annotations_at`) | `at`, `end_at` (null for a point), `kind` (`deploy`, `config`, `flag` or `annotation`), `entity_key` (the `EntityId` of the change's entity, or null; see migration 5), `text` (1–500 characters), `tags` (`text[]`, default `{}`, at most 16), `author_kind` (`local`, `user`, `service_account`), `author_id`, `created_at` |

CHECKs repeat the API's rules: the four kinds, the text length, the tag count, and
`end_at IS NULL OR (end_at >= at AND end_at - at <= interval '31 days')`. A violation is SQLSTATE
`23514`. Because a range is at most 31 days, the list query's lower bound
`at >= from − 31 days` is exact and keeps the index scan bounded. The table is not partitioned
(annotations are few). The API that uses it is described in
[the annotations API page](annotations-api.md).

`pulsus_app` holds `SELECT`, `INSERT` and `DELETE` on `annotations` (no update: delete and post
again). RLS is the template of [row-level security](#row-level-security), and every query also
names `org_id = $1` (T11-002).

## Schema (migration 4)

`server/migrations/00004_board_tags.sql` (#215) adds the board tags cache that the board list
searches and returns (T24-029, T24 §6, T11 §4.3):

| Column of `boards` | Type | Meaning |
|---|---|---|
| `tags` | `text[] NOT NULL DEFAULT '{}'` | the tags of the head version's spec, in their order |
| `tags_version` | `bigint NOT NULL DEFAULT 0` | the head version the cache was taken from |

and the constraint `boards_tags_max CHECK (cardinality(tags) <= 16) NOT VALID`. The defaults are
constants, so the columns are added without rewriting a row (the table keeps its `relfilenode`),
and `NOT VALID` skips the scan of existing rows: the migration holds its lock only for a catalog
change (T11-013). New and updated rows are checked at once (SQLSTATE `23514` for 17 tags); the
existing rows are validated by `VALIDATE CONSTRAINT` in a later release (I4, #218). There is no
grant change: `pulsus_app` already holds `UPDATE` on `boards`.

**Freshness.** A row is fresh when `tags_version = head_version`. Every head move by this release
sets both in the same statement: a create writes the spec's tags with `tags_version` 1, a save
writes them with `tags_version` set to the new head version. A row is stale after migration 4 (its
default `tags_version` 0) and after any head move by an older release, which does not know the
columns.

**Repair.** Each `GET /boards` first runs `RepairBoardTags` in a transaction of its own, bound to
the request's organisation (`Db.Tx`), and commits it before the list:

- it sets `statement_timeout` to 2 s and `lock_timeout` to 500 ms for that transaction;
- it takes at most 200 stale live rows of the organisation (`ORDER BY id LIMIT 200 FOR UPDATE SKIP
  LOCKED`: a row a save holds is skipped, never waited for) and sets `tags` from the head version's
  `spec->'tags'` and `tags_version` to `head_version`;
- it writes no audit event and does not change the `etag`;
- a failure (a timeout, a lock wait, any error) rolls back only the repair: the server logs
  `level=WARN msg="boards: tag repair failed" op=repair_tags sqlstate=<SQLSTATE> request_id=<id>`
  (never the error's text, which could hold titles or tags) and goes on to the list. A cancelled
  request logs nothing and stops.

The list itself is one statement (`ListBoards` in `server/queries/boards.sql`), so its rows, its
truncation and its count of stale rows (`tagsStale`) are one snapshot even under `READ
COMMITTED`. A stale row is listed with its tags unknown (`null`) and never matches by tag. See
[listing and search](boards-api.md#listing-and-search) for the API.

### Old binaries and `make itest-old-binary`

During a rolling upgrade the previous release runs beside this one on the same database (T11-015).
It can list, create, save and delete boards as before, but it cannot read or move a head this
release saved at a newer board spec version: it answers 503 `board saved by a newer server
version` and writes nothing. Against a previous release at spec 3 (before #215), its creates and
saves also leave the tags cache row stale, and the next list by this release repairs them.

`make itest-old-binary` proves this with the real previous binary
(`server/scripts/itest-old-binary.sh`). It builds the merge-base of `HEAD` with `OLD_BINARY_REF`
(default `origin/main`) in a git worktree under `build/old-binary/`, removed on exit, reads the
board spec version of both trees (`BoardSchemaVersion` in `server/internal/spec/board.go`; either
missing fails the gate) and their highest migration numbers (`server/migrations/NNNNN_*.sql`;
either missing fails the gate), and runs every `Test*OldBinary` test in `server/cmd/pulsus-dash` with:

| Variable | Value |
|---|---|
| `DASH_OLD_BINARY` | the previous release's binary |
| `DASH_OLD_SPEC_VERSION` | its board spec version (a positive integer, else the tests fail) |
| `DASH_OLD_FIXTURE` | its own fixture of that version: the first, by name, of `api/fixtures/board-spec/v<P>-*.json` in its tree |
| `DASH_OLD_SCHEMA` | its highest migration number (a positive integer, else the tests that need it fail) |

The selector is `^Test[A-Za-z0-9_]*OldBinary$` (any test name ending in `OldBinary`, digits and
`_` included); `make itest-old-binary` first runs `server/scripts/itest-old-binary.sh --self-test`,
which checks that selector against a fixture package with `go test -list`, and the PASS-line
pattern against sample output, without a database. The gate passes only when the run exits 0, no
test fails, at least one `Test*OldBinary` test passes, `TestBoardSpecOldBinary` passes whenever
the previous release's spec version is older than this one's, and `TestAnnotationsOldBinary`
passes whenever the previous release's schema is older than 5 and this one's is 5 or later. A missing or failing binary fails the tests; plain `make itest` skips them (no
`DASH_OLD_BINARY`). It needs `DASH_ITEST_PG_URLS`, and is a required local gate for every change to
the board schema or spec and to the annotations schema.

- **`TestBoardSpecOldBinary`** (`itest:board-spec-old-binary`,
  `boards_spec_old_binary_itest_test.go`) skips when the spec version is unchanged. Per Postgres
  version it migrates a database with this release, starts the previous release as `serve
  --api-only` on a free loopback port beside this one, and checks: this release creates W from the
  newest version's fixture (`newFixture`, now `v6-board-list.json`, whose first panel is a board
  list) and reads it back canonical at its `schema_version` (6); the previous release gets 503 on
  `GET` and on `PUT` of W (W keeps one version) and still lists it; it refuses W's spec on `POST`
  (400 `oldRefusal`: against a v5 release `board.vis.kind.invalid` at `/panels/0/vis/kind`); it
  creates V from its own fixture, refuses W's spec saved over V the same way (V's head and version
  count unchanged); this release reads V canonical and saves it with a board list; the previous
  release then gets 503 on V; and the board round trip still passes on the previous release.
  Each spec version change updates `newFixture` and `oldRefusal`.
- **`TestBoardTagsOldBinary`** (`itest:board-tags-old-binary`,
  `boards_old_binary_itest_test.go`) checks the tags transition, so it needs a previous release
  before board spec 4 and skips against a later one ("the tags transition needs a previous release
  before board spec 4"). Run it with `make itest-old-binary OLD_BINARY_REF=e748875` (the last
  release at spec 3, before #215). The test migrates a database to 3, seeds 5 000 schema-3 boards
  in each of two organisations, applies migration 4 while a reader queries `boards` (its longest
  wait must be at most 1 s, and the table's `relfilenode` must not change), starts the old binary
  beside this release, runs the board round trip on it, and checks that 25 lists repair org 1's
  5 000 rows 200 at a time (`tagsStale` 4 800, 4 600, … 0) without touching org 2, that the old
  binary's create and save go stale and are repaired, and that it refuses to save over a head this
  release wrote.
- **`TestAnnotationsOldBinary`** (`itest:annotations-old-binary`,
  `annotations_old_binary_itest_test.go`) checks the annotation entity transition, so it needs a
  previous release before migration 5 (`DASH_OLD_SCHEMA` < 5) and skips against a later one. The
  test migrates a database to 4, seeds 2 000 annotations in each of two organisations, applies
  migration 5 while a reader queries `annotations` (its longest wait must be at most 1 s, and the
  `relfilenode` must not change), and starts the old binary beside this release. The old binary
  creates an annotation (201), refuses one with `entity` (400 `annotation.unknown` at `/entity`),
  and answers lists with exactly `items` and `truncated`; this release answers with `applied`
  (`{}`) and lists the old rows with `"entity": null`; this release's create with an entity (binding
  `default`) is listed by the old binary; and no row has only one of `entity_key` and `entity`.

## Schema (migration 5)

`server/migrations/00005_annotation_entity.sql` (#222) adds the canonical entity of an annotation
(T24 §6, T11 §4.4):

| Column of `annotations` | Type | Meaning |
|---|---|---|
| `entity` | `jsonb`, nullable | the canonical entity, or null for an organisation-wide change |

and the constraint `annotations_entity_pair CHECK ((entity_key IS NULL) = (entity IS NULL)) NOT
VALID`: `entity_key` and `entity` are set or null together. The column has no default and the
constraint is `NOT VALID`, so the migration rewrites no row (the table keeps its `relfilenode`) and
holds its lock (`lock_timeout` 5 s) only for a catalog change (T11-012, T11-013). New and updated
rows are checked at once: one column without the other is SQLSTATE `23514`. The existing rows are
all null/null; the next release validates the constraint (I7, #224). There is no grant change.

The stored entity is

```json
{"id": "bb7487bd-100d-a998-e0f0-3c65f11da1a7", "binding": "prod-eu",
 "binding_id": "00000000-0000-4000-8000-0000000000e1", "kind": "service",
 "ident": [null, "checkout"], "attrs": {"service.name": "checkout"}}
```

`id` is the `EntityId` and equals `entity_key`; `binding` and `binding_id` are the tenant binding's
slug and id; `ident` holds the identifying values in schema order (null for an absent optional
position); `attrs` is the canonical map (see
[the annotations API page](annotations-api.md#entity-identity)). The data scope predicate reads
`kind`, `binding_id` and `attrs` only. A binary at schema 4 does not know the column: its inserts
write null/null, which passes the constraint, and it lists entity rows without their entity.

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

- isolation for every tenant table (`annotations` included), as `pulsus_app` and as
  `pulsus_owner`; a table without a test fixture fails the test; every audit partition carries RLS and refuses `SELECT` and `INSERT` by
  `pulsus_app` (`itest:rls-isolation`);
- append-only audit events, versions and boards for `pulsus_app`, the retention floor, and the
  hash chain across it (`itest:audit-append-only`);
- audit partition maintenance: leaves ahead, the 13-month drop, the horizon, collisions of every
  kind, a relation planted before `migrate`, direct `CREATE` grants, and the definer function's
  `search_path`;
- the absence of extensions (`itest:no-extensions`);
- board tags and search: the title and exact-tag search, the 1 000 cap, the cache kept fresh by
  every save, the organisation-bound repair, the constraint and the defaults, the list snapshot
  under a locked row, a head move between the repair and the list, a failing, timed-out or
  cancelled repair (`itest:board-find`, `itest:board-tags`, `itest:board-list-snapshot` in
  `server/internal/boards/list_itest_test.go`), the one-statement list
  (`server/internal/store/boards_itest_test.go`), and the previous binary beside this one
  (`itest:board-tags-old-binary`, `itest:board-spec-old-binary`,
  [above](#old-binaries-and-make-itest-old-binary));
- board spec v5: a widget board created, saved without its data panel and read back at schema 5
  (`itest:board-crud`, `TestBoardCRUDWidgets`), and a clock zone the head holds kept on saves while
  a newly introduced unknown one is refused (`itest:board-zones-grandfathered`,
  `TestBoardZonesGrandfathered`, in `server/internal/boards/boards_itest_test.go`);
- board spec v6: a board with board lists created and read back canonical at schema 6, then saved
  with one list's `limit` changed (`itest:board-crud`, `TestBoardCRUDBoardList`);
- annotations: the window overlap and newest-first order, the 500 cap and `truncated`, isolation
  between organisations, the `annotation.create` and `annotation.delete` audit events and their
  chain, and the CHECKs for a 32-day range and an unknown kind; the entity, kind, tag and
  organisation-wide filters, the data scopes (`P_eu`, `P_shop`, S1–S6, T1–T3) on list, create and
  delete, the SQL predicate against `ScopeCovers`, and keyset paging under inserts and deletes
  (`itest:annotations-entity`, `itest:annotations-scope`, `itest:annotations-scope-compile`,
  `itest:annotations-delete-scope`, `itest:annotations-keyset` in
  `server/internal/annotations/annotations_itest_test.go`); the one-statement list and the
  `annotations_entity_pair` check (`server/internal/store/annotations_itest_test.go`); the routes
  over HTTP (`TestAnnotationsHTTP`) and the previous binary beside this one
  (`itest:annotations-old-binary`) in `server/cmd/pulsus-dash/`;
- the migrate cases, including concurrent runs and the N+1 window (`itest:migrations`);
- the start-up refusals of `serve`;
- `/readyz` with PulsusDB absent and with Postgres stopped (through a TCP proxy).

CI runs them in the `itest` job of `.github/workflows/server.yml` with both versions as service
containers. `make itest-local` starts both versions from `dev/compose.yaml` and runs `make itest`
against them, or `make itest-local ITEST_GOAL=itest-old-binary` for the old-binary test.

## Designs

T11-001, T11-002, T11-003, T11-006, T11-008, T11-010, T11-012, T11-013, T11-015, T11-016,
T11-017, T11-021, T11-023 and T11-026 in [T11](../../designs/technical/T11-postgres-schema.md);
T24-029, T24-030 to T24-032, T24-038 and §6 (the board tags cache and the annotation entity) in
[T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md); T19-006
(the `audit_partitions` check) in [T19](../../designs/technical/T19-deployment.md); T06-016 in
[T06](../../designs/technical/T06-bff-architecture.md);
[ADR-0012](../../designs/adr/0012-derived-state-in-postgres.md),
[ADR-0006](../../designs/adr/0006-pulsusdb-and-postgres.md).
