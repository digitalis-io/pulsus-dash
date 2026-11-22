# T05 — Testing & performance engineering

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.18-rc · 2026-11-21 |
| **Milestone** | M-UI0 (pyramid skeleton, goldens, R1 harness, lab (a)(b), perf gates blocking) → M-UI1 (gallery corpus, replay, lab (c), RUM) → M-UI4 (incident corpus, bug-report replay) |
| **Related ADRs** | [ADR-0014](../adr/0014-typescript-react-web-client.md), [ADR-0015](../adr/0015-go-bff.md) (both supersede ADR-0001), [ADR-0003](../adr/0003-wgpu-rendering.md), [ADR-0007](../adr/0007-in-house-vis-engine.md), [ADR-0006](../adr/0006-pulsusdb-and-postgres.md), [ADR-0012](../adr/0012-derived-state-in-postgres.md) |
| **Source draft** | plans/tech/T05-testing-and-performance.md (not tracked) |

## 0. Applicability under ADR-0014 and ADR-0015 (2026-11-19)

The web client is TypeScript + React ([ADR-0014](../adr/0014-typescript-react-web-client.md)), the
chart engine is Rust/WASM and arrives later behind the `ChartFrame` seam, and the BFF is Go
([ADR-0015](../adr/0015-go-bff.md)). The layers, rules (T05-001 to T05-015), thresholds and the lab
stand. Rust-only tooling maps as follows:

| Was | Now |
|---|---|
| L1 native Rust unit, property and fuzz tests for all logic | Per owner of the code: Vitest with property tests (`fast-check`) for the TS application (state reducer, Context, URL codec, keymap, number format, interim renderer scales and ticks); `go test -race` for the BFF (`ci:go-test`); `cargo nextest`, `proptest`, `loom`/`shuttle` and `cargo-fuzz` for the engine crates from the engine issue (#68). The property rules of §2 apply in whichever language owns the code |
| L2 native GPU goldens on headless wgpu | Stand for the engine from #68. Until then `golden:interim-gallery` renders the interim Canvas 2D gallery pages in the pinned Playwright Chromium (`toHaveScreenshot`, per-pixel threshold 0.1, at most 0.2 % differing pixels, baselines from CI only, changes only under `golden-update`); ꟻLIP and T05-004/T05-005 apply from #68 |
| L3 `wasm-bindgen-test` | Engine only, from #68 |
| L4 Playwright "via the shim" | Playwright (Chromium, Firefox, WebKit) against the production build of the React application (ADR-0014 §6); shim-contract specs apply to the engine adapter from #68 |
| `.pdrec` input-ring replays (§4.4) | Engine canvases only, from #68. Until then each `replay:*` gate runs as a Playwright script of real DOM events with the same assertions |
| Test probe in the generated glue | A TS module included only in test builds (`window.__dashProbe`, same API); `ci:probe-absent` scans the production build |
| `pulsus-fake` (Rust binary) | A Go binary in `server/` with the same fingerprint, latency and fault injection, run by the dev compose stack (ADR-0015) |
| RUM encoder in Rust (§4.7) | A minimal TS OTLP/protobuf encoder in the client; no OpenTelemetry JS package (bundle size) |
| `ci:shim-lint`, `bench:shim-input-cost`, `e2e:shim-fuzz` | `ci:shim-lint` withdrawn; the other two apply to the engine adapter from #68 |
| Rust supply-chain gates | `ci:lockfile`, `ci:npm-audit`, `ci:dep-audit` (client) and `ci:go-*`, `ci:api-gen` (server), §7.1 |

## 1. Context & problem

[09](../product/09-performance-contract.md) states its budgets as acceptance criteria measured in CI
on reference hardware. That only works if every number has a measurement method, a place it runs,
and a gate that fails. [ADR-0007](../adr/0007-in-house-vis-engine.md) adds a second obligation: we
build ~40 visualisations from 12 mark primitives, and without pixel-level regression tests a change
to one primitive silently breaks many vis specs. [05 §14](../product/05-visualisation-catalogue.md#14-showcase-gallery)
makes the public gallery the vis test corpus ([VIZ-069](../product/05-visualisation-catalogue.md#viz-069--gallery-is-the-vis-test-corpus), [VIZ-070](../product/05-visualisation-catalogue.md#viz-070--gallery-runs-on-seeded-synthetic-data)).
[13](../product/13-core-flow-storyboard.md) needs repeatable, seeded incidents, both to demo and to
evaluate the RCA engine (T15 (draft)).

The architecture helps. Application logic is plain TS and Go that tests natively and fast (§0). The
chart engine's wgpu runs headless, so engine visual tests need no browser. All input enters through one binary ring
([T03 §5.4](T03-browser-runtime.md#54-input-ring-record-format)), so sessions can be recorded and
replayed deterministically.

This document is **authoritative** for:
- the test layers;
- the **gate catalogue** (§7.1): every gate named in a Satisfies table of any technical design;
- the gallery = corpus rule and the golden-image procedure;
- benchmark definitions and perf gates;
- the replay recording format (`.pdrec`);
- the synthetic generator and incident corpus contract;
- the RUM telemetry schema for Dash itself.

## 2. Goals / non-goals

**Goals**
- Every [09](../product/09-performance-contract.md) number is measured automatically, with an owner
  and a gate.
- Every vis and every axis or interaction pattern is a gallery page, a golden test and a frame-time
  benchmark, generated from one manifest.
- PR feedback in ≤ 15 min (p90); lab results on every merge to `main` within 60 min.
- A bug report that carries a replay reproduces on a developer machine in one command.
- One seeded generator serves unit fixtures, golden images, perf scenes, the gallery, demos and RCA
  evaluation.
- Field data (RUM) validates the lab budgets on real hardware.

**Non-goals**
- Backend load testing of PulsusDB itself (PulsusDB's own benchmarks).
- The BFF's service-level tests beyond the data-plane contract ([T06](T06-bff-architecture.md)).
- AI answer-quality metrics (T15 (draft)). This doc supplies their corpus.
- Mobile real-device budgets (PRF-035 to PRF-042, M-UI4), measured nightly on a device lab owned by
  T20 (draft); the gate shapes here apply.

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [PRN-011](../product/01-vision-and-principles.md#prn-011--every-surface-traces-to-a-job) | §7.1 | `ci:design-check` (spec review: every 04 surface lists its job ranks) |
| [PRN-003](../product/01-vision-and-principles.md#prn-003--speed-is-the-feature) | §4.3, §7.1 | `bench:frame-gallery`, `bench:input-photon`, `bench:offline-interaction` |
| [PRF-001](../product/09-performance-contract.md#prf-001--frame-rate-during-interaction) | §4.3 (measurement), §7.1 (co-satisfied with T02) | `bench:frame-gallery`; `bench:frame-high-hz` |
| [PRF-002](../product/09-performance-contract.md#prf-002--frame-rate-floor) | §4.3, §7.1 (co-satisfied with T02) | `bench:frame-gallery` |
| [PRF-003](../product/09-performance-contract.md#prf-003--input-to-photon) | §4.3 (input → photon method; co-satisfied with T03) | `bench:input-photon` |
| [PRF-004](../product/09-performance-contract.md#prf-004--input-to-photon-hard-limit) | §4.3 (co-satisfied with T03) | `bench:input-photon` |
| [PRF-005](../product/09-performance-contract.md#prf-005--no-main-thread-long-tasks-during-interaction) | §4.3 (co-satisfied with T03) | `bench:long-tasks` |
| [PRF-006](../product/09-performance-contract.md#prf-006--no-interaction-waits-on-the-network) | §4.3 (co-satisfied with T01, T04) | `bench:offline-interaction` |
| [PRF-023](../product/09-performance-contract.md#prf-023--memory-budget) | §4.3 (memory method; co-satisfied with T03) | `bench:memory-heaviest` |
| [PRF-032](../product/09-performance-contract.md#prf-032--per-visualisation-gpu-benchmarks-in-ci) | §4.3, §7.1 | `bench:frame-gallery` (Chrome WebGPU and WebGL2 legs on (a) and (b); fails on PRF-001/PRF-002) |
| [PRF-033](../product/09-performance-contract.md#prf-033--bundle-size-and-dom-room-gates) | §7.1 | `ci:bundle-size`; `bench:inp-rooms` |
| [VIZ-004](../product/05-visualisation-catalogue.md#viz-004--scale-targets-per-vis) | §4.2, §4.3 | `bench:frame-gallery` |
| [VIZ-069](../product/05-visualisation-catalogue.md#viz-069--gallery-is-the-vis-test-corpus) | §4.2 | `ci:gallery-manifest` |
| [VIZ-070](../product/05-visualisation-catalogue.md#viz-070--gallery-runs-on-seeded-synthetic-data) | §4.2, §4.5 | `e2e:gallery-offline`; `golden:gallery` (two seeded runs identical) |

## 4. Design

### 4.1 Test pyramid

```
                         ┌───────────────────────┐  L6 RUM (field)        continuous, PulsusDB (self-telemetry)
                       ┌─┴───────────────────────┴─┐ L5 lab perf            merge/nightly, (a)(b)(c)
                     ┌─┴───────────────────────────┴─┐ L4 Playwright E2E + replay   PR (smoke) + nightly
                   ┌─┴───────────────────────────────┴─┐ L3 wasm tests       PR
                 ┌─┴───────────────────────────────────┴─┐ L2 native GPU goldens PR
               ┌─┴───────────────────────────────────────┴─┐ L1 native unit/property/fuzz + static CI checks  PR
               └───────────────────────────────────────────┘
```

| Layer | Runner | Scope | Volume / time budget |
|---|---|---|---|
| **L1** native unit, property, fuzz; static checks | `cargo nextest`, `proptest`, `loom`/`shuttle`, `cargo-fuzz` (nightly); `xtask` linters | scales, ticks, units, decimation, layout engines, state reducers, keymap, URL/camera codecs, planner, DSF/Arrow codecs, JSON→Arrow, cache keys, rings; lints over shim, tokens, specs, keymaps, bundles | ~10⁴ tests, ≤ 6 min on 16 cores |
| **L2** native GPU goldens | `dash-golden` on headless wgpu (§4.2) | every gallery page × variants; every mark primitive; transitions at fixed t | ~3 000 images, ≤ 6 min |
| **L3** wasm tests | `wasm-bindgen-test` in headless Chrome and Firefox | code that touches `web-sys`: IndexedDB, net glue, atomics/threads, shared-memory layout, WebGL2 context creation | ≤ 300 tests, ≤ 4 min |
| **L4** Playwright via the shim, and `.pdrec` replays | Playwright (test tooling only; never shipped) against the real build + BFF + seeded PulsusDB or the fake upstream | user flows, mode matrix ([T03 §9](T03-browser-runtime.md#9-failure-modes--degradation)), shim contract, a11y, deep links, replay specs | PR smoke ≤ 40 specs / 8 min; nightly ~400 |
| **L5** lab perf | `dash-lab` agents on reference hardware (§4.6) | frame time, latency, memory, startup, INP | merge: ≤ 45 min; nightly full |
| **L6** RUM | Dash in production → PulsusDB self-telemetry | the same metrics as L5 | continuous |

Property tests that are fixed requirements:
- **decimation** never hides a spike: for every pixel column, the min and max of the raw data appear
  in the output ([T02 §4.4](T02-vis-engine.md#44-lod-decimation-and-precision));
- **ticks** never overlap at any width from 40 to 8 000 px and in any time zone, including DST days;
- **axes**: no two bands overlap; tick labels never collide across stacked lanes; a pan on axis A
  leaves every mark bound to axis B pixel-identical ([T02 §4.3](T02-vis-engine.md#43-axis-system));
- **DSF and Arrow** round-trip for random batches;
- **JSON → Arrow** equals PulsusDB JSON values bit for bit, NaN and ±Inf included
  ([T04 §10](T04-wire-format-and-data-plane.md#10-testing));
- **the state store**: `undo ∘ apply = id` for every command ([T03 §4.4](T03-browser-runtime.md#44-state-ownership));
- **URL and camera codecs**: decode ∘ encode = id; `cam` ≤ 64 characters.

**The fake upstream** (`pulsus-fake`, a Rust binary) serves recorded or generated PulsusDB responses
by request fingerprint, with injectable latency, truncation, 422/429/504 and mid-stream drops. It
also serves the Postgres virtual sources from fixtures. Most L4 specs use it, which keeps them
hermetic. Nightly L4 runs against real PulsusDB and Postgres.

**The test probe.** `test` builds expose `window.__dashProbe`: `state()` returns the Context as JSON,
`frame()` waits for the next presented frame, `readback(viewport)` returns RGBA, and `inputLog()`
returns decoded input records. The probe is a cfg-gated module of the generated glue, not
hand-written shim code. CI asserts it is absent from release artefacts (`ci:probe-absent`).
Until the shell (M-UI1), the probe is the render worker's `self.__dashProbe`
(`docs/runtime/browser-runtime.md`).
Playwright drives **real DOM events** by default, so the shim's capture path is under test. Replay
specs inject recordings instead (§4.4).

**Shim contract fuzz** (`e2e:shim-fuzz`). A Playwright spec dispatches 10⁴ random pointer, wheel,
key, paste and resize events. It then asserts that the Rust decoder (probe `inputLog()`) saw
identical fields, in order, with no loss beyond counted overflow.

#### T05-001 — Every 09 number has a gate and an owner
**MUST** — Every requirement in [09](../product/09-performance-contract.md) at the current milestone
MUST map to at least one gate in §7.1, each with a named owning team, and every Satisfies table in
`technical/` MUST name only gates defined in §7.1.

#### T05-002 — Every gate is proven to fail
**MUST** — A new gate MUST ship with a deliberately regressing change that demonstrates it fails.
For unit, component and end-to-end gates the proof MAY be a local run of the regressing change,
with its output (the gate, the regression and the failing assertion) recorded in the PR. Gates that
exist only in CI (workflow steps and build-artefact checks) MUST be proven by a CI run of a
regressing branch, linked in the PR. A report-only benchmark is proven by its sample assertion
failing, plus a non-red run with a deliberate slowdown that shows the reported time rising
([D13](../README.md#2-decisions-taken-2026-11-18-to-2026-11-20), owner 2026-11-20).

### 4.2 Gallery = corpus, and golden-image tests

**Gallery = corpus.** Every page of the showcase gallery
([05 §14](../product/05-visualisation-catalogue.md#14-showcase-gallery)), including each axis
pattern of [05 §1.1](../product/05-visualisation-catalogue.md#11-axes-as-a-design-tool) Table 5-2
and each interaction pattern, is one entry in the `fixtures/` manifest. From each entry the build
generates:
1. the gallery page;
2. its golden-image fixtures (`golden:gallery`);
3. its frame-time benchmark at the vis's target volume (`bench:frame-gallery`);
4. the vis registry entry (T02-031), so a vis cannot exist without a page and a test.

A manifest entry names the spec, the `pulsus-synth` seed and preset at the target volume, the
variants, the milestone, and the [05](../product/05-visualisation-catalogue.md) table row it
covers. `ci:gallery-manifest` checks that every vis listed for the build's milestone in Tables 5-1 to
5-10 and every Table 5-2 row up to that milestone has an entry, a passing golden and a frame-time
result.

**Seeded, PulsusDB-free.** Gallery pages generate their data in the browser from `pulsus-synth`
linked into the gallery build of core ([T02 §4.9](T02-vis-engine.md#49-capability-tiers-and-the-gallery)).
`e2e:gallery-offline` opens every page with no PulsusDB reachable and asserts it renders at its
target volume; two runs with the same seed produce identical goldens.

```
 fixtures/manifest.toml ─► (seed, preset) ─► pulsus-synth ─► Arrow chunks ─┬─► gallery page (browser)
                                                                          ├─► dash-render (native wgpu, headless) ─► PNG
                                                                          └─► dash-lab frame-time scenario
                       goldens/<spec>/<variant>.png (Git LFS) ◄── compare (ꟻLIP + region rules) ┘
```

- **Renderer.** The same `dash-scene`/`dash-marks` crates as the browser, on native wgpu. The
  *canonical* backend is **lavapipe** (Mesa's software Vulkan) at a pinned Mesa version, for
  bit-stable output on any CI machine. A second job renders on real GPUs (Metal on (a), D3D12 on (b))
  with a looser threshold.
- **Variants.** Per spec: dark theme (M-UI1), light theme (from M-UI5), wall high-contrast (from
  M-UI6) × {320×200, 800×400, 1 920×1 080} × DPR {1, 2} × density {Compact, Comfortable}. Each vis
  also has a "stress" variant at its target volume, downscaled. A greyscale variant
  (`golden:greyscale`) checks that state glyphs and axis-ownership glyphs are pairwise distinguishable
  without colour.
- **Comparison.** **ꟻLIP** (perceptual error, via the `nv-flip` crate), with two rules:
  - fail if mean ꟻLIP > 0.005 on lavapipe (0.02 on real GPUs);
  - fail if any 8×8 block has ꟻLIP > 0.25 inside a *text region*. Text regions are the M8 instance
    bounds the renderer emits next to the PNG. This catches glyph regressions that the mean hides.
- **Decimation references** (#68). `golden:decimation-raw` renders every raw sample through the
  engine's own line pipeline (a capsule per pair of consecutive finite samples, a dot per isolated
  one) and requires zero differing covered pixels against the decimated render, on T1 and T2 at
  DPR 1 and 2; `golden:decimation-ref` checks the decimated render against an independent f64
  reference written from the ADR-0014 §4 model (every sample covered, nothing outside the shapes
  dilated by one pixel, gap bands empty, far crossings in place). PR fixtures hold 10⁴ points per
  series; the nightly run takes 10⁸ points.
- **Image pins** (#68). The lavapipe image is pinned in `engine/tools.toml`: base image digest, apt
  snapshot, Mesa and LLVM versions, toolchain and tool versions; `engine/ci/lavapipe.Dockerfile`
  must carry the same literals (`ci:spec-lint`), and the golden tests assert the adapter is llvmpipe
  at that Mesa version. A change to any of them is one PR with regenerated goldens.
- **Determinism prerequisites:** fonts and MSDF atlases pinned; no wall-clock time (the `Clock` trait
  is fixed at t = 0 or a stated transition t); layouts seeded (T14 (draft)); decimation and pool
  reductions deterministic ([T03 §5.6](T03-browser-runtime.md#56-wasm-bindgen-web-sys-and-threads)).
- **Updating goldens** needs the `golden-update` PR label. CI publishes a diff gallery (before, after,
  ꟻLIP heatmap) as a build artefact. The visual-design review gate ([T02 §10](T02-vis-engine.md#10-testing))
  approves new specs from the same gallery.
- **Tier parity** (`golden:tier-parity`, nightly). Each spec is rendered in Chrome on WebGPU and on
  WebGL2 using probe `readback`, and the two are compared at the real-GPU threshold.
- **Native = browser** (`golden:native-browser`, nightly). A sample of 100 specs, always including
  the field-configuration pages, compares Chrome T1 readback against the native Metal render on (a).

#### T05-003 — Gallery = corpus
**MUST** — Every vis and every Table 5-2 axis pattern and interaction pattern MUST have exactly one
`fixtures/` manifest entry, added in the same milestone as the vis, from which its gallery page,
golden-image test and frame-time benchmark are generated. CI MUST fail when a vis or pattern of the
build's milestone lacks an entry, a passing golden or a frame-time result.

#### T05-004 — The canonical golden backend is pinned
**MUST** — Golden images MUST be compared on lavapipe at a pinned Mesa version, with pinned fonts and
atlases. A Mesa or driver update MUST land as one PR with a regenerated diff gallery.

#### T05-005 — Golden comparison rules
**MUST** — A golden MUST fail when mean ꟻLIP exceeds 0.005 on lavapipe (0.02 on real GPUs) or when
any 8×8 block inside a text region exceeds 0.25. Goldens MUST change only in a PR labelled
`golden-update`.

### 4.3 Frame-time and latency benchmarks

**Per primitive** (L5, plus a native GPU-timestamp variant in L2). Thresholds are the
[09](../product/09-performance-contract.md) numbers: median ≥ 60 fps (p50 ≤ 16.7 ms) on (a), (b) and
(c) for [PRF-001](../product/09-performance-contract.md#prf-001--frame-rate-during-interaction), and p99 ≤ 22.2 ms on (b) for [PRF-002](../product/09-performance-contract.md#prf-002--frame-rate-floor). The draft's stricter p99 ≤ 16.7 ms on
(a) is kept as a tracked target.

| Gate | Primitive | Scene | Target count |
|---|---|---|---|
| `bench:frame-line-1e8` | M1 polyline + GPU decimation | pan/zoom loop | 10⁸ points held, 1 000 series |
| `bench:frame-series-1e4` | M2 band + M1 outliers | pan/zoom loop | 10⁴ series |
| `bench:frame-scatter-1e7` | M4 point (T1) / M10 density; M4 sprites (T2 leg) | brush + zoom | 10⁷ held; T2 sprites at 2–3 × 10⁶ visible |
| `bench:globe-sites-arcs` | M11 globe mesh + M5 extruded sites + M6 great-circle arcs with particles | 10 s orbit, then dive to a region | 500 sites, 5 000 arcs; 60 fps median on (a), 45 fps p99 on (b) ([EST-073](../product/15-estate-navigation.md#est-073--globe-at-scale)) |
| `bench:globe-dive-to-site` | M11 globe + shipped basemap tiles (relief, coastlines, roads) + M5 extruded campus + hall scene | Scripted dive Orbit → Continent → Metro → Site → hall of lon-dc1 and back | 500 sites; basemap streamed; 60 fps median on (a), 45 fps p99 on (b); no frame waits on basemap data ([EST-077](../product/15-estate-navigation.md#est-077--dive-at-scale)) |
| `bench:inf-mixed-estate` | M5 instanced shape families (building, cylinder, ribbon, vault, swarm, gate, enclosure, box) + labels | Fly from the globe to a workload tower and back on the mixed-estate fixture | 10k nodes, 200k pods, 20k VMs, 2 000 managed resources, 500 devices; EST-062 frame rates; ≤ 1 draw per shape family per viewport plus labels ([INF-032](../product/16-infrastructure-model.md#inf-032--mixed-estate-at-scale)) |
| `bench:frame-gallery` | every gallery page | scripted pan/zoom (orbit for 3D) | the page's target volume |
| (in `bench:frame-gallery`) | M3 rect (heatmap) | scroll | 10k × 200 cells |
| (in `bench:frame-gallery`, M-UI2) | M3 + M8 flame | zoom into frame | 10⁵ frames |
| (in `bench:frame-gallery`, M-UI1) | Log stream: the virtualised DOM list in M-UI1 ([ADR-0014](../adr/0014-typescript-react-web-client.md) §2); M8 GPU text from #69 | fling scroll; page past the window end | 10⁶ lines in window ([PRF-020](../product/09-performance-contract.md#prf-020--10⁶-log-lines-scrollable)) |
| (in `bench:frame-gallery`, M-UI3) | M4/M5 + M6 Atlas | orbit + particles | 10⁴ nodes / 5 × 10⁴ edges |
| (in `bench:frame-gallery`, M-UI5) | Board | pan across | 200 viewports |
| `bench:frame-high-hz` | `bench:frame-line-1e8` and the scatter page | as above, on a 120 Hz display | median ≥ 120 fps on (a) driving an external 120 Hz display |

`bench:frame-gallery` runs every page in Chrome with WebGPU and again with WebGL2, on (a) and (b),
and reports p50 and p99 per page. On (c), the 4K wall, every row must also hold at native
resolution.

**Per surface** (scripted `.pdrec` scenarios from [13](../product/13-core-flow-storyboard.md) and
[09 §4](../product/09-performance-contract.md#4-load--data-latency), run against the M-size synthetic
estate, §4.5):

| Gate | Scenario | Metric | Budget | From |
|---|---|---|---|---|
| `bench:startup` | Cold load (cached CDN) → interactive | navigation start → shell accepts `⌘K` ([T03 §7.1](T03-browser-runtime.md#71-startup-sequence-warm-http-cache-reference-a)) | < 1.0 s p75 over 20 runs, (a) and (b) | M-UI1 |
| `bench:input-photon` | pan and hover crosshair | event `t_ms` → present of the frame that consumed it | median ≤ 1 frame, p99 ≤ 2 frames, (a) and (b) | M-UI0 |
| `bench:long-tasks` | every interaction benchmark | main-thread tasks > 16 ms between first and last input | 0, (a) and (b) | M-UI0 |
| `bench:offline-interaction` | network throttled to 0 B/s after first paint; scripted pan/zoom/scrub; then restored | frames blocked on a request; refinement without interrupting the gesture | 0 blocked frames; PRF-001 and PRF-003 still met | M-UI0 |
| `bench:camera-transition` | focus, back, dive, "show me" | trigger → final pose | 100 % ≤ 250 ms, (a) and (b); next frame under reduced motion | M-UI1 |
| `bench:memory-heaviest` | heaviest gallery/surface scene | peak tab memory | < 1.5 GB on (a) | M-UI0 |
| `bench:memory-pressure` | memory pressure induced past the budget | crash; time to rollup; badge | no crash; rollup within 1 s; badge changes | M-UI1 |
| `bench:inp-rooms` | scripted room interactions in Chromium; INP per document from the Event Timing entries of each document the script loads (the data Lighthouse reads), each document's INP ≤ 200 ms | INP | ≤ 200 ms (fail above); 100 ms tracked target | M-UI0 |
| `bench:lens-load` | warm nav → Lens coarse; Lens fully refined (1 h) | dive input → first data frame in every visible viewport; → last `coverage.final` | < 300 ms p75; < 1.5 s p75 (PRF-010, PRF-011, PRF-034) | M-UI2 |
| `bench:decode-r1` | R1 harness ([T04 §10](T04-wire-format-and-data-plane.md#10-testing)) | A1 decode on (a) | < 50 ms p95 | M-UI0 |
| `bench:shim-input-cost` | synthetic N, B; trusted pointer and wheel (R); the 66c rAF flush ([T03-003](T03-browser-runtime.md#t03-003--the-main-thread-never-blocks-and-never-renders)) | time per listener call; per rAF callback | p99 ≤ 0.05 ms (N, B median of 3; R all and wheel); callback ≤ 2 ms; (a) and (b) | M-UI0 |
| — | Atlas 2 000 entities first paint | → first frame with all nodes | < 800 ms (PRF-012) | M-UI3 |
| — | F2 Space-scrub, 2 000 entities | frame time during scrub; network requests | PRF-001/PRF-002; 0 requests | M-UI3 |
| — | Live tail | ingest timestamp → frame containing the line | < 2 s p95 (PRF-015) | M-UI2 |

The board room is the first room `bench:inp-rooms` scripts (#61); the other DOM rooms join as they
gain interactions. `bench:rooms-long-tasks` (T08 §7) applies the long-task method below to the
scripted room interactions, with the board editor (#90) and chart gestures, wheel and drag on a
board panel (#93) as its scenarios. Until the reference lab exists, CI's
`e2e` Chromium leg runs it with the interim trace check's thresholds (thread > 16 ms and wall > 50 ms
fails) as a merge gate; the lab applies 16 ms wall. `bench:long-tasks` is unchanged.

**Measurement methods**
- **Frame time** is the interval between presented frames, from worker `requestAnimationFrame`
  timestamps, cross-checked with GPU timestamp queries where the `timestamp-query` feature is exposed
  (treated as optional, because browsers may quantise or gate it).
- **Headless.** [PRF-032](../product/09-performance-contract.md#prf-032--per-visualisation-gpu-benchmarks-in-ci) calls for headless GPU benchmarks. `dash-lab` runs Chrome's headless
  mode with the GPU enabled (`--headless=new --use-angle=…`, same compositor and GPU process as
  headed), on the reference machines. A weekly headed run checks the two agree within 5 %.
- **Long tasks on main**: top-level `RunTask` on the page's `CrRendererMain` between first and last
  input `EventDispatch` in a Chrome trace, judged on wall `dur` (`dash-lab::trace`); LoAF serves
  RUM. CI's `e2e` runs it (thread > 16 ms, wall > 50 ms) as PRF-005's merge gate until the
  reference lab exists (§7.1).
- **Shim per-event time** (T03-003): CI's `e2e` reports listener times and asserts only
  deterministic queue checks; `bench:shim-input-cost` gates the times.
- **Input → photon** is estimated in CI as event `t_ms` → `queue.submit` of the frame that consumed
  it, plus one vsync. Each reference machine gets a quarterly **photodiode + high-speed camera**
  calibration of the estimate.
- **Memory** uses `performance.measureUserAgentSpecificMemory()` (available because we are
  cross-origin isolated), else WASM memory + a GPU allocation tally.
- **Runs.** Each benchmark runs 3 × 60 s after a 30 s warm-up and thermal soak. We report p50, p95,
  p99, dropped frames and the frame-time histogram.

#### T05-006 — Wall-clock gates run only on the reference lab
**MUST** — Frame-time, latency, memory and INP gates MUST run on the dedicated reference machines
(§4.6), never on shared CI runners. PR-level CPU regressions MUST be gated by instruction counts
(`bench:cpu-instr`).

#### T05-007 — Frame-time gates use the 09 numbers
**MUST** — `bench:frame-gallery` and the per-primitive benches MUST fail when the median frame time on
(a), (b) or (c) exceeds 16.7 ms, when p99 on (b) exceeds 22.2 ms, or when p99 regresses by more than
5 % against the baseline (Mann–Whitney U, p < 0.01). They MUST be blocking from M-UI0 on (a) and (b),
and report each page's p50/p99 on failure.

### 4.4 Deterministic input replay (`.pdrec`)

A recording captures **inputs, not pixels**: the exact [T03 §5.4](T03-browser-runtime.md#54-input-ring-record-format)
input records, the ui → core command records ([T03 §5.3](T03-browser-runtime.md#53-core--shell-messages)),
and the data-plane transcript, all keyed by frame number.

| Section | Contents |
|---|---|
| Header | magic `PDREC1`, build id, wire version, tier, mode, viewport size + DPR, locale, time zone, keymap id, seed(s), dataset id or `live`, wall-clock origin |
| Frame records | `frame u32`, `dt_ms f32`, input records verbatim, ui → core records verbatim |
| Net transcript | per request: `request_id`, `QueryRequest` JSON, and either the DSF frames (full mode) or their `xxh3` digests + coverage (lean mode), each tagged with the frame on which it was delivered |
| Checkpoints | every 60 frames: `xxh3_64` of the canonical state store + scene graph summary |
| Footer | index offsets |

The file is zstd-compressed and written by `dash-replay` in the render worker.

**Replay specs.** Each `replay:*` gate in §7.1 is a set of `.pdrec` files authored against a seeded
dataset, with assertions on checkpoints, probe `state()` and, where stated, frame timing. Replays
assert state and checkpoint hashes, not images, because pixels across GPU vendors are not expected to
match.

**Uses**
1. **Perf scenarios.** Every §4.3 surface scenario is a `.pdrec`, so the identical gesture sequence
   runs on every machine.
2. **Regression tests.** A replay that once diverged or crashed becomes an L4 test with its
   checkpoints.
3. **Bug reports.** The render worker keeps the last 5 minutes in a memory ring of about 2–4 MB,
   always in lean mode. "Attach session replay" (and the automatic attach on a second crash,
   [T03 §9](T03-browser-runtime.md#9-failure-modes--degradation)) uploads it via
   `POST /api/dash/v1/replays` ([T06](T06-bff-architecture.md); refs and retention in
   [T11](T11-postgres-schema.md)).
   - Lean replays re-query PulsusDB at the recorded absolute times, flag divergence by checkpoint,
     and need the replayer to hold the reporter's data scope.
   - Full mode (DSF payloads included) requires explicit user consent and is scope-checked on
     playback.
   - Paste records are redacted to their length. Text typed into DOM fields is never in the ring,
     only the resulting commands.
4. **One command:** `cargo xtask replay <file> [--native|--browser] [--until-divergence]`.

The investigation **flight recorder** (T17 (draft)) shares the container and checkpoint format. The
flight recorder stores semantic Context and evidence for humans; `.pdrec` stores low-level input for
machines.

#### T05-008 — Determinism contract
**MUST** — Core MUST read time only through `Clock` (driven by `dt_ms` in replay), MUST seed every RNG
from the header, MUST use `BTreeMap` or fixed-seed hashers for anything that affects output, and MUST
use order-deterministic pool reductions. The replay scheduler MUST deliver network frames at their
recorded frame. Running any `.pdrec` twice natively MUST produce identical checkpoints.

#### T05-009 — Replays are lean and private by default
**MUST** — Bug-report replays MUST be lean by default (no telemetry values), MUST redact paste
contents to their length, and MUST NOT contain text typed into DOM fields. Full mode MUST require
explicit consent and scope-checked playback.

### 4.5 Seeded synthetic telemetry and the incident replay corpus

**`pulsus-synth`** (a Rust crate, CLI and WASM library) is deterministic from
`(seed, preset, scenario, t0)`.

- **Estate model.** Regions → clusters → nodes → pods → containers, plus services with a call graph
  (power-law fan-out), versions, deploy history, feature flags and journeys. The model covers the
  infrastructure and application ladders of [15](../product/15-estate-navigation.md).
- **Signals.**
  - Metrics: RED/USE, kube-state, histograms.
  - Logs: templated lines with realistic pattern entropy, levels and structured metadata.
  - Traces: spans following the call graph, with errors propagated or originated.
  - Profiles: stack samples from synthetic call trees.
- **Outputs.** OTLP to a *lab* PulsusDB's standard `/v1/{metrics,logs,traces}` and
  `/v1development/profiles` paths (with `Idempotency-Key`, so reloads are safe) for L4 nightly and
  L5; *or* direct Arrow chunks (gallery, L2 goldens) and fake-upstream transcripts (L1–L4 hermetic),
  from the same model and seed. Synthetic OTLP is test data loaded by the test harness, never by the
  Dash product.
- **Presets** (sized from [15](../product/15-estate-navigation.md) and
  [09 §5](../product/09-performance-contract.md#5-volume-targets-single-viewport-or-scene)):

| Preset | Services / pods / nodes | Use |
|---|---|---|
| S | 50 / 500 / 30 | unit fixtures, PR L4 |
| M | 2 000 / 20 000 / 1 500 | surface budgets, demos, F2 scrub, "typical service" for PRF-011 |
| L | 10 000 / 200 000 / 10 000 | Atlas ceilings, nightly |
| Wire-XL | 1 000 × 10 000 points etc. | R1 harness ([T04 §10](T04-wire-format-and-data-plane.md#10-testing)), primitive volumes |

- **Time.** Data is generated relative to `t0`, which defaults to "now − window" at load, so
  retention and "now" semantics hold. Fixtures and gallery pages use a fixed epoch.

**Incident replay corpus** (`corpus/incidents/<id>/`). Each scenario is a `pulsus-synth` scenario
script plus **ground truth** (`truth.yaml`):

| Field | Example (INC-2041, [13](../product/13-core-flow-storyboard.md)) |
|---|---|
| `trigger` | config change `payments.psp.timeout 5000→2000` at t+0 |
| `origin` | edge `payments → psp-api` |
| `victims` | `payments`, `checkout`, `gateway`, journey `Checkout` |
| `onset_order` | `psp-api edge` 12:19:40, `payments` +85 s, `checkout` +110 s |
| `unchanged` | `psp-api` latency, `pg-orders`, deploy v2.31 |
| `signatures` | failed spans at exactly 2.0 s; NEW pattern `timeout calling psp-api after <*>ms` |
| `expected_ui` | First Light order, causal path, Compare keys |

The initial set (M-UI4) has 12 scenarios: bad config timeout; bad deploy (canary); noisy neighbour
on a node; DNS failure; certificate expiry; memory leak with OOM kills; DB lock contention; partial
zone outage; cardinality explosion; sampling gap (coverage honesty); retry storm; and a no-incident
control (false-positive check).

Real incidents may be added from customer opt-in exports after redaction, with the same ground-truth
file. Consumers are perf scenarios (§4.3), RCA evaluation (T15 (draft)), alert backtests
([T16](T16-alert-evaluator.md)) and the [13](../product/13-core-flow-storyboard.md) usability tests.

#### T05-010 — One generator, one seed
**MUST** — Every fixture, golden, gallery page, perf scene and corpus scenario MUST be produced by
`pulsus-synth` from a recorded `(seed, preset, scenario, t0)`, and `pulsus-synth` MUST carry golden
statistics (series counts, pattern counts, error ratios per seed) so generator changes are visible.

#### T05-011 — The corpus contains no customer data
**MUST** — The corpus MUST contain only synthetic data or real incidents redacted under a two-person
review with [T18](T18-security.md)'s checklist.

### 4.6 Reference hardware lab

| Id | Machine ([09 §2.1](../product/09-performance-contract.md#21-reference-hardware)) | Browsers | Role |
|---|---|---|---|
| (a) | MacBook Air M2 (2022), 16 GB, plus an external 120 Hz display | Chrome stable (gating), Safari, Firefox | primary gate; R1; memory; high-Hz |
| (b) | Windows laptop, Intel Iris Xe iGPU | Chrome stable (gating), Edge, Firefox | iGPU floor (≥ 45 fps p99) |
| (c) | 4K wall PC, mid-range discrete GPU | Chrome stable (gating) | wall mode, 4K fill rate |
| (d)* | informational: 4-core/8 GB laptop, Linux | Chrome, Firefox | early warning, ST mode |

\* Not to be confused with the mobile reference (d) of 09, which is owned by the T20 (draft) device
lab.

- **Hygiene.** Machines run on mains power, with fixed brightness, native refresh, and OS and driver
  updates pinned and rolled monthly as one change. No other apps run. The thermal state is checked
  before each run. Each machine has two units, so one can be taken out of service.
- **`dash-lab` agent** (Rust). It pulls jobs from CI, launches Chrome with a clean profile and the
  GPU enabled, loads the build, serves the fake upstream or the lab PulsusDB with preloaded M and L
  presets, runs `.pdrec` scenarios, and uploads results to the lab's PulsusDB as OTLP metrics with
  `run_id`, commit and machine attributes. Results are viewed in Dash itself.
- **Baseline.** Per (benchmark, machine, browser): a rolling median of the last 10 `main` runs.

#### T05-012 — Lab machines self-calibrate
**MUST** — Before each job the agent MUST run a calibration benchmark; if it deviates by more than 5 %
from the machine's own baseline, the job MUST move to the twin unit and the lab owner MUST be
alerted.

### 4.7 Real-user performance telemetry (Dash observing itself)

The shell owns collection, reading the control-block counters ([T03 §4.3](T03-browser-runtime.md#43-shared-memory-layout-and-ownership)).
It **aggregates locally**: frame times go into histograms, never per-frame events. It sends every
30 s, and on `visibilitychange → hidden` via `navigator.sendBeacon`, as OTLP/protobuf from a minimal
hand-rolled encoder (no OpenTelemetry package, to save size). The BFF forwards the data to PulsusDB
OTLP ingest under a dedicated database or tenant (`X-Pulsus-Database` / `X-Scope-OrgID`, configured
by [T19](T19-deployment.md)). This is Dash's self-telemetry, the write to PulsusDB that
[ADR-0012](../adr/0012-derived-state-in-postgres.md) permits; it never lands in a customer tenant.

| Metric (OTLP) | Type | Key attributes |
|---|---|---|
| `dash.frame.duration` | exponential histogram, ms | `surface`, `tier` (T1/T2), `mode` (full/st/mtr), `hw_class`, `viewports` bucket |
| `dash.input.latency` | exp. histogram, ms (event → submit) | `surface`, `kind` (pointer/wheel/key) |
| `dash.load.phase` | histogram, ms | `phase` (`shim`, `shell_compile`, `fcp`, `core_compile`, `gpu_init`, `first_frame`, `interactive`), `cache` (warm/cold) |
| `dash.query.latency` | histogram, ms | `kind`, `phase` (`ttfb`, `first_batch`, `final`), `rank`, `priority`, `outcome` |
| `dash.decode.duration` | histogram, ms per MB | `schema` |
| `dash.cache.lookups` | counter | `result` (hit/stale/miss) |
| `dash.coverage.degraded` | counter | `reason` (truncated, sampled, rollup, memory, tier) |
| `dash.main.long_tasks` | counter + histogram | `room` |
| `dash.inp` | histogram, ms | `room` |
| `dash.memory.bytes` | gauge | `pool` (core, shell, gpu_est, idb) |
| `dash.gpu.device_lost`, `dash.worker.crash` | counter | `role` |

- **Logs.** Panics, with stack traces symbolicated server-side from split DWARF
  ([T03 §5.6](T03-browser-runtime.md#56-wasm-bindgen-web-sys-and-threads)), and mode/tier degradation
  events.
- **Traces.** A browser root span per interaction (navigation, dive, pivot). `traceparent` goes on
  every data-plane request ([T04 §5.2](T04-wire-format-and-data-plane.md#52-http-endpoints-data-plane)),
  so a slow Lens is one trace from browser to BFF to PulsusDB (via the `request_id ↔ X-Pulsus-Query-Id`
  link). The browser tail-samples: keep 1 %, plus every span over its
  [09](../product/09-performance-contract.md) budget, plus errors.
- **`hw_class`.** Bucketed (e.g. `apple-m-series`, `intel-igpu`, `dgpu`, `low-core`) from core count,
  `deviceMemory` and coarse adapter info, never a raw adapter string, to limit fingerprinting.
- **Use.** "Dash on Dash" boards show field p75/p95 per `hw_class` against the 09 budgets; SLO alerts
  fire on regressions ([T16](T16-alert-evaluator.md)); release compare on RUM gates canary rollouts
  ([T19](T19-deployment.md)).

#### T05-013 — RUM identifies no user and no query
**MUST** — RUM MUST NOT contain query text (only a fingerprint), label values or user ids, MUST use a
per-tab random session id, MUST be ingested into a Dash-only database or tenant, and MUST be
disableable or sampled per org.

#### T05-014 — RUM never affects the UI
**MUST** — When RUM ingest is down, the browser MUST drop batches beyond a bounded queue of 3 and MUST
NOT retry in a loop.

## 5. Interfaces

| Interface | Defined here | Consumers |
|---|---|---|
| `fixtures/manifest.toml` (spec, seed, preset, variants, milestone, 05 row) | yes | gallery build, `dash-golden`, `dash-lab`, vis registry |
| `.pdrec` v1 (§4.4) | yes | `dash-replay`, bug-report upload ([T06](T06-bff-architecture.md)), T17 (draft) container reuse |
| `pulsus-synth` CLI: `synth --seed --preset --scenario --t0 --out otlp://…\|arrow://…\|fake://…` | yes | L1–L5, gallery, demos, T15 (draft), [T16](T16-alert-evaluator.md) |
| Corpus ground-truth schema (`truth.yaml`, fields as §4.5) | yes | T15 (draft) evaluation harness |
| Test probe `window.__dashProbe` (test builds only) | yes | Playwright |
| RUM OTLP schema (§4.7) | yes | [T19](T19-deployment.md) self-observability boards, [T16](T16-alert-evaluator.md) SLO alerts |
| `POST /api/dash/v1/telemetry` (OTLP/protobuf, ≤ 256 KiB per post) | assumed in [T06](T06-bff-architecture.md) | browser shell |

## 6. Data & storage

| Data | Where |
|---|---|
| Goldens | Git LFS (`goldens/`), ~3 000 PNGs, about 300 MB |
| Fixture manifest, corpus scripts + ground truth | Git (`fixtures/`, `corpus/`); generated OTLP is never committed |
| Lab results, RUM | PulsusDB, Dash self-telemetry database (lab and production respectively) |
| Bug-report replays | Optional object storage via the BFF ([ADR-0009](../adr/0009-optional-object-storage.md)), else Postgres; refs and retention in Postgres ([T11](T11-postgres-schema.md)); default 30-day retention |
| Fake-upstream transcripts | Git LFS (small set) or generated at test time |

## 7. Performance budget

This doc *enforces* budgets rather than consuming them.

### 7.1 Gate catalogue

Every gate named in a Satisfies table is defined here. **Stage:** PR (blocks merge), merge (blocks
the merge train), nightly (release blocker).

**Static and CI checks (L1)**

| Gate | Checks | Stage | Blocking |
|---|---|---|---|
| `ci:design-check` | `designs/tools/check.py`: no broken links or anchors, unique requirement IDs, every requirement has priority, milestone and acceptance criteria, every Satisfies reference resolves, no M-UI0/1 MUST untraced; `traceability.md` regenerated and diffed | PR | yes |
| `ci:shim-lint` | *Withdrawn* ([ADR-0014](../adr/0014-typescript-react-web-client.md)): there is no hand-written shim. The engine adapter is bound by T01-001 and `ci:lint-ts` | — | — |
| `ci:lint-ts` | `npm run lint`: ESLint (typescript-eslint strict type-checked, react-hooks, jsx-a11y) and Prettier check; `eval`, `Function`, `innerHTML` and `dangerouslySetInnerHTML` banned | PR | yes |
| `ci:typecheck` | `npm run typecheck` (`tsc --noEmit`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | PR | yes |
| `ci:lockfile` | `package-lock.json` committed and `npm ci` succeeds; exact versions only (no `^` or `~`); every `resolved` URL on `https://registry.npmjs.org/` with an `integrity` hash; `.npmrc` sets `save-exact`, `engine-strict` and `ignore-scripts` ([ADR-0014](../adr/0014-typescript-react-web-client.md) §7) | PR | yes |
| `ci:npm-audit` | `npm audit --omit=dev --audit-level=high` and `npm audit --audit-level=critical` pass; `npm audit signatures` passes | PR | yes |
| `ci:bundle-size` | `npm run size`: brotli size per chunk class against `client/bundle-budgets.json` ([ADR-0014](../adr/0014-typescript-react-web-client.md) §8): initial JS ≤ 200 KB, initial CSS ≤ 30 KB, each lazy route chunk ≤ 120 KB, editor chunk ≤ 175 KB, fonts ≤ 150 KB, all client assets except the engine ≤ 1 MB; from #68 the engine ≤ 1.9 MB ([T03 §7.3](T03-browser-runtime.md#73-wasm-size-budget)); client core (initial JS + CSS + engine) < 3 MB (PRF-009). Over budget or a required artefact absent → fail. *Later:* the +2 %-per-PR growth check once `main` has a size baseline | PR | yes |
| `ci:dep-audit` | Every runtime `dependencies` entry of `client/package.json` is on the allowlist in `client/dependency-policy.json` and in no forbidden category (charting, mapping, 3D, graph-diagram, CSS-in-JS); runtime licences on the AGPL-3.0-compatible allowlist; no third-party asset or font host in the build. Engine leg from #68: `cargo deny check licenses advisories bans sources` with `engine/deny.toml` (the licence set of [T18](T18-security.md) §4.11, three exact-version exceptions; no unknown registry or git source; yanked crates denied); the `web-sys` feature allowlist arrives with the browser build (Part C); the lock lint is `ci:engine-lint` | PR | yes |
| `ci:token-lint` | T01-010: no colour, size or duration literal outside the generated token outputs (`tokens.css`, `tokens.ts`, and the engine's Rust constants from #68); regenerating them leaves no diff; state tokens referenced only through `StateEncoding` (T02-004) | PR | yes |
| `ci:api-gen` | `oapi-codegen`, `openapi-typescript` and `sqlc generate` leave no diff against `api/openapi.yaml` and `server/queries/` ([ADR-0015](../adr/0015-go-bff.md)) | PR | yes |
| `ci:go-lint` | `golangci-lint run` (pinned; `depguard` package boundaries of ADR-0015, `forbidigo`, `gosec`, `errcheck`, `staticcheck`); the `ci:depguard` self-test proves the rules with failing fixtures (`server/testdata/depguard/`: `pgx` outside `internal/store`, `chi` outside `internal/gateway`, an HTTP client outside `internal/pulsusdb` (`pulsusdb-only`, T06-005), `encoding/json` decoding inside `internal/pulsusdb` (`pulsusdb-decoder`, #62)) | PR | yes |
| `ci:go-test` | `go test -race ./...` | PR | yes |
| `ci:govulncheck` | `govulncheck ./...`; any reachable vulnerability fails | PR | yes |
| `ci:go-mod` | `go mod verify`; `go mod tidy` leaves no diff; `GOFLAGS=-mod=readonly` | PR | yes |
| `ci:asset-integrity` | Binary-level start-up refusal ([ADR-0016](../adr/0016-asset-integrity-verified-by-bff.md), [T19](T19-deployment.md) T19-005): `make build` once, then gate binaries with the same public key over an altered packed tree must exit 1 before opening a listener: one byte of the largest `assets/*.js` flipped (`hash_mismatch`), an unlisted `assets/extra.js` (`unlisted_file`), a listed `.br` variant deleted (`missing_file`), the manifest changed by one byte (`bad_signature`), no public key (`no_public_key`); the untouched tree verifies and stops only at Postgres; a `make server-build` binary refuses without `--api-only` | PR | yes |
| `ci:go-licenses` | `go-licenses check` over every module linked into the `pulsus-dash` binary: each licence on the AGPL-3.0-compatible allowlist (MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC, MPL-2.0, LGPL-2.1, LGPL-3.0; D3); writes the third-party notices file `build/THIRD_PARTY_NOTICES.txt`; proven by the failing GPL-2.0-only fixture `server/testdata/licences/gpl` ([T18](T18-security.md) T18-026) | PR | yes |
| `ci:no-pulsusdb-host` | Every tracked file: no URL with a non-local host containing `pulsusdb`, and no non-local URL as a PulsusDB datasource key value (bare host names without a scheme are not scanned); no host name is stored in the repository or its secrets, and a local run also forbids the datasource host of the untracked dev environment file; output names files only by opaque index ([T19](T19-deployment.md) T19-010) | PR | yes |
| `ci:fake-image` | The dev stack's PulsusDB fake image (`dev/pulsus-fake.Dockerfile` with its `.dockerignore`) builds, runs, and answers `GET /api/v1/status/runtimeinfo` within 10 s with `X-Pulsus-Query-Id: fake-runtimeinfo-1` and `rollupLevels` (#62) | PR | yes |
| `ci:dev-stack` | The dev compose stack (`dev/compose.yaml`) starts, migrates and seeds, serves `/readyz` 200, stops cleanly, persists across `dev-down` and resets with `dev-reset`; nothing is left behind, also after an injected failure; then `itest` runs on its PostgreSQL 15 and 16 ([ADR-0015](../adr/0015-go-bff.md)) | PR | yes |
| `ci:migrations` | `squawk` on `server/migrations/*.sql` (T11-013), proven by the failing fixture `server/testdata/squawk/create_index_not_concurrently.sql` (`require-concurrent-index-creation`), and an up-from-empty run on Postgres (`itest:migrations`); on pull requests, no merged migration is modified, deleted or renamed (append-only, T11-012) | PR | yes |
| `ci:palette-check` | CVD simulation (deuteranopia, protanopia, tritanopia) for every palette in every theme; series palette within ±3 L*; wall variant ≥ 7:1 text, ≥ 3:1 state marks | PR | yes |
| `ci:keymap-check` | T03-011 over the default table and every preset | PR | yes |
| `ci:spec-lint` | T02-001 (no pipeline outside L1); diverging ramps only on delta encodings; glyphs only through `Glyph`; every overlay declares an axis. Subset from #68 (`cargo xtask spec-lint`): `dash-scene` has no dependency, direct or transitive, on `wgpu`, `naga` or `dash-gpu` and its `dash-marks` edge enables no feature; `.wgsl` files only in `dash-marks`; the literals of `engine/ci/lavapipe.Dockerfile` and the toolchain channel equal `engine/tools.toml` | PR | yes |
| `ci:engine-lint` | From #68: `cargo fmt --check` and `cargo clippy --workspace --all-targets -D warnings` on `engine/`, with `unwrap_used`, `expect_used` and `disallowed_types` (`std::sync::Mutex`, `RwLock`: T03-008) denied | PR | yes |
| `ci:gallery-manifest` | T05-003 for the build's milestone | PR | yes |
| `ci:probe-absent` | No test probe, no globals, no ungated upload endpoint in release artefacts. Scans a fresh production build of the client (and, from #68, the engine), never files on disk; `e2e` checks the marker is found in the test build | PR | yes |

**Unit, property and fuzz (L1)**

| Gate | Checks |
|---|---|
| `unit:decimation-prop` | Raw min and max appear in every pixel column; every span is exactly one NaN-free run, every raw sample lies in its run's span, `total` counts the instances; identical output across rayon pools of 1, 2 and 7 threads |
| `unit:columns-parity` | From #68: the CPU decimation reproduces the interim `lineColumns` per column (count class, first, last, every run in order including spilled ones, the break flag) on `engine/fixtures/columns.json` |
| `unit:decimation-batches` | From #68: past `max_instances` a viewport is drawn in ⌈(G + total)/max⌉ ordered batches whose image is byte-equal to one draw, on T1 and T2 |
| `unit:decimation-tier-parity` | From #68: the T1 compute passes and the CPU path give byte-equal `ColOut`, counts, starts, total and instances (20 seeds, grid and explicit chunks, columns with ≥ 5 runs) |
| `unit:buffer-lifetime` | From #68: pan, zoom and resize rebuild the column ranges and never re-encode values; an encoding change encodes once; one resident encoding per chunk; staging ≤ 16 MiB on T1; a dropped chunk leaves no buffer (T02-014, T04 §5.7) |
| `unit:value-encoding` | From #68: exact-span encoding on subnormal, constant, overflowing and far-from-zero ranges; every u finite and ≤ 2^24; the f32 y within 2^−8 device px of an f64 reference for plots of 240 and 8 192 px |
| `unit:segment-clip` | From #68: f64 segment clipping against the clip box: crossings of a ±1e300 segment at t = 1/3; single cuts; halved form at ±MAX; `is_far` only beyond the box |
| `unit:epoch-adjacency` | From #68: 1 ms apart at an epoch-scale timestamp → columns 0 and 10 of a 100 ms window in 1 000 columns, instances 10 CSS px apart |
| `unit:extreme-ticks` | From #68: data spans that overflow (±MAX) get three finite ticks within 1 ms |
| `unit:spike-visible` | From #68: one sample in 10⁶ is drawn at its value on T1 and T2 |
| `unit:chunk-builder` | From #68: `ChunkBuilder` rejects unequal lengths, non-increasing and NaN timestamps; the finite range spans ±MAX and skips NaN |
| `unit:layout-parity` | From #68: the engine's `value_ticks` and value axis equal the interim `valueTicks`, `layoutPlot` and labels bit for bit (`engine/fixtures/ticks.json`, `layout.json`, `pow.json`) |
| `unit:manual-axis` | From #68: a manual value axis keeps its range as the domain and ticks inside it (1e−9 relative tolerance) |
| `unit:held-band` | From #68: under a held label band the plot rect depends only on (kind, size, band); labels wider than the band are flagged |
| `unit:camera-primitives` | From #68: `zoom_about`, `pan_by`, `contain` and `to_window` bit-equal to the client's camera arithmetic; the anchor moves < 1 px over 100 steps; whole-ms pans; exact no-op at the floor |
| `unit:commit-shape` | From #68: `to_window` rounds like ECMAScript `Math.round`; the commit event's JSON is ADR-0020's TS shape |
| `unit:spec-value-range` | From #68: an invalid `valueRange` is auto; the summary's `valueAxis` reports the drawn domain |
| `unit:drawn` | From #68: `drawn` only for a complete frame at a non-zero size; `FrameInit.id` does not change pixels |
| `unit:frame-summary-parity` | From #68: the engine's frame summary of each gallery line entry equals the interim `frameSummary` (`engine/fixtures/summary.json`) |
| `unit:synth-parity` | From #68: `pulsus-synth` gallery lines equal the client's `synthLines` (keys equal, values within 1e−9) |
| `unit:engine-fixtures` | From #68: `engine/fixtures/*.json` equal a fresh run of `client/scripts/engine-fixtures.ts` (part of `npm test`) |
| `unit:ticks-prop` | Ticks never overlap, 40–8 000 px, all time zones including DST days |
| `unit:axis-layout-prop` | No band overlap; no label collision across lanes; pan on A leaves B's marks pixel-identical; hysteresis (500 ms shrink) |
| `unit:axis-patterns` | Table 5-2 triggers apply per milestone; `origin = User` disables auto; ≤ 2 axes per side auto; "consider stacking" hint |
| `unit:camera-controller` | Cursor-anchored zoom drift < 1 px over 100 random steps (2D and 3D); inertia settles 300 ± 50 ms, no overshoot, stops on the next input frame |
| `unit:scene-model` | Scene = tree of viewports with binding, vis, camera/axes, overlays; preserved when moved |
| `unit:autovis-table` | One fixture per Table 5-13 row → listed vis; milestone restriction; Perspective does not change the rule; Bullet for value + threshold. v1 (#63): rows 5, 6, 7, 14 in that order; row 7 only for a scalar or an instant result of one series with one point; the URL `vis` override wins |
| `unit:explore-plan` | The Explore run planner (#63): one fixture per planner row (bare counter and histogram bucket rewritten to `rate(…[w])` and `sum by (le) (rate(…[w]))` behind the rate chip, `w = max(4 × step, step + S, 4 × S)` with `S` the scrape interval (default 15 s, per binding later), with rows where 4 × S and 4 × step set the window, as written with it off, instant for scalar and string types); the 64 KiB limit on the **sent** text in UTF-8 bytes at ±1 byte for both rewrites and multi-byte text; metric types from metadata; the sent-to-source index mapping (T09-009) |
| `unit:heatmap-buckets` | Prometheus buckets → heatmap counts (#63): per group (labels without `le`) and interval, summed over groups; a missing sample, or a group without a bound, makes the cells it touches missing (single and grouped series), never 0 or a partial sum; per-group clamp; row isolation on the full view's axis from the row's group |
| `unit:frame-plan` | Every vis × result kind (series, scalar, string) gives a spec and data that `validateFrameData` accepts, or a notice (#63); scalar overrides; heatmap row isolation fills only the row and a second click restores the full view |
| `unit:series-rows` | The Explore series table rows (#63): last and max ignore NaN; sort by name or value with nulls last in both directions, ties by name then key; the next-sort and isolation toggles |
| `unit:explore-params` | The `q`, `vis`, `rate` URL keys (#63, IA-022): first value read, invalid `vis` ignored, defaults omitted on write, pairs sorted; a non-canonical search is replaced by the `metrics` route |
| `unit:promql-shape` | The PromQL shape analyser on the Lezer tree: bare selector and its source slice (comments skipped), metric names, `histogram_quantile`, value type; any error node gives `UNKNOWN_SHAPE` (T09-002, #63) |
| `unit:promql-diagnostics` | A `queryInvalid` byte offset maps to a UTF-16 code point in the editor text through the planner's offset map, with the end clamped; no position, an out-of-range one or one inside planner text underlines the whole query with "position unknown" (T09-009) |
| `unit:suggest-cache` | The completion cache holds at most 2 000 keys, LRU by last get; 60 s TTL from settle; shared in-flight promises; a superseded in-flight lookup of the same kind is aborted, evicted or not, and an evicted one is re-joined by its own key; eviction never aborts or withholds a result; rejected loads are not kept; a tenant switch or clear ends the generation: it drops every entry and tracked call, aborts in-flight loads (evicted and stuck ones included) and rejects their callers at once with no unhandled rejection; a call with an ended generation token, or for another tenant, sends nothing (T09-007, T09-014) |
| `unit:prom-source` | Completion lookups call the `/prom/*` API with the window (whole minutes for names, labels and values, whole seconds for series), limits and match, are keyed by 15-min window bucket, cancel superseded lookups, resolve empty on failure, and share the metadata query with the page; metadata of a tenant switched away from or cleared is never delivered, and a source of an ended generation (`a → b → a`, `clear()`) sends nothing (T09-007, T09-014, SRF-027) |
| `unit:prom-client` | The `PrometheusClient` adapter builds the selector of the enclosing matchers, leaving out only the matcher under the caret (completed empty-value matchers are kept) and copying each kept matcher's source text, delimiters and escapes included; the edited label name is decoded before it is sent; a matcher list that does not match the tree sends nothing; every method maps onto `PromSource` (SRF-027, T09-007) |
| `unit:editor-keys` | Shift+Enter and Mod+Enter run; Enter inserts a newline; Escape leaves; Tab is unhandled without a completion popup (T09-004) |
| `unit:editor-completion` | Metric completion shows the metadata type and accepts with Tab; Escape closes the popup first; label values are asked for under the enclosing selector, with `job=""`, `job!=""`, quoted names and single-quoted or backtick literals kept as typed, and escaped quoted names decoded (SRF-027, T09-004, T09-007) |
| `unit:editor-doc` | Programmatic replace and insert are single, undoable history events in the same history as typing (T09-006) |
| `unit:editor-diagnostics` | Run diagnostics are shown as errors, clamped to the document, and cleared by an empty list (SRF-027) |
| `unit:editor-no-linter` | The editor places no client-side diagnostic: the package linter is off (T09-002) |
| `unit:editor-styles` | The editor in its shadow root uses adopted stylesheets and adds no `<style>` element (ADR-0014 §9); the highlight style uses only `syn-*` tokens |
| `unit:editor-host` | The React host makes one shadow root and view under StrictMode, follows `value`, `diagnostics` and `source`, exposes `focus` and `insert`, and removes the view on unmount |
| `unit:query-size` | The query size is the UTF-8 byte length; above 131 072 bytes (not at it) the query is over the limit, multi-byte text included (T09-015) |
| `unit:editor-composition` | During IME composition the editor closes an open popup, opens none, makes no lookup, accepts nothing and holds arriving results; it re-evaluates completion once after the last `compositionend` (T09-005) |
| `unit:editor-size` | Above 128 KB of UTF-8, measured on every change, completion and lookups pause and an open popup closes, while editing, undo and run keys go on; shortening the query resumes completion; at and below the limit a long document completes (T09-015) |
| `unit:lang-table` | `LANGUAGES` resolves each built language to its `QueryLanguage` and rejects the languages not built yet (T09-001, [ADR-0018](../adr/0018-query-language-modules.md)) |
| `unit:window-keys` | Window keys ignore events with an editable element or a dialog, menu, listbox or grid anywhere on the composed path, shadow trees included; without a path, the target decides (INT-032) |
| `unit:number-format` | `2.84 s`, `1.2k rps`, `€38k/h`, `since 12:22 (40 min)`; byte-identical output browser vs native |
| `unit:colour-hash` | Series colour = f(`key_hash`) stable across charts, sessions and sources; a series with a log-level label in [08](../product/08-visual-language.md#vl-002--neutral-series-palette-with-stable-identity-colours) Table 8-1a takes that row's colour in every chart, whatever the other series or their order |
| `unit:series-cap` | Interim renderer (until #68): 600 series → 500 drawn, `a11y` reports 500 of 600, and the frame shows "Showing 500 of 600 series" ([ADR-0014](../adr/0014-typescript-react-web-client.md) §4) |
| `unit:columns` | Interim renderer: one polyline vertex per CSS px column per series; every raw min and max in a column drawn as a 1-px span per NaN-free run; a NaN, even inside a column, breaks the path; a merged heatmap cell with a missing constituent is missing (#63) ([ADR-0014](../adr/0014-typescript-react-web-client.md) §4) |
| `unit:bucket-scale` | Interim heatmap: buckets placed on their numeric scale (log over ≥ 3 decades, else linear), a separate +Inf band, and every finite bucket, including the first, with a height (e.g. `[0, 5, +Inf]`, `[-5, -1, +Inf]`) |
| `unit:text-flow-sanitise` | Markdown with `<script>`, `onerror=`, iframes renders as text runs; removal counted |
| `unit:context-reducer` | Every [02 §5](../product/02-information-architecture.md#5-context-propagation-rules) row; `[` `]` `-` `=` window arithmetic |
| `unit:undo-prop` | `undo ∘ apply = id` for every command |
| `unit:keymap-fsm` | 250 ms tap/hold; 1 s chord timeout and cancel; remap conflict refusal names the existing action |
| `unit:url-codec` | URL round-trip for every pattern; copy link pins absolute time unless "keep relative" |
| `unit:time-expr` | Time expressions (`now`, `now/d`, `now-<n><unit>`, ISO-8601): parse, print and resolve; `now/d` in the browser zone on both DST days; offsets normalised to UTC; each error names its cause (an unknown unit by name); print∘parse is the identity |
| `unit:context-search` | `from`, `to` and `refresh` read from the URL search: missing, duplicate, invalid and `from ≥ to` values defaulted and reported; non-canonical encodings canonicalised; other keys kept, sorted; read∘write is the identity ([ADR-0017](../adr/0017-react-router.md)) |
| `unit:cam-codec` | `cam` ≤ 64 chars for every mode; restore within 1 px; CRC rejects corruption |
| `unit:codec-roundtrip` | Golden Arrow fixture per schema, BFF writer → WASM reader |
| `unit:json-arrow-prop` | JSON → Arrow equals PulsusDB JSON bit for bit, NaN/±Inf and gaps |
| `unit:fuzz-dsf` | `cargo-fuzz` on the DSF parser and IPC decode (nightly; crashes block release) |
| `unit:ring-stress` | loom/shuttle on SPSC rings and chunk pinning; 10⁶ records through each ring with random stalls |
| `unit:decode-frames` | The client decoder (`client/src/data/decode.ts`, T04-010) maps the golden range and instant bodies of `wire/fixtures/json/` to `SeriesFrame`s on the grid bit for bit (NaN, ±Inf, −0, subnormals; `null` → gap) and reports the JSON pointer of the first bad element (#62) |
| `unit:promql-step` | Go `PromGrid` and TS `promGrid` give the step, start and end of every case of `wire/fixtures/json/promql-step.json`, and refuse a range of more than 11 000 steps of 1 d (#62) |
| `unit:keyhash-corpus` | `key_hash` of every entry of `wire/fixtures/keyhash/labels.json`: the empty set is the published XXH3-64 of empty input, the canonical bytes are `name 0xFF value 0xFF`, input order is irrelevant (T04-004) |
| `unit:virtual-guard` | Reserved names are refused as whole words and `source="pulsus-dash"` as bytes, on the query, every `match` and the metadata `metric`, before any request; near misses pass (T07-020 v1) |
| `unit:sanitise` | Upstream error, warning, info and help texts and the accepted headers reach no response or log with the binding's credential, password (any length), Basic token, URL or host; texts are cleaned and capped (T06-024) |
| `unit:deadlines` | Every PulsusDB route ends at its deadline when the upstream sends no header or stalls mid-body (504, or `unreachable` for the check), and the tenant slot is free afterwards (T06-010) |
| `unit:body-limits` | Each body and value limit of the PulsusDB client and the 2 MiB request body give their documented error (#62) |
| `unit:config-strict` | BFF configuration (T06-019): an unknown or repeated YAML key, a second YAML document, an unknown `PULSUS_DASH_*` variable (other than the client tooling's) or a wrong type fails with the key and line or the variable; precedence defaults → file → environment; secret references refuse literals unless `allow_inline_secrets` and never print a value (T19-010) |
| `unit:board-spec` | Board spec v1 (plan #61): the shared fixtures `api/fixtures/board-spec/v1-{minimal,full}.json` parse and round-trip through canonical JSON; the minimal fixture's canonical form and SHA-256 are fixed; every case of `invalid.json` returns exactly its JSON-pointer field errors in order (unknown, wrongly cased, repeated, missing and `null` keys, wrong types, non-integer grid values, and each semantic rule); the upcaster accepts v1 unchanged and refuses newer versions; the RFC 6902 patch applies back to the target. The client's `checkBoardSpec` (`client/src/boards/spec.test.ts`, plan #61 Part B) runs the same fixtures and returns the same pointers and message keys in the same order; the six cases that exist only as JSON text (not JSON, trailing data, empty body, duplicate key, `6.5` and `1e2` as integers) are the server's alone |

**BFF integration on PostgreSQL 15 and 16 (`make itest`)**

| Gate | Checks | Stage | Blocking |
|---|---|---|---|
| `itest:bff-refuses-altered-asset` | Named by [T18](T18-security.md) T18-006; runs in `ci:go-test` (no database needed): an embedded set with one byte changed in a listed file, a listed file missing, or an unlisted extra file is refused by start-up verification (`hash_mismatch`, `missing_file`, `unlisted_file` naming the path), and `serve` exits 1 with `asset integrity check failed` and never opens a listener | PR | yes |
| `itest:asset-manifest-signature` | Named by T18-006; runs in `ci:go-test`: a manifest one byte off its signed bytes, a signature by another key, a 63-byte or missing signature, a missing manifest, and no compiled-in key are refused (`bad_signature`, `missing_signature`, `missing_manifest`, `no_public_key`); of two keys, the second may sign (rotation) | PR | yes |
| `itest:rls-isolation` | For every tenant table, enumerated from `pg_class` (a table without a test fixture fails): a transaction bound to organisation A sees no row of B, as the app role and as the owner (`FORCE`); with no organisation bound every table reads empty; writing B's row from A fails with `42501`; a pooled connection carries no organisation after commit; every table except `install_state` and `goose_db_version` has `ENABLE` and `FORCE` RLS and policy `org_isolation`, and every key leads with `org_id` except the root table's (T11-002, T11-003); the audit partitions carry the same RLS, and as the app role every partition of `audit_events` refuses `SELECT` and `INSERT` with `42501` (T11-026) | PR | yes |
| `itest:no-extensions` | After a migration from empty, `pg_extension` holds only `plpgsql` (T11-001) | PR | yes |
| `itest:promql-range` | The range route against the fake: the grid, one frame per series with its key, every transcript value bit for bit and every other grid point `null`; the upstream form (`start`, `end`, `step`, `timeout`, the query byte for byte); truncation by warning and by flag; keys in any order (PRF-031, T06-011, T04-004, T04-005, T07-002) | PR | yes |
| `itest:promql-errors` | Parse errors with and without a position, timeout, hang with `timeout_ms: 300`, too broad, `timeout_ms` out of range and a reserved name without an upstream request, an unreachable PulsusDB (502) while `/readyz` stays 200 (T06-026, T06-009, T09-009) | PR | yes |
| `itest:cancel` | A browser abort before headers reaches PulsusDB within 100 ms; the access log records `499` (PRF-030, T06-010) | PR | yes |
| `itest:cancel-mid-stream` | A browser abort after the first frame reaches PulsusDB within 100 ms, frees the tenant slot and logs no stream abort (PRF-030, T06-010) | PR | yes |
| `itest:tenant-header` | `X-Scope-OrgID`, `X-Pulsus-Database` and Basic credentials come only from the resolved binding; a binding without them sends none; a browser header is never forwarded; an unknown tenant is 404 (T06-006, T06-002) | PR | yes |
| `itest:datasource-check` | The check answers `ok` against the fake and `unreachable` against a closed port; `/readyz` stays 200 (T06-025, T06-026) | PR | yes |
| `itest:migrations` | Up from empty, then an idempotent rerun; a dry run writes nothing; two concurrent `migrate` runs apply and seed once; a database more than one version ahead is refused (also when another run advanced it while this one waited for the lock) and one version ahead is accepted by `migrate` and `serve`; `serve` refuses an older schema (T11-015, T19-007) | PR | yes |
| `itest:board-crud` | Through `serve` (plan #61): create, read, save, unchanged save (no version, no audit event, ETag kept), stale `If-Match` → 409 with the current board and the submitted spec, missing `If-Match` → 428, list, soft delete; counts of versions and audit events after each step; every audit row names the fixed local principal, the board and the request ID; an invalid board writes nothing; two concurrent saves with one `If-Match` give one version and one 409 (T11-005, T11-006) | PR | yes |
| `itest:board-prefs` | Through `serve`: starring is idempotent, unstarring empties the list, an unknown board is 404; recent boards are most recent first, honour `limit`, and drop deleted boards; starred boards drop deleted boards; 200 recent views are kept per user | PR | yes |
| `itest:audit-append-only` | Board subset (plan #61), as the app role, each in its own transaction: `UPDATE`, `DELETE` and `TRUNCATE` of `audit_events`, `UPDATE` and `DELETE` of `board_versions`, `DELETE` of `boards` and of `audit_chain_heads` fail with `42501`; the hash chain verifies event by event and continues across the retention floor through `audit_chain_heads` (T11-017, T11-006, T06-004) | PR | yes |

**Goldens (L2)**

| Gate | Checks |
|---|---|
| `golden:gallery` | Every gallery page × variants (§4.2), ꟻLIP rules; two seeded runs identical. From #68 it includes the engine line pages (line-1, line-50, line-gaps, line-600 × dark, light; line-50 dark at DPR 2 and with a manual value range) on lavapipe, T1 and T2 byte-equal |
| `golden:interim-gallery` | Until #68: the seven interim Canvas 2D gallery charts × dark and light in the pinned Playwright Chromium against committed baselines (per-pixel threshold 0.1, ≤ 0.2 % differing pixels); two seeded runs identical; baselines written only by CI under the `golden-update` label |
| `golden:decimation-raw` | From #68: decimated vs every-raw-point render through the same pipeline, zero differing covered pixels (PR fixtures; nightly 10⁸ points) — the VIZ-006 gate |
| `golden:decimation-ref` | From #68: the decimated render against the independent f64 reference of the ADR-0014 §4 model (A ⊆ B, B ⊆ R⁺, gap bands, interpolation, far crossing, in-range segment); PR 10⁴ points per series, nightly 10⁸ |
| `golden:extreme-range` | From #68: data scaled to [−MAX, MAX] and [MAX/2, MAX] draws finite geometry, equal on both tiers, every sample's pixel covered |
| `golden:greyscale` | State glyphs and axis-ownership glyphs distinguishable in greyscale |
| `golden:inf-shape-grammar-greyscale` | Every class family's 3D shape and 2D glyph distinguishable by silhouette in greyscale ([INF-002](../product/16-infrastructure-model.md#inf-002--one-shape-grammar-per-class-family)) |
| `golden:tier-parity` | WebGPU vs WebGL2 readback per spec (nightly) |
| `golden:native-browser` | Chrome T1 readback vs native render, 100 specs incl. field configuration (nightly) |

**Browser end-to-end (L4)**

| Gate | Checks |
|---|---|
| `e2e:shim-fuzz` | From #68, on engine canvases: 10⁴ random DOM events decoded identically by the engine, in order, loss only as counted overflow |
| `e2e:mode-matrix` | Smoke suite per mode (Full, T2, ST, MT-R, Static) via `?mode=`; until #68 only the interim Canvas 2D mode |
| `e2e:lazy-load` | Cold load that opens no workbench fetches no workbench chunk; with no chart frame on screen it fetches no engine |
| `e2e:no-dom-vis` | With the engine active, every non-DOM vis is drawn by the engine into its viewport canvas: no chart SVG and no interim Canvas 2D frames; one GPU device for the page |
| `e2e:csp-violations` | The production build served with the [ADR-0014](../adr/0014-typescript-react-web-client.md) §9 headers reports no CSP or Trusted Types violation during the PR smoke suite |
| `e2e:bff-headers` | Against the BFF-served stub build: `GET /` carries a `Content-Security-Policy` equal to the client's `CSP` constant and every other document header of [T18](T18-security.md) T18-002; an `/assets/*.js` file requested with `Accept-Encoding: br` is served `br` and `immutable`; a deep link returns `index.html`; an unknown `/api/` path is the 404 envelope |
| `e2e:bff-http-shell` | Against the BFF-served `http` build, and through the Vite dev server proxied to the BFF: the shell bootstraps from `GET /api/dash/v1/bootstrap`, About shows the server version, Sign out is absent under the fixed local principal (D12), and the sidebar shows the data-source line (IA-021) |
| `e2e:board-edit-save` | Against the BFF-served `http` build and its database, in Chromium, Firefox and WebKit (plan #61 Part B): create a board, add three panels, move one with the pointer to column 7 and resize it to 6 × 10, set titles and visualisations, save with `⌘S`/`Ctrl+S`, reload: the same grid positions, titles and visualisations in View mode, and `GET /api/dash/v1/boards/<uid>` agrees; each panel shows the PromQL empty state; with unsaved changes, in-app navigation asks first (Keep editing stays, Discard changes leaves). A board at the last row (y 9 999, h 100) renders at the same box in View and Edit mode. Each run uses its own uniquely named board and deletes it |
| `e2e:board-prefs` | Against the BFF-served `http` build and its database, in Chromium, Firefox and WebKit (plan #61 Part C), PR: Starred and Recent survive a fresh browser context: a board starred and opened in context A is listed in Starred and Recent of a fresh context B before B opens it; a second tab of A sees the star with no reload (cross-tab channel); an unstar in B shows in A when A becomes visible again; a failed star shows a visible message. Each run uses its own uniquely named board and deletes it |
| `e2e:board-sections` | Against the BFF-served `http` build and its database, in Chromium, Firefox and WebKit (plan #61 Part C), PR: collapsed sections render no panels; View-mode toggles are URL overrides (`collapse`/`expand`) that survive reload and Copy link into a fresh context, while the plain URL shows the saved state; the Edit-mode state and new sections survive reload and match `GET /api/dash/v1/boards/<uid>` |
| `e2e:client-routing` | Boards list → board → Explore → browser back: no document navigation; the board shows its previous data in the first frame with no new query (IA-014) |
| `e2e:app-layout` | At 1440×900 on every page of the build: sidebar at the left edge, 240 px (56 px collapsed); page header 56 px high with the title on the left and the time range picker, refresh control and user menu at the right edge in that order; content padding 24 px; board panel gap 16 px; no other persistent chrome (IA-016, VL-017) |
| `e2e:rooms-reachable` | The sidebar lists the build's destinations for the user's role (Admin only for administrators) and marks the current page; the collapsed state persists across reload; each destination opens from the sidebar, from `⌘K` and by its `g` chord (IA-021) |
| `e2e:chrome-every-surface` | Each surface of [04](../product/04-surfaces.md) Table 4-1 in the build shows the sidebar and page header, with the time range picker and refresh control on time-dependent surfaces and the Time Ribbon on the Atlas and Lens; Wall mode shows none of them (SRF-001) |
| `e2e:chart-brush` | Interim charts: a drag over a line chart sets the absolute window snapped to the brush unit (e.g. 12:20–12:25 from drags 0.1–0.4 units inside it), pushed to the URL; a double-click zooms out (twice the window) and the header shows the new range (IA-020 subset) |
| `e2e:chart-hover` | Interim charts: the tooltip shows the time, every series' name and value at the snapped sample in value order; for more than 20 series, sweeping the pointer down the plot shows every series (INT-033 subset) |
| `e2e:time-range-header` | Header picker offers the relative ranges of IA-020 and absolute ranges with the time zone; choosing a range re-queries visible charts and updates the URL; a brush on any time chart sets the picker to that absolute range; a 30 s auto-refresh re-queries every 30 s and "Off" stops it (IA-020, INT-025) |
| `e2e:a11y-rooms` | axe-core WCAG 2.2 AA checks on every room; keyboard-only traversal reaches and operates every control |
| `e2e:focus-regions` | `F6`/`Shift+F6` cycle sidebar → page header → page content → open panels (→ Time Ribbon in Space scenes) and back; focus never trapped (INT-015) |
| `e2e:chrome-layout` | Space scenes, from M-UI3: at 1440×900 the Time Ribbon is 40 px and translucent (canvas visible beneath), the minimap is present in scenes with a camera extent, and no persistent chrome other than IA-016's is shown (IA-028, VL-017) |
| `e2e:deep-link` | Every URL pattern opened in a fresh session reproduces Context, scene, focus and camera; browser back steps camera history; saved Context and vis overrides restored |
| `e2e:table-csv` | `Shift+T` shows the viewport's data as a table; "Export CSV" downloads the same rows |
| `e2e:text-dom-match` | Same string, same size: canvas vs DOM advance width and baseline differ by ≤ 1 px |
| `e2e:font-origin` | Every font request is same-origin; UI strings in Inter, data in JetBrains Mono |
| `e2e:gallery-offline` | Every gallery page renders at target volume with no PulsusDB reachable |
| `e2e:no-pulsusdb-write` | Nightly storyboard run behind a recording proxy: no write to PulsusDB except self-telemetry and audit export |

**Replay specs (L4, `.pdrec`)**

| Gate | Asserts |
|---|---|
| `replay:mouse-bindings` | One recording per [03 §4.1](../product/03-interaction-model.md#41-mouse-and-trackpad-primary) row: resulting camera, selection or Context (2D from M-UI1, 3D from M-UI3) |
| `replay:key-bindings` | One recording per [03 §4.2](../product/03-interaction-model.md#42-keyboard-expert-speed) row at its milestone, incl. `g` chords and the `?` overlay after a remap |
| `replay:camera-history` | Three committed moves; `Alt+←` ×3, mouse-back ×3 and browser back ×3 each return through the poses; `Alt+→` replays forward |
| `replay:per-axis` | Drag/wheel/double-click on an axis change only that axis; pin shown and cleared; `⌘Z` restores; overlays stay placed |
| `replay:compare-axis` | `Shift+C` shows a real-time-labelled top axis; drag by 20 min moves the ghost by 20 min; `⌘Z` restores |
| `replay:crosshair-sync` | Hover at 12:22 puts the cursor at 12:22 in every time viewport in the same frame; tooltip lists one value per series with its axis unit and the comparison time |
| `replay:time-ribbon` | Space scenes, from M-UI3: edge drag resizes, body drag moves, wheel zooms the overview; Context time and the header picker update on release (IA-028, INT-025) |
| `replay:time-scrub` | `Space` hold + 200 px moves the cursor proportionally in every time viewport at frame rate; release commits |
| `replay:live-scroll` | LIVE x offset advances sub-pixel every frame, no jump > 1 px |
| `replay:events-markers` | A deploy marker on every time chart (and ◆ on the Ribbon in Space scenes); click sets before/after baseline |
| `replay:universal-interactions` | Every vis accepts crosshair, click → Inspector, brush, ghost, anomaly overlay, pivot chips; reason tooltip where not applicable; value, labels and Δ within one frame |
| `replay:selection-sources` | Clicking a table row highlights the matching mark everywhere and opens it in the Inspector |
| `replay:context-propagation` | Every [02 §5](../product/02-information-architecture.md#5-context-propagation-rules) row end to end; pivots keep entity, time, translated filters and baseline |
| `replay:undo` | Brush, filter add, narrow; `⌘Z` ×3 restores; `⌘⇧Z` re-applies |
| `replay:space-transitions` | Atlas → Lens → `Esc` with no document navigation; each ≤ 250 ms; returning scene shows data in the first frame with no query |
| `replay:progressive` | Cached data hatched in the first frame; first query step ≈ width/4; coarse painted before refine; pan by one window issues no query; no spinner, shimmer only after 300 ms; rollup → raw switch on zoom |
| `replay:cancel-storm` | 10 window changes in 1 s → 9 cancelled requests, only the last painted |
| `replay:truncation` | `truncated=true` → partial badge and "truncated" with narrow; `422` → error with narrow that re-issues a narrower query; complete → "100 %"; data age shown |
| `replay:reduced-motion` | With reduced motion: next frame shows the final pose; static dashes; static double ring |
| `replay:motion-audit` | Frame capture: transitions ≤ 250 ms ease-out, crossfade 150 ms ± 1 frame, ring 1 Hz, no other animation |

**Lab benchmarks (L5)** — defined in §4.3: `bench:frame-gallery`, `bench:frame-line-1e8`,
`bench:frame-series-1e4`, `bench:frame-scatter-1e7`, `bench:frame-high-hz`, `bench:input-photon`,
`bench:long-tasks`, `bench:offline-interaction`, `bench:startup`, `bench:camera-transition`,
`bench:memory-heaviest`, `bench:memory-pressure`, `bench:inp-rooms`, `bench:rooms-long-tasks`, `bench:lens-load`,
`bench:decode-r1`, `bench:shim-input-cost`; `bench:frame-interim-line` (report only, until #68: the interim Canvas 2D layer redraw of the 50 × 1 440 line chart over 40 theme changes, p50 and p95 reported, no threshold); `bench:frame-interim-heatmap` (report only, until #68: the interim Canvas 2D layer draw of a 10k × 200 heatmap with missing cells, 50 timed draws, p50 and p95 reported, no threshold; #63);
`bench:promql-decode` and `bench:bff-overhead` (#62, `REFERENCE_LAB=1 make bench-bff`: W1, a 1 000 × 1 000
PulsusDB matrix decoded, gridded and encoded, ≤ 30 ms per 10⁶ points, median of 5; W2, 1 000 sequential
range requests with a 2 ms upstream, BFF overhead p50 ≤ 5 ms and p99 ≤ 20 ms ([T06](T06-bff-architecture.md)
§7); they fail over threshold and skip without the lab); plus `bench:cpu-instr` (PR: decode, decimation,
tick generation and layouts, instruction counts via `iai-callgrind`, and from #62 the BFF workloads W1
and W2 via cachegrind for Go, run by `.github/workflows/bench.yml` on every pull request against
`server/testdata/bench/cpu-instr.json`; +3 % → fail).

| Lab gate class | Stage | Threshold | Blocking |
|---|---|---|---|
| `bench:frame-*` on (a)(b) | merge | T05-007 | yes, from M-UI0; until #68 the interim Canvas 2D stand-ins `bench:frame-interim-line` and `bench:frame-interim-heatmap` (the M3 heatmap row at 10k × 200 cells) report only on shared CI (T05-006); a PR that changes the interim draw path records a local before/after run, p95 regression ≤ 10 % |
| `bench:frame-*` on (c) | nightly | T05-007 | release blocker |
| `bench:input-photon`, `bench:offline-interaction` | merge | §4.3 | yes, from M-UI0 |
| `bench:long-tasks` | merge once the reference lab ((a), (b)) exists; until then `e2e`'s trace check (§4.3) is the merge gate | §4.3 | yes, once the lab exists; M-UI0 is not complete until it passes |
| `bench:startup`, `bench:camera-transition`, `bench:memory-pressure` | merge | §4.3 | yes, from M-UI1 |
| `bench:memory-heaviest` | nightly | < 1.5 GB | release blocker |
| `bench:inp-rooms` | merge once the reference lab ((a), (b)) exists; until then CI's `e2e` Chromium leg runs it report-only (INP, count, slowest interaction) | INP ≤ 200 ms | yes once the lab exists (`INP_GATE=enforce`); until then not blocking |
| `bench:rooms-long-tasks` (owner: [T08](T08-dom-component-kit.md) §7, PRF-005; `e2e/perf-rooms-long-tasks.spec.ts`; the board editor scenario, #90, and chart gestures, #93) | PR: CI's `e2e` Chromium leg, interim; merge once the reference lab ((a), (b)) exists | interim CI: `ciOver === 0`, no main-thread task over 50 ms wall with over 16 ms thread time (§4.3 trace check; a task without thread time counts); lab: no task over 16 ms wall between the first and last input (`LONG_TASK_GATE=enforce`) | interim CI check: yes, blocks merge now; 16 ms wall: yes once the lab exists (#68), pending until then |
| `bench:lens-load` | nightly | PRF-010/011 | release blocker, from M-UI2 |
| `bench:decode-r1` | merge | < 50 ms p95 | yes |
| `bench:shim-input-cost` (engine adapter, from #68) | merge | T03-003 (§4.3) | as `bench:long-tasks`: yes once the lab exists; until then CI's `e2e` reports the times only |
| `bench:frame-interim-line` (interim renderer, until #68) | PR | none (reports p50, p95) | no |
| RUM field p95 per `hw_class` | weekly review | within 20 % of the lab | tracked, not blocking |

Instruction counts are used on PRs because wall-clock benchmarks on shared CI runners are too noisy
to gate at 3 %.

**Entity catalogue and infrastructure model ([T12](T12-entity-catalogue.md))**

| Gate | Checks | Stage | Blocking |
|---|---|---|---|
| `golden:catalogue-graph-estates` | Derived entities, classes, shapes and relationships equal the committed graph per golden estate (IA-010, EST-001, EST-003) | merge | yes |
| `itest:entity-schema-custom` | A custom non-Kubernetes schema drives catalogue and breadcrumb; new tenants get the default (IA-011) | merge | yes |
| `itest:signal-row-entity-map` | An entity's logs, spans and profiles are found with zero configuration (IA-012) | merge | yes |
| `itest:runs-on-cooccurrence` | Runs-on with first/last seen; crossing-chip counts; self-hosted software on its host (EST-002, EST-013, INF-031) | merge | yes |
| `itest:connector-contract` | Inventory-only entities; read-only verification refuses write-capable credentials; no mutating call; failure marks stale (EST-004, INF-010) | merge | yes |
| `itest:coverage-model` | Signal mask and blind marker; unmapped rows and cloud series; provider × family matrix equals graph counts (EST-041, INF-009, INF-033) | merge | yes |
| `unit:mapping-pack-lint` | T12-009 over every embedded pack | merge | yes |
| `unit:inf-class-shape-table` | `Class::shape()` equals [16](../product/16-infrastructure-model.md) Table 16-3; ≤ 24 families; shape independent of provider (INF-002, INF-004) | merge | yes |
| `itest:inf-class-resolution` | One class per entity; class and family filters; unknown type → override → redrawn within one refresh; provider without a pack (INF-001, INF-003, INF-006) | merge | yes |
| `itest:inf-cloud-placement` | aws / azure / gcp: hierarchy and terms, metric joins, headline metrics, managed services with segments, service locations (INF-005, INF-007, INF-008, INF-011) | merge | yes |
| `itest:inf-k8s-object-model` | Table 12-3 from each source and both; pod status; ready endpoints; PVC chain; fleets (INF-013, INF-015, INF-017, INF-019, INF-020, INF-023) | merge | yes |
| `itest:inf-k8s-distributions` | Five distributions modelled alike; distribution, version, control-plane health, "managed by provider" (INF-014, INF-021) | merge | yes |
| `itest:inf-k8s-changes` | Rollout bands and phases, envelope and scaling limit, node events, Kubernetes events read in place (INF-016, INF-018, INF-022) | merge | yes |
| `itest:inf-network-model` | Network tree, boundaries, gateways, links, flow aggregates, denied-flow events, reachability (INF-012, INF-024–INF-026) | merge | yes |
| `itest:inf-onprem-model` | Hypervisors and VMs, SNMP devices and LLDP/CDP links, arrays and mounts, facilities (INF-027–INF-030) | merge | yes |
| `prop:catalogue-diff` | `diff(apply(g, d))` is identity; ids stable under attribute order and re-harvest | merge | yes |
| `prop:scoped-view-no-leak` | No response for a fuzzed scope contains a hidden id, name or attribute (T12-018) | merge | yes |
| `itest:anomaly-sweep-quality` | Precision / recall on labelled seasonal series with injected shifts; scores only in Postgres | nightly | yes |
| `bench:catalogue-cycle-1m` | 1M-container cycle within §7 | nightly | yes |
| `bench:catalogue-mixed-estate-cycle` | Mixed-estate cycle within §7 (INF-032) | nightly | yes |
| `bench:change-rank` | Onset ranking ≤ 20 ms | nightly | yes |

## 8. Security, tenancy & RBAC

- Lean bug-report replays contain no telemetry values. Full replays are scope-checked on playback,
  and uploads and views are audit-logged ([11](../product/11-enterprise.md)).
- The corpus contains only synthetic or redacted data (T05-011).
- RUM ships nothing that identifies users or queries (T05-013), into a database or tenant only Dash
  operators can read.
- Release builds are checked for the absence of the test probe and of recording-upload endpoints not
  gated by user action (`ci:probe-absent`).

## 9. Failure modes & degradation

| Failure | Handling |
|---|---|
| Lab machine unhealthy (thermal, driver drift) | T05-012: the job moves to the twin unit and the lab owner is alerted |
| Flaky L4 spec | auto-retry once; a spec flaky twice in 7 days is quarantined (non-blocking) and filed; quarantine > 14 days escalates |
| Golden drift from a Mesa or driver update | pinned versions; updates land as a single PR with a regenerated diff gallery (T05-004) |
| Replay divergence | `--until-divergence` reports the first checkpoint mismatch and the state diff |
| RUM ingest down | T05-014 |
| Gallery page missing for a new vis | `ci:gallery-manifest` fails the PR |

#### T05-015 — Quarantine is bounded
**MUST** — A quarantined spec MUST be non-blocking for at most 14 days before escalation, and a
quarantined spec MUST NOT be the only verification of any Satisfies row.

## 10. Testing

Meta-testing:
- each new gate ships with a deliberately regressing change to prove it fails: a local run recorded in the PR, or a CI run for CI-only gates (T05-002, D13);
- the replay determinism suite runs every `.pdrec` twice natively and asserts identical checkpoints
  (T05-008);
- `pulsus-synth` has its own golden statistics (T05-010);
- a weekly job checks that every gate named in `technical/` Satisfies tables exists in §7.1 and runs
  (T05-001).

## 11. Rollout

| Milestone | Ships |
|---|---|
| M-UI0 | L1, L2 goldens for M1/M3/M4/M8 pages, L3 basics, L4 smoke; static gates; `pulsus-synth` S + Wire-XL; R1 harness; lab (a) and (b); frame-time, input, long-task, offline, memory and INP gates blocking |
| M-UI1 | Gallery corpus from the manifest; lab (c); fake upstream; `.pdrec` v1 with the M-UI1 replay specs; startup, transition and memory-pressure gates; RUM metrics + load phases |
| M-UI2 | Preset M with all four signals; log/trace/profile pages; Lens load bench; RUM traces |
| M-UI3 | Preset L; Atlas and F2 scrub scenarios; tier-parity nightly at full breadth |
| M-UI4 | Incident corpus (12); bug-report replays; photodiode calibration |
| M-UI5+ | Light-theme variants; geomap/schematic pages; dashboard-import parity goldens ([05 §11](../product/05-visualisation-catalogue.md#11-panel-parity-map)) |

## 12. Alternatives considered

| Alternative | Why not |
|---|---|
| Browser-only screenshot tests | Slow, GPU-dependent and flaky. Native headless wgpu gives the same code path deterministically; the browser keeps parity spot checks |
| SSIM / pixel-count diffs | Poor at text and thin lines. ꟻLIP plus text-region rules targets what users notice |
| Wall-clock benchmarks on CI runners | Noise > 10 %. Instruction counts on PRs, a dedicated lab for time |
| Video/DOM session recorders (rrweb-style) | JS-heavy; capture pixels or DOM rather than our input ring; capture data by default, a privacy risk |
| An external RUM vendor | Ships Dash telemetry outside the customer's estate and adds JS. Dogfooding PulsusDB is also a product test |
| A gallery maintained separately from tests | Drifts from what ships; [05 §14](../product/05-visualisation-catalogue.md#14-showcase-gallery) requires one corpus |

## 13. Open questions

1. Is `timestamp-query` usable unquantised in Chrome without flags? If not, GPU time in the browser is
   only estimated, and native timings carry GPU attribution.
2. Is `measureUserAgentSpecificMemory` available enough for the memory gate in Firefox and Safari, or
   do they need the fallback tally?
3. Should lean replays capture coverage blocks only, or also cheap per-batch row counts, to localise
   divergence faster?
4. The lab budget for twin units of (c) (4K wall PCs) and for the external 120 Hz display on (a).
5. Can the corpus be shared publicly as a benchmark for observability RCA? That would help
   [06](../product/06-ai-copilot.md) credibility.

**Resolved during formalisation**

1. **Frame-time thresholds follow 09.** The draft gated p99 ≤ 16.7 ms on (a) and ≤ 22 ms on (b). The
   gates now use [PRF-001](../product/09-performance-contract.md#prf-001--frame-rate-during-interaction) (median ≥ 60 fps on (a), (b), (c)) and [PRF-002](../product/09-performance-contract.md#prf-002--frame-rate-floor) (p99 ≤ 22.2 ms on
   (b)); p99 ≤ 16.7 ms on (a) is a tracked target.
2. **Blocking from M-UI0.** The draft made frame-time gates blocking from M-UI1 and brought lab (b)
   up in M-UI1. [PRF-032](../product/09-performance-contract.md#prf-032--per-visualisation-gpu-benchmarks-in-ci) is an M-UI0 MUST on (a) and (b), so both are M-UI0.
3. **120 Hz.** The draft reported high-Hz without gating until M-UI3. [PRF-001](../product/09-performance-contract.md#prf-001--frame-rate-during-interaction) requires ≥ 120 fps
   on (a) driving a 120 Hz display at M-UI0, so `bench:frame-high-hz` is gated, and (a) gets an
   external 120 Hz display (the M2 Air's panel is 60 Hz).
4. **Headless vs headed.** The draft ran headed Chrome because headless GPU paths differed.
   [PRF-032](../product/09-performance-contract.md#prf-032--per-visualisation-gpu-benchmarks-in-ci) says headless; the lab uses Chrome's new headless mode with the GPU, cross-checked
   weekly against headed (§4.3).
5. **INP threshold.** The draft's lab bar was 100 ms. [PRF-033](../product/09-performance-contract.md#prf-033--bundle-size-and-dom-room-gates) fails at 200 ms; 100 ms stays as a
   tracked target.
6. **Golden variants.** Light theme is M-UI5 and wall high-contrast M-UI6
   ([08](../product/08-visual-language.md)), so M-UI1 goldens are dark only, plus density variants.
7. **Gallery = corpus** is now a design rule (T05-003) generated from one manifest, with the gallery
   running in-browser on `pulsus-synth` ([VIZ-070](../product/05-visualisation-catalogue.md#viz-070--gallery-runs-on-seeded-synthetic-data)).
8. **Section numbering.** [05 §14](../product/05-visualisation-catalogue.md#14-showcase-gallery) cites
   "T05 §3.2–3.3"; these are §4.2–4.3 here, because §3 is the Satisfies table.
9. **D2.** Lab results and RUM are Dash self-telemetry, the only product write to PulsusDB that
   [ADR-0012](../adr/0012-derived-state-in-postgres.md) allows; synthetic OTLP goes only to lab
   PulsusDB instances, from the test harness.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft. Restructured to the template; design rules T05-001 to T05-015; gate catalogue (§7.1) defining every gate named in T01–T05 Satisfies tables; gallery = corpus manifest; thresholds, milestones and headless mode aligned with 09; replay specs; Satisfies table |
| 1.0-rc | 2026-11-18 | #22: §7.1 `ci:shim-lint` and `ci:bundle-size` state their interim behaviour and enabling conditions (`ci:bundle-size` report mode until the first PR that builds `dash-core-mt`) |
| 1.0-rc | 2026-11-18 | #23: §4.1 probe location until the shell; §4.3 long tasks measured from a Chrome trace (`dash-lab::trace`) with CI's `e2e` as PRF-005's merge gate until the reference lab exists, and the shim per-event time (CI reports, `bench:shim-input-cost` gates); §7.1 `bench:long-tasks` row split; `ci:shim-lint` `layout.gen.js` exclusion, `ci:dep-audit` regenerate-and-compare, `ci:probe-absent` fresh build at PR, `ci:bundle-size` enforced |
| 1.0-rc | 2026-11-19 | Roadmap D5 ([12](../product/12-roadmap.md#21-delivery-order-2026-11-19) §2.1): §4.3 log stream gallery page moves M-UI2 → M-UI1 with PRF-020 |
| 1.1-rc | 2026-11-19 | [ADR-0014](../adr/0014-typescript-react-web-client.md), [ADR-0015](../adr/0015-go-bff.md) and the application layout (D9): new §0 maps Rust-only tooling to TS, Go and the later engine; §7.1 withdraws `ci:shim-lint`, adds `ci:lint-ts`, `ci:typecheck`, `ci:lockfile`, `ci:npm-audit`, `ci:api-gen`, `ci:go-lint`, `ci:go-test`, `ci:govulncheck`, `ci:go-mod`, `ci:migrations`, `e2e:csp-violations`, `e2e:client-routing`, `e2e:app-layout`, `e2e:rooms-reachable`, `e2e:chrome-every-surface` and `e2e:time-range-header`; redefines `ci:bundle-size` (ADR-0014 §8 budgets), `ci:dep-audit` (npm allowlist), `ci:token-lint`, `e2e:focus-regions`, `e2e:chrome-layout` (Space scenes only), `e2e:lazy-load`, `e2e:no-dom-vis`, `replay:time-ribbon` and `replay:events-markers`; §4.3 log stream page measures the active implementation (PRF-020) |
| 1.2-rc | 2026-11-20 | #57: §7.1 adds `unit:time-expr` and `unit:context-search` (time expressions and the typed URL search module of [ADR-0017](../adr/0017-react-router.md)); other gates unchanged |
| 1.3-rc | 2026-11-20 | #58: §0 L2 row names `golden:interim-gallery` (Chromium `toHaveScreenshot`, CI-only baselines; ꟻLIP from #68); §7.1 adds `golden:interim-gallery`, `e2e:chart-brush`, `e2e:chart-hover`, `unit:series-cap`, `unit:columns`, `unit:bucket-scale` and `bench:frame-interim-line` (report only until #68), and extends `unit:colour-hash` with the 08 Table 8-1a level rule |
| 1.4-rc | 2026-11-20 | Owner decision D13 (review of #58): T05-002 allows local regression runs, recorded in the PR, as the proof for unit, component and end-to-end gates; CI proof runs only for CI-only gates; report-only benchmarks add a non-red slowdown run; §10 updated to match |
| 1.5-rc | 2026-11-20 | #59 Part A: §7.1 adds `unit:config-strict` and the BFF integration gates `itest:rls-isolation`, `itest:no-extensions` (both already named by T11) and `itest:migrations`; `ci:migrations` names its failing squawk fixture and the append-only check on pull requests |
| 1.6-rc | 2026-11-20 | #59 Part B: §7.1 adds `itest:bff-refuses-altered-asset` and `itest:asset-manifest-signature` (named by T18-006, run in `ci:go-test`), `ci:asset-integrity` (binary-level start-up refusal, PR, blocking), `e2e:bff-headers` and `e2e:bff-http-shell`; other gates unchanged |
| 1.7-rc | 2026-11-20 | #61 Part A: §7.1 adds `unit:board-spec`, `itest:board-crud`, `itest:board-prefs` and `itest:audit-append-only` (board subset; named by T06 and T11); `itest:rls-isolation` adds the audit partitions, unreachable as the app role (T11-026) |
| 1.8-rc | 2026-11-20 | #61 Part B: §7.1 adds `e2e:board-edit-save` (BFF, PR); `unit:board-spec` names the client's side, held to the server by `api/fixtures/board-spec/` |
| 1.9-rc | 2026-11-21 | #61 Part C: §4.3 `bench:inp-rooms` scenario is scripted room interactions in Chromium with INP per document from Event Timing (the board room first, #61); §7.1 lab gate row: merge once the reference lab exists, until then report-only in CI's `e2e` Chromium leg, as `bench:long-tasks` (D-INP-interim; T05-006 unchanged); §7.1 adds `e2e:board-prefs` and `e2e:board-sections` (BFF, PR) |
| 1.10-rc | 2026-11-21 | #90: §4.3 `bench:rooms-long-tasks` scenario and its interim CI check |
| 1.11-rc | 2026-11-21 | #90 code review: §7.1 defines `bench:rooms-long-tasks` (owner T08 §7, PRF-005): interim CI check `ciOver === 0` blocking on PRs; 16 ms wall in the reference lab, pending #68 |
| 1.12-rc | 2026-11-21 | #68 Part A: §4.2 decimation references (`golden:decimation-raw` replaces the old every-raw-point wording of `golden:decimation-ref`, which becomes the f64 structural reference) and the image pins in `engine/tools.toml`; §7.1 adds `ci:engine-lint`, the `ci:spec-lint` subset (crate graph, WGSL location, image literals), the `ci:dep-audit` engine leg (`cargo deny`), `unit:columns-parity`, `unit:decimation-batches`, `unit:decimation-tier-parity`, `unit:buffer-lifetime`, `unit:value-encoding`, `unit:segment-clip`, `unit:epoch-adjacency`, `unit:extreme-ticks`, `unit:spike-visible`, `unit:chunk-builder`, `unit:layout-parity`, `unit:manual-axis`, `unit:held-band`, `unit:camera-primitives`, `unit:commit-shape`, `unit:spec-value-range`, `unit:drawn`, `unit:frame-summary-parity`, `unit:synth-parity`, `unit:engine-fixtures`, `golden:decimation-raw` and `golden:extreme-range`; `golden:gallery` includes the engine line pages |
| 1.13-rc | 2026-11-21 | #59 Part C: §7.1 adds `ci:go-licenses`, `ci:no-pulsusdb-host` and `ci:dev-stack`; `ci:go-lint` self-tests its depguard rules with failing fixtures; owner decision 2026-11-21: `ci:no-pulsusdb-host` uses no repository secret and needs no host name |
| 1.14-rc | 2026-11-21 | #62: §7.1 adds `itest:promql-range`, `itest:promql-errors`, `itest:cancel`, `itest:cancel-mid-stream`, `itest:tenant-header`, `itest:datasource-check`, `unit:decode-frames`, `unit:promql-step`, `unit:keyhash-corpus`, `unit:virtual-guard`, `unit:sanitise`, `unit:deadlines`, `unit:body-limits` and `ci:fake-image`; the lab gates `bench:promql-decode` and `bench:bff-overhead` (`REFERENCE_LAB=1`); `bench:cpu-instr` adds the BFF workloads W1 and W2 (cachegrind for Go); `ci:go-lint`'s `ci:depguard` self-test names `pulsusdb-only` and `pulsusdb-decoder` |
| 1.15-rc | 2026-11-21 | #63 Part A: §7.1 adds `unit:explore-plan`, `unit:heatmap-buckets`, `unit:frame-plan`, `unit:series-rows`, `unit:explore-params` and the report-only `bench:frame-interim-heatmap`; `unit:autovis-table` states its v1 rows; `unit:columns` adds the missing merged heatmap cell; the `bench:frame-*` lab-gate row names the interim stand-ins and the before/after rule for interim draw-path changes |
| 1.16-rc | 2026-11-21 | #63 Part A: `unit:explore-plan` states the rate window `max(4 × step, step + S, 4 × S)` (`S` the scrape interval, default 15 s, per binding later) in place of `4 × step`, with rows where 4 × S and 4 × step set the window |
| 1.17-rc | 2026-11-21 | #93: §4.3 chart-gesture scenario |
| 1.18-rc | 2026-11-21 | #63 Part B: §7.1 adds `unit:promql-shape`, `unit:promql-diagnostics`, `unit:suggest-cache`, `unit:prom-source`, `unit:prom-client`, `unit:editor-keys`, `unit:editor-completion`, `unit:editor-doc`, `unit:editor-diagnostics`, `unit:editor-no-linter`, `unit:editor-styles`, `unit:editor-host`, `unit:query-size`, `unit:editor-composition`, `unit:editor-size`, `unit:lang-table` and `unit:window-keys` |
