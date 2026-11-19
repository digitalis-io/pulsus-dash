# Browser runtime

How the browser runs Pulsus Dash in M-UI0: the JS shim, the render and data workers, the shared
control block and input ring, the GPU tier fallback, and how to run and test it locally. The demo
page (`web/index.html`) draws one instanced rect mark (10 000 rects in one draw call), animated and
brightened around the pointer, on a canvas the main thread never renders.

Implements [VIZ-001](../../designs/product/05-visualisation-catalogue.md),
[PRF-005](../../designs/product/09-performance-contract.md#prf-005--no-main-thread-long-tasks-during-interaction)
(CI merge gate), [PRF-044](../../designs/product/09-performance-contract.md) (tiers),
[T01-003 and T01-004](../../designs/technical/T01-frontend-architecture.md), and
[T03-001, T03-003, T03-005, T03-006, T03-007, T03-019, T03-020, T03-022, T03-024 and T03-025](../../designs/technical/T03-browser-runtime.md),
following [ADR-0001](../../designs/adr/0001-rust-wasm-everywhere.md),
[ADR-0002](../../designs/adr/0002-no-js-ui-framework.md) and
[ADR-0007](../../designs/adr/README.md). The test gates are in
[T05 §7.1](../../designs/technical/T05-testing-and-performance.md#71-gate-catalogue).

## Modes and threads

`boot.js` probes the capabilities (T03 §9.1) and picks a mode before loading any WASM:

| Mode | When | Core artefact | Workers |
|---|---|---|---|
| **Full** (`mt`) | cross-origin isolated (`crossOriginIsolated` and `SharedArrayBuffer`) | `dash-core-mt` (`+atomics`, one shared `WebAssembly.Memory`, max 2 GiB) | `render`, `data-0` |
| **ST** (`st`) | not isolated, or `?mode=st` | `dash-core-st` (same crate, built without atomics, own memory) | `render` only (it also publishes the instances) |
| **Static** | no `OffscreenCanvas` (until MT-R ships, M-UI1), `?mode=static`, or no GPU tier | none rendered | none, or a render worker that found no tier |

The mode is written to `<html data-dash-mode>` (`mt` | `st`) and the status to
`<html data-dash-status>` (below). In ST mode the page shows the banner "Reduced performance:
cross-origin isolation is off (ask your admin)".

| Thread | Runs | Owns | Never |
|---|---|---|---|
| main | `boot.js`, `input.js`, the HTML | DOM, input listeners, the input queue | instantiates the core, renders, waits on an atomic |
| render | `worker.js` + the core | the control block, the GPU device and surface, the rect pipeline, the scene, the input-ring consumer, frame statistics | takes a lock shared with another thread |
| data-0 (Full only) | `worker.js` + `dash-core-mt` | the instance chunk it publishes | writes a chunk after publishing it |

The main thread compiles the core once (`WebAssembly.compileStreaming`) and sends the module to the
workers; it never instantiates it. In Full mode the render worker's instantiation creates the shared
memory and returns it in its first status message; boot then hands it to data-0. data-0 publishes
the scene's instances into the chunk table (`arc-swap`); the render worker pins the chunk each frame
and drops the pin after `queue.submit` (T03-007).

## The shim

Three hand-written files in `web/shim/`, plus the generated `layout.gen.js` and the git-ignored
wasm-bindgen output in `web/shim/gen/dash-core-{mt,st}/`:

| File | Budget (code lines) | Does |
|---|---|---|
| `boot.js` | ≤ 70 | the Trusted Types policy, capability probe, mode, compile, spawn workers and handshakes, status → `<html>`, T2 restart, stale-layout stop, 10 s boot timeout |
| `worker.js` | ≤ 35 | imports the glue of its mode, instantiates the module, dispatches by `role` (`render`, `data`), runs the frame loop on the worker's `requestAnimationFrame` (`setTimeout(16)` where it is absent), answers ST input batches |
| `input.js` | ≤ 90 | canvas listeners, record encoding, the bounded queue, the ring and batch sinks |
| `layout.gen.js` | excluded | control-block offsets, capability bits and status codes, generated from `dash-protocol` |

The three files total ≤ 195 lines of the 300 of T03-001, and each is SHA-256-pinned in
`ci/shim-pins.toml` (see [Build, test and CI](../development/build-and-ci.md)). `layout.gen.js` is
written by `cargo xtask gen` from `dash_protocol::layout::render_js()` and committed; `ci:shim-lint`
and `ci:dep-audit` accept it only while it is byte-identical to its generator.

**Trusted Types (T18-005).** `boot.js` creates the one policy the CSP allows, `pulsus-sanitised`,
once at the top level: `createHTML` passes input through (the Rust-side `SanitisedHtml` type guards
it) and `createScriptURL` accepts only same-origin URLs (T18-007), throwing `TypeError` otherwise.
Workers are created with `new Worker(scriptURL(new URL("./worker.js", import.meta.url)), …)`; where
the browser has no Trusted Types, `scriptURL` returns the URL unchanged. The shim has no other DOM
sink; `worker.js` uses only `import()` and `postMessage`. `ci:shim-lint` accepts the `scriptURL(…)`
wrapper around a literal worker URL.

**Messages.** Each worker gets one handshake (`role`, `mode`, `index`, `module`, `main_time_origin`,
`caps`, `query`; plus the transferred `canvas` for render, the shared `memory` for data-0). The
render worker answers `{t: "status", status, layout, cb, memory}` once `render_start` resolves, and
`{t: "status", status}` if its frame loop stops. In ST mode input travels as
`{t: "input", buf, len, dropped}` and comes back as `{t: "ack", buf}`. Full mode sends no input by
message.

## Control block (layout v1)

The render worker allocates one zeroed, 64-byte aligned 256 KiB block, leaks it, and returns its
address (`control_block()`). The regions are the T03 §4.3 table; the fields used in #23
(`dash_protocol::layout::off`, mirrored as `OFF_*` in `layout.gen.js`):

| Offset | Field | Written by |
|---|---|---|
| `0x00` | magic `PDCB` | render, before the handshake |
| `0x04` | layout version `u16` = 1 | render |
| `0x08` | capability bits `u32` (`ISOLATED 1`, `OFFSCREEN 2`, `WEBGPU 4`, `WEBGL2 8`, `WAIT_ASYNC 16`, `DPCB 32`); render ORs in `WEBGL2` on T2 | boot → render |
| `0x0C` | boot epoch `u32` = 1 | render |
| `0x20` | runtime status `u32` (below) | render |
| `0x40` / `0x48` / `0x54` | frame number `u64`, last present time `f64` (main time origin), visible `u8` | render, each frame |
| `0x80` / `0xC0` | input ring head / tail `u32` (separate cache lines) | shim / render |
| `0xC4` | input overflow count `u32` | shim (Full), render (ST) |
| `0x4400`–`0x4D0F` | frame statistics (below) | render |
| `0x10000` | input ring data, 64 KiB | shim / render |

A shim whose `LAYOUT_VERSION` differs from the core's (`layout_version()`) shows "Pulsus was
updated — reload" and terminates every worker (T03-005).

## Input

**Records** (`dash_protocol::input`, T03 §5.4): a 16-byte header (`kind`, `flags`, `size`, `seq`,
`t_ms` = `event.timeStamp` on the main time origin) and a payload, padded to 8 bytes,
little-endian. #23 emits pointer down/move/up/cancel and wheel (40 bytes each), resize (40) and
visibility (24). `flags`: bit0 coalesced, bit3 overflowed-before. Coordinates are `offsetX/offsetY`
(the canvas has no border or padding); resize carries `devicePixelContentBoxSize` where available,
else the CSS size × `devicePixelRatio`.

| Event (target) | Record |
|---|---|
| `pointerdown` / `up` / `cancel` (canvas) | one record; `setPointerCapture` on down |
| `pointermove` (canvas) | buttons down: one per `getCoalescedEvents()` entry, at most 16 (longer lists subsampled, first and last kept, all bit0); no button: the event only, bit0 if coalesced |
| `wheel` (canvas, `passive: false`) | one record, always `preventDefault()` |
| `ResizeObserver` (canvas) | one resize record |
| `visibilitychange` (document) | 2 hidden, 3 visible |

**The ring** (`dash_protocol::ring`, T03-006) is single-producer, single-consumer. Head and tail are
free-running `u32` byte counters. A record that does not fit before the end is preceded by a
one-byte wrap marker (`0x00`) and written at offset 0. The producer writes the payload, then stores
the head with release ordering; the consumer loads the head with acquire ordering. An undecodable
record, or a wrap marker that cannot be one (at position 0, or not followed by published bytes
past the end), makes the consumer skip to the head and count it in `FS_RING_CORRUPT`.

**The queue** (`input.js`, T03-020) sits in front of the sink:

| Bound | Value |
|---|---|
| Move and Wheel | one coalescing slot each (latest position, summed wheel deltas, bit0), never dropped |
| Discrete records | FIFO backlog of 1 024 (`BACKLOG_MAX`); past it the record is dropped and counted (`INPUT_OVERFLOW`); the next accepted discrete record carries bit3 |
| Per event handler | ≤ 32 queued writes (`FLUSH_PER_EVENT`) before its own ≤ 16 records |
| Per main rAF callback | ≤ 256 queued writes (`FLUSH_PER_RAF`); rescheduled while the queue is not empty |

Entries leave in ascending `seq`. An empty queue writes straight to the ring.

**ST batches.** In ST mode the sink is one 10 240-byte `ArrayBuffer` (`BATCH_BYTES`). Each main rAF
fills it with up to 256 records and posts it (transferred) with the count of main-side drops; the
render worker pushes the records into its own ring (`render_input`) and transfers the buffer back.
While a batch is unacknowledged nothing else is posted, so at most one batch (≤ 10 240 bytes) is in
flight; input waits in the bounded queue.

## Frame loop

Each worker `requestAnimationFrame` (`render_frame(t)`):

1. take the start time;
2. drain the input ring into the scene **before** any update (T03-019); a resize record resizes the
   canvas and reconfigures the surface;
3. pin the instance chunk; a new generation uploads the instance buffers once;
4. compute the uniforms; acquire the surface texture (lost or outdated: reconfigure and skip; timeout
   or occluded: skip; other: Failed);
5. one render pass: clear to the canvas background, one `draw(0..6, 0..10 000)`; submit; present;
   drop the pin; a lost device sets Failed and stops the loop;
6. update the frame clock and the frame statistics.

**Frame statistics** (control block `FS_*`): frames recorded, a 64-bucket histogram of frame
intervals (0.5 ms buckets; the last holds ≥ 31.5 ms), intervals over 50 ms, and the last 256
intervals and render CPU times (ms). They are exported for the later frame-time gates; the probe
reads them as `frameStats()`.

## GPU tiers and fallback

`dash-gpu` tries WebGPU when the worker has `navigator.gpu`, then WebGL2 (both through wgpu 30), with
WebGL2-level limits, no features, FIFO presentation and the first non-sRGB surface format.

| Failure | Result |
|---|---|
| WebGPU adapter or device unavailable, or WebGPU `create_surface` fails (no context created) | WebGL2 on the same canvas |
| WebGPU fails after the canvas holds its context (format, `configure`) | `RETRY_T2`: boot restarts the render worker once on a fresh canvas with `?mode=t2`; a second restart is Failed |
| WebGL2 context unavailable | Static |
| `OffscreenCanvas` missing | Static, no worker (MT-R is M-UI1) |
| core fails to load, a worker errors, or Booting for 10 s | Failed |

## Status codes

| `data-dash-status` | Page shows | Canvas |
|---|---|---|
| 0 Booting (initial) | — | visible |
| 1 TierT1 | badge "Tier: WebGPU (T1)" | visible |
| 2 TierT2 | badge "Tier: WebGL2 (T2)" | visible |
| 3 Static | "Interactive charts unavailable on this browser" | hidden |
| 4 Failed | "Interactive charts failed. Reload the page." | hidden |
| 5 Stale | "Pulsus was updated — reload" | hidden |

`RETRY_T2` (256) is a `render_start` result only; it is never shown. All text lives in
`web/index.html`; `boot.js` sets only the two `data-` attributes (T03-025).

## Query flags

| Flag | Effect |
|---|---|
| `?mode=t2` | WebGL2 only |
| `?mode=static` | Static |
| `?mode=st` | ST mode even when isolated |
| `?fault=webgpu-device` / `?fault=webgpu-surface` | probe builds only: fail WebGPU before / after the surface (tests the two fallback paths). Ignored by release builds |

## Headers

The runtime needs the T03 §5.7 headers (T03-022): COOP `same-origin` and COEP `require-corp` for
isolation, CORP `same-origin`, and at least the CSP `script-src 'self' 'wasm-unsafe-eval';
worker-src 'self'; connect-src 'self'; font-src 'self'`. Without COOP/COEP the page still works, in
ST mode with the banner.

The `pulsus-dash` binary serves the page with the full production set (T18-002): the strict CSP
with `require-trusted-types-for 'script'` and `trusted-types pulsus-sanitised`, on every static
response (workers take CSP and COEP from their own response), plus HSTS, `Referrer-Policy` and
`Permissions-Policy` on the document; see
[Server architecture](../server/architecture.md#static-assets-and-security-headers). `style-src
'self'` forbids inline styles, so the page's styles live in `web/shell.css`. `cargo xtask serve`
sends the T03 §5.7 minimum only (below); it stays for header-stripping tests (`--no-isolation`).

## Test probe

Builds with the `probe` feature of `dash-core-mt` (only `cargo xtask gen --test` and the `e2e` gate)
install `self.__dashProbe` on the render worker:

| Method | Returns |
|---|---|
| `status()` | the control block's status |
| `frameStats()` | `{frames, longFrames, hist[64], intervalsMs[], cpuMs[]}` |
| `frameStarts()` | the last 256 `{frame, tMainMs}` |
| `inputLog()` | the last 8 192 drained records `{kind, flags, seq, tMs, x, y, frame}` |
| `threads()` | `{sharedMemory, instancesPublishedBy}` |
| `pauseInput(b)` | stops or resumes draining the input ring |
| `overflowCount()` | the input overflow count |

Release artefacts never contain it (T03-024): `ci:probe-absent` scans a fresh release build of both
artefacts for the marker `__dashProbe`, and the `e2e` gate checks that the marker is found in the
probe build, which proves the scan works.

## Performance checks in CI

- **Main-thread long tasks (PRF-005).** After the page reaches T1/T2 and settles for 1.5 s (so
  the renderer's own startup tasks, such as the delayed shutdown of the initial `about:blank`
  widget in the non-isolated project, fall outside the window), the `e2e` gate records a Chrome
  trace during 5 s (or more) of scripted pointer movement in the `webgpu`, `webgl2` and `noiso` projects
  (`e2e/test-results/traces/long-tasks-<project>.json`). `dash-lab::trace::long_tasks` finds the
  renderer main thread (the `CrRendererMain` with the most input events), takes the window from the
  first to the last input `EventDispatch`, and counts top-level `RunTask`s on it. CI fails on any
  task over 16 ms of thread time or 50 ms of wall time (`main-thread-long-task`), on a missing trace
  (`long-task-trace-missing`), and errors on a trace it cannot judge (no main thread, no input, no
  task, no thread time). The reference-lab gate (`bench:long-tasks`, wall > 16 ms) blocks merges
  once the lab exists.
- **Shim per-event time (T03-003).** `e2e/tests/input-queue.spec.ts` times every call of the
  installed input listeners on a fixed 300×300 canvas: workload N (ring always free), B (ring full,
  backlog, drops, 32-entry flushes) and R (300 trusted mouse sequences with 1 200 trusted wheel
  events), plus a control run of R on a bare listener (`getCoalescedEvents`, `offsetX/Y`, capture,
  `preventDefault`) and the times of the 66c rAF flush callbacks. CI only **reports** these times
  (p50, p99, max in `e2e/test-results/traces/shim-cost.json`; wall-clock gates do not run on shared
  runners, T05-006). It **asserts** the deterministic checks: no call writes more than 48 records; B
  overflows the ring and advances by exactly one 32-entry flush; R's trusted counts (300 down,
  300 up, 300–2 700 move, 1 200 wheel); 66c writes 256, 256, 256, 256, 2 records in `seq` order.
  The budgets (p99 ≤ 0.050 ms for N and B, median of three, and for R all and wheel; rAF callback
  ≤ 2 ms) are gated by `bench:shim-input-cost` on the reference lab, blocking like
  `bench:long-tasks` once the lab exists. Test 68 runs on `/?mode=static` (isolated, no scene), so
  the software GPU does not pace trusted input. On a 16-core development machine N and B measured
  p99 0.030 and 0.020 ms, R 0.075 ms against 0.070 ms for the bare-listener control: R is
  dominated by the browser's own trusted-event work.

Frame-rate numbers are not gated in CI (T05-006). CI renders with SwiftShader, where the
10 000-rect scene runs at about 10 fps.

## Running locally

```bash
cargo xtask dev up           # tools, both artefacts into web/, the stack and the binary on :8080
# or, without Postgres and the binary:
cargo xtask tools            # once: pinned nightly, wasm-bindgen, wasm-opt
cargo xtask gen              # build both artefacts into web/shim/gen/ (and refresh layout.gen.js)
cargo xtask serve            # http://localhost:8080 with the T03 §5.7 headers
cargo xtask serve --no-isolation --port 8081   # ST mode
```

`cargo xtask dev up` needs Docker and the PulsusDB URL in `dev/local.env` ([Dev stack](../development/dev-stack.md)).

Open `http://localhost:8080/`. Add `?mode=t2`, `?mode=st` or `?mode=static` to force a mode. For
the probe build, `cargo xtask gen --test` writes `target/web-test/`; serve it with
`cargo xtask serve --root target/web-test`. The end-to-end suite runs with
`cargo xtask ci e2e` (it builds `target/web-test/`, serves it with the binary on port 8787 and with
the header-stripping dev server on 8788, then runs the `dev up` flow on 8789).

## Limits

- One mark type and one data worker; no shell, no data plane, no device-loss recovery or worker
  respawn (M-UI1). A lost device or a trap shows Failed.
- No OffscreenCanvas → Static until the MT-R mode ships.
- `navigator.gpu` present but no adapter counts as "no WebGPU": the WebGPU attempt fails before the
  surface and WebGL2 runs on the same canvas.
- The threaded glue carries wasm-bindgen's `Atomics.waitAsync` fallback, which spawns a blob-URL
  worker on browsers without `Atomics.waitAsync`; CSP `worker-src 'self'` and Trusted Types block
  it there. Current Chromium has `Atomics.waitAsync`.
- `dash-tokens::spike` holds provisional colours until the token set (epic #3) replaces them.

## Design mapping

| Code | Design |
|---|---|
| `crates/dash-protocol` (`layout`, `status`, `input`, `ring`) | T03 §4.3, §5.4, §9.3; T03-005, T03-006 |
| `crates/dash-gpu` (`tier`, `web`) | T03 §9.2, PRF-044, T03-025 |
| `crates/dash-scene::spike`, `crates/dash-marks::rect` | VIZ-001 (one instanced mark, one draw call) |
| `crates/dash-core-mt` (`render`, `data`, `chunk`, `frame_input`, `frame_stats`, `probe`) | T01-003, T01-004, T03-007, T03-019, T03-024 |
| `web/shim/{boot,worker,input}.js`, `web/index.html`, `web/shell.css` | T03-001, T03-003, T03-020, T03-022, T03-025, T18-005 |
| `crates/dash-lab::trace`, `xtask e2e` | PRF-005, T05 §4.3 |
