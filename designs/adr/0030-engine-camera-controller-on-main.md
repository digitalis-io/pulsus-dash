# ADR-0030: A 2D engine frame's camera controller is the application's, on the main thread; amends 0014 §2 and 0020 decision 4

| | |
|---|---|
| **Status** | Accepted (2026-11-26, on merge of #68 Part C2a2, under the owner's standing authorisation for pipeline design changes) |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md) §2 ("the engine owns only render-local state (gesture camera, …)"): for 2D charts the gesture camera is the main-thread controller's. [ADR-0020](0020-chart-camera-commit-and-value-range.md) decision 4 ("the later `WasmEngine` emits `commit` from the worker's gesture end"): the controller emits it on the main thread. The rest of both ADRs is unchanged |
| **Source** | Issue #68 Part C2a2 (the shared camera controller on engine frames) |
| **See** | [T03](../technical/T03-browser-runtime.md) §4.2, §4.4, §6, §12; [T02](../technical/T02-vis-engine.md) §4.6; [T05](../technical/T05-testing-and-performance.md) §7.1 (`e2e:engine-camera`, `bench:shim-input-cost`); [ADR-0019](0019-chart-frame-drawn-event-and-frame-id.md) |

## Context

ADR-0014 §2 gave the engine the camera *during* a gesture, and ADR-0020 had the WASM engine emit
`commit` from the worker's gesture end. #93 then built the 2D camera policy in TypeScript: the
wheel, pinch, swipe and drag gestures, the held value-label band (T02-011, T02-021), the whole-ms
pan step of a sub-minimum view and the commit rules, with one set of unit tests. Part A of #68
gave the engine camera primitives and a caller-supplied band, and no gesture policy (D-GESTURE):
"one controller, one set of tests, for both engines".

Porting the controller to Rust would duplicate that policy and its tests, and the two copies would
drift. The DOM listeners are on the main thread already; the engine frame's canvas element stays
in the page after its transfer and receives its events.

## Decision

1. **The controller runs on the main thread.** A 2D engine frame's camera controller is #93's
   `FrameController`, shared with the Canvas 2D frame (`client/src/engine/controller/`), run by
   `ControlledFrame` on the canvas element. It emits `commit` and `brush` there; the worker emits
   neither.
2. **The worker applies what it is sent.** Each camera change (per axis) is one Camera record in
   the input ring (T03 §5.4): the view, the value view (auto or manual) and the band (measured or held). The
   render worker holds only the applied render state: the camera it last applied, hover and
   decoded columns.
3. **The controller acts on what is on screen.** The worker reports each completed presentation's
   stage (plot, value domain, band) with a `stage` event, only for the frame's current Resize; the
   controller reads that stage, as the Canvas 2D controller reads its last drawn layer. A withdrawn
   stage (no plot, a zero size) aborts a running gesture without a commit, back to the last
   committed camera.
4. **Space and 3D controllers are not decided here.** #94's controllers may read pointer and wheel
   records from the input ring in the render worker (T02 §4.6, L4).

## Consequences

- One controller and one set of controller tests for both engines; `e2e:engine-camera` runs #93's
  camera cases against engine frames.
- Main-thread work per input event is the controller's arithmetic and at most one Camera record
  per axis it moves (two for a zoom of both axes) (T03-003); `bench:shim-input-cost` measures the
  whole dispatch, report-only until the reference lab exists.
- The camera used by input lags the newest layout by the presentation in flight; the held band
  keeps the plot fixed through a gesture, so the anchor stays under the pointer.
- An engine restart mid-gesture creates a new controller: the gesture is dropped without a commit,
  as on dispose.
