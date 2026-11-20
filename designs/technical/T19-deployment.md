# T19 — Deployment & operations

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.7-rc · 2026-11-20 |
| **Milestone** | M-UI1 (binary + image + basic chart) → M-UI4 (worker roles, HA evaluator, self-observability, derived-state sizing) → M-UI6 (air-gapped, SaaS cells) |
| **Related ADRs** | [ADR-0016](../adr/0016-asset-integrity-verified-by-bff.md), [ADR-0015](../adr/0015-go-bff.md), [ADR-0014](../adr/0014-typescript-react-web-client.md) (supersede ADR-0001), [ADR-0006](../adr/0006-pulsusdb-and-postgres.md), [ADR-0008](../adr/0008-dash-alert-evaluator.md), [ADR-0009](../adr/0009-optional-object-storage.md), [ADR-0012](../adr/0012-derived-state-in-postgres.md) |
| **Source draft** | plans/tech/T19-deployment.md (not tracked) |

## 1. Context & problem

[11](../product/11-enterprise.md) §8 commits to:
- a single binary (Go since [ADR-0015](../adr/0015-go-bff.md)) with embedded static client assets and a Helm chart (ENT-028);
- HA through stateless replicas, Postgres HA and a leader-elected alert evaluator (ENT-029);
- one deployment fronting several PulsusDB clusters and tenants (ENT-027);
- air-gapped installs with self-hosted AI models (ENT-030).

[ADR-0012](../adr/0012-derived-state-in-postgres.md) makes **Postgres the store for all
Dash-derived state** (alert history, anomaly baselines and scores, change events, fallback
pyramids), so Postgres sizing grows and becomes part of this design. Dash writes to PulsusDB only its
own self-telemetry, plus the audit export when an operator configures one.

The browser side adds hard requirements:
- correct **COOP/COEP** on every document ([T01](T01-frontend-architecture.md),
  [T18](T18-security.md) §4.2);
- `application/wasm` served with brotli;
- a cold load under 1 s from a warm CDN with core WASM < 3 MB brotli
  ([09](../product/09-performance-contract.md) PRF-008, PRF-009).

The same product must run in two very different environments: as a 1-node install for a small
team, and as a multi-tenant SaaS for thousands of organisations. Dash also has to observe itself
with its own tools, without becoming its own single point of failure. The repository is AGPL-3.0
(decision D3), and self-hosted, air-gapped and SaaS deployments run the same build.

## 2. Goals / non-goals

**Goals**
- One artefact (`pulsus-dash`), with behaviour chosen by flags and configuration.
- Zero-downtime upgrades, including schema migrations and browsers already holding old WASM.
- Air-gapped operation with no outbound calls.
- A documented sizing guide, including Postgres for derived state.
- Self-observability that ships to PulsusDB and still pages when PulsusDB or Dash is down.

**Non-goals**
- Operating PulsusDB or ClickHouse. PulsusDB ships its own setup (`/admin/setup`). We state only the
  configuration we need from it (§4.9).
- Internal module layout, which belongs to [T06](T06-bff-architecture.md). Here we only map modules
  to process roles.
- Postgres operations beyond sizing, HA topology and backup ([T11](T11-postgres-schema.md) §4.12).

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [ENT-028](../product/11-enterprise.md#ent-028--single-binary-static-assets-helm) | §4.1 one binary + embedded assets; §4.2 image; §4.4 Helm chart | `e2e:helm-default-install` (kind cluster, default values → the application shell as the fixed local principal, no login page until M-UI6, D12) |
| [ENT-027](../product/11-enterprise.md#ent-027--one-deployment-many-pulsusdb-tenants) | §4.4 `pulsusdb:` bindings list; §4.8 tenancy into PulsusDB | `itest:multi-binding` |
| [ENT-029](../product/11-enterprise.md#ent-029--high-availability) | §4.6 HA topology; §4.5 fenced lease handover; T19-017 no sticky sessions | `chaos:replica-kill` (no missed interval, no duplicate notification, sessions survive) |
| [ENT-030](../product/11-enterprise.md#ent-030--air-gapped-installs) | §4.11 air-gapped profile and bundle | `itest:airgap-no-egress` (full smoke suite, zero denied connections) |
| [ENT-020](../product/11-enterprise.md#ent-020--configuration-and-derived-state-in-postgres) | §4.3 Postgres required, no extension; §4.7 sizing for derived state | `itest:no-extensions`; `bench:pg-derived-state` |
| [ENT-021](../product/11-enterprise.md#ent-021--large-artefacts-in-optional-object-storage) | §4.3 object storage optional; Postgres fallback | `itest:object-store-fallback` |
| [ENT-019](../product/11-enterprise.md#ent-019--siem-export) | §4.9 `[audit_export]` sink; T19-011 | `itest:audit-export-only-when-configured` |
| [ENT-011](../product/11-enterprise.md#ent-011--oidc-sso-with-idp-enforced-mfa) | §4.3 IdP dependency; full-page redirect flow behind ingress | `e2e:oidc-login-coop` |
| [IA-001](../product/02-information-architecture.md#ia-001--object-vocabulary-and-persistence) | §4.10 T19-011 only self-telemetry and audit export reach PulsusDB | `itest:no-pulsusdb-writes` |
| [ALR-070](../product/07-alerting.md#alr-070--heartbeat-dead-mans-switch) | §4.6 heartbeat to an external receiver for every org and for the deployment | `chaos:heartbeat-stops` |
| [ALR-084](../product/07-alerting.md#alr-084--alert-history-in-postgres) | §4.3, §4.10: alert history never on the PulsusDB write path | `itest:no-pulsusdb-writes` |
| [ALR-087](../product/07-alerting.md#alr-087--alerting-survives-without-pulsusdb-ingest) | §4.4 `/readyz` independent of PulsusDB; §4.9 no ingest requirement | `itest:alerting-no-ingest` |
| [ALR-066](../product/07-alerting.md#alr-066--server-rendered-chart-image) | §4.2 `pulsus-dash-render` image and render-worker deployment | `itest:chart-image-render` |
| [AI-044](../product/06-ai-copilot.md#ai-044--bring-your-own-model) | §4.3 model endpoint dependency (Anthropic, Bedrock/Vertex/Azure, OpenAI-compatible) | `itest:ai-provider-routing` |
| [AI-045](../product/06-ai-copilot.md#ai-045--air-gapped-ai) | §4.11 self-hosted OpenAI-compatible endpoint under the air-gapped profile | `itest:airgap-no-egress` (INC-2041 stage 1 and 2 complete) |
| [AI-050](../product/06-ai-copilot.md#ai-050--derived-ai-state-stays-out-of-pulsusdb) | §4.10 T19-011 | `itest:no-pulsusdb-writes` |
| [PRF-008](../product/09-performance-contract.md#prf-008--cold-load-to-interactive-shell) | §4.1 pre-compressed assets, `immutable` caching, CDN mode; §7 TTFB | `bench:cold-load` |
| [PRF-009](../product/09-performance-contract.md#prf-009--core-bundle-size-and-lazy-loading) | §4.1 lazy modules served by hash; previous release's assets kept | `e2e:upgrade-lazy-module` (old client fetches a lazy module after upgrade) |
| [PRF-025](../product/09-performance-contract.md#prf-025--local-first-analytics) | §4.1 `worker` role runs the fallback pyramid builder into Postgres | `itest:pyramid-tile-fallback` |

## 4. Design

### 4.1 Packaging: one binary, roles by flag

```
pulsus-dash serve   --role all | api,evaluator,notifier,ai,worker   (default: all)
pulsus-dash migrate [--dry-run]             pulsus-dash config check
pulsus-dash export|import --org <slug>      pulsus-dash-render         (Rust, headless wgpu, separate image §4.2)
pulsus-dash admin bootstrap --email …       pulsus-dash version --json
pulsus-dash assets publish --to s3://…
```

#### T19-001 — One artefact, roles by flag
**MUST** — Every server process MUST be the same `pulsus-dash` binary (the Rust `pulsus-dash-render`
chart renderer of §4.2 is the one exception, ADR-0015); behaviour MUST be selected
by `--role` and configuration. A module MUST declare its role and be safe to run on N replicas, or
take a `dash-jobs` lease ([T06](T06-bff-architecture.md)).

| Role | Contains (modules per [T06](T06-bff-architecture.md)) | Scaling |
|---|---|---|
| `api` | HTTP/WS API, auth (T10 (draft)), scene planner and virtual sources ([T07](T07-scene-query-planner.md)), Arrow streaming ([T04](T04-wire-format-and-data-plane.md)), static assets, MCP endpoint, Prometheus-compatible read API ([T16](T16-alert-evaluator.md) §4.7) | Horizontal, stateless |
| `evaluator` | Rule evaluation shards ([T16](T16-alert-evaluator.md)) | Shard leases; N replicas, each holding ≥ 0 shards |
| `notifier` | Routing, dispatch, delivery workers, heartbeat delivery | Horizontal (work queue in Postgres `FOR UPDATE SKIP LOCKED`) |
| `ai` | Stage-1 causal engine, agent runs (T15 (draft)) | Horizontal; isolated so long agent runs don't share CPU with the API |
| `worker` | Entity derivation ([T12](T12-entity-catalogue.md)); **derived-state jobs**: anomaly sweep and baselines, change-event derivation, fallback pyramid builder (T13 (draft), only when R4 is absent); partition maintenance, retention purges and class moves ([T11](T11-postgres-schema.md) §4.11); Git sync, audit export, import jobs | Singleton and per-tenant tasks via `dash-jobs` leases; may run on any replica |

**Static assets:**

#### T19-003 — Assets served pre-compressed and immutable
**MUST** — In **embedded mode** (default), assets MUST be compiled in with Go `embed.FS` *(revised
2026-11-19, ADR-0015; was `rust-embed`)*,
pre-compressed at build time (brotli q11 + gzip) and served with `Content-Encoding` negotiation,
`Content-Type: application/wasm` for WASM, `Cache-Control: public, max-age=31536000, immutable` for
hashed names, and `no-cache` for `index.html`, `asset-manifest.json` and `asset-manifest.sig`.

#### T19-004 — Old clients keep working across one upgrade
**MUST** — Lazy modules of the previous release MUST stay fetchable after an upgrade: the binary
embeds the **previous release's** hashed assets (roughly 1 × the core bundle; `--no-previous-assets`
turns it off), and in CDN mode versioned paths are kept for 30 days.

- **CDN mode:** `assets.base_url = https://cdn…/pulsus-dash/<version>/`. Every JS module, CSS file and worker is same-origin; the one executable asset that may come from the CDN is the engine WASM, which is fetched with `integrity` and compiled only from that verified response, with a same-origin retry
  ([T18](T18-security.md) T18-006, T18-007). Besides the engine WASM, the CDN serves only fonts and
  tiles. The BFF serves `index.html`, `asset-manifest.json` and `asset-manifest.sig`.

#### T19-005 — CDN asset sets are verified
**MUST** — At start-up the BFF MUST verify the detached Ed25519 `asset-manifest.sig` over
`asset-manifest.json` with the public key compiled into the binary, and the hash of every embedded
asset file, and MUST exit without serving on any mismatch or unlisted file (the manifest and its
signature are the only exemptions; [T18](T18-security.md) T18-006). A binary built without
embedded assets refuses to serve; `serve --api-only` is a development-only mode that serves no
client, and therefore nothing unverified. In CDN
mode it MUST also fetch and hash every manifest-listed CDN file and fall back to the embedded assets
on any mismatch.

  The CDN must send:
  - `Content-Type: application/wasm`;
  - `Cross-Origin-Resource-Policy: cross-origin`;
  - `Access-Control-Allow-Origin: <dash origin>`;
  - `Timing-Allow-Origin`.

  `pulsus-dash assets publish --to s3://…` uploads a version together with a generated header
  config for CloudFront and Cloud CDN. Header config syntax for other CDNs is left to the operator.

#### T19-002 — Headers come from the binary
**MUST** — Headers (CSP, COOP, COEP, HSTS…) MUST be set **by the binary**
([T18](T18-security.md) T18-002), never by ingress configuration, so they cannot be lost. When the
optional `server.public_url` is set, a start-up self-check makes one request with a 2 s timeout
right after the listener opens (`GET <public_url>/` as HTML, or `/healthz` without a client) and
warns when it is unreachable, answers another status, or an ingress strips or changes COOP, COEP or
the CSP. It never retries and never fails start-up.

**Build** *(revised 2026-11-19, [ADR-0015](../adr/0015-go-bff.md))*:
- `CGO_ENABLED=0 GOOS=linux GOARCH=amd64|arm64 go build -trimpath -buildvcs=true`, statically linked,
  with the Go toolchain pinned in `server/go.mod`; the client is built first (`npm ci && npm run build`)
  and embedded.
- TLS via the Go standard library.
- SAML (T10 (draft), M-UI6) is chosen in a Go library that needs no cgo, so there is no separate
  glibc build.

### 4.2 Docker images

| Image | Base | Contents | Size target |
|---|---|---|---|
| `pulsus-dash` | `gcr.io/distroless/static-debian12:nonroot` | static binary + embedded assets, CA bundle, tzdata | < 80 MB |
| `pulsus-dash-render` | `debian:12-slim` + Mesa (`llvmpipe`/lavapipe) | the Rust `pulsus-dash-render` binary built from the chart engine crates, for server-side chart images ([T02](T02-vis-engine.md), [07](../product/07-alerting.md) ALR-066); can use a GPU node with Vulkan drivers | < 350 MB |

#### T19-009 — Hardened, signed images
**MUST** — All images MUST run as UID 65532 with a read-only root filesystem and no shell, be
multi-arch (amd64/arm64), and be cosign-signed with an SBOM attestation ([T18](T18-security.md)
§4.11).

- The render worker is a separate deployment because Mesa is large and has a dynamic-library attack
  surface. The `notifier` calls it over HTTP/2 with mTLS (JSON request, PNG response) with a per-request time limit of 2 s.

### 4.3 Required and optional dependencies

| Dependency | Required? | Version | Used for |
|---|---|---|---|
| **PostgreSQL** | Yes | ≥ 15 (16 recommended); **no extension required** ([T11](T11-postgres-schema.md) T11-001); optional `pgvector` ≥ 0.7 and `pg_trgm` as accelerators | All config and state, **including all Dash-derived state** (alert history, anomaly baselines and scores, change events, fallback pyramids) |
| **PulsusDB** | Yes (≥ 1 binding) | Compatibility matrix per release; minimum is the version with the features in [pulsusdb-requirements](pulsusdb-requirements.md) §0 | Telemetry (**read**). Writes: Dash self-telemetry (§4.10) and, if configured, the audit export (ENT-019). Nothing else |
| Object storage | Optional ([ADR-0009](../adr/0009-optional-object-storage.md)); recommended for > 1 replica when snapshots/recordings are heavy | S3 API, GCS, Azure Blob, MinIO | Evidence snapshots, flight recordings, AI payloads, chart images, audit archive. Without it, artefacts go to Postgres with tighter retention ([T11](T11-postgres-schema.md) §4.15) |
| **Redis** | Optional | ≥ 7 (or Valkey) | Session cache, pub/sub fan-out for presence (T17 (draft)) and revocation. Without Redis: Postgres `LISTEN/NOTIFY` + per-replica caches. Fine up to about 10 API replicas. |
| KMS / Vault | Optional (a local KEK file otherwise) | — | Secret envelope encryption ([T18](T18-security.md) §4.8) |
| Model endpoint | Optional | Anthropic API, Bedrock/Vertex/Azure, or OpenAI-compatible self-hosted ([06](../product/06-ai-copilot.md) AI-044) | AI. Without one, AI features are hidden and the Stage-1 causal engine still runs. |
| IdP | Optional (local bootstrap admin otherwise) | OIDC / SAML | SSO (ENT-011, ENT-012); MFA is enforced by the IdP |
| External heartbeat receiver | Recommended | PagerDuty, Healthchecks.io-style, Better Stack | Dead-man's switch (§4.6) |

### 4.4 Helm chart

Chart `pulsus-dash`, OCI-published and signed. Values sketch:

```yaml
image: { repository: ghcr.io/…/pulsus-dash, tag: "1.4.2", digest: sha256:… }
publicUrl: https://dash.example.com
roles:                      # each becomes a Deployment (or merged into one with mode: allInOne)
  mode: split               # allInOne | split
  api:       { replicas: 3, hpa: { min: 3, max: 20, cpu: 65 }, resources: {…} }
  evaluator: { replicas: 2, shards: 32 }
  notifier:  { replicas: 2 }
  ai:        { replicas: 2, enabled: true }
  worker:    { replicas: 2 }
  render:    { enabled: true, replicas: 1, gpu: false }
postgres:   { url: { secretRef: pulsus-dash-pg, key: url }, pool: 20, external: true }   # or bundled CNPG Cluster (dev only)
redis:      { enabled: false }
objectStore: { enabled: false, kind: s3, bucket: …, secretRef: … }
kek:        { provider: awsKms, keyId: arn:… }       # awsKms|gcpKms|azureKv|vaultTransit|file
pulsusdb:   [ { name: prod, url: https://pulsusdb.example:3100, credentialsSecret: pdb-prod, tenants: [...] } ]
selfTelemetry: { enabled: true, binding: prod, tenant: pulsus-dash-self }
auditExport:   { enabled: false }                   # syslog | otlp (may be a PulsusDB tenant)
heartbeat:     { receiverSecret: pulsus-dash-heartbeat }   # deployment Watchdog receiver
airGapped:  false
ingress:    { className: nginx, tls: { secretName: … } }   # headers are NOT configured here (set by binary)
networkPolicy: { enabled: true }                            # egress only to PG, Redis, PulsusDB, KMS, allowlisted hosts
```

Templates included:
- a `Deployment` per role, each with a `PodDisruptionBudget` (`minAvailable: 1`, api
  `maxUnavailable: 25%`);
- topology spread across zones;
- a `ServiceMonitor` (optional);
- a **migration `Job`** as a `pre-install,pre-upgrade` hook (§4.5);
- a `NetworkPolicy`;
- `ConfigMap` (`dash.toml`) + `Secret` references.

#### T19-006 — Readiness does not depend on PulsusDB
**MUST** — Probes MUST be:
- `/healthz` (liveness): the process only;
- `/readyz`: Postgres reachable and the migration level compatible. It MUST NOT check PulsusDB: an
  unreachable PulsusDB must not take the UI down, because users still need alert state, silences,
  alert history and investigations, all of which are in Postgres;
- `/startupz`: true once warm caches are loaded.

### 4.5 Zero-downtime upgrades & schema migrations

```
 release N running ──► helm upgrade ──► pre-upgrade Job: `pulsus-dash migrate` (expand-only, advisory-locked)
                                          │  schema now N+1-compatible; N still works (T11 T11-012)
                                          ▼
                       rolling update per role (maxSurge 25 %, maxUnavailable 0)
                         api: drain = stop accepting, finish streams ≤ 30 s, WS close 1012 "service restart"
                         evaluator: release shard leases on SIGTERM → peers pick up within 1 eval interval
                         worker: release job leases; partition maintenance resumes from its cursor
                                          ▼
                       release N+1 everywhere ──► later release N+2 runs the contract migrations
```

#### T19-007 — Migrations run before the roll, expand-only
**MUST** — Schema migrations MUST run in the pre-upgrade Job ([T11](T11-postgres-schema.md)
T11-015) and be expand-only for release N+1; contract migrations MUST be delayed by one release so
`helm rollback` to N works. API and schema compatibility is N ↔ N+1, and a replica refuses to start
against a schema older than its minimum, or newer than its maximum plus 1.

#### T19-008 — Graceful drain and lease release
**MUST** — On `SIGTERM` a replica MUST stop accepting requests, finish streams for ≤ 30 s, close
WebSockets with 1012, and release every lease it holds (shards, dispatch, jobs), so peers take over
without waiting for expiry and two evaluators never both notify for one shard (fencing,
[T16](T16-alert-evaluator.md) T16-006).

- **Browser clients:**
  - every API response carries `X-Pulsus-Build: <version>`;
  - the WASM app compares it with its own build and, on mismatch, shows a non-blocking "Pulsus
    updated, reload" toast. The reload preserves Context, because the URL holds it
    ([02](../product/02-information-architecture.md) IA-022);
  - if the API returns `409 client-too-old` for a removed endpoint (only possible after N+2), the
    toast becomes mandatory;
  - lazy-loaded modules from the old build stay fetchable (T19-004).
- **WebSocket/streams:** clients reconnect with jittered backoff (base 250 ms, maximum 10 s), and
  streaming queries resume via [T04](T04-wire-format-and-data-plane.md) chunk cursors.

### 4.6 HA topology

```
                 ┌──────────── L7 LB / Ingress (TLS, HTTP/2, WS) ─────────────┐
                 ▼                         ▼                          ▼
          api ×3..20 (zone a/b/c)   notifier ×2   ai ×2   worker ×2   evaluator ×2..N (32 shards)
                 │  │                    │                              │
                 │  └── Redis (opt., Sentinel/cluster) ◄── pub/sub ─────┤
                 ▼                                                      ▼
   Postgres primary (zone a) ══sync══ standby (zone b) ── async ── standby (zone c) / PITR archive
     (config + live alert state + all derived state)
                 │
                 ▼
   PulsusDB readers (per binding) ◄── reads; writes: OTLP self-telemetry (+ audit export if configured)
   Object store (optional, regional, versioned bucket)       KMS (regional)
   External heartbeat receiver ◄── Watchdog via evaluator → notifier
```

#### T19-017 — No sticky sessions
**MUST** — No role MAY require sticky sessions. Sessions live in Postgres/Redis, and WS presence is
fanned out via pub/sub, so losing a replica loses no session (ENT-029).

- **Failure domains:**
  - loss of a zone → the remaining API replicas take traffic. HPA headroom is sized so two zones
    carry peak load.
  - Postgres failover takes ≈ 30 s, with writes paused ([T11](T11-postgres-schema.md) §9).
  - PulsusDB down → UI shell, alert state, alert history, silences and investigations stay up. Data
    viewports show "PulsusDB unreachable", and evaluators mark rules `Error`, which notify per error
    policy.
- **Heartbeat** ([07](../product/07-alerting.md) ALR-070): each org's Watchdog, and a
  **deployment Watchdog** in the system org for the operator, traverse evaluator → dispatcher →
  delivery worker and reach an *external* receiver ([T16](T16-alert-evaluator.md) T16-018). That is
  the only signal that survives a total Dash outage.

### 4.7 Sizing guide

These are **planning estimates, to be validated by [T05](T05-testing-and-performance.md) load
tests** (`bench:pg-derived-state`, `bench:sizing-profiles`) before GA.

| Profile | Users (concurrent) | Entities | Alert instances | Deployment | Postgres (compute) |
|---|---|---|---|---|---|
| **S** (team) | ≤ 50 (10) | ≤ 2k | ≤ 5k | `allInOne` ×1 (×2 for HA), 2 vCPU / 4 GiB | 2 vCPU / 8 GiB |
| **M** (department) | ≤ 500 (80) | ≤ 10k | ≤ 50k | api ×3 (2 vCPU / 4 GiB), evaluator ×2, notifier ×2, ai ×2 (2 vCPU / 4 GiB), worker ×2 (2 vCPU / 4 GiB) | 4–8 vCPU / 32 GiB, 1 sync standby |
| **L** (enterprise) | ≤ 5k (600) | ≤ 50k | ≤ 500k | api ×8–20 (4 vCPU / 8 GiB), evaluator ×4 (64 shards), notifier ×4, ai ×4, worker ×3 (4 vCPU / 8 GiB), Redis | 16 vCPU / 128 GiB, NVMe, 2 standbys |

#### T19-016 — Postgres sizing includes derived state
**MUST** — The sizing guide and `pulsus-dash config check` MUST size Postgres for derived state at
the org's retention classes, not only for configuration. `config check` reports the projected
volume per domain from current entity and instance counts and warns when free disk is below
2 × the projected 30-day growth.

**Table 4.7 — Postgres storage by profile at default retention** (from
[T11](T11-postgres-schema.md) Table 6.2; data + indexes)

| Domain (default retention) | S | M | L |
|---|---|---|---|
| Alert history: transitions + deliveries (13 months) | 1.3 GB | 12.5 GB | 125 GB |
| Anomaly scores + baselines (30 days) | 2.4 GB | 12 GB | 59 GB |
| Fallback pyramid tiles (7 days; only when R4 is absent) | 1.5 GB | 7.4 GB | 37 GB |
| Entity change events (90 days) and evaluation stats (30 days) | 0.3 GB | 1.3 GB | 7 GB |
| Config, content, audit (13 months), investigations | 3 GB | 15 GB | 60 GB |
| **Subtotal** | ≈ 8.5 GB | ≈ 48 GB | ≈ 290 GB |
| With 1.5× headroom (bloat, one extra partition per class, retention moves) | ≈ 13 GB | ≈ 72 GB | ≈ 430 GB |
| **Provisioned disk** (adds WAL, ≥ 2× headroom for growth and `VACUUM`) | **30 GB** | **150 GB** | **1 TB** |
| Investigation artefacts without object storage | + 10 GB | + 50 GB | + 250 GB (object storage strongly recommended) |

Longer retention classes scale linearly: alert history at 25 months roughly doubles its row; anomaly
data at 90 days triples its row.

**Postgres write and connection load** (L profile):
- alert instance upserts ≤ 1.7k/s at 50k instances per 30 s (changes only, [T11](T11-postgres-schema.md)
  §4.6), proportionally more at L when many instances change;
- anomaly open-hour upserts ≈ 670/s and hour-block inserts ≈ 55/s; transitions ≈ 3/s on average with
  incident bursts of ~1k/s;
- `max_connections` ≥ (replicas × pool) + 20, or PgBouncer (transaction mode) in front;
- `autovacuum` tuned for `alert_instances` and `anomaly_scores_open` (HOT-update heavy:
  `autovacuum_vacuum_scale_factor = 0.02` on those tables).

Rules of thumb (assumptions to verify):
- **API CPU** is dominated by JSON → Arrow conversion until R1 lands
  ([ADR-0005](../adr/0005-arrow-wire-format.md)). Budget about 1 vCPU per 15 concurrent active users
  exploring; after R1, about 1 per 40. Virtual-source queries over alert history add little; budget
  0.5 vCPU per 100 concurrent history viewports.
- **API memory:** 1 GiB base + query buffers capped at 256 MiB per in-flight scene (the T07 budget).
- **Evaluator:** about 1 vCPU per 2k rule-queries per minute. Most of the time is spent waiting on
  PulsusDB, so concurrency matters more than CPU.
- **Worker:** the anomaly sweep is about 1 vCPU per 10k entity × signal series at a 30 s cadence;
  the fallback pyramid builder (R4 absent) about 1 vCPU per 5k entities.

### 4.8 SaaS multi-tenant vs self-hosted

| | Self-hosted | SaaS |
|---|---|---|
| Orgs per deployment | Usually 1 (multi-org supported) | Many orgs per **cell** |
| Unit | One Helm release | **Cell** = Dash deployment + Postgres cluster + optional object bucket + ≥ 1 PulsusDB cluster, in one region |
| Tenancy into PulsusDB | Customer's `X-Scope-OrgID` / `X-Pulsus-Database` choices | One `X-Scope-OrgID` per Dash org (opaque `o_<ulid>`), on shared cell PulsusDB clusters; dedicated databases for large orgs via `X-Pulsus-Database` (retention is per database in PulsusDB) |
| Derived state | In the deployment's Postgres | In the cell's Postgres; per-org retention classes ([T11](T11-postgres-schema.md) §4.11); the cell's Postgres is sized as the sum of its orgs' profiles |
| Routing | — | Global edge (`<org>.pulsus.cloud`) → cell via a routing table. Org placement is sticky and its region is chosen at signup (data residency). |
| Isolation | — | Row-level + RLS ([T11](T11-postgres-schema.md) §4.1); per-org query, AI and notification quotas; **dedicated cell** option for regulated customers |
| Noisy neighbours | — | Per-org concurrency limits in the planner ([T07](T07-scene-query-planner.md)), per-org evaluator shard weighting, PulsusDB 422/429 bounds |
| Org move | `export`/`import` | Cell-to-cell migration via logical export + per-org `COPY` of derived state ([T11](T11-postgres-schema.md) §4.12) (manual runbook in v1) |
| Upgrades | Customer-driven, N ↔ N+1 | Canary cell → 10 % → all, 1 release/week; feature flags per org |
| Identity | Customer IdP | Per-org IdP config; SCIM per org; a Dash-operated login for trials |

### 4.9 Configuration

- **Sources and precedence** *(revised 2026-11-20, #59; [T06](T06-bff-architecture.md) §4.9)*:
  defaults < one YAML file (`--config`) < env `PULSUS_DASH_<KEY_PATH>` (the key path upper-cased,
  `.` → `_`, for example `PULSUS_DASH_SERVER_LISTEN`) < CLI flags (`--role`). It is validated
  strictly (T06-019) by `pulsus-dash config check --for serve|migrate`, which resolves the Postgres
  references but connects to nothing.

#### T19-010 — Secrets in config are references
**MUST** — *(Revised 2026-11-20, #59.)* Secret values in static config MUST be references: a
`*_ref` key whose value is `env:NAME` or `file:/absolute/path` (`vault://…` is reserved and refused
until it is supported). Literal secrets MUST be refused unless `allow_inline_secrets: true` is set
(dev only). After the first-run seed, the tenant binding in Postgres, including its credentials
reference, is authoritative, and later configuration values for the seed are ignored. A resolved
secret MUST NOT be stored or logged.

- **Static versus dynamic.** Static config covers listeners, Postgres, KEK, roles, public URL, asset
  mode, self-telemetry, audit export and air-gapped mode. Everything per org (IdPs, bindings, AI
  provider, policies, retention classes) is **dynamic**, lives in Postgres and is edited in Admin
  rooms. Bootstrap can seed it from a `provisioning/` directory of YAML ([T11](T11-postgres-schema.md)
  §4.9).
- **Required PulsusDB configuration** (preflight-checked by `config check` against each binding):
  - `PULSUS_AUTH_USER`/`PASSWORD` set; TLS or mTLS on the path;
  - admin routes not reachable from Dash's network or not on default credentials (api.md §7 says the
    default is `admin`/`admin`);
  - `PULSUS_COMPAT_ENDPOINTS` not required;
  - **PulsusDB ingest is not required** for any Dash feature (ALR-087); ingest is needed only on the
    binding that receives self-telemetry, and on an audit-export tenant if one is configured;
  - the ruler enabled only if the operator opts into PulsusDB recording rules (the R4 rule pack, or
    the SLO accelerator of [T16](T16-alert-evaluator.md) §4.1); otherwise Dash's own fallbacks write
    their results to Postgres.

```toml
[server]   public_url = "https://dash.example.com"   listen = "0.0.0.0:8080"   roles = ["all"]
[postgres] url_file = "/var/run/secrets/pg/url"   pool = 20
[assets]   mode = "embedded"   # | "cdn"; base_url = "…"
[kek]      provider = "file"   path = "/var/run/secrets/kek/key"
[egress]   mode = "allowlist"  proxy = ""   allow_private = ["10.20.0.0/16"]
[ai]       enabled = true      # provider configured per org in Admin
[selftelemetry] otlp_endpoint = "https://pulsusdb.example:3100"  tenant = "pulsus-dash-self"  sample_traces = 0.05
[audit_export]  enabled = false   # kind = "otlp" | "syslog"; endpoint = "…"; tenant = "…"
[airgapped] enabled = false
```

### 4.10 Dash self-observability

#### T19-011 — Dash writes to PulsusDB only self-telemetry and the audit export
**MUST** — The only PulsusDB write paths in the binary MUST be (a) the self-telemetry OTLP exporter
and (b) the audit export sink when `[audit_export]` is enabled with an OTLP PulsusDB target. No
derived state (alert history, `ALERTS`, anomaly scores, baselines, change events, pyramids) MAY be
written to PulsusDB ([ADR-0012](../adr/0012-derived-state-in-postgres.md)). A CI test runs the
storyboard and the alerting suite against a recording PulsusDB proxy and asserts this
(`itest:no-pulsusdb-writes`).

- **Instrumentation:** `tracing` + `tracing-opentelemetry` + `opentelemetry-otlp` export traces,
  metrics and logs **over OTLP to PulsusDB**. The target defaults to the first binding with tenant
  `pulsus-dash-self`, which can be a separate binding or a separate PulsusDB.
- **Resource attributes:** `service.name=pulsus-dash`, `service.namespace=pulsus`,
  `service.version`, `pulsus.role`, `k8s.*`. Dash therefore appears in its own Atlas as an entity.
- **Correlation:** every PulsusDB call is a client span carrying the `X-Pulsus-Query-Id` response
  header as a span attribute, so a slow viewport can be traced to ClickHouse statements (PulsusDB
  writes the id as `log_comment`).

#### T19-018 — Metrics only on the admin port
**MUST** — The Prometheus `/metrics` endpoint MUST be exposed only on a separate admin port
(default 9090), never on the public listener or through ingress.

- **Browser telemetry (RUM-lite):** the WASM app batches frame-time p50/p99, long tasks, cold-load
  phases, renderer tier, WebGPU adapter info and errors, and sends them to `POST /api/dash/v1/rum`.
  The BFF stamps the org (hashed user) and forwards over OTLP as self-telemetry. Sampling is 10 % of
  sessions by default, and the feature can be switched off per org. This is how the
  [09](../product/09-performance-contract.md) contract is observed in the field.
- **Shipped content** (installed by the `worker` role at bootstrap, versioned like any content,
  `source='provisioning'`):
  - Board "Pulsus Dash: overview": request rate/latency per route, Arrow bytes/s, planner queue,
    PulsusDB latency and errors by endpoint, `query_too_broad` rate, cache hit rate, WS connections;
  - Board "Alerting pipeline": eval lag per shard, rules in Error, missed evaluations,
    notifications sent/failed per integration, delivery latency, heartbeat age;
  - Board "Postgres & derived state": size per retention domain and class, partition horizon,
    retention job lag, replication lag, connection use;
  - Board "AI": runs, tokens, cost, latency, budget exhaustion;
  - Board "Client experience": frame-time p99 by tier, cold-load p75;
  - **Alert pack**:
    - evaluator lag > 2 intervals;
    - contact point failure ratio > 20 % over 10 min;
    - scope violations > 0 (T10 (draft));
    - audit export backlog > 1 h;
    - KEK unwrap failures;
    - Postgres replication lag > 30 s;
    - partition horizon < 1 grain ([T11](T11-postgres-schema.md) T11-021);
    - Postgres free disk < 2 × projected 30-day derived-state growth (T19-016).

#### T19-012 — Self-telemetry never blocks
**MUST** — If the self-telemetry target is down, self-telemetry MUST be buffered (bounded at
50 MiB, then dropped with a counter) and MUST NOT block or slow any request, evaluation or delivery.

#### T19-013 — Dash-about-Dash alerts avoid recursion
**MUST** — Alerts about Dash itself MUST route via the external heartbeat and a `fallback` contact
point that does not depend on the failing component; the alert pack's rules are ordinary rules on
the self-telemetry binding, so they degrade to `Error` (and the heartbeat still runs) when that
binding is down.

### 4.11 Air-gapped installs

#### T19-014 — Air-gapped profile
**MUST** — `airgapped.enabled = true` MUST set `egress.mode = deny` ([T18](T18-security.md)
T18-021) except for explicitly configured internal hosts (IdP, PulsusDB, model endpoint, Git server,
contact points), and MUST disable update checks, vendor telemetry, external fonts and CDNs (assets
embedded) and external avatars. No feature MAY attempt an outbound connection outside the
allowlist.

- **Offline basemap** for Geomap ([05](../product/05-visualisation-catalogue.md) §7):
  - bundled low-zoom country/region outlines (GeoJSON from Natural Earth, public domain), about 2
    MB, enough for the minimal basemap in [T02](T02-vis-engine.md);
  - optional **PMTiles** vector-tile archive (e.g. an OpenStreetMap-derived extract; licence
    obligations such as ODbL attribution apply) uploaded by the admin and served by the BFF with
    range requests;
  - a cloud-region gazetteer bundled.
- **Self-hosted model endpoint:** an OpenAI-compatible API (e.g. vLLM, TGI or Ollama-class servers;
  capability not verified per product) configured per org (AI-045). An embedding model is needed for
  similar-incident retrieval, or the feature falls back to full-text search
  ([T11](T11-postgres-schema.md) §4.7). The AI evaluation harness (T15 (draft)) can be run on site to
  show expected quality with the chosen model.
- **Distribution:** an offline bundle (`pulsus-dash-<ver>-airgap.tar`) contains:
  - OCI images (`skopeo`-compatible layout);
  - the Helm chart;
  - cosign signatures + public key for offline verification;
  - SBOMs;
  - the basemap pack.

  Mirror instructions cover Harbor, Artifactory and plain registries.
- tzdata and fonts are embedded. Vis modules come from a local registry only.
- Postgres needs no extension (T11-001), so air-gapped installs on a hardened, extension-less
  Postgres are supported.

### 4.12 Backup

| What | How | Restore notes |
|---|---|---|
| Postgres | PITR (WAL + base backups) per [T11](T11-postgres-schema.md) §4.12; RPO ≤ 5 min, RTO ≤ 30 min (≤ 60 min at L with storage snapshots) | Holds **all** alert state and history and all derived state; the evaluator reconciles alert state from `alert_transitions` on start |
| KEK | Lives in KMS/Vault (their own backup). File-KEK installs must back up the key **separately** from the database. | Without the KEK, secrets are unrecoverable by design. Contact points must be re-entered. |
| Object store (if used) | Bucket versioning + lifecycle; cross-region replication for SaaS | References in Postgres; missing objects degrade to "snapshot unavailable" |
| Config-as-code | Git sync `push` mode or nightly `pulsus-dash export` per org | Org-level restore or migration |
| PulsusDB | Out of scope (PulsusDB/ClickHouse backup) | Holds only Dash self-telemetry and, if configured, an audit copy; nothing Dash needs to restore |

Restore drills run quarterly in SaaS, and the runbook ships for self-hosted installs.

### 4.13 Licence and plan limits

The repository is **AGPL-3.0** (decision D3), so every deployment runs the same build with every
feature enabled. A neutral hook remains for SaaS plan limits only:

```rust
pub struct Entitlements { pub edition: Edition, pub features: BitSet<Feature>, pub limits: Limits,
                          pub expires_at: Option<DateTime<Utc>>, pub licensee: String }
pub fn entitled(f: Feature) -> bool;   // constant true in self-hosted builds
```

- **Self-hosted and air-gapped:** `Entitlements` is constant (`Edition::Community`, everything
  enabled). There is no licence file and nothing phones home.
- **SaaS:** `limits` carry plan quotas (users, bindings, AI tokens/month, retention classes on
  offer), read from the cell's control plane.

#### T19-015 — Limits never stop the data plane
**MUST** — Reaching a plan limit or an expired plan MUST NOT stop alert evaluation, notification
delivery, the heartbeat, or read access to existing boards, alert history and investigations; it
MAY block *new configuration* of the limited feature after a 30-day grace period, with a banner.

## 5. Interfaces

- CLI surface (§4.1); Helm values schema (`values.schema.json`); TOML config schema (generated with
  `schemars`); probes `/healthz`, `/readyz`, `/startupz`; admin port `/metrics`; `POST
  /api/dash/v1/rum`; header `X-Pulsus-Build`.
- **Cross-doc interfaces:**
  - **[T06](T06-bff-architecture.md)** maps its modules onto the five roles (§4.1). Role names
    follow T06 (`all`, `api`, `worker`, `evaluator`, `notifier`, `ai`).
  - **[T16](T16-alert-evaluator.md)** uses the Postgres lease + fencing primitive
    (`rule_shard_leases`); no Kubernetes Lease RBAC is needed. Its Watchdog provides the heartbeat.
  - **T17 (draft)** gets Redis pub/sub when present, with a Postgres `LISTEN/NOTIFY` fallback.
  - **[T03](T03-browser-runtime.md)** relies on the binary setting COOP/COEP/CSP, same-origin
    workers, and asset paths from `asset-manifest.json`.
  - **[T04](T04-wire-format-and-data-plane.md)** relies on reconnection and resume across replica
    restarts.
  - **[T05](T05-testing-and-performance.md)** validates the §4.7 sizing tables.
  - **[T18](T18-security.md)** provides header values, KEK providers, the egress policy and
    signing.
  - **[T11](T11-postgres-schema.md)** provides the migration runner contract (§4.5) and the
    derived-state volumes (§4.7).

## 6. Data & storage

See §4.3 and §4.12. Each replica keeps only caches in memory: grants, compiled scopes, DEKs ≤ 1 h, a
query result cache ([T07](T07-scene-query-planner.md)), the alert-set feed state and asset bytes.
Nothing on local disk is authoritative. The root filesystem is read-only, and `/tmp` is an
`emptyDir` with a size limit. All durable state (configuration, live alert state, alert history and
all other Dash-derived state) is in Postgres, plus optional object storage for large artefacts.

## 7. Performance budget

| Metric | Target |
|---|---|
| Process start to ready (api) | < 2 s (embedded assets are memory-mapped; caches warm lazily) |
| `index.html` + manifest TTFB | < 50 ms at the BFF |
| Core WASM transfer (brotli) | < 3 MB ([09](../product/09-performance-contract.md) PRF-009); served from memory with `immutable` caching |
| Graceful drain | ≤ 30 s |
| Evaluator shard failover | ≤ 1 eval interval + 10 s (immediate on graceful release) |
| Rolling upgrade of an M deployment | < 10 min, with no failed user requests beyond WS reconnects |
| Partition maintenance run (L) | < 60 s per cycle, off-peak drops |

## 8. Security, tenancy & RBAC

- Pod security: non-root, read-only root filesystem, dropped capabilities, `seccompProfile:
  RuntimeDefault`.
- NetworkPolicy with default-deny egress.
- Secrets mounted as files.
- The admin metrics port is not exposed through ingress (T19-018).
- Postgres roles `pulsus_app` and `pulsus_maint` use separate credentials and pools
  ([T11](T11-postgres-schema.md) §4.1); only the migration Job holds `pulsus_owner`.
- The tenancy strategy is in §4.8 and [T11](T11-postgres-schema.md) §4.1. Security controls are in
  [T18](T18-security.md).

## 9. Failure modes & degradation

| Failure | User-visible behaviour |
|---|---|
| PulsusDB binding down | Viewports "PulsusDB unreachable"; alerts → `Error` per policy; alert history, silences and investigations stay available; UI otherwise functional |
| PulsusDB ingest disabled | No effect on any feature; self-telemetry buffers then drops (T19-012) |
| Postgres down | Reads from caches ≤ 5 min, then "configuration store unavailable". Alert evaluation continues in memory, but transitions cannot be committed and nothing is notified; the heartbeat stops, so the external dead-man's switch pages ([T16](T16-alert-evaluator.md) §9) |
| Postgres disk pressure | Alert at < 2 × projected growth; pyramid tiles are the first domain shed (regenerable) |
| Redis down | Fallback to Postgres notify; presence may lag a few seconds |
| Render worker down | Notifications sent without chart images, with a note in the message |
| Ingress strips COOP/COEP | App starts in non-SAB fallback mode and an admin banner names the cause |
| Version skew (browser older than N+1) | Reload toast; mandatory reload only after N+2 |

## 10. Testing

- `helm lint`, `kubeconform` and chart unit tests (`helm-unittest`).
- `e2e:helm-default-install`: default values on kind → the application shell served as the fixed local principal (no login page until M-UI6, D12).
- Kind-based end-to-end tests: install → upgrade N→N+1 under synthetic load
  ([T05](T05-testing-and-performance.md)), asserting zero 5xx beyond drain, no duplicate
  notifications, and browsers on N continuing to work (`e2e:upgrade-lazy-module`).
- `chaos:replica-kill`: kill one of three replicas during evaluation; no missed interval, no
  duplicate notification, sessions continue.
- `itest:airgap-no-egress`: a cluster with egress fully blocked must pass the full smoke suite with
  zero denied-connection logs other than expected probes.
- `itest:no-pulsusdb-writes`: recording PulsusDB proxy (T19-011).
- `bench:pg-derived-state` and `bench:sizing-profiles`: S/M/L synthetic estates for 24 h; measured
  Postgres size and write rates are compared to Table 4.7 and the table is corrected before GA.
- Restore drill automation (`drill:pitr-restore`): PITR to a new cluster, then verify the audit hash
  chain, secrets decryption with the KEK, and alert-state reconciliation.

## 11. Rollout

| Milestone | Ships |
|---|---|
| M-UI1 | Static binary, embedded assets with correct headers, `pulsus-dash` image, Helm chart (`allInOne`), migration Job, basic OTLP self-traces |
| M-UI4 | Split roles, evaluator leases, render worker image, self-observability boards and alerts, heartbeat, derived-state sizing and the Postgres board, `config check` volume projection |
| M-UI5 | CDN mode, previous-assets embedding, sizing validation |
| M-UI6 | Air-gapped bundle and profile, offline basemap pack, SaaS cells and routing, plan-limit hook, signed chart |

## 12. Alternatives considered

- **Separate binaries per role:** more artefacts and version skew between them. Roles by flag give
  the same isolation with one build.
- **Nginx sidecar for static assets and headers:** risks losing COOP/COEP in configuration drift.
  The binary owns its headers.
- **Kubernetes operator instead of Helm:** deferred. Helm plus a migration Job covers v1. An operator
  may help SaaS cell management later.
- **SQLite for single-node installs:** rejected. One storage engine
  ([ADR-0006](../adr/0006-pulsusdb-and-postgres.md)); small installs can use a bundled CNPG single
  instance.
- **A separate Postgres (or a time-series store) for derived state:** rejected for v1. One Postgres
  keeps backup, PITR and RLS in one place; the L profile's ≈ 1 TB is within a single well-run
  primary. A dedicated derived-state database can be introduced later behind `dash-store` without
  changing the schema.
- **Licence-file entitlement checks** (the draft's open-core option): unnecessary since D3 chose
  AGPL-3.0.

## 13. Open questions

1. Should the render worker eventually move into the `notifier` image with a software renderer only
   (`wgpu` + lavapipe) to drop an image? This depends on Mesa size and security review.
2. Should SaaS orgs share PulsusDB clusters per cell (tenant via `X-Scope-OrgID`), or should each
   paying org get a database (`X-Pulsus-Database`) for per-org retention? Leaning: shared by default,
   a database for enterprise tiers.
3. Is a desktop build (native renderer, [ADR-0001](../adr/0001-rust-wasm-everywhere.md)
   consequence) in scope for packaging? Not in v1.
4. The Table 4.7 volumes rest on T11's transition-rate assumption (0.5 per instance per day); design
   partners' Alertmanager history should confirm it before GA.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft; Postgres sizing includes derived state per ADR-0012; formal design rules; Satisfies table |

**Changes versus the draft:**
1. **Postgres sizing (ADR-0012).** The draft sized Postgres for configuration only (20 / 100 /
   500 GB). Table 4.7 adds alert history, anomaly data, fallback pyramids and change events from
   [T11](T11-postgres-schema.md) §6.2, raising provisioned disk to 30 GB / 150 GB / 1 TB and Postgres
   memory to 8 / 32 / 128 GiB; T19-016 makes `config check` project it.
2. **PulsusDB writes.** The dependency table, HA diagram and backup table no longer mention alert
   history write-back or alert/audit copies in PulsusDB. T19-011 limits writes to self-telemetry and
   the opt-in audit export; PulsusDB ingest is not required.
3. **Postgres failure** now matches T16: with Postgres down nothing is notified and the heartbeat
   stops (the draft queued notifications in memory).
4. **Heartbeat** goes through the full evaluator → notifier path, with a deployment Watchdog for the
   operator.
5. **Licence (D3).** The licensing hook for an open-core option is reduced to SaaS plan limits; the
   draft's Q8 open question is closed.
6. **Postgres extensions:** none required (the draft listed `ltree`, `btree_gist`, `pg_trgm`); object
   storage is optional, not "required for > 1 replica".
7. The `worker` role gains the derived-state jobs (anomaly sweep, baselines, change events, pyramid
   builder, retention classes).
| 1.1-rc | 2026-11-19 | [ADR-0015](../adr/0015-go-bff.md): Go static build (`CGO_ENABLED=0`), `embed.FS` assets (T19-003), the chart renderer is a separate Rust binary (T19-001 exception, §4.2), no SAML glibc variant |
| 1.2-rc | 2026-11-19 | #56 code review: CDN mode serves only the engine WASM, fonts and tiles; all JS, CSS and workers stay same-origin ([T18](T18-security.md) T18-006); T19-005 adds per-file start-up verification of every embedded asset, fail closed, and hashing of every CDN file |
| 1.3-rc | 2026-11-19 | ADR-0016 (Accepted): asset integrity is verified by the BFF at start-up, per file, fail closed; no per-module integrity in the browser |
| 1.4-rc | 2026-11-19 | Review r6 of #56: CDN-mode wording aligned with ADR-0016 (engine WASM is the one executable asset the CDN may serve); detached `asset-manifest.sig` verified with the compiled-in Ed25519 public key; only the manifest and its signature are exempt from listing |
| 1.5-rc | 2026-11-20 | #59 Part A: T19-010 revised (`*_ref` keys with `env:NAME` or `file:/absolute/path`, `vault://` later; the seeded binding in Postgres, with its credentials reference, is authoritative); §4.9 sources aligned with T06 §4.9 (YAML file, `PULSUS_DASH_<KEY_PATH>`, `config check` connects to nothing); D12: the ENT-028 Helm gate expects the application shell, not a login page |
| 1.6-rc | 2026-11-20 | #59 Part B: T19-002 names the optional `server.public_url` and its one 2 s self-check request after the listener opens; T19-005: a binary built without embedded assets refuses to serve, and `serve --api-only` is a development-only mode that serves no client ([ADR-0016](../adr/0016-asset-integrity-verified-by-bff.md) unchanged) |
| 1.7-rc | 2026-11-20 | #59 Part C: the example PulsusDB URLs in §4.4 and §4.9 use the reserved `pulsusdb.example` name, so `ci:no-pulsusdb-host` ([T05](T05-testing-and-performance.md) §7.1) passes on every tracked file |
