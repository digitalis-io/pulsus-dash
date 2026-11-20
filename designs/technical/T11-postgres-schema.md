# T11 — Postgres schema & config lifecycle

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.3-rc · 2026-11-20 |
| **Milestone** | M-UI1 (tenancy, prefs, boards v0) → M-UI3 (entities, derived state) → M-UI4 (alerting, investigations, alert history) → M-UI5 (versions UI, dashboard import) → M-UI6 (identity, Git sync, Terraform) |
| **Related ADRs** | [ADR-0015](../adr/0015-go-bff.md) (Go BFF), [ADR-0006](../adr/0006-pulsusdb-and-postgres.md), [ADR-0008](../adr/0008-dash-alert-evaluator.md), [ADR-0009](../adr/0009-optional-object-storage.md), [ADR-0011](../adr/0011-terraform-provider-in-go.md), [ADR-0012](../adr/0012-derived-state-in-postgres.md) |
| **Source draft** | plans/tech/T11-postgres-schema.md (not tracked) |

## 1. Context & problem

[ADR-0006](../adr/0006-pulsusdb-and-postgres.md) puts everything that is not telemetry in Postgres:
boards, rules, RBAC, preferences, investigations, incidents and contact points.
[ADR-0012](../adr/0012-derived-state-in-postgres.md) (Accepted) adds **all Dash-derived state**:
alert transitions and notification deliveries (alert history), anomaly baselines and scores, entity
change events, and fallback health pyramids. Dash never writes product state into PulsusDB.
[11](../product/11-enterprise.md) §6 lists the domains and the default retention of
time-partitioned state, and [07](../product/07-alerting.md) §10 the alerting data.

On top of that, the product needs:
- **versioning with diff and restore** for boards, Lens templates, Perspectives, rules, SLOs and
  journeys;
- **config-as-code**: YAML, Git sync and Terraform;
- **migration from existing dashboard and alerting tools** with an honest import report;
- **per-org retention** of high-volume derived state, enforced by dropping partitions, with no
  Postgres extension required.

This doc is the **authoritative schema**. [T16](T16-alert-evaluator.md), [T12](T12-entity-catalogue.md), T13 (draft),
T15 (draft) and T17 (draft) store into tables defined here, and may refine columns within the
conventions of §4.0.

## 2. Goals / non-goals

**Goals**
- One schema serves self-hosted (1 org) and SaaS (10⁴ orgs) deployments.
- Every content object has a stable `uid`, immutable versions and a provenance `source`.
- Zero-downtime migrations (expand/contract).
- Imports are lossless where possible and say what was lost where not.
- Dash-derived state is natively time-partitioned, with per-org retention enforced by `DROP`ping
  partitions, and runs on a vanilla Postgres with no extension.
- The same tables back the virtual query sources (`ALERTS`, `ALERTS_FOR_STATE`,
  `pulsus_anomaly_score`, `{source="pulsus-dash"}`) that the planner serves
  ([T07](T07-scene-query-planner.md)).

**Non-goals**
- Raw telemetry. It stays in PulsusDB and is only read.
- Object-store layout for snapshot payloads and flight recordings, which belongs to T17 (draft).
  Here we keep only references and the Postgres fallback tables (§4.15).
- Query semantics of the virtual sources (PromQL evaluation, joins), which belong to
  [T07](T07-scene-query-planner.md) and [T16](T16-alert-evaluator.md) §4.7. This doc supplies the
  tables and indexes they read.

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [IA-001](../product/02-information-architecture.md#ia-001--object-vocabulary-and-persistence) | §4.0–§4.13, §6.1 object map | `itest:schema-object-map` (every §2 object of 02 maps to a table); `itest:no-pulsusdb-writes` on the storyboard run |
| [IA-003](../product/02-information-architecture.md#ia-003--scenes-are-trees-of-viewports) | §4.3 versioned `spec` documents hold the viewport tree | `itest:spec-roundtrip` (viewport moved between scenes keeps its four properties) |
| [IA-004](../product/02-information-architecture.md#ia-004--lens-templates) | §4.3 `lens_templates` + `lens_overrides` per org/team, versioned | `itest:versions-diff-restore` (team edit → new version used by that team only; restore) |
| [IA-006](../product/02-information-architecture.md#ia-006--boards) | §4.3 `boards` in `folders`, owners, versions, variables in `spec` | `itest:versions-diff-restore` |
| [IA-007](../product/02-information-architecture.md#ia-007--investigations) | §4.5 `investigations`, `evidence`, `timeline_events`, `participants` | `itest:investigation-store` (time-ordered items, post-mortem export contains all) |
| [IA-008](../product/02-information-architecture.md#ia-008--waypoints) | §4.4 `waypoints` with `visibility` personal/team | `itest:waypoint-visibility` |
| [IA-009](../product/02-information-architecture.md#ia-009--incident-and-investigation-identifiers) | §4.5 `org_sequences`: one number for `INC-n` and `INV-n` | `itest:incident-numbering` (concurrent creation, no gaps reused, INV shares INC number) |
| [IA-010](../product/02-information-architecture.md#ia-010--entities-are-derived-from-telemetry) | §4.4 `entity_overrides` (names, owners, tiers) | `itest:entity-override-persist` |
| [IA-011](../product/02-information-architecture.md#ia-011--configurable-entity-schema) | §4.4 `entity_schema` versioned per org | `itest:entity-schema-store` |
| [ALR-004](../product/07-alerting.md#alr-004--evaluation-independent-of-the-pulsusdb-ruler) | §4.6 rules, contact points, routing, silences, maintenance in Postgres | `itest:alerting-ruler-disabled` |
| [ALR-021](../product/07-alerting.md#alr-021--historical-replay-of-every-view) | §4.13.1 interval-closing transition rows, §5.3 state-at-time query | `itest:alert-replay-at-t` (state at 03:12 equals the transition log) |
| [ALR-026](../product/07-alerting.md#alr-026--perspective-default-segmentations) | §4.3 `perspectives.spec` default segmentation; §4.4 `saved_views` | `itest:saved-views-store` |
| [ALR-038](../product/07-alerting.md#alr-038--saved-alert-views) | §4.4 `saved_views` (surface `alerts`), shipped rows seeded by provisioning | `itest:saved-views-store` |
| [ALR-045](../product/07-alerting.md#alr-045--rule-history-view) | §4.13.1 transitions + §4.13.2 deliveries + §4.3 rule versions, indexed per rule | `itest:rule-history-summary` (summary values equal reference computation) |
| [ALR-046](../product/07-alerting.md#alr-046--rule-versions-and-beforeafter-backtest) | §4.6 `alert_rule_versions` immutable | `itest:versions-diff-restore` |
| [ALR-047](../product/07-alerting.md#alr-047--per-instance-breakdown-and-evaluation-health) | §4.6 `rule_eval_stats` (duration, errors, missed ticks) | `itest:rule-eval-health` |
| [ALR-048](../product/07-alerting.md#alr-048--calendar-heatmap-of-incidents) | §4.5 `incidents (org_id, owner_team_id, opened_at)` index | `itest:incident-calendar-counts` |
| [ALR-049](../product/07-alerting.md#alr-049--transition-explorer) | §4.13.1 explorer index `(org_id, rclass, at)`; keyset paging (§7) | `bench:pg-transition-explorer` (10⁶ rows, page ≤ 150 ms p99) |
| [ALR-051](../product/07-alerting.md#alr-051--ops-metrics) | §4.13.1–§4.13.2 ack/notify timestamps, §4.5 incidents | `itest:ops-metrics-reference` |
| [ALR-052](../product/07-alerting.md#alr-052--incident-archive) | §4.5 `incidents` + `investigations` with built-in full-text index | `itest:incident-archive-search` |
| [ALR-053](../product/07-alerting.md#alr-053--similar-incidents-in-the-alert-lens) | §4.7 `incident_embeddings` (optional pgvector) with full-text fallback | `itest:similar-incident-fallback` (works without pgvector) |
| [ALR-054](../product/07-alerting.md#alr-054--past-incidents-reopen-in-full) | §4.5 investigations, evidence, `recordings`; §4.15 artefact fallback | `itest:investigation-reopen` |
| [ALR-059](../product/07-alerting.md#alr-059--existing-contact-point-import) | §4.10 alerting importer: contact points 1:1, report | `itest:dashboard-import-corpus` |
| [ALR-062](../product/07-alerting.md#alr-062--secrets-are-write-only) | §4.0 secrets only via `secret_ref`; §4.7 `secrets` | `itest:secret-write-only` |
| [ALR-063](../product/07-alerting.md#alr-063--used-by-blast-radius) | §4.6 `rule_routes` / contact-point references indexed both ways | `itest:contact-point-used-by` |
| [ALR-068](../product/07-alerting.md#alr-068--every-attempt-recorded) | §4.13.2 `notification_deliveries` per attempt | `itest:delivery-attempt-record` |
| [ALR-071](../product/07-alerting.md#alr-071--policy-tree-editor-with-traffic-sankey) | §4.13.2 `route_id` on each delivery; 7-day aggregate (§7) | `itest:sankey-vs-deliveries` (within 1 %) |
| [ALR-077](../product/07-alerting.md#alr-077--silences-with-preview-reason-and-audit) | §4.6 `silences` require `reason`; audit (§4.7) | `itest:silence-reason-audit` |
| [ALR-078](../product/07-alerting.md#alr-078--maintenance-windows) | §4.6 `maintenance_windows` with RRULE and scope | `itest:maintenance-rrule` |
| [ALR-082](../product/07-alerting.md#alr-082--monthly-noise-report) | §4.6 `noise_reports`, inputs from §4.13 | `itest:noise-report-sections` |
| [ALR-084](../product/07-alerting.md#alr-084--alert-history-in-postgres) | §4.13.1–§4.13.2 monthly partitions, retention class 13 months, drop (§4.11) | `itest:retention-drop` (14 months seeded → oldest queryable is 13 months); `itest:no-pulsusdb-writes` |
| [ALR-085](../product/07-alerting.md#alr-085--history-queryable-as-telemetry) | §4.13 indexes for the virtual sources; §5.3 read contracts | `itest:virtual-source-alerts` (query matches transition table; PulsusDB query log empty) |
| [ALR-087](../product/07-alerting.md#alr-087--alerting-survives-without-pulsusdb-ingest) | §4.13 all alert history in Postgres; nothing on the ingest path | `itest:alerting-no-ingest` |
| [AI-013](../product/06-ai-copilot.md#ai-013--how-i-got-here-and-cost) | §4.7 `ai_sessions` tokens/cost, `tool_call_log` timings | `itest:ai-cost-ledger` |
| [AI-014](../product/06-ai-copilot.md#ai-014--evidence-objects) | §4.5 `evidence` eight fields, `producer_kind` engine/agent/user/external | `itest:evidence-fields` |
| [AI-015](../product/06-ai-copilot.md#ai-015--re-run-as-of-then-and-now) | §4.5 `evidence.result_hash`; §4.13.3 baseline snapshots as of then | `itest:evidence-rerun-as-of` |
| [AI-037](../product/06-ai-copilot.md#ai-037--anomaly-sweep) | §4.13.3 `anomaly_scores`, `anomaly_baselines` | `itest:virtual-source-anomaly` |
| [AI-046](../product/06-ai-copilot.md#ai-046--data-governance) | §4.7 `tool_call_log` + payload refs, viewable by admins | `itest:ai-audit-log` |
| [AI-050](../product/06-ai-copilot.md#ai-050--derived-ai-state-stays-out-of-pulsusdb) | §4.7, §4.13.3–§4.13.4: baselines, scores, change events, embeddings, sessions, feedback in Postgres | `itest:no-pulsusdb-writes` (RCA replay run) |
| [AI-054](../product/06-ai-copilot.md#ai-054--production-feedback-becomes-labels) | §4.7 `ai_feedback` with inputs ref, engine version, model id | `itest:feedback-labels` |
| [ENT-001](../product/11-enterprise.md#ent-001--organisations-teams-and-users) | §4.2 `orgs`, `teams`, `users`, `memberships` | `itest:identity-model` |
| [ENT-002](../product/11-enterprise.md#ent-002--service-accounts) | §4.2 `service_accounts` (no login credential columns) | `itest:service-account-no-login` |
| [ENT-003](../product/11-enterprise.md#ent-003--built-in-roles) | §4.2 built-in `roles` seeded per org | `itest:builtin-roles` |
| [ENT-004](../product/11-enterprise.md#ent-004--custom-roles) | §4.2 `roles` + `role_permissions` | `itest:custom-role` |
| [ENT-005](../product/11-enterprise.md#ent-005--resource-scoping) | §4.2 `grants` per folder/team; §4.3 folders | `itest:folder-team-grants` |
| [ENT-006](../product/11-enterprise.md#ent-006--scoped-users-see-no-out-of-scope-data) | §4.1 RLS; §4.13 derived rows carry `entity_id`/`tenant_binding_id` for scope filtering (T10 (draft)) | `itest:rls-isolation`; `itest:scope-derived-state` |
| [ENT-008](../product/11-enterprise.md#ent-008--field-level-controls) | §4.2 `data_scopes.field_policy`; §4.7 `audit_events` for gated lookups | `itest:field-policy-store` |
| [ENT-010](../product/11-enterprise.md#ent-010--no-dead-access-denied-pages) | §4.1 list queries filter by grant in SQL (T11-024) | `itest:list-filters-by-permission` |
| [ENT-013](../product/11-enterprise.md#ent-013--scim-provisioning) | §4.2 `users.active`, `orgs.perms_epoch`, token `revoked_at` | `itest:scim-deprovision` (≤ 5 s, with T10 (draft)) |
| [ENT-014](../product/11-enterprise.md#ent-014--group-to-team-and-role-mapping) | §4.2 `idp_group_mappings`; `grants.source='idp'` read-only | `itest:idp-managed-grants` |
| [ENT-015](../product/11-enterprise.md#ent-015--api-tokens) | §4.2 `api_tokens.expires_at NOT NULL`, `permissions`, `scope_id` | `itest:token-expiry-scope` |
| [ENT-016](../product/11-enterprise.md#ent-016--kiosk-tokens) | §4.2 `kiosks`, `kiosk_pairings` | `itest:kiosk-pairing` |
| [ENT-017](../product/11-enterprise.md#ent-017--append-only-audit-log) | §4.7 `audit_events`: no UPDATE/DELETE for any app role, hash chain | `itest:audit-append-only`; `itest:audit-hash-chain` |
| [ENT-018](../product/11-enterprise.md#ent-018--audit-viewer) | §4.7 audit indexes on actor, action, resource | `bench:pg-audit-filter` (10⁴ events, ≤ 50 ms) |
| [ENT-019](../product/11-enterprise.md#ent-019--siem-export) | §4.7 `audit_export_cursors` | `itest:audit-export-cursor` |
| [ENT-020](../product/11-enterprise.md#ent-020--configuration-and-derived-state-in-postgres) | §4.1 RLS on every table (from #59: `orgs`, `tenant_bindings`; from #61: `folders`, `boards`, `board_versions`, `audit_events` and its partitions, `audit_chain_heads`, `stars`, `recent_views`; partial, roadmap Table 2.1c); §4.11 drop-partition retention; T11-001 no extensions | `itest:rls-isolation`; `itest:retention-drop`; `itest:no-extensions` (vanilla PG 15) |
| [ENT-021](../product/11-enterprise.md#ent-021--large-artefacts-in-optional-object-storage) | §4.15 object references with `lo_blobs` fallback | `itest:object-store-fallback` |
| [ENT-022](../product/11-enterprise.md#ent-022--versioned-content-with-diff-and-restore) | §4.3 `<kind>` + `<kind>_versions`, diff and restore | `itest:versions-diff-restore` |
| [ENT-023](../product/11-enterprise.md#ent-023--yaml-export) | §4.9 YAML envelope | `itest:yaml-roundtrip` (byte-identical canonical YAML) |
| [ENT-024](../product/11-enterprise.md#ent-024--git-sync) | §4.9 Git sync modes | `itest:git-sync` (UI save → PR; merged commit → update) |
| [ENT-025](../product/11-enterprise.md#ent-025--managed-by-git-badge-and-conflicting-edits) | §4.9 `managed_by` locks UI edits | `itest:managed-by-lock` |
| [ENT-026](../product/11-enterprise.md#ent-026--terraform-provider) | §4.9 Terraform provider resources ([ADR-0011](../adr/0011-terraform-provider-in-go.md)) | `itest:terraform-provider` (apply, then plan is empty) |
| [ENT-027](../product/11-enterprise.md#ent-027--one-deployment-many-pulsusdb-tenants) | §4.2 `tenant_bindings` per org | `itest:multi-binding` |
| [ENT-029](../product/11-enterprise.md#ent-029--high-availability) | §4.12 HA Postgres, single read-write endpoint | `chaos:pg-failover` |
| [EST-046](../product/15-estate-navigation.md#est-046--entity-graph-cache-and-ephemeral-history) | §4.4 `entities` first/last seen, 30-day daily partitions | `itest:retention-drop` (entities); `itest:ephemeral-replay` |
| [PRF-025](../product/09-performance-contract.md#prf-025--local-first-analytics) | §4.13.5 `pyramid_tiles` fallback (Arrow `bytea`) | `itest:pyramid-tile-fallback` (R4 absent; no PulsusDB write) |

## 4. Design

### 4.0 Conventions

#### T11-001 — Vanilla Postgres, no required extension
**MUST** — The schema MUST run on PostgreSQL ≥ 15 (16 recommended) with **no extension
installed**. Optional extensions (`pgvector`, `pg_trgm`) MAY be detected at start-up and used to
accelerate a feature; every feature MUST work without them. Dash MUST NOT depend on TimescaleDB,
`pg_partman` or `pg_cron`.

- **Keys:** `id uuid` holds a UUIDv7, generated in the BFF (`github.com/google/uuid`, `NewV7`), so the IDs
  are time-ordered and index-friendly. No `pgcrypto` is needed (`gen_random_uuid()` is core since
  PG 13 and is used only in maintenance scripts). Content also has a human `uid text`
  (`[a-z0-9-]{1,40}`), unique per org and kept from the source tool on import.
- **Case-insensitive email** is `text` with a unique index on `lower(email)`, not `citext`.
- **Folder paths** are a `text` materialised path (`/payments/checkout/`) with a
  `text_pattern_ops` index for prefix queries, not `ltree`.
- **Silence overlap** uses a plain B-tree on `(org_id, ends_at)` with `starts_at` filtered in the
  query, not a `btree_gist` range index.
- **Text search** (library, incident archive) uses the built-in `tsvector`/GIN. If `pg_trgm` is
  present, a trigram index is added for fuzzy title matches.
- **Documents:** complex specs (board scene, Lens template, vis spec, rule definition) are stored as
  `jsonb` with a `schema_version int`. Old documents are upgraded by Go upcasters in `internal/spec`,
  applied on read and persisted on the next write. This is separate from SQL migrations.
- **Timestamps** are `timestamptz`. **Soft delete** uses `deleted_at` on content (trash kept 30
  days). Hard delete is used for identity and secrets.

#### T11-002 — `org_id` leads every key
**MUST** — Every tenant-owned table MUST have `org_id uuid NOT NULL` as the first column of its
primary key and of every index, so every access path is org-local.

*Note (#59):* the root table `orgs` keys on `id`, which is the organisation id itself (its policy is
`id = pulsus_org()`); its `slug` index is the only other exception. Non-tenant tables
(`install_state`, `goose_db_version`; §4.1) have no `org_id`.

#### T11-005 — Optimistic concurrency
**MUST** — Every mutable content row MUST carry `etag bigint`, incremented on update; the API MUST
require `If-Match` and return `409` with both versions (for the diff UI) on conflict.

#### T11-004 — Secrets never in domain tables
**MUST** — Secret values MUST NOT appear in any domain table, export or audit diff. Domain tables
hold `secret_ref uuid` pointing at `secrets` ([T18](T18-security.md) §4.8).

### 4.1 Multi-tenancy strategy

**Decision: shared schema, row-level tenancy (`org_id`), with Postgres Row-Level Security as
defence in depth. Schema-per-tenant is rejected.**

| Criterion | Row-level + RLS | Schema-per-tenant |
|---|---|---|
| Migrations | One run | N runs; a partial failure leaves the fleet on mixed versions |
| 10⁴ SaaS orgs | Fine | Catalogue bloat (10⁴ × ~80 tables × indexes, × partitions), slow `pg_dump`, planner cache churn |
| Connection pooling | One pool | `search_path` per checkout, pooled carefully (PgBouncer transaction mode breaks session `SET`) |
| Isolation | App-enforced + RLS | Stronger by default |
| Per-org export/delete | `WHERE org_id` | `DROP SCHEMA` |

**Database roles:**

| Role | Attributes | Used by |
|---|---|---|
| `pulsus_owner` | Owns schema objects, no login from replicas | Migration runner only |
| `pulsus_app` | No `BYPASSRLS`; `SELECT/INSERT/UPDATE/DELETE` on parent tables only; no `UPDATE/DELETE` on `audit_events` | Every request path |
| `pulsus_maint` | `BYPASSRLS`; partition create/detach/drop, retention moves and purges | `worker` role maintenance jobs, separate pool |
| `pulsus_ro` (optional) | No `BYPASSRLS`, read-only | Audit viewer and import dry-runs on a read replica |

A database administrator creates the roles once per cluster, before the first `migrate`, with
`server/deploy/postgres-roles.sql`. The script is idempotent, sets no passwords, and gives every
role `NOSUPERUSER NOCREATEDB NOCREATEROLE`; only `pulsus_maint` has `BYPASSRLS`. The database is
created `OWNER pulsus_owner`. `serve` refuses to start as a role with `rolsuper` or `rolbypassrls`.

**Non-tenant tables.** `install_state` holds one row (`singleton`, `bootstrap_org_id`,
`seeded_at`): the record of the first-run seed, which `migrate` writes under its lock (#59). It has
no `org_id` and no RLS; `pulsus_app` and `pulsus_maint` may only read it, as they may
`goose_db_version`, the migration runner's table. No other table is exempt from T11-003.

#### T11-003 — Every tenant table under RLS, one transaction path
**MUST** — Every tenant-owned table, including partitioned parents, MUST have `ENABLE` and `FORCE
ROW LEVEL SECURITY` with a policy on `org_id`. Every application transaction MUST be opened by
`Db::tx(org)`, which issues one statement setting `pulsus.org_id` and the retention floors (§4.11)
with `set_config(…, true)`; there MUST be no other way to obtain a transaction.

```sql
CREATE FUNCTION pulsus_org() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('pulsus.org_id', true), '')::uuid $$;
CREATE FUNCTION pulsus_floor(domain text) RETURNS timestamptz LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('pulsus.floor.' || domain, true), '')::timestamptz $$;

-- template applied to every tenant table by the migration generator
ALTER TABLE boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE boards FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON boards
  USING (org_id = pulsus_org()) WITH CHECK (org_id = pulsus_org());
```

An unset `pulsus.org_id` yields `NULL`, so a missing context returns zero rows (fail closed).

#### T11-026 — Partitions are not directly reachable
**MUST** — RLS policies apply when a partitioned table is queried through its parent, not when a
partition is queried directly. `pulsus_app` MUST therefore have no privilege on any partition;
partitions MUST be created by `pulsus_maint` with privileges revoked from `PUBLIC` and
`pulsus_app`. A CI check enumerates `pg_inherits` and asserts this.

*Until the worker's maintenance job exists (#61, 2026-11-20):* the audit partitions are created by
the definer function `pulsus_audit_partitions_maintain` (§4.11), owned by `pulsus_owner`, because
`CREATE TABLE … PARTITION OF` and `DETACH` need the parent's owner. Each partition it creates has
RLS enabled and forced with policy `org_isolation`, and grants nothing to `PUBLIC` or `pulsus_app`
(`itest:rls-isolation`).

#### T11-027 — Pre-authentication lookups through definer functions
**MUST** — Lookups that happen before the org is known (session cookie, API token, SCIM bearer,
kiosk pairing code) MUST go through `SECURITY DEFINER` functions (`auth_lookup_session(sid_hash)`,
`auth_lookup_token(token_id)`, `auth_lookup_pairing(code_hash)`) that return only the row's
`org_id` and principal. `pulsus_app` MUST have no direct `SELECT` on `sessions`, `api_tokens` or
`kiosk_pairings`, so these tables stay under the same RLS as the rest.

- Cross-org jobs (retention, the migration runner, the audit exporter's cursor scan) use
  `pulsus_maint` from a separate pool.
- A CI test runs every repository query under RLS with the wrong org and asserts zero rows
  (`itest:rls-isolation`).
- Customers needing harder isolation get a **dedicated cell** (their own Postgres) rather than a
  schema ([T19](T19-deployment.md) §4.8).

#### T11-024 — List queries filter by permission in SQL
**MUST** — Repository list functions MUST take the caller's grant set and filter in SQL (join on
`grants` / folder path prefix), so out-of-permission items are never returned to the BFF and hidden
later ([11](../product/11-enterprise.md) ENT-010). Counts and pagination MUST be computed over the
filtered set.

### 4.2 Identity & access (semantics owned by T10 (draft))

`orgs` and `tenant_bindings` ship first (#59, migration 1). The identity tables (`users`, `teams`,
`memberships`, `roles`, `role_permissions`, `grants`, `idps`, `sessions` and the rest of this
section) arrive with authentication at M-UI6 (D12).

```sql
CREATE TABLE orgs (id uuid PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}', perms_epoch bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz);
-- RLS on orgs: USING (id = pulsus_org())

CREATE TABLE tenant_bindings (org_id uuid REFERENCES orgs, id uuid, slug text NOT NULL,
  datasource_url text NOT NULL, database text, scope_org_id text
    CHECK (scope_org_id ~ '^[A-Za-z0-9_.-]{1,150}$'),
  credentials_ref text                          -- a secret reference, never a value (T11-004):
    CHECK (credentials_ref ~ '^(env:[A-Za-z_][A-Za-z0-9_]{0,127}|file:/.*)$'
           AND credentials_ref !~ '[\x01-\x20\x7f]'  -- no ASCII whitespace or control byte
           AND octet_length(credentials_ref) <= 1028),  -- file:PATH, PATH 1-1023 bytes; byte-wise,
                                                -- locale-independent; secret:<uuid> is added
                                                -- with the secrets table
  kind text NOT NULL DEFAULT 'pulsusdb',        -- 'prometheus' read-only (PRN-012)
  PRIMARY KEY (org_id, id), UNIQUE (org_id, slug));

CREATE TABLE users (org_id uuid, id uuid, email text NOT NULL, display_name text,
  idp_id uuid, external_id text, active bool NOT NULL DEFAULT true,
  password_hash text,                           -- local login (bootstrap / no IdP); no Dash MFA (ENT-011)
  last_login_at timestamptz,
  PRIMARY KEY (org_id, id), UNIQUE (org_id, idp_id, external_id));
CREATE UNIQUE INDEX ON users (org_id, lower(email));

CREATE TABLE teams (org_id uuid, id uuid, uid text, name text NOT NULL, external_id text,
  idp_managed bool NOT NULL DEFAULT false, working_hours jsonb,    -- out-of-hours pages (ALR-051)
  PRIMARY KEY (org_id, id), UNIQUE (org_id, uid));
CREATE TABLE memberships (org_id uuid, team_id uuid, user_id uuid, role text NOT NULL DEFAULT 'member',
  source text NOT NULL, PRIMARY KEY (org_id, team_id, user_id));          -- source: ui|scim|idp
CREATE INDEX ON memberships (org_id, user_id);

CREATE TABLE roles (org_id uuid, id uuid, name text, builtin bool NOT NULL,
  PRIMARY KEY (org_id, id), UNIQUE (org_id, name));          -- Viewer, Responder, Editor, Admin seeded
CREATE TABLE role_permissions (org_id uuid, role_id uuid, permission text,
  PRIMARY KEY (org_id, role_id, permission));
CREATE TABLE grants (org_id uuid, id uuid, subject_kind text, subject_id uuid, role_id uuid,
  resource_kind text NOT NULL,                  -- org|folder|team|object
  resource_id uuid, source text NOT NULL,       -- ui|api|idp|terraform; 'idp' rows are read-only in the UI
  PRIMARY KEY (org_id, id));
CREATE INDEX ON grants (org_id, subject_kind, subject_id);
CREATE INDEX ON grants (org_id, resource_kind, resource_id);

CREATE TABLE data_scopes (org_id uuid, id uuid, name text, tenants uuid[] NOT NULL,
  rules jsonb NOT NULL,                         -- [{key, allow:{exact:[..]}|{re2:".."}}]
  field_policy jsonb NOT NULL,                  -- log body visibility, masked keys, gated lookups
  signals text[] NOT NULL, PRIMARY KEY (org_id, id));
CREATE TABLE scope_grants (org_id uuid, subject_kind text, subject_id uuid, scope_id uuid,
  PRIMARY KEY (org_id, subject_kind, subject_id, scope_id));

CREATE TABLE idps (org_id uuid, id uuid, kind text CHECK (kind IN ('oidc','saml')), config jsonb,
  client_secret_ref uuid, PRIMARY KEY (org_id, id));
CREATE TABLE idp_group_mappings (org_id uuid, idp_id uuid, external_group text, team_id uuid, role_id uuid,
  PRIMARY KEY (org_id, idp_id, external_group));

CREATE TABLE service_accounts (org_id uuid, id uuid, name text, team_id uuid, kind text NOT NULL,
  PRIMARY KEY (org_id, id));                    -- kind: generic|kiosk|auto_rca|scim|git_sync; no credential columns
CREATE TABLE api_tokens (org_id uuid, id text,  -- ULID from the token prefix
  owner_kind text, owner_id uuid, kind text, secret_hash bytea NOT NULL,
  permissions text[] NOT NULL, scope_id uuid, cidrs cidr[], expires_at timestamptz NOT NULL,
  last_used_at timestamptz, revoked_at timestamptz, PRIMARY KEY (org_id, id));
CREATE UNIQUE INDEX ON api_tokens (id);         -- used only by auth_lookup_token()
CREATE TABLE sessions (sid_hash bytea PRIMARY KEY, org_id uuid NOT NULL, user_id uuid NOT NULL,
  idp_id uuid, auth_time timestamptz, amr text[], idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL, csrf_token bytea, idp_refresh_ref uuid,
  perms_epoch bigint NOT NULL, ip inet, ua_hash bytea);
CREATE INDEX ON sessions (org_id, user_id);     -- revoke-all on SCIM deprovision
CREATE TABLE kiosks (org_id uuid, id uuid, sa_id uuid, playlist_id uuid, scene_ref text,
  cidrs cidr[], last_heartbeat_at timestamptz, PRIMARY KEY (org_id, id));
CREATE TABLE kiosk_pairings (code_hash bytea PRIMARY KEY, org_id uuid, device_pubkey bytea,
  approved_by uuid, kiosk_id uuid, expires_at timestamptz NOT NULL);       -- code shown on the wall
CREATE TABLE identity_links (org_id uuid, provider text, external_user text, user_id uuid NOT NULL,
  linked_at timestamptz, PRIMARY KEY (org_id, provider, external_user));  -- Slack/Teams → Dash user (T16 §4.13)
```

- SCIM deprovisioning sets `users.active=false`, deletes the user's `sessions`, sets
  `revoked_at` on their tokens and increments `orgs.perms_epoch` in one transaction; replicas
  compare the session's `perms_epoch` on every request (T10 (draft)), which meets the 5 s bound of
  ENT-013.
- Built-in roles are seeded per org by migration with `builtin=true` and cannot be edited; custom
  roles (ENT-004) are ordinary rows.

### 4.3 Content: folders, boards, versions

```sql
CREATE TABLE folders (org_id uuid, id uuid, uid text, title text, path text NOT NULL,   -- '/payments/checkout/'
  owner_team_id uuid, managed_by text, PRIMARY KEY (org_id, id), UNIQUE (org_id, uid));
CREATE INDEX ON folders (org_id, path text_pattern_ops);

-- Generic versioned-content pattern: one head table + one versions table per kind.
CREATE TABLE boards (org_id uuid, id uuid, uid text NOT NULL, folder_id uuid, title text NOT NULL,
  tags text[], head_version int NOT NULL, etag bigint NOT NULL,
  managed_by text,                      -- null | 'git:<repo_id>' | 'terraform' | 'provisioning'
  incident_open_count int NOT NULL DEFAULT 0,  -- "used during incidents" ranking (04 §4.3)
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || array_to_string(tags, ' '))) STORED,
  deleted_at timestamptz, PRIMARY KEY (org_id, id), UNIQUE (org_id, uid));
CREATE INDEX ON boards USING gin (search);
CREATE TABLE board_versions (org_id uuid, board_id uuid, version int,
  spec jsonb NOT NULL, schema_version int NOT NULL, content_hash bytea NOT NULL,  -- SHA-256 of canonical JSON
  author_kind text, author_id uuid, message text,
  source text NOT NULL CHECK (source IN ('ui','api','git','terraform','import','ai','restore','provisioning')),
  source_ref text,                      -- commit sha / PR url / import job id
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (org_id, board_id, version));
ALTER TABLE board_versions ALTER COLUMN spec SET COMPRESSION lz4;
```

(`array_to_string` on a nullable `tags` is wrapped with `coalesce` in the real migration.)

The same `<kind>` + `<kind>_versions` pair is used for:
- `lens_templates` (with `entity_type`, `team_id`; `entity_type='edge'` for Edge Lens);
- `lens_overrides` (per entity or team);
- `perspectives` (built-ins seeded, org overrides; `spec` includes the default Segments
  segmentation of [07](../product/07-alerting.md) Table 5.3);
- `journeys`;
- `slos`;
- `alert_rules` (§4.6);
- `contact_points`, `notification_templates`, `action_definitions`;
- `schematics`;
- `playlists`.

`stars`, `recent_views (org_id, user_id, kind, id, viewed_at)` (kept to 200 per user) and `tags`
are small, unversioned tables.

*#61 subset (2026-11-20, migration 2):*
- `boards` ships without `tags`, `search`, `managed_by` and `incident_open_count`; each is added,
  expand-only, with its feature.
- Integer columns are `bigint` (squawk `prefer-bigint-over-int`), and `board_versions.spec` has no
  `lz4` compression setting, because a vanilla build may lack lz4 (T11-001).
- `stars (org_id, user_id, kind, object_id, created_at)` and `recent_views (org_id, user_id, kind,
  id, viewed_at)`, both keyed by all columns but the timestamp, `kind` limited to `board`.
- Every organisation has a root folder (`uid` `root`, path `/`): seeded with the organisation and
  ensured on its first board.

#### T11-006 — Versions are immutable
**MUST** — A save MUST insert version `n+1` and move `head_version` in one transaction, with an
audit event carrying the RFC 6902 JSON Patch. No version row is ever updated or
deleted except by the org's version-retention policy; restore MUST create a new head with
`source='restore'`, so history is never rewritten.

- Diffs are computed on demand in the BFF, never stored:
  - a structural diff for the JSON view;
  - a "scene diff" (added, removed or moved viewports; changed queries) for the visual
    side-by-side ([04](../product/04-surfaces.md) §4.3).
- Unchanged saves (same `content_hash`) are no-ops.
- Retention: all versions kept by default, or an org policy such as "keep 100 or 1 year, whichever
  is more", pruned by the maintenance job (head and tagged versions are never pruned).

### 4.4 Entities, views, layout (store for [T12](T12-entity-catalogue.md), T14 (draft))

```sql
CREATE TABLE entity_schema (org_id uuid, version int, spec jsonb, PRIMARY KEY (org_id, version));  -- entity types, identity keys, hierarchy
CREATE TABLE label_mappings (org_id uuid, tenant_binding_id uuid, canonical_key text, signal text,
  label text NOT NULL, PRIMARY KEY (org_id, tenant_binding_id, canonical_key, signal));
CREATE TABLE entity_overrides (org_id uuid, entity_key text,          -- canonical identity string
  display_name text, owner_team_id uuid, tier smallint, runbook_url text, attrs jsonb,
  PRIMARY KEY (org_id, entity_key));
CREATE TABLE entities (org_id uuid, tenant_binding_id uuid, id uuid, kind text, ident text,
  class text, provider text, native_type text, managed bool,          -- 16 Table 16-1 (T12)
  attrs_digest bytea, first_seen timestamptz, last_seen_day date NOT NULL, source text,
  PRIMARY KEY (org_id, last_seen_day, id)) PARTITION BY RANGE (last_seen_day);   -- daily, 30 d (EST-046)
CREATE TABLE entity_edges (org_id uuid, from_id uuid, to_id uuid, rel text, first_seen timestamptz,
  last_seen_day date NOT NULL, PRIMARY KEY (org_id, last_seen_day, from_id, to_id, rel))
  PARTITION BY RANGE (last_seen_day);
CREATE TABLE class_mappings (org_id uuid NOT NULL, provider text NOT NULL, native_type text NOT NULL,
  class text NOT NULL, updated_by uuid NOT NULL, updated_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, provider, native_type));                        -- INF-003 overrides (T12)
CREATE TABLE catalogue_snapshots (org_id uuid, tenant_binding_id uuid, seq bigint, fencing bigint,
  blob bytea, created_at timestamptz, PRIMARY KEY (org_id, tenant_binding_id, seq));   -- zstd, last 3 kept
CREATE TABLE waypoints (org_id uuid, id uuid, owner_user_id uuid,
  visibility text NOT NULL CHECK (visibility IN ('personal','team','org')), team_id uuid,
  name text, context jsonb NOT NULL, camera bytea NOT NULL, scene_ref text, PRIMARY KEY (org_id, id));
CREATE TABLE saved_views (org_id uuid, id uuid, owner_user_id uuid, team_id uuid, shipped bool NOT NULL DEFAULT false,
  surface text, name text, state jsonb NOT NULL, PRIMARY KEY (org_id, id));  -- workbench queries, Explorer columns, alert views
CREATE TABLE layout_positions (org_id uuid, layout_key text,         -- e.g. 'atlas:topology:<perspective>'
  entity_key text, x real, y real, z real, pinned bool NOT NULL DEFAULT false, updated_at timestamptz,
  PRIMARY KEY (org_id, layout_key, entity_key));
CREATE TABLE annotations (org_id uuid, id uuid, at timestamptz NOT NULL, end_at timestamptz,
  entity_key text, text text NOT NULL, tags text[], author_kind text, author_id uuid,
  PRIMARY KEY (org_id, id));                                            -- user notes on the time axis
CREATE INDEX ON annotations (org_id, at);
```

- `entities` and `entity_edges` are partitioned on a **day** column: the precise `last_seen` is
  kept in the in-memory catalogue and the `catalogue_snapshots` blob, and `last_seen_day` is
  advanced at most once per day per row, so a row moves between daily partitions at most once a
  day. Partitions older than 30 days are dropped (EST-046; older history is reconstructed from
  PulsusDB by [T12](T12-entity-catalogue.md)).
- `layout_positions` holds per-org spatial memory for force layouts ([T02](T02-vis-engine.md)).
  Positions are **server-canonical**: the BFF layout job computes and writes them, and browsers
  write only explicit user pins (`layout:write`). T14 (draft) owns and may refine this table,
  including the entity key type (T12 `EntityId`). At 10⁴ entities × a few layouts it stays under
  10⁵ rows per org.
- The shipped alert saved views ("My team's firing", "Unowned SEV1–2", "NoData everywhere",
  "Silenced, expiring < 1 h", ALR-038) are `saved_views` rows with `shipped=true`, seeded by
  provisioning.

### 4.5 Investigations, evidence, incidents (store for T15 (draft), T17 (draft))

```sql
CREATE TABLE org_sequences (org_id uuid, kind text, next bigint NOT NULL,
  PRIMARY KEY (org_id, kind));                  -- kind 'incident': INC-n and its INV-n share n
CREATE TABLE incidents (org_id uuid, id uuid, number bigint NOT NULL, title text, severity text, status text,
  origin_entity_key text, owner_team_id uuid, opened_at timestamptz NOT NULL, acked_at timestamptz,
  acked_by uuid, resolved_at timestamptz, last_activity_at timestamptz,
  investigation_id uuid, root_cause_category text, impact jsonb, postmortem_url text,
  external_refs jsonb,                          -- PagerDuty/Jira/ServiceNow ids
  search tsvector,                              -- title, origin, root cause; maintained on write
  PRIMARY KEY (org_id, id), UNIQUE (org_id, number));
CREATE INDEX ON incidents (org_id, owner_team_id, opened_at);
CREATE INDEX ON incidents (org_id, status, last_activity_at) WHERE status <> 'resolved';
CREATE INDEX ON incidents USING gin (search);
CREATE TABLE incident_alerts (org_id uuid, incident_id uuid, rule_id uuid, labels_hash bytea,
  joined_at timestamptz, sticky bool NOT NULL DEFAULT false,      -- human merge/split (ALR-037)
  PRIMARY KEY (org_id, incident_id, rule_id, labels_hash));
CREATE TABLE investigations (org_id uuid, id uuid, number bigint NOT NULL, title text, status text,
  context jsonb, ic_user_id uuid, created_by_kind text, created_by_id uuid,
  root_cause text, postmortem jsonb, PRIMARY KEY (org_id, id), UNIQUE (org_id, number));
CREATE TABLE evidence (org_id uuid, id uuid, investigation_id uuid,
  producer_kind text CHECK (producer_kind IN ('engine','agent','user','external')), producer_id uuid,
  signal text, query text NOT NULL, params jsonb, window_start timestamptz, window_end timestamptz,
  tenant_binding_id uuid, scope_fp bytea NOT NULL,   -- viewer re-check (T10 (draft), AI-018)
  coverage jsonb, result_hash bytea, viewport jsonb, snapshot_ref uuid,  -- artefacts(id), §4.15
  created_at timestamptz, PRIMARY KEY (org_id, id));
CREATE INDEX ON evidence (org_id, investigation_id, created_at);
CREATE TABLE hypotheses (org_id uuid, id uuid, investigation_id uuid, parent_id uuid, text text,
  verdict text, confidence real, producer_kind text, PRIMARY KEY (org_id, id));
CREATE TABLE hypothesis_evidence (org_id uuid, hypothesis_id uuid, evidence_id uuid,
  relation text CHECK (relation IN ('supports','refutes')), PRIMARY KEY (org_id, hypothesis_id, evidence_id));
CREATE TABLE timeline_events (org_id uuid, investigation_id uuid, id uuid, at timestamptz, kind text,
  actor_kind text, actor_id uuid, body jsonb, PRIMARY KEY (org_id, investigation_id, id));
CREATE TABLE participants (org_id uuid, investigation_id uuid, user_id uuid, role text, joined_at timestamptz,
  PRIMARY KEY (org_id, investigation_id, user_id));
CREATE TABLE recordings (org_id uuid, id uuid, investigation_id uuid, artefact_id uuid, bytes bigint,
  started_at timestamptz, ended_at timestamptz, PRIMARY KEY (org_id, id));   -- flight recorder (T17 (draft))
```

**Numbering.** Opening an incident runs `UPDATE org_sequences SET next = next + 1 WHERE org_id = $1
AND kind = 'incident' RETURNING next - 1` in the same transaction as the insert, so `INC-n` is
unique and its investigation is created with the same `n` (`INV-n`, IA-009). Numbers are never
reused; a rolled-back transaction leaves no gap because the counter row update rolls back with it.

### 4.6 Alerting configuration and live state (store for [T16](T16-alert-evaluator.md))

```sql
CREATE TABLE alert_rules (org_id uuid, id uuid, uid text, folder_id uuid, owner_team_id uuid,
  owner_sa_id uuid NOT NULL,                  -- evaluation identity (T10 (draft))
  kind text, head_version int, etag bigint, paused bool, managed_by text, shard smallint NOT NULL,
  last_eval_at timestamptz, last_eval_status text,   -- missed-evaluation watchdog (T16 §4.2)
  PRIMARY KEY (org_id, id), UNIQUE (org_id, uid));
CREATE INDEX ON alert_rules (shard, org_id);  -- shard owner loads its rules via rules_for_shard() (below)
CREATE TABLE alert_rule_versions (org_id uuid, rule_id uuid, version int, spec jsonb, schema_version int,
  content_hash bytea, author_kind text, author_id uuid, source text, created_at timestamptz,
  PRIMARY KEY (org_id, rule_id, version));
-- spec: {kind, tenant_binding, queries:[{ref,signal,expr}], condition, for, keep_firing_for,
--        nodata_policy, error_policy, severity, notify, damping, labels, annotations,
--        entity_template?, slo_ref?, composite?}
CREATE TABLE rule_routes (org_id uuid, rule_id uuid, route_id text, contact_point_id uuid,
  PRIMARY KEY (org_id, rule_id, route_id, contact_point_id));      -- derived; drives "Used by"
CREATE INDEX ON rule_routes (org_id, contact_point_id);

CREATE TABLE alert_instances (org_id uuid, rule_id uuid, labels_hash bytea, labels jsonb NOT NULL,
  entity_id uuid, state text NOT NULL, state_since timestamptz NOT NULL, active_at timestamptz,
  last_eval_at timestamptz, last_value double precision, fired_at timestamptz, resolved_at timestamptz,
  flags smallint NOT NULL DEFAULT 0,          -- bit 0 acked, 1 silenced, 2 maintenance, 3 flapping, 4 stale
  acked_by uuid, acked_at timestamptz, flap_ring timestamptz[], incident_id uuid, fencing bigint NOT NULL,
  PRIMARY KEY (org_id, rule_id, labels_hash))
  WITH (fillfactor = 70);                     -- HOT updates each checkpoint

CREATE TABLE contact_points (org_id uuid, id uuid, uid text, name text, integrations jsonb,  -- secrets as secret_ref
  delivery jsonb NOT NULL,                    -- retries 5, backoff exp, timeout 10 s, send_resolved, rate limit
  is_fallback bool NOT NULL DEFAULT false, head_version int, managed_by text,
  PRIMARY KEY (org_id, id), UNIQUE (org_id, uid));
CREATE TABLE notification_policies (org_id uuid, version int, tree jsonb NOT NULL, created_by uuid,
  created_at timestamptz, PRIMARY KEY (org_id, version));   -- whole tree versioned, like Alertmanager
CREATE TABLE inhibition_rules (org_id uuid, id uuid, source_matchers jsonb, target_matchers jsonb,
  equal text[], PRIMARY KEY (org_id, id));
CREATE TABLE notification_templates (org_id uuid, name text, body text, head_version int, PRIMARY KEY (org_id, name));
CREATE TABLE escalation_chains (org_id uuid, id uuid, name text, steps jsonb NOT NULL,     -- [{receiver, after, until_ack}]
  PRIMARY KEY (org_id, id));
CREATE TABLE escalation_timers (org_id uuid, incident_id uuid, chain_id uuid, step smallint,
  due_at timestamptz NOT NULL, fencing bigint, PRIMARY KEY (org_id, incident_id, chain_id));
CREATE TABLE silences (org_id uuid, id uuid, matchers jsonb NOT NULL, entity_selector jsonb,
  starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, reason text NOT NULL CHECK (length(reason) > 0),
  created_by_kind text, created_by_id uuid, expired_at timestamptz, nudged_at timestamptz,
  PRIMARY KEY (org_id, id));
CREATE INDEX ON silences (org_id, ends_at) WHERE expired_at IS NULL;
CREATE TABLE maintenance_windows (org_id uuid, id uuid, title text, rrule text, dtstart timestamptz,
  duration interval, tz text, scope jsonb, source_ref text, PRIMARY KEY (org_id, id));   -- RFC 5545 RRULE; CR link
CREATE TABLE mute_timings (org_id uuid, name text, intervals jsonb, PRIMARY KEY (org_id, name));
CREATE TABLE rule_eval_stats (org_id uuid, rclass smallint NOT NULL, hour timestamptz NOT NULL, rule_id uuid,
  evals int, errors int, missed int, missed_ticks timestamptz[], dur_p50_ms int, dur_max_ms int,
  PRIMARY KEY (org_id, rclass, hour, rule_id)) PARTITION BY LIST (rclass);   -- domain 'eval_health', 30 d, daily
CREATE TABLE noise_reports (org_id uuid, team_id uuid, month date, report jsonb NOT NULL,
  generated_at timestamptz, PRIMARY KEY (org_id, team_id, month));           -- ALR-082 (M-UI5)

-- Coordination (shape from the T06 lease primitive; DDL here)
CREATE TABLE job_leases (job_key text PRIMARY KEY, holder uuid NOT NULL, fencing bigint NOT NULL,
  expires_at timestamptz NOT NULL);
CREATE TABLE members (instance uuid PRIMARY KEY, roles text[], heartbeat timestamptz, version text);
CREATE TABLE evaluator_members (member uuid PRIMARY KEY, epoch bigint NOT NULL, heartbeat_at timestamptz NOT NULL);
CREATE TABLE rule_shard_leases (shard smallint PRIMARY KEY, owner uuid, fence bigint NOT NULL,
  expires_at timestamptz NOT NULL);
CREATE TABLE dispatch_leases (shard smallint PRIMARY KEY, owner uuid, fence bigint NOT NULL,
  expires_at timestamptz NOT NULL);

CREATE TABLE alert_events (org_id uuid, id bigint GENERATED ALWAYS AS IDENTITY, rule_id uuid, labels_hash bytea,
  kind text NOT NULL,                          -- transition | flag | heartbeat | meta
  fencing bigint NOT NULL, body jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz, PRIMARY KEY (org_id, id));     -- outbox, pruned after 7 d (T16 §4.8)
CREATE INDEX ON alert_events (created_at) WHERE consumed_at IS NULL;
CREATE TABLE delivery_jobs (org_id uuid, id uuid, due_at timestamptz, attempt smallint, claimed_by uuid,
  fencing bigint, payload jsonb, PRIMARY KEY (org_id, id));          -- claimed FOR UPDATE SKIP LOCKED
CREATE INDEX ON delivery_jobs (due_at) WHERE claimed_by IS NULL;
CREATE TABLE nflog (org_id uuid, receiver uuid, group_key bytea, firing_set_hash bytea,
  resolved_set_hash bytea, window_start timestamptz, sent_at timestamptz, fence bigint,
  PRIMARY KEY (org_id, receiver, group_key, firing_set_hash, resolved_set_hash, window_start));
```

- **Coordination tables are infrastructure**, not tenant data: `job_leases`, `members`,
  `evaluator_members`, `rule_shard_leases` and `dispatch_leases` carry no `org_id` and no tenant
  content, and are exempt from RLS. The shard owner reads `alert_rules` for its shard through a
  `SECURITY DEFINER` function `rules_for_shard(shard)` that returns `(org_id, rule_id)` pairs; all
  further reads are per-org `Db::tx` transactions.
- **Write volume:** 50k instances evaluated every 30 s gives about 1.7k candidate upserts/s. These
  are batched by [T16](T16-alert-evaluator.md) into `INSERT … ON CONFLICT DO UPDATE … WHERE state IS
  DISTINCT FROM …`, one statement per shard per cycle, so only changes write; value and last-eval
  fields are checkpointed every 5 min.

#### T11-011 — Fenced writes
**MUST** — Every state write made under a lease (alert instance upsert, outbox row, transition,
delivery claim, catalogue snapshot, partition maintenance) MUST carry the lease's fencing token and
be conditional on it (`WHERE fence = $current` on the lease row in the same transaction), so a
deposed owner's late write is rejected.

### 4.7 Preferences, AI, secrets, audit

```sql
CREATE TABLE user_preferences (org_id uuid, user_id uuid, prefs jsonb, PRIMARY KEY (org_id, user_id));
CREATE TABLE notification_prefs (org_id uuid, user_id uuid, prefs jsonb, PRIMARY KEY (org_id, user_id));
CREATE TABLE ai_settings (org_id uuid PRIMARY KEY, provider jsonb, api_key_ref uuid, policy jsonb,
  redaction_rules jsonb, budgets jsonb);       -- policy: logs_body_visible, auto-approve list, models per task
CREATE TABLE ai_sessions (org_id uuid, id uuid, user_id uuid, principal_kind text, investigation_id uuid,
  started_at timestamptz, tokens_in bigint, tokens_out bigint, queries int, cost_micros bigint,
  PRIMARY KEY (org_id, id));
CREATE TABLE tool_call_log (org_id uuid, session_id uuid, seq int, tool text, provider text, model text,
  args_hash bytea, payload_ref uuid,           -- artefacts(id): prompt + result, redacted form
  result_hash bytea, latency_ms int, at timestamptz, PRIMARY KEY (org_id, session_id, seq));
CREATE TABLE ai_feedback (org_id uuid, id uuid, target_kind text, target_id uuid, user_id uuid,
  rating smallint, challenge text, outcome text,          -- 'confirmed_root_cause' | 'challenge_upheld' | …
  inputs_ref uuid, engine_version text, model_id text, at timestamptz, PRIMARY KEY (org_id, id));
CREATE TABLE incident_embeddings (org_id uuid, investigation_id uuid, model text, embedding real[] NOT NULL,
  PRIMARY KEY (org_id, investigation_id, model));
  -- portable form; if pgvector is present a generated vector(d) column + HNSW index is added per model (T15 (draft))
CREATE TABLE actions (org_id uuid, id uuid, kind text, definition_id uuid, target jsonb, params jsonb, risk text,
  proposed_by_kind text, proposed_by_id uuid, on_behalf_of uuid, confirmed_by uuid, status text, approvals jsonb,
  idempotency_key text, result jsonb, created_at timestamptz, PRIMARY KEY (org_id, id));   -- T18 §4.7
CREATE TABLE action_definitions (org_id uuid, id uuid, uid text, kind text, risk text, spec jsonb,
  credential_ref uuid, runbook_url text, head_version int, PRIMARY KEY (org_id, id), UNIQUE (org_id, uid));
CREATE TABLE vis_modules (org_id uuid, id uuid, name text, wasm_sha256 bytea, artefact_id uuid,
  publisher_key bytea, signature bytea, enabled bool, PRIMARY KEY (org_id, id));           -- T18 §4.4
CREATE TABLE secrets (org_id uuid, id uuid, kind text CHECK (kind IN ('inline','vault','aws_sm','gcp_sm','azure_kv')),
  ciphertext bytea, nonce bytea, dek_id uuid, ref text, aad text NOT NULL, last4 text, rotated_at timestamptz,
  PRIMARY KEY (org_id, id));
CREATE TABLE data_keys (org_id uuid, id uuid, wrapped_dek bytea, kek_ref text, created_at timestamptz,
  retired_at timestamptz, PRIMARY KEY (org_id, id));                                     -- T18 §4.8
CREATE TABLE audit_events (org_id uuid, rclass smallint NOT NULL, at timestamptz NOT NULL, id uuid,
  actor_kind text, actor_id uuid, on_behalf_of uuid, action text NOT NULL, resource_kind text, resource_id text,
  reason jsonb, diff jsonb, ip inet, request_id text, prev_hash bytea, hash bytea NOT NULL,
  PRIMARY KEY (org_id, rclass, at, id)) PARTITION BY LIST (rclass);    -- each class RANGE (at) monthly
CREATE INDEX ON audit_events (org_id, actor_id, at);
CREATE INDEX ON audit_events (org_id, action, at);
CREATE INDEX ON audit_events (org_id, resource_kind, resource_id, at);
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM pulsus_app, pulsus_ro;
CREATE TABLE audit_export_cursors (org_id uuid, sink text, last_at timestamptz, last_id uuid, PRIMARY KEY (org_id, sink));
CREATE TABLE git_repos (org_id uuid, id uuid, url text, branch text, path text, direction text,
  auth_ref uuid, last_sync_sha text, last_sync_at timestamptz, PRIMARY KEY (org_id, id));
CREATE TABLE import_jobs (org_id uuid, id uuid, kind text, status text, report jsonb, created_by uuid,
  created_at timestamptz, PRIMARY KEY (org_id, id));
CREATE TABLE backfills (name text PRIMARY KEY, cursor jsonb, done bool NOT NULL DEFAULT false, updated_at timestamptz);
```

*Audit chain head (#61, 2026-11-20):* `audit_chain_heads (org_id, last_at, last_id, last_hash)`
holds each organisation's chain head. It is not under the retention floor, so the chain continues
across it, and it is updated in the event's transaction (`pulsus_app` has no `DELETE`).

#### T11-017 — Audit is append-only and hash-chained
**MUST** — `audit_events` MUST NOT be updatable or deletable by `pulsus_app` or `pulsus_ro`; only
`pulsus_maint` MAY drop whole expired partitions. Each event MUST carry `hash = SHA-256(prev_hash ‖
canonical(event))`, chained per org. The insert takes `pg_advisory_xact_lock(hashtext(org_id::text))`,
which serialises inserts per org; the expected rate (≤ 100/s per org) is far below the contention
point. The previous hash is read from `audit_chain_heads` (`FOR UPDATE`), never from the newest
visible event, which may be below the retention floor (T11-010).

- Exports, gated customer lookups (ENT-008), AI tool calls, silences, acks and actions are audit
  actions; data-access audit (M-UI6) is sampled per org policy.
- The SIEM exporter (ENT-019) reads by `(org_id, at, id)` after `audit_export_cursors` and is
  at-least-once; the sink deduplicates on `id`.

### 4.8 Migrations

**Decision (revised 2026-11-19, [ADR-0015](../adr/0015-go-bff.md)): `goose` migrations** — plain SQL
files in `server/migrations/`, embedded with `embed.FS` and run by `pulsus-dash migrate`. Repository
code uses `pgx/v5` with `sqlc`-generated queries from `server/queries/`; the generated code is
committed and regenerated in CI (`ci:api-gen`). Data backfills are application jobs (T11-014), so
Go-code migrations are not used. (Was: `sqlx` migrations, with `refinery` as the alternative.)

#### T11-012 — Expand/contract only
**MUST** — A release MAY add tables, columns (nullable or with a default), indexes and constraints,
and MAY delete only what release N−1 no longer reads. Renames MUST be done as add + backfill + switch
+ drop across ≥ 2 releases.

#### T11-013 — No locking DDL
**MUST** — A CI lint (`squawk`) MUST reject locking DDL: `ALTER … SET NOT NULL` without a `CHECK …
NOT VALID` → `VALIDATE` sequence, `CREATE INDEX` without `CONCURRENTLY` on a non-empty table, and
`ATTACH PARTITION` without a pre-validated matching `CHECK`. `CREATE INDEX CONCURRENTLY` cannot run
in a transaction, so such migrations are marked `-- +goose NO TRANSACTION` (goose supports this per file).
Indexes on partitioned parents are created `ON ONLY` the parent, then `CONCURRENTLY` on each
partition and attached.

#### T11-014 — Backfills are jobs
**MUST** — Data backfills MUST be idempotent, batched jobs (`backfills` table with a cursor), not
migrations, so a 10⁷-row backfill never holds a migration lock.

#### T11-015 — Migration runner and compatibility window
**MUST** — The runner is `pulsus-dash migrate`, run by a Helm pre-upgrade Job
([T19](T19-deployment.md) §4.5). It MUST take `pg_advisory_lock(<constant>)`, and MUST refuse to
start if the database is *ahead* of the binary by more than the N+1 compatibility window. Replicas at
start-up MUST check `goose_db_version` and refuse to serve if the schema is older than they require.

#### T11-016 — Document upcasters are golden-tested
**MUST** — Every historical `schema_version` fixture MUST upcast to the current version in CI.

### 4.9 Config-as-code: YAML, Git sync, Terraform

**YAML format.** Each versioned kind has a documented resource envelope:

```yaml
apiVersion: dash.pulsus.io/v1
kind: Board                       # Board|LensTemplate|Perspective|AlertRule|SLO|ContactPoint|NotificationPolicy|Journey|Folder|DataScope|Silence
metadata: { uid: payments-overview, folder: payments, labels: {team: payments} }
spec: { … }                       # same JSON Schema as board_versions.spec
```

JSON Schemas are taken from the components of `api/openapi.yaml` and published, so editors and CI can
validate. Secrets in YAML are always references (`secretRef: vault://kv/pulsus/slack#token`), never
values. Export → import → export MUST yield byte-identical canonical YAML (ENT-023).

**Git sync** (M-UI6). Each repo binding is in `git_repos`, and the layout is
`<path>/<kind>/<folder>/<uid>.yaml`. Three modes:

| Mode | Behaviour |
|---|---|
| `pull` (Git → Dash) | A webhook or 60 s poll reads the commit. Changed files are validated and applied as versions with `source='git'` and `source_ref=<sha>`, and the objects get `managed_by='git:<repo>'`. UI edits are **blocked** with a "managed by Git" badge; the "Propose change" action creates a PR instead. |
| `pr` (Dash → Git) | A UI save on a managed object becomes a branch + PR through the provider REST API (GitHub, GitLab, Bitbucket, Azure DevOps). It lands when the PR merges and the pull runs. The live object is unchanged until then. |
| `push` (Dash → Git, mirror) | Every save commits to a branch; Git is used for audit and backup only. |

- A file deleted in Git moves the object to trash. Objects are never deleted silently.
- Conflicts can only arise in `pr` mode, and they are resolved in Git.
- Git operations use `gix` (gitoxide) for fetch and read, plus provider REST APIs for commits and
  PRs. That avoids `git2`/libgit2's C dependency and a need to push over SSH. `gix`'s push support is
  still maturing (to be verified in M-UI6), and REST commits avoid needing it.

#### T11-019 — Managed objects cannot diverge
**MUST** — An object with `managed_by` set MUST NOT accept a direct UI or API write that would make
it diverge from its source: per folder policy the write is refused (`409 managed`) or turned into a
PR. The only writer for a `terraform`-managed object is a request carrying the Terraform provider's
token kind.

**Terraform provider** (M-UI6, [ADR-0011](../adr/0011-terraform-provider-in-go.md)). It is a thin
Go client of the same public REST API, generated where possible from the OpenAPI description, with
resources `pulsus_dash_board`, `_folder`, `_alert_rule`, `_slo`, `_contact_point`,
`_notification_policy`, `_mute_timing`, `_silence`, `_maintenance_window`, `_team`, `_role`,
`_data_scope`, `_service_account`, `_api_token`, `_lens_template`, `_perspective` and `_journey`,
and data sources for users, teams and entities.
- Managed objects get `managed_by='terraform'`, which locks them in the UI like Git does.
- Board specs are passed as YAML/JSON strings (`spec = file("…")`), with a diff-suppress function
  on canonical JSON, so `terraform plan` after `apply` is empty.

### 4.10 Importers

`internal/importer` package, exposed as `POST /api/dash/v1/import/{dashboard|alerting}` and
as `pulsus-dash import` CLI.

#### T11-020 — Imports are dry-run first
**MUST** — Every import MUST first produce an `import_jobs.report` with each item marked `mapped`,
`approximated (note)` or `unmapped (fallback)`, and MUST commit nothing until the user accepts it.
Imported alert rules MUST start paused.

**Existing dashboard JSON → Board** ([05](../product/05-visualisation-catalogue.md) §11):

| Source dashboard | Board |
|---|---|
| `uid`, `title`, `tags`, folder | kept (`uid` collision → suffix + report) |
| `schemaVersion` | Older dashboards are upgraded first by our port of the source format's documented schema migrations, to the extent covered by a fixture corpus. Unknown versions are flagged. |
| `panels[].gridPos` (24 columns) | 12-col grid: `x/2`, `w/2` rounded, with heights preserved in rows. `collapsed` rows become collapsible sections. |
| `panels[].type` | Mapped per the [05](../product/05-visualisation-catalogue.md) §11 table. Unknown plugin → Table of the same query + report. |
| `targets[]` with datasource `{type, uid}` | Prometheus/Loki/Tempo/Pyroscope-type datasources map to a tenant binding chosen in the import dialog. The query text is kept verbatim and parsed by our parsers, and parse failures are reported. Other datasource types are unmapped. |
| `fieldConfig.defaults/overrides`, `options` | Units, thresholds, mappings, overrides, links, legend and tooltip ([05](../product/05-visualisation-catalogue.md) §10) |
| `transformations[]` | Mapped by `id` to local-engine transforms; unknown → report |
| `templating.list` | `query`, `custom`, `constant`, `interval`, `textbox` and `datasource` (→ tenant binding picker) map to variables. `adhoc` maps to Context filters. Repeat options map to viewport repeat. |
| `annotations.list` | Change-feed overlays where the query is LogQL/PromQL; others reported |
| `links` | Board links (URL allowlist, [T18](T18-security.md) §4.5) |
| Canvas panel JSON | Schematic ([05](../product/05-visualisation-catalogue.md) §8). Element actions → *unmapped*, because raw HTTP calls are replaced with audited actions. |

**Existing alerting provisioning → rules, contact points, policies** ([07](../product/07-alerting.md)
§7–§8). Input is the file-provisioning YAML (`apiVersion: 1`; `groups`, `contactPoints`,
`policies`, `muteTimes`, `templates`) or the Alerting provisioning HTTP API export.
- **Rules:** each rule's `data[]` holds query nodes and server-side expression nodes (reduce, math,
  threshold, classic condition). Single-query + reduce + threshold chains collapse to our `query +
  condition`. Math across queries becomes a multi-query rule with an expression. Anything else is
  reported.
- `for`, `keep_firing_for`, `noDataState` and `execErrState` map to our NoData/Error policies
  ([07](../product/07-alerting.md) Table 3.2). Labels, annotations and `folderUID` → folder are kept.
- **Contact points** map 1:1 for every type available at import time ([07](../product/07-alerting.md)
  Table 7.1; v1 at M-UI4, v2 at M-UI5). Types not yet available are listed as unmapped (ALR-059).
  Secrets present in the export (often redacted) produce *"secret required"* placeholders that block
  activation until filled.
- **Policies** keep the tree as-is, including `group_by`, timings (an imported `group_wait: 30s` is
  kept, not replaced by Dash's default), `matchers`/`object_matchers`, `mute_time_intervals` and
  `continue`.
- **Templates:** Go templates are kept. Our renderer is Go-template-compatible
  ([T16](T16-alert-evaluator.md) §4.11), and functions with no equivalent are reported.
- **Imported rules start paused**, with a "backtest before enabling" prompt that uses the live
  backtest ([07](../product/07-alerting.md) §4).

### 4.11 Retention

#### T11-008 — Native time partitioning, retention by DROP
**MUST** — Every high-volume time-series table (§4.13, `audit_events`, `rule_eval_stats`,
`entities`, `entity_edges`) MUST be natively partitioned by time (`PARTITION BY RANGE`), and
retention MUST be enforced by detaching and dropping whole partitions, never by bulk `DELETE`.
Partition maintenance is Dash's own job (about 300 lines in `dash-store::partitions`), run by the
`worker` role under a `job_leases` lease; it MUST NOT depend on `pg_partman`, `pg_cron` or
TimescaleDB, which not every managed Postgres offers.

*Until that job exists (#61, 2026-11-20):* `audit_events` is the first partitioned table. The
`SECURITY DEFINER` function `pulsus_audit_partitions_maintain(months)` (owned by `pulsus_owner`,
`search_path = pg_catalog, pg_temp`, every name qualified, executable by `pulsus_app`, months 1–12)
creates the class-13 leaves `audit_events_r13_YYYY_MM` for the current UTC month and 3 months
ahead, and detaches and drops a leaf once its upper bound is more than 13 months old. `migrate`
calls it on every run, and `serve` at start and then every 24 h (1 h after a failure). Leaves are
validated, never trusted by name: a relation with a leaf's name that is not an ordinary table, a
direct child of `audit_events_r13`, owned by `pulsus_owner`, with exactly the month's bounds, fails
the call with `audit_partition_collision` (SQLSTATE `PD001`). Migration 2 revokes `CREATE` on
`public` from `PUBLIC`, `pulsus_app` and `pulsus_maint`; it, and every later `migrate`, fails with
`schema_create_grant` (SQLSTATE `PD002`) while any role other than `pulsus_owner` may create in
`public`.

#### T11-009 — Per-org retention through retention classes
**MUST** — Per-org retention MUST be implemented as **retention classes**: each derived-state table
is `PARTITION BY LIST (rclass)`, and each class is sub-partitioned `BY RANGE` on time. Every row is
stamped at insert with its org's current class for that domain (from `retention_policies`, cached
in `Db::tx`). Dropping a class's expired time partition enforces that class's retention for every
org in it.

```sql
CREATE TABLE retention_policies (org_id uuid, domain text, rclass smallint NOT NULL,
  changed_at timestamptz NOT NULL, PRIMARY KEY (org_id, domain));
  -- domain: alert_history | anomaly | pyramids | change_events | eval_health | audit

-- example: alert_transitions, class 13 (months), monthly sub-partitions
CREATE TABLE alert_transitions_r13 PARTITION OF alert_transitions
  FOR VALUES IN (13) PARTITION BY RANGE (at);
CREATE TABLE alert_transitions_r13_2026_11 PARTITION OF alert_transitions_r13
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
```

**Table 4.11a — Retention domains and classes**

| Domain | Tables | Partition grain | Classes offered | Default |
|---|---|---|---|---|
| `alert_history` | `alert_transitions`, `notification_deliveries` | Month | 3, 6, **13**, 25, 37 months | 13 months ([07](../product/07-alerting.md) ALR-084) |
| `anomaly` | `anomaly_scores`, `anomaly_baselines` | Day | 7, 14, **30**, 90 days | 30 days ([11](../product/11-enterprise.md) Table 6.2) |
| `pyramids` | `pyramid_tiles` | Day | 3, **7**, 14 days | 7 days, regenerated on demand |
| `change_events` | `entity_change_events` | Week | 30, **90**, 180, 400 days | 90 days |
| `eval_health` | `rule_eval_stats` | Day | **30**, 90 days | 30 days |
| `audit` | `audit_events` | Month | 3, 6, **13**, 25, 37, 61, 84 months | 13 months (org policy 3–84) |

Fixed classes keep the partition count bounded (worst case for one table: the sum of its classes'
periods, e.g. 84 monthly partitions for `alert_history`) regardless of org count; partitions are
created only for classes that at least one org uses.

#### T11-010 — Expired rows are invisible before they are dropped
**MUST** — A partition is dropped only when its whole range is older than its class's retention, so
up to one partition grain of expired rows can still exist on disk. The RLS policy of every
retention-managed table MUST therefore also filter on the org's **retention floor**
(`at >= pulsus_floor('<domain>')`, set by `Db::tx` to `now() − retention`), so the application
never sees a row older than the org's retention. An unset floor yields `NULL`, which hides every row
(fail closed).

```sql
CREATE POLICY org_isolation ON alert_transitions
  USING (org_id = pulsus_org() AND at >= pulsus_floor('alert_history'))
  WITH CHECK (org_id = pulsus_org());
```

**Changing an org's retention:**
- **Shorter:** new rows get the new class at once; the floor hides older rows at once; a purge job
  (`pulsus_maint`) deletes that org's rows older than the new retention from its previous classes
  in batches of 10k by primary-key prefix `(org_id, rclass, at)`, and is audited. This is the only
  `DELETE` on derived state, and it is bounded to one org.
- **Longer:** new rows get the new class; a background job moves the org's existing rows by
  `UPDATE … SET rclass = <new>` in batches (Postgres executes this as a cross-partition move),
  oldest first. Rows that had already expired under the old retention are gone; the admin UI says
  so.

#### T11-021 — Partitions exist ahead of time
**MUST** — The maintenance job MUST keep partitions created at least 2 grains ahead (7 days ahead
for daily tables) for every class in use, and there MUST be no `DEFAULT` partition. A horizon below
1 grain MUST raise a self-telemetry alert ([T19](T19-deployment.md) §4.10); an insert that finds no
partition fails loudly rather than landing in a catch-all.

*Audit partitions (#61, 2026-11-20):* until the self-telemetry exporter publishes the same state, the
low-horizon alert is the `/readyz` check `audit_partitions` plus the error record
`audit_partition_horizon_low`. The check is `unknown` before the first maintenance run; `error`
(503) after 3 consecutive failed runs or when the current month has no valid leaf; `low` (200)
after 1 or 2 failed runs or with a horizon of 0 or 1 month, below the 2 grains this rule requires;
otherwise `ok`. Operators alert on `audit_partitions != ok`.

**Table 4.11b — Retention of other tables**

| Table | Default retention | Mechanism |
|---|---|---|
| `entities`, `entity_edges` | 30 d after `last_seen_day` (EST-046) | Daily partitions, dropped |
| `alert_events` outbox | 7 d after consumption | Batched delete (small, unpartitioned) |
| `delivery_jobs`, `nflog` | Until done; `nflog` until `repeat_interval` + 1 d | Batched delete |
| `sessions`, `kiosk_pairings` | Expiry + 1 d | Batched delete |
| `*_versions` | All (or org policy) | Pruning job keeps head and tagged versions |
| Trash (`deleted_at`) | 30 d | Hard delete |
| `tool_call_log` payloads | 90 d (payload artefact); row 13 months | Artefact lifecycle (§4.15) |
| Investigations, incidents | Indefinite | — |

### 4.12 Backup/restore & HA

- **HA:** one primary + ≥ 1 synchronous standby, run with CloudNativePG or Patroni on Kubernetes,
  or a managed service (RDS/Aurora Multi-AZ, Cloud SQL HA, Azure Flexible Server). Dash needs only
  a single read-write endpoint. Read replicas are optional, for the audit viewer and import
  dry-runs.
- **Backups:** continuous WAL archiving + daily base backups (pgBackRest, or CNPG's Barman Cloud),
  35-day PITR. Targets: **RPO ≤ 5 min** with WAL shipping (≈ 0 with a synchronous standby for
  failover), **RTO ≤ 30 min** for a typical (< 50 GB) database. With derived state, the L profile
  database is ≈ 1 TB (§6.2), so its RTO is dominated by base-backup restore; L installs SHOULD use
  storage snapshots plus WAL replay (target RTO ≤ 60 min).
- **Key dependency:** `secrets` ciphertext is useless without the KEK ([T18](T18-security.md)
  §4.8). Backup runbooks must cover KEK availability. A restore drill without the KEK is a
  deliberate test case.
- **Logical export:** `pulsus-dash export --org <slug>` writes a YAML bundle of all versioned kinds
  plus identity metadata without secrets. It is used for org migration between cells and as an
  "escape hatch" backup. `import` is its inverse. Derived state is not part of the logical export;
  an org move copies it with `COPY … TO STDOUT (FORMAT binary)` per table, filtered by `org_id`.
- **Restore semantics:** after a PITR, alert instance state may be behind the last transition. On
  start, the evaluator reconciles `alert_instances` against the latest `alert_transitions` row per
  instance (same database, same snapshot) and then re-evaluates ([T16](T16-alert-evaluator.md)
  §4.3).

### 4.13 Dash-derived state (ADR-0012)

#### T11-007 — Derived state only in Postgres
**MUST** — Alert transitions, notification deliveries, anomaly baselines and scores, entity change
events and fallback pyramid tiles MUST be stored only in the tables of this section. No code path in
Dash MAY write them to PulsusDB ([ADR-0012](../adr/0012-derived-state-in-postgres.md)); the only
PulsusDB writes are self-telemetry and the optional audit export ([T19](T19-deployment.md) §4.10).

All tables in this section are `PARTITION BY LIST (rclass)` with `BY RANGE` time sub-partitions
(§4.11), under the floor-filtered RLS policy of T11-010, and are written only by fenced jobs
(T11-011).

#### 4.13.1 `alert_transitions`

One row per state transition **or flag change** (ack, unack, silence on/off, maintenance on/off,
flapping on/off) of an alert instance. Each row closes the interval that began at `from_since`, so
a state-over-time query is an interval-overlap scan with no look-back.

```sql
CREATE TABLE alert_transitions (
  org_id uuid NOT NULL, rclass smallint NOT NULL, at timestamptz NOT NULL, id uuid NOT NULL,  -- UUIDv7
  rule_id uuid NOT NULL, rule_version int NOT NULL, labels_hash bytea NOT NULL,
  kind text NOT NULL CHECK (kind IN ('state','flag')),
  from_state text, to_state text NOT NULL,          -- Table 3.2 names of 07
  from_since timestamptz NOT NULL,                  -- start of the interval this row closes
  flags_before smallint NOT NULL, flags_after smallint NOT NULL,
  active_at timestamptz,                            -- Pending start (ALERTS_FOR_STATE value)
  value double precision, threshold double precision, severity text NOT NULL,
  entity_id uuid, tenant_binding_id uuid NOT NULL, incident_id uuid,
  actor_kind text, actor_id uuid,                   -- for ack / silence / maintenance changes
  labels jsonb NOT NULL, fencing bigint NOT NULL,
  PRIMARY KEY (org_id, rclass, at, id)
) PARTITION BY LIST (rclass);                        -- each class: RANGE (at), monthly
CREATE INDEX ON alert_transitions (org_id, rule_id, labels_hash, at);       -- instance / rule history
CREATE INDEX ON alert_transitions (org_id, incident_id, at) WHERE incident_id IS NOT NULL;
CREATE INDEX ON alert_transitions (org_id, entity_id, at);                  -- Lens, viewport bands, scope filter
CREATE INDEX ON alert_transitions (org_id, from_since);                     -- interval overlap (§5.3)
```

Row size ≈ 1 KB including `labels` and index entries (the ADR-0012 reference figure).

#### 4.13.2 `notification_deliveries`

One row per delivery **attempt**, plus one row per routing **decision** that suppressed a
notification (muted, silenced, inhibited, coalesced into a digest), so per-alert notification
status and the routing Sankey are computed from one table.

```sql
CREATE TABLE notification_deliveries (
  org_id uuid NOT NULL, rclass smallint NOT NULL, at timestamptz NOT NULL, id uuid NOT NULL,
  incident_id uuid, rule_id uuid, labels_hash bytea, group_key bytea NOT NULL,
  route_id text NOT NULL, route_path text[] NOT NULL,          -- Sankey (ALR-071)
  contact_point_id uuid, integration_idx smallint, integration_kind text,
  attempt smallint NOT NULL,                                   -- 0 for decision rows
  status text NOT NULL CHECK (status IN ('delivered','retrying','failed','rate_limited',
                                         'coalesced','muted','silenced','inhibited','test')),
  reason text,                                                 -- e.g. 'mute timing weekends'
  response_code int, response_excerpt text,                    -- ≤ 512 B, redacted
  latency_ms int, payload_hash bytea, error text, fencing bigint NOT NULL,
  PRIMARY KEY (org_id, rclass, at, id)
) PARTITION BY LIST (rclass);                                  -- each class: RANGE (at), monthly
CREATE INDEX ON notification_deliveries (org_id, contact_point_id, at);     -- health, "Last 7 d"
CREATE INDEX ON notification_deliveries (org_id, incident_id, at) WHERE incident_id IS NOT NULL;
CREATE INDEX ON notification_deliveries (org_id, rule_id, labels_hash, at);
```

Row size ≈ 0.5 KB. Same retention domain as transitions (ALR-084).

#### 4.13.3 `anomaly_scores` and `anomaly_baselines`

The anomaly sweep (a per-tenant [T06](T06-bff-architecture.md) job, every 30 s) keeps scores in memory and persists them at
**5-minute resolution** (the maximum score in each 5-minute bucket, so peaks survive). To avoid
per-point rows and update churn, closed hours are written once as immutable **hour blocks**; the
open hour lives in a small upserted table.

```sql
CREATE TABLE anomaly_scores (                       -- immutable hour blocks
  org_id uuid NOT NULL, rclass smallint NOT NULL, hour timestamptz NOT NULL,
  tenant_binding_id uuid NOT NULL, entity_id uuid NOT NULL, signal smallint NOT NULL,  -- signal dictionary
  scores real[] NOT NULL CHECK (cardinality(scores) = 12),    -- 5-min slots; NaN = not computed
  model_version int NOT NULL, fencing bigint NOT NULL,
  PRIMARY KEY (org_id, rclass, hour, entity_id, signal)
) PARTITION BY LIST (rclass);                                  -- each class: RANGE (hour), daily
CREATE INDEX ON anomaly_scores (org_id, entity_id, signal, hour);

CREATE TABLE anomaly_scores_open (                  -- current hour, upserted every 5 min
  org_id uuid, tenant_binding_id uuid, entity_id uuid, signal smallint, hour timestamptz,
  scores real[] NOT NULL, fencing bigint NOT NULL,
  PRIMARY KEY (org_id, entity_id, signal)) WITH (fillfactor = 50);

CREATE TABLE anomaly_baselines (                    -- one fitted model per entity × signal × day
  org_id uuid NOT NULL, rclass smallint NOT NULL, valid_from timestamptz NOT NULL,
  tenant_binding_id uuid NOT NULL, entity_id uuid NOT NULL, signal smallint NOT NULL,
  model_version int NOT NULL, trained_window tstzrange NOT NULL,
  profile bytea NOT NULL,          -- Arrow IPC, zstd: weekly profile at 5-min slots (expected) + hourly scale
  fencing bigint NOT NULL,
  PRIMARY KEY (org_id, rclass, valid_from, entity_id, signal)
) PARTITION BY LIST (rclass);                                  -- each class: RANGE (valid_from), daily
CREATE INDEX ON anomaly_baselines (org_id, entity_id, signal, valid_from);
```

- At hour close, the sweep owner inserts the hour block and deletes the `anomaly_scores_open` row in
  one fenced transaction. The `pulsus_anomaly_score` virtual source reads both (§5.3).
- Baselines are refit hourly in memory and **persisted at most every 6 h** (a new row per day, then
  replaced in place only when the fit drifts beyond tolerance), so "as of then" re-runs (AI-015)
  and score explanations use the baseline that was active at that time.

#### 4.13.4 `entity_change_events`

Changes that **Dash derives**: version transitions (R8 fallback), executed actions
([T18](T18-security.md) §4.7), detected new log patterns and error types, scaling and failover
inferred from inventory. Changes that arrive as customer telemetry stay in PulsusDB and are only
read. Both are merged by the change feed ([T12](T12-entity-catalogue.md)).

```sql
CREATE TABLE entity_change_events (
  org_id uuid NOT NULL, rclass smallint NOT NULL, at timestamptz NOT NULL, id uuid NOT NULL,
  tenant_binding_id uuid NOT NULL, entity_id uuid, entity_key text NOT NULL,
  kind text NOT NULL,              -- version | config | flag | scale | failover | pattern_new | error_new | action
  summary text NOT NULL, before jsonb, after jsonb, author text, ref_url text,
  source text NOT NULL,            -- derived | action
  dedup_key bytea NOT NULL, fencing bigint NOT NULL,
  PRIMARY KEY (org_id, rclass, at, id)
) PARTITION BY LIST (rclass);                                  -- each class: RANGE (at), weekly
CREATE INDEX ON entity_change_events (org_id, entity_id, at);
CREATE UNIQUE INDEX ON entity_change_events (org_id, rclass, at, dedup_key);   -- idempotent re-derivation
```

#### 4.13.5 `pyramid_tiles`

Fallback health pyramids for when PulsusDB cannot serve rollups (R4 absent): compressed Arrow tiles,
one row per entity × signal × level × tile, retained 7 days **after build** and regenerated on
demand. Partitioning is on `built_at`, so a coarse tile for an old window is not dropped the moment
it is built.

```sql
CREATE TABLE pyramid_tiles (
  org_id uuid NOT NULL, rclass smallint NOT NULL, built_at timestamptz NOT NULL, id uuid NOT NULL,
  tenant_binding_id uuid NOT NULL, entity_id uuid NOT NULL, signal smallint NOT NULL,
  level smallint NOT NULL,                     -- 60 | 720 | 7200 | 86400 s (PulsusDB lattice; 10 s live is not stored)
  tile_start timestamptz NOT NULL, buckets smallint NOT NULL,   -- 240 buckets per tile
  complete bool NOT NULL,                      -- false for the tile containing now
  arrow bytea NOT NULL,                        -- Arrow IPC record batch, zstd; schema per signal (T04)
  schema_version int NOT NULL, fencing bigint NOT NULL,
  PRIMARY KEY (org_id, rclass, built_at, id)
) PARTITION BY LIST (rclass);                  -- each class: RANGE (built_at), daily
CREATE INDEX ON pyramid_tiles (org_id, tenant_binding_id, entity_id, signal, level, tile_start, built_at);
ALTER TABLE pyramid_tiles ALTER COLUMN arrow SET STORAGE EXTERNAL;   -- already compressed: no TOAST recompression
```

A lookup takes the newest `built_at` per `(entity, signal, level, tile_start)`; rebuilding a tile
inserts a new row, and the superseded one expires with its partition.

### 4.14 Interaction with the virtual query sources

The planner ([T07](T07-scene-query-planner.md)) resolves the reserved selectors against these
tables and never sends them to PulsusDB. The read contracts T11 guarantees indexes for:

| Selector | Tables | Access path |
|---|---|---|
| `ALERTS`, `ALERTS_FOR_STATE` | `alert_instances` (open intervals) ∪ `alert_transitions` (closed intervals) | `at >= start AND from_since <= end`, by `(org_id, from_since)` / `(org_id, rule_id, labels_hash, at)` |
| `pulsus_anomaly_score` | `anomaly_scores` ∪ `anomaly_scores_open` | `(org_id, entity_id, signal, hour)` |
| `{source="pulsus-dash", kind="alert_transition"}` | `alert_transitions` | `(org_id, rclass, at)` keyset |
| `{source="pulsus-dash", kind="notification_attempt"}` | `notification_deliveries` | `(org_id, rclass, at)` keyset |
| `{source="pulsus-dash", kind="entity_change"}` | `entity_change_events` | `(org_id, rclass, at)` / `(org_id, entity_id, at)` |

Label names and PromQL semantics are fixed in [T16](T16-alert-evaluator.md) §4.7.

### 4.15 Large artefacts

#### T11-018 — Object storage is optional
**MUST** — Large immutable artefacts (evidence snapshots, flight-recorder segments, AI tool-call
payloads, rendered chart images, import uploads, vis modules, detached audit partitions) MUST be
referenced through `artefacts`. With object storage configured
([ADR-0009](../adr/0009-optional-object-storage.md)) the bytes go to the bucket; without it they
MUST go to `lo_blobs` in Postgres, with the tighter default retention below, and reopen identically.

```sql
CREATE TABLE artefacts (org_id uuid, id uuid, kind text, sha256 bytea NOT NULL, bytes bigint,
  store text NOT NULL CHECK (store IN ('object','postgres')), object_key text,
  expires_at timestamptz, created_at timestamptz, PRIMARY KEY (org_id, id));
CREATE TABLE lo_blobs (org_id uuid, artefact_id uuid, chunk int, data bytea NOT NULL,
  PRIMARY KEY (org_id, artefact_id, chunk));       -- 1 MiB chunks; bytea, not pg_largeobject (RLS-able)
```

`bytea` chunks are used rather than `pg_largeobject` because large objects cannot be put under
RLS. Without object storage, flight-recorder segments default to 30 days and chart images to 7
days.

## 5. Interfaces

### 5.1 Crates and APIs

- `internal/store` package *(revised 2026-11-19, ADR-0015)*: per-domain repositories (`BoardRepo`,
  `RuleRepo`, `HistoryRepo`, `DerivedRepo`, …) over `pgxpool.Pool` and the sqlc queries. All take
  an `OrgTx`, a transaction with `pulsus.org_id` and the retention floors set.

#### T11-023 — The repository is the only SQL path
**MUST** — `internal/store` MUST be the only package that issues SQL; other packages depend on its
repository interfaces. `depguard` bans `pgx` and the sqlc output outside `internal/store`.

- REST: `/api/dash/v1/{kind}` CRUD with `If-Match`; `/api/dash/v1/{kind}/{uid}/versions`,
  `/versions/{a}/diff/{b}`, `/versions/{n}/restore`; `/api/dash/v1/import/*`;
  `/api/dash/v1/export`; `/api/dash/v1/admin/retention` (per-domain class). The OpenAPI document
  `api/openapi.yaml` is written first and the server is generated from it (ADR-0015).

### 5.2 Cross-doc ownership

- **T10 (draft)** owns the semantics of the identity tables (§4.2).
- **[T12](T12-entity-catalogue.md)** owns `entity_schema`, `entity_overrides`, `entities`, `entity_edges`,
  `catalogue_snapshots`, `entity_change_events` and `label_mappings`.
- **T13 (draft)** owns `pyramid_tiles` content and the anomaly model inside `anomaly_baselines`.
- **T14 (draft)** owns `layout_positions`.
- **T15 (draft)** owns `ai_*`, `incident_embeddings` and `evidence` producer semantics.
- **[T16](T16-alert-evaluator.md)** owns `alert_*`, `notification_*`, `nflog`, `delivery_jobs`,
  `silences`, `maintenance_windows`, `mute_timings`, `escalation_*`, `rule_eval_stats`,
  `noise_reports`, and its lease tables (`rule_shard_leases`, `dispatch_leases`,
  `evaluator_members`).
- **[T06](T06-bff-architecture.md)** owns the generic `job_leases` and `members` shapes.
- **T17 (draft)** owns `timeline_events`, `participants` and `recordings`, plus its own
  `collab_ops` (op log, monthly partitions), `text_docs` (yrs state), `recorder_chunks` (hot
  flight-recorder segments), `collab_room_leases` and short links. DDL for those is T17's to add
  here, following §4.0 and §4.11.
- **[T18](T18-security.md)** owns `secrets`, `data_keys`, `actions`, `action_definitions` and
  `vis_modules`.

Owners may add columns and indexes. Changing a primary key, the `org_id` convention, the RLS
template or the retention-class scheme needs a change here.

Assumed from [T06](T06-bff-architecture.md): one `PgPool` per replica (default 20 connections,
configurable); PgBouncer in transaction mode is supported because we use only
`set_config(..., true)`.

### 5.3 Virtual-source read contracts

- **State at time t** (ALR-021 replay): for each instance, the open interval in `alert_instances`
  with `state_since <= t`, else the `alert_transitions` row with `from_since <= t < at`. One query:
  `SELECT … FROM alert_transitions WHERE org_id=$1 AND at > $t AND from_since <= $t` ∪ open rows.
- **Range** `[s, e]`: closed intervals `at >= s AND from_since <= e`, plus open intervals with
  `state_since <= e`; the BFF turns intervals into step series at the query step.
- **Event streams**: keyset pagination on `(at, id)`, newest first, page size ≤ 10 000, returned as
  Arrow ([T04](T04-wire-format-and-data-plane.md)).

## 6. Data & storage

### 6.1 Where things live

| Store | Holds |
|---|---|
| Postgres | Everything in §4, including all Dash-derived state |
| Object storage (optional; S3/GCS/Azure/MinIO) | Bytes of `artefacts` when configured; detached audit partitions (optional archive) |
| PulsusDB | Customer telemetry (read only). Dash writes only its self-telemetry and, if configured, the audit export |
| Redis (optional) | Session cache, pub/sub fan-out. Never authoritative |

**Object map** (IA-001 schema review):

| Object ([02](../product/02-information-architecture.md) §2) | Table(s) |
|---|---|
| Entity | `entities`, `entity_edges`, `catalogue_snapshots` (derived); `entity_overrides` (user) |
| Context | Inside `board_versions.spec`, `investigations.context`, `evidence.params`, `waypoints.context` |
| Scene / Viewport | `board_versions.spec`, `lens_template_versions.spec` |
| Lens / Edge Lens | `lens_templates`, `lens_overrides` |
| Board | `boards`, `board_versions`, `folders` |
| Investigation | `investigations`, `evidence`, `hypotheses`, `timeline_events`, `participants`, `recordings`; payloads via `artefacts` |
| Waypoint | `waypoints` |
| Alert rule | `alert_rules`, `alert_rule_versions`; state `alert_instances`; history §4.13.1–§4.13.2 |
| Journey | `journeys`, `journey_versions` |
| Perspective | `perspectives`, `perspective_versions` |
| Incident | `incidents`, `incident_alerts`, `org_sequences` |
| Change | `entity_change_events` (Dash-derived); ingested changes read from PulsusDB |
| Annotation / Event | `annotations`; alert transitions and changes via the event stream (§4.14) |

### 6.2 Size estimates for derived state

Assumptions (to be validated by `bench:pg-derived-state` before GA): 0.5 transitions (state or
flag) per alert instance per day; 0.5 delivery rows per transition; 4 health signals per entity;
baseline profile ≈ 5 KB compressed; 6.6 pyramid tiles built per entity × signal per day (1 m and
12 m levels) at ≈ 4 KB; 2 Dash-derived change events per entity per day at ≈ 0.6 KB. Profiles are
those of [T19](T19-deployment.md) §4.7.

**Table 6.2 — Derived-state volume at default retention** (data + indexes)

| Table | Formula | S (5k inst., 2k ent.) | M (50k inst., 10k ent.) | L (500k inst., 50k ent.) |
|---|---|---|---|---|
| `alert_transitions` (13 mo) | inst × 0.5/d × 395 d × 1 KB | 1 GB | 10 GB | 100 GB |
| `notification_deliveries` (13 mo) | transitions × 0.5 × 0.5 KB | 0.25 GB | 2.5 GB | 25 GB |
| `anomaly_scores` (30 d) | ent × 4 × 24 h-blocks/d × 30 × 200 B | 1.2 GB | 5.8 GB | 29 GB |
| `anomaly_baselines` (30 d) | ent × 4 × 30 × 5 KB | 1.2 GB | 6 GB | 30 GB |
| `pyramid_tiles` (7 d, only if R4 absent) | ent × 4 × 6.6/d × 7 × 4 KB | 1.5 GB | 7.4 GB | 37 GB |
| `entity_change_events` (90 d) | ent × 2/d × 90 × 0.6 KB | 0.2 GB | 1.1 GB | 5.4 GB |
| `rule_eval_stats` (30 d) | rules × 24 × 30 × 120 B | < 0.1 GB | 0.2 GB | 1.7 GB |
| **Derived state total** | | **≈ 5.5 GB** | **≈ 33 GB** | **≈ 228 GB** |
| Config, content, audit (13 mo), investigations | | ≈ 3 GB | ≈ 15 GB | ≈ 60 GB |
| **With 1.5× headroom** (bloat, WAL, one extra partition per class) | | **≈ 13 GB** | **≈ 72 GB** | **≈ 430 GB** |

Content can dominate for a large org: 10k boards × 50 versions × 20 KB ≈ 10 GB. Specs are
TOAST-compressed with `lz4`. [T19](T19-deployment.md) §4.7 turns these figures into disk sizing.

## 7. Performance budget

| Operation | p99 target | Note |
|---|---|---|
| Load board head (spec ≤ 1 MB) | 15 ms | One PK lookup on head + version |
| Save board version | 30 ms | Insert + head update + audit, one transaction |
| Library search (10k boards/org) | 50 ms | Built-in `tsvector` GIN; `pg_trgm` if present |
| Alert instance batch upsert (5k rows) | 150 ms | Per shard per cycle |
| Transition insert batch (1k rows) | 50 ms | Same transaction as instance upsert and outbox |
| `ALERTS` range read, 24 h, 5k instances | 100 ms | Interval overlap (§5.3), pruned to 1–2 monthly partitions |
| Transition explorer page (10k rows of 10⁶) | 150 ms | Keyset on `(org_id, rclass, at)` |
| Contact-point Sankey, 7 d | 200 ms | Aggregate on `(org_id, contact_point_id, at)`; cached 60 s |
| `pulsus_anomaly_score`, 1 entity × 30 d | 30 ms | 720 hour blocks |
| Pyramid tile fetch, 100 tiles | 40 ms | One index range per entity × signal × level |
| Audit filter (actor + action) over 10⁴ events | 50 ms | Composite indexes |
| Partition drop | < 1 s | Metadata only; `DETACH … CONCURRENTLY` first |
| Version diff (two 1 MB specs) | 40 ms | In the BFF, not SQL |

Write load at L: transitions ≈ 3/s average; anomaly open-hour upserts ≈ 670/s (200k series every
5 min), hour blocks ≈ 55/s; alert instance upserts ≤ 1.7k/s at 50k instances per 30 s, changes only.

## 8. Security, tenancy & RBAC

Row-level isolation and RLS are covered in §4.1, and authorisation checks happen in the repository
layer's callers (T10 (draft)), with list filtering in SQL (T11-024). Derived-state rows carry
`tenant_binding_id` and `entity_id`, so the BFF can apply data scopes (ENT-006) to alert history,
anomaly scores and change events exactly as to telemetry; derived state has no path around the
scope filter because it is only reachable through the virtual sources. The audit table is
append-only for the app role. Secrets are envelope-encrypted with AAD that binds `(org_id, table,
row, field)`, so ciphertext moved between rows fails to decrypt. Exports exclude secrets.

## 9. Failure modes & degradation

| Failure | Effect |
|---|---|
| Primary failover (≈ 30 s) | API writes return 503 with retry-after. The UI shows "saving paused" and retries with the same `If-Match`. Reads are served from cache where possible. The evaluator keeps evaluating from in-memory state, cannot notify (no outbox), and flushes on recovery. |
| Migration fails mid-way | goose records per-migration success, and the runner is re-entrant. Old replicas keep serving because the changes are expand-only. |
| Partition horizon exhausted | Inserts into that table fail loudly; self-telemetry alert at < 1 grain (T11-021). The evaluator keeps state in memory and retries the history write. |
| Retention purge or class move interrupted | Both are cursor-driven and idempotent; the floor already hides expired rows. |
| Disk pressure from derived state | Pyramid tiles are dropped first (regenerable); the admin sees which domain is largest per org. |
| Git provider down | `pull`: stale with a badge. `pr`: saves queue as pending PRs. |
| Import partial | Nothing is committed until the user accepts the dry-run report. Commit is one transaction per object. |
| Object store down | New artefacts fall back to `lo_blobs` if enabled; reads of object-stored artefacts show "snapshot unavailable". |

## 10. Testing

- Migration tests: apply all migrations to an empty database and to a snapshot of each previous
  release's schema. Run release N−1's repository tests against schema N (`itest:migration-compat-n-1`).
- `itest:no-extensions`: the full suite on a vanilla Postgres 15 with `pg_available_extensions`
  emptied of non-core entries.
- `itest:rls-isolation`: every repository function under the wrong org returns zero rows; direct
  `SELECT` on every table and every partition as `pulsus_app` with another org's context returns
  zero rows or a privilege error (T11-026).
- `itest:retention-drop`: 14 months of synthetic transitions → after maintenance, partitions older
  than 13 months are gone and nothing older than 13 months is visible; same for each domain.
- `itest:retention-class-change`: shorten and lengthen an org's class; verify floor, purge and
  move.
- `itest:no-pulsusdb-writes`: storyboard and RCA replay runs against a PulsusDB proxy that records
  writes; only self-telemetry and the configured audit export appear.
- `ci:squawk-migrations` on every migration.
- Importer golden corpus: about 300 public dashboards in the common open dashboard JSON format across schema versions, plus alerting
  exports. Reports are snapshot-tested (`itest:dashboard-import-corpus`).
- Round-trip: export → import → export yields byte-identical canonical YAML (`itest:yaml-roundtrip`).
- `bench:pg-derived-state`: L-profile synthetic load for 24 h; asserts §7 and the §6.2 sizes.
- `drill:pitr-restore`: PITR to a new cluster, verify audit chain, secrets with the KEK, and
  evaluator reconciliation.

## 11. Rollout

| Milestone | Scope |
|---|---|
| M-UI1 | `orgs`, `tenant_bindings`, `install_state`, `user_preferences`, `saved_views`, `folders`, `boards` and `board_versions` (minimal Boards, #48), `audit_events` (config only), migration runner, RLS template, partition maintenance framework |
| M-UI2–3 | Entities tables, `layout_positions`, `waypoints`, lens templates (versioned), `entity_change_events`, `anomaly_*`, `pyramid_tiles` |
| M-UI4 | Alerting domain incl. `alert_transitions` and `notification_deliveries`, investigations/evidence, incidents, AI tables, `actions`, `secrets`, `artefacts` |
| M-UI5 | Boards versions UI, diff and restore, legacy dashboard import, playlists, schematics, `noise_reports` |
| M-UI6 | Identity tables with authentication (D12), Git sync, Terraform provider, data scopes, kiosks, audit hash chain and data-access audit, per-org retention classes in the admin UI |

## 12. Alternatives considered

- **Schema-per-tenant / database-per-tenant:** see §4.1. Dedicated cells cover the extreme cases.
- **Event-sourced config:** an append-only event log with projections. Rejected: versions tables
  already give history, and event sourcing complicates every query and import.
- **Storing specs normalised (viewports as rows).** Rejected: specs are read and written whole,
  Git/Terraform want documents, and JSONB with schema-versioned upcasters is simpler.
- **`refinery` / `diesel` migrations:** see §4.8.
- **Alert instance state in Redis:** not durable enough to be authoritative
  ([07](../product/07-alerting.md) §10 requires surviving restart).
- **Per-org partitions** (`LIST (org_id)` then time) for exact per-org retention: 10⁴ orgs ×
  13 monthly partitions is 1.3 × 10⁵ partitions per table, beyond what the planner and catalogue
  handle well. Retention classes give per-org retention with a bounded partition count.
- **Bulk `DELETE` for per-org retention:** violates ADR-0012's drop-partition rule and bloats the
  heap.
- **TimescaleDB hypertables / compression:** attractive for scores, but ENT-020 and ADR-0012 forbid
  depending on an extension.
- **Writing derived series into PulsusDB** (ADR-0010): rejected by the product owner
  (ADR-0012).

## 13. Open questions

1. Should `layout_positions` be per user as well as per org (personal spatial memory)? Leaning: org
   default plus a per-user offset table later.
2. pgvector dimension is fixed per column. Support for multiple embedding models needs one
   generated column per model. T15 (draft) to decide; the portable `real[]` column is always kept.
3. How far back do we port the source format's dashboard `schemaVersion` migrations? This depends on the age
   of design partners' dashboards.
4. Are the retention class lattices of Table 4.11a acceptable to the product owner, given that
   [11](../product/11-enterprise.md) Table 6.2 says "configurable" without values?
5. Size assumptions in §6.2 (0.5 transitions per instance per day) need confirmation from design
   partners' Alertmanager history.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft; ADR-0012 derived-state tables added; formal design rules; Satisfies table |
| 1.0-rc | 2026-11-19 | Roadmap D5 ([12](../product/12-roadmap.md#21-delivery-order-2026-11-19) §2.1): §11 `folders`, `boards` and `board_versions` move M-UI5 → M-UI1; versions UI, diff and restore stay M-UI5 |

**Changes versus the draft:**
1. **Derived state in Postgres (ADR-0012).** The draft's non-goal "alert transitions and long-term
   delivery logs go to PulsusDB" is removed. `alert_transitions_hot` (30 d) becomes
   `alert_transitions` (13 months, monthly); the draft's `notification_log` (30 d, daily) becomes
   `notification_deliveries` (13 months, monthly) and now also records suppression decisions; the
   Alertmanager-style dedup log is a separate `nflog`. New: `anomaly_scores`,
   `anomaly_scores_open`, `anomaly_baselines`, `pyramid_tiles`; `change_events` is renamed
   `entity_change_events` (weekly partitions). The store table in §6.1 no longer lists PulsusDB as a
   history store.
2. **No required extensions (ENT-020, T11-001).** The draft required `pgcrypto`, `ltree`,
   `btree_gist`, `citext` and `pg_trgm`. These are replaced by core features (text paths,
   `lower(email)` index, B-tree silence index, built-in `tsvector`); `pgvector` and `pg_trgm` are
   optional accelerators. `incident_embeddings` keeps a portable `real[]` column.
3. **Per-org retention by dropping partitions** (ENT-020, ALR-084): retention classes (T11-009) and
   the RLS retention floor (T11-010) are new; the draft had one global retention per table.
4. **RLS completeness.** `sessions` was exempt from RLS in the draft; ENT-020's acceptance covers
   every table, so pre-auth lookups move to `SECURITY DEFINER` functions (T11-027) and partitions
   are made unreachable directly (T11-026).
5. **Product alignment:** `users.totp_secret_ref` removed, because MFA is the IdP's (ENT-011); evidence producer `human` → `user` plus `external` (AI-014); waypoints get
   team visibility (IA-008); `org_sequences` for `INC-n`/`INV-n` (IA-009); `ai_feedback` carries
   engine version and model id (AI-054); `kiosk_pairings`, `identity_links`, `rule_routes`,
   `rule_eval_stats`, `noise_reports`, `escalation_*`, `inhibition_rules`, `annotations` and
   `artefacts`/`lo_blobs` (ENT-021 fallback) added.
6. **Restore semantics:** reconciliation after PITR uses `alert_transitions` in Postgres, not the
   PulsusDB copy, which no longer exists.
7. The Terraform-in-Go question is closed as Proposed ADR-0011 (tracked under O2), so it is no
   longer an open question here.
| 1.1-rc | 2026-11-19 | [ADR-0015](../adr/0015-go-bff.md): migrations by `goose` and repositories on `pgx` + `sqlc` (§4.8, T11-013, T11-015); `internal/store` replaces `dash-store` (§5.1, T11-023); Rust-specific mentions made language-neutral; OpenAPI spec first |
| 1.2-rc | 2026-11-20 | #59 Part A and D12 (authentication deferred to M-UI6): header milestones and §11 move the identity tables from M-UI1 to M-UI6; §4.2 notes that `orgs` and `tenant_bindings` ship first; §3 ENT-020 row marks the #59 subset (ENT-020 stays M-UI1); `tenant_bindings.credentials_ref` becomes `text`, a secret reference (`env:NAME` or `file:/path`; `secret:<uuid>` with the `secrets` table) under a CHECK, never a value; §4.1 adds the roles script and the non-tenant `install_state`; T11-002 note on the root table `orgs` |
| 1.3-rc | 2026-11-20 | #61 Part A (migration 2): §3 ENT-020 row adds the board tables, `audit_events` and its partitions; §4.3 notes the boards subset (no `tags`, `search`, `managed_by`, `incident_open_count`; `bigint` columns; no `lz4`), the `stars` and `recent_views` DDL and the root folder; §4.7 adds `audit_chain_heads` (the chain head outside the retention floor) and T11-017 reads the previous hash from it; T11-008, T11-021 and T11-026 note the audit partition function owned by `pulsus_owner` until the worker job exists (3 months ahead, drop after 13 months, leaf validation, `REVOKE CREATE ON SCHEMA public`), and the `/readyz` check `audit_partitions` as the low-horizon alert |
