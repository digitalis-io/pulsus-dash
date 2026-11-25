# Pulsus Dash — Formal design

> **Status:** Review baseline v1.0-rc (2026-11-18); client and BFF technology changed on 2026-11-19
> (D7, D8), and the product requirements and technical designs aligned with D7–D9 on the same day.
> This folder holds the **formal, version-controlled design**. Working drafts and research live in
> `plans/`, which is local and not tracked. A design is promoted from `plans/` into here once its
> blocking decisions are made.

| Folder | Contents |
|---|---|
| [`product/`](product/) | The product and UX specification: what people see and do, as numbered requirements with acceptance criteria |
| [`technical/`](technical/) | Technical designs: how it is built. Each one traces to the product requirements it satisfies |
| [`adr/`](adr/README.md) | Architecture Decision Records |
| [`mockups/`](mockups/README.md) | SVG screen mockups referenced from the product spec |
| [`traceability.md`](traceability.md) | Generated matrix: requirement → technical design → test gate → milestone |
| [`tools/`](tools/) | Scripts that check links and IDs and generate the traceability matrix |

## 1. Conventions

### 1.1 Normative language

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT** and **MAY** follow
[RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) / [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174)
and are only normative when written in capitals. Text in a `> **Rationale:**` or
`> **Note:**` block is non-normative.

### 1.2 Requirement IDs

Every normative statement in `product/` is a requirement with a stable ID `AREA-NNN`. IDs are
never reused or renumbered. A removed requirement keeps its ID and is marked *Withdrawn*.

| Area | Product doc | | Area | Product doc |
|---|---|---|---|---|
| `PRN` | 01 Vision & principles | | `AI` | 06 AI copilot & RCA |
| `AUD` | 01a Audiences & perspectives | | `ALR` | 07 Alerting |
| `IA` | 02 Information architecture | | `VL` | 08 Visual language |
| `INT` | 03 Interaction model | | `PRF` | 09 Performance contract |
| `SRF` | 04 Surfaces | | `ENT` | 11 Enterprise |
| `VIZ` | 05 Visualisation catalogue | | `SCN` | 13 Core flow storyboard (acceptance scenarios) |
| `EST` | 15 Estate navigation | | `INF` | 16 Infrastructure model |
| — | 12 Roadmap (milestones; no requirements) | | | |

Technical designs use `Tnn-NNN` for their own design rules (e.g. `T06-014`).

### 1.3 Requirement block

```markdown
#### ALR-012 — Acknowledge from any alert view
**MUST** · M-UI4 · SRE, NOC

An operator MUST be able to acknowledge an alert from every alert view with `Shift+A` …

*Acceptance:* Given a firing alert shown in the Map view, when the operator focuses it and
presses `Shift+A`, then the alert enters Acknowledged within 1 s in every view and for every
collaborator, and the action is in the audit log.
```

- **Priority:** MUST, SHOULD or MAY.
- **Milestone:** the earliest milestone in which it MUST be met (see [12](product/12-roadmap.md)).
- **Audiences:** who it serves, using the short names NOC, SRE, Platform, Engineer, Business, Support,
  IC (incident commander) and Admin (see [01a](product/01a-audiences-and-perspectives.md)).
  The storyboard characters are Sam (SRE), Priya (Engineer) and Lee (Platform).
- **Acceptance:** observable and testable. Prefer Given/When/Then, and use numbers wherever
  [09](product/09-performance-contract.md) gives them.

### 1.4 Technical design traceability

Every technical design has a **Satisfies** table (requirement ID → section of the design that
satisfies it), plus a **Verification** column naming the test gate from
[T05](technical/T05-testing-and-performance.md).

### 1.5 Mockups

Mockups are SVG, following [mockups/README.md](mockups/README.md). They are illustrative: where a
mockup and a requirement disagree, the requirement wins and the mockup is a defect.

### 1.6 Links

Only link to files inside `designs/`, or to public URLs. Designs that are not yet formalised (still
only in `plans/`) are referred to by ID in text, e.g. "T13 (draft)", never by link. `plans/` is not
tracked in git.

### 1.7 Status and change control

**Status values:**
- **Draft:** not here; drafts stay in `plans/`.
- **Review:** in `designs/` awaiting sign-off.
- **Accepted.**
- **Implemented.**
- **Superseded.**

Changes to an Accepted doc go through review and are recorded in that doc's change log.

## 2. Decisions taken (2026-11-18 to 2026-11-20)

| # | Decision | Record |
|---|---|---|
| D1 | DOM rooms use **Leptos** | [ADR-0004](adr/0004-leptos-dom-rooms.md) **Superseded** by D7 |
| D2 | Dash-derived state (alert history, baselines, anomaly scores, change events, fallback pyramids) lives in **PostgreSQL**; Dash never writes product state into PulsusDB | [ADR-0012](adr/0012-derived-state-in-postgres.md) Accepted; ADR-0010 Rejected |
| D3 | Licence: the repository is **AGPL-3.0**, the same as PulsusDB, so reusing PulsusDB's AGPL parser crates is licence-compatible. R17 (permissive syntax crates) drops to *nice-to-have* unless a non-AGPL edition is planned | `LICENSE`; [R17](technical/pulsusdb-requirements.md) |
| D4 | Mockups are SVG | [mockups/](mockups/README.md) |
| D7 | The web client is a standard **TypeScript + React + Vite** application, built first; GPU/3D chart frames come later from one Rust/WASM engine in a worker behind a typed TS API, with an in-house Canvas 2D renderer in the meantime | [ADR-0014](adr/0014-typescript-react-web-client.md) Accepted 2026-11-19; supersedes ADR-0001 (browser), ADR-0002, ADR-0004 |
| D8 | The BFF is written in **Go** (spec-first OpenAPI, pgx + sqlc, goose, go-oidc) | [ADR-0015](adr/0015-go-bff.md) Accepted 2026-11-19; supersedes ADR-0001 (server) |
| D9 | Conventional application layout: left navigation sidebar, page header with time range, refresh and user menu top-right, roomy boards | [ADR-0014](adr/0014-typescript-react-web-client.md) §10; product requirements revised (roadmap Q13 closed, [12](product/12-roadmap.md#7-resolved-during-formalisation) item 6) |
| D10 | Asset integrity is verified by the BFF against the signed manifest before serving; every JS module, CSS file and worker is same-origin, and the one executable asset that may come from the CDN is the engine WASM, fetched with `integrity`; no per-module SRI in the browser | [ADR-0016](adr/0016-asset-integrity-verified-by-bff.md) Accepted 2026-11-19; amends ADR-0014 (lazy-chunk SRI) |
| D11 | SRF-027 shows PulsusDB's errors on run in M-UI1; pre-run byte-offset diagnostics are SRF-078 at M-UI2 | [12](product/12-roadmap.md) D11 (was Q14, option A), Accepted 2026-11-19 |
| D12 | Authentication deferred (owner, 2026-11-20): sign-in, sessions, users and roles are not built in M-UI1. ENT-001, ENT-003 and ENT-011, and their dependents ENT-002, ENT-005, ENT-010, ENT-014, ENT-015, SRF-063 and SRF-065, move to **M-UI6**; #60 is M-UI6; #61 and #62 depend on #59. Until then the BFF serves a fixed local principal ("Local user", role admin) of the bootstrap organisation | [12](product/12-roadmap.md#21-delivery-order-2026-11-19) §2.1, D12 |
| D13 | Gate sensitivity proofs (T05-002): unit, component and end-to-end gates may prove that they fail with a local regression run whose output is recorded in the PR; a CI proof PR (a `gate-proof/*` branch with a red run) is needed only for CI-specific gates (workflow and build-artefact checks) (owner, 2026-11-20) | [T05](technical/T05-testing-and-performance.md#t05-002--every-gate-is-proven-to-fail) T05-002; [12](product/12-roadmap.md#3-decisions-taken) D13 |

## 3. Assumptions

| # | Assumption | If false |
|---|---|---|
| A1 | PulsusDB raises the `service_graph` edge cap from 1 000 to **≥ 50 000** to meet the topology target ([PRF](product/09-performance-contract.md), R5) | Topology falls back to the R5 client-side aggregation path and the edge-count coverage meter shows truncation |
| A2 | Reference hardware and browsers are as listed in [09](product/09-performance-contract.md) | Performance gates are re-baselined |

## 4. Open decisions

| # | Question | Recommendation | Record |
|---|---|---|---|
| O1 | Data scopes on metrics when resource attributes are not labels | Option B: enforce on labels, fail closed per metric family, and pursue R16 with PulsusDB | [ADR-0013](adr/0013-metrics-data-scopes.md) |
| O2 | Proposed ADRs 0003 (wgpu), 0005 (Arrow), 0008 (Dash evaluator), 0009 (object storage), 0011 (Terraform in Go) | Accept. Each matches the drafts and none has a live alternative | [adr/](adr/README.md) |

## 5. Index

See the sections below. They are completed as documents are promoted.

### Product

| # | Document | Status |
|---|---|---|
| 01 | [Vision & principles](product/01-vision-and-principles.md) | Review |
| 01a | [Audiences & perspectives](product/01a-audiences-and-perspectives.md) | Review |
| 02 | [Information architecture](product/02-information-architecture.md) | Review |
| 03 | [Interaction model](product/03-interaction-model.md) | Review |
| 04 | [Surfaces](product/04-surfaces.md) | Review |
| 05 | [Visualisation catalogue](product/05-visualisation-catalogue.md) | Review |
| 06 | [AI copilot & RCA](product/06-ai-copilot.md) | Review |
| 07 | [Alerting](product/07-alerting.md) | Review |
| 08 | [Visual language](product/08-visual-language.md) | Review |
| 09 | [Performance contract](product/09-performance-contract.md) | Review |
| 11 | [Enterprise](product/11-enterprise.md) | Review |
| 12 | [Roadmap](product/12-roadmap.md) | Review |
| 13 | [Core flow storyboard](product/13-core-flow-storyboard.md) | Review |
| 15 | [Estate navigation](product/15-estate-navigation.md) | Review |
| 16 | [Infrastructure model: clouds, Kubernetes and generic components](product/16-infrastructure-model.md) | Review |

### Technical

| # | Document | Status |
|---|---|---|
| T01 | [Frontend architecture](technical/T01-frontend-architecture.md) | Review |
| T02 | [Vis engine](technical/T02-vis-engine.md) | Review |
| T03 | [Browser runtime & JS shim](technical/T03-browser-runtime.md) (applies to the later chart engine, ADR-0014) | Review |
| T04 | [Wire format & data plane](technical/T04-wire-format-and-data-plane.md) | Review |
| T05 | [Testing & performance engineering](technical/T05-testing-and-performance.md) | Review |
| T06 | [BFF service architecture](technical/T06-bff-architecture.md) (Go since ADR-0015) | Review |
| T07 | [Scene query planner](technical/T07-scene-query-planner.md) | Review |
| T08 | [DOM rooms & component kit](technical/T08-dom-component-kit.md) (TS/React since ADR-0014) | Review |
| T09 | [Query editors](technical/T09-query-editors.md) | Review |
| T11 | [Postgres schema & config lifecycle](technical/T11-postgres-schema.md) | Review |
| T12 | [Entity catalogue & graph service](technical/T12-entity-catalogue.md) | Review |
| T16 | [Alert evaluator & notification service](technical/T16-alert-evaluator.md) | Review |
| T18 | [Security](technical/T18-security.md) | Review |
| T19 | [Deployment & operations](technical/T19-deployment.md) | Review |
| T22 | [Value, categorical and table panels](technical/T22-value-categorical-and-table-panels.md) | Review |
| — | [PulsusDB requirements](technical/pulsusdb-requirements.md) | Sent; rev. 5 (2026-11-19) records the Go and TS stack change |

**Not yet promoted:** these remain drafts in `plans/tech/`.
- T10 auth & data scopes (blocked on O1);
- T13 local analytics engine;
- T14 layout engines;
- T15 AI/RCA/MCP;
- T17 collaboration;
- T20 mobile PWA.

They are later milestones (M-UI2 and up).
