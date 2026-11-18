# 12 — Roadmap

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.0-rc · 2026-11-18 |
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
| **M-UI0** | Rendering spike | wgpu line chart + scatter in an OffscreenCanvas worker; JS shim only; Arrow decode; 10⁸-point pan/zoom; WebGPU + WebGL2 | The performance contract is achievable in Rust/WASM ([09](09-performance-contract.md)) |
| **M-UI1** | Metrics workbench + Time Ribbon | PromQL editor (Rust parser), auto-vis, synced cursor, baseline ghost, BFF with Arrow, OIDC login | Day-to-day usefulness vs incumbent query explorers |
| **M-UI2** | Entities + Lens | Entity catalogue, Service/Host Lens templates, logs (volume, patterns, stream) + traces (scatter, waterfall) + profiles (flame), pivots, Correlate stack | "Entity first" and cross-signal correlation |
| **M-UI3** | Atlas + Change feed + Compare | Estate navigation ([15](15-estate-navigation.md)): Landscape, both zoom ladders + `V` floors, Infra grid + node packing, Explorer, Health/Capacity/Coverage layers; Topology/Hierarchy Atlas with LOD, semantic zoom, replay, segments/bundling/anomalous subgraph; change feed; Universal Compare (+ unchanged, coverage); local WASM analytics engine; First Light; victim/origin heuristic; **MCP server** | The spatial differentiator + RCA foundations |
| **M-UI4** | Alerts + Investigations + RCA v1 | Alert authoring with backtest, routing, incident grouping, Alert Lens, Investigation workspace, RCA stage 1 + agent stage 2, evidence ledger + hypothesis tree, draw-to-ask, flight recorder, mobile PWA push + offline Alert Lens card (T20 (draft)) | MTTI improvement; AI RCA accuracy on the replay corpus |
| **M-UI5** | Boards + Perspectives + Journeys | Boards (edit, versions, dashboard import with full panel parity per [05](05-visualisation-catalogue.md) §11: tables, geomap, schematics, widgets, field config + transformations), Perspectives (NOC, Platform, Engineer, Business, Support), Journeys and customer lookup, release compare | Multi-audience value; migration path |
| **M-UI6** | Enterprise hardening | Data scopes, audit, SCIM, Git sync, Terraform, attention-managed wall (salience ladder, wall ↔ desk, shift replay), A/B Everything, accessibility AA audit, air-gapped AI | Sellable to regulated enterprises |

The milestone of each requirement is in the requirements summary of its document and in the
generated traceability matrix (`traceability.md`, produced by `tools/check.py --write`).

## 3. Decisions taken

| # | Decision | Record | Status |
|---|---|---|---|
| D1 | DOM rooms use **Leptos** (was Q1: Leptos · Dioxus · all-canvas) | [ADR-0004](../adr/0004-leptos-dom-rooms.md) | Accepted 2026-11-18 |
| D2 | Dash-derived state (alert history, baselines, anomaly scores, change events, fallback pyramids) lives in **PostgreSQL**; Dash never writes product state into PulsusDB | [ADR-0012](../adr/0012-derived-state-in-postgres.md); [ADR-0010](../adr/0010-dash-writes-derived-series.md) Rejected | Accepted 2026-11-18 |
| D3 | Licence: the repository is **AGPL-3.0**, the same as PulsusDB, so reusing PulsusDB's AGPL parser crates is licence-compatible (was Q8). R17 (permissive syntax crates) drops to nice-to-have unless a non-AGPL edition is planned | `LICENSE`; [pulsusdb-requirements](../technical/pulsusdb-requirements.md) R17 | Accepted 2026-11-18 |
| D4 | Mockups are SVG | [mockups/](../mockups/README.md) | Accepted 2026-11-18 |

### 3.1 Settled by the specification

These draft questions are answered by requirements in this review baseline. They are listed so the
product owner can confirm them at sign-off.

| Was | Question | Answer in the specification | Where |
|---|---|---|---|
| Q2 | Entity schema source of truth | Derivation from telemetry is the default, with a configurable schema; CMDB (e.g. ServiceNow) import remains open (§5, Q2) | [02](02-information-architecture.md) IA-010, IA-011 |
| Q4 | Atlas default layout | Per Perspective: Topology for SRE/Engineer, City for NOC/Platform | [01a](01a-audiences-and-perspectives.md) AUD-045, [15](15-estate-navigation.md) |
| Q5 | Non-PulsusDB datasources | Prometheus-API compatible, read-only; no other datasources in v1 | [01](01-vision-and-principles.md) PRN-012 |
| Q9 | Business impact (€) data source | Both configuration constants and business metrics in PulsusDB, with the formula always visible | [01a](01a-audiences-and-perspectives.md) AUD-030 |
| Q10 | Mobile app | PWA from the same WASM; read, acknowledge and AI only | [01](01-vision-and-principles.md) PRN-014, [09](09-performance-contract.md) PRF-035 to PRF-042 |

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
| Q2 | CMDB import (e.g. ServiceNow) in addition to derivation | None · CMDB import · both | Both; derivation is the default | T12 (draft) |
| Q3 | Alert evaluation location | Pulsus Dash evaluator · PulsusDB ruler (post-1.0) | Ours first; migrate when the ruler is ready (part of O2) | [ADR-0008](../adr/0008-dash-alert-evaluator.md) (Proposed) |
| Q6 | Arrow natively from PulsusDB vs BFF conversion | — | BFF first, native later (part of O2) | [ADR-0005](../adr/0005-arrow-wire-format.md) (Proposed); [T01](../technical/T01-frontend-architecture.md) |
| Q7 | Default AI provider and level of self-hosted model support | — | Claude via API by default; OpenAI-compatible endpoint for self-hosted | [06](06-ai-copilot.md); T15 (draft) |

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

## 8. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft; decisions D1–D4, assumptions A1–A2 and open decisions O1–O2 added |
