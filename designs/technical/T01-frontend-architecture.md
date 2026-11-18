# T01 — Frontend architecture

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.0-rc · 2026-11-18 |
| **Milestone** | M-UI0 (constraint, thread layout, technology choices) → M-UI1 (shell/core split, rooms, tokens) |
| **Related ADRs** | [ADR-0001](../adr/0001-rust-wasm-everywhere.md), [ADR-0002](../adr/0002-no-js-ui-framework.md), [ADR-0003](../adr/0003-wgpu-rendering.md), [ADR-0004](../adr/0004-leptos-dom-rooms.md), [ADR-0005](../adr/0005-arrow-wire-format.md), [ADR-0006](../adr/0006-pulsusdb-and-postgres.md), [ADR-0007](../adr/0007-in-house-vis-engine.md), [ADR-0012](../adr/0012-derived-state-in-postgres.md) |
| **Source draft** | plans/tech/T01-frontend-architecture.md (not tracked) |

## 1. Context & problem

The product specification ([01](../product/01-vision-and-principles.md) to
[09](../product/09-performance-contract.md)) forces a particular stack on the browser. Speed is the
product ([PRN-003](../product/01-vision-and-principles.md#prn-003--speed-is-the-feature)): 60 fps during interaction, input to photon within one frame, and no
interaction waiting on the network. Every visualisation is drawn in one shared GPU scene
([VIZ-001](../product/05-visualisation-catalogue.md#viz-001--gpu-rendering-in-one-shared-scene)), while rooms are conventional, accessible DOM ([IA-015](../product/02-information-architecture.md#ia-015--rooms-are-conventional-accessible-dom)).

This document is the umbrella for the frontend. It records the binding constraints and the
decisions the UI depends on, and it delegates the detail:

| Concern | Authoritative design |
|---|---|
| Shim contract, worker topology, shared memory, input ring, WASM split, size budgets | [T03](T03-browser-runtime.md) |
| GPU mark primitives, scales, axes, layouts, vis specs | [T02](T02-vis-engine.md) |
| Arrow schemas, DSF framing, cancellation, coverage, IndexedDB cache | [T04](T04-wire-format-and-data-plane.md) |
| Test layers, gates, replay, synthetic data | [T05](T05-testing-and-performance.md) |
| BFF service | [T06](T06-bff-architecture.md) |
| Scene query planner | [T07](T07-scene-query-planner.md) |
| DOM rooms and component kit | [T08](T08-dom-component-kit.md) |
| Query editors | [T09](T09-query-editors.md) |

## 2. Goals / non-goals

**Goals**
- Fix the hard constraint: all application logic is Rust compiled to WASM, and browser JavaScript
  only moves bytes and events.
- Fix the process layout, so that canvas rendering can never be blocked by DOM work.
- Fix the technology per layer: wgpu, Leptos, Arrow IPC, an in-house mark engine.
- Fix the boundary between the Space (GPU) and rooms (DOM), and the single token source both use.
- Record the backend shape the UI implies, and the PulsusDB gaps it surfaced.

**Non-goals**
- Byte-level contracts. These are in [T03](T03-browser-runtime.md) and
  [T04](T04-wire-format-and-data-plane.md).
- The BFF's internal design ([T06](T06-bff-architecture.md)) and the Postgres schema
  ([T11](T11-postgres-schema.md)).
- Component-level DOM design ([T08](T08-dom-component-kit.md)).

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [PRN-003](../product/01-vision-and-principles.md#prn-003--speed-is-the-feature) | §4.1, §4.2, §7 | `bench:frame-gallery`, `bench:input-photon`, `bench:offline-interaction` |
| [VIZ-001](../product/05-visualisation-catalogue.md#viz-001--gpu-rendering-in-one-shared-scene) | §4.1, §4.3, §4.4 | `ci:dep-audit` (no JS charting/mapping/diagram library); `e2e:no-dom-vis` (non-DOM vis drawn by the wgpu canvas only) |
| [VIZ-002](../product/05-visualisation-catalogue.md#viz-002--every-vis-is-a-composition-of-shared-mark-primitives) | §4.4 (co-satisfied with T02) | `ci:spec-lint` |
| [IA-014](../product/02-information-architecture.md#ia-014--the-space-camera-transitions-never-page-loads) | §4.3 (co-satisfied with T02) | `replay:space-transitions` |
| [IA-015](../product/02-information-architecture.md#ia-015--rooms-are-conventional-accessible-dom) | §4.3, §4.4 | `e2e:a11y-rooms` |
| [IA-016](../product/02-information-architecture.md#ia-016--minimal-global-chrome) | §4.3 | `e2e:chrome-layout` |
| [VL-017](../product/08-visual-language.md#vl-017--thin-translucent-chrome) | §4.3 | `e2e:chrome-layout` |
| [VL-021](../product/08-visual-language.md#vl-021--one-token-source-for-canvas-and-dom) | §4.5 | `ci:token-lint` |
| [VL-022](../product/08-visual-language.md#vl-022--component-and-mark-libraries-share-the-tokens) | §4.5 (co-satisfied with T02, T08) | `ci:token-lint`, `ci:spec-lint` |
| [PRF-005](../product/09-performance-contract.md#prf-005--no-main-thread-long-tasks-during-interaction) | §4.2 (co-satisfied with T03) | `bench:long-tasks` |
| [PRF-006](../product/09-performance-contract.md#prf-006--no-interaction-waits-on-the-network) | §4.2, §4.4 (co-satisfied with T04) | `bench:offline-interaction` |
| [IA-001](../product/02-information-architecture.md#ia-001--object-vocabulary-and-persistence) | §4.7 (co-satisfied with T04, T11) | `e2e:no-pulsusdb-write` |

## 4. Design

### 4.1 Hard constraint: Rust everywhere, JS only as a shim

JavaScript in the browser is limited to proxying bytes and events into the Rust/WASM application.
No application logic, state, data transformation, layout or rendering lives in JS.

| JS shim responsibility | Why it cannot sensibly be Rust |
|---|---|
| Bootstrap: fetch and instantiate WASM modules, set up workers, check COOP/COEP | Must run before WASM exists |
| Network byte pump: `fetch()` streaming and `WebSocket` → `ArrayBuffer` chunks handed to WASM (copied once, never parsed) | Platform APIs. Rust could call them via `web-sys`, but a dedicated pump in each data worker keeps the hot path simple and zero-parse in JS |
| Input forwarding: pointer, wheel, keyboard, IME and clipboard events → compact binary records in a WASM ring buffer | Events originate in the DOM, and some decisions (`preventDefault`, `copy`) must be synchronous inside the handler |
| Browser integrations that `web-sys` cannot reach sensibly | History/URL, downloads, clipboard writes and media queries are done in Rust via `web-sys` ([T03](T03-browser-runtime.md)) |

Everything else is Rust: the state store, query planning, decoding, decimation, layout (graph, grid,
text), the scene graph, GPU command encoding, DOM rooms and the AI dock.

#### T01-001 — No application logic in JavaScript
**MUST** — Hand-written browser JavaScript MUST be limited to the four shim responsibilities in the
table above. It MUST NOT hold application state, transform data or make product decisions, and it
MUST NOT parse JSON or inspect payload bytes. Its size and import rules are fixed by T03-001.

#### T01-002 — No JavaScript UI, charting or component framework
**MUST** — The shipped bundle MUST NOT contain a JavaScript UI framework (React, Vue, Svelte,
Angular), component library (MUI, AG Grid, …) or charting, mapping, 3D or graph-diagram
library. The only npm packages
allowed are test tooling that is never shipped (Playwright).

> **Rationale:** [ADR-0001](../adr/0001-rust-wasm-everywhere.md) and
> [ADR-0002](../adr/0002-no-js-ui-framework.md). One language end to end gives one debugger, one
> test harness ([T05](T05-testing-and-performance.md)) and deterministic replay of every input.

### 4.2 Process layout in the browser

The main thread runs a separate `dash-shell.wasm` (Leptos) with its own non-shared memory, because
Rust `std` locks on `wasm32+atomics` compile to `memory.atomic.wait`, which the main thread cannot
use. The render, data, layout and pool workers share one `dash-core-mt.wasm` memory. The
authoritative state store lives in the render worker, and the shell holds a read-only mirror. The
exact topology is [T03 §4.2](T03-browser-runtime.md#42-worker-topology); the conceptual view is:

```
 Main thread (JS shim + dash-shell.wasm, own memory)        Workers (dash-core-mt.wasm, one shared WebAssembly.Memory)
 ┌──────────────────────────────────────────┐            ┌─────────────────────────────────────────────────┐
 │ input capture → input ring ──────────────┼─── SAB ──► │ RENDER: OffscreenCanvas + wgpu; state store      │
 │ Leptos DOM rooms, chrome, tooltips       │◄── ring ───│   (authoritative Context), camera, scene, LOD,   │
 │ a11y mirror DOM (Rust-managed)           │─── ring ──►│   GPU decimation, frame loop                     │
 │ URL/history, downloads, clipboard        │            ├─────────────────────────────────────────────────┤
 └──────────────────────────────────────────┘            │ DATA (n): byte pump → DSF/Arrow decode →         │
                                                         │   columnar chunks in shared memory → upload      │
                                                         ├─────────────────────────────────────────────────┤
                                                         │ LAYOUT: force graph, treemap, text shaping, tess.│
                                                         ├─────────────────────────────────────────────────┤
                                                         │ POOL (m): rayon threads (decimation, CPU-tier    │
                                                         │   compute, pyramid merges, local-engine kernels) │
                                                         └─────────────────────────────────────────────────┘
```

- **Rendering off the main thread** (OffscreenCanvas in a worker) means DOM work in rooms or the
  Inspector can never drop a canvas frame.
- **Shared memory** (`SharedArrayBuffer`, which needs the COOP/COEP headers from our server) lets data
  workers write columnar buffers that the render worker reads with zero copies. Only the GPU upload
  copies.
- **Multithreaded WASM** (`wasm-bindgen-rayon` or equivalent) fans out decode and decimation.
- **Client-held data.** Every interaction (pan, zoom, orbit, hover, scrub, brush) reads only chunks
  already in the arena or the local engine. New data arrives asynchronously and refines what is
  drawn ([T04 §4.4](T04-wire-format-and-data-plane.md#44-streaming-and-chunking)).

#### T01-003 — Rendering never runs on the main thread
**MUST** — In the Full and Tier-T2 modes ([T03 §9](T03-browser-runtime.md#9-failure-modes--degradation)),
the GPU scene MUST be rendered in the render worker through an OffscreenCanvas. The main thread MUST
run only the shim and the shell. Main-thread rendering is permitted only in the MT-R fallback mode.

#### T01-004 — Hot-path threads share one memory
**MUST** — Every thread on the data → render path (render, data, layout, pool) MUST run the same
shared-memory module, so that decoded Arrow buffers are never copied between threads.

#### T01-005 — Interaction never waits on the network
**MUST** — No input handler, camera controller or frame MUST await a network response. A frame
MUST be produced from whatever chunks are resident, and arriving data MUST be applied between
frames without interrupting a gesture.

### 4.3 The Space and the rooms

[02](../product/02-information-architecture.md) splits the product into the **Space** (Atlas,
Lenses, Boards in view mode, workbenches), which is GPU-rendered, and **rooms** (Boards library,
Investigations, Alerts, Admin), which are DOM.

| Part | Rendered by | Notes |
|---|---|---|
| Space scenes and every non-DOM vis | wgpu canvas in the render worker ([T02](T02-vis-engine.md)) | One shared scene per Space view; moves between scenes are camera transitions, not page loads |
| Time Ribbon chart | wgpu, as a reserved viewport at the bottom of the canvas ([T02 §4.6](T02-vis-engine.md#46-interaction-controllers-and-the-scene)) | Its DOM controls (LIVE pill, window text, baseline picker) are overlaid by the shell |
| Top bar, Time Ribbon controls, Inspector, AI dock, tooltips, coverage meter, table view | Leptos in the shell ([T08](T08-dom-component-kit.md)) | Floating over the canvas |
| Rooms | Leptos in the shell; admin rooms as a lazy satellite ([T03 §4.1](T03-browser-runtime.md#41-artefacts-and-module-split)) | Standard DOM keyboard behaviour |
| DOM vis (marked **DOM** in [05](../product/05-visualisation-catalogue.md)) | Leptos | e.g. tables of ≤ 10k rows |

**Composition.** The canvas is full-bleed: it covers the whole window under the chrome. The 32 px
top bar and the 40 px Time Ribbon strip are DOM elements positioned over it with a translucent
`surface-1` background, so canvas content shows through ([VL-017](../product/08-visual-language.md#vl-017--thin-translucent-chrome)). The shell reports every DOM
element that occludes the canvas to core as `RoomGeometry` ([T03 §5.3](T03-browser-runtime.md#53-core--shell-messages)),
which core uses for picking and for safe-area framing (frame-all never puts content under the
chrome). In Space scenes with a camera extent, the minimap is a GPU viewport in the bottom-right of
the canvas.

#### T01-006 — The Space is one GPU scene
**MUST** — Every Space view MUST be rendered as one scene in the shared wgpu canvas. Moving between
Space scenes MUST NOT cause a document navigation; it is a camera transition ([T02](T02-vis-engine.md)
T02-026), and the previous scene stays resident.

#### T01-007 — Rooms are Leptos DOM
**MUST** — Rooms, chrome, tooltips, the Inspector and DOM vis MUST be Leptos components from the
component kit ([T08](T08-dom-component-kit.md)). They MUST be operable by keyboard alone and MUST
pass the WCAG 2.2 AA automated checks.

#### T01-008 — Global chrome is thin, translucent and the only persistent chrome
**MUST** — The Space MUST show only the 32 px top bar (logo menu, breadcrumb, command palette entry,
alert count, AI dock toggle, avatar menu), the canvas (with a minimap where the scene has a camera
extent) and the 40 px Time Ribbon. The bar and ribbon MUST be translucent over the canvas, and the
canvas MUST be informed of their geometry.

### 4.4 Rendering and UI technology choices

| Layer | Choice | Rationale / alternative |
|---|---|---|
| GPU API | **wgpu** → WebGPU, falling back to WebGL2 ([ADR-0003](../adr/0003-wgpu-rendering.md)) | One Rust codebase. Compute shaders for decimation and KDE on WebGPU; CPU fallback paths on WebGL2. The same renderer runs natively, headless, for server-side PNGs (notifications, reports) and golden tests |
| Scene and marks | Own retained-mode scene graph plus instanced mark pipelines (polyline, area, rect, point, arc, edge, path, text, image, density, mesh, tile); full design in [T02](T02-vis-engine.md) ([ADR-0007](../adr/0007-in-house-vis-engine.md)) | The performance of high-performance charting libraries needs bespoke batching. Generic engines (Bevy) bring too much |
| Text on canvas | MSDF glyph atlases of the self-hosted UI fonts; shaping with `rustybuzz`/`cosmic-text` in the layout worker | Crisp at any zoom; logs as GPU text; matches DOM text ([T02](T02-vis-engine.md) T02-012) |
| DOM rooms and panels | **Leptos** (fine-grained reactive, Rust → WASM, DOM through generated bindings), [ADR-0004](../adr/0004-leptos-dom-rooms.md) **Accepted** | Forms, tables, settings, accessibility, IME and autofill need real DOM. Dioxus is not pursued; all-canvas (egui) was rejected for accessibility, IME and enterprise forms |
| Query editors | Rust editor core (PromQL/LogQL/TraceQL tokenisers and parsers reused from the PulsusDB crates where possible), rendered in DOM as a transparent `<textarea>` over a highlighted layer ([T09](T09-query-editors.md)) | Parser parity with the backend gives exact error positions and autocomplete |
| Wire format | **Arrow IPC** in the DSF envelope from the BFF; JSON only for config/CRUD ([ADR-0005](../adr/0005-arrow-wire-format.md), [T04](T04-wire-format-and-data-plane.md)) | Zero-parse decode into GPU-ready columns |
| Local analytics engine | Rust columnar engine in WASM (a DataFusion-class subset: filter, group, aggregate, histogram merge) over summary pyramids and fetched chunks, with the same query interface as the server (the pattern used by in-browser trace viewers); T13 (draft) | Interaction never waits on a round trip |
| Local cache | IndexedDB via `web-sys`, storing DSF/Arrow chunks ([T04 §6.1](T04-wire-format-and-data-plane.md#61-indexeddb-chunk-cache)) | "Show cached first" ([PRF-026](../product/09-performance-contract.md#prf-026--show-cached-marked-stale)) |

#### T01-009 — Every vis is a spec over the shared mark engine
**MUST** — Every vis MUST be an L5 spec over the T02 mark primitives (T02-001). No feature team MAY
add a draw pipeline outside [T02](T02-vis-engine.md)'s L1.

### 4.5 One token source for canvas and DOM

Colour, space, type and motion tokens ([08](../product/08-visual-language.md)) are defined once in
`design/tokens.toml`. The `dash-tokens` crate's `build.rs` generates:

| Output | Consumer | Form |
|---|---|---|
| `tokens.rs` | core (`dash-marks`, `dash-scene`), shell | `pub const` linear-space RGBA (`[f32; 4]`), px sizes, durations in ms, per theme and density |
| `tokens.css` | shell, rooms, component kit | CSS custom properties under `:root[data-theme][data-density]` |
| `tokens.json` | palette validator, gallery, docs | Flat map, for tooling only |

Theme (dark default, light from M-UI5, wall high-contrast from M-UI6) and density (Comfortable,
Compact, Wall ×1.6) are token *sets*, selected at runtime by the `Prefs` message
([T03 §5.3](T03-browser-runtime.md#53-core--shell-messages)). Neither the mark library nor the
component kit defines a colour, size or duration of its own.

#### T01-010 — Tokens are defined once and generated
**MUST** — Every colour, space, type and motion value used by the renderer or the DOM MUST come from
the generated `dash-tokens` outputs. A hard-coded colour literal outside the generated files MUST
fail CI.

### 4.6 Crate map

| Crate | Module | Role | Detailed in |
|---|---|---|---|
| `dash-protocol` | shell + core | Core ↔ shell message records (postcard) | [T03](T03-browser-runtime.md) |
| `dash-shell` | `dash-shell.wasm` | Leptos app, bridge, URL/history, browser integrations | [T03](T03-browser-runtime.md), [T08](T08-dom-component-kit.md) |
| `dash-core-mt` | `dash-core-mt.wasm` | Core module crate: links the core crates; built for wasm32 (`cargo build-wasm`) | [T03](T03-browser-runtime.md) |
| `dash-state` | core | Context store, commands, undo, keymap, URL codec | [T03](T03-browser-runtime.md) |
| `dash-scene`, `dash-gpu`, `dash-marks` | core, native | Scene graph, wgpu runtime, mark pipelines | [T02](T02-vis-engine.md) |
| `dash-scales`, `dash-axes`, `dash-units`, `dash-colour`, `dash-fieldcfg`, `dash-autovis` | core, BFF, native | L2–L4 shared layers | [T02](T02-vis-engine.md) |
| `dash-wire` | core, BFF | DSF framing, Arrow schemas, coverage | [T04](T04-wire-format-and-data-plane.md) |
| `dash-chunk-cache` | core | IndexedDB chunk cache | [T04](T04-wire-format-and-data-plane.md) |
| `dash-tokens` | all | Generated design tokens | §4.5 |
| `dash-replay`, `dash-golden`, `pulsus-synth`, `pulsus-fake`, `dash-lab` | test, native | Replay, goldens, synthetic data, fake upstream, lab agent | [T05](T05-testing-and-performance.md) |

All crates live in one root Cargo workspace: browser, shared (⇄) and test crates under `crates/`,
BFF-only crates under `server/`, tooling in `xtask/`.

### 4.7 Backend shape implied by the UI

```
 Browser (Rust/WASM) ──HTTP/2 + WS, DSF/Arrow──►  pulsus-dash server (Rust, axum) — the BFF
                                                   ├─ Scene query planner: dedupe/merge viewport queries,
                                                   │  choose step from pixel width, fan out, stream Arrow (T07)
                                                   ├─ Entity catalogue + graph service (T12, draft)
                                                   ├─ Change feed, baselines / anomaly sweep, compare
                                                   ├─ Alert evaluator, routing, notifications (T16)
                                                   ├─ AI orchestrator: RCA stages, tools, MCP server (T15, draft)
                                                   ├─ Auth (OIDC/SAML/SCIM), RBAC enforcement, audit (T10, draft)
                                                   └─ Postgres: config + all Dash-derived state, leases,
                                                      LISTEN/NOTIFY (T11) · Redis optional (L2 cache)
                                                                          │ read-only telemetry queries
                                                                          ▼
                                                   PulsusDB (PromQL / LogQL / TraceQL / profiles, service graph)
```

The BFF ([T06](T06-bff-architecture.md)) is essential. It converts PulsusDB's
Prometheus/Loki/Tempo-style JSON into Arrow once, server-side. It enforces RBAC on every query by
injecting tenant and label matchers, and it plans queries per *scene* rather than per panel. Longer
term, PulsusDB may emit Arrow natively (ClickHouse already speaks Arrow): requirement R1 in
[pulsusdb-requirements](pulsusdb-requirements.md).

Dash-derived state (alert history and state, baselines, anomaly scores, derived change events and
fallback pyramids) lives in PostgreSQL (decision D2, [ADR-0012](../adr/0012-derived-state-in-postgres.md)).
The planner resolves the reserved selectors `ALERTS`, `ALERTS_FOR_STATE`, `pulsus_anomaly_score` and
the `{source="pulsus-dash"}` event stream against Postgres-backed virtual sources
([T07](T07-scene-query-planner.md)), and their results reach the browser in the same Arrow
schemas as telemetry ([T04](T04-wire-format-and-data-plane.md)).

#### T01-011 — Dash never writes product state into PulsusDB
**MUST** — No Dash component MUST write to PulsusDB other than Dash's own self-telemetry (RUM, lab
results; [T05 §4.7](T05-testing-and-performance.md#47-real-user-performance-telemetry-dash-observing-itself))
and the configured audit export. All derived state MUST be written to PostgreSQL
([ADR-0012](../adr/0012-derived-state-in-postgres.md)).

## 5. Interfaces

| Boundary | Format | Defined in |
|---|---|---|
| Shim ↔ Rust (bootstrap, byte pump, input ring) | wasm-bindgen imports/exports; binary records in shared memory | [T03 §5](T03-browser-runtime.md#5-interfaces) |
| Core ↔ shell | postcard records on two SPSC rings | [T03 §5.3](T03-browser-runtime.md#53-core--shell-messages) |
| Browser ↔ BFF data plane | DSF frames carrying Arrow IPC over HTTP/2 and WebSocket | [T04 §5](T04-wire-format-and-data-plane.md#5-interfaces) |
| Browser ↔ BFF config/CRUD | JSON over HTTP | [T06](T06-bff-architecture.md), [T11](T11-postgres-schema.md) |
| BFF ↔ PulsusDB | PulsusDB HTTP APIs (JSON, OTLP protobuf, Connect); read-only for telemetry | [pulsusdb-requirements](pulsusdb-requirements.md), [T06](T06-bff-architecture.md) |

### 5.1 PulsusDB gaps surfaced by the UI

The formal hand-off to PulsusDB engineering, with priorities, acceptance criteria and a Dash-side
fallback for every item (so none blocks Dash), is [pulsusdb-requirements](pulsusdb-requirements.md).
The table below is the summary from the UI's point of view, checked against upstream PulsusDB on
2026-11-17.

| Need | UI feature | Status in PulsusDB | Ask (R-number) |
|---|---|---|---|
| Arrow/columnar response format | Every vis, the performance contract | JSON / protobuf only | Optional `Accept: application/vnd.apache.arrow.stream` on `query_range` endpoints (R1) |
| Exemplars | Metric → trace pivot (exemplar dots on charts) | **Available.** `/api/v1/query_exemplars` answers from stored OTLP and remote-write exemplars (bounded at 100k, thinned per panel step). TraceQL metrics attach `trace:id` exemplars by default (≤ 100 per response). Profile exemplars in progress | None for metrics and traces. Consume profile exemplars and the span/profile heatmap when they land |
| Entity catalogue / resource inventory | Atlas, Lens, Perspectives | Not present (service graph only) | Endpoint listing resource-attribute combinations with activity and signal availability (R3) |
| Per-entity RED/USE rollups at fleet scale | Atlas health for 10k entities | Possible via PromQL recording rules operated by PulsusDB | Built-in entity health rollups exported as Arrow (R4). Fallback pyramids are Dash-derived and stored in Postgres (D2), never written into PulsusDB |
| Service-graph time series | Atlas replay | Aggregate over a window only | `step` parameter on `service_graph` (R5); edge cap ≥ 50 000 (assumption A1) |
| Compare for logs and metrics | Attribute-divergence Compare everywhere | TraceQL `compare()` only | Generalised compare endpoint (R6) |
| Error origination | Victim vs origin | Not present | Span aggregation of originated vs propagated errors per service (R7) |
| Span ↔ profile linkage | Span → profile pivot | Profiles API by selector/time; heatmap and exemplars in progress | Span-id-scoped merge for the pivot |
| Alert evaluation | Alerts | Rules stored; evaluation post-1.0 | Dash evaluates first ([ADR-0008](../adr/0008-dash-alert-evaluator.md), [T16](T16-alert-evaluator.md)); PulsusDB ruler later (R15) |
| Query cost / explain | Explain view, budgets | `X-Pulsus-Explain` exists | Keep it stable; add a pre-execution cost estimate (R14); uniform completeness metadata (R10) |
| Cancellation | Cancel superseded requests | Request dropped on disconnect | Confirm cancellation reaches ClickHouse (R11) |

## 6. Data & storage

| Data | Where | Owner |
|---|---|---|
| Authoritative Context, camera, undo stack | Render worker memory | [T03 §4.4](T03-browser-runtime.md#44-state-ownership) |
| Decoded Arrow chunks | Core shared-memory arena | [T03](T03-browser-runtime.md), [T04](T04-wire-format-and-data-plane.md) |
| Cached chunks and scene snapshots | IndexedDB | [T04 §6.1](T04-wire-format-and-data-plane.md#61-indexeddb-chunk-cache) |
| Configuration, Boards, Investigations, all Dash-derived state | PostgreSQL | [T11](T11-postgres-schema.md), [ADR-0012](../adr/0012-derived-state-in-postgres.md) |
| Large artefacts (snapshot payloads, replays) | Optional S3-compatible store, else Postgres | [ADR-0009](../adr/0009-optional-object-storage.md) |
| Telemetry | PulsusDB (read-only for Dash) | — |
| Dash self-telemetry | PulsusDB, dedicated database/tenant | [T05](T05-testing-and-performance.md) |

## 7. Performance budget

T01 owns no number of its own. It assigns every [09](../product/09-performance-contract.md) budget
to the design that meets it:

| Budget | Requirement | Met by |
|---|---|---|
| 60 fps / ≥ 45 fps p99 on (b) | [PRF-001](../product/09-performance-contract.md#prf-001--frame-rate-during-interaction), [PRF-002](../product/09-performance-contract.md#prf-002--frame-rate-floor) | [T02](T02-vis-engine.md) (marks, LOD), [T03](T03-browser-runtime.md) (render worker) |
| Input → photon ≤ 1 frame (p99 ≤ 2) | [PRF-003](../product/09-performance-contract.md#prf-003--input-to-photon), [PRF-004](../product/09-performance-contract.md#prf-004--input-to-photon-hard-limit) | [T03](T03-browser-runtime.md) (input ring read at frame start) |
| 0 main-thread long tasks during interaction | [PRF-005](../product/09-performance-contract.md#prf-005--no-main-thread-long-tasks-during-interaction) | §4.2, [T03](T03-browser-runtime.md) |
| No interaction waits on the network | [PRF-006](../product/09-performance-contract.md#prf-006--no-interaction-waits-on-the-network) | §4.2, [T04](T04-wire-format-and-data-plane.md) |
| Camera transition ≤ 250 ms | [PRF-007](../product/09-performance-contract.md#prf-007--camera-transition-duration) | [T02](T02-vis-engine.md) |
| Cold load < 1.0 s; core < 3 MB brotli | [PRF-008](../product/09-performance-contract.md#prf-008--cold-load-to-interactive-shell), [PRF-009](../product/09-performance-contract.md#prf-009--core-bundle-size-and-lazy-loading) | [T03](T03-browser-runtime.md) |
| Volumes (10⁸ line points, 10⁷ scatter, 10⁴ series) | [PRF-016](../product/09-performance-contract.md#prf-016--10⁸-line-chart-points), [PRF-017](../product/09-performance-contract.md#prf-017--10⁷-scatter-points), [PRF-018](../product/09-performance-contract.md#prf-018--10⁴-series-per-scene) | [T02](T02-vis-engine.md), [T04](T04-wire-format-and-data-plane.md) |
| Memory < 1.5 GB; graceful degradation | [PRF-023](../product/09-performance-contract.md#prf-023--memory-budget), [PRF-024](../product/09-performance-contract.md#prf-024--graceful-degradation-under-memory-pressure) | [T03](T03-browser-runtime.md), [T04](T04-wire-format-and-data-plane.md) |
| Progressive data (cached, coarse, refine, cancel, truncation) | [PRF-026](../product/09-performance-contract.md#prf-026--show-cached-marked-stale) to [PRF-031](../product/09-performance-contract.md#prf-031--truncation-honesty) | [T04](T04-wire-format-and-data-plane.md), [T07](T07-scene-query-planner.md) |
| CI enforcement | [PRF-032](../product/09-performance-contract.md#prf-032--per-visualisation-gpu-benchmarks-in-ci), [PRF-033](../product/09-performance-contract.md#prf-033--bundle-size-and-dom-room-gates) | [T05](T05-testing-and-performance.md) |

## 8. Security, tenancy & RBAC

- **Cross-origin isolation** (COOP `same-origin`, COEP `require-corp`) is required for shared memory
  and is also a security posture: it is what makes `SharedArrayBuffer` and high-resolution timers
  acceptable after Spectre. The exact headers are in [T03 §5.7](T03-browser-runtime.md#57-http-headers-the-runtime-requires);
  the full CSP is in [T18](T18-security.md).
- **Smaller supply chain.** With no npm runtime dependencies (T01-002), the browser attack surface is
  the shim, the wasm-bindgen glue and our own crates.
- **RBAC is server-side.** The browser never chooses a tenant or scope beyond what `/bootstrap`
  granted; the BFF injects tenant and data-scope matchers on every upstream call (T10 (draft),
  [T04 §8](T04-wire-format-and-data-plane.md#8-security-tenancy--rbac)).
- **Derived state** is isolated in one place, Postgres RLS ([ADR-0012](../adr/0012-derived-state-in-postgres.md)).

## 9. Failure modes & degradation

Capability loss (no WebGPU, no cross-origin isolation, no OffscreenCanvas, no WebGL2), GPU device
loss, worker crashes and memory pressure each have a defined mode. The app never shows a blank
page. The matrix is [T03 §9](T03-browser-runtime.md#9-failure-modes--degradation); data-plane
failures are in [T04 §9](T04-wire-format-and-data-plane.md#9-failure-modes--degradation).

## 10. Testing

[T05](T05-testing-and-performance.md) is authoritative. In summary:
- Rust unit and property tests natively for state, planning, decimation, codecs and layouts.
- Native headless wgpu golden images for every gallery page.
- Playwright drives the real build through the shim for integration, the mode matrix and
  accessibility.
- Deterministic replay of recorded input against seeded data, which also powers bug reports.
- Frame-time, latency and memory benchmarks on the reference lab gate merges.

## 11. Rollout

| Milestone | Frontend architecture ships |
|---|---|
| M-UI0 | Shim; one `dash-core-mt` with shell features stubbed in core; render, data and pool workers; wgpu T1/T2; Arrow decode; line + scatter at volume ([12](../product/12-roadmap.md)) |
| M-UI1 | Shell/core split with Leptos on main; chrome and Time Ribbon; token pipeline; query editor satellite; metrics workbench; IndexedDB cache |
| M-UI2+ | Entities, Lens, logs/traces/profiles vis; local engine (M-UI3); rooms per feature milestone |

## 12. Alternatives considered

| Alternative | Why not |
|---|---|
| All-canvas UI (egui) including forms | Reinvents accessibility, IME, autofill and enterprise forms. Rejected in [ADR-0004](../adr/0004-leptos-dom-rooms.md) |
| Dioxus for DOM rooms | Viable; Leptos chosen ([ADR-0004](../adr/0004-leptos-dom-rooms.md)). The M-UI1 forms + table + tree work is the build-risk check |
| React (or any JS UI framework) for rooms | Violates [ADR-0002](../adr/0002-no-js-ui-framework.md); splits state across two languages |
| Existing JS charting, mapping and graph libraries | JS; cannot share the Rust scene, picking, LOD or replay ([ADR-0007](../adr/0007-in-house-vis-engine.md)) |
| Bevy or another game engine as the scene | Too much engine for retained, instanced 10⁷-mark scenes; size |
| One WASM module on main + workers | Rust on main would hit `memory.atomic.wait`; see [T03 §12](T03-browser-runtime.md#12-alternatives-considered) |

## 13. Open questions

1. Whether the M-UI1 forms + table + tree work exposes a Leptos blocker (the condition for reopening
   [ADR-0004](../adr/0004-leptos-dom-rooms.md)).
2. When PulsusDB ships R1, whether the BFF moves to pass-through for all numeric results
   ([T04 §5.6](T04-wire-format-and-data-plane.md#56-json--arrow-conversion-in-the-bff-r1-fallback)).

**Resolved during formalisation**

1. **Leptos.** The draft's "decision to confirm" is closed: [ADR-0004](../adr/0004-leptos-dom-rooms.md)
   is Accepted (D1).
2. **Derived state (D2).** The draft's backend sketch had baselines, anomaly sweep and pyramids
   without a store, and the PulsusDB-gap table asked PulsusDB to host Dash's entity-health rollups.
   Under [ADR-0012](../adr/0012-derived-state-in-postgres.md) all Dash-derived state is in Postgres,
   T01-011 forbids writes into PulsusDB, and the pyramid row now states the Postgres fallback.
3. **Process layout.** The draft's single "ui-host" module on main is replaced by the shell/core
   split decided in [T03](T03-browser-runtime.md).
4. **Shim scope.** The draft listed gamepad among shim inputs. Gamepad is a MAY at M-UI6 in
   [03 §4.4](../product/03-interaction-model.md#44-gamepad-and-3d-mouse-stretch-noc-walls), so it is
   reserved in the record format but not in the M-UI0/M-UI1 shim.
5. **Links.** References to the competitive teardown (not part of the formal design) were removed.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft. Restructured to the template; added design rules T01-001 to T01-011, the Space/rooms composition (§4.3), the token pipeline (§4.5), the crate map (§4.6) and the Satisfies table; applied D1 and D2 |
| 1.0-rc | 2026-11-18 | #22: crate map adds `dash-core-mt` (the core module crate); the IndexedDB chunk cache is renamed `dash-chunk-cache` (T06's BFF `dash-cache` keeps the name in the one workspace); all crates live in one root Cargo workspace |
