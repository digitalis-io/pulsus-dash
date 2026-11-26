# ADR-0031: The GPU chart engine is the default renderer; Canvas 2D is the fallback; amends 0014 §4, 0022 decision 2 and 0023 decision 4

| | |
|---|---|
| **Status** | Accepted (2026-11-26, owner decision on #256) |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md) §4 (the interim Canvas 2D renderer draws every chart): line frames are drawn by the engine by default, and Canvas 2D is the fallback and draws the other kinds until #69. [ADR-0022](0022-chart-thresholds-and-stat-sparkline.md) decision 2 and [ADR-0023](0023-chart-event-markers.md) decision 4 ("labels are never dropped"): unmet on engine line frames until #69 (the accepted gap below). The rest of the three ADRs is unchanged |
| **Supersedes** | The D-SEL rule of #68 Part C1 (the engine is opt-in until #69) |
| **Source** | Issue #256 (owner decision 2026-11-26) |
| **See** | [T03](../technical/T03-browser-runtime.md) §9.2; [T02](../technical/T02-vis-engine.md) §0; [T05](../technical/T05-testing-and-performance.md) §7.1 (`e2e:mode-matrix`, `e2e:canvas2d-pin`, `ci:engine-built`); [ADR-0016](0016-asset-integrity-verified-by-bff.md); [ADR-0026](0026-engine-csp-and-worker-policy.md); [VIZ-001](../product/05-visualisation-catalogue.md#viz-001--gpu-rendering-by-one-shared-engine) |

## Context

Part C1 of #68 put the WASM engine behind the chart seam as an opt-in (`?engine=wasm`, or a
`VITE_ENGINE=wasm` build), because it draws no axis text, threshold or event labels until #69. The
engine now draws line frames with the camera, hover, selection and the box band, gated on the
pinned Mesa. Opt-in means no user ever sees it, and the work toward VIZ-001 is never exercised
outside the engine suite. The owner decided on 2026-11-26 that the engine is the default renderer
and Canvas 2D the fallback, accepting the label gap until #69.

## Decision

1. **Selection.** Per page, first match wins: the flag (the URL's `engine`, else the build's
   `VITE_ENGINE`) is `canvas2d` → Canvas 2D; the session is marked failed → Canvas 2D; `mode` is
   `st`, `mtr` or `static` → Canvas 2D; not cross-origin isolated, no OffscreenCanvas, neither
   WebGPU nor WebGL2, or no `Atomics.waitAsync` → Canvas 2D; otherwise (no flag, `wasm`, empty or any
   other value) the engine, with `forceT2` iff `mode=t2`. Line frames go to the engine, the other
   kinds to Canvas 2D (D-ROUTE, unchanged). Only `canvas2d` forces Canvas 2D.
2. **A failed boot marks the session.** When the engine does not boot (the integrity check refuses
   the wasm twice, a compile error, status 3 or 4, or no status in 10 s), its frames are on Canvas
   2D with no notice, and the session is marked (T03-025), so later pages make no engine request.
   A build without the engine (`EngineAbsent`) is not marked.
3. **Every build and dev server includes the engine.** `vite build` and the dev server refuse to
   run without `client/src/engine/wasm/gen/`, naming `make engine-wasm`; there is no opt-out, whatever the
   environment. Only the unit tests' own configuration (`client/vitest.config.ts`, which builds and
   dev servers never read) resolves the engine module to `absent.ts`. `ci:bundle-size` already reports
   `missing-artefact:engine` for a tree without it.
4. **`VITE_ENGINE=canvas2d` is a renderer override** in a build that still holds the engine. The
   main e2e suite, which runs on host browsers with uncontrolled GPUs, pins Canvas 2D this way
   (`e2e:canvas2d-pin`); the engine suite proves the default on an unflagged signed-asset build.
5. **The BFF's signed manifest is the only deployment path** (ADR-0016). `npm run preview`
   computes an `/asset-manifest.json` from the `dist/` it serves, so the engine's integrity check
   runs there too; that manifest proves transit integrity only, so the preview refuses any
   non-loopback bind.

**Accepted gap until #69.** Engine line frames draw no axis labels or tick text, and no threshold
or event labels (after #68 C2c1 draws their lines). Their summaries' `thresholdLabels` and
`eventLabels` are `[]`: there is no `ThresholdHit` or `EventHit`, event labels are not
keyboard-reachable, and the summary text carries no event count. INT-031's label clause and
ADR-0022 decision 2 and ADR-0023 decision 4 ("labels are never dropped") are unmet on engine line
frames until #69. `?engine=canvas2d` restores them.

## Alternatives rejected

- **Opt-in until #69** (the D-SEL rule of #68 C1): no user sees the engine; superseded here.
- **A dev-server warning with a Canvas 2D fallback** when the engine is not built: silent, and a
  build without the engine could ship.
- **An engine-absent opt-out** variable: shippable, so the default could be lost unnoticed.
- **A manifest-less preview**: the release build's integrity check refuses the engine there.
- **`&engine=canvas2d` on the main suite's URLs**, or pinning it through the session failure flag:
  edits across the suite's specs, or a misuse of the failure path.

## Consequences

- Users get the engine's line frames by default where the browser can run it; every other case
  falls back to Canvas 2D (T03-025).
- UI-only work needs the engine built once (`make engine-wasm` in the engine web image, or
  `make client-dev`); the non-gating client workflow must build it before `npm run build`
  (follow-up issue).
- The engine suite runs one more build and three more servers (the release BFF, `vite preview`
  and the dev server).
- A blocklisted GPU with the APIs present downloads the engine and waits up to 10 s for the boot to
  fail on the first page of a session only.
