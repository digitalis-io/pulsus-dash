# T01 — Frontend architecture

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.3-rc · 2026-11-19 |
| **Milestone** | M-UI1 (React application, rooms, tokens, interim charts; first, [12 §2.1](../product/12-roadmap.md#21-delivery-order-2026-11-19)) → M-UI0 (chart engine in workers behind the `ChartFrame` seam) |
| **Related ADRs** | [ADR-0014](../adr/0014-typescript-react-web-client.md), [ADR-0015](../adr/0015-go-bff.md) (supersede ADR-0001, ADR-0002 and ADR-0004), [ADR-0003](../adr/0003-wgpu-rendering.md), [ADR-0005](../adr/0005-arrow-wire-format.md), [ADR-0006](../adr/0006-pulsusdb-and-postgres.md), [ADR-0007](../adr/0007-in-house-vis-engine.md), [ADR-0012](../adr/0012-derived-state-in-postgres.md) |
| **Source draft** | plans/tech/T01-frontend-architecture.md (not tracked) |

## 1. Context & problem

> **Note (2026-11-19):** [ADR-0014](../adr/0014-typescript-react-web-client.md) makes the client a
> TypeScript + React + Vite application, built first, with a Rust/WASM chart engine in a worker
> added later behind a typed TS API; [ADR-0015](../adr/0015-go-bff.md) makes the BFF Go. §4.1 to
> §4.6, §6, §11, §12 and §13 are revised for this: React owns semantic state on the main thread, and
> the engine in workers renders chart frames behind the `ChartFrame` seam. There is no Leptos shell
> and no Rust on the main thread.

The product specification ([01](../product/01-vision-and-principles.md) to
[09](../product/09-performance-contract.md)) forces a particular stack on the browser. Speed is the
product ([PRN-003](../product/01-vision-and-principles.md#prn-003--speed-is-the-feature)): 60 fps during interaction, input to photon within one frame, and no
interaction waiting on the network. Every visualisation is drawn by one shared engine, one canvas per
chart frame ([VIZ-001](../product/05-visualisation-catalogue.md#viz-001--gpu-rendering-by-one-shared-engine)), while rooms are conventional, accessible DOM ([IA-015](../product/02-information-architecture.md#ia-015--rooms-are-conventional-accessible-dom)).

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
- Fix the technology boundary: the application is TypeScript, and the chart engine is Rust compiled
  to WASM in a worker behind a typed API (ADR-0014).
- Fix the process layout, so that canvas rendering can never be blocked by DOM work.
- Fix the technology per layer: React, wgpu, Arrow IPC (from the engine on), an in-house mark engine.
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
| [VIZ-001](../product/05-visualisation-catalogue.md#viz-001--gpu-rendering-by-one-shared-engine) | §4.1, §4.3, §4.4 | `ci:dep-audit` (no JS charting/mapping/3D/diagram library); `e2e:no-dom-vis` (with the engine active, non-DOM vis drawn by the engine only) |
| [VIZ-002](../product/05-visualisation-catalogue.md#viz-002--every-vis-is-a-composition-of-shared-mark-primitives) | §4.4 (co-satisfied with T02) | `ci:spec-lint` |
| [IA-014](../product/02-information-architecture.md#ia-014--the-space-camera-transitions-never-page-loads) | §4.3 (co-satisfied with T02) | `e2e:client-routing`; `replay:space-transitions` (Space, from M-UI2) |
| [IA-015](../product/02-information-architecture.md#ia-015--rooms-are-conventional-accessible-dom) | §4.3, §4.4 | `e2e:a11y-rooms` |
| [IA-016](../product/02-information-architecture.md#ia-016--application-layout) | §4.3 | `e2e:app-layout` |
| [VL-017](../product/08-visual-language.md#vl-017--application-layout-dimensions) | §4.3 | `e2e:app-layout`; `e2e:chrome-layout` (Space scenes) |
| [VL-021](../product/08-visual-language.md#vl-021--one-token-source-for-canvas-and-dom) | §4.5 | `ci:token-lint` |
| [VL-022](../product/08-visual-language.md#vl-022--component-and-mark-libraries-share-the-tokens) | §4.5 (co-satisfied with T02, T08) | `ci:token-lint`, `ci:spec-lint` |
| [PRF-005](../product/09-performance-contract.md#prf-005--no-main-thread-long-tasks-during-interaction) | §4.2 (co-satisfied with T03) | `bench:long-tasks` |
| [PRF-006](../product/09-performance-contract.md#prf-006--no-interaction-waits-on-the-network) | §4.2, §4.4 (co-satisfied with T04) | `bench:offline-interaction` |
| [IA-001](../product/02-information-architecture.md#ia-001--object-vocabulary-and-persistence) | §4.7 (co-satisfied with T04, T11) | `e2e:no-pulsusdb-write` |

## 4. Design

### 4.1 Technology boundary: TypeScript application, Rust engine

The split is fixed in [ADR-0014](../adr/0014-typescript-react-web-client.md) §2:

| Part | Language | Notes |
|---|---|---|
| Application: shell, routing, Context, rooms, forms, boards, query editors, keyboard, API client | TypeScript (React) | Main thread. One owner of semantic state |
| Interim charts | TypeScript (`Canvas2DEngine`) | Main thread, behind the engine seam (ADR-0014 §3, §4) |
| Chart engine: decode, decimation, scales, marks, picking, wgpu | Rust → WASM | Worker; one `OffscreenCanvas` per panel; later the Space scenes |
| Engine adapter | TypeScript (`client/src/engine/wasm/`) | Successor of the shim: moves bytes and events to the engine |

#### T01-001 — No application logic in the engine adapter
**MUST** — *(Revised 2026-11-19, ADR-0014; previously "No application logic in JavaScript".)* The
engine adapter MUST only create frames, forward input and data, and relay engine events. It MUST NOT
parse or inspect payload bytes destined for the engine, and it MUST NOT use `eval`, `Function` or
`innerHTML`. Application logic lives in the TS application, never in the adapter.

#### T01-002 — No JavaScript charting, mapping, 3D or diagram library
**MUST** — *(Revised 2026-11-19, ADR-0014; previously also banned UI frameworks and component
libraries.)* The shipped bundle MUST NOT contain a charting, mapping, 3D or graph-diagram library or
a CSS-in-JS runtime. Runtime npm dependencies MUST be on the allowlist of ADR-0014 §7.

> **Rationale:** every chart is drawn by our own renderer (interim Canvas 2D, then the engine), so
> picking, LOD and replay stay ours ([ADR-0007](../adr/0007-in-house-vis-engine.md)). Standard UI
> concerns use the React ecosystem.

### 4.2 Process layout in the browser

*(Rewritten 2026-11-19, ADR-0014 §2–§3; previously a Leptos `dash-shell.wasm` on the main thread
mirrored a state store owned by the render worker.)* The main thread runs the React application,
which is the **one owner of semantic state** (route, Context, selection, committed camera, undo,
keymap, URL), and the engine adapter. From the engine issue on, the engine runs in workers that
share one `dash-core-mt.wasm` memory; it holds only render-local state (gesture camera, hover,
decoded columns) and reports commits, brushes, selections and hovers as events. No Rust runs on the
main thread, because Rust `std` locks on `wasm32+atomics` compile to `memory.atomic.wait`, which the
main thread cannot use. The exact topology is [T03 §4.2](T03-browser-runtime.md#42-worker-topology);
the conceptual view is:

```
 Main thread (TypeScript)                                   Engine workers (dash-core-mt.wasm, one shared Memory)
 ┌──────────────────────────────────────────┐            ┌─────────────────────────────────────────────────┐
 │ React application: rooms, layout, forms, │            │ RENDER: one OffscreenCanvas per ChartFrame,      │
 │   editors; Context store (owner), undo,  │ ChartFrame │   one wgpu device; render-local state (gesture   │
 │   keymap, URL/history                    │──calls───► │   camera, hover), scene, LOD, GPU decimation,    │
 │ <ChartFrame> per chart: one <canvas>     │◄─events────│   frame loop                                     │
 │ engine adapter: boot, input → input ring ├─── SAB ──► ├─────────────────────────────────────────────────┤
 │ a11y mirror DOM from engine summaries    │            │ DATA (n): byte pump → DSF/Arrow decode →         │
 └──────────────────────────────────────────┘            │   columnar chunks in shared memory → upload      │
                                                         ├─────────────────────────────────────────────────┤
                                                         │ LAYOUT: force graph, treemap, text shaping, tess.│
                                                         ├─────────────────────────────────────────────────┤
                                                         │ POOL (m): rayon threads (decimation, CPU-tier    │
                                                         │   compute, pyramid merges, local-engine kernels) │
                                                         └─────────────────────────────────────────────────┘
```

Until the engine lands, the interim `Canvas2DEngine` implements the same `ChartFrame` API on the main
thread (ADR-0014 §4); the state ownership above does not change when it is replaced.

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
every engine chart frame and Space scene MUST be rendered in the render worker through an
OffscreenCanvas. The main thread MUST run only the React application and the engine adapter, and no
WASM module. Main-thread rendering is permitted only in the MT-R fallback mode.
*Interim (ADR-0014 §4):* until the engine lands, the `Canvas2DEngine` draws on the main thread.

#### T01-004 — Hot-path threads share one memory
**MUST** — From the engine issue on, every engine thread on the data → render path (render, data, layout, pool) MUST run the same
shared-memory module, so that decoded Arrow buffers are never copied between threads.

#### T01-005 — Interaction never waits on the network
**MUST** — No input handler, camera controller or frame MUST await a network response. A frame
MUST be produced from whatever chunks are resident, and arriving data MUST be applied between
frames without interrupting a gesture.

### 4.3 The Space and the rooms

[02](../product/02-information-architecture.md) splits the product into the **Space** (Atlas and
Lenses), which is GPU-rendered, and **rooms** (Boards library, Investigations, Alerts, Admin), which
are DOM. Boards and workbenches are application pages whose viewports are chart frames drawn by the
engine, one canvas each (IA-003, [ADR-0014](../adr/0014-typescript-react-web-client.md) §3).

| Part | Rendered by | Notes |
|---|---|---|
| Space scenes and every non-DOM vis | The engine in the render worker ([T02](T02-vis-engine.md)): one canvas per chart frame, one scene per Space view, one GPU device | Moves between Space scenes are camera transitions; moves between pages are client-side routes, never document loads (IA-014) |
| Time Ribbon chart (Space scenes only, IA-028) | wgpu, as a reserved viewport at the bottom of the Space canvas ([T02 §4.6](T02-vis-engine.md#46-interaction-controllers-and-the-scene)) | Elsewhere the time window is the page header's time range picker (IA-020) |
| Sidebar, page header, Inspector, AI dock, tooltips, coverage meter, table view | React ([T08](T08-dom-component-kit.md)) | Application layout (ADR-0014 §10) |
| Rooms | React; heavy rooms as lazy route chunks | Standard DOM keyboard behaviour |
| DOM vis (marked **DOM** in [05](../product/05-visualisation-catalogue.md)) | React | e.g. tables of ≤ 10k rows, the interim log list |

**Composition.** *(Revised 2026-11-19, ADR-0014 §10.)* The application uses a conventional
layout: a left navigation sidebar, a page header (title left; time range, refresh and user menu
right) and the page body. Board panels are grid cells, each with its own canvas. Space scenes (from
M-UI3) fill the page body with one canvas; the application reports occluding elements to the engine as
`RoomGeometry` so picking and frame-all respect them.

#### T01-006 — The Space is one GPU scene
**MUST** — Every Space view MUST be rendered as one scene in the shared wgpu canvas. Moving between
Space scenes MUST NOT cause a document navigation; it is a camera transition ([T02](T02-vis-engine.md)
T02-026), and the previous scene stays resident.

#### T01-007 — Rooms are accessible React DOM
**MUST** — *(Revised 2026-11-19, ADR-0014.)* Rooms, chrome, tooltips, the Inspector and DOM vis MUST
be React components built from the kit ([T08](T08-dom-component-kit.md)). They MUST be operable by
keyboard alone and MUST pass the WCAG 2.2 AA automated checks.

#### T01-008 — Global chrome is the application layout
**MUST** — *(Revised 2026-11-19, ADR-0014 §10; previously "thin, translucent and the only persistent
chrome".)* Every page MUST show the left navigation sidebar (collapsible) and the page header with
the time range picker, refresh control and user menu on the right. Any canvas MUST be informed of
the geometry of elements that occlude it.

### 4.4 Rendering and UI technology choices

| Layer | Choice | Rationale / alternative |
|---|---|---|
| GPU API | **wgpu** → WebGPU, falling back to WebGL2 ([ADR-0003](../adr/0003-wgpu-rendering.md)) | One Rust codebase. Compute shaders for decimation and KDE on WebGPU; CPU fallback paths on WebGL2. The same renderer runs natively, headless, for server-side PNGs (notifications, reports) and golden tests |
| Scene and marks | Own retained-mode scene graph plus instanced mark pipelines (polyline, area, rect, point, arc, edge, path, text, image, density, mesh, tile); full design in [T02](T02-vis-engine.md) ([ADR-0007](../adr/0007-in-house-vis-engine.md)) | The performance of high-performance charting libraries needs bespoke batching. Generic engines (Bevy) bring too much |
| Text on canvas | MSDF glyph atlases of the self-hosted UI fonts; shaping with `rustybuzz`/`cosmic-text` in the layout worker | Crisp at any zoom; logs as GPU text; matches DOM text ([T02](T02-vis-engine.md) T02-012) |
| Application and DOM rooms | **TypeScript + React + Vite**, React Aria Components, TanStack Router and Query ([ADR-0014](../adr/0014-typescript-react-web-client.md)) | Mature accessible components, pickers, editor and hiring pool. Supersedes Leptos ([ADR-0004](../adr/0004-leptos-dom-rooms.md)) |
| Query editors | CodeMirror 6 in TS; diagnostics from PulsusDB via the BFF, later from PulsusDB's parser crates compiled to WASM ([T09](T09-query-editors.md) to be revised) | Parser parity with PulsusDB for error positions |
| Wire format | JSON frames to the TS app until the engine lands; then **Arrow IPC** in the DSF envelope to the engine worker; JSON for config/CRUD ([ADR-0014](../adr/0014-typescript-react-web-client.md) §5, [ADR-0005](../adr/0005-arrow-wire-format.md), [T04](T04-wire-format-and-data-plane.md)) | One decoder seam in the client; zero-parse decode once Arrow arrives |
| Local analytics engine | Rust columnar engine in WASM (a DataFusion-class subset: filter, group, aggregate, histogram merge) over summary pyramids and fetched chunks, with the same query interface as the server (the pattern used by in-browser trace viewers); T13 (draft) | Interaction never waits on a round trip |
| Local cache | IndexedDB from the engine's data worker, storing DSF/Arrow chunks ([T04 §6.1](T04-wire-format-and-data-plane.md#61-indexeddb-chunk-cache)) | "Show cached first" ([PRF-026](../product/09-performance-contract.md#prf-026--show-cached-marked-stale)) |

#### T01-009 — Every vis is a spec over the shared mark engine
**MUST** — Every vis MUST be an L5 spec over the T02 mark primitives (T02-001). No feature team MAY
add a draw pipeline outside [T02](T02-vis-engine.md)'s L1. *Interim (ADR-0014 §4):* the
`Canvas2DEngine` is the one permitted exception until the engine lands, and it lives only behind the
`ChartFrame` seam.

### 4.5 One token source for canvas and DOM

Colour, space, type and motion tokens ([08](../product/08-visual-language.md)) are defined once in
`design/tokens.toml`. *(Revised 2026-11-19.)* `client/scripts/gen-tokens.ts` generates `tokens.css`
and `tokens.ts`; the `dash-tokens` crate's `build.rs` adds `tokens.rs` for the engine when it lands.
The outputs are:

| Output | Consumer | Form |
|---|---|---|
| `tokens.rs` | engine (`dash-marks`, `dash-scene`) | `pub const` linear-space RGBA (`[f32; 4]`), px sizes, durations in ms, per theme and density |
| `tokens.ts` | TS application, `Canvas2DEngine` | typed constants per theme and density |
| `tokens.css` | application, rooms, component kit | CSS custom properties under `:root[data-theme][data-density]` |
| `tokens.json` | palette validator, gallery, docs | Flat map, for tooling only |

Theme (dark default, light from M-UI5, wall high-contrast from M-UI6) and density (Comfortable,
Compact, Wall ×1.6) are token *sets*, selected at runtime by the application
(`data-theme`/`data-density` on the document, `ChartFrame.setTheme` for the engine). Neither the mark library nor the
component kit defines a colour, size or duration of its own.

#### T01-010 — Tokens are defined once and generated
**MUST** — Every colour, space, type and motion value used by the renderer or the DOM MUST come from
the generated token outputs. A hard-coded colour literal outside the generated files MUST
fail CI.

### 4.6 Crate map

*(Rewritten 2026-11-19.)* Under [ADR-0014](../adr/0014-typescript-react-web-client.md) and
[ADR-0015](../adr/0015-go-bff.md), the Rust workspace holds only the chart engine, the later browser
parser module and their test tooling. The application is TypeScript under `client/` (modules in
[T08](T08-dom-component-kit.md) §0); the BFF is the Go module of [T06](T06-bff-architecture.md) §4.1.
Code that both sides need (`dash-wire` schemas, units) is implemented once per language and held
together by shared fixtures (ADR-0015). `dash-shell` and `dash-state` are withdrawn: semantic state
lives in the TS store.

| Crate | Module | Role | Detailed in |
|---|---|---|---|
| `dash-core-mt` (`-st`) | `dash-core-mt.wasm` (the engine, ADR-0014 §8) | Engine module crate: links the engine crates; built for wasm32 (`cargo build-wasm`) | [T03](T03-browser-runtime.md) |
| `dash-protocol` | engine + adapter | Records behind the `ChartFrame` API and engine events; control block layout | [T03](T03-browser-runtime.md) |
| `dash-scene`, `dash-gpu`, `dash-marks` | engine, native | Scene graph, wgpu runtime, mark pipelines, render-local state | [T02](T02-vis-engine.md) |
| `dash-scales`, `dash-axes`, `dash-units`, `dash-colour`, `dash-fieldcfg`, `dash-autovis` | engine, native | L2–L4 layers | [T02](T02-vis-engine.md) |
| `dash-wire` | engine | DSF framing, Arrow decode, coverage; the Go writer reproduces its fixtures | [T04](T04-wire-format-and-data-plane.md) |
| `dash-chunk-cache` | engine | IndexedDB chunk cache | [T04](T04-wire-format-and-data-plane.md) |
| `dash-tokens` | engine | `tokens.rs` generated from `design/tokens.toml` | §4.5 |
| `dash-editor` | `dash-editor.wasm` (later) | PulsusDB's parser crates for editor diagnostics | [T09](T09-query-editors.md) §0 |
| `dash-replay`, `dash-golden`, `pulsus-synth`, `dash-lab` | test, native | Replay, goldens, synthetic data, lab agent | [T05](T05-testing-and-performance.md) |

All crates live in one root Cargo workspace: engine and test crates under `crates/`, tooling in
`xtask/`. `pulsus-fake` (the fake upstream) is part of the Go test tooling ([T05](T05-testing-and-performance.md)).

### 4.7 Backend shape implied by the UI

```
 Browser (TS app; Rust/WASM engine) ─HTTP/2 + WS──►  pulsus-dash server (Go) — the BFF
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
JSON responses (PromQL-compatible JSON, the standard query-API response shape, for metrics; native JSON for logs and traces) into Arrow once, server-side. It enforces RBAC on every query by
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
| TS application ↔ engine | `ChartEngine` / `ChartFrame` typed API | [ADR-0014](../adr/0014-typescript-react-web-client.md) §3 |
| Engine adapter ↔ engine worker (bootstrap, byte pump, input ring) | wasm-bindgen imports/exports; binary records in shared memory | [T03 §5](T03-browser-runtime.md#5-interfaces) |
| Browser ↔ BFF data plane | JSON frames until the engine; then DSF frames carrying Arrow IPC over HTTP/2 and WebSocket | [T04 §5](T04-wire-format-and-data-plane.md#5-interfaces) |
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
| Authoritative Context, committed camera, undo stack | TS application store (main thread) | [T03 §4.4](T03-browser-runtime.md#44-state-ownership), [T08 §4.2](T08-dom-component-kit.md) |
| Gesture camera, hover | Engine render worker (render-local) | [T03 §4.4](T03-browser-runtime.md#44-state-ownership) |
| Decoded Arrow chunks | Engine shared-memory arena | [T03](T03-browser-runtime.md), [T04](T04-wire-format-and-data-plane.md) |
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
- **Supply chain.** npm runtime dependencies are an allowlist with lockfile, exact versions, audit
  and signature gates ([ADR-0014](../adr/0014-typescript-react-web-client.md) §7).
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
- Rust unit and property tests natively for the engine (decimation, codecs, layouts); Go tests for
  planning ([T07](T07-scene-query-planner.md)); Vitest for the TS store and reducers.
- Native headless wgpu golden images for every gallery page.
- Vitest unit and component tests for the TS application; Playwright drives the production build
  for integration, accessibility and CSP, and later the engine's mode matrix.
- Deterministic replay of recorded input against seeded data, which also powers bug reports.
- Frame-time, latency and memory benchmarks on the reference lab gate merges.

## 11. Rollout

| Milestone | Frontend architecture ships |
|---|---|
| M-UI1 (first, [12 §2.1](../product/12-roadmap.md#21-delivery-order-2026-11-19)) | React application: layout, routing, Context, token pipeline (CSS + TS), boards, PromQL and LogQL explore and panels, CodeMirror editors, interim `Canvas2DEngine` |
| M-UI0 (after the first M-UI1 slice) | Chart engine: adapter, render, data and pool workers; wgpu T1/T2; Arrow decode; one canvas per panel; line + scatter at volume, replacing the interim renderer behind the seam |
| M-UI2+ | Entities, Lens, logs/traces/profiles vis; local engine (M-UI3); rooms per feature milestone |

## 12. Alternatives considered

| Alternative | Why not |
|---|---|
| All-canvas UI (egui) including forms | Reinvents accessibility, IME, autofill and enterprise forms |
| A Rust DOM framework (Leptos per ADR-0004, Dioxus) for the application | Superseded by [ADR-0014](../adr/0014-typescript-react-web-client.md): a conventional web application first, on the mature React ecosystem |
| A JS charting library for the interim charts | Breaches VIZ-001's library clause and would be removed later; the in-house Canvas 2D renderer uses the engine's canvas-per-panel structure ([ADR-0014](../adr/0014-typescript-react-web-client.md) §4) |
| Existing JS charting, mapping and graph libraries | JS; cannot share the Rust scene, picking, LOD or replay ([ADR-0007](../adr/0007-in-house-vis-engine.md)) |
| Bevy or another game engine as the scene | Too much engine for retained, instanced 10⁷-mark scenes; size |
| One WASM module on main + workers | Rust on main would hit `memory.atomic.wait`; under ADR-0014 the main thread runs no WASM ([T03 §12](T03-browser-runtime.md#12-alternatives-considered)) |
| Engine owns the authoritative Context (the 1.0 design) | Two owners of semantic state once the application is React; ADR-0014 §2 gives it to the TS store and keeps only render-local state in the engine |

## 13. Open questions

1. *(Closed 2026-11-19: ADR-0004 superseded by ADR-0014.)*
2. When PulsusDB ships R1, whether the BFF moves to pass-through for all numeric results
   ([T04 §5.6](T04-wire-format-and-data-plane.md#56-json--arrow-conversion-in-the-bff-r1-fallback)).

**Resolved during formalisation**

1. **Leptos.** *(Superseded by ADR-0014.)* The draft's "decision to confirm" was closed by
   [ADR-0004](../adr/0004-leptos-dom-rooms.md) (D1), since superseded.
2. **Derived state (D2).** The draft's backend sketch had baselines, anomaly sweep and pyramids
   without a store, and the PulsusDB-gap table asked PulsusDB to host Dash's entity-health rollups.
   Under [ADR-0012](../adr/0012-derived-state-in-postgres.md) all Dash-derived state is in Postgres,
   T01-011 forbids writes into PulsusDB, and the pyramid row now states the Postgres fallback.
3. **Process layout.** *(Superseded by ADR-0014.)* The draft's single "ui-host" module on main was
   replaced by a shell/core split; the main thread now runs the React application and no WASM (§4.2).
4. **Shim scope.** The draft listed gamepad among shim inputs. Gamepad is a MAY at M-UI6 in
   [03 §4.4](../product/03-interaction-model.md#44-gamepad-and-3d-mouse-stretch-noc-walls), so it is
   reserved in the record format but not in the M-UI0/M-UI1 shim.
5. **Links.** References to the competitive teardown (not part of the formal design) were removed.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft. Restructured to the template; added design rules T01-001 to T01-011, the Space/rooms composition (§4.3), the token pipeline (§4.5), the crate map (§4.6) and the Satisfies table; applied D1 and D2 |
| 1.0-rc | 2026-11-18 | #22: crate map adds `dash-core-mt` (the core module crate); the IndexedDB chunk cache is renamed `dash-chunk-cache` (T06's BFF `dash-cache` keeps the name in the one workspace); all crates live in one root Cargo workspace |
| 1.1-rc | 2026-11-19 | [ADR-0014](../adr/0014-typescript-react-web-client.md), [ADR-0015](../adr/0015-go-bff.md): TS/React client and Go BFF. §4.1 rewritten (T01-001, T01-002 revised); T01-007, T01-008 revised to the application layout; interim notes on T01-003 and T01-009; §4.4 rows, §4.5 generator, §4.6 note, §4.7 diagram, §5, §8, §10, §11, §12 updated; §13 Q1 closed |
| 1.2-rc | 2026-11-19 | Product text revised to D7–D9 (roadmap Q13 closed): §4.3 Space is the Atlas and Lenses, Boards and workbenches are pages of chart frames, the Time Ribbon only in Space scenes; Satisfies rows for IA-014, IA-016 and VL-017 use `e2e:client-routing`, `e2e:app-layout` and `e2e:chrome-layout` |
| 1.3-rc | 2026-11-19 | ADR-0014 state ownership: §1 note and VIZ-001 sentence; §4.2 rewritten (React owns semantic state on the main thread; the engine in workers holds render-local state behind `ChartFrame`; no Leptos shell, no Rust on main); T01-003 and T01-004 aligned; §4.6 crate map rewritten (`dash-shell`, `dash-state` withdrawn; no BFF crates); §5, §6, §10, §12 and §13 resolved items 1 and 3 aligned; review r3: third-party product names replaced by generic wording |
