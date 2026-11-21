# T06 — BFF service architecture: the `pulsus-dash` server

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.6-rc · 2026-11-21 |
| **Milestone** | M-UI1 (gateway, planner host, PulsusDB client, L1 cache, self-telemetry) → M-UI3 (split roles, Redis L2, workers, leases) → M-UI4 (evaluator, notifier, ai roles, HA) → M-UI6 (OIDC auth, multi-tenant quotas UI, audit export) |
| **Related ADRs** | [ADR-0015](../adr/0015-go-bff.md) (supersedes ADR-0001 for the server), [ADR-0014](../adr/0014-typescript-react-web-client.md), [ADR-0005](../adr/0005-arrow-wire-format.md), [ADR-0006](../adr/0006-pulsusdb-and-postgres.md), [ADR-0008](../adr/0008-dash-alert-evaluator.md), [ADR-0012](../adr/0012-derived-state-in-postgres.md), [ADR-0013](../adr/0013-metrics-data-scopes.md), [ADR-0018](../adr/0018-query-language-modules.md), [ADR-0021](../adr/0021-query-planning-is-server-side.md) |
| **Source draft** | plans/tech/T06-bff-architecture.md (not tracked) |

## 0. Applicability under ADR-0015 (2026-11-19)

The BFF is Go ([ADR-0015](../adr/0015-go-bff.md)). Module responsibilities, rules, routes, the
error envelope and the budgets of this document stand. Rust specifics map as follows:

| Was (Rust) | Now (Go, under `server/`) |
|---|---|
| Cargo workspace, `server/crates/*`, shared ⇄ crates | One Go module; `internal/<module>` per crate below (`dash-` prefix dropped: `internal/core`, `internal/store`, `internal/gateway`, `internal/pulsusdb`, …); shared logic is per language, tied by fixtures (ADR-0015) |
| Service traits (`#[async_trait] trait Catalogue`) held as `Arc<dyn Trait>` | Go interfaces in `internal/core/services.go`, implemented in-process or by an internal-API stub |
| `RequestCtx` with `CancellationToken` and `Deadline` | `core.RequestCtx` passed explicitly as `*core.RequestCtx` beside a `context.Context` that carries cancellation and the deadline |
| `axum`, `tower` layers | `net/http` + `chi` middleware; server stubs from `oapi-codegen` |
| `sqlx`, migrations | `pgx/v5` + `sqlc`; `goose` ([T11](T11-postgres-schema.md) §4.8) |
| `moka` L1 cache | `ristretto` (cost-weighted TinyLFU) |
| JSON → Arrow converter (`simd-json` tape, Arrow builders) | Streaming `encoding/json` decoder into Arrow Go builders; until the engine lands, JSON frames to the browser ([ADR-0014](../adr/0014-typescript-react-web-client.md) §5) |
| `cargo-deny` bans | `depguard` rules in golangci-lint |
| `bincode` internal API | JSON over HTTP/2 with mTLS (T06-027 revised) |
| `utoipa` OpenAPI | spec-first `api/openapi.yaml` |

## 1. Context & problem

[T01](T01-frontend-architecture.md) sketches one Go process ([ADR-0015](../adr/0015-go-bff.md)) between the browser and PulsusDB.
It converts JSON to Arrow, enforces RBAC, plans per scene, and hosts the entity, change, alert and AI
services. The product specification pushes several hard requirements onto that process:

- **Nothing waits on the network that could have been pre-computed.** The Alert Lens opens in
  < 300 ms because the RCA card, mini-Atlas and First Light are ready before the responder clicks
  ([13](../product/13-core-flow-storyboard.md), SCN-008). That needs background workers running
  continuously: the anomaly sweep, the change feed and RCA stage 1.
- **Aggressive cancellation must not flood ClickHouse** (PRF-030, [R11](pulsusdb-requirements.md)).
- **Data scope is enforced server-side, for humans and agents alike** ([11 §3.2](../product/11-enterprise.md),
  [06](../product/06-ai-copilot.md)).
- **HA from stateless replicas, plus singleton jobs that are leader-elected** (ENT-029).
- **One deployment fronts several PulsusDB clusters and tenants** (ENT-027).
- **Dash-derived state lives in PostgreSQL**, never in PulsusDB (decision D2,
  [ADR-0012](../adr/0012-derived-state-in-postgres.md)). Dash writes to PulsusDB only its own
  self-telemetry and, when configured, the audit export.

This document fixes the crate layout, the process roles, the PulsusDB client, caching, scaling,
tenancy, backpressure, self-observability, configuration, the authentication plumbing (M-UI6, D12),
and the external API surface. Two components get their own documents: the scene planner
([T07](T07-scene-query-planner.md)) and the alert evaluator ([T16](T16-alert-evaluator.md)).

## 2. Goals / non-goals

**Goals**
- One binary (`pulsus-dash`) with role flags. A laptop runs `--role all`; an enterprise runs
  separately scaled api, worker, evaluator, notifier and ai pools from the same image.
- Every PulsusDB call goes through **one client** that applies tenancy, scope, deadlines, retries,
  concurrency limits and telemetry. No module builds its own HTTP request to PulsusDB.
- Every Postgres access goes through **one store crate** (`dash-store`) that applies the tenant
  binding for row-level security.
- Module boundaries are explicit Go interfaces, so in-process and remote (worker) placement are
  interchangeable without callers changing.
- The p50 BFF overhead (excluding PulsusDB time) is ≤ 5 ms per physical query, and the JSON→Arrow
  conversion (until R1) is ≤ 30 ms per 10⁶ points per core (§7).
- The identity subset (OIDC login, sessions, built-in roles), delivered at M-UI6 (D12), is defined
  here, because T10 (draft) is not yet promoted (blocked on O1). Until then every request runs as a
  fixed local principal of the bootstrap org (§4.11); tenant binding is M-UI1.

**Non-goals**
- Arrow schemas and the browser framing protocol. [T04](T04-wire-format-and-data-plane.md) owns
  them; this document consumes them.
- The Postgres schema ([T11](T11-postgres-schema.md)), full identity flows (SAML, SCIM, token
  scopes) and data-scope semantics (T10 (draft)), evaluator semantics ([T16](T16-alert-evaluator.md)),
  RCA logic (T15 (draft)), packaging and Helm ([T19](T19-deployment.md)).
- Being a general query federation layer. v1 talks to PulsusDB, plus Prometheus-API read-only
  sources later (PRN-012). Postgres-backed virtual sources (§4.12, [T07](T07-scene-query-planner.md))
  are Dash's own state, not a federated datasource.

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [PRN-012](../product/01-vision-and-principles.md#prn-012--observability-signals-only-not-general-bi) | §4.3, §4.13, T06-025 | `itest:datasource-types`: the datasource API accepts only `pulsusdb` (and, once enabled, `prometheus-api` read-only); any other type is refused with `invalid` |
| [IA-001](../product/02-information-architecture.md#ia-001--object-vocabulary-and-persistence) | §4.8, §6, T06-017, T06-016 | `itest:no-pulsusdb-writes`: full storyboard run against seeded PulsusDB with an ingest proxy; the only writes observed are self-telemetry to the self tenant and the configured audit export |
| [AUD-041](../product/01a-audiences-and-perspectives.md#aud-041--show-data-trust) | §4.3 (Completeness, data age) | `itest:completeness-trailer`: seeded `truncated=true` and gapped responses produce a trailer with `truncated`, `data_age_ms` and gap ranges, forwarded to the viewport |
| [VIZ-027](../product/05-visualisation-catalogue.md#viz-027--coverage-meter-on-every-viewport) | §4.3 (Completeness) | `itest:completeness-trailer` (as above), plus `itest:422-narrow-hint` |
| [PRF-026](../product/09-performance-contract.md#prf-026--show-cached-marked-stale) | §4.4 (tile keys shared with IndexedDB) | `prop:resultkey-tiles`: browser and BFF derive identical tile boundaries for the same query; `e2e:reopen-cached-hatched` (T04 co-owns) |
| [PRF-030](../product/09-performance-contract.md#prf-030--cancel-superseded-requests) | §4.3 (cancellation), T06-010 | `itest:planner-cancel`: 10 window changes in 1 s against seeded PulsusDB give 9 stream resets on the PulsusDB side (`499` count) and 1 completed query |
| [PRF-031](../product/09-performance-contract.md#prf-031--truncation-honesty) | §4.3 (retries, `422`), §5.2 | `itest:422-narrow-hint`: a seeded too-broad query returns `too_broad` with a machine-readable `hint`; a `truncated` service-graph response sets `Completeness.truncated` |
| [ENT-001](../product/11-enterprise.md#ent-001--organisations-teams-and-users) | §4.11 (Principal: org, teams) | `itest:auth-principal`: a user in two teams resolves to a Principal carrying both team ids; "My teams" listing returns resources of either |
| [ENT-003](../product/11-enterprise.md#ent-003--built-in-roles) | §4.11, T06-023 | `itest:rbac-builtin-roles`: route-permission matrix test, one request per (built-in role × mutating route); Viewer ack refused with `forbidden` + `request_access` link |
| [ENT-011](../product/11-enterprise.md#ent-011--oidc-sso-with-idp-enforced-mfa) | §4.11, T06-022 | `itest:oidc-login`: against a test IdP (Dex/Keycloak) requiring MFA, login succeeds only through the IdP flow; `acr`/`amr` are recorded on the session; Dash exposes no second-factor endpoint |
| [ENT-020](../product/11-enterprise.md#ent-020--configuration-and-derived-state-in-postgres) | §4.8, §6, T06-016 | `itest:rls-tenant-isolation` (T11 co-owns): a tenant-A session through `dash-store` returns no tenant-B row from any table |
| [ENT-027](../product/11-enterprise.md#ent-027--one-deployment-many-pulsusdb-tenants) | §4.7, T06-006 | `itest:multi-tenant-headers`: fuzzed queries for an org bound to two databases; every outbound request carries the bound `X-Pulsus-Database` / `X-Scope-OrgID`; switching tenant switches the header |
| [ENT-028](../product/11-enterprise.md#ent-028--single-binary-static-assets-helm) | §4.2, T06-003 | `ci:single-binary`: the release build produces one `pulsus-dash` binary plus static assets; `e2e:helm-default-shell` (T19 co-owns): the default install serves the application shell with no redirect to a login page |
| [SRF-063](../product/04-surfaces.md#srf-063--admin-rooms) | §4.11, §5.1 (datasource bindings, OIDC), T06-025 | `itest:datasource-binding`: binding a seeded PulsusDB runs the `runtimeinfo` check and stores the binding; a wrong URL is refused with a positioned field error |
| [ENT-029](../product/11-enterprise.md#ent-029--high-availability) | §4.5, §4.6, T06-015 | `sim:lease-fencing` (turmoil: partitions, clock skew, paused processes) and `load:kill-replica` (3 replicas, one killed mid-evaluation: no missed interval, no duplicate notification) |
| [ENT-017](../product/11-enterprise.md#ent-017--append-only-audit-log) | §4.2 (audit sink), §8, T06-004 | `itest:audit-append-only`: config edit, ack and AI tool call appear in `audit_events`; UPDATE/DELETE by the application role fail |
| [ALR-084](../product/07-alerting.md#alr-084--alert-history-in-postgres) | §4.8, T06-017 | `itest:no-pulsusdb-writes` (as above) during the alerting suite |
| [ALR-086](../product/07-alerting.md#alr-086--prometheus-compatible-read-api-for-history) | §5.1 (Prometheus-compatible read API) | `itest:prom-read-alerts`: Prometheus-API `query_range` for `ALERTS{alertstate="firing"}` equals the series a Dash viewport receives |
| [ALR-087](../product/07-alerting.md#alr-087--alerting-survives-without-pulsusdb-ingest) | §4.8, T06-017 | `itest:alerting-no-ingest`: the alerting suite passes with the PulsusDB ingest endpoint returning `403` for Dash |
| [ENT-006](../product/11-enterprise.md#ent-006--scoped-users-see-no-out-of-scope-data) | §4.1 (`RequestCtx.scope`), §4.3 (the authority on the final query), §8, T06-002, T06-029 | `prop:scope-proof`: every outbound PulsusDB request in the fuzz corpus carries a `ScopeProof`; `itest:scope-paths` (T10 (draft) co-owns); `itest:plan-authority`: a request whose `query` is already the planned text of another request still goes through `Plan`, and the query sent upstream equals that request's own `planned.query` |
| [AI-048](../product/06-ai-copilot.md#ai-048--mcp-server) | §5.1 (`/mcp` mount), §4.10 (ExternalAgent class), §8 | `itest:mcp-scoped-budgeted`: an MCP call with a team-scoped token returns only in-scope entities, is charged to the ExternalAgent budget and is audited |
| [PRF-013](../product/09-performance-contract.md#prf-013--rca-stage-1-ready) | §4.6 (stage-1 job scheduling), §7 | `load:rca-stage1-lag`: `dash_job_lag_seconds{job="rca1"}` p99 ≤ 1 s on the replay corpus (T15 (draft) co-owns the 10 s target) |
| [EST-046](../product/15-estate-navigation.md#est-046--entity-graph-cache-and-ephemeral-history) | §4.6 (catalogue refresh job, 60 s) | `itest:catalogue-refresh-60s`: a new seeded pod appears in the snapshot within 60 s ([T12](T12-entity-catalogue.md) co-owns) |

## 4. Design

### 4.1 Package layout and module boundaries

*(Revised 2026-11-19, [ADR-0015](../adr/0015-go-bff.md).)*

```
api/openapi.yaml                 the HTTP contract (spec first); Go and TS code generated from it
wire/schemas/, wire/fixtures/    language-neutral Arrow schemas and golden IPC fixtures (T04)
server/                          one Go module
├─ cmd/pulsus-dash               main(): config → role selection → module wiring → http.Server
├─ migrations/                   goose SQL migrations, embedded (T11 §4.8)
├─ queries/                      sqlc query files; sqlc.yaml
└─ internal/
   ├─ core                       TenantCtx, Principal, RequestCtx, Priority, error types, ids, service interfaces
   ├─ config                     layered config (§4.9), reload channel
   ├─ telemetry                  slog + OTel SDK wiring, metrics, self-tenant exporter (§4.8)
   ├─ pulsusdb                   THE PulsusDB client (§4.3): typed endpoints, JSON frames / Arrow, limits, retries
   ├─ pulsusfake                 recorded-transcript fake of PulsusDB for tests and the dev stack (T05)
   ├─ cache                      L1 ristretto, L2 Redis adapter, singleflight (§4.4)
   ├─ gateway                    chi router, generated server, REST CRUD, data plane, WS session, static assets
   ├─ planner, vsrc              scene planner (T07); Postgres-backed virtual sources (T07 §4.11)
   ├─ catalogue, changefeed, health, compare     T12, change feed, baselines and pyramids, Compare
   ├─ alerting, notify, ai       T16 evaluator, routing and delivery; T15 (draft)
   ├─ auth                       OIDC sessions, authz (§4.11)
   ├─ audit                      append-only audit sink
   ├─ store                      pgx + sqlc repositories, migration runner, LISTEN/NOTIFY bus (T11)
   └─ jobs                       leases, leader election, scheduler (§4.6)
```

Packages are created by the issue that first needs them.

#### T06-001 — Dependency rule
**MUST** — *(Revised 2026-11-19, ADR-0015.)* Feature packages depend only on `internal/core`,
`internal/pulsusdb`, `internal/cache`, `internal/store` and the interfaces of their peers, never on
a peer's implementation package. `internal/gateway` is the only package that imports an HTTP router
or the generated server. The rule is enforced by `depguard` in golangci-lint.

Every module exposes a service interface (the Rust sketch below is kept for its field list; the
Go form is in §0). A service can be backed by the in-process implementation or by a remote stub that calls a worker over the
internal API (§5.4).

```rust
// dash-core: the request context every call carries
pub struct RequestCtx {
    pub tenant: TenantCtx,          // Dash org + resolved datasource (§4.7)
    pub principal: Principal,       // user | service account | ai_agent{on_behalf_of, investigation}
    pub scope: Arc<DataScope>,      // compiled by dash-auth (§4.11, T10 (draft)); never optional
    pub deadline: Deadline,         // absolute; propagated to PulsusDB `timeout`
    pub priority: Priority,         // Interactive | Alerting | Refine | Prefetch | Agent | ExternalAgent | Background
    pub budget: BudgetHandle,       // T07 §4.8; charged by pulsusdb-client and dash-vsrc
    pub trace: opentelemetry::Context,
    pub cancel: CancellationToken,  // tokio-util; child tokens per physical query
}

#[async_trait] pub trait Catalogue   { async fn resolve(&self, cx: &RequestCtx, q: EntityQuery) -> Result<EntitySet>; /* … */ }
#[async_trait] pub trait ChangeFeed  { async fn changes(&self, cx: &RequestCtx, w: TimeWindow, e: &EntitySet) -> Result<Vec<Change>>; }
#[async_trait] pub trait Baselines   { async fn expected(&self, cx: &RequestCtx, s: SignalRef, w: TimeWindow) -> Result<BandSeries>;
                                       async fn anomalies(&self, cx: &RequestCtx, w: TimeWindow) -> Result<AnomalyIndex>; }
#[async_trait] pub trait Compare     { async fn compare(&self, cx: &RequestCtx, req: CompareRequest) -> Result<CompareStream>; }
#[async_trait] pub trait Planner     { async fn plan(&self, cx: &RequestCtx, req: ScenePlanRequest) -> Result<PlanSession>; }
#[async_trait] pub trait VirtualSource { async fn eval(&self, cx: &RequestCtx, q: VirtualQuery) -> Result<ResultStream>; } // T07 §4.11
#[async_trait] pub trait Orchestrator{ async fn start_rca(&self, cx: &RequestCtx, inc: IncidentId) -> Result<RcaRunId>; /* T15 (draft) */ }
pub trait ScopeRewriter: Send + Sync {   // thin wrapper over T10 (draft) `pulsus-dash-scope`
    fn rewrite(&self, scope: &DataScope, sig: Signal, text: &str) -> Result<Rewritten, ScopeError>;   // scope::rewrite
    fn filter_response(&self, scope: &DataScope, batch: RecordBatch) -> Result<RecordBatch>;           // scope::filter_response
}
pub trait AuditSink: Send + Sync     { fn record(&self, ev: AuditEvent); } // non-blocking, bounded channel
```

#### T06-002 — Every data call carries a scoped `RequestCtx`
**MUST** — Every method of `pulsusdb-client`, `dash-vsrc` and every feature service MUST take
`&RequestCtx`, whose `scope` is non-optional. There MUST be no "system" bypass on interactive routes.
Background jobs run as per-tenant service principals whose scope is the full tenant, and results they
produce for display (anomaly index, pyramids) are filtered by the viewer's scope at read time.

### 4.2 Process roles: in-process vs separately scalable

```
                       ┌──────────────────── L7 load balancer (sticky by session cookie for WS) ─────────────┐
 browser ─HTTP/2+WS──► │  role=api  ×N (stateless, autoscaled on CPU + in-flight queries)                    │
                       │   gateway · auth · planner · virtual sources · catalogue(read) · compare · AI chat/MCP │
                       └───────┬─────────────────────────────┬──────────────────────────────┬────────────────┘
                               │ pulsusdb-client             │ internal API (gRPC-less:      │ Postgres (dash-store)
                               ▼                             │ HTTP/2 + bincode, §5.4)       ▼
                        PulsusDB clusters ◄──────────────────┼──── role=worker ×M ─── dash-jobs leases
                         (reads; writes only                 │      catalogue refresh, change feed, anomaly
                          self-telemetry +                   │      sweep, baselines, fallback pyramid builder
                          optional audit export)             │
                               ├──── role=evaluator ×K ──────┤      (sharded, T16)
                               ├──── role=notifier ×J ───────┤      (delivery queue in Postgres, T16)
                               └──── role=ai ×A ─────────────┘      (RCA stage 1/2 runs, model calls, T15 (draft))
```

| Module | Placement | Why |
|---|---|---|
| Gateway, auth, planner, virtual sources, interactive compare | **api**, in-process | On the interactive critical path. An extra hop costs latency, and these are CPU-light apart from JSON→Arrow and BFF joins, which scale with api replicas |
| Catalogue (read path) | **api**, in-process, reads a snapshot | Resolving `{{entity}}` and Atlas inventory must be < 5 ms. Snapshots are built by the worker and published through Redis/Postgres (§4.4) |
| Catalogue refresh, change feed, anomaly sweep, baselines, fallback pyramid builder | **worker**, singleton or sharded jobs | Periodic fleet-wide sweeps (60 s refresh, EST-046). They must run once per tenant, not once per replica. Their output is written to Postgres (ADR-0012) |
| Alert evaluator | **evaluator**, sharded by rule hash | Its correctness and load profile are independent of UI traffic ([ADR-0008](../adr/0008-dash-alert-evaluator.md), [T16](T16-alert-evaluator.md)) |
| Notification delivery | **notifier** | Slow external endpoints and retry storms must not affect UI latency |
| AI orchestrator: stage-1 causal engine, stage-2 agent | **ai** (stage 1 can also run on worker) | Long-running (90 s), high memory, with model-provider rate limits. Interactive copilot chat stays on api and calls `ai` for heavy runs |
| Audit | in-process sink in every role → Postgres batch insert, plus optional OTLP export | Must never block a request (T06-004) |

With `--role all`, every module runs in one process, and the job leases (§4.6) still work, so a
two-replica small install is HA without extra configuration.

#### T06-003 — One binary, role flags
**MUST** — Dash MUST ship as a single `pulsus-dash` binary plus static WASM assets. Process roles
(`all | api | worker | evaluator | notifier | ai`) MUST be selected by configuration, never by
separate builds, and `--role all` MUST be a complete, supported deployment.

#### T06-004 — The audit sink never blocks
**MUST** — `AuditSink::record` MUST be non-blocking (bounded channel). On overflow the event MUST be
spilled to a local append-only file and `dash_audit_spill_total` raised; it MUST NOT be dropped
silently. Audit rows are append-only: the application role has INSERT but not UPDATE or DELETE on
`audit_events` (T11).

*Note (#61, 2026-11-20):* configuration-change audit rows (boards first) are written inside the
save transaction, so that a version and its audit event commit or roll back together (T11-006).
The non-blocking sink applies to events outside a content transaction, and lands with its first
producer.

### 4.3 The PulsusDB client (`pulsusdb-client`)

```
server/internal/pulsusdb/            core: Client, decoration chain (T06-005), tenant header and slots
                                     (T06-006), retry budget and deadlines (T06-009, T06-010), limits,
                                     redaction, decoder seam (JSON; Arrow under r1_arrow_accept, T06-011)
server/internal/pulsusdb/prom/       QueryRange, Query, Series, Labels, LabelValues, Metadata, TSDBStatus,
                                     Plan (substitution, rate rewrite, size limits; ADR-0021)
server/internal/pulsusdb/logs/       LogQueryRange, LogVolume, LogLabels, LogLabelValues, LogSeries, Patterns,
                                     DetectedLabels, DetectedFields, Tail,
                                     Plan (substitution, size limits, volume template)
server/internal/pulsusdb/traces/     Search, Fetch, Tags, TagValues, MetricsRange, ServiceGraph
server/internal/pulsusdb/profiles/   Merge, SelectSeries, Diff, Types, Labels, LabelValues
```

Each module has its routes, request shaping, decoders and `testdata/` fixtures. `rules_*` and
`RuntimeInfo` stay in the core.

Planning is part of the module ([ADR-0021](../adr/0021-query-planning-is-server-side.md)).
`prom.Plan` and `logs.Plan` are pure functions over the inputs and the metric types. The gateway
and the evaluator call them, then hand the planned text to the core. Fixtures:
`wire/fixtures/plan/<lang>.json`.

Return contracts (T06-011). No method returns untyped JSON values.

| Methods | Return |
|---|---|
| `prom` `QueryRange`, `Query`; the `resultType: matrix` branch of `LogQueryRange` (streamed when `resultType` precedes `result`) | `ResultStream` (streamed metric results) |
| `LogQueryRange` | `*LogResult`: a `*LogPage` (`resultType: streams`, typed streams and entries) or a `ResultStream` (`resultType: matrix`). The matrix branch streams only when `resultType` precedes `result` in the response; when `result` comes first, the response is buffered |
| `LogVolume` | `[]*Series` with its `Completeness`, one aggregated series per level |
| `Series`, `LogSeries` | `*SeriesResult` |
| `Labels`, `LabelValues`, `LogLabels`, `LogLabelValues` | `*ValuesResult` |
| `Metadata` | `*MetadataResult` |
| `RuntimeInfo` | `*RuntimeInfo` |

The completion and metadata results are typed and fully decoded. Three cases are buffered: the log
page, the log volume, and a `LogQueryRange` response whose `result` comes before `resultType`. T06-011
sets the bounds for all three when the LogQL client lands (#65).

#### T06-005 — One PulsusDB client
**MUST** — Every request from Dash to PulsusDB MUST be made through `pulsusdb-client`. No other crate
MAY construct an HTTP request to a PulsusDB endpoint; `depguard` bans `net/http` client use in feature
packages other than `internal/pulsusdb`, `internal/notify` (external endpoints), `internal/ai` (model
providers), `internal/auth` (IdP calls through the egress guard) and `internal/telemetry` (self-export, §4.8).

*Note (ADR-0018, 2026-11-21):* "`internal/pulsusdb`" means the core package only; the language
modules use no `net/http` client.

**Request decoration (applied in one `tower` layer stack, in this order):**

| Layer | Behaviour | PulsusDB reference |
|---|---|---|
| `TenantLayer` | Sets `X-Scope-OrgID` from `TenantCtx.datasource.org_id`. If the value is empty or absent, the header is omitted for the single-tenant datasource; PulsusDB rejects an empty value with `400` | api.md "Request headers" |
| `DatabaseLayer` | Sets `X-Pulsus-Database` when the datasource names an alternate ClickHouse database | same |
| `AuthLayer` | Basic auth from the datasource secret (`PULSUS_AUTH_USER` pair); secrets resolved through [T18](T18-security.md)'s secret provider | api.md "Authorization" |
| `ScopeLayer` | Asserts that the query was rewritten (carries a `ScopeProof`, T07 §4.7): debug builds panic, release builds refuse the request and count `dash_scope_proof_missing_total`. Once [R12](pulsusdb-requirements.md) lands, it adds the trusted scope header | R12 |
| `VirtualGuardLayer` | Refuses any request whose query text contains a reserved virtual selector (`ALERTS`, `ALERTS_FOR_STATE`, `pulsus_anomaly_score`, `source="pulsus-dash"`); counts `dash_virtual_leak_total` (T07-020) | ADR-0012 |
| `DeadlineLayer` | Sends PromQL `timeout=` as the remaining deadline minus 100 ms (only effective when strictly shorter than `PULSUS_QUERY_TIMEOUT`, default `2m`). Sets a client-side timer as well | api.md §3.1 |
| `ExplainLayer` | Adds `X-Pulsus-Explain: 1` **only** for (a) a user-requested plan explain and (b) a 1 % calibration sample (T06-007) | api.md §3.2, §3.6 |
| `ConcurrencyLayer` | Adaptive limiter per (cluster, priority class), §4.10 | — |
| `RetryLayer` | Below (T06-009) | — |
| `TraceLayer` | Client span `pulsusdb.<route>` with `pulsus.query_id`, `pulsus.read_cache`, bytes, rows, status. Injects W3C `traceparent` (PulsusDB reading it is **unverified**, harmless if ignored) | api.md "Response headers" |

#### T06-006 — Tenant decoration on every request
**MUST** — `TenantLayer` and `DatabaseLayer` MUST derive `X-Scope-OrgID` and `X-Pulsus-Database`
only from the `TenantCtx` resolved for the request (§4.7), never from client-supplied headers or
query parameters.

#### T06-007 — Explain is on demand or sampled
**MUST** — `X-Pulsus-Explain` MUST be sent only for a user-requested explain and for the calibration
sample (default 1 %, `explain_sample_ratio`), because explain requests bypass PulsusDB's read cache.

**`X-Pulsus-Query-Id` flows upward, not downward.** PulsusDB generates it per request and returns it
on every response, errors included. It also tags every ClickHouse statement with it as `log_comment`.
Dash cannot set it.

#### T06-008 — Query ids are captured end to end
**MUST** — The client MUST record `X-Pulsus-Query-Id` on the client span, in the data-access audit
event, in the physical-query node of the plan explain (T07 §4.10) and in the completeness trailer sent
to the browser. `X-Pulsus-Read-Cache` and `-Through` MUST be captured the same way. An operator can
then go from a slow viewport to `system.query_log` in one copy-paste.

**Retries.** Only for read routes, and only within the remaining deadline:

| Outcome | Retry? |
|---|---|
| Connection refused or reset before response headers; `503` with metrics `errorType: unavailable`, or the logs/traces "unavailable" equivalents | Yes, up to 2 more attempts, decorrelated jitter 50–400 ms |
| `503 timeout` / `504` (deadline), `422` (too broad / memory), `400`, `401` | No. `422` surfaces as truncation honesty with a "narrow" hint (PRF-031) |
| `429` | No retry on the interactive path; background priorities back off for `Retry-After` |

#### T06-009 — Bounded retries, no hedging
**MUST** — Retries MUST be limited to read routes, to the outcomes in the table above, and to the
remaining deadline. A per-cluster **retry budget** (token bucket: retries ≤ 10 % of requests over
10 s) MUST cap retries so that they cannot amplify an outage. Requests MUST NOT be hedged in v1: it
doubles ClickHouse load, and PulsusDB already spreads reads across replicas.

**Cancellation (R11).** Each physical query owns a child `CancellationToken`. Cancelling it drops the
hyper future. On HTTP/2 that is an `RST_STREAM`; on HTTP/1.1 the connection is closed and removed
from the pool. Whether PulsusDB then cancels the underlying ClickHouse statements is the subject of
[R11](pulsusdb-requirements.md) and is not yet verified.

#### T06-010 — Cancellation and tight deadlines
**MUST** — Cancelling a physical query MUST drop its in-flight request within one scheduler tick, so
the transport sends `RST_STREAM` (HTTP/2) or closes the connection (HTTP/1.1). Until R11 is verified:
1. the planner coalesces and debounces (T07 §4.6), so a supersede storm turns into at most one
   in-flight query per (viewport, pass);
2. every query MUST carry a `timeout` no longer than its priority's deadline (Interactive 10 s,
   Refine 20 s, Background 60 s), so an orphaned statement dies at that deadline, not at
   `PULSUS_QUERY_TIMEOUT`;
3. a query that has delivered > 80 % of its expected batches is allowed to finish and fill the cache
   rather than being cancelled (T07-010).

**Connections.** HTTP/1.1 keep-alive pool by default. HTTP/2 is used where TLS ALPN negotiates `h2`.
Prior-knowledge h2c is a config switch that is off until PulsusDB's support for it is verified. Pool
size per (api replica, cluster) is 64 by default. This interacts with PulsusDB's own limits
(`PULSUS_CH_POOL_SIZE` 8 per process, `PULSUS_QUERY_EVAL_CONCURRENCY` 256), which the operator sizes
together with the number of Dash replicas ([T19](T19-deployment.md)).

**JSON→Arrow (until R1).** Streaming `simd-json`-style tape parsing straight into Arrow builders
(`Int64Builder` timestamps, `Float64Builder` values, dictionary-encoded labels). The JSON is never
materialised as a DOM. Prometheus string values are parsed with `lexical-core`. Each series becomes
a record batch, flushed at 64k rows, so the browser starts painting before PulsusDB's body ends. When
R1 is negotiated (`Accept`), the converter is bypassed and batches pass through, re-chunked if
necessary.

#### T06-011 — Results are Arrow streams
**MUST** — Client methods MUST return `ResultStream` (record batches plus a `Completeness` trailer),
never untyped JSON values. *(2026-11-19, ADR-0014 §5: until the chart engine lands, the gateway
serialises the batches as JSON frames for the TS client; the batch type is Arrow Go throughout.)* Until R1, the converter MUST stream: the first batch MUST leave
the BFF ≤ 10 ms after PulsusDB's first byte, and batches MUST be flushed at ≤ 64k rows.
*(2026-11-21, ADR-0018.)* The completion and metadata methods (series, label names, label values,
metadata, runtime info) return typed, fully decoded results (§4.3), never untyped JSON values. They
carry no record batches, so the streaming bounds above do not apply to them.

**Completeness (R10 fallback).** Each typed method extracts what its endpoint offers into one struct:

```rust
pub struct Completeness {
    pub truncated: bool,                 // service_graph.truncated, "results truncated due to limit", 422s
    pub exactness: Exactness,            // RawExact | Rollup{level_s} | Predicted{level_s} (T07 §4.3) | Sampled{ratio} | Windowed | Virtual
    pub source: SourceKind,              // PulsusDb{cluster} | Virtual{table} (T07 §4.11) | Cache{tier, age_ms}
    pub data_age_ms: Option<u64>,        // now − newest sample; drives the freshness indicator (AUD-041)
    pub warnings: Vec<String>,           // PromQL warnings/infos verbatim
    pub withheld: Vec<WithheldFamily>,   // metric families failed closed by scope (T07-015, ENT-007)
    pub approximation: Option<MsgKey>,   // fallback in use (R2/R5/R6/R9), shown in the coverage meter
    pub query_id: Option<QueryId>,       // X-Pulsus-Query-Id
    pub read_cache: Option<ReadCache>,   // hit/miss/bypass + through_ms
    pub rows_read: Option<u64>,          // only when explain/R10 supplies it
}
```

#### T06-028 — Language modules are isolated
**MUST** — A package under `internal/pulsusdb/<lang>` MUST NOT import another language module, and
`internal/pulsusdb` MUST NOT import any of them. Only the core may construct an HTTP request to
PulsusDB. A module MUST send the request shapes recorded in its fixtures. Enforced by `depguard`.
Test: `unit:pulsusdb-shapes` per module.

#### T06-029 — The server builds the final query
**MUST** — This rule covers the language query paths ADR-0021 decides: the PromQL query routes
and the evaluator's PromQL queries now, and the LogQL query routes once `logs.Plan` lands. On these
paths, every query sent to PulsusDB MUST be built by the server from the request's raw inputs. The
language module's `Plan` produces the **planned text** (`planned.query`). The only change after it is
the scope rewrite (T07-014), which produces the **final text** that is sent. No such route accepts a
pre-planned text. The order is: inputs checked, substitute, plan, reserved-name guard, scope, send.
The scope rewrite therefore applies after every substitution and rewrite the user controls. In v1
the scope rewrite is the identity for an unrestricted principal and refuses a restricted one
(T07 §0), so the final text equals `planned.query`. Test: `itest:plan-authority` (a request whose
`query` is already the planned text of another request still goes through `Plan`, and the query
sent upstream equals that request's own `planned.query`).

### 4.4 Caching tiers

```
 browser IndexedDB (T04) ─► L1 in-process (per api replica) ─► L2 Redis (optional, shared) ─► PulsusDB read cache (per PulsusDB process, §3.2 api.md) ─► ClickHouse
```

| Tier | Holds | Implementation | Size / TTL |
|---|---|---|---|
| **Singleflight** | In-flight physical queries | `DashMap<ResultKey, Shared<…>>`. A second subscriber attaches to the running stream and replays the batches buffered so far | Lives as long as the query |
| **L1 results** | Arrow tiles of query results (PulsusDB and virtual) | `moka::future::Cache` (W-TinyLFU), weighed by bytes | 512 MiB per replica by default |
| **L1 metadata** | Label values, series counts, metric metadata, catalogue snapshot, runtimeinfo (`rollupLevels`), per-family label sets for scope checks | moka | 30–60 s TTL |
| **L1 metric types** | prom metric types per tenant binding (a tenant with two PulsusDB bindings gets two entries); used by `prom.Plan` (ADR-0021) | moka, keyed by tenant binding; singleflight per tenant binding | 60 s TTL |
| **L2 results** | The same tiles, shared across replicas | Redis 7 (or Valkey), `SET` with zstd-compressed Arrow IPC, `PX` TTL | Operator-sized. Off on small installs |
| **L2 snapshots** | Catalogue graph and anomaly index published by workers | Redis key + Postgres `snapshots` row (`LISTEN/NOTIFY` on version bump) | Versioned |

**Read-through result tiles.** Each query result is split into **time tiles** whose boundaries are
aligned to the epoch. Tile width = `step × 1024`, so tiles cut cleanly at step boundaries. Key:

```rust
pub struct ResultKey {
    tenant: TenantId, datasource: DatasourceId,  // or DatasourceId::Virtual for Postgres-backed sources
    physical_hash: [u8; 16],   // xxh3-128 of the *scope-rewritten, normalised* physical query (T07 §4.2)
    scope_fp: ScopeFp,         // T07 §4.7
    step_ms: u64, tile_start_ms: i64,
    level: RollupLevel,        // predicted level (T07 §4.3), so a level change is a different key
    lookback_ms: Option<u64>,
}
```

#### T06-012 — Cache keys are scope-rewritten, never per user
**MUST** — Every cross-session cache entry and singleflight key MUST be derived from the
scope-rewritten, normalised physical query plus `tenant` and `scope_fp`. Two principals with
different data scopes MUST never share an entry; two principals with the same scope SHOULD share,
which is what makes a NOC wall with 50 viewers cheap. Cache keys MUST NOT include the user id.

#### T06-013 — Immutability horizon
**MUST** — A result tile MUST be treated as immutable only once `tile_end < now − horizon(level)`,
where the horizon is the larger of 4 minutes, PulsusDB's own read-cache keep rule, and the level's
build lag (≤ 270 s at 1 m, 16 min at 12 m, 2 h 5 min at 2 h, 24 h 6 min at 1 d; api.md §3.6
Freshness). Immutable tiles get a 24 h TTL. The head tile gets `TTL = max(step, 10 s)` and is
refreshed by delta (only the newest points). Virtual-source tiles use a horizon of twice the
evaluation interval of the slowest rule in the tenant (alert history is append-only).

- Aligning `start` to a multiple of `step` (T07 §4.3) also gives PulsusDB's read cache a stable grid,
  so cache hits compound across both layers.
- Late data: Dash accepts the same late-sample semantics PulsusDB documents for its read cache. A
  "refresh exact" action in the explain view bypasses L1/L2 for one plan.
- The browser IndexedDB tier (T04) uses the same `ResultKey` tile boundaries, so a re-opened view is
  painted from IndexedDB as stale (PRF-026) and only missing tiles are planned (T07 §4.5).

#### T06-014 — Redis is never authoritative
**MUST** — Redis (L2) MUST hold only re-derivable data. Losing it MUST cost hit rate, not
correctness; every read path MUST work with Redis absent.

### 4.5 Horizontal scaling and HA

- **api** replicas are stateless apart from caches. The WS session is sticky (cookie affinity) so its
  plan session and singleflight stay local. If an api replica dies, the browser reconnects and
  resends its scene state (T04 owns the resume handshake), which re-plans with L2/IndexedDB warm.
- **Autoscaling signals:** api uses CPU and `dash_planner_inflight_physical`; worker uses job lag;
  evaluator uses evaluation lag (T16); ai uses queue depth.
- **Postgres** HA is external (Patroni or a managed service). Dash degrades to read-only for config
  when Postgres is unreachable: reads come from an L1 snapshot, writes return `503`, and the UI banner
  is defined in [T08](T08-dom-component-kit.md). Virtual sources (T07 §4.11) return
  `unavailable`, and their viewports show the coverage note "alert history unavailable".
- **Redis** is optional and never authoritative (T06-014).

### 4.6 Leader election and singleton jobs (`dash-jobs`)

Leases live in Postgres, which Dash requires anyway. There is no etcd or ZooKeeper.

```sql
-- owned by T11; shape defined here
CREATE TABLE job_leases (
  job_key      text PRIMARY KEY,      -- e.g. 'catalogue.refresh/{tenant}', 'eval.shard/17'
  holder       uuid NOT NULL,         -- process instance id
  fencing      bigint NOT NULL,       -- monotonically increasing on every acquisition
  expires_at   timestamptz NOT NULL
);
CREATE TABLE members (instance uuid PRIMARY KEY, roles text[], heartbeat timestamptz, version text);
```

- **Acquire/renew:** `UPDATE … SET holder=$me, fencing=fencing+1, expires_at=now()+'15s' WHERE job_key=$k AND (expires_at < now() OR holder=$me) RETURNING fencing`.
  Renew every 5 s; the lease lasts 15 s.
- **Sharded jobs** (alert evaluation, per-tenant sweeps) use rendezvous hashing of `job_key` over
  live `members` with the role. Each member takes only the leases it owns, and rebalancing on
  membership change is minimal. T16 builds on this primitive.
- **Singleton jobs per tenant:** catalogue refresh (60 s), change-feed sweep (60 s), anomaly sweep
  (30 s; scores written to Postgres at 5-minute resolution, ADR-0012), fallback pyramid builder (per
  level cadence, only while R4 is absent; tiles to Postgres, T07 §4.12), baseline recompute (hourly),
  RCA stage-1 kick-off (event-driven from T16 transitions), audit export.

#### T06-015 — Leases with fencing tokens
**MUST** — Singleton and sharded jobs MUST hold a Postgres lease. Every side-effecting write a job
makes (alert state, catalogue snapshot version, anomaly scores, pyramid tiles, notification claim)
MUST carry its fencing token, and the write MUST be rejected if a newer token for that `job_key` has
been seen. A lost lease MUST be taken over by another member within 15 s.

### 4.7 Multi-tenancy

```
 Dash org ──1:N──► datasource { cluster_url, database?, org_id?, credentials_ref, rollup_ranges?, limits }
    │                              │
    └─ users/teams/roles/scopes    └─► X-Scope-OrgID / X-Pulsus-Database on every request
```

- A **Dash org** maps to one or more **datasources**. Each datasource is a (PulsusDB cluster,
  database, tenant) triple. One deployment can front several clusters (ENT-027). Scenes are bound to
  one datasource. Cross-datasource scenes are out of scope for v1; Postgres-backed virtual sources
  belong to the Dash org and mix into any of its scenes.
- `TenantCtx` is resolved once per request from the session and the URL `/t/{tenant}`
  ([02 §4](../product/02-information-architecture.md)), and is required by the type system:
  `pulsusdb-client` methods take `&RequestCtx`, not a URL.
- **Isolation:** every cache key, singleflight key, budget, lease key and metric label includes the
  tenant. Postgres access sets the tenant binding for row-level security on every transaction:
  `Db.Tx` runs `SELECT set_config('pulsus.org_id', …, true)` (transaction-local) first (T11-003).
- **Fairness:** the concurrency limiter (§4.10) is a weighted deficit-round-robin across tenants
  inside each priority class. Per-tenant quotas (queries/s, concurrent physical queries, AI
  tokens/month) are stored in Postgres and hot-reloaded.

#### T06-016 — Postgres access through `dash-store` under RLS
**MUST** — All configuration and Dash-derived state MUST be read and written through `dash-store`,
which MUST bind the tenant for row-level security on every transaction and MUST NOT require any
Postgres extension. Time-partitioned tables are managed by T11's partition jobs.

### 4.8 Dash self-observability and what Dash writes to PulsusDB

Dash monitors itself in PulsusDB, through the same UI ([T19](T19-deployment.md) owns the deployment
wiring).

- `tracing` + `tracing-opentelemetry` + `opentelemetry-otlp` (HTTP/protobuf) export to PulsusDB
  `POST /v1/traces`, `/v1/metrics`, `/v1/logs` under a **dedicated self tenant** (`X-Scope-OrgID:
  pulsus-dash-self` by default, configurable, optionally a separate `X-Pulsus-Database`). Writes use
  `X-Pulsus-Async: 1`, because losing self-telemetry is acceptable and blocking on it is not.
- Resource attributes: `service.name=pulsus-dash`, `service.instance.id`, `pulsus.dash.role`. The
  catalogue therefore shows Dash as an entity with its own Lens.
- Key metrics: `dash_http_request_duration_seconds{route}`,
  `dash_pulsusdb_request_duration_seconds{cluster,route,priority,status}`,
  `dash_vsrc_request_duration_seconds{source}`,
  `dash_planner_{plans,physical,dedup_hits,cancelled}_total`, `dash_cache_{hits,misses,bytes}{tier}`,
  `dash_json_to_arrow_seconds`, `dash_budget_rejections_total{class}`, `dash_job_lag_seconds{job}`,
  `dash_scope_proof_missing_total`, `dash_virtual_leak_total`, and the evaluator and notifier
  families from T16.
- A Prometheus `/metrics` endpoint is also exposed for operators who scrape, on the separate admin
  port ([T19](T19-deployment.md)), never on the public listener.
- Browser RUM (frame time p99, long tasks, input latency) is posted by the shim's byte pump to
  `POST /api/dash/v1/rum` in a compact binary record ([T03](T03-browser-runtime.md)). The BFF relays
  it as OTLP metrics to the self tenant, which turns the [09](../product/09-performance-contract.md)
  contract into a production dashboard.
- **Alert transitions and deliveries are not written to PulsusDB.** They are stored in Postgres
  (ALR-084, T16) and served back through the virtual sources (T07 §4.11). The draft's OTLP write-back
  into the customer tenant is removed (D2).

#### T06-017 — Dash writes to PulsusDB only self-telemetry and the audit export
**MUST** — The only write requests Dash sends to PulsusDB MUST be (a) its self-telemetry, to the
self tenant, and (b) the audit export when an operator configures PulsusDB as its target. Alert
history, alert state, baselines, anomaly scores, change events and fallback pyramids MUST NOT be
written to PulsusDB (ADR-0012). No feature other than self-telemetry MAY depend on PulsusDB ingest
being enabled; alerting in particular MUST work when ingest rejects Dash's writes (ALR-087).

#### T06-018 — Self-telemetry never loops
**MUST** — Self-export MUST bypass `pulsusdb-client`'s budgets, planner and concurrency limiter, MUST
NOT trace its own HTTP calls, and MUST be asynchronous (`X-Pulsus-Async: 1`) and lossy under pressure.
Spans are head-sampled at 10 % (100 % for errors and for spans > 1 s).

### 4.9 Configuration

Configuration is layered, and later layers win: compiled defaults → YAML file (`--config`) → env
`PULSUS_DASH_*` → **runtime settings** in Postgres (per-tenant quotas, budgets, feature flags), which
are hot-reloaded through `LISTEN dash_config`.

```rust
pub struct DashConfig {
    pub roles: Vec<Role>,                         // all | api | worker | evaluator | notifier | ai
    pub listen: SocketAddr,                       // default 0.0.0.0:8080
    pub admin_listen: SocketAddr,                 // default 127.0.0.1:9090 (/metrics, pprof)
    pub postgres: PgConfig,                       // url_ref, pool 32, optional read_replica_url_ref (virtual sources)
    pub redis: Option<RedisConfig>,
    pub datasources_bootstrap: Vec<DatasourceSeed>, // first-run seed; then Postgres-owned
    pub pulsusdb: PulsusClientConfig {            // defaults per cluster, overridable per datasource
        pool_per_cluster: u32,                    // 64
        interactive_timeout: Duration,            // 10s
        refine_timeout: Duration,                 // 20s
        background_timeout: Duration,             // 60s
        rollup_ranges_s: Vec<u64>,                // [10800, 57600, 604800, 7776000]: mirrors PULSUS_ROLLUP_RANGES
        explain_sample_ratio: f32,                // 0.01
        h2c_prior_knowledge: bool,                // false
    },
    pub cache: CacheConfig { l1_bytes: u64 /*512 MiB*/, tile_points: u32 /*1024*/ },
    pub limits: LimitsConfig,                     // §4.10 defaults; per-tenant overrides in Postgres
    pub telemetry: TelemetryConfig { self_org_id: String, sample: f32, otlp_endpoint: Option<Url> },
    pub audit_export: Option<AuditExportConfig>,  // OTLP target: PulsusDB tenant or SIEM collector
    pub ai: AiConfig,                             // T15 (draft)
    pub auth: AuthConfig,                         // §4.11; T10 (draft)
}
```

`rollup_ranges_s` exists because `runtimeinfo` reports the levels (`rollupLevels`) but not the switch
points (`PULSUS_ROLLUP_RANGES`). The planner needs the switch points to predict the level (T07 §4.3).
The 1 % explain sample compares the predicted level with PulsusDB's `rollup_route` stage and raises
`dash_rollup_prediction_mismatch_total` if they diverge.

**Implemented keys (#59).** The Go server reads the subset its features need. Today these are
`server.roles`, `server.listen` and `server.shutdown_grace`;
`postgres.app_url_ref` (serve, as `pulsus_app`), `postgres.owner_url_ref` (migrate, as
`pulsus_owner`) and `postgres.pool_max`; the first-run seed `datasource.{url, slug, database,
scope_org_id, credentials_ref}` and `bootstrap.{org_slug, org_name}`, which replace
`datasources_bootstrap` above; `log.{level, format}`; and `allow_inline_secrets`. Each key's
variable is `PULSUS_DASH_` plus the key path upper-cased with `.` → `_`, for example
`PULSUS_DASH_POSTGRES_POOL_MAX`. The other fields above arrive with the features that use them.
`docs/server/README.md` is the reference.

#### T06-019 — Strict configuration
**MUST** — *(Revised 2026-11-20, #59.)* Unknown YAML keys, repeated keys, and unknown
`PULSUS_DASH_*` variables MUST be rejected at start-up, matching PulsusDB's convention. The
`PULSUS_DASH_*` variables that only the client tooling reads (the server's `ClientVars` list, for
example `PULSUS_DASH_DEV_BFF`) are exempt: the server accepts and ignores them. Runtime settings MUST be validated before they are applied; an
invalid hot-reload MUST be refused and leave the previous settings active.

### 4.10 Backpressure

Backpressure works at three layers. Each sheds the least valuable work first.

1. **PulsusDB-facing.** For each (cluster, priority) there is an adaptive concurrency limit (a
   gradient/AIMD limiter, using the latency of
   `Interactive` requests as the signal). The starting limits per api replica are Interactive 32,
   Alerting 16 (evaluator role), Refine 16, Prefetch 8, Agent 8, ExternalAgent 4, Background 4. A
   rising p90 or any `503 timeout` cuts the limits; `Background` and `Prefetch` are cut first.
   Postgres-backed virtual sources have their own class limit (4 per api replica) so alert-history
   queries cannot exhaust the config pool.
2. **Planner-facing.** When a class's queue wait exceeds its slack (Interactive 50 ms, Refine
   300 ms), the planner gets `Overloaded{class}` and **degrades the plan** instead of queueing. It
   drops prefetch, skips the fine pass (coarse only), and widens steps ×2. The coverage meter shows
   "server busy: coarse view".
3. **Browser-facing.** Each WS/HTTP2 session has an outbound byte budget of 32 MB buffered. HTTP/2
   flow control is honoured. If the client stops reading (a backgrounded tab), streams are paused
   lowest-priority-first, and after 30 s with no reads the session's prefetch and refine queries are
   cancelled. The shim reports visibility so the planner can suspend a hidden tab's live refresh.

#### T06-020 — Degrade, do not queue
**MUST** — When a priority class's queue wait exceeds its slack, the BFF MUST signal
`Overloaded{class}` to the planner and the planner MUST degrade the plan (T07 §4.13) rather than
queue interactive work behind it.

#### T06-021 — Inbound limits
**MUST** — The gateway MUST apply `tower::limit` per principal (default 50 plan requests/s, 200
CRUD/s), a body limit of 2 MiB for JSON and 16 MiB for uploads (imports), and answer excess with
`429 Retry-After` and a JSON reason (§5.2).

### 4.11 Authentication and authorization plumbing (M-UI6 subset)

T10 (draft) owns identity end to end (SAML, SCIM, API tokens, service accounts, data-scope
semantics). It is not yet promoted, so this section fixes the subset that ships with authentication
at M-UI6 and the seams T10 plugs into.

**Until authentication lands (D12).** Sign-in, sessions, users and roles are deferred to M-UI6
([designs README](../README.md) D12). Until then there is no login route and no session. Every
request runs as a fixed local principal: "Local user", role admin, in the bootstrap organisation
that `migrate` seeds (`install_state`), with that organisation's tenant binding. The BFF reports it
to the client through its bootstrap route (#59 Part B). The rest of this section applies from
M-UI6.

- **OIDC login.** `dash-auth` implements the authorization-code flow with PKCE (`openidconnect`
  crate) against one or more configured IdPs per org. Routes: `GET /auth/login?idp=`,
  `GET /auth/callback`, `POST /auth/logout`. ID-token validation: issuer, audience, `exp`, `nonce`,
  JWKS signature (cached, refreshed on `kid` miss).
- **MFA is the IdP's.** Dash honours the IdP's authentication context: an org MAY require a minimum
  `acr` value or `amr` members, and a token that does not meet it is refused with a link back to the
  IdP. Dash implements no second factor of its own.
- **Sessions.** Server-side session rows in Postgres (T11 `sessions`), referenced by an opaque
  `__Host-dash_session` cookie (`Secure`, `HttpOnly`, `SameSite=Lax`, rotated on login). Idle timeout
  12 h, absolute 7 d by default (runtime settings). The WS session authenticates with the same
  cookie at upgrade, plus an `Origin` check ([T18](T18-security.md) owns CSRF and CSP).
- **Principal.** On each request the session resolves to `Principal { org, user, teams: SmallVec,
  roles: RoleSet, auth: AuthContext{idp, acr, amr} }`. Users can belong to several teams (ENT-001).
- **Built-in roles** (ENT-003; [11 §3.1](../product/11-enterprise.md)) are a static
  `Role → PermissionSet` table compiled into `dash-auth`. Custom roles arrive with T10 (M-UI6).
- **Data scope.** `DataScope` is compiled per principal by `dash-auth` from the org's scope rules
  (T10 (draft)) and cached by `scope_fp`. At M-UI1 every principal has the full-tenant scope unless
  the org defines scopes; the plumbing (non-optional `RequestCtx.scope`, `ScopeProof`) is present from
  M-UI1 so enforcement is not retrofitted.

#### T06-022 — OIDC only, MFA at the IdP
**MUST** — Interactive login MUST be delegated to an OIDC IdP (SAML from M-UI6 via T10). Dash MUST
NOT store user passwords or implement its own second factor, and MUST refuse a login whose `acr` or
`amr` does not meet the org's configured minimum.

#### T06-023 — Authorization at the gateway
**MUST** — Every route MUST declare the permission it requires (`#[require(Permission::BoardWrite)]`
on the axum handler), and the gateway MUST check it against the principal's role set before the
handler runs. List endpoints MUST filter by permission in the query rather than return items for the
UI to hide. A refused action returns `forbidden` with a `request_access` hint (§5.2), never a bare
`403` page.

#### T06-024 — Credentials never reach the browser
**MUST** — Datasource credentials, IdP client secrets and notification secrets MUST NOT be sent to
the browser in any response. Admin APIs treat them as write-only fields.

#### T06-025 — Datasource bindings
**MUST** — The datasource API MUST accept only the types `pulsusdb` and, once enabled,
`prometheus-api` (read-only). Binding a datasource MUST verify connectivity and credentials with a
`runtimeinfo` call (and `X-Scope-OrgID` / `X-Pulsus-Database` when set) before it is stored, and
report a failure as a field error.

### 4.12 Postgres-backed virtual sources (hosting)

[ADR-0012](../adr/0012-derived-state-in-postgres.md) requires the reserved selectors `ALERTS`,
`ALERTS_FOR_STATE`, `pulsus_anomaly_score` and `{source="pulsus-dash"}` to be served through the same
query interface as telemetry. Their semantics, supported functions and join limits are specified in
[T07](T07-scene-query-planner.md) §4.11. This document fixes their hosting:

- `dash-vsrc` runs in the **api** role, in-process with the planner, and implements `VirtualSource`.
- It reads through `dash-store` under RLS. When `postgres.read_replica_url_ref` is configured, it
  reads from the replica (history queries tolerate replica lag up to the T06-013 horizon).
- Statements carry `statement_timeout` = the remaining deadline and are cancelled with
  `pg_cancel_backend` semantics when the physical query's token is cancelled (sqlx drops the
  connection's in-flight query).
- Results leave as Arrow `ResultStream` with `Completeness.source = Virtual{table}`, so caching,
  frames and coverage are identical to PulsusDB results.

### 4.13 Prometheus-compatible read API

Because tools reading PulsusDB directly do not see alert history (ADR-0012), Dash serves
`ALERTS`/`ALERTS_FOR_STATE` (ALR-086) on a Prometheus HTTP API subset under `/api/prom/v1/`:
`query`, `query_range`, `series`, `labels`, `label/{name}/values`. It accepts **only expressions
that are fully virtual** (T07 §4.11); any expression referencing PulsusDB series is refused with
`invalid` and the hint "query PulsusDB directly". Authentication is an API token (T10 (draft)); the
token's data scope applies.

## 5. Interfaces

### 5.1 External HTTP surface (served by `dash-gateway`)

| Path | Protocol | Purpose | Owner of body schema |
|---|---|---|---|
| `GET/POST/PUT/PATCH/DELETE /api/dash/v1/{boards,folders,lens-templates,perspectives,waypoints,journeys,alert-rules,contact-points,routing,silences,investigations,datasources,…}` | REST/JSON, `ETag`/`If-Match` optimistic concurrency, cursor pagination | Config CRUD | T11 (schemas), T16 (alerting objects), T17 (draft) (investigations) |
| `GET/PUT /api/dash/v1/prefs` | JSON, `ETag` | User preferences, keymap, dock layout ([T08](T08-dom-component-kit.md)) | T08 (`Prefs` schema) |
| `GET /api/dash/v1/search?q=&kinds=` | JSON | ⌘K remote providers (entities, boards, alerts, investigations, waypoints) | T08 |
| `POST /api/dash/v1/suggest` | JSON | Editor completion and metadata: metric names, labels, values, detected fields, trace tags, cardinality ([T09](T09-query-editors.md)); scope-rewritten | T09 |
| `POST /api/dash/v1/actions/{action}` | JSON | Audited action API (table action buttons, ack, silence) | T16, T08 |
| `POST /api/dash/v1/export` | JSON request → CSV/Parquet stream | Table and viewport export | T08 |
| `GET /api/dash/v1/entities`, `/entities/{ref}`, `/graph?scope=…` | JSON for small, Arrow for bulk (`Accept`) | Catalogue | [T12](T12-entity-catalogue.md) |
| `GET /api/dash/v1/changes?from&to&entity=` | JSON or Arrow | Change feed | [T12](T12-entity-catalogue.md) |
| `POST /api/dash/v1/plan` | Request JSON → **response Arrow IPC stream** (`application/vnd.apache.arrow.stream`) over HTTP/2 | One-shot scene plan (no WS: exports, server-rendered images, MCP) | Request: [T07](T07-scene-query-planner.md) §5.1; frames: T04 |
| `GET /api/dash/v1/session` (upgrade) | **WebSocket**, binary frames | Long-lived scene session: plan/replan/cancel/approach hints, live updates, tail relay, presence (T17 (draft)) | Messages: T07 §5.1; framing: T04 |
| `GET /api/dash/v1/pyramids/{id}/tiles/{level}/{tile}` | Arrow IPC, `ETag`, immutable `Cache-Control` | Pyramid tiles (from PulsusDB rollups, or from Postgres fallback tiles) | T13 (draft) |
| `POST /api/dash/v1/compare` | JSON request → Arrow stream | Universal Compare (server side) | T13 (draft) |
| `/api/prom/v1/{query,query_range,series,labels,label/{name}/values}` | Prometheus HTTP API (JSON) | Virtual sources only (§4.13) | Prometheus API |
| `/api/dash/v1/ai/*`, `/mcp` | REST + SSE; MCP streamable HTTP | Copilot, RCA runs, MCP server (ExternalAgent class) | T15 (draft) |
| `/auth/*` (OIDC), `/scim/v2/*` (M-UI6) | OIDC/SAML/SCIM | Identity | §4.11, T10 (draft) |
| `POST /api/dash/v1/rum` | Binary | Browser RUM | T03 (record format) |
| `GET /healthz` (liveness), `/readyz`, `/startupz`; `/metrics` on the separate admin port only | — | Ops | [T19](T19-deployment.md) |
| `GET /api/dash/v1/version` | JSON | The server's version and commit | `api/openapi.yaml` (`Version`) |
| `GET /api/dash/v1/bootstrap` | JSON | The client's first call: principal (the fixed local principal until M-UI6, D12), organisation, tenant slugs with their data-source check state (never a datasource URL, database, scope or credentials reference, T06-024), the server version and `can_sign_out` | `api/openapi.yaml` (`Bootstrap`) |
| `POST /api/dash/v1/csp-report` | `application/reports+json` or `application/csp-report` | CSP violation reports ([T18](T18-security.md) T18-003): rate-limited, 64 KiB, read deadline, logged as allowlisted values only | `api/openapi.yaml` (hand-written handler) |

#### T06-026 — Readiness does not depend on PulsusDB
**MUST** — `/readyz` MUST report Postgres reachability, migration level and audit partition health
only *(revised 2026-11-20, #61; was "Postgres reachability and migration level only")*. A PulsusDB outage
MUST NOT make replicas unready, so alert state, silences and investigations stay available.

### 5.2 Error envelope (JSON routes)

`{"error":{"code":"scope_denied|budget_exhausted|too_broad|unavailable|invalid|forbidden|virtual_unsupported|not_found|conflict|internal","message":"…","hint":{…},"query_id":"…","fields":[{"pointer":"/rules/0/expr","message_key":"…"}]}}`.

- `hint` carries machine-readable narrowing suggestions, for example the label to add (PRF-031), or
  `request_access{owner_team}` for `forbidden` (ENT-010).
- `fields` maps server validation errors to form fields by JSON pointer ([T08](T08-dom-component-kit.md) forms).
- `not_found` answers an unknown route or object (404); `internal` answers an unexpected server error
  (500), whose details are logged and never returned. A wrong method on a known route is `invalid`
  (405).
- `conflict` answers a write whose `If-Match` does not equal the object's current ETag (409,
  [T11](T11-postgres-schema.md) T11-005). Its body is `{"error":{…},"current":{…},"submitted":{…}}`:
  the current object and, for a save, the submitted spec, so the client can show both.

### 5.3 PulsusDB endpoints used

Every endpoint in §4.3 is documented in the PulsusDB API reference (`docs/api.md` §2–§6, checked
2026-11-18). Fallbacks for [R1](pulsusdb-requirements.md) (JSON→Arrow), R10 (Completeness), R11
(coalescing + tight `timeout`) and R12 (`ScopeRewriter`) live here. R2/R4/R5/R6/R9/R13/R14 are in
[T07](T07-scene-query-planner.md) §4.12, and R3/R8 in [T12](T12-entity-catalogue.md).

### 5.4 Internal API (api ⇄ worker/ai/evaluator)

#### T06-027 — Internal API is mTLS and never exposed
**MUST** — Replica-to-replica calls MUST use HTTP/2 with mutual TLS ([T18](T18-security.md)), bodies
JSON-encoded versions of the interface calls in §4.1 *(revised 2026-11-19, ADR-0015; was `bincode`)*, under `/internal/v1/{service}/{method}`. The
internal listener MUST NOT be routed by the ingress. It is versioned per release, and mixed-version
clusters are supported for one minor version ([T19](T19-deployment.md)).

### 5.5 Cross-doc interfaces

| Interface | Direction | Assumption / contract |
|---|---|---|
| `RequestCtx`, service traits (§4.1) | **Defined here** | Every module (T07, T10, T12, T15, T16, T17) implements or consumes these |
| `ScopeRewriter` | Trait defined here, implemented by T10 (draft) (`pulsus-dash-scope`) | Pure function over the *physical* query text, returning `Rewritten{query, scope_fp, withheld}`. Runs in the planner after physicalisation and before cache keys or dispatch (T07 §4.7). `filter_response` covers native operations |
| `VirtualSource` | Trait defined here, semantics in T07 §4.11, tables in T11 | Evaluated in the api role under RLS |
| `job_leases`, `members`, `sessions` tables | Shape defined here, DDL owned by T11 | Fencing tokens on all job writes |
| Arrow schemas, frame codec, WS resume | **Assumed from T04** | T04 provides `dash-wire` with `encode_batch(stream_id, batch)` and a resume token. Each frame carries `(plan_id, viewport_id, pass, generation)` |
| IndexedDB cache | Assumed from T04 | Browser tier above L1. Uses the same `ResultKey` tile boundaries so tiles are shared |
| Secrets provider, mTLS, CSP | Assumed from T18 | — |
| Helm, sizing (incl. Postgres growth from ADR-0012), self-telemetry tenant bootstrap | Assumed from T19 | — |

## 6. Data & storage

| Data | Where |
|---|---|
| Result tiles | L1 memory, L2 Redis (optional), browser IndexedDB (T04) |
| Catalogue graph snapshot, anomaly index | Built by worker. Published to Redis + Postgres (`snapshots` table, versioned) |
| Baselines, anomaly scores (5 min, 30 d), derived change events, entity first/last seen (30 d) | Postgres, time-partitioned (ADR-0012, T11) |
| Fallback pyramid tiles (R4 absent) | Postgres `pyramid_tiles` (zstd Arrow IPC `bytea`, 7 d), T07 §4.12 |
| Alert state, transitions, delivery attempts | Postgres (T16, T11) |
| Leases, members, sessions, runtime settings, quotas | Postgres |
| Audit | Postgres `audit_events` (monthly partitions, [11 §5](../product/11-enterprise.md)) + optional OTLP export (PulsusDB tenant or SIEM) |
| Self-telemetry | PulsusDB self tenant |

## 7. Performance budget

| Item | Budget | Ties to | Measured by |
|---|---|---|---|
| BFF overhead per physical query (auth, plan, cache lookup, decoration) | p50 ≤ 5 ms, p99 ≤ 20 ms | PRF-010 "first coarse < 300 ms" | `dash_http_request_duration_seconds` minus `dash_pulsusdb_request_duration_seconds`; `load:bff-overhead` |
| JSON→Arrow conversion | ≤ 30 ms per 10⁶ points per core; first batch out ≤ 10 ms after first PulsusDB byte | PRF-010, R1 | `bench:json-to-arrow` (criterion on recorded responses) |
| L1 hit to first byte on the wire | ≤ 2 ms | PRF-026 | span `cache.lookup` |
| Catalogue resolve (`{{entity}}`, Atlas inventory) | ≤ 5 ms from snapshot | PRF-012 | span |
| Virtual-source query (1 week of `ALERTS`, one tenant, ≤ 1 000 series) | p95 ≤ 150 ms | ALR-085 | `bench:vsrc-alerts-week` against seeded Postgres |
| Stage-1 RCA kick-off after alert fires | ≤ 1 s scheduling latency on ai/worker | PRF-013 "RCA card < 10 s" | `dash_job_lag_seconds{job="rca1"}` |
| OIDC callback to session | ≤ 50 ms excluding IdP time | PRF-008 (warm re-login) | span `auth.callback` |
| Memory per api replica | ≤ 2 GiB at 1k concurrent sessions (512 MiB L1 + 1 MiB per session on average) | — | `load:api-1k-sessions` |

## 8. Security, tenancy & RBAC

- Every PulsusDB and virtual-source call requires a `RequestCtx` with a non-optional `DataScope`
  (T06-002). Background results are filtered by the viewer's scope at read time (T13 (draft)).
- The AI agent runs as `Principal::AiAgent{on_behalf_of}` with the user's scope, intersected with the
  org's AI policy ([06](../product/06-ai-copilot.md)). Its budget is separate (T07 §4.8). MCP calls run
  as the token's principal, in the ExternalAgent class, budgeted and audited (AI-048).
- Data-access audit records principal, entity refs, time window, the physical query hash and
  `X-Pulsus-Query-Id`. Each event is sampled or recorded in full according to org policy (ENT-017,
  from M-UI6).
- Derived state (alert history, anomaly scores) is protected by Postgres RLS for tenancy and by the
  data scope for finer filtering (T07 §4.11); customer telemetry tenants are never written by Dash.
- Datasource credentials never reach the browser (T06-024). CSP and COOP/COEP headers are served by
  the gateway ([T18](T18-security.md), [T03](T03-browser-runtime.md)).

## 9. Failure modes & degradation

| Failure | User sees |
|---|---|
| PulsusDB cluster unreachable | Cached tiles with stale hatching (PRF-026) and the coverage meter "server unreachable, showing cache from 12:03". Health is **never** shown as green on missing data. Virtual sources keep working |
| PulsusDB `422` too broad | "Too broad" badge with a one-click narrowing (hint label from the catalogue) |
| Overload (§4.10) | Coarse-only views, the "server busy" coverage note, prefetch off |
| Postgres down | Read-only banner, boards from snapshot, alert evaluation continues from in-memory state (T16); virtual-source viewports show "alert history unavailable" |
| Redis down | No visible change apart from lower hit rate |
| A worker job lease is lost | The job is resumed by another member within 15 s. A stale snapshot age shows in the Atlas header |
| IdP unreachable | Existing sessions continue until expiry; new logins show the IdP error with retry |
| PulsusDB ingest rejects self-telemetry | Self-telemetry dropped and counted; no user-facing effect (T06-017) |

## 10. Testing

- **Contract tests** against a real PulsusDB in Docker (seeded datasets from
  [T05](T05-testing-and-performance.md)), one per client method (`itest:pulsusdb-contract`). Golden
  JSON→Arrow conversions use PulsusDB's own fixtures where possible.
- **No writes:** an ingest-recording proxy in front of PulsusDB during the storyboard and alerting
  suites asserts that the only writes are self-telemetry and the configured audit export
  (`itest:no-pulsusdb-writes`, `itest:alerting-no-ingest`).
- **Fault injection:** `toxiproxy` between Dash and PulsusDB (latency, resets, 503 bursts) checks the
  retry budget, the limiter and degradation. Postgres failover is checked with Patroni nightly.
- **Lease and fencing:** deterministic simulation with `turmoil`, covering partitions, clock skew and
  paused processes (`sim:lease-fencing`).
- **Tenancy:** a property test checks that two tenants and scopes never share a `ResultKey`
  (`prop:resultkey-tenancy`). A fuzzer generates queries and asserts that every outbound request
  carries the expected `X-Scope-OrgID` and a `ScopeProof` (`itest:multi-tenant-headers`,
  `prop:scope-proof`).
- **Auth:** OIDC against Dex and Keycloak containers with MFA policies (`itest:oidc-login`); the
  route-permission matrix per built-in role (`itest:rbac-builtin-roles`).
- **Load:** a synthetic NOC wall (50 sessions on the same board), Lens storms and 1k sessions per
  replica (`load:noc-wall`, `load:api-1k-sessions`). Gates are in T05.

## 11. Rollout

| Milestone | Ships |
|---|---|
| M-UI1 | `--role all`; gateway, a fixed local principal (D12), datasource bindings, planner v1, PulsusDB client (metrics; logs on the native log routes: `logs_query_range`, `logs_volume`, labels and series), L1 cache, self-telemetry, `/suggest`, `/prefs`, `/search` |
| M-UI2 | Remaining logs methods (`logs_patterns`, `logs_detected_{labels,fields}`, `logs_tail`), traces and profiles client methods; catalogue refresh as a leased job; Arrow tiles in IndexedDB |
| M-UI3 | Split roles; Redis L2; change feed, anomaly sweep and fallback pyramid builder workers (Postgres tiles); compare service; MCP mount |
| M-UI4 | Evaluator and notifier roles (T16); ai role (T15 (draft)); virtual sources and the Prometheus-compatible read API; HA gates |
| M-UI6 | OIDC auth with built-in roles and sessions (D12); per-tenant quotas UI, data-access audit, audit export, SAML/SCIM (T10 (draft)), multi-cluster fairness tuning |

Feature flags in runtime settings: `redis_l2`, `explain_sampling`, `h2c`, `r1_arrow_accept`
(switched on per cluster when R1 ships), `audit_export`.

## 12. Alternatives considered

| Option | Why not |
|---|---|
| Microservices from day one | Operational cost for small installs, plus a latency hop on the critical path. Role flags in one binary give the same scaling seams |
| etcd/Consul for leader election | Adds a dependency. Postgres leases with fencing are sufficient at our cadence (≥ 5 s) |
| Rust/axum BFF (ADR-0001) | Superseded by [ADR-0015](../adr/0015-go-bff.md): the browser no longer shares server crates, and Go's web, OIDC, Postgres and cloud SDK ecosystem fits the BFF's work |
| gRPC for the internal API | Workable. JSON over HTTP/2 reuses the OpenAPI tooling; revisit if call volume makes encoding cost visible |
| Caching per user | Forfeits the NOC-wall sharing. Keying by the scope-rewritten query is both safe and shareable |
| Relying only on PulsusDB's read cache | It is per PulsusDB process, PromQL `query_range` only, and bypassed by explain. Dash still needs logs, traces and cross-replica caching |
| Writing alert transitions and derived series back to PulsusDB over OTLP (draft; ADR-0010) | Rejected by D2 / [ADR-0012](../adr/0012-derived-state-in-postgres.md): consumes customer ingest, makes alerting depend on ingest, and splits product state across two stores |
| JWT-only stateless sessions | Revocation and idle timeout need server state anyway; Postgres sessions are cheap at our login rate |

## 13. Open questions

1. Does PulsusDB honour `traceparent` on query routes? If so, Dash and PulsusDB spans join into one trace (R11).
2. h2c support in PulsusDB, and whether HTTP/2 stream reset maps to the same `499` path as a connection close (R11 test).
3. Redis vs Postgres `UNLOGGED` tables for L2 on installs that refuse Redis.
4. Per-tenant pinning of api replicas for very large tenants (cache locality) vs pure fair sharing.
5. Should the Prometheus-compatible read API (§4.13) also proxy PulsusDB queries under the caller's
   scope, so external tools can use one endpoint? Leaning no for v1.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft. Restructured to the template; binding constraints turned into rules T06-001…T06-027. **D2 / ADR-0012:** removed the OTLP write-back of alert transitions and deliveries into customer tenants; Dash writes to PulsusDB only self-telemetry and the optional audit export (T06-017); baselines, anomaly scores and fallback pyramids move to Postgres; draft open question 3 closed. Added `dash-vsrc` hosting (§4.12), the Prometheus-compatible read API (§4.13), the M-UI1 OIDC/RBAC plumbing (§4.11, because T10 is not promoted), the `/suggest`, `/prefs`, `/search`, `/actions`, `/export` routes the T08/T09 drafts assumed, `VirtualGuardLayer`, `Completeness.{source,data_age_ms,withheld,approximation}`, and datasource-binding validation |
| 1.0-rc | 2026-11-18 | #22: §4.1 BFF crates live in the repository's root Cargo workspace (BFF-only crates under `server/`, shared ⇄ crates under `crates/`, one lockfile); the shared wire crate is named `dash-wire`, as in T01 §4.6 |
| 1.0-rc | 2026-11-19 | Roadmap D5 ([12](../product/12-roadmap.md#21-delivery-order-2026-11-19) §2.1): §11 logs client methods on the native log routes move M-UI2 → M-UI1; patterns, detected fields, tail, traces and profiles stay M-UI2 |
| 1.1-rc | 2026-11-19 | [ADR-0015](../adr/0015-go-bff.md): BFF in Go. New §0 mapping; §4.1 rewritten as the Go package layout; T06-001, T06-005 (enforcement) and T06-027 (JSON internal API) revised; T06-011 notes JSON frames to the browser until the engine (ADR-0014 §5); §12 updated |
| 1.2-rc | 2026-11-20 | #59 Part A and D12 (authentication deferred to M-UI6): header milestones, §2 goal, §4.11 (now the M-UI6 subset, with the fixed local principal until then) and §11 move OIDC auth from M-UI1 to M-UI6; §3 ENT-028 gate `e2e:helm-default-login` renamed `e2e:helm-default-shell`; §4.7 binds the tenant with `set_config('pulsus.org_id', …, true)` in `Db.Tx`; §4.9 lists the implemented Go keys; T06-019 revised: repeated keys rejected, client-tooling variables exempt; §5.2 adds the `not_found` and `internal` codes |
| 1.3-rc | 2026-11-20 | #59 Part B: §5.1 adds `GET /api/dash/v1/version`, `GET /api/dash/v1/bootstrap` (fixed local principal until M-UI6, D12) and `POST /api/dash/v1/csp-report` |
| 1.4-rc | 2026-11-20 | #61 Part A: §5.2 adds the `conflict` code (409 on an `If-Match` mismatch, body `{error, current, submitted}`, T11-005); T06-004 note: configuration-change audit rows are written in the save transaction (T11-006), the non-blocking sink applies outside a content transaction; T06-026 revised: `/readyz` reports Postgres reachability, migration level and audit partition health only (still never PulsusDB) |
| 1.5-rc | 2026-11-21 | [ADR-0018](../adr/0018-query-language-modules.md): §4.3 split into core and language modules, with the log completion methods and a return-contract table (streamed metric results, typed completion and metadata results, the log page and volume returns, and the buffered `LogQueryRange` response when `result` precedes `resultType`); T06-011 note on typed completion and metadata results; T06-028; T06-005 note |
| 1.6-rc | 2026-11-21 | [ADR-0021](../adr/0021-query-planning-is-server-side.md): §4.3 `prom.Plan` and `logs.Plan` in the language modules, with fixtures under `wire/fixtures/plan/`; §4.4 L1 metric-types row; new rule T06-029 (the server builds the final query, `itest:plan-authority`); ENT-006 row |
| 1.6-rc | 2026-11-21 | Design review r1 of the ADR-0021 PR: T06-029 scoped to the PromQL paths (LogQL once `logs.Plan` lands) and separates the planned text from the final scope-rewritten text; `itest:plan-authority` no longer requires the re-planned text to differ; §4.4 metric types keyed, with singleflight, by tenant binding |
