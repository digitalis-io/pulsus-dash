# 12 — Roadmap

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.7-rc · 2026-11-20 |
| **Requirement area** | — (milestones; no requirements) |
| **Source draft** | plans/12-roadmap-and-open-questions.md (not tracked) |
| **Depends on** | [01a](01a-audiences-and-perspectives.md), [05](05-visualisation-catalogue.md), [09](09-performance-contract.md), [15](15-estate-navigation.md), [designs README](../README.md), [ADR index](../adr/README.md) |
| **Mockups** | — |

## 1. Purpose & scope

This document defines the UI milestones M-UI0 to M-UI6 that every requirement's milestone field
refers to, records the decisions taken and the assumptions made, and lists the questions still open
with pointers to their records. It contains no requirements of its own.

Each milestone is sliced so that it is demoable against the validation scenario in
[01a](01a-audiences-and-perspectives.md) §8 (AUD-050) and proves a risky assumption early. A
requirement's milestone is the earliest milestone in which it MUST be met.

## 2. UI milestones

| Milestone | Theme | Scope | Proves |
|---|---|---|---|
| **M-UI0** | Rendering spike | wgpu line chart + scatter in an OffscreenCanvas worker behind the typed TS engine API ([ADR-0014](../adr/0014-typescript-react-web-client.md)); Arrow decode; 10⁸-point pan/zoom; WebGPU + WebGL2. Delivered **after** the first M-UI1 slice (§2.1) | The performance contract is achievable in Rust/WASM ([09](09-performance-contract.md)) |
| **M-UI1** | PromQL and LogQL query and boards, then the metrics workbench | **First (delivery order §2.1):** TS/React application with the conventional layout, Go BFF (JSON frames to the client until the engine), OIDC login, PulsusDB client for metrics and logs, PromQL and LogQL editors (PulsusDB validates), auto-vis, minimal Boards (grid of panels, save/load in Postgres), metrics vis (rate line, heatmap, stat) and logs vis (volume by level, log stream) on the interim Canvas 2D renderer. **Then:** visual builder, explain, metric browser, cardinality explorer, multiple queries and expressions, synced cursor, baseline ghost, events, LIVE, cached-first paint | PromQL and LogQL can be dashboarded against PulsusDB; day-to-day usefulness vs incumbent query explorers |
| **M-UI2** | Entities + Lens | Entity catalogue, Service/Host Lens templates, **the rest of** logs (patterns, detected fields, line expand, live tail, log to metric), traces (scatter, waterfall) + profiles (flame), pivots, Correlate stack. Traces and profiles follow directly after the M-UI1 PromQL/LogQL slice | "Entity first" and cross-signal correlation |
| **M-UI3** | Atlas + Change feed + Compare | Estate navigation ([15](15-estate-navigation.md)): Landscape, both zoom ladders + `V` floors, Infra grid + node packing, Explorer, Health/Capacity/Coverage layers; infrastructure model ([16](16-infrastructure-model.md)): canonical classes and shape grammar, three largest public clouds from telemetry, Kubernetes object model and Workload arrangement; Topology/Hierarchy Atlas with LOD, semantic zoom, replay and the Time Ribbon in Space scenes, segments/bundling/anomalous subgraph; change feed; Universal Compare (+ unchanged, coverage); local WASM analytics engine; First Light; victim/origin heuristic; **MCP server** | The spatial differentiator + RCA foundations |
| **M-UI4** | Alerts + Investigations + RCA v1 | Alert authoring with backtest, routing, incident grouping, Alert Lens, Investigation workspace, RCA stage 1 + agent stage 2, evidence ledger + hypothesis tree, draw-to-ask, flight recorder, mobile PWA push + offline Alert Lens card (T20 (draft)) | MTTI improvement; AI RCA accuracy on the replay corpus |
| **M-UI5** | Boards + Perspectives + Journeys | Boards **beyond the M-UI1 minimum** (edit mode with undo history, variables, versions UI with diff and restore, library, free-form canvas, 200 viewports, dashboard import with full panel parity per [05](05-visualisation-catalogue.md) §11: tables, geomap, schematics, widgets, field config + transformations), Perspectives (NOC, Platform, Engineer, Business, Support), Journeys and customer lookup, release compare; cloud inventory connectors, Network layer, further clouds, hypervisors, network devices and storage systems ([16](16-infrastructure-model.md)) | Multi-audience value; migration path |
| **M-UI6** | Enterprise hardening | Data scopes, audit, SCIM, Git sync, Terraform, attention-managed wall (salience ladder, wall ↔ desk, shift replay), A/B Everything, accessibility AA audit, air-gapped AI | Sellable to regulated enterprises |

The milestone of each requirement is in the requirements summary of its document and in the
generated traceability matrix (`traceability.md`, produced by `tools/check.py --write`).

### 2.1 Delivery order (2026-11-19)

Within M-UI1, the PromQL and LogQL query slice comes first. A user signs in, opens a board, adds
PromQL and LogQL panels, sees the auto-chosen vis with live PulsusDB data and saves the board. Logs
and Boards are delivered as a first subset in M-UI1. Requirements that the subset fully meets move to
M-UI1 (Table 2.1b). Every other requirement keeps its milestone, which is when it is fully met (D6);
its M-UI1 subset is recorded in Table 2.1c. TraceQL and profile queries follow directly after the
slice and keep their M-UI2 milestone. The real-Earth globe spike (EST-065 to EST-073) is paused
by the product owner: estate and globe work resumes after the PromQL/LogQL slice, and its
requirements stay at M-UI3.

**Restart (D7–D9).** On 2026-11-19 the code was removed and the sequence re-planned: a standard
TS/React web application first ([ADR-0014](../adr/0014-typescript-react-web-client.md)), a Go BFF
([ADR-0015](../adr/0015-go-bff.md)), charts on the interim Canvas 2D renderer, and the GPU chart
engine (the M-UI0 scope) after the slice. Issues #24, #25 and #39–#49 are superseded by the steps
below; each step is filed as the issue named in Table 2.1a.

**Table 2.1a — Step sequence.** Critical path: 1 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11. Step 2 runs
alongside steps 3–4; steps 12–13 follow the slice.

| Step | Issue | Delivers | Milestone | Depends on |
|---|---|---|---|---|
| 0 | #56 | Designs aligned with D7–D9 (this revision; roadmap Q13) | — | — |
| 1 | #57 | Web client scaffold and application shell (layout, routing, time range, refresh, user menu, themes, empty pages), stub data, CI | M-UI1 | — |
| 2 | #58 | Interim chart frames: `ChartFrame` seam and Canvas 2D line, stacked bars, heatmap, stat; chart gallery on stub data | M-UI1 | 1 |
| 3 | #59 | Go BFF skeleton: Postgres under RLS, migrations, OpenAPI pipeline, serves the client with headers, dev stack | M-UI1 | 1 |
| 4 | #60 | OIDC sign-in, sessions and built-in roles, wired into the shell | M-UI1 | 3 |
| 5 | #61 | Boards: list, 12-column grid, panel editor, save and load with versions | M-UI1 | 4, 2 |
| 6 | #62 | PulsusDB client and PromQL routes (JSON frames) | M-UI1 | 4 |
| 7 | #63 | Explore metrics: PromQL editor, auto-vis, series table | M-UI1 | 6, 2 |
| 8 | #64 | PromQL panels on boards | M-UI1 | 7, 5 |
| 9 | #65 | LogQL routes | M-UI1 | 6 |
| 10 | #66 | Explore logs: LogQL editor, volume by level, log stream | M-UI1 | 9, 2 |
| 11 | #67 | LogQL panels on boards | M-UI1 | 10, 8 |
| 12 | #68 | Chart engine foundation: Rust/WASM worker, WebGPU/WebGL2, line mark behind the seam, Arrow frames from the BFF | M-UI0 | 8 |
| 13 | #69 | Engine marks for text and axes, heatmap, bars, stat and the GPU log stream; 10⁸-point line; scatter at 10⁷ | M-UI0 | 12 |
| later | — | TraceQL panels, trace waterfall, profile panels | M-UI2 | 11 (and 13 for GPU volumes) |

**Table 2.1b — Requirements moved to M-UI1** (the slice meets all their acceptance criteria).

| Requirement | Doc | From | To | Delivered by |
|---|---|---|---|---|
| SRF-033 Log volume histogram | [04](04-surfaces.md) | M-UI2 | M-UI1 | Steps 10–11 (stacked by level; a brush sets the Context window) |
| PRF-020 10⁶ log lines scrollable | [09](09-performance-contract.md) | M-UI2 | M-UI1 | Step 10, #66 (virtualised DOM list). If it misses the PRF-001 frame target at 10⁶ lines on the reference lab, PRF-020 moves back to M-UI2 and is met by the GPU log stream of step 13, #69 (D6) |

**Table 2.1c — Partially delivered in M-UI1; milestone unchanged (D6).**

| Requirement | Milestone | M-UI1 subset | Remainder |
|---|---|---|---|
| SRF-036 Log stream | M-UI2 | stream (steps 10–11) | minimap |
| VIZ-034 Log stream | M-UI2 | virtualised list, severity gutter, wrap (step 10); GPU text (step 13) | JSON expand, prettify, dedupe, context lines, minimap |
| SRF-030 Metrics auto-vis + multiple queries | M-UI1 | auto-vis (step 7) | A/B queries and expressions |
| IA-020 Time range in the page header | M-UI1 | header time range picker and refresh control, brush on charts, window keys (steps 1, 2) | LIVE (INT-028) |
| IA-006 Boards | M-UI5 | board in the root folder, versions stored on save (step 5) | owners, version history UI, variables |
| SRF-014 Board layout | M-UI5 | 12-column grid (step 5) | free-form canvas, 3D viewports |
| ENT-022 Versioned content | M-UI5 | version rows on every save (step 5) | diff and restore |
| VL-002 Neutral series palette with stable identity colours | M-UI1 | stable colours: level table, else key hash (step 2, #58) | `ci:palette-check` |
| VL-012 Numbers for humans | M-UI1 | `2.84 s`, `1.2k rps`, `%`, IEC bytes (step 2, #58) | currency, relative times |
| INT-033 Hover tooltip | M-UI1 | value and labels on line, bars and heatmap (step 2, #58) | Δ vs baseline, Atlas nodes |
| VIZ-010 Line, area and bar style options | M-UI1 | gaps, stacking (step 2, #58) | the other options |
| VIZ-013 Axes are first-class objects | M-UI1 | one time axis and one value axis (step 2, #58) | multiple axes |
| VIZ-069 Gallery is the vis test corpus | M-UI1 | interim gallery goldens (step 2, #58) | manifest, frame-time gate |

Traces and profiles (SRF-040 to SRF-048, VIZ-033, VIZ-036, PRF-021), the rest of logs (SRF-034,
SRF-035, SRF-037 to SRF-039, VIZ-035, PRF-015), the rest of Boards (SRF-015 to SRF-026, PRF-022) and
the rest of the metrics workbench keep their milestones.

**PulsusDB routes.** The slice uses PulsusDB's native routes: PromQL under `/api/v1/` (`query`,
`query_range`, `series`, `labels`, `label/{name}/values`, `metadata`, `status/{runtimeinfo, tsdb}`)
and LogQL under `/api/logs/v1/` (`query_range`, `volume`, `labels`, `label/{name}/values`,
`series`). Later work uses `/api/logs/v1/{patterns, detected_labels, detected_fields, tail}`,
`/api/traces/v1/{search, trace/{id}, metrics/query_range, metrics/query, tags, tag/{tag}/values}`,
the service graph at `/api/traces/v1/service_graph?start=<t>&end=<t>` (confirmed by the PulsusDB
owner on 2026-11-19; the edge cap remains assumption A1), and the profiles Connect API under
`/api/profiles/v1/`. PR tests run against `pulsus-fake` ([T05](../technical/T05-testing-and-performance.md));
contract tests may also run against a configured shared PulsusDB deployment, read-only.

## 3. Decisions taken

| # | Decision | Record | Status |
|---|---|---|---|
| D1 | DOM rooms use **Leptos** (was Q1: Leptos · Dioxus · all-canvas) | [ADR-0004](../adr/0004-leptos-dom-rooms.md) | Superseded 2026-11-19 by D7 |
| D2 | Dash-derived state (alert history, baselines, anomaly scores, change events, fallback pyramids) lives in **PostgreSQL**; Dash never writes product state into PulsusDB | [ADR-0012](../adr/0012-derived-state-in-postgres.md); [ADR-0010](../adr/0010-dash-writes-derived-series.md) Rejected | Accepted 2026-11-18 |
| D3 | Licence: the repository is **AGPL-3.0**, the same as PulsusDB, so reusing PulsusDB's AGPL parser crates is licence-compatible (was Q8). R17 (permissive syntax crates) drops to nice-to-have unless a non-AGPL edition is planned | `LICENSE`; [pulsusdb-requirements](../technical/pulsusdb-requirements.md) R17 | Accepted 2026-11-18 |
| D4 | Mockups are SVG | [mockups/](../mockups/README.md) | Accepted 2026-11-18 |
| D5 | Delivery order: the PromQL and LogQL query and board slice first; logs and minimal Boards pulled into M-UI1; TraceQL and profiles next, at their M-UI2 milestone; globe spike (#25) paused | §2.1 | Accepted 2026-11-19 |
| D6 | Partially delivered requirements keep their milestone; a requirement moves earlier only if the earlier delivery meets all its acceptance criteria, and the earlier subset is recorded in §2.1 (was Q11, option A) | §2.1 | Accepted 2026-11-19 |
| D7 | The web client is a standard **TypeScript + React + Vite** application, built first; the GPU chart engine (Rust/WASM in a worker, one canvas per panel) comes later behind a typed TS API, with an in-house Canvas 2D renderer until then | [ADR-0014](../adr/0014-typescript-react-web-client.md) | Accepted 2026-11-19 |
| D8 | The BFF is written in **Go** | [ADR-0015](../adr/0015-go-bff.md) | Accepted 2026-11-19 |
| D9 | Conventional application layout: left navigation sidebar, page header with time range, refresh and user menu top-right, roomy boards; the earlier no-sidebar prototype is rejected | [ADR-0014](../adr/0014-typescript-react-web-client.md) §10 | Accepted 2026-11-19 |
| D10 | Asset integrity is verified by the BFF against the signed manifest before serving; every JS module, CSS file and worker is same-origin, and the one executable asset that may come from the CDN is the engine WASM, fetched with `integrity`; no per-module SRI in the browser | [ADR-0016](../adr/0016-asset-integrity-verified-by-bff.md) | Accepted 2026-11-19 |
| D11 | SRF-027 in M-UI1 shows PulsusDB's parse errors on run (positioned where PulsusDB returns a position); pre-run byte-offset diagnostics are SRF-078 at M-UI2 with the browser parser (was Q14, option A) | [04](04-surfaces.md) SRF-027, SRF-078 | Accepted 2026-11-19 |
| D13 | Gate sensitivity proofs (T05-002): unit, component and end-to-end gates may prove that they fail with a local regression run whose output is recorded in the PR; a CI proof PR (a `gate-proof/*` branch with a red run) is needed only for CI-specific gates (workflow and build-artefact checks) | [T05](../technical/T05-testing-and-performance.md#t05-002--every-gate-is-proven-to-fail) T05-002 | Accepted 2026-11-20 (owner) |

### 3.1 Settled by the specification

These draft questions are answered by requirements in this review baseline. They are listed so the
product owner can confirm them at sign-off.

| Was | Question | Answer in the specification | Where |
|---|---|---|---|
| Q2 | Entity schema source of truth | Derivation from telemetry is the default, with a configurable schema; CMDB (e.g. ServiceNow) import remains open (§5, Q2) | [02](02-information-architecture.md) IA-010, IA-011 |
| Q4 | Atlas default layout | Per Perspective: Topology for SRE/Engineer, City for NOC/Platform | [01a](01a-audiences-and-perspectives.md) AUD-045, [15](15-estate-navigation.md) |
| Q5 | Non-PulsusDB datasources | Prometheus-API compatible, read-only; no other datasources in v1 | [01](01-vision-and-principles.md) PRN-012 |
| Q9 | Business impact (€) data source | Both configuration constants and business metrics in PulsusDB, with the formula always visible | [01a](01a-audiences-and-perspectives.md) AUD-030 |
| Q10 | Mobile app | PWA from the same web client; read, acknowledge and AI only | [01](01-vision-and-principles.md) PRN-014, [09](09-performance-contract.md) PRF-035 to PRF-042 |

## 4. Assumptions

| # | Assumption | If false |
|---|---|---|
| A1 | PulsusDB raises the `service_graph` edge cap from 1 000 to **≥ 50 000** to meet the topology target ([09](09-performance-contract.md) PRF-019, R5) | Topology falls back to the R5 client-side aggregation path and the edge-count coverage meter shows truncation |
| A2 | Reference hardware and browsers are as listed in [09](09-performance-contract.md) §2.1 | Performance gates are re-baselined |

## 5. Open questions

| # | Question | Options | Recommendation / leaning | Record |
|---|---|---|---|---|
| O1 | Data scopes on metrics when resource attributes are not labels | See ADR | Option B: enforce on labels, fail closed per metric family, and pursue R16 with PulsusDB | [ADR-0013](../adr/0013-metrics-data-scopes.md) (Proposed, open decision) |
| O2 | Proposed ADRs: 0003 wgpu, 0005 Arrow, 0008 Dash evaluator, 0009 object storage, 0011 Terraform in Go | Accept / revise | Accept: each matches the drafts and none has a live alternative | [ADR index](../adr/README.md) |
| Q2 | CMDB import (e.g. ServiceNow) in addition to derivation | None · CMDB import · both | Both; derivation is the default | [T12](../technical/T12-entity-catalogue.md) |
| Q3 | Alert evaluation location | Pulsus Dash evaluator · PulsusDB ruler (post-1.0) | Ours first; migrate when the ruler is ready (part of O2) | [ADR-0008](../adr/0008-dash-alert-evaluator.md) (Proposed) |
| Q6 | Arrow natively from PulsusDB vs BFF conversion | — | BFF first, native later (part of O2) | [ADR-0005](../adr/0005-arrow-wire-format.md) (Proposed); [T01](../technical/T01-frontend-architecture.md) |
| Q7 | Default AI provider and level of self-hosted model support | — | Claude via API by default; OpenAI-compatible endpoint for self-hosted | [06](06-ai-copilot.md); T15 (draft) |
| Q12 | Local sign-in without an IdP | (A) OIDC only; dev installs use a bundled test IdP · (B) a local bootstrap admin with a password, break-glass only | (A) for now. T06-022 forbids stored passwords, but T19 §4.3 and T11 `users.password_hash` assume a local bootstrap admin (T18 §13 Q5). Reconcile before the M-UI1 release | [T06](../technical/T06-bff-architecture.md), [T11](../technical/T11-postgres-schema.md), [T18](../technical/T18-security.md), [T19](../technical/T19-deployment.md) |

## 6. Next design steps

1. Validate personas and drill paths with 5–8 interviews per audience
   ([01a](01a-audiences-and-perspectives.md) §9).
2. Build a high-fidelity interactive prototype of the Alert Lens → Atlas causal path → Correlate flow
   (the core demo) on the M-UI0 rendering spike ([13](13-core-flow-storyboard.md)).
3. Define the entity schema defaults from OTel semconv against real customer telemetry
   ([02](02-information-architecture.md) §2.1).
4. Agree the PulsusDB API asks ([T01](../technical/T01-frontend-architecture.md),
   [pulsusdb-requirements](../technical/pulsusdb-requirements.md)) with the PulsusDB team.

## 7. Resolved during formalisation

1. **Q1 and Q8 closed** by decisions D1 and D3. The draft's Q8 constraint (Dash links PulsusDB's
   AGPL parser crates, so it is a combined AGPL work) is the reason for D3; the permissive fallback
   build in T09 is no longer required unless a non-AGPL edition is planned.
2. **Q2, Q4, Q5, Q9, Q10** had leanings that the product documents now specify as requirements; they
   are listed in §3.1 for confirmation rather than as open. Q2 keeps its CMDB-import half open.
3. **Q3 and Q6** are the subjects of Proposed ADRs 0008 and 0005 and are tracked under O2.
4. **Perspectives in M-UI5.** The draft listed NOC, Platform, Engineer, Business and Support; SRE and
   Exec are also built in ([01a](01a-audiences-and-perspectives.md) AUD-046) and land in the same
   milestone.
5. **Validation-scenario reference.** The scenario is [01a](01a-audiences-and-perspectives.md) §8
   (renumbered from the draft's §6).
6. **Q13 closed (2026-11-19, #56).** The product requirements written for the previous shell and the
   Rust-only stack are revised in place to D7–D9, with stable IDs: IA-014, IA-016, IA-020, IA-021
   ([02](02-information-architecture.md), plus IA-028 for the Time Ribbon in Space scenes); INT-015,
   INT-017, INT-025, INT-029, INT-031 ([03](03-interaction-model.md)); SRF-001, SRF-014, SRF-019,
   SRF-027 ([04](04-surfaces.md); split into SRF-027 and new SRF-078 by code review, D11); VIZ-001, VIZ-057, VIZ-063 ([05](05-visualisation-catalogue.md));
   ALR-021 ([07](07-alerting.md)); VL-017, VL-019, VL-021 ([08](08-visual-language.md)); PRF-008,
   PRF-009, PRF-020 (note), PRF-022, PRF-033, PRF-038 ([09](09-performance-contract.md)); ENT-028
   ([11](11-enterprise.md)). The technical designs are aligned in the same change.
7. **Q14 closed (2026-11-19, owner)** as option A: decision D11.

## 8. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft; decisions D1–D4, assumptions A1–A2 and open decisions O1–O2 added |
| 1.1-rc | 2026-11-19 | D5 delivery order: PromQL and LogQL query and board slice first; M-UI1, M-UI2 and M-UI5 scopes re-cut; §2.1 added with the issue sequence (#39–#49); SRF-033 and PRF-020 moved from M-UI2 to M-UI1; D6 milestone rule for partial delivery (Q11 closed, option A); Q12 added; globe spike #25 paused; service graph confirmed on the native traces API |
| 1.2-rc | 2026-11-19 | D7 TS/React/Vite client (ADR-0014, supersedes D1), D8 Go BFF (ADR-0015), D9 conventional application layout. §2.1 re-planned as steps 1–13 after the code restart; #24, #25 and #39–#49 superseded; M-UI0 delivered after the first M-UI1 slice; Q13 added for product text that assumes the previous shell |
| 1.3-rc | 2026-11-19 | Q13 closed (#56): product requirements revised to D7–D9 (§7 item 6); Table 2.1a names the issues #56–#69; PRF-020 fallback is the GPU log stream (#69); Table 2.1c IA-020 row updated and SRF-027 row added; M-UI1 theme no longer names the Time Ribbon, which moves to the M-UI3 Space scenes (IA-028); Q10 answer reads "same web client" |
| 1.4-rc | 2026-11-19 | Code review of #56: SRF-027 revised to errors on run and its pre-run positioned criterion split out as SRF-078 (M-UI2, proposed); the SRF-027 row leaves Table 2.1c; Q14 added for owner confirmation |
| 1.5-rc | 2026-11-19 | Owner decisions on #56: Q14 closed as option A (D11, SRF-078 at M-UI2); D10 asset integrity verified by the BFF (ADR-0016) |
| 1.6-rc | 2026-11-20 | #58: Table 2.1c adds the M-UI1 subsets of VL-002, VL-012, INT-033, VIZ-010, VIZ-013 and VIZ-069 delivered by the interim chart frames; milestones unchanged (D6) |
| 1.7-rc | 2026-11-20 | Owner decision D13 (review of #58): gate sensitivity proofs may be local runs recorded in the PR, except for CI-only gates |
