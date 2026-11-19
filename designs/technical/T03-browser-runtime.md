# T03 — Browser runtime & JS shim

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.2-rc · 2026-11-19 |
| **Milestone** | M-UI0 (shim, topology, single core module) → M-UI1 (shell/core split, keymap, URL/history, lazy satellites) |
| **Related ADRs** | [ADR-0014](../adr/0014-typescript-react-web-client.md) (supersedes ADR-0001, ADR-0002, ADR-0004), [ADR-0003](../adr/0003-wgpu-rendering.md) |
| **Source draft** | plans/tech/T03-browser-runtime.md (not tracked) |

## 0. Applicability under ADR-0014 (2026-11-19)

[ADR-0014](../adr/0014-typescript-react-web-client.md) makes the application TypeScript + React and
adds the Rust/WASM chart engine later, behind a typed TS API. This document now describes the
**engine runtime**; the "shim" is the engine adapter in `client/src/engine/wasm/`, and the "shell"
is the React application.

| Section | Status |
|---|---|
| §4.1 artefacts | `dash-core-mt`/`-st` become the engine, loaded on the first chart frame. `dash-shell.wasm`, `dash-editor.wasm` and `dash-rooms-admin.wasm` are withdrawn (React app, CodeMirror, lazy route chunks). T03-001 revised; T03-002 applies to the engine's satellites |
| §4.2, §4.3 worker topology and shared memory | Stand, for the engine, from the engine issue on |
| §4.4 state ownership | Revised: semantic state is owned by the TS application (ADR-0014 §2); the engine owns render-local state. T03-009 revised; T03-010 applies to the TS Context store |
| §4.5 keymap | The keymap is implemented in TS. T03-011 and T03-012 stand (timing from event timestamps); T03-013 revised |
| §4.6 URL codec | Implemented in TS; T03-014 to T03-017 stand |
| §5.1 shim line budget, `ci:shim-lint` | Withdrawn. The adapter is bound by T01-001 instead |
| §5.2, §5.4 byte pump and input ring | Stand for engine canvases; JSON results for the interim renderer are parsed in TS (ADR-0014 §5) |
| §5.3 core ↔ shell messages | Replaced by the typed `ChartEngine` API (ADR-0014 §3); the records listed become engine events |
| §5.7 headers | Stand; the CSP is ADR-0014 §9 |
| §7.1 startup, §7.3 sizes | The shell is measured as JS (ADR-0014 §8); the `dash-shell.wasm` row is withdrawn; engine rows stand |
| §9 degradation | Stands for the engine; without an engine mode the interim `Canvas2DEngine` remains the fallback |
| §11 rollout | Replaced by [12 §2.1](../product/12-roadmap.md#21-delivery-order-2026-11-19) |

## 1. Context & problem

[T01](T01-frontend-architecture.md) fixes the rule that browser JS only moves bytes and events into
Rust/WASM (T01-001), and sketches a main thread plus render, data and layout workers that share
memory. Neither says *exactly* what the shim does, how threads share memory without blocking the
main thread, how the app loads in under a second, or what happens when the browser lacks
SharedArrayBuffer, WebGPU or OffscreenCanvas.

The product specification makes this load-bearing:
- **Input → photon ≤ 1 frame (p99 ≤ 2 frames)** and **0 main-thread tasks > 16 ms during
  interaction** ([PRF-003](../product/09-performance-contract.md#prf-003--input-to-photon), [PRF-004](../product/09-performance-contract.md#prf-004--input-to-photon-hard-limit), [PRF-005](../product/09-performance-contract.md#prf-005--no-main-thread-long-tasks-during-interaction)). Input must reach the render loop without a
  `postMessage` hop or a main-thread Rust call per event.
- **Cold load to interactive shell < 1.0 s, with core WASM < 3 MB brotli and workbenches
  lazy-loaded** ([PRF-008](../product/09-performance-contract.md#prf-008--cold-load-to-interactive-shell), [PRF-009](../product/09-performance-contract.md#prf-009--core-bundle-size-and-lazy-loading)).
- **Alert Lens paints in < 300 ms with no spinners** ([13 §4](../product/13-core-flow-storyboard.md#4-f1--alert-lens-t--0-s-sam-opens-the-link)),
  and the F2 scrub needs 16 ms frames from the local engine.
- **10⁸ points held client-side, < 1.5 GB tab** ([PRF-016](../product/09-performance-contract.md#prf-016--10⁸-line-chart-points), [PRF-023](../product/09-performance-contract.md#prf-023--memory-budget)). That needs zero-copy
  sharing between the decode threads and the render thread.
- **One Context, one undo stack, one keymap and a URL that reproduces the view**
  ([02 §4](../product/02-information-architecture.md#4-url--state-model),
  [03 §4.2](../product/03-interaction-model.md#42-keyboard-expert-speed),
  [03 §9](../product/03-interaction-model.md#9-undo-everywhere)).

This document is **authoritative** for the shim contract, the worker topology, the shared control
block and input record format, state ownership, the keymap engine, the URL/camera codec and the WASM
artefact split. [T04](T04-wire-format-and-data-plane.md) owns what flows through the byte pump.
[T05](T05-testing-and-performance.md) owns how all of this is tested.

## 2. Goals / non-goals

**Goals**
- A hand-written shim of **≤ 300 lines** in total, with no npm runtime dependencies, enforced in CI.
- Rendering, state and decoding all happen off the main thread. The main thread runs only DOM rooms
  (Leptos) and input capture.
- One shared linear memory for every hot-path thread (render, data, layout, pool), so Arrow buffers
  are never copied between threads.
- First canvas frame < 600 ms and interactive < 1.0 s on reference (a) with a warm HTTP cache.
- One authoritative Context with undo, one keymap for canvas and global shortcuts, and a URL derived
  from state.
- Defined, tested degradation for each missing capability. The app never shows a blank page.

**Non-goals**
- The DOM component kit and the Leptos app structure ([T08](T08-dom-component-kit.md)).
- Arrow schemas and the BFF protocol ([T04](T04-wire-format-and-data-plane.md)).
- CSP and the wider security posture ([T18](T18-security.md)). This doc only states the headers that
  the runtime *requires*.
- The service worker and offline behaviour (T20 (draft)). This doc reserves its line budget.
- Gamepad and SpaceMouse input (a MAY at M-UI6,
  [03 §4.4](../product/03-interaction-model.md#44-gamepad-and-3d-mouse-stretch-noc-walls)). The
  record kind is reserved; the polling code is not in the M-UI0/M-UI1 shim.

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [PRF-003](../product/09-performance-contract.md#prf-003--input-to-photon) | §4.3, §5.4, §7.2 | `bench:input-photon` (median ≤ 1 frame) |
| [PRF-004](../product/09-performance-contract.md#prf-004--input-to-photon-hard-limit) | §4.3, §5.4, §7.2 | `bench:input-photon` (p99 ≤ 2 frames) |
| [PRF-005](../product/09-performance-contract.md#prf-005--no-main-thread-long-tasks-during-interaction) | §4.1, §4.2, §7.2 | `bench:long-tasks` |
| [PRF-006](../product/09-performance-contract.md#prf-006--no-interaction-waits-on-the-network) | §4.2, §4.3 (co-satisfied with T04) | `bench:offline-interaction` |
| [PRF-008](../product/09-performance-contract.md#prf-008--cold-load-to-interactive-shell) | §7.1 | `bench:startup` (shell accepts `⌘K` < 1.0 s, p75 of 20) |
| [PRF-009](../product/09-performance-contract.md#prf-009--core-bundle-size-and-lazy-loading) | §4.1, §7.3 | `ci:bundle-size`; `e2e:lazy-load` |
| [PRF-023](../product/09-performance-contract.md#prf-023--memory-budget) | §6 | `bench:memory-heaviest` |
| [PRF-024](../product/09-performance-contract.md#prf-024--graceful-degradation-under-memory-pressure) | §6, §9 (co-satisfied with T04) | `bench:memory-pressure` |
| [PRF-033](../product/09-performance-contract.md#prf-033--bundle-size-and-dom-room-gates) | §7.3 (bundle part; co-satisfied with T05) | `ci:bundle-size` |
| [PRN-006](../product/01-vision-and-principles.md#prn-006--context-is-sticky) | §4.4 | `replay:context-propagation` |
| [IA-002](../product/02-information-architecture.md#ia-002--context-is-the-one-state-every-view-reads) | §4.4 | `replay:context-propagation`; `e2e:deep-link` (saved Context restored) |
| [IA-021](../product/02-information-architecture.md#ia-021--left-navigation-sidebar) | §4.5 (`g` chords) | `replay:key-bindings` (`g` chords); `e2e:rooms-reachable` |
| [IA-022](../product/02-information-architecture.md#ia-022--deep-links-reproduce-the-view) | §4.6 | `e2e:deep-link` |
| [IA-023](../product/02-information-architecture.md#ia-023--shared-links-pin-absolute-time) | §4.6 | `unit:url-codec` |
| [IA-024](../product/02-information-architecture.md#ia-024--compact-camera-encoding) | §4.6 | `unit:cam-codec` (≤ 64 chars, ≤ 1 px restore) |
| [IA-025](../product/02-information-architecture.md#ia-025--browser-history-is-camera-history) | §4.6 | `replay:camera-history`; `e2e:deep-link` (browser back) |
| [IA-026](../product/02-information-architecture.md#ia-026--context-propagation) | §4.4 | `replay:context-propagation`; `unit:undo-prop` |
| [INT-006](../product/03-interaction-model.md#int-006--camera-history) | §4.6 | `replay:camera-history` |
| [INT-007](../product/03-interaction-model.md#int-007--mouse-and-trackpad-bindings) | §5.4 (input capture; co-satisfied with T02) | `replay:mouse-bindings`; `e2e:shim-fuzz` |
| [INT-009](../product/03-interaction-model.md#int-009--keyboard-bindings) | §4.5 | `replay:key-bindings` (one spec per table row) |
| [INT-010](../product/03-interaction-model.md#int-010--no-key-bound-to-two-actions-in-one-context) | §4.5 | `ci:keymap-check`; `unit:keymap-fsm` (remap refusal) |
| [INT-011](../product/03-interaction-model.md#int-011--tap-and-hold) | §4.5 | `unit:keymap-fsm` |
| [INT-012](../product/03-interaction-model.md#int-012--chords) | §4.5 | `unit:keymap-fsm` |
| [INT-014](../product/03-interaction-model.md#int-014--shortcut-overlay) | §4.5, §5.3 | `replay:key-bindings` (overlay rows per context, after remap) |
| [INT-015](../product/03-interaction-model.md#int-015--keyboard-focus-is-never-trapped) | §4.5, §5.3 | `e2e:focus-regions` |
| [INT-032](../product/03-interaction-model.md#int-032--window-step-and-zoom-keys) | §4.4, §4.5 | `unit:context-reducer` (`[` `]` `-` `=`) |
| [INT-041](../product/03-interaction-model.md#int-041--undo-stack) | §4.4 | `unit:undo-prop`; `replay:undo` |
| [VL-016](../product/08-visual-language.md#vl-016--reduced-motion) | §5.4 (`Prefs` record; co-satisfied with T02) | `replay:reduced-motion` |

## 4. Design

### 4.1 Artefacts and module split

Rust on the main thread cannot block: `Atomics.wait` throws there, and Rust's `std` mutexes on
`wasm32+atomics` compile to `memory.atomic.wait32`. So the main thread runs a **separate module with
its own non-shared memory**, and every thread that needs to share data runs one shared-memory module.

| Artefact | Runs on | Memory | Contents | Loaded |
|---|---|---|---|---|
| `shim/*.js` | main + every worker | — | §5.1 | eagerly, inline module preload |
| `dash-shell.wasm` | main | own, non-shared | Leptos DOM rooms core, chrome, Context mirror, URL/history, a11y mirror, browser integrations via `web-sys` | eagerly |
| `dash-core-mt.wasm` | render, data × n, layout, pool × m | **one shared `WebAssembly.Memory`** (max 2 GiB) | state store, keymap, scene graph, wgpu renderer, marks M1–M10, scales, decimation, Arrow decode, client query planner, IndexedDB cache, local engine | eagerly (one of mt/st) |
| `dash-core-st.wasm` | one worker (or main in MT-R) | own, non-shared | same code built without `+atomics`; §9 fallback | only when not cross-origin isolated, or without OffscreenCanvas |
| `dash-editor.wasm` | `editor` worker | own | PromQL/LogQL/TraceQL tokenisers and parsers, autocomplete ([T09](T09-query-editors.md)) | on first focus of a query bar |
| `dash-rooms-admin.wasm` | main | own | Admin/settings rooms and alert authoring forms, mounted into their own DOM subtree | on route |
| `dash-geo.wasm` | `geo` worker | own | MVT decode and tile tessellation (M12, M-UI5) | on first geomap |
| Workbench satellites | per workbench | own | Workbench-only code that is not on the shared hot path (e.g. pattern tooling, trace-specific panels) | on first use of that workbench |
| Data files | — | — | MSDF font atlases, `chrono-tz` slices, locale data, self-hosted fonts | on demand, cached immutably |

**Lazy-loading rule.** Code splitting *inside* a threaded module is not reliable today, so a lazy
unit is always a **separate module with its own memory**, talking to core or shell by messages.
That suits coarse units (editors, admin rooms, geo, workbench-only code). It does not suit
fine-grained ones, so everything on the M-UI0–M-UI3 hot path (M1–M10, T13 (draft)'s local engine)
lives in core. Satellites never touch core memory directly. Their outputs (token streams, tessellated
meshes) are copied in once, through a core-allocated slab.

#### T03-001 — Engine adapter imports
**MUST** — *(Revised 2026-11-19, ADR-0014; the ≤ 300-line shim budget is withdrawn.)* The engine
adapter (`client/src/engine/wasm/`) MUST NOT import application modules other than
`client/src/engine/api.ts` and the generated wasm-bindgen glue, and MUST NOT use `eval`, `Function`
or `innerHTML`. ESLint import rules enforce it.

#### T03-002 — Lazy units are separate modules
**MUST** — Anything not needed for the shell and the first Space scene MUST be a separate WASM module
with its own memory, loaded on first use. Signal workbenches MUST NOT be part of the eager download.
A satellite MUST NOT read or write core memory except through a core-allocated copy-in slab.

### 4.2 Worker topology

```
 MAIN THREAD                                   WORKERS (all dash-core-mt, one shared Memory)
 ┌───────────────────────────────┐            ┌───────────────────────────────────────────────┐
 │ shim/boot.js  (bootstrap)     │  spawn     │ render   OffscreenCanvas + wgpu device         │
 │ shim/input.js (event capture) ├──────────► │          state store (authoritative Context)   │
 │   └► input ring ──────────────┼─ SAB ────► │          keymap, camera, interaction, scene,   │
 │ dash-shell.wasm               │            │          LOD, frame loop on worker rAF         │
 │   Leptos rooms, a11y mirror   │◄─ SAB ring │──── core→ui ring (anchors, selection, a11y)    │
 │   URL/history, downloads      ├─ SAB ring ►│◄─── ui→core ring (DOM commands, Context edits) │
 └───────────────────────────────┘            ├───────────────────────────────────────────────┤
                                              │ data-0   coordinator: client planner (T07),    │
            BFF (HTTP/2, WS)  ◄────────────── │          IndexedDB cache, request ids, cancel  │
                 ▲                            │ data-1…  byte pump (shim/net.js) → DSF/Arrow   │
                 └─────────────────────────── │          decode → chunk arena                  │
                                              ├───────────────────────────────────────────────┤
                                              │ layout   T14 engines, text shaping, lyon tess. │
                                              ├───────────────────────────────────────────────┤
                                              │ pool×m   rayon threads (decimation, CPU tier-2 │
                                              │          compute, pyramid merges, T13 kernels) │
                                              └───────────────────────────────────────────────┘
   satellites (own memory): editor worker · geo worker · workbench satellites · admin rooms (main)
```

| Thread | Count | Blocks? | Owns | Wakes on |
|---|---|---|---|---|
| main | 1 | never | DOM, shim listeners, shell | DOM events; doorbell `message` from render |
| render | 1 | never on locks held by others for > 50 µs | Context/state store, keymap, scene, GPU device, input ring consumer | worker `requestAnimationFrame` |
| data-0 | 1 | never (event loop) | planner, request table, cache, cancellation | doorbell `MessagePort`, fetch promises |
| data-k | `clamp(hwc/4, 1, 3)` in total, data-0 included | never (event loop) | assigned network streams, decode | fetch/WS promises, doorbell |
| layout | 1 | may block in rayon joins | layout jobs, glyph runs, tessellation | Rust channel + doorbell |
| pool | `clamp(hwc − 3 − n_data, 1, 6)` | yes (rayon idle wait) | nothing long-lived | rayon |

Data workers keep an event loop because `fetch` and `WebSocket` deliver through promises. A worker
parked in `Atomics.wait` (as idle rayon threads are) would never see its responses. That is why the
pool is separate from the data workers. Heavy fan-out from a data worker goes to the pool with
`rayon::spawn` and comes back over a channel and a doorbell.

**Doorbells.** At boot the shim creates a `MessageChannel` between every pair of workers that need
one and hands the ports to Rust. Rust rings a port with an empty `postMessage` only when a queue goes
from empty to non-empty. The queue itself is a Rust channel (`crossbeam-channel`) in shared memory,
never the message payload. `Atomics.waitAsync` replaces doorbells where it is available; its
availability in Firefox and Safari is verified in M-UI0.

#### T03-003 — The main thread never blocks and never renders
**MUST** — The main thread MUST run only the shim and `dash-shell.wasm` (non-shared memory). It MUST
NOT wait on an atomic, take a lock shared with a worker, decode data or render the canvas (except in
MT-R mode, §9). Shim work per input event MUST stay ≤ 0.05 ms at p99.

#### T03-004 — At most one doorbell per queue per frame
**MUST** — A producer MUST ring a doorbell only on the empty → non-empty transition of its queue, so
that no queue generates more than one `postMessage` per frame.

### 4.3 Shared memory layout and ownership

`dash-core-mt` is linked with `--shared-memory --max-memory=2147483648` (2 GiB; the [PRF-023](../product/09-performance-contract.md#prf-023--memory-budget) tab
budget is 1.5 GB). The render worker allocates a **control block** of 256 KiB, 64-byte aligned, at
startup and publishes its address in the boot handshake. The shim and the shell reach it through
`Int32Array`/`Uint8Array` views of `memory.buffer`. Growing shared memory never detaches old views,
so the low-address control block stays valid.

| Offset | Size | Region | Producer → consumer | Sync |
|---|---|---|---|---|
| `0x00000` | 64 | header: magic `PDCB` at `0x00`, layout version `u16` at `0x04`, capability bits `u32` at `0x08`, boot epoch `u32` at `0x0C`, build id `[u8;16]` at `0x10`, runtime status `u32` at `0x20` (§9.3) | render → all | written before the handshake; status `Atomics.store` |
| `0x00040` | 64 | frame clock: `frame_no u64`, `last_present_ms f64`, `vsync_ms f32`, `visible u8` | render → all | `Atomics.store` |
| `0x00080` | 64 | input ring **head** `u32` (own cache line) | shim → render | `Atomics.store` (release) |
| `0x000C0` | 64 | input ring **tail** `u32`, `overflow_count u32` | render → shim | `Atomics.store` |
| `0x00100` | 512 | captured-chord table: `generation u32`, `count u32`, 126 × `u32` chord hashes | render → shim | seqlock on `generation` |
| `0x00300` | 64 | ui→core ring head/tail | shell → render | as input ring |
| `0x00340` | 64 | core→ui ring head/tail | render → shell | as input ring + doorbell |
| `0x00400` | 16 KiB | copy buffer: `len u32`, `mime u8`, UTF-8 text of the current canvas selection | render → shim | seqlock |
| `0x04400` | 4 KiB | runtime counters (RUM, [T05 §4.7](T05-testing-and-performance.md#47-real-user-performance-telemetry-dash-observing-itself)); frame statistics at 0x04400–0x04D0F (`dash-protocol::layout`) | all → shell | relaxed atomics |
| `0x10000` | 64 KiB | input ring data | shim → render | SPSC |
| `0x20000` | 64 KiB | ui→core ring data | shell → render | SPSC |
| `0x30000` | 64 KiB | core→ui ring data | render → shell | SPSC |

Outside the control block, the **chunk arena** (owned by data workers) and the **render staging
slabs** are ordinary Rust allocations in the shared heap (`talc` or `dlmalloc` with atomics).

#### T03-005 — Control block layout is versioned and generated
**MUST** — The control block MUST follow the table above for layout version 1. The JS offsets MUST be
generated from `dash-protocol` by `cargo xtask gen` (with capability bits and status codes),
committed as `web/shim/layout.gen.js`, diffed by `ci:shim-lint`. A shim whose layout version differs
from the core's MUST force a reload.

#### T03-006 — Rings are SPSC with release/acquire ordering
**MUST** — Every ring MUST have exactly one producer and one consumer, 8-byte-aligned
variable-length records, and head and tail on separate 64-byte cache lines. The producer MUST write
the payload, then store the head with release ordering; the consumer MUST read the head with acquire
ordering (`AtomicU32` `Release`/`Acquire` in Rust, `Atomics.load/store` in JS).

#### T03-007 — Published chunks are immutable; readers pin
**MUST** — A data worker MUST write network bytes into a slab, decode it in place
([T04 §5.7](T04-wire-format-and-data-plane.md#57-zero-copy-path-from-network-to-gpu)) and publish an
`Arc<Chunk>` into the chunk table with `arc-swap`, after which no thread writes to it. The render
worker MUST pin the chunks it needs per frame (refcount increment) and drop them after
`queue.submit`. Eviction removes a chunk from the table; memory is freed when the last `Arc` drops.

#### T03-008 — The render worker never waits on another thread's lock
**MUST** — All cross-thread handoff into the render worker MUST use `arc-swap`, SPSC rings or
`crossbeam` channels with `try_recv`. A CI lint MUST deny `std::sync::Mutex` and `RwLock` in the
crates the render worker links (`dash-scene`, `dash-gpu`, `dash-marks`, `dash-state`), with an
audited allowlist.

### 4.4 State ownership

The **render worker owns the authoritative state store** (`dash-state`): the Context (entity set,
time window and time cursor, A/B windows and baseline, filters, selection, focus), the camera per
scene, camera history and the undo stack. This keeps the input → state → frame path on one thread.

The shell holds a **read-only mirror**: Leptos signals updated from `ContextChanged` records on the
core → ui ring. DOM edits (a filter chip removed, a time typed in the Ribbon, a table row clicked)
go to the render worker as `Command` records on the ui → core ring and come back as
`ContextChanged`. Undo/redo therefore has one owner.

**Reducer.** `dash-state` is a pure reducer `(State, Command) → (State, Inverse, Effects)`. Effects
are query invalidations for the planner, URL commits and DOM commands. Context propagation follows
[02 §5](../product/02-information-architecture.md#5-context-propagation-rules) exactly, as a table in
code:

| Command | Entity set | Time | Filters | Baseline |
|---|---|---|---|---|
| `ZoomIntoChild(entity)` | narrows to child | kept | kept (if applicable) | kept |
| `Pivot(signal)` | kept | kept | translated (label ⇄ attribute names, IA-027 table) | kept |
| `Brush(range)` | kept | **set to brush** (undoable) | kept | kept |
| `ClickInstance(span or log line)` | narrows to its instance | keeps window, adds focus instant | adds `trace_id` | kept |
| `OpenBoard(uid)` | Board variables seeded from Context by name | kept unless the Board pins time | Board's | kept |
| `PinToInvestigation` | snapshot of all four | snapshot | snapshot | snapshot |

Window keys are commands too: `StepWindow(±1)` moves the window by one width (`[` / `]`) and
`ZoomWindow(×2 | ÷2)` zooms it about its centre (`-` / `=`).

**Undo.** Every Context-changing command (brush, filter add/remove, entity narrow, window step and
zoom, axis range, compare offset) and every Board edit (M-UI5) pushes its inverse onto the undo
stack. `⌘Z` and `⌘⇧Z` are reserved global keys. Camera moves are **not** on the undo stack; they are
on camera history (§4.6), so undo and back stay distinct.

#### T03-009 — One authoritative state store
**MUST** — *(Revised 2026-11-19, ADR-0014 §2.)* The Context, selection, camera history and undo
stack MUST be owned by the TS application's Context store. The engine MUST NOT change them except by
emitting events that the store reduces, and every view MUST read entity set, time, filters and
baseline from this Context.

#### T03-010 — Every Context command has an inverse
**MUST** — Every `Command` that changes the Context or a Board MUST return an inverse, and
`undo ∘ apply` MUST be the identity on the canonical state. Propagation MUST follow the table above.

### 4.5 Keymap and input contexts

The **keymap lives in core**, so one table serves canvas and global shortcuts. Bindings are data
(`keymaps/default.toml`, plus the shipped presets), keyed by **physical key** (`KeyboardEvent.code`)
and modifiers, so `Shift+1` and `?` work on non-US layouts. The binding table is
[03 §4.2](../product/03-interaction-model.md#42-keyboard-expert-speed) verbatim, including its
context column and milestones.

**Contexts and precedence.** Text input → Fly → 3D → Est / Board → S / Room → G, innermost first.
Text input is decided in the shim: key events whose target is editable are not forwarded (§5.4), so
Leptos handles typing, IME, autofill, `Esc` (leave the field) and `⌘Z` (undo typing).

**Key state machine** (`dash-state::keys`), driven only by record timestamps `t_ms`, never by wall
clock:
- **Tap vs hold.** For keys with tap and hold actions (`.`, `V`) and hold-only actions (`Space`,
  `D`): released < 250 ms after KeyDown → tap; held ≥ 250 ms → hold, which starts at the 250 ms mark
  (evaluated each frame) and ends on KeyUp. `Space`-scrub tracks pointer motion provisionally from
  KeyDown and commits it only once the hold is established.
- **Chords.** `g` enters a pending state with a 1 000 ms deadline. The next key completes the chord
  (`g a` Alerts, `g b` Boards, `g i` Investigations, `g s` Space, `g l` Logs, `g t` Traces,
  `g m` Metrics, `g p` Profiles); any other key or the deadline cancels it with no side effect. `g`
  alone is never bound.
- **Region focus.** `F6` / `Shift+F6` emit `Command::FocusRegion(next | prev)` to the shell, which
  moves DOM focus through sidebar → page header → page content (canvas) → open panels, plus the
  Time Ribbon in Space scenes (INT-015). The canvas element is
  focusable (`tabindex=0`), so keyboard users can always leave and re-enter it.

**Captured chords.** Each time the active keymap or context changes, core writes the hashes of the
keys it handles in the current context to the captured-chord table. The shim computes
`fnv1a32(code) ^ mods` per keydown and calls `preventDefault()` synchronously if the hash is in the
table. This stops the browser's own `Alt+←`, `F6`, `⌘K` and `/` behaviour exactly when Dash handles
them.

**Shortcut overlay.** `?` makes core emit `ShortcutOverlay` (every binding active in the current
scene and context, after remaps, with the user's layout labels from `navigator.keyboard.getLayoutMap()`
where available) for the shell to render ([T08](T08-dom-component-kit.md)).

#### T03-011 — No key bound twice in a context
**MUST** — The keymap loader MUST reject a table (default, preset or user remap) in which a key,
including modifiers and the tap/hold distinction, maps to two actions in one context, in which an
inner context overrides an outer key without the † mark, or in which anything other than Text input
overrides `⌘K`, `?`, `Esc`, `⌘Z` or `⌘⇧Z`. The same validator MUST run in CI over every shipped
table and at runtime on remap, where a refusal names the existing action.

#### T03-012 — Tap/hold and chord timing come from record timestamps
**MUST** — Tap/hold MUST use a 250 ms threshold and chords a 1 000 ms timeout, both measured on input
record `t_ms`, so replays reproduce them exactly.

#### T03-013 — preventDefault is decided synchronously
**MUST** — *(Revised 2026-11-19.)* The TS keymap MUST decide `preventDefault()` inside the DOM
handler, synchronously, and MUST NOT act on key events whose target is editable, except for the
reserved keys of T03-011.

### 4.6 URL, history and camera encoding

The URL is **derived from state**. `dash-state::url` encodes the Context, scene and camera into the
[02 §4](../product/02-information-architecture.md#4-url--state-model) patterns
(`/t/{tenant}/space/{scene}?e=…&from=…&to=…&cmp=…&f=…&cam=…&persp=…`, `/t/{tenant}/board/{uid}?var-x=…&vp=…`,
`/t/{tenant}/inv/{id}#evidence-{n}`, `/t/{tenant}/incident/{id}`, `/t/{tenant}/alerts/{view}?…`).
The shell writes `history.pushState` when a `ContextChanged` carries `commit = true` (a committed
camera move or a committed Context change) and `history.replaceState` otherwise.

**Camera history** is browser history. A committed camera move pushes a history entry; browser
back/forward, `Alt+←` / `Alt+→` and the mouse back/forward buttons all produce `popstate`, which the
shell turns into `Command::RestoreCamera(url)`. Mouse buttons 3/4 are left to the browser, so the
three paths cannot diverge.

**Compact camera (`cam`).** A small binary struct, base64url without padding:

| Byte(s) | Field | Notes |
|---|---|---|
| 0 | `ver:2 | mode:3 | flags:3` | mode: 0 2D, 1 Orbit, 2 Fly, 3 Map |
| 2D | `y_lo f32`, `y_hi f32`, `pins u8` | X comes from `from`/`to`; Y range of the focused viewport's default axis; manual-pin bitmask |
| Orbit | `focus xyz 3×f32`, `yaw i16`, `pitch i16`, `dist f32` | angles in 0.01° |
| Fly | `pos xyz 3×f32`, `yaw i16`, `pitch i16` | no roll (INT-005) |
| Map | `centre xy 2×f32`, `height f32`, `rot i16` | tilt-locked |
| last | `crc8` | rejects corrupted links |

The largest form (Orbit) is 22 bytes → 30 characters, under the 64-character limit.

**Copy link.** `Command::CopyLink { keep_relative }` resolves relative time (`now-1h`) to absolute
`from`/`to` at the moment of copying, unless `keep_relative` is set, and writes the URL through
`navigator.clipboard.writeText` in the shell.

#### T03-014 — The URL reproduces the view
**MUST** — Every Space scene, Board, Investigation, Incident and Alerts-room view MUST be encoded by
the URL codec such that decoding it in a fresh session, with the same access, restores the same
Context, scene, focused viewport and camera pose.

#### T03-015 — Compact, exact camera encoding
**MUST** — `cam` MUST be ≤ 64 characters for every camera mode and MUST restore the pose to within
one pixel at the same viewport size.

#### T03-016 — Browser history is camera history
**MUST** — Every committed camera move MUST push exactly one history entry, and every history
navigation MUST restore its camera through `popstate`, whether it came from the browser, `Alt+←/→`
or the mouse buttons.

#### T03-017 — Shared links pin absolute time by default
**MUST** — "Copy link" MUST write absolute `from`/`to` unless the user chose "keep relative".

## 5. Interfaces

### 5.1 Shim files and line budget

| File | Role | Budget (lines) |
|---|---|---|
| `web/shim/boot.js` | capability probe, COOP/COEP check, `compileStreaming`, worker spawn, boot handshake, shell start | 70 |
| `web/shim/worker.js` | worker entry: instantiate the core module with the shared memory, dispatch by `role`, install doorbells and rAF | 35 |
| `web/shim/net.js` | fetch/WebSocket byte pump (data workers) | 65 |
| `web/shim/input.js` | DOM event capture → input ring; copy/paste; ResizeObserver; Prefs media queries hand-off | 90 |
| `web/shim/sw.js` | service worker (contents owned by T20 (draft)) | 35 |
| **Total** | | **295 / 300** |

A CI job (`xtask shim-lint`, gate `ci:shim-lint`) counts non-blank, non-comment lines of every JS
file under `web/shim/` that git tracks or does not ignore, and enforces T03-001. Shim code has no
regex literals (use `new RegExp`), writes `/` for division only right after an identifier, number,
`]` or non-keyword `)` on the same line, and is ASCII outside strings and comments; the lint rejects
any other `/`. `ci:dep-audit` admits only the files in this table, each SHA-256-pinned in
`ci/shim-pins.toml`. wasm-bindgen output (glue, `.wasm`, `snippets/`, the `wasm-bindgen-rayon`
helper) goes to the git-ignored `web/shim/gen/<crate>/`, accepted only with a regenerate-and-compare
check ([T05 §7.1](T05-testing-and-performance.md#71-gate-catalogue)). `layout.gen.js` (unpinned) and
`gen/dash-core-{mt,st}/` are admitted only when byte-identical to a fresh `cargo xtask gen`; other
`gen/` entries fail.

### 5.2 Bootstrap and the network byte pump

**Bootstrap handshake** (`boot.js` → each worker, one `postMessage`):

| Field | Type | Notes |
|---|---|---|
| `role` | `"render" \| "data" \| "layout" \| "pool" \| "editor" \| "geo"` | |
| `mode` | `"mt" \| "st"` | which core artefact the worker loads (§9.2) |
| `index` | `u32` | data worker index; 0 = coordinator |
| `module` | `WebAssembly.Module` | compiled once on main and structured-cloned to workers |
| `memory` | `WebAssembly.Memory` | created by the render worker's instantiation, returned in its first `status`; absent for satellites and `-st` |
| `canvas` | `OffscreenCanvas` | render only (transferred) |
| `ports` | `MessagePort[]` | doorbells (§4.2) |
| `main_time_origin` | `f64` | `performance.timeOrigin` of main, to rebase `event.timeStamp` |
| `caps` | `u32` | capability bits (§9.1) |
| `query` | `string` | `location.search` (`?mode=`, test-only `?fault=`); a T2 restart passes `"?mode=t2"`. Until `/bootstrap` carries the flags (M-UI1) |
| `boot` | `ArrayBuffer` | bytes of `GET /api/dash/v1/bootstrap` (session, tenant, scope epoch, wire versions, flags; JSON, parsed in Rust) |

**Worker ↔ boot messages** (besides the handshakes: at most render, a T2 restart and data-0 per page):

| Direction | Message | Fields |
|---|---|---|
| render → boot | `{t: "status", status, layout, cb, memory}` | after `render_start`: status code or `RETRY_T2` (§9.3), layout version, control-block address, the shared memory (`mt`; `null` in `st`) |
| render → boot | `{t: "status", status}` | the frame loop stopped; the control block's status |
| boot → render (`st`) | `{t: "input", buf, len, dropped}` | once per main rAF while no batch is in flight; `buf` (10 240 bytes) transferred |
| render → boot (`st`) | `{t: "ack", buf}` | after the batch is in the ring; `buf` transferred back |

Full mode sends input through the input ring, never by message.

**Rust → shim imports** (`#[wasm_bindgen(module = "/web/shim/net.js")]`, data workers only):

| Function | Behaviour |
|---|---|
| `net_open(id: u32, method: &str, url: &str, headers: &str, body: &[u8], prio: u8)` | `fetch` with an `AbortController` per id. `headers` is `k: v\r\n`-joined. The body is **copied out of shared memory** with `.slice()`, because fetch and `TextDecoder` reject shared views. `prio` maps to `fetch` `priority` (`high`/`auto`/`low`) where supported |
| `net_cancel(id: u32)` | `controller.abort()` → HTTP/2 `RST_STREAM` ([T04 §5.4](T04-wire-format-and-data-plane.md#54-request-ids-priorities-and-cancellation)) |
| `ws_open(id: u32, url: &str, protocol: &str)` / `ws_send(id, data: &[u8])` / `ws_close(id, code: u16)` | `WebSocket` with `binaryType = "arraybuffer"` |

**Shim → Rust exports** (callbacks, called on the same worker):

| Function | Behaviour |
|---|---|
| `net_head(id: u32, status: u16, headers: String)` | after the response headers |
| `net_alloc(id: u32, len: u32) -> u32` | returns a pointer to a 64-byte-aligned slab of ≥ `len` bytes in the chunk arena; 0 = backpressure (the shim stops reading and retries on the next doorbell) |
| `net_commit(id: u32, ptr: u32, len: u32)` | after `new Uint8Array(memory.buffer, ptr, len).set(chunk)`: the **only copy** on the network path |
| `net_end(id: u32, code: i32)` | `0` ok; `-1` network error; `-2` aborted; `-3` body error |
| `ws_event(id: u32, kind: u8, code: u16)` | open / close / error; data frames use `net_alloc`/`net_commit` with the same id |

#### T03-018 — The byte pump never parses
**MUST** — `net.js` MUST NOT parse, inspect or buffer bytes beyond the single chunk it is copying.
Backpressure MUST be applied by not calling `reader.read()`, which propagates through HTTP/2 flow
control to the BFF.

### 5.3 Core ↔ shell messages

Both rings carry `[kind u16][len u16][seq u32][postcard payload]` records, defined once in the
`dash-protocol` crate that both modules link. The shell side is `dash-shell::bridge`, which copies
records with `Uint8Array::copy_from`/`copy_to`.

| Direction | Message | Payload (summary) |
|---|---|---|
| core → ui | `ContextChanged` | full Context diff, `commit: bool`, `undo_depth`, URL |
| core → ui | `TooltipAnchor` | viewport id, CSS rect, content model ([T08](T08-dom-component-kit.md) renders it) |
| core → ui | `SelectionChanged` / `InspectorModel` | selection key, Inspector sections, pivot chips |
| core → ui | `A11ySummary` | viewport id, summary text, table model ([05 §13](../product/05-visualisation-catalogue.md#13-accessibility-of-data-vis)) |
| core → ui | `LegendModel` | entries, values, axis-ownership glyphs, "N in band" |
| core → ui | `ShortcutOverlay` | active bindings per context (§4.5) |
| core → ui | `Command` | open palette, focus query bar, focus region, toast, open room, copy link, download (bytes ptr) |
| core → ui | `CoverageChanged` | viewport id, coverage badge model ([T04 §5.3](T04-wire-format-and-data-plane.md#53-coverage-block-coverage1-r10)) |
| ui → core | `Command` | keymap-independent intents from DOM (pin, compare, filter add/remove, time set, select row, restore camera) |
| ui → core | `RoomGeometry` | DOM panels occluding the canvas (for picking and safe-area framing) |
| ui → core | `Prefs` | theme, density, keymap, locale, time zone, reduced motion |

### 5.4 Input ring record format

Every record starts with a 16-byte header and is padded to a multiple of 8 bytes. All values are
little-endian. Coordinates are CSS pixels relative to the canvas's content box. The render worker
multiplies by `dpr`.

| Off | Type | Header field |
|---|---|---|
| 0 | `u8` | `kind` |
| 1 | `u8` | `flags`: bit0 coalesced, bit1 predicted, bit2 synthetic (replay/test), bit3 overflowed-before |
| 2 | `u16` | `size`, header included |
| 4 | `u32` | `seq`, monotonic per tab |
| 8 | `f64` | `t_ms`: `event.timeStamp` on the main time origin |

`mods` (`u16`): bit0 Shift, bit1 Ctrl, bit2 Alt, bit3 Meta, bit4 AltGraph, bit5 CapsLock.

| Kind | Name | Size | Payload (offset: type field) |
|---|---|---|---|
| `0x01–0x04` | PointerDown / Move / Up / Cancel | 40 | 16 `f32` x · 20 `f32` y · 24 `u32` pointer_id · 28 `u16` mods · 30 `u16` buttons · 32 `i8` button · 33 `u8` ptype (0 mouse, 1 pen, 2 touch) · 34 `u8` pressure×255 · 35 `u8` pad · 36 `u8` width · 37 `u8` height · 38 `i8` tilt_x · 39 `i8` tilt_y |
| `0x05` | Wheel | 40 | 16 `f32` x · 20 `f32` y · 24 `f32` dx · 28 `f32` dy · 32 `u16` mods · 34 `u8` mode (0 px, 1 line, 2 page) · pad |
| `0x06` | PointerEnter / Leave | 24 | 16 `u32` pointer_id · 20 `u8` enter |
| `0x10–0x11` | KeyDown / KeyUp | 24 + n | 16 `u16` mods · 18 `u8` repeat · 19 `u8` location · 20 `u8` code_len · 21 `u8` key_len · 22 pad · 24 UTF-8 `code` then `key` |
| `0x20` | Resize | 40 | 16 `f32` css_w · 20 `f32` css_h · 24 `f32` dpr · 28 `u32` device_w · 32 `u32` device_h (from `devicePixelContentBoxSize`, else rounded) |
| `0x21` | Focus / Visibility | 24 | 16 `u8` 0 blur, 1 focus, 2 hidden, 3 visible |
| `0x22` | Prefs | 24 | 16 `u32` bits: reduced-motion, dark, forced-colors, reduced-transparency, coarse-pointer |
| `0x30` | Gamepad snapshot | 24 + 4a + b | *reserved for M-UI6*: 16 `u8` index · 17 `u8` n_axes (a) · 18 `u8` n_buttons (b) · 20 `u32` pressed bitmask · 24 `f32`×a axes · `u8`×b analog values |
| `0x40` | Paste | 24 + n | 16 `u32` len · 20 `u8` mime (0 text) · 24 UTF-8 (≤ 16 KiB inline; longer is truncated with flag bit3) |
| `0x7F` | Marker | 24 | 16 `u64` tag (replay sync, [T05 §4.4](T05-testing-and-performance.md#44-deterministic-input-replay-pdrec)) |

`0x00` Wrap: one byte; continue at offset 0. Head and tail are free-running `u32` byte counters; no
record straddles the end.

Capture rules (`input.js`):
- Pointer, wheel, contextmenu and dblclick listeners attach to the canvas element. Wheel is
  `{passive:false}` and always `preventDefault()`s. Double-click is *derived in Rust* from pointer
  records, so `dblclick` is only suppressed. `setPointerCapture` runs synchronously on pointerdown.
- While any button is down, `pointermove` writes `getCoalescedEvents()`, because brush, lasso and
  draw-to-ask (M-UI4) need the full path. ≤ 16 per event (T03-003): longer lists subsampled, first
  and last kept, bit0 set.
- Key events attach to `window`. They are **not forwarded** when `event.target` is editable
  (`input`, `textarea`, `[contenteditable]`). Otherwise the shim applies T03-013.
- `copy` on the canvas reads the copy buffer synchronously (seqlock) and calls
  `clipboardData.setData`. This needs no Rust call inside the handler.
- `matchMedia` changes (reduced motion, colour scheme, forced colours) are written as a Prefs record,
  so the render worker applies them on the next frame.
- **Overflow.** When free space is less than the record size, Move and Wheel are coalesced into one
  pending record (latest position, summed deltas). Discrete records go into a bounded JS backlog of
  1 024 entries that is flushed first on the next event or rAF. Past 1 024 they are dropped and
  `overflow_count` is incremented. At 64 KiB the ring holds about 1 600 pointer records, about 25×
  the input of a 120 Hz frame with coalesced pen input. A handler writes ≤ 32 queued entries before
  its own, a main rAF callback ≤ 256 (T03-003, PRF-005); the rest leave later, in order.

#### T03-019 — Input is read at frame start
**MUST** — The render worker MUST drain the input ring at the start of every frame, before camera
and scene updates, so every record present at frame start is reflected in that frame.

#### T03-020 — Overflow never loses discrete input silently
**MUST** — On ring overflow the shim MUST coalesce Move and Wheel, MUST queue discrete records in the
1 024-entry backlog, and MUST count every dropped record in `overflow_count`.

### 5.5 Browser integrations

These are implemented in **Rust via `web-sys`** in the shell and cost no hand-written JS:
`history` push/replace and `popstate`, downloads (Blob + `<a download>`, used by CSV export),
`navigator.clipboard.writeText`, `document.title`, `navigator.keyboard.getLayoutMap()`,
`visibilitychange`, and `PerformanceObserver` for long tasks and long animation frames
([T05 §4.7](T05-testing-and-performance.md#47-real-user-performance-telemetry-dash-observing-itself)).
Only the cases that need a *synchronous* answer inside a DOM event handler (`preventDefault`
decisions, `copy`) or a dedicated thread for latency (input) stay in JS.

### 5.6 wasm-bindgen, web-sys and threads

- `wasm-bindgen --target web`. No bundler. ES-module glue served next to the `.wasm`.
- **`web-sys` features are allow-listed** per crate in `Cargo.toml`. Core enables only the WebGPU,
  WebGL2, OffscreenCanvas, IndexedDB, MessagePort and Performance features. No `serde-wasm-bindgen`
  on hot paths. No `JsValue` crosses a boundary per frame except wgpu's own calls.
- **Threads.** `dash-core-mt` builds on a pinned nightly with
  `RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128"` and
  `-Z build-std=panic_abort,std`, which threaded wasm32 needs today. Shell and `-st` build on stable.
  The rayon pool uses **`wasm-bindgen-rayon`** in M-UI0; its worker helper is audited and counted as
  third-party glue. `worker.js` already supports `role = "pool"`, so a later milestone can replace
  the helper with `rayon::ThreadPoolBuilder::spawn_handler` driven by the shim (§13, Q2).
- **Build profile.** `lto = "fat"`, `codegen-units = 1`, `panic = "abort"`. Core is optimised with
  `wasm-opt -O3`, shell and satellites with `-Oz`. Leptos and the component kit get per-package
  `opt-level = "z"`. DWARF is split off and kept server-side to symbolicate RUM panics.
- **Arrow.** Depend on `arrow-ipc`, `arrow-array`, `arrow-buffer`, `arrow-schema` and `arrow-data`
  with default features off, not the `arrow` umbrella crate, to keep the compute kernels out of core.

#### T03-021 — Pool reductions are deterministic
**MUST** — Anything that affects pixels or state MUST use indexed parallel iterators with fixed
chunk sizes, so results are independent of thread count and scheduling (T02-015, T02-030).

### 5.7 HTTP headers the runtime requires

| Header | Value | Why |
|---|---|---|
| `Cross-Origin-Opener-Policy` | `same-origin` | cross-origin isolation, needed for SAB |
| `Cross-Origin-Embedder-Policy` | `require-corp` (default); `credentialless` as a per-deployment option | as above; `credentialless` eases third-party images, but browser support varies (Q5) |
| `Cross-Origin-Resource-Policy` | `same-origin` on all Dash assets | `require-corp` |
| CSP (minimum; full policy in [T18](T18-security.md)) | `script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; font-src 'self'` | WASM compile, same-origin workers, BFF only, self-hosted fonts |
| `Cache-Control` | `public, max-age=31536000, immutable` on hashed artefacts; `no-cache` on `index.html` | warm-cache startup (§7.1) |

Consequences: every subresource (avatars, map tiles, runbook images) is served or proxied
same-origin by the BFF ([T06](T06-bff-architecture.md)). SSO uses full-page redirects, not popups,
because COOP `same-origin` severs `window.opener` (T10 (draft)). Embedding Dash in another portal's
iframe requires that portal to be cross-origin isolated too; otherwise the embed runs in the §9
single-threaded mode.

#### T03-022 — Required headers
**MUST** — The BFF MUST serve every Dash document and asset with the COOP, COEP, CORP and minimum
CSP values above. A deployment that strips them MUST still work, in ST mode (§9), with the banner.

## 6. Data & storage

| Data | Where | Owner |
|---|---|---|
| Control block, rings | core shared memory, 256 KiB | render |
| Arrow chunks, staging slabs | core shared memory (chunk arena) | data workers; layout in [T04 §5.7](T04-wire-format-and-data-plane.md#57-zero-copy-path-from-network-to-gpu) |
| GPU buffers and textures | GPU (counted in the tab on unified-memory machines) | render |
| Context, camera, undo stack, keymap | core (render worker) | render |
| Context mirror, DOM state | shell memory | shell |
| Chunk and scene cache | IndexedDB, from data-0 via `web-sys` | [T04 §6.1](T04-wire-format-and-data-plane.md#61-indexeddb-chunk-cache) |
| User keymap remaps, Prefs | Postgres user preferences ([T11](T11-postgres-schema.md)), cached in shell | shell |
| Compiled WASM | browser HTTP and code cache | browser |

**Memory budget** on (a), heaviest scene ([PRF-023](../product/09-performance-contract.md#prf-023--memory-budget), < 1.5 GB tab): core shared memory ≤ 1.2 GB
(arena ≤ 1.0 GB, enforced by T04 eviction), shell ≤ 64 MB, satellites ≤ 64 MB each, browser overhead
the remainder.

#### T03-023 — Memory never runs out; it degrades
**MUST** — data-0 MUST start degradation at 85 % of the arena cap (drop raw chunks for rollups,
raise LOD bias, [T04 §5.7](T04-wire-format-and-data-plane.md#57-zero-copy-path-from-network-to-gpu)),
MUST switch affected viewports to rollups within 1 s, and MUST NOT let `memory.grow` fail.

## 7. Performance budget

### 7.1 Startup sequence (warm HTTP cache, reference (a))

```
 t(ms) 0        50        150       300       450       600        800      1000
       │ HTML+shim│          │         │         │         │          │         │
 main  ├─probe──┤ compileStreaming(shell) ─┤ shell start → chrome DOM painted (FCP) ┊
       │        ├ fetch /bootstrap ──┤     │                                      ┊
       │        ├ compileStreaming(core-mt) ───────┤ post Module to workers         ┊
 render│                                           ├inst┤ adapter+device ┤ pipelines ┤ first frame (cached scene)
 data-0│                                           ├inst┤ IDB scene read ┤ planner → BFF requests ───► refine
       └─────────────────────────────── interactive (input ring live, ⌘K accepted) ≤ 1000 ┘
```

| Phase | Budget | Notes / ties to 09 |
|---|---|---|
| HTML parse + shim execute + capability probe | ≤ 30 ms | shim is ~6 KB brotli, `modulepreload` |
| Shell compile + instantiate (code-cached) | ≤ 120 ms | from `compileStreaming` started at t ≈ 30 ms |
| **First contentful paint** (sidebar and page header) | **≤ 300 ms** | no data spinners ([VL-015](../product/08-visual-language.md#vl-015--no-spinners-on-data)) |
| Core compile (code-cached) | ≤ 150 ms | in parallel with the shell |
| Worker instantiate (each, shared memory) | ≤ 30 ms | all workers in parallel |
| WebGPU adapter + device | ≤ 120 ms | WebGL2 context ≤ 40 ms |
| Pipeline creation for the first scene's marks | ≤ 100 ms | M1/M3/M4/M8 first; others compiled in idle frames |
| **First canvas frame** (from the IndexedDB scene snapshot, hatched as stale) | **≤ 600 ms** | [PRF-026](../product/09-performance-contract.md#prf-026--show-cached-marked-stale) |
| **Interactive shell** (sidebar, page header and palette responsive; `⌘K` accepted) | **< 1.0 s** p75 of 20 runs on (a) and (b) | [PRF-008](../product/09-performance-contract.md#prf-008--cold-load-to-interactive-shell) |
| Cold (no HTTP cache): network-bound | ≤ 2.5 s on 50 Mbit/s | informational; core ~1.9 MB br |

Preload: `index.html` carries `<link rel="modulepreload">` for the shim and
`<link rel="preload" as="fetch" crossorigin>` for the shell and **core-mt**. The server sets
COOP/COEP, so isolation is the expected case. Chrome caches compiled code for streamed WASM; other
engines' code caching is measured in M-UI0, and the ≤ 150 ms figure may not hold there.

### 7.2 Steady-state budgets

| Metric | Budget | 09 |
|---|---|---|
| Main-thread time per input event (shim) | ≤ 0.05 ms p99 | [PRF-005](../product/09-performance-contract.md#prf-005--no-main-thread-long-tasks-during-interaction) |
| Input record → visible in render frame | read at frame start; ≤ 1 frame median, ≤ 2 frames p99 | [PRF-003](../product/09-performance-contract.md#prf-003--input-to-photon), [PRF-004](../product/09-performance-contract.md#prf-004--input-to-photon-hard-limit) |
| Main-thread shell work per frame during canvas interaction | ≤ 2 ms p99 (mirror updates only) | [PRF-005](../product/09-performance-contract.md#prf-005--no-main-thread-long-tasks-during-interaction) |
| Doorbells per queue per frame | ≤ 1 | — |
| Render worker frame CPU (excluding GPU) | ≤ 8 ms p99 on (b) | [PRF-002](../product/09-performance-contract.md#prf-002--frame-rate-floor) |

### 7.3 WASM size budget

Brotli sizes, checked per PR by gate `ci:bundle-size` ([PRF-009](../product/09-performance-contract.md#prf-009--core-bundle-size-and-lazy-loading), [PRF-033](../product/09-performance-contract.md#prf-033--bundle-size-and-dom-room-gates)); report-only until enforcement is enabled ([T05 §7.1](T05-testing-and-performance.md#71-gate-catalogue)).

| Artefact | Budget | Notes |
|---|---|---|
| shim (all files) | ≤ 8 KB | |
| `dash-shell.wasm` + glue | ≤ 700 KB | Leptos core, kit core, bridge |
| `dash-core-mt.wasm` + glue | ≤ 1 900 KB | wgpu (WebGPU + GL), arrow-ipc, marks, scales, text shaping, planner, local engine |
| `dash-core-st.wasm` + glue | ≤ 1 900 KB | ST fallback (§9.2); loaded instead of core-mt when not isolated (not eager) |
| **Eager total** | **≤ 2 600 KB** | 400 KB headroom below the 3 MB ceiling of [PRF-009](../product/09-performance-contract.md#prf-009--core-bundle-size-and-lazy-loading) |
| MSDF atlases (Inter + JetBrains Mono, Latin) | ≤ 250 KB | not WASM; other scripts lazy |
| `dash-editor.wasm` | ≤ 600 KB | lazy |
| `dash-rooms-admin.wasm` | ≤ 500 KB | lazy |
| Each workbench satellite | ≤ 400 KB | lazy |
| `dash-geo.wasm` | ≤ 800 KB | lazy, M-UI5 |
| `chrono-tz` slice | ≤ 40 KB per region group | lazy |

The artefact → path mapping is `ci/bundle-budgets.toml`: each WASM module is the whole
`web/shim/gen/<crate>/` directory (glue and snippets count); workbench satellites are crates
`dash-wb-<workbench>` and `chrono-tz` slices `web/assets/tz/*.bin`, each measured separately;
atlases are `web/assets/msdf/latin/`.

wgpu, cosmic-text/rustybuzz and arrow-ipc are the size risks. M-UI0 measures each with `twiggy` and
records the result in this table. A text stack over budget falls back to `rustybuzz` plus our own
line layout without `cosmic-text`.

## 8. Security, tenancy & RBAC

- Cross-origin isolation is a security feature as well as an enabler: it is what makes
  high-resolution timers and SAB acceptable post-Spectre. All workers are same-origin module
  workers. There are no blob-URL workers, so CSP `worker-src 'self'` holds.
- The shim exposes **no globals** in production. The test probe (`window.__dashProbe`,
  [T05](T05-testing-and-performance.md)) is compiled only into `test` builds, and CI asserts it is
  absent from release artefacts (`ci:probe-absent`).
- Satellites get no network capability. Their worker has no `net.js` role, and future third-party
  vis modules (M-UI6) run as satellites under [T18](T18-security.md)'s sandbox rules.
- The control block holds no secrets. Session cookies are `HttpOnly` and never visible to WASM
  (T10 (draft)). Paste records exist only when the canvas has focus.

#### T03-024 — No test hooks in release builds
**MUST** — Release artefacts MUST NOT contain the test probe or any global exposed by the shim.

## 9. Failure modes & degradation

### 9.1 Capability probe (`boot.js`)

| Bit | Probe |
|---|---|
| `ISOLATED` | `self.crossOriginIsolated && typeof SharedArrayBuffer === "function"` |
| `OFFSCREEN` | `"transferControlToOffscreen" in HTMLCanvasElement.prototype` |
| `WEBGPU` | `"gpu" in navigator` (adapter confirmed later in render) |
| `WEBGL2` | probed in the render worker on an `OffscreenCanvas` |
| `WAIT_ASYNC` | `typeof Atomics.waitAsync === "function"` |
| `DPCB` | `devicePixelContentBoxSize` supported by ResizeObserver |

### 9.2 Degradation matrix

| Condition | Mode | What runs | What the user sees |
|---|---|---|---|
| All present | **Full** | §4.2 | — |
| No WebGPU adapter / device | **Tier T2** ([T02 §4.9](T02-vis-engine.md#49-capability-tiers-and-the-gallery)) | wgpu GL backend in the render worker; compute on the pool. A WebGPU failure after the canvas holds its context restarts the render worker once on a fresh canvas with T2. | coverage meter shows "WebGL2 tier" where a ceiling binds |
| Not cross-origin isolated (headers stripped by a proxy, non-isolated embed) | **Single-thread (ST)** | `dash-core-st` in **one** worker (render + data + layout), no pool; input via `postMessage` with transfer, batched per frame, ≤ 1 batch unacknowledged (the worker returns the buffer) | banner "Reduced performance: cross-origin isolation is off (ask your admin)"; ceilings: 10⁷ line points, 10⁶ scatter, 2k Atlas entities; RUM flags it |
| No OffscreenCanvas | **Main-thread render (MT-R)** | `dash-core-st` on main, time-sliced (≤ 8 ms per slice), data decoded in a worker and transferred. Static until MT-R ships (§11). | banner; only Lens, Alert Lens and workbenches supported; Atlas falls back to the Explorer list ([15](../product/15-estate-navigation.md)) |
| No WebGL2 either | **Static** | shell only; viewports show server-rendered PNGs from the BFF's native renderer ([T02 §4.9](T02-vis-engine.md#49-capability-tiers-and-the-gallery)), refreshed on Context change | "Interactive charts unavailable on this browser"; Alert Lens, ack and silence still work |
| GPU device lost | recover | render recreates the device and re-uploads from arena chunks (CPU-resident) | ≤ 500 ms with no blank frame: the last frame stays on screen; logged |
| Worker crash / WASM trap | recover | panic hook records the trace (RUM); `boot.js` respawns the worker; data workers are restartable; a render restart re-reads the Context from the shell mirror and the URL | toast "Recovered from an error"; a second crash in 60 s → reload prompt with the replay attached ([T05](T05-testing-and-performance.md)) |
| Memory near cap | degrade | T03-023, T04 eviction: raw → rollup; LOD bias raised | coverage meter "reduced resolution (memory)" |
| HTTP/1.1 to the BFF (proxy downgrade) | degrade | works, 6-connection limit | RUM flags `nextHopProtocol`; admin diagnostic |
| Stale shim after deploy (layout version mismatch) | reload | T03-005 | "Pulsus was updated — reload" |

Supported browsers: current and previous Chrome/Edge (T1), Firefox stable and ESR, Safari 17+.
WebGPU availability in Firefox and Safari differs by OS and version, so the matrix is re-verified at
each milestone and the probe never hard-codes version numbers.

*Milestone note (#23):* before M-UI4 each mode shows the runtime page's status line and mode banner;
Alert Lens entries bind from M-UI4.

#### T03-025 — Never a blank page
**MUST** — Every capability combination MUST map to one of the modes above, and every mode MUST show
the chrome and at least the Alert Lens path. *Milestone note:* before M-UI4, 'the chrome' is the
runtime page with its status line and mode banner; the Alert Lens clause applies from M-UI4 (#23).

### 9.3 Runtime status codes

The render worker writes the status to the control block (`0x20`); `boot.js` mirrors it to
`<html data-dash-status>` and sets `<html data-dash-mode>` (`mt` | `st`) before spawning workers.
All text is in `index.html`.

| Status | Page shows | Canvas |
|---|---|---|
| 0 Booting (initial) | — | visible |
| 1 TierT1 | badge "Tier: WebGPU (T1)" | visible |
| 2 TierT2 | badge "Tier: WebGL2 (T2)" | visible |
| 3 Static (no adapter; no OffscreenCanvas) | "Interactive charts unavailable on this browser" | hidden |
| 4 Failed | "Interactive charts failed. Reload the page." | hidden |
| 5 Stale | "Pulsus was updated — reload" | hidden |
| mode `st` (any status) | banner "Reduced performance: cross-origin isolation is off (ask your admin)" | — |

`RETRY_T2` (`0x100`) is a `render_start` result, never written to the page: the canvas is committed
to a failed WebGPU context, so `boot.js` restarts the render worker once on a fresh canvas with
`?mode=t2`; a second `RETRY_T2` is Failed. Booting longer than 10 s is Failed.

## 10. Testing

Owned by [T05](T05-testing-and-performance.md). Specific to this doc:
- **Shim contract** (`e2e:shim-fuzz`). A Playwright fuzz test dispatches random DOM events and
  asserts that the Rust decoder sees the same values. `layout.gen.js` is regenerated and diffed in CI
  (`ci:shim-lint`) once its generator exists (T05 §7.1).
- **Mode matrix** (`e2e:mode-matrix`). Each §9.2 mode is forced by query flag
  (`?mode=t2|st|mtr|static`) and gets a smoke suite in CI.
- **Ring stress** (`unit:ring-stress`). Native loom/shuttle tests of the SPSC rings and the
  chunk-table pinning. A wasm test pushes 10⁶ records through each ring, stalling the consumer at
  random to exercise the overflow path.
- **Keymap** (`ci:keymap-check`, `unit:keymap-fsm`, `replay:key-bindings`). Conflict validation over
  every shipped table; tap/hold and chord timing on synthetic timestamps; one replay per binding row.
- **URL and camera codecs** (`unit:url-codec`, `unit:cam-codec`). Round-trip properties and the
  64-character bound.
- **Startup trace** (`bench:startup`). A cold and warm boot timeline on every lab run (§7.1 phases as
  `performance.mark`s from the shim plus Rust spans).

## 11. Rollout

| Milestone | Ships |
|---|---|
| M-UI0 | shim (boot, worker, net, input), one `dash-core-mt` (shell features stubbed in core), render + 2 data + pool, control block v1, T1/T2, ST mode with the `-st` artefact, size gate; no OffscreenCanvas → Static |
| M-UI1 | shell/core split (Leptos on main), ui↔core rings, keymap in core with captured chords, URL/history and `cam` codec, undo stack, `dash-editor` satellite, workbench satellites, MT-R mode |
| M-UI2–M-UI3 | layout worker under load (T14 (draft)), local engine in core (T13 (draft)), memory degradation at scale |
| M-UI5 | `dash-geo`, admin rooms satellite, `sw.js` (T20 (draft)) |
| M-UI6 | gamepad and SpaceMouse capture; third-party vis satellites ([T18](T18-security.md)) |

Feature flags in `/bootstrap`: `force_tier`, `force_mode`, `n_data`, `pool_size`. The layout version
in the control block header lets a stale shim (cached `index.html` across a deploy) be detected,
which forces a reload.

## 12. Alternatives considered

| Alternative | Why not |
|---|---|
| Single module on main + workers sharing memory | Rust on main would hit `memory.atomic.wait` through std locks and allocator contention; it would trap or jank. Splitting shell and core costs one message hop for DOM updates, which is cheap |
| Rust does fetch via `web-sys` directly (no `net.js`) | Workable, and kept as a fallback. The JS pump is ~65 lines, keeps the promise/stream plumbing out of WASM and shrinks core. Revisit if the line budget is tight |
| `postMessage` for input | One task hop per event, structured-clone cost, and a main → worker latency of a few ms under load. That breaks ≤ 1 frame |
| Function-level code splitting of threaded WASM (`wasm-split`-style tooling) | Not mature for shared-memory modules today. Re-evaluate in M-UI3 for workbench-specific code |
| Render on main thread | Any DOM room work would drop canvas frames. Kept only as the MT-R fallback |
| Data workers as rayon threads | Idle rayon threads block in `Atomics.wait` and would starve their fetch event loop |
| Keymap in the shell (DOM) | Canvas shortcuts would need a hop to the render worker per key; two owners of focus context |
| Camera moves on the undo stack | Mixes navigation with edits; `⌘Z` would fly the camera. Camera history is browser history instead |

## 13. Open questions

1. **Q1** Does `GPUQueue.writeBuffer` accept views on shared memory in every target engine (the spec
   type is `AllowSharedBufferSource`)? If not, wgpu's web backend must stage through a non-shared
   buffer, which adds a copy ([T04 §5.7](T04-wire-format-and-data-plane.md#57-zero-copy-path-from-network-to-gpu)).
   Measure in M-UI0.
2. **Q2** Keep `wasm-bindgen-rayon`'s helper, or move to a shim-driven `spawn_handler`?
3. **Q3** Worker `requestAnimationFrame` with OffscreenCanvas is available in Chrome and Firefox;
   Safari's behaviour needs verification. The fallback is a `setTimeout` loop paced by the frame
   clock.
4. **Q4** Does the 1.9 MB core budget survive wgpu's dual backend? If not, ship T1-only and T2-only
   core variants, selected at boot (one extra artefact, no extra download).
5. **Q5** `COEP: credentialless` support in Safari, which decides whether it can be the default.
6. **Q6** `navigator.keyboard.getLayoutMap()` is Chromium-only. Firefox and Safari overlay labels fall
   back to US labels for physical keys.

**Resolved during formalisation**

1. **Key bindings follow 03.** The draft cited draw-to-ask as "03 §2.2 `D`", undo as "03 §7" and LIVE
   as "03 §4". The formal sections are [03 §4.2](../product/03-interaction-model.md#42-keyboard-expert-speed),
   [03 §9](../product/03-interaction-model.md#9-undo-everywhere) and
   [03 §6](../product/03-interaction-model.md#6-time-as-a-dimension). The keymap engine (§4.5) was
   added to implement the formal contexts, precedence, reserved keys, 250 ms tap/hold, 1 s chords and
   `F6` region focus, none of which the draft specified.
2. **Gamepad deferred.** The draft's shim polled `navigator.getGamepads()`. Gamepad is a MAY at
   M-UI6, so the record kind is reserved and the polling code moves to M-UI6.
3. **URL and camera codec added** (§4.6) for [IA-022](../product/02-information-architecture.md#ia-022--deep-links-reproduce-the-view) to [IA-025](../product/02-information-architecture.md#ia-025--browser-history-is-camera-history); camera history is browser
   history, and camera moves are not on the undo stack.
4. **Interactive shell** is measured to `⌘K` acceptance at p75 over 20 runs, per [PRF-008](../product/09-performance-contract.md#prf-008--cold-load-to-interactive-shell).
5. **Workbench lazy loading.** [PRF-009](../product/09-performance-contract.md#prf-009--core-bundle-size-and-lazy-loading) requires signal workbenches to be lazy; workbench
   satellites were added to the artefact table.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft. Restructured to the template; design rules T03-001 to T03-025; added the state reducer and propagation table (§4.4), the keymap engine (§4.5) and the URL/camera codec (§4.6); gamepad deferred to M-UI6; workbench satellites; Satisfies table |
| 1.0-rc | 2026-11-18 | #22: §5.1 states what `ci:shim-lint` counts, the `/` rule for shim code and the SHA-256 pins checked by `ci:dep-audit`; generated output goes to the git-ignored `web/shim/gen/<crate>/`; T03-001 exclusions and the §10 `layout.gen.js` diff apply once their regenerate-and-compare checks exist; §7.3 is report-only until enforcement is enabled and names the artefact → path mapping |
| 1.0-rc | 2026-11-18 | #23: §4.3 header and counters rows name the fields and offsets; T03-005 names its generator (`cargo xtask gen`, `layout.gen.js`); §5.1 admits `layout.gen.js` and `gen/dash-core-{mt,st}/` by regenerate-and-compare; §5.2 handshake `mode`, `query`, `memory` and the worker messages; §5.4 coalescing and flush bounds, the wrap marker; §7.3 `dash-core-st` row; §9.2 ST batch bound, T2 restart, Static without OffscreenCanvas, milestone note; T03-025 milestone note; new §9.3 status codes; §10 `?mode=t2`; §11 ST with the `-st` artefact in M-UI0 |
| 1.1-rc | 2026-11-19 | [ADR-0014](../adr/0014-typescript-react-web-client.md): new §0 applicability table; the document now describes the chart engine runtime; T03-001, T03-009 and T03-013 revised; shim line budget withdrawn |
| 1.2-rc | 2026-11-19 | Product text revised to D9 (roadmap Q13 closed): IA-021 row verified by `e2e:rooms-reachable`; §4.5 region focus order; §7.1 first paint and interactive shell are the sidebar, page header and palette |
