# T05 — Testing & performance engineering

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.65-rc · 2026-11-26 |
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
| (in `bench:frame-gallery`, M-UI1) | Log stream: the virtualised DOM list in M-UI1 ([ADR-0014](../adr/0014-typescript-react-web-client.md) §2), measured by `bench:log-scroll` on the dev harness (#66), and `bench:log-page-load` on the Logs page (HTTP decode); M8 GPU text from #69 | fling scroll; page past the window end | 10⁶ lines in window ([PRF-020](../product/09-performance-contract.md#prf-020--10⁶-log-lines-scrollable)) |
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
board panel (#93) as its scenarios, and `bench:editor-keystroke` to the 100 measured keys of the
Explore editor (#63). Until the reference lab exists, CI's `e2e` Chromium leg runs both with the
interim trace check's thresholds (thread > 16 ms and wall > 50 ms fails) as a merge gate; PRF-005's
limit, no main-thread task over 16 ms, is the reference lab's gate (`over16`, enforce mode), pending
#68. `bench:long-tasks` is unchanged.

**Measurement methods**
- **Frame time** is the interval between presented frames, from worker `requestAnimationFrame`
  timestamps, cross-checked with GPU timestamp queries where the `timestamp-query` feature is exposed
  (treated as optional, because browsers may quantise or gate it).
- **Headless.** [PRF-032](../product/09-performance-contract.md#prf-032--per-visualisation-gpu-benchmarks-in-ci) calls for headless GPU benchmarks. `dash-lab` runs Chrome's headless
  mode with the GPU enabled (`--headless=new --use-angle=…`, same compositor and GPU process as
  headed), on the reference machines. A weekly headed run checks the two agree within 5 %.
- **Long tasks on main**: top-level `RunTask` on the page's `CrRendererMain` between first and last
  input `EventDispatch` in a Chrome trace, judged on wall `dur` (`dash-lab::trace`); LoAF serves
  RUM. **Interim CI check** (`ciOver`, until the reference lab exists, §7.1): CI's `e2e` fails a task
  only when it exceeds **both** thresholds, over 50 ms wall **and** over 16 ms thread time, or when
  the trace has no thread time for it (the check fails closed). This is deliberately looser than
  PRF-005 for shared runners, whose wall times are noisy. **PRF-005's limit** (no main-thread task over
  16 ms wall) is enforced by the reference-lab check (`over16`, enforce mode), pending #68.
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
| `ci:no-iframe` | The `security/no-iframe` ESLint rule in `ci:lint-ts` over `client/src` and `client/e2e`: no JSX `iframe`, `frame`, `frameset`, `object` or `embed`, no `createElement` of those names in any case, no JSX `srcDoc` or `srcdoc` assignment, `new DOMParser` (also member-qualified) or `.createContextualFragment(`, static computed keys included; `security/no-html-sink` adds `innerHTML`, `outerHTML` and `insertAdjacentHTML` in every spelling (VIZ-056, T08-009); with it `security/markdown-boundary` keeps the [ADR-0024](../adr/0024-markdown-runtime-dependencies.md) packages inside `src/security/sanitise/` ([T24](T24-geo-schematic-and-widget-panels.md) §10, #198) | PR | yes |
| `ci:typecheck` | `npm run typecheck` (`tsc --noEmit`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) | PR | yes |
| `ci:lockfile` | `package-lock.json` committed and `npm ci` succeeds; exact versions only (no `^` or `~`); every `resolved` URL on `https://registry.npmjs.org/` with an `integrity` hash; `.npmrc` sets `save-exact`, `engine-strict` and `ignore-scripts` ([ADR-0014](../adr/0014-typescript-react-web-client.md) §7) | PR | yes |
| `ci:npm-audit` | `npm audit --omit=dev --audit-level=high` and `npm audit --audit-level=critical` pass; `npm audit signatures` passes | PR | yes |
| `ci:bundle-size` | `npm run size` on the stub build (`dist/`) and `npm run size -- dist-http` on the HTTP build: brotli size per chunk class against `client/bundle-budgets.json` ([ADR-0014](../adr/0014-typescript-react-web-client.md) §8): initial JS ≤ 200 KB, initial CSS ≤ 30 KB, each lazy route chunk ≤ 120 KB, editor chunk ≤ 175 KB, fonts ≤ 150 KB, all client assets except the engine ≤ 1 MB; from #184 E1 the geo asset rows `geo-basemap` ≤ 40 000 B and `geo-gazetteer` ≤ 104 000 B, inside the 1 MB total ([T24](T24-geo-schematic-and-widget-panels.md) §7); from #68 the engine ≤ 1.9 MB ([T03 §7.3](T03-browser-runtime.md#73-wasm-size-budget)); client core (initial JS + CSS + engine) < 3 MB (PRF-009). The editor budget applies to the editor entries and the `editor-*` files statically reachable from them, walking only through `editor-*` files (other imported chunks keep their own rows); none of them may be in the initial JS (#63). Over budget or a required artefact absent in either build → fail. *Later:* the +2 %-per-PR growth check once `main` has a size baseline | PR | yes |
| `ci:geo-data` | From #184 E1: each committed geo asset (`basemap.json`, `gazetteer.json`) has the SHA-256 recorded in `tools/geo/manifest.json` and decodes with `decodeBasemap` / `decodeGazetteer` (T24-087); the CI client job reads only the committed files and downloads no source ([T24](T24-geo-schematic-and-widget-panels.md) §5.13, §10.3) | PR | yes |
| `ci:dep-audit` | Every runtime `dependencies` entry of `client/package.json` is on the allowlist in `client/dependency-policy.json` and in no forbidden category (charting, mapping, 3D, graph-diagram, CSS-in-JS); runtime licences on the AGPL-3.0-compatible allowlist; no third-party asset or font host in the build; no chunk of any audited build (`dist`, `dist-http`, the release builds) holds `minimist`, a Node built-in (also as Vite's `__vite-browser-external` id) or `parse5-sax-parser`'s `SAXParser` entry (`check-bundle-modules.ts` on each build's module graph, #198); and, from each build's manifest, no Markdown module (commonmark, parse5, `parse5-sax-parser`, `entities`, `mdurl`, the renderer, `findIframes`, the Text entry) in the static closure of `index.html` or `BoardPage`, failing closed on a missing root, a dangling import, an unmapped chunk, or a missing, static or empty Markdown entry (#198 Part 3a, ADR-0014 §8). Engine leg from #68: `cargo deny check licenses advisories bans sources` with `engine/deny.toml` (the licence set of [T18](T18-security.md) §4.11, three exact-version exceptions; no unknown registry or git source; yanked crates denied); the `web-sys` feature allowlist arrives with the browser build (Part C); the lock lint is `ci:engine-lint` | PR | yes |
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
| `ci:spec-lint` | T02-001 (no pipeline outside L1); diverging ramps only on delta encodings; glyphs only through `Glyph`; every overlay declares an axis. Subset from #68 (`cargo xtask spec-lint`): `dash-scene` has no dependency, direct or transitive, on `wgpu`, `naga` or `dash-gpu` and its `dash-marks` edge enables no feature; `.wgsl` files only in `dash-marks`; the literals of `engine/ci/lavapipe.Dockerfile` and the toolchain channel equal `engine/tools.toml`; `dash-wire-deps`: the normal dependencies of `dash-wire` are exactly `thiserror` and `bytemuck` (#68 Part B2, ADR-0014 §7); T21-001: no depth, perspective, bevel, shadow or shading property on a 2D kind | PR | yes |
| `ci:engine-lint` | From #68: `cargo fmt --check` and `cargo clippy --workspace --all-targets -D warnings` on `engine/`, with `unwrap_used`, `expect_used` and `disallowed_types` (`std::sync::Mutex`, `RwLock`: T03-008) denied | PR | yes |
| `ci:gallery-manifest` | T05-003 for the build's milestone | PR | yes |
| `ci:probe-absent` | No test probe, no globals, no ungated upload endpoint in release artefacts. Scans a fresh production build of the client (and, from #68, the engine), never files on disk: every file of the tree, recursively, for `__dashProbe` and the fault sentinel `__pulsus_engine_fault__`; the fault build must hold all three fault sites (`--expect-faults`) | PR | yes |
| `ci:engine-gen` | From #68 Part C1 (`make engine-wasm-check`): two engine builds from separate target directories are byte-equal; the generated `dash_core_mt.d.ts` and `layout.gen.ts` equal the committed files | PR | yes |
| `ci:e2e-complete` | Every test `playwright test --list` names for an engine is assigned to exactly one CI shard of it (retries allowed) and was not skipped, except the skips allowlisted in `client/config/e2eSkips.ts` (`client/scripts/e2e-complete.ts`) | PR | yes |

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
| `unit:extreme-ticks` | From #68: data spans that overflow (±MAX) get three finite ticks within 1 ms; from #97, height-aware: three ticks when both mapped pixel gaps (the draw y mapping, halved when the span overflows) are ≥ label + 2, two when the plot is ≥ label + 2 tall, else the end nearer zero; strictly increasing |
| `unit:spike-visible` | From #68: one sample in 10⁶ is drawn at its value on T1 and T2 |
| `unit:chunk-builder` | From #68: `ChunkBuilder` rejects unequal lengths, non-increasing and NaN timestamps; the finite range spans ±MAX and skips NaN |
| `unit:layout-parity` | From #68: the engine's `value_ticks` and value axis equal the interim `valueTicks`, `layoutPlot` and labels bit for bit (`engine/fixtures/ticks.json`, `layout.json`, `pow.json`); from #97, `ticks-extreme.json`: `value_ticks`, falling back to `extreme_ticks`, equals the interim `valueTicks` on its rows |
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
| `unit:value-ticks-bounded` | From #97: the interim `valueTicks` returns finite, bounded ticks for every finite domain (≤ 64 steps, ticks − 1 ≤ floor(h/(label + 2)), and no colliding labels: every adjacent gap measured through the renderer's y is ≥ (label + 2)·(1 − 1e-9), after the nice search too), including overflowing spans, ±MAX ends, equal ends, subnormal spans and short plots; each case in a child process killed after 5 s |
| `unit:axis-layout-prop` | No band overlap; no label collision across lanes; pan on A leaves B's marks pixel-identical; hysteresis (500 ms shrink) |
| `unit:axis-patterns` | Table 5-2 triggers apply per milestone; `origin = User` disables auto; ≤ 2 axes per side auto; "consider stacking" hint |
| `unit:camera-controller` | Cursor-anchored zoom drift < 1 px over 100 random steps (2D and 3D); inertia settles 300 ± 50 ms, no overshoot, stops on the next input frame |
| `unit:scene-model` | Scene = tree of viewports with binding, vis, camera/axes, overlays; preserved when moved |
| `unit:autovis-table` | One fixture per Table 5-13 row → listed vis; milestone restriction; Perspective does not change the rule; Bullet for value + threshold. v1 (#63): rows 5, 6, 7, 14 in that order; row 7 only for a scalar or an instant result of one series with one point; the URL `vis` override wins. #184 step 2 (E3b): row 8 (`hasGeoFields`) after rows 5–7, fixtures A1–A9 of [T24](T24-geo-schematic-and-widget-panels.md) §10.6. #173 Part 2: row 11 (reduced categories) after row 8 and before 14, only for a kind in `available`: instant `byVersion` and `threeKeys` → barchart; range with `reducer` → barchart, without → line (14); one sample per range series without `reducer` → line; histogram with `reducer` → heatmap (5); rate rewrite with `reducer` → line (6); 51 series → line; the default set keeps line (14) |
| `unit:plan-parity` | The shared planner fixture `wire/fixtures/plan/promql.json` (#112, ADR-0021 §6) through the Go planner (`prom.Plan`) and the TS StubApi mirror: every case's plan or refusal (status, message, fields, the plan of a 413), `to_source` position pairs, `needs_types`, Classify and the resolved step, groups that plan to one query; the tables of metric kinds, metadata types, rate windows, durations and byte counts; the reserved-name byte guard; with `unit:plan-shape`, the Go parser's shape of every case and the stub's (Lezer plus the type check) equal to it, and the stub's function table equal to the parser's. It replaces `unit:explore-plan` (#63): the planner rows, the 64 KiB limit on the **sent** text and the rate window rows are fixture cases. LogQL (#116): `wire/fixtures/plan/logql.json` through `logs.Plan` and the TS mirror `api/stub/logsPlan.ts`, by outcome (a preparation failure asserts its error; a plan its text, substituted text and `to_source`; a parity entry its prepared and planned classes, their equality and their spans; a sent-too-large entry the class of its plan), with the `volume_range`, `rate_window` and `durations` tables (the last two equal to `promql.json`'s) and `FuzzEncodeDQ` (a value written into a `"…"` string unquotes to itself). PromQL (#118): `FuzzEncodeQuoted` (a value written into `"…"` or `'…'` unquotes to itself by the upstream parser's rules) and `FuzzValueRoundTrip` (the planned text parses to the value, or the value is refused with `variable.unrepresentable`) |
| `unit:logql-classify` | The `classify` group of `wire/fixtures/plan/logql.json` (L1–L22, #116, T07 §4.1 step 1a) through `logs.Prepare` and the TS mirror: each text's source, reserved set and selector spans on the substituted text, the same from `Classify` of that text, and the T07-020 byte guard over the fixture's `reserved` table; `FuzzClassify` (seeds only in CI) never panics and keeps the spans ordered and in range |
| `unit:heatmap-buckets` | Prometheus buckets → heatmap counts (#63): per group (labels without `le`) and interval, summed over groups; a missing sample, or a group without a bound, makes the cells it touches missing (single and grouped series), never 0 or a partial sum; per-group clamp; row isolation on the full view's axis from the row's group |
| `unit:frame-plan` | Every vis × result kind (series, scalar, string) gives a spec and data that `validateFrameData` accepts, or a notice (#63); scalar overrides; heatmap row isolation fills only the row and a second click restores the full view |
| `unit:series-rows` | The Explore series table rows (#63): last and max ignore NaN; sort by name or value with nulls last in both directions, ties by name then key; the next-sort and isolation toggles |
| `unit:explore-params` | The `q`, `vis`, `rate` URL keys (#63, IA-022): first value read, invalid `vis` ignored, defaults omitted on write, pairs sorted; a non-canonical search is replaced by the `metrics` route |
| `unit:promql-shape` | The PromQL shape analyser on the Lezer tree: bare selector and its source slice (comments skipped), metric names, `histogram_quantile`, value type; any error node gives `UNKNOWN_SHAPE` (T09-002, #63) |
| `unit:promql-diagnostics` | A `queryInvalid` byte offset maps to a UTF-16 code point in the editor text through the planner's offset map, with the end clamped; no position, an out-of-range one or one inside planner text underlines the whole query with "position unknown" (T09-009) |
| `unit:suggest-cache` | The completion cache holds at most 2 000 keys, LRU by last get; 60 s TTL from settle; shared in-flight promises; no in-flight lookup is superseded by another key; an evicted in-flight lookup is re-joined by its own key and is still released by its last signalled caller (#107); eviction never aborts or withholds a result; rejected loads are not kept; a tenant switch or clear ends the generation: it drops every entry and tracked call, aborts in-flight loads (evicted and stuck ones included) and rejects their callers at once with no unhandled rejection; a call with an ended generation token, or for another tenant, sends nothing (T09-007, T09-014); the key holds the language; an entry of either language is never superseded by another key: it is aborted only when its last signalled caller aborts and no unsignalled caller holds it (a pinned request is never aborted while held), or when its generation ends (#66) |
| `unit:prom-source` | Completion lookups call the `/prom/*` API with the window (whole minutes for names, labels and values, whole seconds for series), limits and match, are keyed by 15-min window bucket, pass the caller's signal, so a released lookup is cancelled (#107), resolve empty on failure, and share the metadata query with the page; metadata of a tenant switched away from or cleared is never delivered, and a source of an ended generation (`a → b → a`, `clear()`) sends nothing (T09-007, T09-014, SRF-027) |
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
| `unit:explore-run-size` | Explore Run refusal (#63, T09-015): above 128 KB of UTF-8 in the draft or the URL query, Run (button, Shift+Enter, Mod+Enter, URL load) sends nothing and shows the size message, which also shows while editing; between 64 KiB on the **sent** text (rewrite included) and 128 KB completion works and Run is refused with the 64 KiB message; Run is not accepted until the metric metadata and the chart width are known, so the check always uses the plan that would be sent |
| `unit:lang-table` | `LANGUAGES` resolves each built language to its `QueryLanguage` and rejects the languages not built yet (T09-001, [ADR-0018](../adr/0018-query-language-modules.md)); `LANGUAGES` resolves PromQL and LogQL (whose `shape` claims nothing, ADR-0021 §4) and rejects TraceQL and profiles (#66) |
| `unit:logql-lex` | The LogQL scanner cuts selectors, line filters, pipes, operators, strings (escapes, unterminated at LF, backtick across lines), numbers, durations and bytes; a `#` outside a string is one `error` token and the scan goes on, as LogQL has no comments (#121); any text lexes without throwing into contiguous tokens (T09-003, #66) |
| `unit:logql-state` | The LogQL mode stack: braces, parens, grouping after `by`/`without`/`on`/`ignoring`, ranges; unmatched closers ignored; depth capped at 64 (#66) |
| `unit:logql-highlight` | The LogQL stream language tags label names (in selectors and grouping), functions, stages and keywords, strings and numbers; a `#` is `invalid`, never a comment; a backtick string over two lines stays a string (T09-003) |
| `unit:logql-context` | The LogQL caret context: label name, label value (quoted, backtick, unquoted), grouping, stage, function and duration, with the other complete matchers of the selector as scope, as written, leaving out matchers with variable references; the text after a `#` is LogQL, not a comment (#121) (T09 §4.4, T09-010) |
| `unit:logql-completion` | LogQL completion asks for label names and values under the selector's other matchers from its remote slot and completes stages, functions and durations from its synchronous local slot; each context answers in one slot (T09-007) |
| `unit:logql-replace` | Accepting a LogQL completion replaces the whole token or value under the caret and keeps its quotes and brackets; a value not well closed (unclosed, or not followed by `}` or `,`; the end of the query never counts) ends at the first quote, `}`, `,` or whitespace after the caret and gains its closing quote unless that is its own; values are escaped for the quote in use (#66) |
| `unit:logql-cancel` | An in-flight LogQL lookup is kept and shared while the caret context keeps its key, and the view's interest is released when a document or selection change moves the context to another key or a non-remote context, or the view is destroyed; the request is aborted only when no other view or unsignalled caller still holds it (T09-007) |
| `unit:logql-completion-timing` | LogQL static completions open in the keystroke's task; remote lookups start 120 ms after the last keystroke, at once on an explicit start (T09-007, T09 §7) |
| `unit:promql-completion` | PromQL completion answers static items (functions, aggregations, keywords, operators, durations, numbers) from a local slot, whose recording run of the package sends nothing, and metric names, label names and values from a remote slot that returns only what the local run did not; both results end at the caret, each in its own section (T09-007, SRF-027, #107) |
| `unit:promql-replace` | Accepting a PromQL completion filtered by the text before the caret replaces the whole token or value under it: the package's end rule (equal to the package on a corpus), and a label value that is not well closed ends at the first unescaped quote, `}`, `,` or whitespace after the caret and gains its closing quote (T09 §4.4, #107) |
| `unit:promql-completion-timing` | PromQL static completions open in the keystroke's task, with no wait for the pending remote slot; remote lookups start 120 ms after the last keystroke, at once on an explicit start; a late result never moves the highlighted item or any item above it (T09-007, T09-008, T09 §7, #107) |
| `unit:promql-cancel` | Every document or selection change, a query of another key and the view's end release the PromQL view's interest in an in-flight lookup, and the next one starts 120 ms after the last key with a new signal; a wait on a context CodeMirror does not abort starts nothing after a change or the view's end; another view's interest keeps a shared request, and two views on two keys both complete (T09-007, #107) |
| `unit:editor-probe` | The editor's update probe and the PromQL completion probe are read once per view: a probe the bench installs before the view is called, one set later never (T09-003, T09 §7, #63, #107) |
| `unit:router-dev-logql` | The dev-only LogQL editor harness route renders the editor with the `q` text (#66) |
| `unit:log-source` | LogQL lookups go through `/logs/labels` and `/logs/label/{name}/values` over the minute-snapped window with limit 1 000, send `query` only for a non-empty selector and exactly as given, are cached per tenant and language, resolve `[]` on any error (a refused reserved scope included) or abort, pass the caller's signal to the cache, and end with the tenant's generation (T09-007, T09-014) |
| `unit:lookup-window` | Completion windows snapped to minutes (widened to one minute) or seconds |
| `unit:logql-diagnostics` | A LogQL `queryInvalid` byte offset, mapped to the raw text by the server, underlines its code point; none or out of range underlines the whole query with "position unknown"; `invalid` (variables), `queryTooLong` (planned size, processing cap) and other kinds underline nothing (T09-009, ADR-0021 §3) |
| `unit:logql-editor` | The LogQL editor on the shared host: shadow root, label, run keys, Escape, diagnostics, read-only, focus delegation, completion from the current source, no lookup while composing; no line-comment token or comment command, and a positioned server refusal of a `#` underlines the `#` (T09-004, T09-005, T09-009) |
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
| `unit:codec-roundtrip` | Golden Arrow fixtures (`wire/fixtures/arrow/*.dsf` with their `.expect.json`, built from the writer's inputs): the Go writer reproduces the bytes and an arrow-go read-back equals the expectation (#68 Part B1); the engine reader decodes them to the same expectation (B2) (T04-001, T04-005) |
| `unit:json-arrow-prop` | 200 seeded PulsusDB matrix bodies through `Client.QueryRange` and the Arrow writer: the read-back equals the decoded series bit for bit (NaN payloads, ±Inf, −0, subnormals), validity = presence (T04-004, T04-005) |
| `unit:schema-yaml` | `wire/schemas/*.yaml` equal the writer's four schemas: names, order, Arrow types, nullability, required metadata, the `dash.grid.len` maximum; no column is dictionary-encoded ([ADR-0015](../adr/0015-go-bff.md), T04-003) |
| `unit:dsf-writer-order` | The writer's frame sequence (type, part, flags), batch sizes 1 then clamp(⌊1 MiB/(8·N)⌋, 1, 64), labels before data, one `LAST` per part; bad grids refused with the stream-level ERROR; the 2²²-point grid fits one batch; a refused `Add` closes its part with `writer refused: …` (T04-006, T04-012) |
| `unit:part-ids` | Zero, equal and reused part ids are refused with one stream-level ERROR (part 0) and later calls are `ErrOrder`; the valid `part-ids.dsf` decodes without failures (T04-009) |
| `unit:dsf-header` | The 16-byte DSF header byte for byte on both sides; version ≠ 1, reserved ≠ 0, types 0 and 9 and `payload_len` > 64 MiB rejected (T04-009) |
| `unit:arrow-alignment` | Every IPC body at a body offset ≡ 0 (mod 64) and every frame length ≡ 0 (mod 8); grid values and `series_id` buffers 64-aligned after an arrow-go read-back (B1); the engine reader rejects misaligned buffers and bodies and pins no input (B2) (T04 §4.2, §5.1, T04-015) |
| `unit:coverage-complete` | `CoverageFrom` maps PulsusDB's completeness (exactness 4, `read_cache` codes, `data_end`, `series_returned`) (B1); the engine's `complete`, `retention_limited` and `exact` follow the T04 §5.3 rule against `dash.grid.requested_start_ms` (B2) (T04-012, VIZ-027) |
| `unit:dsf-bounds` | The engine's DSF splitter and decoder: every split point gives the same events; truncation, header faults, `MAX_PAYLOAD` + 1 and per-part corruptions each fail only their part; end of input without `END` fails the open parts; never a panic (#68 Part B2; T04-009, T04-010) |
| `unit:dsf-fuzz-smoke` | Seeded mutants of every fixture through splitter, decoder and `finish`: no panic, and every published chunk's offsets and values consistent (B2; T04-009, T04-010) |
| `unit:fb-reader` | The engine's flatbuffers reader on hand-built buffers: defaults for absent fields, every offset, length, alignment and depth bound refused (B2; T04-010) |
| `unit:limits-json` | `wire/schemas/limits.json` equals the Go and Rust wire limits, cost constants, reserves and `MAX_GRID_LEN` (#68 Part B3) |
| `unit:wire-limits` | The writer at and one beyond each shared limit: batches split, parts auto-closed with `wire_limit`/`wire_budget`, coverage and error strings cut (B3; T04-012) |
| `unit:dsf-limits` | The engine reader's source, input and budget bounds: peak bytes held, slab sizes, writer-valid limit fixtures accepted, over-budget bodies refused before allocation (B3; T04-010) |
| `unit:fuzz-dsf` | `cargo-fuzz` on the DSF parser and IPC decode (nightly; crashes block release) |
| `unit:ring-stress` | loom/shuttle on SPSC rings and chunk pinning; 10⁶ records through each ring with random stalls |
| `unit:input-ring` | From #68 Part C2a1, the engine's input ring (T03 §5.4): the record layout and the two control words, and the generated TS equal to the committed file; the decoder in order, across the wrap marker, a bad record skipping the rest of the batch with tail = head; the free-running counters across 2³² (a full ring of 1 024 Cameras, no overwrite; the end-of-ring gap); the wake-up interleavings of T03-004 (revised); a threaded stress run of 10⁶ records with consumer stalls (seed 7) from 0xFFFF_0000, over ≥ 15 wraps and the rollover, none lost; the adapter's bytes (`engine/fixtures/input-ring.json`) decoded to its log; the producer's coalescing and ordering, per-frame seqs at publish with their 53-bit extension, the `created` gate, dispose and restart, and `drawn` from the presentation captured at submit |
| `unit:decode-frames` | The client decoder (`client/src/data/decode.ts`, T04-010) maps the golden range and instant bodies of `wire/fixtures/json/` to `SeriesFrame`s on the grid bit for bit (NaN, ±Inf, −0, subnormals; `null` → gap) and reports the JSON pointer of the first bad element (#62) |
| `unit:promql-step` | Go `PromGrid` and TS `promGrid` give the step, start and end of every case of `wire/fixtures/json/promql-step.json`, and refuse a range of more than 11 000 steps of 1 d (#62) |
| `unit:keyhash-corpus` | `key_hash` of every entry of `wire/fixtures/keyhash/labels.json`: the empty set is the published XXH3-64 of empty input, the canonical bytes are `name 0xFF value 0xFF`, input order is irrelevant (T04-004) |
| `unit:virtual-guard` | Reserved names are refused as whole words and `source="pulsus-dash"` as bytes, on the query, every `match` and the metadata `metric`, and on the LogQL range, volume, label and series inputs (#65), before any request; near misses pass (T07-020 v1). The LogQL query routes classify first (`logs.Prepare`, #116), then run the guard |
| `unit:sanitise` | Upstream error, warning, info and help texts, log lines, stream label values, `text/plain` errors and the accepted headers reach no response or log with the binding's credential, password (any length), Basic token, URL or host; texts are cleaned and capped (T06-024; log routes #65) |
| `unit:deadlines` | Every PulsusDB route ends at its deadline when the upstream sends no header or stalls mid-body (504, or `unreachable` for the check), and the tenant slot is free afterwards (T06-010); the LogQL range route also on a stalled second request of a page, and the volume route on a stalled matrix without a partial aggregate (#65) |
| `unit:decode-logs` | The client decoder's `decodeLogs` and `decodeVolume` (#65, T04-010): the log goldens of `wire/fixtures/json/` give exact `BigInt64Array` timestamps (`1767229100000000300n`), rows in the merge order (ts in direction, then stream, then entry), level codes, per-row metadata and parsed fields, the cursor; the metric golden equals `decodeRangeFrame`; a ts beyond int64, with a leading zero, at `start·10⁶` or past `end·10⁶`, an unknown level, a ts against the direction, and volume labels other than `{level}` are refused at their JSON pointer |
| `unit:log-cursor` | The log cursor (#65): 48 base64url characters of a 36-byte image that round-trips; another length, version, direction byte, a skip of 5 000 or a position outside its own window is `cursor.invalid`; another query, direction, `from` or `to` is `cursor.mismatch`; the width is not bound |
| `unit:logql-routes` | The LogQL range and volume routes (#65): every validation row before any upstream request; a metric result streams its first frame before the upstream ends and a failure after the header resets the connection (`logql_stream_aborted`); `result` before `resultType` gives the same bytes, for a page and a metric result; the PromQL routes unchanged |
| `unit:log-time-range` | The log routes' supported time range, `maxLogTimeMs` = 9223372036854, on `to` before alignment (all five routes) and on the aligned grid end (range and volume), without an upstream request; the edge values reach PulsusDB as 19-digit ns (#65, owner decision Q6) |
| `unit:logql-golden` | The log route bodies of `wire/fixtures/json/logql-*.json` byte for byte against the fake: backward and forward pages with their cursors, a metric result and the volume (#65, T04-001) |
| `unit:logs-completion` | The log completion routes: labels, label values and series with keys, the BFF's `limit` cut, 429 with `Retry-After`, an upstream error as the default response (#65) |
| `unit:body-limits` | Each body and value limit of the PulsusDB client and the 2 MiB request body give their documented error (#62) |
| `unit:log-paging` | The LogQL pager against an upstream that answers each request with a different valid subset and order of its edge timestamp group, in both directions: pages of complete groups only, the group fetch and its sub-paging, the `(ts, skip)` cursor, at most 3 requests per page, the documented limit of 5 000 entries at one nanosecond, no request after a cancel; a 500-case property run delivers every entry exactly once in page order (#65, acceptance 1 at the client level); and every case of the shared fixture `wire/fixtures/json/logql-paging.json` for 10 seeds of edge-group subsets (`TestPagingFixture`), which the client synth also passes (#66 Part B) |
| `unit:log-window` | The log window `(from, to]` in ns on an unaligned range: entries exactly on `from` never and on `to` always delivered, the first page on the grid and its re-issue on the window, the int64 edge (#65) |
| `unit:log-buffer` | The client log buffer (#66 Part B): ordinals over whole pages; the caps 10⁶ entries and 2²⁷ UTF-16 units, far-end eviction except the shown pages, the page just added never evicted; the cursor chain kept after eviction; a re-fetch with another count, returned cursor or content fingerprint (ts, stream key, level and line of every row, in order) is drift and changes nothing; empty pages; per-page stream tables |
| `unit:log-pager` | The client pager over `Api.queryLogs` (#66 Part B): the raw text, `vars`, window, width, direction and `limit` 1 000 the same on every page, `cursor` from the chain; one request per end, both ends together; dispose aborts both and ignores late answers; phases (a metric page 0 stops paging), errors and retry, drift, stale answers; completeness merge; a 300-case property run delivers every synthetic entry exactly once in page order across tie groups and limits, and re-fetches equal the first fetch |
| `unit:log-synth` | The synthetic log API equals the BFF's pager on the shared fixture `wire/fixtures/json/logql-paging.json` (whole groups, a split group continued by `(ts, skip)`, `past`, both directions, empty last pages, an insert and a replace); generated data in `(from, to]` in direction order; determinism, latency, abort, line length |
| `unit:log-slice` | The stream's slice: ≤ 200 000 rows (+ 20 000 while scrolling), ≤ 8 × 10⁶ px at rest and 12 × 10⁶ px always; growth while scrolling, the slice around an ordinal, the re-slice triggers with a margin of at most a quarter of the slice (a stationary viewport never re-slices twice), the measured extent over the bound, the sentinel index mapping, the anchor with its fallbacks (a sentinel at the top, an empty slice, clamping, no measurement, an ordinal outside the slice) |
| `unit:log-stream` | `LogStream` in jsdom: the gutter's colour bar, three-letter glyph and screen-reader level name, the browser-zone timestamp, the line as text; wrap and order controls; ≤ 42 rows mounted of 10 000; prefetch near the end; head re-fetch; the sentinels of every state; `aria-posinset` and `aria-setsize`; nothing for a metric result |
| `unit:log-stream-prefetch` | `LogStream`'s `prefetchRows` (#67): at 50, one page of 1 000 loads nothing after mount and the next page once row 960 is in view; without it (2 000) the next page loads at mount |
| `unit:log-panel-path` | A board LogQL panel's path by its saved vis (#67): Auto and Logs → stream; Bars → volume frame; Line, Heatmap, Stat → frame |
| `unit:stream-input` | The run a stream panel holds (#67, T07-012): visible → the next run; scrolled out → the next run only with the held run's pager key and generation, else none |
| `unit:fetch-log-frame` | A board frame panel's fetch (#67): Bars starts the volume before the probe settles; the probe is the raw request with `limit` 1, no direction or cursor; a log answer is the volume (or an empty series result without it), a metric answer its series and aborts the volume with no unhandled rejection; a rejected probe aborts the volume; a rejected volume rejects; the outer abort aborts both; the abort listener is removed once |
| `unit:stream-meta` | A stream panel's `planned` and completeness by pager phase: the page's for streams, the series' for a metric answer, none before (#67) |
| `unit:logql-planned` | A LogQL `planned` as a panel's: query, expanded, bytes and step, `valueType` `unknown`, no rate or histogram facts, no rate window (#67) |
| `unit:from-range-frame` | `fromRange` takes any range frame: a log volume is a range series result (#67) |
| `unit:panel-view` | The board panel views: PromQL's blocked, error, loading and result rows (#64); the LogQL rows (#67): stream loading, the stream, a metric answer as a line (Auto) or the Logs message, the volume frame by level with thresholds and legend, a metric answer in the saved vis, the "metric queries" message for Line, Heatmap and Stat on a log query; a volume legend isolation keeps the level stack |
| `unit:explore-link` | A panel's Open in Explore link: PromQL's expanded text and vis (#64); a LogQL panel's expanded text to Explore › Logs, none without it (#67) |
| `unit:query-language` | `useQueryLanguage(null)` stays loading and imports nothing; a language is imported once (#67) |
| `unit:board-log-panels` | Board LogQL panels in jsdom, BL1–BL29 (#67): one first page when visible, kept while scrolled out, a new one after a window change only when shown; the kind probe and volume of a Bars panel, the volume aborted on a metric answer; the metric-answer and log-answer messages; every request aborted on a window change, the tenant switch and Edit; Refresh now under an absolute window; unset and referenced variables; the error with line and column; Partial data and Narrow; resize within and across a step; drift's Run again; Open in Explore; full screen on the same pager; order and wrap; the editor's LogQL field, Run of the same text and the Auto option; a PromQL-only board loads no LogQL; the saved vis kinds survive a save and reload; the volume legend isolation |
| `unit:log-time` | `formatLogTime`: `YYYY-MM-DD HH:mm:ss.SSS` in UTC, a negative and a half-hour offset zone, millisecond padding |
| `unit:level-tokens` | `level-*` equal the series hues of VL-002 Table 8-1a in both themes (`unknown` → `series-3`) and no state colour; the glyphs are distinct |
| `unit:use-log-pager` | One live pager per key: an equal input keeps it, another key or unmount aborts it, StrictMode leaves one request; a new generation with the identical input object disposes the pager, aborts its request and starts one new pager; the same generation keeps it; a generation and an input change in one render make one request (#66 Part C) |
| `unit:router-dev-log-stream` | The dev-only log stream harness route exists in dev and stub builds only |
| `unit:long-task-marks` | `scripts/longTasks.ts` with `marks`: the window runs between two User Timing marks (a task after the last input counts); without `marks`, unchanged |
| `unit:event-latency` | `scripts/eventLatency.ts`: the scroll-update `EventLatency` durations of a trace, other types skipped, an unmatched event an error |
| `unit:logs-params` | Explore › Logs URL keys (#66 Part C, IA-022): `q`, `dir` (`forward` only) and `wrap` (`on` only), the first value of each, defaults omitted, sorted with the rest; other keys kept; canonical search or null |
| `unit:use-logs-params` | `useLogsParams`: `dir` and `wrap` replace, `q` pushes, the time Context kept |
| `unit:router-logs-params` | The `explore/logs` route replaces a non-canonical search with the canonical one |
| `unit:clock-epoch` | `Clock.epoch()` counts `refreshed()` calls and notifies; `tick()` leaves it; `refreshed()` leaves the anchor |
| `unit:refresh-epoch` | `refreshNow` moves `refreshEpoch` only when the window does not move: an absolute window and a frozen relative window move it, a relative window under an advanced clock does not (IA-020) |
| `unit:step-width` | The width sent with a log run is held per grid step: the same object within a step, a new one at another step; no width keeps the last |
| `unit:logs-volume` | The Logs page's volume query: one call with the raw text, window and width; a key change aborts the old signal; `rerun()` aborts and refetches; an error keeps the shown volume; another tenant shows nothing until its own success; disabled makes no call (PRF-030, SRF-033) |
| `unit:logs-run` | `pagerInput`, `nextLast` (the last answer kept per tenant), `layoutOf`, `volumePlan` (stacked bars by level, valid frame data), `metricPlan`, `firstPageError` and every row of the Logs status line (SRF-033, PRF-031, T09-015) |
| `unit:logs-page` | Explore › Logs in jsdom, LP1–LP23: the empty state; the raw text, window and width to both routes; the stream and volume layout and the metric layout; Refresh now under an absolute and a moved relative window; Run with the same and new text; order and wrap; the run error underlined; Narrow; partial data per card; the volume's own alert; superseded requests aborted and late answers ignored; resize within and across a step; tenant switches never show the old tenant's volume or series; the 128 KB refusal; drift's Run again; a failed editor chunk; a rerun after a metric answer keeps its chart (#66 Part C) |
| `unit:palette-levels` | Every Table 8-1a row by value takes its series colour, `unknown` → `series-3` (VL-002, T02-005) |
| `unit:log-transcripts` | The generated paging transcripts of the Logs e2e equal a fresh run byte for byte: 1 001 and 500 entries, entry 1 000 in both, every timestamp distinct and in the window |
| `e2e:logs-completion` | Explore › Logs on the fake: typing `{app="` offers the label values; Enter accepts one (T09-007) |
| `e2e:logs-run` | A stream query sends the raw text, window and width to the range and volume routes; the volume draws stacked by level; the lines are listed, the first announced with its level (SRF-033, VIZ-067) |
| `e2e:logs-brush` | Brushing 12:20–12:25 on the volume sets the Context window; the stream and the volume rerun for it (SRF-033, IA-020) |
| `e2e:logs-paging` | Scrolling to the end of page one loads page two: 1 500 distinct ordinals, no duplicate or missing line, two range requests (PRF-020) |
| `e2e:logs-metric` | A LogQL metric query draws a line chart, with no stream and no volume |
| `e2e:logs-cancel` | Two window changes within 200 ms: the superseded range and volume requests are cancelled at the fake, the last completes (PRF-030) |
| `e2e:logs-truncation` | Partial data in the Log lines card with Narrow, which reruns on the middle half; a 422 shows PulsusDB's message and Narrow (PRF-031) |
| `e2e:logs-refresh` | Refresh now under an absolute window reruns the stream from its first page and the volume (IA-020) |
| `e2e:logs-error-on-run` | A syntax error on Run underlines its position and shows the message (T09-009) |
| `e2e:log-stream` | On the harness: the top row keeps its ordinal and offset across far-end eviction and re-slicing, with fixed and wrapped rows (Chromium, Firefox, WebKit, wheel) and with touch (Chromium, no scroll write during the gesture); the last of 10⁶ held rows is reachable; a wrapped slice stays within 8 × 10⁶ px with rows ≤ 2 000 px and does not re-slice at rest; rows taller than estimated are re-sliced back within the bound; wrapping keeps the top row |
| `unit:log-decode` | Log stream decoding: members in any order, a non-object third value element skipped, `ts` as a decimal string without a leading zero within int64, the 5 000-entry, 65 536-byte line and 64 MiB page limits, redaction of lines and labels (#65, T06-011, T06-024) |
| `unit:log-member-order` | Log and metric responses decode the same with `result` before or after `resultType`; a metric result streams when `resultType` comes first; the 96 MiB capture bound; captured bytes are redacted when re-read; the capture's compact re-encoding round-trips (#65) |
| `unit:log-level` | Table 3.2a of #65 (T04 §4.3): `detected_level` first, then `level`, then `unknown`, ASCII case-insensitive; an entry's level from its stream labels, then structured metadata, then parsed fields |
| `unit:log-categorized` | Log query pages send `categorize-labels` and no other call does; the categorised entry (`structuredMetadata`, `parsed`) and the plain shape both decode; metadata and parsed fields are redacted, cut at 4 096 bytes, counted towards the page bound, and break ties in the group order (#65, owner decision 2026-11-21) |
| `unit:logql-calls` | Each LogQL method's upstream method, path and parameters (GET with a query string, `step=<n>ms`, `%019d` ns timestamps, the POST fallback over 8 KiB), decoration on every request of a three-request page with non-increasing `timeout`, retries, deadlines and the scope refusal (#65, T06-005, T06-006, T06-009) |
| `unit:volume-compose` | The volume query embeds the text byte for byte in its fixed template with `\| drop __error__`; the level series are point-wise sums in a fixed order; positions map back into the text (#65, T07-002). Since #116 the template is applied in `logs.Plan` and the core sends the planned text byte for byte; a position inside the template has none (ADR-0021 §3) |
| `unit:volume-buffered` | The volume call returns only after the upstream matrix ended, with the full aggregate, holding its tenant slot until then (#65, T06-011 case 3) |
| `unit:text-errors` | `text/plain` error bodies on both route families: 400 and 422 texts, `at byte N` positions, redaction, cleaning, the 64 KiB cap; a text 503 is not retried (#65, T09-009, PRF-031) |
| `unit:query-hash` | `keyhash.Text` is xxh3-64 (seed 0) of the bytes (#65) |
| `unit:contract-window` | The reference-window setup of the `logql` contract subtest: at most 20 requests, none under 1 ms, the kept half holds the newest timestamp, the empty and too-dense skips with their exact texts, more than 5 000 entries fails (#65) |
| `unit:config-strict` | BFF configuration (T06-019): an unknown or repeated YAML key, a second YAML document, an unknown `PULSUS_DASH_*` variable (other than the client tooling's) or a wrong type fails with the key and line or the variable; precedence defaults → file → environment; secret references refuse literals unless `allow_inline_secrets` and never print a value (T19-010) |
| `unit:board-spec` | Board spec v1 (plan #61): the shared fixtures `api/fixtures/board-spec/v1-{minimal,full}.json` parse and round-trip through canonical JSON; the minimal fixture's canonical form and SHA-256 are fixed; every case of `invalid.json` returns exactly its JSON-pointer field errors in order (unknown, wrongly cased, repeated, missing and `null` keys, wrong types, non-integer grid values, and each semantic rule); the upcaster accepts v1 unchanged and refuses newer versions; the RFC 6902 patch applies back to the target. The client's `checkBoardSpec` (`client/src/boards/spec.test.ts`, plan #61 Part B) runs the same fixtures and returns the same pointers and message keys in the same order; the six cases that exist only as JSON text (not JSON, trailing data, empty body, duplicate key, `6.5` and `1e2` as integers) are the server's alone. Board spec v2 (#64 Part B): `v2-full.json` and `v2-threshold-bounds.json` round-trip on both sides, the threshold and legend rows of `invalid.json` match (the raw `1e400` row is `board.json.type` on both), and a value outside 0 or 1e-9…1e15 in size is `board.thresholds.value.range` on both |
| `unit:thresholds` | `vis/thresholds.ts`: crossing, state, next step and display text per the B.4 table; seam lines skip non-finite values (#64 Part B) |
| `unit:event-marks` | Canvas 2D event markers ([ADR-0023](../adr/0023-chart-event-markers.md)): the label band, one line per event in view through the time transform (pan preview included), layering over filled series and thresholds, truncation, the right edge, `+N` chips and merges, the no-text box, and a 200-set property (boxes inside the band, gaps ≥ `space.1`, every event in view in exactly one box); stat draws none (#64 Part C) |
| `unit:board-events` | One annotations request per resolved window for the whole board (30 panels), the previous one aborted; markers sorted by (atMs, id); none while disabled or before the time is ready; an absolute Refresh now aborts and asks again; the failed and truncated notices; every panel kind gets the same markers; a board with sections only (#64 Part C) |
| `unit:flame-decode` | `data/decode.ts`: the S, A and Z payloads decode (parent, x, width; A's diff layout, Z's empty state); `"9007199254740991"` accepted; each bad case (level gap, x out of order, child past its parent, overlapping siblings, self > total, name out of range, duplicate sibling in a union or a single, a non-root 0/0 node, a count as a JSON number, `"9007199254740992"`, `"01"`, `"-1"`) → DecodeError at the offending element's pointer (T23-002, T23-021); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-suspects` | `vis/flameSuspects.ts` on `flame-agg` and `flame-flat`: ① = `hot::b`, ② = `agg::a`; flat → lowest level then x and "no other suspects"; 9 → 18 % gives g = 0.09 ± 1e-9 and REGRESSED (VIZ-106); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-suspects-nobase` | Suspects with no baseline (single, and union with base.ticks 0): ②–④ by s_f, a 0.5 % function absent, growth null, HOT only, no NEW or REGRESSED, glow 0, no NaN (T23-006); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-suspects-diff` | Union suspects: ① = the current hottest frame, not the baseline's; REGRESSED with g = 0.12; cur.ticks 0 → no rows (VIZ-106, T23-006); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-merge` | `flame-1e5` at 1 000 px: every drawn rect equals its node's or its run's true span (± pixel snapping), none widened; merged counts = hidden nodes; a 0.3 px suspect inside a run is a 2 px accent tick at its true x (VIZ-005, T23-004); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-search-dense` | 5 000 adjacent 0.2 px matches: the highlight is exactly the union of their pixel columns, density strip 5 per column, clicks focus the covering match, `n` visits every match once in order and wraps, "k of 5000 matches labelled" (VIZ-036, T23-004, T23-017); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-options` | `boards/spec.ts` and `validate.go` on `vis.flame`: each invalid case keyed at `/…/vis/flame/<field>` (`.sandwichFunction.required`, `.baseline.invalid` for the offset and range bounds); `mode:'diff'` with `baseline:{kind:'none'}` and no `leftQuery` is valid; absent = defaults (T23 §5.1); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:autovis-profile` | Lang `profile` → `flame` by Table 5-13 rule 2 (VIZ-065); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-diff` | `vis/flameDiff.ts`: added, removed, reordered and unchanged frames; removed blue "− removed" with width > 0, "+ new", reorder = same layout, zero delta all index 4 "no change", zero-tick banner (SRF-046); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-diff-sign` | Cost-rate Δ of +0.4, +0.001, −0.001 and 0 ticks/s (max 0.4): indices 8, 5, 3 and 4; the small changes keep their class cue; the zero frame has none (T23-013, T23-025); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-diff-exact` | Counts next to 2^53 − 1: E, M, the step and the cost text computed in BigInt (index 8 / 0, "cost ±<0.01 %"); unequal windows with equal rates give E = 0, index 4, "cost +0 %"; no float is used for any sign or step (T23-013); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-diff-self` | Self 0 → 0, 0 → 50 and 50 → 0: "self +0 %", "self new", "self −100 %"; self bars none, solid, dashed (T23-013, T23-025); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-diff-cost` | Cases (a)–(e): the class follows the cost-rate change, not the share ("cost +50 % · share −25 pts" is grew; unequal windows at equal rate are unchanged); a parent with self 0 whose cost rises is grew with no self bar (SRF-046, T23-013, T23-025); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-diff-empty` | A zero-tick baseline gives every non-root frame "+ new" ("cost new"); a zero-tick current side gives "− removed" ("cost −100 %"); no NaN or Infinity; banners per T23-021 (T23-013, T23-021); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-gap` | A single frame whose parent has self time keeps the gap (x [0,0,70], width [100,50,30]); a click on b zooms to [70, 100] (T23-013); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-layout` | Payload V: the current-only layout (shown [1,1,1,1,0], p = 90 %) and the union layout (width [1,1,0.5,0.35,0.15], x [0,0,0,0.5,0.85]) (T23-013); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-multiparent` | Payload M: name paths via `parent` keep the two `x` nodes distinct; the diff and single layouts as listed in T23 §10 (T23-002, T23-013); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-zero-self` | A profile with no self time: 2D fills all `sequentialRamp[0]`, 3D Y = 2 with the axis "no self time", ① = the largest-total non-root frame badged LARGEST with "no self time recorded", and one click opens its Inspector (T23-003, T23-006, T23-008); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-sandwich` | `vis/flameSandwich.ts`: f's total counts outermost occurrences only (60, self 35); callers a 40, b 20; callee g 30 (T23-014); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:flame-labels` | Engine crate, `flame3d-1e5`, 360° orbit in 10° steps: no overlaps; selected, focused and ① labels always present; every placed label has a leader (solid when visible, dashed when occluded); badges drawn; ≥ 11 px (VIZ-076, T23-005); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `unit:board-spec-widgets` | `boards/spec.ts` and `validate.go` on the widgets-version fixtures ([T24](T24-geo-schematic-and-widget-panels.md) §5.0; `v‹N›-widgets.json`): valid → no error; text with `query` → `board.panel.query.forbidden`, line without → `.required`; clock `depth` → `board.json.unknownKey`; 13 zones or `Mars/Base` → `zones.invalid` (`Mars/Base` on a new spec in Go only: a `tz`'s existence is checked on writes against the build's zone set, the client checks its form; `TestEmbeddedZonesMatchToolchain` keeps the generated set equal to the toolchain's `zoneinfo.zip`), a duplicate → `.duplicate`; 65 537 bytes → `content.tooLong`; a `to` without offset → `countdown.invalid`; TS = Go; the immediately preceding version's fixture upcasts unchanged (T24-003, VIZ-031, VIZ-057); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `unit:classify-url` | `sanitise/url.ts`: the T24 §10 rejected strings (control, backslash, `//`, credentials, `javascript:`, `data:`, relative), `local` same-origin paths, `external` normalised, `mailto:`; other schemes, look-alikes, C0/C1 controls and lone surrogates (in a path `%EF%BF%BD`, in a host rejected); nothing throws (T24-005, T18-011); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `unit:well-formed` | `sanitise/url.ts` `toWellFormed`: lone surrogates → U+FFFD, pairs and `''` unchanged (T24-005, T24-008); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #198) |
| `unit:markdown-links` | `javascript:` → text + `linkScheme`; `/\t/e.test` → `/%09/e.test`; http(s), local and mailto links → new-tab `<a>`; under `ai` external and mailto links are text with host or address (T24-005, T24-018); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `unit:markdown-nodes` | `<script>` and an `onerror` image render nothing, `**ok**` → `<p><strong>ok</strong></p>`, removals `[{html,1},{html,3}]`; heading offset `<h4>`, `<h6>`; `<ol start="999999">` (VIZ-054, T24-009); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `unit:markdown-iframe` | A block, nested and inline iframe render nothing; removals `[iframe]`, `[iframe]`, and `[html]` inside `<script>` (T24-006); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `unit:markdown-images` | `board`: `<img>` for local images, a link for external and for `/api/` and `/auth/` paths, text for `data:`; `ai`: alt texts + `image`, no `img` (T24-018, T18-014); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `unit:markdown-interpolate` | `$env`, `${env}` replaced in text; `$missing`, `$__from`, `{{entity}}` and code literal; destinations `encodeURIComponent`-ed, a `javascript:` value → text + `linkScheme` (T24-008); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `unit:removal-redaction` | Removals `[{linkScheme,1}]`, `[{html,1}]`; the editor text and the `console.debug` JSON lack the credential, token and host (T24-007); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `fuzz:markdown-nodes` | 10 000 inputs (mulberry32, seed 20261125) of 1–40 tokens from the corpus payloads and Markdown syntax, both policies and import: `checkInvariants` (tags ⊆ T24 §4.2 + `span`, attributes ⊆ `href target rel src alt loading start data-lang class aria-hidden`, `href`/`src` pass the independent checker, `ai` has only local anchors and no `img`, DOM depth ≤ `MAX_DEPTH`, well-formed text); import is invertible and its result passes the invariants (VIZ-054, VIZ-056); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153, #198) |
| `unit:markdown-depth`, `unit:markdown-root`, `unit:markdown-walk`, `unit:markdown-pathological`, `unit:markdown-flat-lines`, `unit:markdown-inline-depth`, `unit:markdown-surrogates` | `sanitise/markdown.test.tsx`: elements up to the depth limit, then one flat span of the block's whole source lines and one `depth` removal; the root fragment; splicing into the immediate parent and the removal order; pathological input in < 2 s; `sourceLines` clamping and line ends; lone surrogates → U+FFFD and `%EF%BF%BD` (T24-006, T24-008, VIZ-054); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #198) |
| `unit:markdown-xss-corpus` | Every case of the generated XSS corpus under both policies, through `createRoot`: the generated shape and removals, `checkInvariants`, no `fetch`, `XMLHttpRequest.open` or `sendBeacon` (VIZ-054, VIZ-056, T18-013); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #198) |
| `unit:xss-corpus-current` | `scripts/gen-xss-corpus.ts --check`: the committed corpus equals a fresh generation; one changed expectation → exit 1; PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #198) |
| `unit:xss-e2e-cases` | `scripts/gen-xss-e2e-cases.ts --check`: the committed browser case list (`e2e/fixtures/xss-e2e-cases.json`: digest, skip reason, image request paths) equals a fresh generation; one changed expectation → exit 1; the load-baseline comparison names a changed count; a changed source under the same id changes its digest; the image extraction rows; PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #198 Part 3b) |
| `unit:widget-gallery-route` | `src/app/router.test.tsx`: `dev/widgets?page=widget-text` shows 3 Text bodies, `widget-text-removals` 1 removal list of 7; no route in the http build; PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #198 Part 3b) |
| `unit:find-iframes` | `sanitise/findIframes.ts`: first-duplicate `src` with spec decoding, comment edge cases, the `select`, `table`, `frameset`, `template`, `svg` and `select`/`title` contexts found; none inside raw text, RCDATA, CDATA, processing instructions or bogus comments; no duplicates; the aliased `ParserFeedbackSimulator` gives `SAXParser`'s tokens on every input and imports no `node:` module (T24-006); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `unit:import-text-iframe` | Fixtures f1, f3–f12: exact `inserted` and `notes`; removing `inserted` gives the input byte-for-byte; the listed hrefs; f11 (CRLF, CR) and f12 (list item, block quote) links are `link` nodes after their top-level block (VIZ-056, T24-016); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `unit:import-size-error` | A 65 500-byte panel → `{kind:'textTooLargeForLinks', panelIndex, sourceId, links:1}`; the JSON and message lack the token and the panel title (T24-016); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `unit:security-lint` | `scripts/security-plugin.test.ts`: each `security/no-iframe`, `security/no-html-sink` and `security/markdown-boundary` case reported (static computed keys and member-qualified `DOMParser` included), the allowed cases not, and the full ESLint config applying both (VIZ-056, T08-009, ADR-0024); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #198) |
| `unit:bundle-modules` | The module graph holds the separately built worker bundles (a probe worker extending `node:stream` is found); `scripts/check-bundle-modules.ts` on graph fixtures (a worker chunk among them): `minimist`, `node:` (with or without NUL), `__vite-browser-external` (with or without NUL) and `SAXParser`'s entry each → one `forbidden-module` naming the chunk and module, exit 1; clean → exit 0; a missing graph → exit 2 (ADR-0024). From #198 Part 3a, with manifests: Markdown reached only through `dynamicImports` → none, exit 0; `markdown-in-route`, `missing-route-root`, `bad-manifest-import`, `unmapped-chunk` and `missing-markdown-entry` (absent, not a dynamic entry, or without the renderer) → exactly that rule, exit 1; no manifest → exit 2 (ADR-0014 §8); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #198) |
| `unit:sanitise-bundle` | A Vite build of a probe lazily importing `classifyUrl`, `findIframes`, `convertImportedText` and `renderMarkdown`: the lazy chunk holds the packages and no forbidden module and is ≤ 100 000 bytes brotli 11 (size printed); a probe extending `node:stream` `Transform` gives a `forbidden-module` finding (ADR-0024, ADR-0014 §8); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #198) |
| `unit:text-widget`, `unit:text-region`, `unit:text-overflow`, `unit:text-invalid`, `unit:text-widget-vars` | `widgets/text/TextBody.test.tsx`: headings, new-tab links, variables and code verbatim; empty and blank with no chunk load; removals logged once; the load-failed state; the region named by the title on a board and "Preview: ‹title or Text›" in every state; the tab stop exactly while `scrollHeight > clientHeight` (101 and 100 included) after content and variable changes and on a resize; an invalid draft never rendered or loaded, with the preview's status; `widgetVisErrors` against the `invalid.json` text rows; an unrelated variable renders nothing (T24-008, T24-009, T24-014, T24-017); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #198) |
| `unit:widget-add`, `unit:widget-editor`, `unit:widget-spec-roundtrip`, `unit:text-vis-roundtrip`, `unit:widget-registry-generic` | `addWidget` and `updateWidget` (the caps, a collapsed section, the kind guard, ignored while saving); the widget editor's fields, live errors, removal list and focus; an edit typed back is clean and a save changes only the edited key; `textVis` keeps the stored representation; a test registry's kind added, edited and saved through the same path (VIZ-053, T24-002, T24-003, T24-007, T24-014); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #198) |
| `unit:clock-format` | 12:34:56Z, Context London, en-GB: Tokyo, New York, Auckland and UTC times, dates, offsets, day difference and day/night; `h12` Tokyo `9:34 pm` (T24-010, T24-013); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `unit:clock-countdown` | `in 2 h 15 min`, `in 42 s`, `since 21:34 (0 s)`, `since 21:22 (12 min)`, `in 2 d 3 h`; `hide` + past → no row (T24-012); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `unit:countdown-due` | `countdownDue` per the T24 §10 table (text, due, next, announced); property 200 s → −130 s in 137 ms steps: the text changes exactly at due (T24-011, T24-012); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `unit:wall-clock` | Fake timers: one timer at the earliest due; hidden → none; visible → all notified, `in 30 s` announced once; the last unsubscribe clears (T24-011); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `unit:board-spec-board-list` | `boards/spec.ts` and `validate.go` on the board-list-version fixtures (T24 §5.0; `v‹N›-board-list.json`): `{}` → the defaults `{starred, '', null, 10, default}`; tag mode without a tag and starred with a tag → `tag.invalid`; a 101-character query, `query:'a\tb'` (U+0009 TAB) and recent with a query → `query.invalid`; limit 0, 51, 2.5 → `limit.invalid`; `sort:'care'` → `sort.invalid`; `depth` → `board.json.unknownKey`; board tags ×17 and `['A']` → `board.tags.invalid`, `['a','a']` → `board.tags.duplicate` (these tag cases shipped with the tags version, v4, in #215); TS = Go; the immediately preceding version's fixture upcasts unchanged; the editor shows the Cc text for `a\tb` (U+0009) and sends nothing (T24-029, T24-021, VIZ-031); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.1, #181) |
| `unit:board-list-source` | Stub Api, fake timers: the T24-021 calls and keys; `'  Checkout '` → `{q:'Checkout'}`, `''` → no `q`; keys at 0, 100 and 200 ms → one key change and one request at 450 ms, the previous rows shown until then (T24-021); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.1, #181) |
| `unit:board-list-rows` | Fixture B, current `pay`: `Checkout · ck-1`, `Checkout · ck-2`, the rest plain; `pay` "this board"; `incidents` → B order and the M-UI4 caption (T24-022, T24-023); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.1, #181) |
| `unit:list-coverage` | `listCoverage` → `coverageText`: (12,10) `showing 10 of 12`; (12,12) `100 %`; (1000,10,truncated) `truncated · showing 10 of 1,000`; (0,0) `100 %`; old server `coverage unknown`; `tagsStale` 1 and 3 → `tags not yet known for 1 board`, `… 3 boards`; `stale (12:31:05)`; Narrow in search mode only (T24-024, VIZ-027); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.1, #181) |
| `unit:board-list-states` | Loading at 300 ms (`loading`, facts null); 12 rows; a failed refetch keeps the rows with the notice, `showing 10 of 12 · stale (12:31:05)`, CSV 12 rows, `12 boards (stale)`; Retry gives 11 rows, "Edge v2", `11 boards`; 503 → the store text and `unavailable` (T24-024, T24-026, T24-027); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.1, #181) |
| `unit:board-list-mixed` | An answer without `applied`: starred `coverage unknown · showing 10 of 12`, setsize −1; search filters titles client-side, no chips; tag mode → the T24-029 notice, no rows; `tagsStale: 3` → `tags not yet known for 3 boards`; a 400 at `/tags` → the editor text (T24-029); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.1, #181) |
| `unit:board-list-key` | Deferred stub: at the 450 ms commit no old-key row, CSV disabled, facts null; the old key's refetch is kept while a second widget observes it and aborted when it leaves; late answers never render; no `acme` row after the tenant becomes `beta`; a rejected new key → "Couldn't load boards", no rows, `unavailable` (T24-024); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.1, #181) |
| `unit:list-keyboard` | Fixture B, limit 10: ↓, End, Home, PageDown; Show more + Enter focuses row 11; a refetch without the active row focuses the row at its index and announces "Gateway is no longer listed"; focus outside the list stays; empty → the empty text; error → Retry; Esc clears the search, the next Esc reaches the T25 ladder (T24-025); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.1, #181) |
| `unit:list-table-csv` | `csvCell`: `=SUM(1)`, `-prod`, `@x`, TAB (U+0009) and CR (U+000D) leading cells get `'`; from #184 step 1b numbers are exempt, so `+1` is unchanged (and `+x` gets `'`), with each result of the guard block of [T24](T24-geo-schematic-and-widget-panels.md) §10.5 (`-1+2` → `'-1+2`, `+Infinity`, `-6.25` and `1e5` unchanged); `a,b` and `say "hi"` quoted per RFC 4180; B and S rows with tags and `updated_at`; a `tags: null` row → `unknown` and "tags unknown"; facts `{'12 boards', 'Starred'}`, S `1,000+ boards` (T24-026, VIZ-066, VIZ-068); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.1, #181) |
| `unit:import-board-list` | Dashboard list cases I1–I9 of T24 §10.1: options and notes exactly as listed (I9's query `a\tb\u0007c` holds U+0009 TAB and U+0007 BEL → `abc`) (T24-028, VIZ-060); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.1, #181) |
| `unit:entity-id` | Go `entity/entity_test.go` and the shared `wire/fixtures/json/entity-id.json` (full UUIDs): every [T12](T12-entity-catalogue.md) §4.5 vector (bindings `00000000-0000-4000-8000-0000000000e1`, `…e2`), e.g. service checkout @e1 → `bb7487bd-100d-a998-e0f0-3c65f11da1a7`, the 128 / 129 / 240 / 241 / 306-byte inputs; `{}`, an empty name or namespace, an extra key, kind `spaceship`, a pod without its namespace, a number and an environment conflict → 400 `annotations.entity.invalid` (T12-010); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.2, #181) |
| `unit:change-source` | A counting stub, a line panel and an unfiltered feed: concurrent mounts → 1 request, a later mount → 0, Refresh → 1; a failed refresh → the markers' notice and the feed stale; a new window → the feed hides the old rows and the markers keep theirs; an `e` → its own key (T24-030); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.2, #181) |
| `unit:change-pager` | Fixture C in pages of 3 → 3 requests, 8 rows, "all 3 pages loaded · may have changed while loading", setsize −1; after page 1 `truncated` + Load older; one page of 500 → `100 %`, setsize 8; cap 5 → c7, c4, c3, c6, c2, capped; 1 900 + 150 → 2 000, capped; 1 500 + 500 with `next` null → complete, set → capped (T24-032, T24-036); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.2, #181) |
| `unit:change-snapshot` | Two pages, then a refresh whose page 0 lacks c7 and renames c4: `[c4′, c3, c6]`, the older request aborted, CSV and facts match; a failed refresh keeps the rows, stale; the old key is never rendered (T24-033); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.2, #181) |
| `unit:change-entity` | `e` = [checkout@e1] → c1 + "3 organisation-wide changes not shown", the toggle → 4 rows; + payments@e1 → 3 rows; [checkout@e2] → c3; ["checkout"] → 8 rows + "Entity filter unavailable for this context"; [] → "All entities"; `orgWideHidden` null → no toggle or line (T24-031); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.2, #181) |
| `unit:change-rows` | Fixture C, UTC: c1 `◆ Deploy · 12:10:00 · service checkout · prod-eu`, c3 `… · prod-us`, c2 `service shop / payments`, c4 `Note · 12:23:00–12:40:00 · 17 min · organisation-wide`; c7's text literal; no colour (T24-034, VL-012, VL-020); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.2, #181) |
| `unit:change-selection` | c1–c7 and c9 loaded: `{[], 12:19:00, 12:22:00}` → c3, c6, c2 selected, the others muted; a series key with the interval, or a foreign `change:` id → no effect; a series key + `change:…000000000004` + c4's interval → c4 only; the line panel bands and dims nothing; Enter/Space on c4 inspects and focuses the heading; Load older → "3 changes loaded" (T24-035, T24-036); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.2, #181) |
| `unit:change-inspect` | `inspector/model.test.ts`: c4 → `Note`, `17 min`, `organisation-wide`, Logs disabled ("This change has no service"); c2 → Logs `{service_name="payments"}` over 12:18:02–12:20:02; with `f=job=shop/web` → `{service_name="payments",service_name="web"}` and the T25-010 conflict line; a service named `a"b\c` + LF + `d` → `{service_name="a\"b\\c\nd"}` (T24-035, T25-002); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.2, #181) |
| `unit:change-mixed` | An answer without `applied`: `coverage unknown`, setsize −1, no Load older; `[]` → empty and `coverage unknown`; an `e` → "Filtering by entity needs a newer server", no rows; a create with `entity` → 400 → "This server cannot record the entity yet", 1 request (T24-038); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.2, #181) |
| `unit:change-table-csv` | Fixture C: the T24 §10.2 CSV exactly (header `at,end_at,kind,entity_id,entity,text,tags,id`; c7's text `"'=HYPERLINK(""a"")"`; c3 `3d1d4695-d757-d5f8-d6bf-c1b134128742`, `service checkout · prod-us`); facts `{'8 changes', 'Note: =HYPERLINK("a") at 12:30:00'}` (T24-037, VIZ-066, VIZ-068); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.2, #181) |
| `unit:change-scope-text` | `widgets/changeFeed/scope.test.ts`: the P_shop answer of fixture C + c10 + c11 renders c11's text and tag unchanged, its entity `service shop / payments`, and the T24 §10.2 P_shop CSV; no row, CSV entity cell or Inspector fact other than the free-text Tags names checkout@e2 (T12-018); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.2, #181) |
| `unit:board-spec-change-feed` | `boards/spec.ts` and `validate.go` on the change-feed-version fixtures (T24 §5.0; `v‹N›-change-feed.json`): `{}` → the defaults; kinds `[]` and `['release']` → `kinds.invalid`, a repeat → `kinds.duplicate`; 9 tags and `Bad` → `tags.invalid`; `entityMode:'fixed'` → `entityMode.invalid`; `orgWide:'yes'` → `board.json.type`; `fieldConfig`, `thresholds`, `depth` → `board.json.unknownKey`; TS = Go; the immediately preceding version's fixture upcasts unchanged; never auto-picked by Table 5-13 (T24-037, VIZ-057, VIZ-065); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.2, #181) |
| `unit:import-change-feed` | Annotations list cases J1–J4 of T24 §10.2: options and notes exactly as listed (T24-039, VIZ-060); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.2, #181) |
| `unit:geo-locate` | `vis/geo/locate.ts` over gazetteer T: fixtures L, C, E and G0 of T24 §10.3, each the complete `LocationResult` (`toStrictEqual`): key normalisation and collisions, the ladder without fallback, coordinates, geohash, country, region, IATA and cloud lookups, the provider hint, `ambiguous` with sorted candidates, `gazetteerUnavailable` (VIZ-045, T24-080 to T24-084); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.3, #184) |
| `unit:geo-geohash` | `decodeGeohash`: `u4pruydqqvj` and `u4pr` → the L18 and C8 centres and cells; `''`, 13 characters and `u4pa` → null (T24-083); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.3, #184) |
| `unit:geo-decode` | `decodeBasemap` and `decodeGazetteer`: the build outputs decode (RT Alpha's outer (0,0), (1000,0), (1000,1000), (0,1000)); each malformed basemap M1–M15, the ×100 L-hole CORNER, CROSS, TOUCH, COLLINEAR and NESTED assets and each malformed gazetteer G1–G8 → null (T24-087); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.3, #184) |
| `unit:geo-build` | `tools/geo/test_build.py`: the T24 §10.3 build fixtures (RT, ROT, HOLECLAMP, COLLINEAR, NESTED, POLE, ANT, SPAN, ENCLAVE, SLIVER, COLLAPSE, BIGDROP, L-holes) give the exact outputs, reports and failure messages; building twice gives identical bytes (T24-086); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.3, #184) |
| `unit:geo-gazetteer-build` | `tools/geo/test_build.py` on DBF and CSV fixtures: France + Clipperton → FR France; two ZZ features with no main → both; `-99` dropped; a repeated region → 2 rows; no name → the code; a heliport, an unscheduled airport and `ab` left out; a bad `ne_id` fails the build (T24-085); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.3, #184) |
| `unit:geo-assets` | The bundled assets decode: 238 countries, ≥ 4 300 regions, ≥ 3 200 IATA rows, aws, gcp and azure rows; `cloud_region=eu-west-1` → L1's object; Mons and Amsterdam placed; SHA-256 = the manifest (VIZ-045, VIZ-046); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.3, #184) |
| `unit:geo-load` | `loadGeoData` against a stub (ok, 404, bad JSON, invalid): 2 requests, then 0 on later calls; a failure nulls that asset only; one `console.debug` line (T24-087); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.3, #184) |
| `unit:geo-rows` | `geoRowSet` and `validateGeoRows` on fixture G with and without thresholds: the value, state, location and draw statuses (k02 combined, 1 conflict); G → null; each invalid set → its detail (`order`, `value`, `state`, `draw`, `group`, `coverage`) (T24-089); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.4, #184) |
| `unit:geo-identity` | Groups of G, H (+h9), H′, A, O, Q, D, U, one row and S: ids, injective labels (JSON quoting, the final pass), patterns, colours, legend and `other (n)` members (VIZ-067, T22-004, T24-090); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.4, #184) |
| `unit:geo-basemap-draw` | 1a's RT and ANT basemaps on a recording context: one `nonzero` path per polygon (the hole stays water), coast and border strokes once, no stroke on the artificial edges (VIZ-046, T24-091); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.4, #184) |
| `unit:geo-radius-project` | The G radii (M 300; min 2 max 4, patterned and one group) and the projection values ±1e−12 (T24-090, T24-091); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.4, #184) |
| `unit:geo-camera` | zMin, inset, fit, containment and letterboxing, persisted views, wheel anchors and drift (100 steps < 1e−9) and `tooSmall` at 159 × 200 (INT-002, T24-091); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.4, #184) |
| `unit:geo-ownership` | Camera ownership: refit on new data until a commit, kept after a commit and on a title change, moved by a new `spec.view`, not by an equal one (T24-091); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.4, #184) |
| `unit:geo-keys-engine` | Surface keys about the focus mark (`+`, `-`, `0`, Shift+→), wheel `deltaX` pans, a `null` wheel and other elements ignored (T24-091); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.4, #184) |
| `unit:geo-inertia` | A geomap fling pans with the shared T02 inertia (settles in 300 ± 50 ms, no overshoot, interrupted on the next frame by a pointer-down) and emits exactly one `geoCommit`, after it settles (INT-003, T24-091); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.4, #184) |
| `unit:geo-host` | `GeoMapFrame`: 3 subscriptions; `spec.view` from commits and `options.view` changes; an engine swap starts at the last view and gets `setFocusMark`; nothing after dispose (T24-088); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.4, #184) |
| `unit:geo-select-hover` | `ChartFrame` `select` on cluster:k03 → the `geo` cluster target and its keys selected; the k05 tooltip with `geoPlace` (INT-034, T24-088); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.4, #184) |
| `unit:geo-plan` | `planGeo` states loading, error, invalid, mapDataUnavailable (18 rows), tooSmall, empty, noneShown and ok (T24-088); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.4, #184) |
| `unit:geo-marks` | Draw ids, members, centres ±0.01 px, radii, the keyboard order and picks at fit; levels Z2–Z6, `cluster:false`, shuffled input, the tie, the crossfade and the UTF-16 order (VIZ-044, T24-091); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.4, #184) |
| `unit:geo-coverage` | The G meter with `truncated` and 2 warnings, Narrow and the popover; the 5 003-row Cap keeps min and max (VIZ-027, T22-006); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.4, #184) |
| `unit:board-spec-geomap` | The geomap board spec version ([T24](T24-geo-schematic-and-widget-panels.md) §5.0: the next free version) on `v‹N›-geomap.json` and `invalid.json`: the defaults; size, colour, groupBy and view errors; `depth` → `board.json.unknownKey`; TS = Go (VIZ-057); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.4, #184) |
| `unit:geo-list` | The hidden mark list on G and G3: names, posinset, setsize (−1 unless complete and all in view), the placeholder that stays focused (T24-093); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `unit:geo-list-keys` | Mark-list keys: arrows, Home/End, PageUp/PageDown, Enter (heading focused), the camera keys through `cameraKey`, Esc propagates to the ladder (T24-093); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `unit:geo-list-repair` | Repair (a)–(c) on `geoMarks`; focus moves only from inside the list; one removal announcement (T24-093); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `unit:geo-targets` | Marker, cluster, aggregate (`other:geo`) and group targets on G and O2; brush, empty click and table toggles (T24-092, T25-006); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `unit:geo-members` | Member sections of M12 and N with `next` buttons and parallel labels, resolved on the snapshot after a refresh; `bin` and `stateRun` keep `next` null (T25-011); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `unit:inspector-nav` | The T25 navigation stack: push and pop rules, stale and closed no-ops, reset, the Esc ladder with pop, Back and the breadcrumb (T25-007, T25 §4.8); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `unit:inspector-viewkey` | `viewKey`: one inert leaving layer (150 ms; none under reduced motion), the `h2` focus per step and the announcements; `point` targets behave as before (T25-008); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `unit:geo-announce` | N with the real host and a fake clock: the Level texts, a repeated text rewritten, only the last of a quick run at 500 ms (T25-008); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `unit:geo-nav` | N by keys through `other (12)`, e18 and n27 and back: one request, the selections, the breadcrumb, focus and close (T24-092); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `unit:geo-nav-life` | Navigation lifetime: a refresh keeps the snapshot, pivots over the origin window, every close path empties `nav`, a double push in one tick, unmount, the expanded aggregate (T25-011, T25-012); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `unit:geo-inspect` | `inspectorModel` for the four `geo` kinds (T24 §4.13); k01's chips with `f=env=prod` (T25-002, T25-009 to T25-011); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `unit:geo-single-group` | S1: no legend; Tab surface → list → meter; selection works (T24-093); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `unit:geo-table-csv` | `geoTable` and `geoCsv`: CSV G (18 rows) and CSV X byte for byte; the table unguarded, the parsed CSV guarded (VIZ-066, T24-094); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `unit:geo-facts` | `geoFacts` on G, G with k13 = 900, F1, Cap and R (T22-014, T24-094); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `unit:geo-states` | Every §4.12 state from `ok` G: status, focus targets, announcements, stale text, focus outside the panel unmoved, the selection and the Inspector kept (T24-095); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `unit:map-params` | `state/mapParams.ts`: the codec, reject and bounds blocks of T24 §10.6 exactly; read(write(x)) = x; `withArea` replaces any `geo` and null removes it (T24-096); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:board-url-store` | `state/boardUrl.ts` on BD: four writers in one tick give 4 cumulative entries with every pair; a later time write keeps them (T24-096, T24-098); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:board-url-queue` | A delayed data router: FIFO navigation, one at a time; `latest()` never regresses; a POP, a same-board link and a route change each cancel pending and in-flight writes; only a route change or unmount disposes the store (T24-096, T24 §4.18); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:url-budget` | The 4 096-byte budget: map entries evicted first, a refused map write stays local with the notice, removals always written, other writers as today, `timeInit` adds only from/to (T24-096); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:url-echo` | Memory router: the store's own echoes never move a map; tagged and untagged POPs and links apply the URL's full map state (T24-096); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:url-time-init` | An oversized link without time params: one replace adds from/to only, every map and area pair kept, the time gate opens (T24-096); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:url-atomic` | A writer's view and area are written and restored together through back, forward and reload (T24-096); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:geo-history` | One push per distinct encoded view, none below URL precision or on the first draw; `Alt+←`/`Alt+→` step the entries; nothing in an input (INT-006, T24-096); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:geo-sync` | BD: a synced pan pushes one `*` entry; followers move by `setSpec` with no commit; a `tooSmall` map builds at `*`; reduced motion cuts (VIZ-047, T24-097); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:geo-sync-save` | Saved views and sync toggles per T24 §4.17, cases (a)–(e) of T24 §10.6 (T24-097); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:geo-writers` | Writers, the effective area by provenance, cleanup on option, deletion and sync, history and the local-map notice, cases (a)–(d) of T24 §10.6 (T24-098); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:geo-area` | `vis/geo/area.ts`: the area block decisions, counts and meter text (T24-098, T22-006); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:geo-area-results` | The results block per result kind (T24 §4.15); a `mapDataUnavailable` table of kept rows; a `tooSmall` writer writes nothing (T24-098); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:geo-area-consumers` | BD at EU: writers unfiltered, consumers filtered, the log notice, the chip's remove, Clear map area with focus to the filter bar, `loading` while `geoData` is (VIZ-047); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:geo-area-scope` | A stub BFF: only returned series are kept or counted; no request carries `geo` or `map` (T12-018); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:board-spec-geomap-v8` | The map-sync board spec version (T24 §5.0; the gate keeps its `-v8` label): `sync` and `boundsFilter` defaults and type errors, `legacyAuto` only on `auto`, the upcast from the immediately preceding version marks only `auto` panels, a map-sync save to a geomap-version stub → 400 with its message; TS = Go (VIZ-057, T24-096); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:autovis-legacy` | An `auto` panel stored before the map-sync version (T24 §5.0) over A1 stays a line; the editor previews "Auto (Map)"; its save drops `legacyAuto` and gives a geomap; other saves keep it (VIZ-065, T24-099); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:autovis-logql` | A LogQL `auto` metric answer on a panel at the map-sync version or later → geomap (8); on a panel stored before the map-sync version → line until edited and saved; a log-line answer unchanged (T24-099); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:autovis-explore` | A1 on Explore → line (14) (T24-099); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:editor-preview-legacy` | The editor preview of an `auto` panel stored before the map-sync version renders a geomap and "Auto (Map)" while the board shows a line; cancel and save (T24-099); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:import-geomap` | `import/geomap.ts` on M1–M14 of T24 §10.6: options and notes exactly; every output passes `validateBoardSpec` and `validate.go` (VIZ-060, T24-099); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |
| `unit:import-geomap-fuzz` | Seed 184, 500 documents over the T24 §4.19 leaf paths: never throws, equals the committed `api/fixtures/import/geomap-fuzz.json`, every output valid in TS and Go; the non-finite numeric cases per mode (VIZ-060); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |

**BFF integration on PostgreSQL 15 and 16 (`make itest`)**

| Gate | Checks | Stage | Blocking |
|---|---|---|---|
| `itest:bff-refuses-altered-asset` | Named by [T18](T18-security.md) T18-006; runs in `ci:go-test` (no database needed): an embedded set with one byte changed in a listed file, a listed file missing, or an unlisted extra file is refused by start-up verification (`hash_mismatch`, `missing_file`, `unlisted_file` naming the path), and `serve` exits 1 with `asset integrity check failed` and never opens a listener | PR | yes |
| `itest:asset-manifest-signature` | Named by T18-006; runs in `ci:go-test`: a manifest one byte off its signed bytes, a signature by another key, a 63-byte or missing signature, a missing manifest, and no compiled-in key are refused (`bad_signature`, `missing_signature`, `missing_manifest`, `no_public_key`); of two keys, the second may sign (rotation) | PR | yes |
| `itest:rls-isolation` | For every tenant table, enumerated from `pg_class` (a table without a test fixture fails): a transaction bound to organisation A sees no row of B, as the app role and as the owner (`FORCE`); with no organisation bound every table reads empty; writing B's row from A fails with `42501`; a pooled connection carries no organisation after commit; every table except `install_state` and `goose_db_version` has `ENABLE` and `FORCE` RLS and policy `org_isolation`, and every key leads with `org_id` except the root table's (T11-002, T11-003); the audit partitions carry the same RLS, and as the app role every partition of `audit_events` refuses `SELECT` and `INSERT` with `42501` (T11-026) | PR | yes |
| `itest:no-extensions` | After a migration from empty, `pg_extension` holds only `plpgsql` (T11-001) | PR | yes |
| `itest:pulsusdb-contract` | Read-only calls against a real PulsusDB, only with `DASH_CONTRACT_PULSUSDB_URL`; the `logql` subtest (with `DASH_CONTRACT_LOGQL_SELECTOR`) checks the log window semantics, `%019d` timestamps, the group fetch and limited-response properties the pager relies on, text errors, paging equality and the request shape (#62, #65); the `logql-lexer` subtest pins PulsusDB's LogQL lexer (a `#` outside strings refused at its byte, U+FFFD accepted in `"…"` and `` `…` ``) through its own bounded transport and records the synthesised transcripts with `DASH_CONTRACT_RECORD_DIR` (#121) | on demand | no |
| `itest:promql-range` | The range route against the fake: the grid, one frame per series with its key, every transcript value bit for bit and every other grid point `null`; the upstream form (`start`, `end`, `step`, `timeout`, the query byte for byte); truncation by warning and by flag; keys in any order (PRF-031, T06-011, T04-004, T04-005, T07-002) | PR | yes |
| `itest:promql-errors` | Parse errors with and without a position, timeout, hang with `timeout_ms: 300`, too broad, `timeout_ms` out of range and a reserved name without an upstream request, an unreachable PulsusDB (502) while `/readyz` stays 200 (T06-026, T06-009, T09-009) | PR | yes |
| `itest:plan-authority` | The PromQL routes (#112, T06-029, ENT-006) and the LogQL range and volume routes (#116): every upstream `query` equals the `planned.query` of the response it served; a request whose `query` is already the planned text of another request still goes through `Plan` (a volume `planned.query` sent back is wrapped again); Classify and the byte guard refuse a reserved name a variable introduces, or an unparsable one, before any upstream request; the PromQL value cases of `promql.json` are sent as planned, or refused with `variable.unrepresentable` and no upstream request (#118) | PR | yes |
| `itest:logql-planned` | The LogQL routes plan the raw text with `vars` (#116): the upstream `query` is the planned text, the bodies carry `planned` after `kind` (range) and first (volume), refusals before planning carry none, an upstream error carries the plan; every value case of the fixture (quoted, backtick, comment and top-level values) is sent as planned or refused with `variable.unrepresentable` and no upstream request | PR | yes |
| `itest:logql-virtual-refused` | Every `classify` entry of `logql.json` that is `virtual` or `mixed`, on both LogQL routes, is 400 `virtual_unsupported` with `hint.reserved` `source="pulsus-dash"`, no `planned` and no upstream request (a counting fake that a request past the refusals would reach); the label-filter and backtick cases through the byte guard (the two `#` entries are refused first as `query.invalid`, #121); the near misses reach PulsusDB; refused before tenant resolution; a macro that makes the planned text reserved is refused at the final check with `planned` (#116, T07-020) | PR | yes |
| `itest:logql-hash-refused` | A `#` outside strings, raw or from a value, is refused with its mapped position on the range and volume routes before any upstream request, a spaced or escaped reserved selector after it included (#121, T07-020, T06-029) | PR | yes |
| `itest:logql-lexer` | A value with U+FFFD is sent as itself in `"…"` and `` `…` ``; a `#` is refused with no upstream request (#121) | PR | yes |
| `unit:lexer-record` | The probe recorder writes only synthesised, validated transcripts, refuses any secret in any encoding, and writes all files or none (#121) | PR | yes |
| `itest:logql-plan-sizes` | 131 072 raw bytes on the LogQL routes, 65 536 planned bytes with the volume template counted, and the 2 MiB processing cap, each refused before any upstream request (#116, T09-015) | PR | yes |
| `itest:logql-error-position` | PulsusDB's `at byte N` on the LogQL routes maps to the raw text and the message follows; an offset inside a substituted value is the start of its reference; none inside the volume prefix or suffix (#116, T09-009, ADR-0021 §3) | PR | yes |
| `itest:cancel` | A browser abort before headers reaches PulsusDB within 50 ms (T04 §7, T04-013; measured from the cancel in the test to the in-process fake's `CancelledAt`); the access log records `499` (PRF-030, T06-010) | PR | yes |
| `itest:cancel-mid-stream` | A browser abort after the first frame reaches PulsusDB within 100 ms, frees the tenant slot and logs no stream abort (PRF-030, T06-010) | PR | yes |
| `itest:logql-streams` | The LogQL range route against the fake in both directions (#65, acceptance 1 as amended by owner decision Q5): pages of complete timestamp groups (the upstream's partial edge group is not delivered), a group larger than the page sub-paged by the cursor, the request form of every upstream request (`start`, `end`, `step`, `limit`, `direction`, `timeout`, the query byte for byte, `X-Scope-OrgID`), the concatenated pages equal the window's six entries in direction order, levels from structured metadata and parsed fields (T06-011, T06-006, T07-002, T04-004) | PR | yes |
| `itest:logql-metric` | A LogQL metric query on the range route: `kind: series`, one frame per series with its key on the 721-point grid, every other point `null`, no cursor (#65, acceptance 2; T06-011, T04-005) | PR | yes |
| `itest:logql-volume` | The volume route: five level frames labelled exactly `{level}` with the summed values, the composed query byte for byte and `step=5000ms` (#65, acceptance 3) | PR | yes |
| `itest:logql-errors` | Text errors with and without a position (also mapped back on volume), too broad, PulsusDB's 5-year window error, timeout, hang with `timeout_ms: 300`; `timeout_ms`, `limit`, `to`, cursor and reserved-selector refusals and a series call without `match` with no upstream request; an unreachable PulsusDB (502) while `/readyz` stays 200 (#65, acceptance 4; PRF-031, T06-009, T06-010, T07-020, T09-009, T06-026) | PR | yes |
| `itest:logql-cancel` | A browser abort reaches PulsusDB within 50 ms on the first request of a page and on its group fetch, measured as `itest:cancel`; no further request starts; the access log records `499` (#65; PRF-030, T04-013, T06-010) | PR | yes |
| `itest:tenant-header` | `X-Scope-OrgID`, `X-Pulsus-Database` and Basic credentials come only from the resolved binding; a binding without them sends none; a browser header is never forwarded; an unknown tenant is 404 (T06-006, T06-002) | PR | yes |
| `itest:datasource-check` | The check answers `ok` against the fake and `unreachable` against a closed port; `/readyz` stays 200 (T06-025, T06-026) | PR | yes |
| `itest:migrations` | Up from empty, then an idempotent rerun; a dry run writes nothing; two concurrent `migrate` runs apply and seed once; a database more than one version ahead is refused (also when another run advanced it while this one waited for the lock) and one version ahead is accepted by `migrate` and `serve`; `serve` refuses an older schema (T11-015, T19-007) | PR | yes |
| `itest:board-crud` | Through `serve` (plan #61): create, read, save, unchanged save (no version, no audit event, ETag kept), stale `If-Match` → 409 with the current board and the submitted spec, missing `If-Match` → 428, list, soft delete; counts of versions and audit events after each step; every audit row names the fixed local principal, the board and the request ID; an invalid board writes nothing; two concurrent saves with one `If-Match` give one version and one 409 (T11-005, T11-006) | PR | yes |
| `itest:board-prefs` | Through `serve`: starring is idempotent, unstarring empties the list, an unknown board is 404; recent boards are most recent first, honour `limit`, and drop deleted boards; starred boards drop deleted boards; 200 recent views are kept per user; amended by #181: 201 starred → `truncated` true, 200 → false, 51 views with limit 50 → true (T24-021) | PR | yes |
| `itest:board-find` | Fixture S: `q` checkout → the 2 org-A rows, updated desc; zürich → Zürich edge, ZÜRICH → ZÜRICH core (ASCII-only folding); payments → payments; `%` → none; bulk → the 1 000 newest in `created_at DESC, uid` order, truncated, the 2 oldest absent; finance and FINANCE → Ledger (an exact tag through `q`), fin → none (tags match whole); `tag=team:payments` → Ledger, Checkout overview; `q=checkout&tag=team:payments` → Checkout overview and `q=ledger&tag=payments` → none (`q` AND `tag`); a 101-character `q` and `Bad Tag` → `boards.q.invalid`, `boards.tag.invalid`; org B sees only its own board (T24-021, tenancy; [T24](T24-geo-schematic-and-widget-panels.md) §10.1, #181) | PR | yes |
| `itest:board-tags` | Saves with tags `[a,b]`, none, then v1's spec again → `[a,b]`, `[]`, `[a,b]`; org B's save of org A's uid → 404; org B's repair touches 0 org-A rows; `tag=a` in org B → none (T24-029, tenancy; #181) | PR | yes |
| `itest:board-list-snapshot` | Two connections with barriers and a labelled fault injection that makes a row stale: a row locked during the repair is absent from `tag=a` and counted in `tagsStale`, then present with 0; a schema-3 head move between repair and read is counted (never `100 %`); no match → the sentinel only (`[]`, stale 1); a locked stale row is returned with `tags: null` in unfiltered and `q` lists; a repair error or timeout → 200, stale counted, a log without titles; a cancel during the repair rolls both back; one SELECT per list (T24-029; #181) | PR | yes |
| `itest:board-spec-old-binary` | `make itest-old-binary` (local; builds the merge-base binary): the previous release beside N on one database, for every board spec version change (skips when the version is unchanged; the gate fails unless it passes when the previous release's version is older). N creates W from the newest version's fixture, whose first panel is of the newest kind (v6: `v6-board-list.json`, a board list), and reads it canonical at N's version; the previous release's `GET` and `PUT` of W → 503 with nothing written, its list still shows W; its create of W's spec → 400 with the newest version's refusal first (v6 against v5: `board.vis.kind.invalid` at `/panels/0/vis/kind`; v5 against v4 was `board.json.required` at `/panels/0/query`); it creates V from its own fixture and its save of W's spec over V → 400 with the same refusal, V unchanged; N reads V canonical and saves it with a panel of the newest kind (v6: a board list); the previous release's `GET` of V → 503; it then passes `itest:board-crud` (T11-015, T11-016; #198 Part 1, #216 Part 1) | PR | yes |
| `itest:board-zones-grandfathered` | A head seeded at schema 5 with a clock zone the build does not know: `GET` 200; a title-only save and a save moving that zone to a new clock → 200; a save adding another unknown zone → 400 at its `/tz`, head and versions unchanged; a create of the spec → 400 (T24-003, T11-016; #198 Part 1) | PR | yes |
| `itest:board-tags-old-binary` | `make itest-old-binary` (local; builds the merge-base binary, never skips there for a missing binary; skips unless the previous release predates the tags version, board spec 4: run it with `OLD_BINARY_REF` at such a release): 10 000 boards in 2 orgs at schema 3 with a looping reader; migration 4 rewrites nothing (`relfilenode`) and the reader waits ≤ 1 s; 17 tags fail; the base-commit binary starts at schema 4 and passes `itest:board-crud`; its head moves count as stale (`tagsStale` 2) until repaired; its save of a head N saved → `ErrSchemaTooNew`, nothing written; the next list repairs them (T11-012, T11-013, T11-015; #181) | PR | yes |
| `itest:board-tags-validate` | I4: schema 4 with every row ≤ 16 tags; the I4 migration sets `pg_constraint.convalidated`, and an UPDATE to 17 tags fails (T11-013; #181) | PR | yes |
| `itest:annotations-entity` | Fixture C in org A, org B with a checkout@e1 change: checkout@e1 → c1, `orgWideHidden` 3; checkout@e2 → c3; + payments@e1 → c6, c2, c1; checkout@e1 + `orgWide` → c7, c4, c1, c9; deploy + config → c6, c2, c1, c5, c9; `pr:4411` → c2; payments + `flag` → `[]`; org B sees none of org A; bad parameters → the T24 §5.9 400s (T24-030, T24-031; [T24](T24-geo-schematic-and-widget-panels.md) §10.2, #181) | PR | yes |
| `itest:annotations-scope` | C + c10 + c11: full → 10 rows; P_eu in pages of 3 → `[c11, c6, c2]`, `[c1, c5]`; P_shop → c11, c6, c2 with c11's text and tag unchanged and its entity `service shop / payments`; P_shop with checkout@e1 → `[]`, `"orgWideHidden": null`; c10 and checkout@e2 in no structured field, page, cursor, count, CSV entity cell or Inspector fact; unset → 403; P_shop creates checkout@e1 → 403 `annotations.entity.scope`, no entity → 403 `annotations.scope`, payments@e1 → 201 (T12-018; #181) | PR | yes |
| `itest:annotations-scope-compile` | The environment via either attribute or both → `f8bdae9d-e739-228c-dd0e-317933242944`, attrs `{deployment.environment.name: prod}`; a conflict → 400; scopes S1–S6 and T1–T3 of T24 §10.2 cover exactly the listed entities on create, list, markers, delete and CSV (S6 `{b: []}` → 403 `scope_denied`, no SQL); the SQL predicate = `ScopeCovers`; `entity` and `entity_key` set or NULL together (T12-010, T12-018; #181) | PR | yes |
| `itest:annotations-delete-scope` | P_shop deletes c1 (out of scope), an absent id and c2: identical 404s for the first two, c1 kept, no audit; c2 → 204 and one audit event; an unset scope → 403, no SQL (T12-018; #181) | PR | yes |
| `itest:annotations-keyset` | `limit=3`: (a) n1 (12:45) and n2 (12:05) inserted after page 1 → c7, c4, c3 / c6, c2, c1 / n2, c5, c9, n1 absent, no id twice; (b) c5 deleted before page 3 → page 3 is c9; (c) `limit=500` → one page of 8; one SELECT per page (T24-032; #181) | PR | yes |
| `itest:annotations-old-binary` | `make itest-old-binary` (local; it skips once the previous release has migration 5): the previous release's binary (schema 4) beside N on schema 5, migration 5 applied beside a reader (wait ≤ 1 s, same `relfilenode`): it starts, answers without `applied`, rejects a create with `entity` (400 `annotation.unknown`) and lists N's entity rows; N reads its rows with `entity: null` (T24-038, T11-012, T11-013, T11-015; #181, #222) | PR | yes |
| `itest:annotations-entity-validate` | I7: schema 5 with every row's `entity` and `entity_key` paired; the I7 migration sets `pg_constraint.convalidated`, and an INSERT with only one of them fails (T11-013; #181) | PR | yes |
| `itest:audit-append-only` | Board subset (plan #61), as the app role, each in its own transaction: `UPDATE`, `DELETE` and `TRUNCATE` of `audit_events`, `UPDATE` and `DELETE` of `board_versions`, `DELETE` of `boards` and of `audit_chain_heads` fail with `42501`; the hash chain verifies event by event and continues across the retention floor through `audit_chain_heads` (T11-017, T11-006, T06-004) | PR | yes |

**Goldens (L2)**

| Gate | Checks |
|---|---|
| `golden:gallery` | Every gallery page × variants (§4.2), ꟻLIP rules; two seeded runs identical. From #68 it includes the engine line pages (line-1, line-50, line-gaps, line-600 × dark, light; line-50 dark at DPR 2 and with a manual value range) on lavapipe, T1 and T2 byte-equal. From #184 E2 it adds `geomap-markers` (fixture G), `geomap-groups` (H) and `geomap-states` (G with thresholds) × the 3 themes ([T24](T24-geo-schematic-and-widget-panels.md) §10.4) |
| `golden:interim-gallery` | Until #68: the sixteen interim Canvas 2D gallery charts (with `line-thresholds` and `stat-sparkline`, #64 Part B, `line-extreme`, #97, `line-events`, #64 Part C, and `barchart`, `barchart-thresholds`, `barchart-dupes`, `barchart-subset` and `barchart-cap`, #173 Part 2) × dark and light in the pinned Playwright Chromium against committed baselines (per-pixel threshold 0.1, ≤ 0.2 % differing pixels); two seeded runs identical; baselines generated with `PW_UPDATE_GOLDENS=1` in a container built from the CI image definition (pinned browsers), reviewed and committed (no hosted CI, owner decision 2026-11-25) |
| `golden:decimation-raw` | From #68: decimated vs every-raw-point render through the same pipeline, zero differing covered pixels (PR fixtures; nightly 10⁸ points) — the VIZ-006 gate |
| `golden:decimation-ref` | From #68: the decimated render against the independent f64 reference of the ADR-0014 §4 model (A ⊆ B, B ⊆ R⁺, gap bands, interpolation, far crossing, in-range segment); PR 10⁴ points per series, nightly 10⁸ |
| `golden:extreme-range` | From #68: data scaled to [−MAX, MAX] and [MAX/2, MAX] draws finite geometry, equal on both tiers, every sample's pixel covered |
| `golden:greyscale` | State glyphs and axis-ownership glyphs distinguishable in greyscale. Interim (#173 Part 2): the five gallery bar charts in dark with the canvas in `grayscale(1)` against `gallery-<id>-greyscale.png`, the bars told apart by their visible names (VIZ-067) |
| `golden:inf-shape-grammar-greyscale` | Every class family's 3D shape and 2D glyph distinguishable by silhouette in greyscale ([INF-002](../product/16-infrastructure-model.md#inf-002--one-shape-grammar-per-class-family)) |
| `golden:flame3d` | Engine fixtures `flame3d-1e5` and `flame3d-diff` pass with T1 = T2; glow at r 0.4 vs 0.8 in the ratio 1 : 2 ± 10 %, none without a baseline (VIZ-105, VIZ-086, VL-004); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `golden:flame-greyscale` | Diff frames in greyscale, 2D and 3D, at 6, 20 and 200 px: each class identified by its cue alone (top bar, bottom bar, top bar + hatch, dashed + hatch); the total-only and self-only frames show only their own bar; a dense run of class-bearing frames is one merged mark with per-class counts; none narrower than 4 px (2D) or 6 px (3D) drawn alone (VIZ-067, T23-025, T23-004); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `golden:widget-gallery` | 5 widget gallery pages × dark, light and greyscale, fixed clock: baseline (0.1, ≤ 0.2 %) (VIZ-069, VIZ-067); #198 Part 3b lands `widget-text` and `widget-text-removals` (`dev/widgets?page=`; greyscale is CSSOM `grayscale(1)` on dark; a reload gives the same pixels; baselines generated in the pinned e2e container), the Clock pages follow with A2; PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153); #181 adds `widget-board-list` (fixture B), `widget-board-list-search` (fixture S) and `widget-board-list-states` (loading, stale, unknown, empty), and step 2 `widget-change-feed` (fixture C), `widget-change-feed-entity`, `widget-change-feed-states` (loading, empty, more, capped, paged, stale, old server) and `widget-change-feed-inspector` |
| `golden:tier-parity` | WebGPU vs WebGL2 readback per spec (nightly) |
| `golden:native-browser` | Chrome T1 readback vs native render, 100 specs incl. field configuration (nightly) |

**Browser end-to-end (L4)**

| Gate | Checks |
|---|---|
| `e2e:shim-fuzz` | From #68, on engine canvases: 10⁴ random DOM events decoded identically by the engine, in order, loss only as counted overflow. #68 Part C2a1 (until #94 writes raw input records): the adapter's records decoded identically, in the probe build (`make e2e-build-probe`, project `probe` on lavapipe; the probe engine logs what it decodes): two probe frames with `line-50` data take 10⁴ seeded ops (resize, time window, spec; batches of 1–2 000, the first before the frames are created); the worker's log equals the adapter's (length, order, fields), records coalesced, `overflow` 0, both frames settled with the last window and the last size drawn; a rollover case (the counters from 0xFFFF_F000 cross 2³², the head advanced by exactly the bytes published) and a wake case (one record wakes an idle worker, settled within 1 s). #68 Part C2a2: the 10⁴-op run adds DOM events at random (seed 68) on both frames' canvases (wheels with deltaX/Y ±600, modes 0–2 and Shift/Ctrl/Meta; pointer down, move, up and cancel with buttons 0–2; double clicks) through the main-thread camera controller ([ADR-0030](../adr/0030-engine-camera-controller-on-main.md)); the gestures end before the final ops, and each frame's last summary shows its last published Camera's view |
| `e2e:engine-camera` | From #68 Part C2a2 ([ADR-0030](../adr/0030-engine-camera-controller-on-main.md)), the fault build with `?probe=1`, project `lavapipe` (gated) and `swiftshader` (report-only with the WebGPU leg): #93's camera cases on engine frames, each step settled (< 250 ms inside a gesture): E1 100 seeded wheel steps keep the plot and the anchor (< 0.01 px; INT-002, T02-021); E2 a sub-minimum preview survives a wider external window (#68 Part A C3); E3–E6 non-fitting and wider labels during a Y zoom and after a refetch keep the plot until a layout transition releases the band, then the plot x is a fresh frame's (Part A C4, T02-011), the leftmost ink column of the first preview, last preview and final frames at the plot's x ± 1 device px; E7 axis drags and double clicks (INT-008); E8 a wheel and a drag on the gallery's `line-50` change the URL (INT-007) |
| `e2e:mode-matrix` | From #68 Part C1, on the gallery in the engine web image (`make engine-e2e`, `playwright.engine.config.ts`): `default` (Canvas 2D, no engine request), `webgl2` (`?engine=wasm&mode=t2`: status 2, llvmpipe, `wasm-webgl2`), `webgpu` (status 1, `wasm-webgpu`, every line frame `drawn`; report-only, below), `no-offscreen` and `static` (Canvas 2D, no engine request), `integrity` (a flipped wasm byte refused twice, then Canvas 2D with `engine_integrity_failed`). ST and MT-R are Canvas 2D until `dash-core-st` |
| `golden:engine-line` | From #68 Part C1: the browser engine against the native renderer. Each of line-1, line-50, line-gaps, line-600 and line-extreme in dark and light, and line-50 dark at DPR 2: the engine's canvas (WebGL2 on lavapipe through ANGLE, `&engine=wasm&mode=t2`, status 2, llvmpipe, `wasm-webgl2`) vs `dash-golden render` of the same page, theme, CSS size and DPR (T2); both images `round(css × dpr)`; mean ꟻLIP ≤ 0.001 and no 8 × 8 tile mean above 0.05 (`dash-golden compare --tile-max`). A 1 % shifted window and the `gap` fault must fail. WGSL pixel parity of the passes stays with the native `golden:gallery` |
| `canvas2d parity` | From #68 Part C1, sampled geometric parity with the interim Canvas 2D engine (anti-aliasing differs between the two renderers by design, so pixel identity is gated against the native renderer only): for the five line pages in both themes, the engine's `data-plot` equals Canvas 2D's, and on 32 points of Canvas 2D's line mask (its frame with and without data, ≥ 64 in a channel) at least 28 differ by ≥ 64 in the engine within ±1 device px, with at most 8 of 32 background points (≥ 4 px from the mask) touched; the `noline` fault must fail |
| `e2e:engine-recovery` | From #68 Part C1, on the fault build: `surface` (that frame alone moves to Canvas 2D on a fresh canvas with the notice, the retired canvas `display: none`, the fallback within mean ꟻLIP 0.005 of plain Canvas 2D), `trap` (one restart on the same tier, notice), `trap2` (every engine frame on Canvas 2D, the session flag set, also after a reload) |
| WebGPU in CI | The engine image's Chromium offers WebGPU only on Dawn's SwiftShader adapter, which cannot render there; its project (`swiftshader`) runs every engine gate above report-only, with the reason in `client/e2e/engine-legs.json` printed at the head of the run. WebGPU on a real GPU: the hardware runner (follow-up) |
| `e2e:lazy-load` | Cold load that opens no workbench fetches no workbench chunk; with no chart frame on screen it fetches no engine; and opening Boards fetches no `editor-*` chunk; opening Explore › Metrics or Explore › Logs fetches each once (#63, #66 Part C) |
| `e2e:no-dom-vis` | With the engine active, every non-DOM vis is drawn by the engine into its viewport canvas: no chart SVG and no interim Canvas 2D frames; one GPU device for the page |
| `e2e:csp-violations` | The production build served with the [ADR-0014](../adr/0014-typescript-react-web-client.md) §9 headers ([ADR-0026](../adr/0026-engine-csp-and-worker-policy.md) from #68) reports no CSP or Trusted Types violation during the PR smoke suite; its engine leg (#68 Part C1) runs the gallery, a board and a frame recovery with the engine, cross-origin isolated |
| `e2e:explore-completion` | Against `pulsus-fake` through the `http` BFF: typing a metric prefix in Explore offers the metric with its metadata type; Enter accepts it (SRF-027) |
| `e2e:metrics-autovis` | Against `pulsus-fake`: a bare counter runs as `rate(…[1m])` at step 5 s, drawn as a line with the "Rate applied" chip, and the chip off runs the raw counter; the histogram transcript draws a heatmap; the scalar transcript a stat (SRF-030, VIZ-065) |
| `e2e:editor-error-on-run` | Against `pulsus-fake`: the SRF-027 query underlines PulsusDB's reported position and shows its message; an error without a position underlines the whole query with "position unknown"; the previous result stays drawn (SRF-027, T09-009) |
| `e2e:series-table` | Sorting the Explore series table by max puts the largest series first; choosing it isolates it; choosing it again restores all (SRF-031) |
| `e2e:explore-cancel` | Two time changes within 200 ms leave exactly one completed request and one cancelled request at `pulsus-fake`, and the last window drawn (PRF-030) |
| `e2e:explore-truncation` | A truncated result shows the partial-data badge with its text and Narrow, which re-issues the middle half; a `422` shows PulsusDB's message with Narrow (PRF-031) |
| `e2e:explore-refresh` | The header Refresh now reruns the Explore query (IA-020) |
| `e2e:editor-ime` | Chromium, CDP composition in the editor: no completion popup during the composition, one after it commits (T09-005) |
| `e2e:board-promql-panels` | Create a board with counter, histogram and gauge PromQL panels against the fake: rate line, heatmap and line; an override to Stat survives save and reload |
| `e2e:board-visible-only` | A 30-panel board with 6 on screen issues exactly 6 range queries on open; scrolling issues queries for newly visible panels only, and none on scrolling back |
| `e2e:board-cancel` | Two window changes while board panels load: every superseded request cancelled, one completed request per panel for the last window |
| `e2e:board-open-in-explore` | A panel's Open in Explore carries its query and the board's time; `$__interval` and `$__rate_interval` keep the panel's values at a 5 m step |
| `e2e:board-refresh` | Under an absolute window, Refresh now reruns every visible panel |
| `e2e:board-states` | Partial-data badge with Narrow, a too-broad error with Narrow, a parse error with line and column, and the empty panel, on a board |
| `e2e:board-thresholds-legend` | Against the BFF and the fake: a line panel's legend table shows mean, max and last with threshold states; a row isolates its series; a 4-row panel's compact legend is reachable by keyboard and opens the full table; Legend Hidden and a threshold edit survive save and reload; an unparsable value blocks the save |
| `e2e:board-stat-tile` | Against the BFF and the fake: a stat panel with thresholds shows the state chip and the threshold text; a range stat draws a sparkline (canvas pixels in its band) and a scalar stat draws none |
| `e2e:board-event-markers` | Against the BFF, Postgres and the fake (#64 Part C): annotations posted through the API show on a line panel as focusable markers with their kind, title and time, evenly spaced, none outside the window and none on a stat tile; a window change and Refresh now after a delete update them; the first marker is reached by keyboard and shows its tooltip |
| `e2e:board-logql-save` | Against the BFF and the fake (#67): a board with a PromQL, a LogQL stream and a LogQL Bars panel typed into the panel editor shows a line, six log lines and the volume stacked by level; the saved vis kinds and the views survive save and reload (SRF-033, SRF-036, VIZ-065) |
| `e2e:board-logql-brush` | Against the BFF and the fake (#67): a brush 12:20–12:25 on a board's volume panel sets the board window, and one PromQL range, one stream page, one kind probe and one volume request run for it; the stream lists that window's lines (SRF-033, T03-016) |
| `e2e:board-logql-paging` | Against the BFF and the fake (#67): a stream panel sends one page and no more until scrolled; scrolling to **End of results** sends one more page with its cursor; the last row is the 1 500th (SRF-036, PRF-030) |
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
| `e2e:ticks-parity` | From #97, #126: `valueTicks` equals `ticks.json` and `ticks-extreme.json` exactly in Chromium, Firefox and WebKit, with path parity on every row (each row records `path: 'nice' \| 'fallback'`); the page also equals `pow.json` |
| `unit:js-pow` | From #126: the interim `pow10`/`powBase` equal `pow.json` on all 855 rows and `**` at the edges; `valueTicks.ts` contains no `**` |
| `e2e:gallery-extreme` | From #97: `line-extreme` ([−MAX, MAX]) draws and the main thread stays responsive |
| `e2e:chart-hover` | Interim charts: the tooltip shows the time, every series' name and value at the snapped sample in value order; for more than 20 series, sweeping the pointer down the plot shows every series (INT-033 subset) |
| `e2e:time-range-header` | Header picker offers the relative ranges of IA-020 and absolute ranges with the time zone; choosing a range re-queries visible charts and updates the URL; a brush on any time chart sets the picker to that absolute range; a 30 s auto-refresh re-queries every 30 s and "Off" stops it (IA-020, INT-025) |
| `e2e:a11y-rooms` | axe-core WCAG 2.2 AA checks on every room; keyboard-only traversal reaches and operates every control. Board log panels (#67): axe and 24 × 24 px targets with a stream panel's lines, with its editor open on Bars (not in Firefox, whose page crashes inside axe with that editor open) and with the panel saved to Bars in Edit mode; the keyboard reaches the order options, Wrap lines and the `Log lines` region of every stream panel on a board, at full screen, in the editor's preview and on a copy (T08-007, T08-010). Inspector (#164, [T25](T25-inspector-and-pivots.md)): open and collapsed, in dark, light and forced colours, axe 0 and targets ≥ 24 px |
| `e2e:focus-regions` | `F6`/`Shift+F6` cycle sidebar → page header → page content → open panels (→ Time Ribbon in Space scenes) and back; focus never trapped (INT-015) |
| `e2e:chrome-layout` | Space scenes, from M-UI3: at 1440×900 the Time Ribbon is 40 px and translucent (canvas visible beneath), the minimap is present in scenes with a camera extent, and no persistent chrome other than IA-016's is shown (IA-028, VL-017) |
| `e2e:deep-link` | Every URL pattern opened in a fresh session reproduces Context, scene, focus and camera; browser back steps camera history; saved Context and vis overrides restored |
| `e2e:table-csv` | `Shift+T` shows the viewport's data as a table; "Export CSV" downloads the same rows |
| `e2e:text-dom-match` | Same string, same size: canvas vs DOM advance width and baseline differ by ≤ 1 px |
| `e2e:font-origin` | Every font request is same-origin; UI strings in Inter, data in JetBrains Mono |
| `e2e:gallery-offline` | Every gallery page renders at target volume with no PulsusDB reachable |
| `e2e:no-pulsusdb-write` | Nightly storyboard run behind a recording proxy: no write to PulsusDB except self-telemetry and audit export |
| `e2e:flame-two-actions` | One click on suspect ① (or `Tab`) opens the Inspector on the max cur.self frame within 250 ms + 1 frame, in 2D and 3D, also on a diff answer (VIZ-106); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame-escape` | Each `Esc` takes the next T23-011 step; `Shift+F` returns to the overview in ≤ 250 ms; `Alt+←` restores the prior pose (INT-016); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame-merge-pick` | A click inside a merged run of 0.25 px leaves selects the leaf whose span covers the pointer and flies to it, in 2D and in 3D at the same world X (T23-004, T23-007, T23-010); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame-search-levels` | Overlapping matches on different rows: a click selects the match on the row (2D) or box (3D, front preset and orbited 45°) under the pointer (T23-017); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame-2d` | Search `json::` draws matches at true spans and filters the table, `n` shows "match 2 of N"; a click on `checkout::handle` zooms to [0, 560]‰ in ≤ 250 ms (reduced motion: next frame) (VIZ-036); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame-types` | The type switcher lists the fake's types in order, a choice reruns with that prefix, an empty list disables it with a notice (SRF-046); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame-states` | Shimmer at 300 ms; error view + Retry, or the frame kept with the stale banner; "Narrow" on 429; "could not be read" on a malformed answer; the older request aborted and its late answer ignored; one request per Retry (T23-022); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame-baseline` | A window within limits → one diff request; 8 d back → one merge and "baseline unavailable"; `leftQuery` → a diff of the left selector (T23-023); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame-baseline-range` | A custom non-adjacent baseline range is sent as `left` with diff colours and survives reload and URL copy; offset −1 d moves `left` by one day (SRF-046, T23-023); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame-identity` | The selection is kept by name path across a refresh that reorders siblings and a switch to diff; an answer with a duplicate sibling → DecodeError per T23-022, frame kept stale, selection unchanged (T23-002); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame-a11y` | `Shift+T` table = CSV = data; the T23-018 summary; axe clean; greyscale (VIZ-066, VIZ-067); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame-diff-nobaseline` | A saved `mode:'diff'` panel 8 d back: one merge, the banner, sequential colours, Diff "unavailable", board JSON unchanged; with the window at now − 1 h, one diff request and diverging colours (T23-023); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame-diff-none` | Compare to → None in diff saves without a validation error; reopened: one merge, `mode:'diff'` kept, the "baseline unavailable" banner (T23-023); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame-mode-switch` | Payload V: a selection not shown in single moves to its nearest shown ancestor; p fills 90 % of the row in single and 50 % in diff (T23-013); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame-diff-fly` | Clicks in the union layout fly to the frame's [x, x+width] ([0, 0.5], [0.85, 1.0], [0.5, 1.0] ± 1e-9); in single, p → [0, 180] ticks (T23-010, T23-013); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame3d-nav` | `flame3d-1e5`: morph ≤ 250 ms; the subtree framed at 80 ± 2 %; input stops a flight; pitch 10–89°; dolly drift < 1 px (VIZ-105); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame3d-controls` | No log on the X axis; log Y per T23-008; per-plane auto/show/hide while orbiting, `planes` kept over reload and URL; presets by keyboard via `F6`; orthographic; Dock 2D mirrors hover, selection and brush (VIZ-077, VIZ-078); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:flame3d-modes` | 3D diff draws a removed path as a blue slab with its wireframe; 3D sandwich puts callers at Z < 0 (VIZ-105); PR, blocking ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §10, #152) |
| `e2e:widget-text` | Text `# R`, a link and `Env $env`: `h4`, a `_blank` link; env=dev → "Env dev"; no query sent; the region named by the title; a Text added by Add widget survives Save and a reload (VIZ-053); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153, #198 Part 3b) |
| `e2e:widget-text-xss` | The `unit:markdown-nodes` input plus an iframe line: `window.__xss` unset, no finding, no `iframe`; removals `[html, html, iframe]`. The whole XSS corpus in the browser (#198 Part 3b): one case per fresh context on its own board under the production CSP and Trusted Types, every request judged against the committed per-browser load baseline and the case's generated image list, the exact CSP header and a consumed Trusted Types canary; canaries c1–c12 prove each class of miss (VIZ-054, VIZ-056, T18-013); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153, #198) |
| `e2e:widget-clock` | `page.clock` 12:34:56Z, Tokyo and New York, countdown to 12:35:56Z: `in 1 min` silent; +1 s `in 59 s`; +59 s `since 21:35 (0 s)` announced; no transition under reduced motion (T24-012, VL-016); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `e2e:widget-a11y` | Text and Clock, view and edit: axe clean; the T24-017 order (Text from #198 Part 3b: panel menu → region → links; the preview's region and "Preview unavailable" status); the zone label "Tokyo, 21:34, Thu 26 Nov, night, UTC+09:00" (T24-017, VIZ-066, VIZ-068); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10, #153) |
| `e2e:widget-board-list` | Stub BFF, fixture B and a search over S: 10 rows + Show more; "check" → one request 250 ms after the last key, 2 rows, "2 boards" announced once; hrefs carry `from` and `to`; ⌘-click opens a new tab (VIZ-053, T24-021 to T24-023); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.1, #181) |
| `e2e:widget-lists-a11y` | Board lists in the loading (held 2 s), empty, error 500, stale, unknown, ok and `bulk` states, view and edit, and reduced motion: axe clean in each; focus to the empty `<p>` or Retry; `Payments, this board`; the T24-025 order; setsize 12 or −1 (`bulk`, unknown); no transition when reduced (T24-025, T24-027, VL-016); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.1, #181); step 2 adds Change feeds in the loading, empty, more, capped, paged, stale and old-server states: axe clean, setsize per T24-036 (([T24](T24-geo-schematic-and-widget-panels.md) §10.2, #181)) |
| `e2e:widget-change-feed` | Stub BFF, fixture C in pages of 3, a line panel, `?e=bb7487bd-100d-a998-e0f0-3c65f11da1a7`: 1 row + "3 organisation-wide changes not shown"; the toggle → 4 rows; without `e`: Load older ×2 → 8 rows, the paged text, setsize −1; Enter on c4 → the Inspector `Note` and the band on the line panel; Esc ×2; Refresh → 1 request (VIZ-053, T24-030 to T24-036); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.2, #181) |
| `e2e:geomap-offline` | No rows at (53.34, −6.25, 6), 1024 × 512, dark, every other origin aborted: `getImageData` reads `map-land` and `map-water` (±2 per channel); 0 requests to another origin (VIZ-046); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.4, #184) |
| `e2e:geomap-a11y` | A stub BFF with G in states (a)–(h) and reduced motion: axe clean, the Tab order, the keys, no transitions (VIZ-068, VL-016); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `e2e:geomap` | G: a click on cluster:k03 opens `Cluster of 5`; Esc ×2 clears, then closes; Shift+T shows 18 rows; the CSV equals CSV G (VIZ-066, INT-034); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.5, #184) |
| `e2e:geomap-sync` | Chromium, a stub BFF and BD: a drag on P1 moves P2; EU filters L to 5 series; three moves, then real `Alt+ArrowLeft` ×3 and `Alt+ArrowRight` ×3 give the expected URL and camera after each press with the history index ±1 exactly; reload restores the views and the area; axe clean (VIZ-047, INT-006); PR, blocking ([T24](T24-geo-schematic-and-widget-panels.md) §10.6, #184) |

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
`bench:decode-r1`, `bench:shim-input-cost`, `bench:editor-keystroke` (Chromium, stub BFF: 100 keys typed at the end of a 1 KB PromQL query; the editor's update time per key (each CodeMirror transaction's state and view update, highlighting and DOM sync included, timed in the page) minus the idle overhead, p95 ≤ 2 ms (T09-003); a trace of the measured keys, read by the `bench:rooms-long-tasks` parser, with no main-thread task over 50 ms wall and 16 ms thread time, blocking in CI's `e2e` Chromium leg now (PRF-005, §4.3 interim); p95 ≤ 2 ms and no task over 16 ms wall in the lab (`EDITOR_BENCH_GATE=enforce`, #68); #63; and 100 keys typed inside the last line filter of a 1 KB LogQL query on the dev harness route (`bench-editor-keystroke-logql.json`) and on Explore › Logs with the stream shown (the `logs page` case, `bench-editor-keystroke-logs-page.json`); same probe, trace, thresholds and modes, #66); `bench:log-page-load` (Chromium, http BFF and the fake: Explore › Logs runs `{app="paging"}`; window one from before Run to the first row of page one, window two from there through page two to the end of the list; a `page.route` gate on the range route's path holds every request with a cursor until page one is marked, so page two's decode falls in window two; always: two range requests (the second with a cursor), the gate held the tenant-scoped request once, one volume request, page one answered by its mark and page two after it, `ciOver` 0; lab (`LOG_BENCH_GATE=enforce`): no main-thread task over 16 ms in either window (PRF-005, PRF-020); #66 Part C); `bench:logql-completion-latency` (Chromium, stub build, dev harness route with an in-memory source: keydown to popup for 30 local (`|` → stages) and 30 remote (`w` in a value) trials; remote never before 120 ms; enforced: local p95 ≤ 16 ms, remote p95 ≤ 136 ms (T09-007, T09 §7); #66); `bench:log-scroll` (Chromium, stub build, dev harness with a synthetic API: 10⁶ entries held; vsync calibrated at rest; a control scroller for the browser's floor; a 30 000 px scripted fling at the middle; a fling across the buffer end, the window running to 1 s after the page lands; always: held at the cap, the load made, `ciOver` 0 between the `bench:start` and `bench:end` marks; lab (`LOG_BENCH_GATE=enforce`), unrounded against the vsync interval: fling median interval ≤ 1 vsync at ≥ 60 Hz (PRF-001), crossing intervals ≤ 2 vsyncs (PRF-020), Chromium `EventLatency` (input to presentation, the PRF-003 proxy; photons are not observable) median ≤ 1 and p99 ≤ 2 vsyncs (PRF-003, PRF-004), no task over 16 ms wall (PRF-005); #66 Part B); `bench:promql-completion-latency` (Chromium, stub build, Explore › Metrics: keydown to popup for 30 local (`r` in `sum(‸up)` at the end of a 1 022-byte query → functions) and 30 remote (`a` in `up{job=""}`) trials; `keyWork` per local key = its document update, its local completion work and the popup render, timed in the page by the editor and completion probes; a trace of every trial; always: remote never before 120 ms, local p50 < 100 ms, `ciOver === 0`, both probes wired; enforced: local p95 ≤ 16 ms, remote p95 ≤ 136 ms, `over16 === 0`, `keyWork` p95 ≤ 2 ms (T09-007, T09-008, T09 §7, PRF-005); remote processing reported as `remoteWork`; #107); `bench:frame-interim-line` (report only, until #68: the interim Canvas 2D layer redraw of the 50 × 1 440 line chart over 40 theme changes, p50 and p95 reported, no threshold; and, in a separate test with a 30 s limit, the `line-extreme` frame, #97); `bench:frame-interim-heatmap` (report only, until #68: the interim Canvas 2D layer draw of a 10k × 200 heatmap with missing cells, 50 timed draws, p50 and p95 reported, no threshold; #63);
`bench:promql-decode` and `bench:bff-overhead` (#62, `REFERENCE_LAB=1 make bench-bff`: W1, a 1 000 × 1 000
PulsusDB matrix decoded, gridded and encoded, ≤ 30 ms per 10⁶ points, median of 5; W2, 1 000 sequential
range requests with a 2 ms upstream, BFF overhead p50 ≤ 5 ms and p99 ≤ 20 ms ([T06](T06-bff-architecture.md)
§7); they fail over threshold and skip without the lab); plus `bench:cpu-instr` (PR: decode, decimation,
tick generation and layouts, instruction counts via `iai-callgrind`, and from #62 the BFF workloads W1
and W2, and from #65 W3 (one 5 000-entry log page through the LogQL range route), via cachegrind for
Go, run by `.github/workflows/bench.yml` on every pull request against
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
| `bench:rooms-long-tasks` (owner: [T08](T08-dom-component-kit.md) §7, PRF-005; `e2e/perf-rooms-long-tasks.spec.ts`; the board editor scenario, #90, chart gestures, #93, the "board editor, 8 thresholds" scenario, #64 Part B, the "gallery near-limit" scenario, #97, and the "histogram 2·10⁶ values" scenario (run, hover, brush, click a bin, select all keys from a line panel), [T21](T21-time-and-distribution-panels.md) H22, #154, under the same interim CI check) | PR: CI's `e2e` Chromium leg, interim; merge once the reference lab ((a), (b)) exists | interim CI: `ciOver === 0`, no main-thread task over 50 ms wall with over 16 ms thread time (§4.3 trace check; a task without thread time counts); lab: no task over 16 ms wall between the first and last input (`LONG_TASK_GATE=enforce`) | interim CI check: yes, blocks merge now; 16 ms wall: yes once the lab exists (#68), pending until then |
| `bench:lens-load` | nightly | PRF-010/011 | release blocker, from M-UI2 |
| `bench:decode-r1` | merge | < 50 ms p95 | yes |
| `bench:shim-input-cost` (engine adapter, from #68) | merge | T03-003 (§4.3) | as `bench:long-tasks`: yes once the lab exists; until then CI's `e2e` reports the times only. Report-only from #68 Part C2a2: the synthetic subset on the gate host (10⁴ wheels and 10⁴ pointer moves on a probe frame, 16 per animation frame, one run; p50, p99 and max per dispatch and per frame's group printed next to the limits; asserts only that every prevented wheel enqueued a record); the trusted-input leg (R), the median of 3 runs for N and B, machines (a) and (b) and failing on the limits wait for the reference lab |
| `bench:editor-keystroke` | PR: CI's `e2e` Chromium leg, interim; merge once the reference lab exists (`EDITOR_BENCH_GATE=enforce`, #68) | interim CI: `ciOver === 0` (§4.3); lab: editor update p95 ≤ 2 ms, 0 main-thread tasks > 16 ms | the CI check blocks now; the lab thresholds once the lab exists, report only until then |
| `bench:logql-completion-latency` | PR: CI's `e2e` Chromium leg, report-only; merge once the reference lab exists (`EDITOR_BENCH_GATE=enforce`, #68) | always: 30 + 30 samples, remote min ≥ 120 ms; lab: local p95 ≤ 16 ms, remote p95 ≤ 136 ms | the always checks block now; the lab thresholds once the lab exists, report only until then |
| `bench:log-page-load` (#66 Part C; `e2e/perf-log-page-load.spec.ts`) | PR: CI's `e2e` Chromium leg, the always checks; merge once the reference lab exists (`LOG_BENCH_GATE=enforce`, #68) | always: the request, gate (`cursorHeld === 1`) and attribution checks, `ciOver` 0; lab: no main-thread task over 16 ms in either window | the always checks block now; the lab threshold once the lab exists, report only until then |
| `bench:promql-completion-latency` | PR: CI's `e2e` Chromium leg; merge once the reference lab exists (`EDITOR_BENCH_GATE=enforce`, #68) | always: 30 + 30 samples, remote min ≥ 120 ms, local p50 < 100 ms, `ciOver === 0`, the probe wired; lab: local p95 ≤ 16 ms, remote p95 ≤ 136 ms, `over16 === 0`, `keyWork` (document update plus local completion work) p95 ≤ 2 ms | the always checks block now; the lab thresholds once the lab exists, report only until then |
| `bench:log-scroll` (#66 Part B; `e2e/perf-log-scroll.spec.ts`) | PR: CI's `e2e` Chromium leg, the always checks; merge once the reference lab exists (`LOG_BENCH_GATE=enforce`, #68) | always: 10⁶ held, the crossing load made, `ciOver` 0, ≥ 50 latencies; lab: fling median ≤ 1 vsync at ≥ 60 Hz, crossing ≤ 2 vsyncs, `EventLatency` median ≤ 1 and p99 ≤ 2 vsyncs, no task over 16 ms between the marks | the always checks block now; the lab thresholds once the lab exists, report only until then; if the lab misses PRF-001 at 10⁶ lines, PRF-020 returns to M-UI2 and #69 meets it |
| `bench:frame-interim-line` (interim renderer, until #68) | PR | none (reports p50, p95) | no |
| `bench:frame-interim-categories` (interim renderer, until #68; #173 Part 2) | PR | none (reports p50, p95) | no |
| `bench:frame-flame-1e5` ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §7, #152: icicle pan, zoom and fly at 10⁵ frames, interim renderer then engine) | PR: CI report-only; lab-enforced (`FLAME_BENCH_GATE=enforce`) | median ≥ 60 fps / p99 ≤ 22.2 ms on (a) and (b); no task > 16 ms | report only in CI; enforced in the lab, where the (a)+(b) verdict is I1's PRF-021 acceptance |
| `bench:frame-flame3d-1e5` ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §7, #152: 3D orbit, dolly and fly for 30 s at 10⁵ frames) | lab | as `bench:frame-flame-1e5`; worker CPU ≤ 8 ms p99 (LOD 2, labels 2, pick 0.5, upload 1) | yes (lab, enforced) |
| `bench:flame-fly` ([T23](T23-graph-trace-profile-and-hierarchy-panels.md) §7, #152: fly, morph, re-root) | merge | ≤ 250 ms | yes |
| `bench:markdown-render` ([T24](T24-geo-schematic-and-widget-panels.md) §7, #153, #198: 50 distinct 64 KiB inputs, every memo lookup a miss; the uncached p95) | PR: CI report-only | ≤ 16 ms p95 | no |
| `bench:text-widget-render` ([T24](T24-geo-schematic-and-widget-panels.md) §7, #198 Part 3b: 6 Text panels (4 × 2 KiB, 16 KiB, 64 KiB) on the production stub build in Chromium; open, 5 variable changes, typing in the 16 KiB and 64 KiB editors; the uncached render per size bucket, the long tasks and the event latency) | PR: report-only; enforced with `LONG_TASK_GATE=enforce` | `le4k`, `le16k`: render p95 and every long task ≤ 16 ms; `le64k`: render p95 ≤ 16 ms | no (report-only) |
| `bench:clock-tick` ([T24](T24-geo-schematic-and-widget-panels.md) §7, #153: 20 Clocks × 12 zones) | PR: CI report-only | ≤ 2 ms per tick | no |
| `bench:widget-lists` ([T24](T24-geo-schematic-and-widget-panels.md) §7, #181: a 1 000-row list re-render; step 2: a 2 000-row Change feed render, ≤ 50 ms p95) | PR: CI report-only | ≤ 16 ms p95 (Change feed ≤ 50 ms p95) | no |
| `bench:geomap-markers` ([T24](T24-geo-schematic-and-widget-panels.md) §7, #184: 5 000 rows, 10 s of pan and zoom, Chromium at 1×) | PR: CI report-only | ≤ 16 ms p95 | no |
| `bench:geo-area` ([T24](T24-geo-schematic-and-widget-panels.md) §7, #184 step 2: `applyArea` over 5 000 series, 4 000 `cloud_region` and 1 000 coordinates, the EU area, 20 warm-up and 200 timed runs) | PR: the `unit` leg, report-only (p50, p95); merge once the reference lab exists (`GEO_BENCH_GATE=enforce`) | p95 ≤ 2 ms | no until the lab exists, then yes |
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

**Time and distribution panels ([T21](T21-time-and-distribution-panels.md))**

| Gate | Checks | Stage |
|---|---|---|
| `unit:state-runs` | T21-003, T21-004, T21-005, T21-011 | PR |
| `unit:summary-facts` | T21-010 | PR |
| `e2e:chart-select` | T21-009 against the #164 Inspector | PR |
| `unit:dist-bins` | T21-012, T21-013, T21-014, T21-016 meter, and the hit regions | PR |
| `unit:hist-worker` | T21-016 batching, abort and stale drop | PR |
| `e2e:hist-inspect` | T21-015 click, keys, brush and Esc against the T25 host | PR |
| `bench:frame-interim-time-kinds` | Until #68: scripted pan and zoom over each T21 kind at its cap. Reports p50 and p95. A change to the draw path records a local before/after run, and the p95 regression must be ≤ 10 % | PR (report) |
| `golden:3d-occlusion` | From the engine, for each 3D view: two poses invert one occlusion, and the depth order equals the geometry | merge |
| `replay:3d-linked-2d` | From the engine: `T` swaps 2D and 3D with the same data and selection, and hovering in 3D drives the docked 2D slice | merge |

The existing gates `bench:rooms-long-tasks` (the "histogram 2·10⁶ values" scenario),
`golden:interim-gallery`, `golden:greyscale`, `e2e:table-csv`, `unit:board-spec`,
`unit:summary-facts`, `unit:selection-draw` and `unit:inspector-model` gain the T21 H rows (#154).

**Value, categorical and table panels ([T22](T22-value-categorical-and-table-panels.md))**

| Gate | Checks | Stage |
|---|---|---|
| `unit:category-reduce` | T22-003: each reducer over finite samples; all NaN → NaN, `count` 0 | PR |
| `unit:category-cap` | T22-006: `capMarks(many, 200)` keeps min, max and the failing row; the coverage and its meter text | PR |
| `unit:category-tiny` | T22-006: caps 3 and 2, `tooSmallText`, every row in `panelRows`, `barCap` | PR |
| `unit:coverage-text` | T22-006, VIZ-027: every meter part, including the list-widget members, and `100 %` | PR |
| `unit:category-label` | T22-005, T22-007: the effective label, the filter pairs and their texts, the names | PR |
| `unit:category-duplicates` | T22-003, T21: the instant and range merges, their conflicts (equal to the histogram's), the facts change, the baseline match and delta | PR |
| `unit:category-subset-names` | T22-004: the shortest distinguishing set, breadth-first; absent keys | PR |
| `unit:category-unique-names` | T22-004: the final uniqueness pass, quoted raw values, aggregates | PR |
| `unit:category-bounds` | T22 §6.1, ADR-0022: `resolveBounds` and `outsideCount` | PR |
| `unit:category-summary-facts` | T22-014, VIZ-068: focus, change, extent and ratio; instant, warning baseline, no finite mark | PR |
| `unit:category-table` | T22-013, T24-026: `panelRows` (aggregates), `panelCsv`, `csvCell` and `csvFileName` | PR |
| `unit:board-options` | T22 §6.1: `withKind`, `keepOptions`, the bar chart defaults, the key tables against `option-keys.json`; #173 Part 3a: a kind change keeps only valid values, and `optionValueValid` is false exactly where the validator reports a value in `invalid.json` (the cross-key rules aside) | PR |
| `unit:frame-coverage` | T22-006, [ADR-0028](../adr/0028-chart-seam-bar-chart.md): `many` at a 2 800 px extent draws 200; the `a11y` summary has 250 / 200 and the data's `coverage`; a line summary has none | PR |
| `unit:category-colour` | T22-004, T22-001, VIZ-067: series colours without thresholds, no pattern, gradient or shadow; `many` at 300 px gives 21 named bars; with thresholds the state colour, the glyph before the name and two dashed lines | PR |
| `unit:barchart-layout` | T22-004, T22-006: `categoryExtent` (H and V, with thresholds), data order, value labels outside the bars (also clipped at a fixed range and negative), none when off, vertical names at −90° | PR |
| `unit:barchart-labels` | T22-004: the middle fit, ` (k)` then draw-index suffixes, hidden names with the note, full names in `mark` | PR |
| `unit:barchart-fit-stages` | T22-006: the fit's stages by width (H) and height (V), with and without value labels; no frame and an empty drawn set at `tooSmall`; mounted plots ≥ `minPlotPx`; the matching note | PR |
| `unit:barchart-events` | ADR-0028, [ADR-0029](../adr/0029-bar-chart-keys-and-brush.md): `mark` once per band change and null once on leaving; `pick` `{…, source: 'pointer'}` for a click and an empty click; a 5 px drag picks a one-band `brush`; a right click, the wheel and a double click emit nothing | PR |
| `unit:barchart-selection` | T22-008, ADR-0025: the others at `dimmed`, a focus ring on the selected bar; a foreign or null selection draws as none | PR |
| `unit:barchart-ghost` | ADR-0028: the dashed `text-muted` rectangle from x(0) to x(baseline), as thick as the bar; none off or without a baseline | PR |
| `unit:frame-data-categories` | ADR-0028: `validateFrameData` for `barchart`: `kind`, `cap` over 200, `key` (bad or repeated) | PR |
| `unit:barchart-plan` | T22-006, VIZ-005: `barchartModel` and `fitBarchart`: the sorted rows, `100 %`, `tooSmall` at caps 1 and 0 with drawn 0, one row at a cap of 1, the bounds and `outside`, thresholds; a resize within one cap and stage keeps the data | PR |
| `unit:barchart-keys` | T22-010, ADR-0029: focus, arrows, Home/End, the Shift brush (`brush`, `keyboard`, draw order), Enter, Escape (not prevented, silent), Ctrl ignored, `focusout` → `mark` null, new data clamps f; the 2 px `focus` stroke; no rows emit nothing | PR |
| `unit:barchart-brush` | T22-008, T22 §4.3, ADR-0029: the `selection` fill over the brushed bands while dragging; `pick` {keys in draw order, `brush`, `pointer`} both ways; clamped below the plot; `pointercancel` picks nothing | PR |
| `unit:bar-list` | T08-016, T22-010, ADR-0029: the mirror listbox is the key target, its `aria-activedescendant` follows a keyboard `mark` only, `data-escape-ladder`, `k more` outside it, the canvas's description resolves to it with every bar | PR |
| `unit:bar-list-selected` | T22-008, T08-016: options selected from the page selection; null selects none; every gallery listbox none at first paint | PR |
| `unit:bar-action` | T22-007, T22-005, VIZ-037: `barAction` (click, filter toggle, no pair, Explore, clear, brush, unknown key, merged duplicates) and `barHint` | PR |
| `unit:mark-tooltip` | T22-011, T22-006: the bar tooltip lines (baseline, its truncated or limited run, the filter hint, the reduced window, the anomaly note) | PR |
| `unit:panel-table` | T22-013, VIZ-066: `PanelTable` caption, `aria-rowcount`, virtualised rows, End, Enter, a name click, Export (Blob = `panelCsv`, the file name); an empty table | PR |
| `unit:panel-table-active` | T22-013, T08-016: the active row's id names a mounted row and stays mounted when scrolled away; new rows clear it | PR |
| `unit:panel-table-button` | T22-013: a row button's Enter and Space pick its row once; the grid's active row stays | PR |
| `unit:category-chart-table` | T22-013: Shift+T swaps chart and table with focus following; inputs and an absent `onTable` are left alone; the ghost on the spec and the baseline-failed note; the gallery's per-entry table; the focusable `tooSmall` notice (`unit:category-tiny` (table)) | PR |
| `unit:baseline-window` | T22-012: `baselineOffset`, `OFFSET_MS`, `shiftWindow` | PR |
| `unit:barchart-options-field` | T22 §6.1: `BarchartOptionsField` defaults, each key written, empty removes, Min/Max number errors, the baseline offset, `errorAt` | PR |
| `bench:frame-interim-categories` | VIZ-004: the 200-bar `barchart-cap` over 50 theme changes; p50 and p95 reported, no threshold | PR (report) |

`unit:board-spec` covers board spec v3 (#173 Part 1): `v3-full.json` round-trips with the same
canonical SHA-256 on both sides, the `options-*` rows of `invalid.json` match on both, and the
previous release (`max` 2) refuses a v3 row.

**Inspector and pivots ([T25](T25-inspector-and-pivots.md))**

| Gate | Checks | Stage |
|---|---|---|
| `unit:inspector-model` | T25-003, T25-004, T25-015: fixture P sections, raw values, pivot reasons, staged actions and `announce`; the edge cases (no value, no labels, no query, bucket ranges, ns log time); #173 Part 3a: the `mark` target (value, Baseline, State, Series key, Reduced over, labels, selection, `vis=barchart`, the origin window) | PR |
| `unit:inspector-pivots` | T25-010: the Logs ±1 min href, LogQL escaping, `job` translation and the job reason | PR |
| `unit:pivot-context` | T25-010, IA-026, IA-027, INT-035: rows C1, C1′ and C2; C3 (added by I6) and C4 (added by #223: the canonical `e=` entity set); C5 and C6 (added by #184 step 2 E3a: the map area disclosed only while effective, never carried) | PR |
| `unit:escape-ladder` | T25-007, T23-011: pre and post steps, `data-escape-ladder` fields, unmarked inputs skipped; a listbox marked `data-escape-ladder` is not skipped, an unmarked one is (#173 Part 3a) | PR |
| `unit:inspector-members` | T25-011, T21-005: two lists, complete and stale results, reset | PR |
| `unit:engine-select` | T25-005: pointer hit rules for line, bars and heatmap | PR |
| `unit:inspector-nav` | #184, T25-007, T25 §4.8: the navigation stack (push, pop, no-ops, reset, the Esc pop) | PR |
| `unit:inspector-viewkey` | #184, T25-008, T25 §4.4: `viewKey` layers, focus and announcements | PR |
| `unit:clipboard-denied` | T25-015: "Couldn't copy" for 4 s on refusal | PR |
| `unit:log-selection` | T25-006: LogStream matching and muting under the relevance rule | PR |
| `unit:selection-draw` | T25-006, T02-025: line, bars, stat and heatmap selection drawing; a null selection draws as none | PR |
| `e2e:inspector-open` | VIZ-003, T25-001, T25-014: a click and Enter open the Inspector per kind on boards and Explore; the origin outline | PR |
| `e2e:inspector-sections` | INT-034 (staged): sections in order, 2 chips enabled and 4 disabled with visible reasons, 3 actions disabled | PR |
| `e2e:inspector-pivot-nav` | INT-036 (staged), INT-035: Logs ±1 min destination; plain and Shift-click navigate and Back restores; Ctrl-click opens a new page | PR |
| `e2e:inspector-escape` | INT-016: crosshair, then selection, then close, with focus returned; the panel editor's Esc stays its own | PR |
| `e2e:selection-sources` | T02-025, T25-006, T25-016: a legend-table "Select" highlights in every panel on the next frame (screenshots `selection-b`, `selection-none`) | PR |
| `e2e:selection-logs` | T02-025, T25-006: log selection in both directions, foreign keys mute nothing | PR |
| `e2e:pivot-destination` | IA-026, INT-035, T25-010: the Explore › Logs request carries the filters; Explore › Metrics has no `f`, and the line disclosed it | PR |
| `e2e:inspector-keyboard` | T25-008: keyboard inspect of a log row, Tab order, disabled chips described, the live region | PR |
| `e2e:inspector-motion` | T25-013, VL-014, VL-016: reduced motion shows the final styles on the first frame; normal motion is a 200 ms opacity transition | PR |
| `golden:inspector` | T25-013, VL-014, VL-016: open and collapsed, dark, light and forced colours (opaque) | PR |
| `bench:inspector-redraw` | The redraw comparison with a selection and the Inspector open against neither: p95 ≤ +10 % (MINOR); measures `backdrop-filter` and selection redraws | PR (report) |

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
| 1.19-rc | 2026-11-21 | #63 Part C: §7.1 adds `unit:explore-run-size`, `e2e:explore-completion`, `e2e:metrics-autovis`, `e2e:editor-error-on-run`, `e2e:series-table`, `e2e:explore-cancel`, `e2e:explore-truncation`, `e2e:explore-refresh`, `e2e:editor-ime` and the lab benchmark `bench:editor-keystroke` (lab-gate row: merge once the lab exists, report-only on shared CI until then); `e2e:lazy-load` and `ci:bundle-size` name the editor closure |
| 1.20-rc | 2026-11-21 | #63 Part C (orchestrator decision on plan C.12): §4.3 states the interim CI long-task check as AND: a task fails CI only over 50 ms wall **and** over 16 ms thread time, or without thread time; PRF-005's 16 ms limit is the reference-lab gate (`over16`, enforce mode), pending #68; `bench:editor-keystroke` uses the same check. §7.1 `bench:editor-keystroke`: the editor update per key (probe) p95 ≤ 2 ms and the traced tasks |
| 1.21-rc | 2026-11-21 | #112: §7.1 `unit:plan-parity` (the shared planner fixture through the Go planner and the TS StubApi mirror, with the Go and Lezer shapes) replaces `unit:explore-plan`; the integration table adds `itest:plan-authority` (T06-029) |
| 1.22-rc | 2026-11-22 | #65 Part A: §7.1 adds `unit:log-paging`, `unit:log-window`, `unit:log-decode`, `unit:log-member-order`, `unit:log-level`, `unit:logql-calls`, `unit:volume-compose`, `unit:volume-buffered`, `unit:log-categorized`, `unit:text-errors`, `unit:query-hash`, `unit:contract-window` and `itest:pulsusdb-contract` (with its `logql` subtest); `unit:virtual-guard` covers the LogQL inputs |
| 1.23-rc | 2026-11-22 | #65 Part B: §7.1 adds `unit:decode-logs`, `unit:log-cursor`, `unit:logql-routes`, `unit:log-time-range`, `unit:logql-golden`, `unit:logs-completion`, `itest:logql-streams`, `itest:logql-metric`, `itest:logql-volume`, `itest:logql-errors` and `itest:logql-cancel`; `unit:sanitise` and `unit:deadlines` cover the log routes; `itest:cancel` and `itest:logql-cancel` are bound at 50 ms; `bench:cpu-instr` adds W3 |
| 1.24-rc | 2026-11-22 | #64 Part A: §7.1 adds `e2e:board-promql-panels`, `e2e:board-visible-only`, `e2e:board-cancel`, `e2e:board-open-in-explore`, `e2e:board-refresh` and `e2e:board-states` |
| 1.25-rc | 2026-11-22 | #116: §7.1 adds `unit:logql-classify`, `itest:logql-planned`, `itest:logql-virtual-refused`, `itest:logql-plan-sizes`, `itest:logql-error-position`; `unit:plan-parity` adds `logql.json` through `logs.Plan` and `api/stub/logsPlan.ts`; `itest:plan-authority` adds the LogQL range and volume routes; `unit:volume-compose` (the template in `logs.Plan`, sent byte for byte by the core, no position inside it); `unit:virtual-guard` (the LogQL query routes classify first) |
| 1.26-rc | 2026-11-22 | #118: §7.1 `unit:plan-parity` adds the PromQL value encodings (`FuzzEncodeQuoted`, `FuzzValueRoundTrip`, the Q cases of `promql.json`); `itest:plan-authority` adds the PromQL value cases, sent as planned or refused with `variable.unrepresentable` and no upstream request |
| 1.27-rc | 2026-11-23 | #121: §7.1 adds `itest:logql-hash-refused`, `itest:logql-lexer` and `unit:lexer-record`; `itest:pulsusdb-contract` adds the `logql-lexer` subtest; `itest:logql-virtual-refused` refuses the `#` entries as `query.invalid` first |
| 1.28-rc | 2026-11-23 | #66 Part A: §7.1 adds `unit:logql-lex`, `unit:logql-state`, `unit:logql-highlight`, `unit:logql-context`, `unit:logql-completion`, `unit:logql-replace`, `unit:logql-cancel`, `unit:logql-completion-timing`, `unit:log-source`, `unit:lookup-window`, `unit:logql-diagnostics`, `unit:logql-editor` and `unit:router-dev-logql`; `unit:suggest-cache`, `unit:lang-table` and `bench:editor-keystroke` (a LogQL case) extended; the lab benchmark `bench:logql-completion-latency` and its lab-gate row (report-only on shared CI until the lab exists) |
| 1.29-rc | 2026-11-23 | #64 Part B: §7.1 adds `unit:thresholds`, `e2e:board-thresholds-legend` and `e2e:board-stat-tile`; `unit:board-spec` covers board spec v2; `bench:rooms-long-tasks` adds the "board editor, 8 thresholds" scenario under the same interim CI check; `golden:interim-gallery` "seven" → "nine" (`line-thresholds`, `stat-sparkline`) |
| 1.30-rc | 2026-11-23 | #66 Part B: §7.1 adds `unit:log-buffer`, `unit:log-pager`, `unit:log-synth`, `unit:log-slice`, `unit:log-stream`, `unit:log-time`, `unit:level-tokens`, `unit:use-log-pager`, `unit:router-dev-log-stream`, `unit:long-task-marks`, `unit:event-latency` and `e2e:log-stream`; `unit:log-paging` adds the shared fixture `wire/fixtures/json/logql-paging.json` (`TestPagingFixture`), which the client synth also passes; the lab benchmark `bench:log-scroll` and its lab-gate row; §4.3: the M-UI1 log stream page is measured by `bench:log-scroll` on the dev harness |
| 1.31-rc | 2026-11-23 | #97: §7.1 adds `unit:value-ticks-bounded`, `e2e:ticks-parity` (path parity; F, S and N classes), `unit:ulp-distance` and `e2e:gallery-extreme`; `unit:extreme-ticks` is height-aware; `unit:layout-parity` adds `ticks-extreme.json`; `bench:frame-interim-line` adds the `line-extreme` frame; `bench:rooms-long-tasks` adds the "gallery near-limit" scenario; `golden:interim-gallery` "nine" → "ten" (`line-extreme`) |
| 1.32-rc | 2026-11-23 | #107: §7.1 adds `unit:promql-completion`, `unit:promql-replace`, `unit:promql-completion-timing`, `unit:promql-cancel`, `unit:editor-probe` (with the completion probe) and `bench:promql-completion-latency`, with its lab-gate row beside `bench:logql-completion-latency`; `unit:suggest-cache`: no in-flight lookup is superseded by another key, and an evicted one is re-joined by its key and still released by its last signalled caller (the #66 clause on PromQL supersession goes); `unit:prom-source` passes the caller's signal; `unit:logql-completion-timing` no longer checks PromQL's 120 ms delay |
| 1.33-rc | 2026-11-23 | #66 Part C: §7.1 adds `unit:logs-params`, `unit:use-logs-params`, `unit:router-logs-params`, `unit:clock-epoch`, `unit:refresh-epoch`, `unit:step-width`, `unit:logs-volume`, `unit:logs-run`, `unit:logs-page`, `unit:palette-levels`, `unit:log-transcripts`, `e2e:logs-completion`, `e2e:logs-run`, `e2e:logs-brush`, `e2e:logs-paging`, `e2e:logs-metric`, `e2e:logs-cancel`, `e2e:logs-truncation`, `e2e:logs-refresh` and `e2e:logs-error-on-run`; `unit:use-log-pager` adds the generation; `e2e:lazy-load` names the Logs page; `bench:editor-keystroke` adds the Logs page case; the lab benchmark `bench:log-page-load` and its lab-gate row; §4.3 log stream row: `bench:log-page-load` on the Logs page (HTTP decode) |
| 1.34-rc | 2026-11-23 | #64 Part C ([ADR-0023](../adr/0023-chart-event-markers.md)): §7.1 adds `unit:event-marks`, `unit:board-events` and `e2e:board-event-markers`; `golden:interim-gallery` "ten" → "eleven" (`line-events`) |
| 1.35-rc | 2026-11-24 | #135: §7.1 `ci:bundle-size` also measures the HTTP build (`dist-http/`) |
| 1.36-rc | 2026-11-24 | #126: §7.1 `e2e:ticks-parity` exact in every engine (F/S/N classes removed); adds `unit:js-pow`; removes `unit:ulp-distance` |
| 1.37-rc | 2026-11-24 | #67: §7.1 adds `unit:log-stream-prefetch`, `unit:log-panel-path`, `unit:stream-input`, `unit:fetch-log-frame`, `unit:stream-meta`, `unit:logql-planned`, `unit:from-range-frame`, `unit:panel-view`, `unit:explore-link`, `unit:query-language`, `unit:board-log-panels`, `e2e:board-logql-save`, `e2e:board-logql-brush` and `e2e:board-logql-paging`; `e2e:a11y-rooms` adds the board log panels (axe, targets and the keyboard loop L34) |
| 1.38-rc | 2026-11-24 | #130: §7.1 adds `ci:e2e-complete` (the e2e suite runs as five CI shards per engine, chosen by tag and spec file) |
| 1.39-rc | 2026-11-24 | #150 ([T21](T21-time-and-distribution-panels.md)): §7.1 adds `unit:state-runs`, `unit:summary-facts`, `e2e:chart-select`, `bench:frame-interim-time-kinds`, `golden:3d-occlusion` and `replay:3d-linked-2d`; `ci:spec-lint` adds the T21-001 2D-kind check |
| 1.40-rc | 2026-11-24 | #152 ([T23](T23-graph-trace-profile-and-hierarchy-panels.md), flame graph): §7.1 adds `unit:flame-decode`, `unit:flame-suspects`, `unit:flame-suspects-nobase`, `unit:flame-suspects-diff`, `unit:flame-merge`, `unit:flame-search-dense`, `unit:flame-options`, `unit:autovis-profile`, `unit:flame-diff`, `unit:flame-diff-sign`, `unit:flame-diff-exact`, `unit:flame-diff-self`, `unit:flame-diff-cost`, `unit:flame-diff-empty`, `unit:flame-gap`, `unit:flame-layout`, `unit:flame-multiparent`, `unit:flame-zero-self`, `unit:flame-sandwich`, `unit:flame-labels`, `golden:flame3d`, `golden:flame-greyscale`, `e2e:flame-two-actions`, `e2e:flame-escape`, `e2e:flame-merge-pick`, `e2e:flame-search-levels`, `e2e:flame-2d`, `e2e:flame-types`, `e2e:flame-states`, `e2e:flame-baseline`, `e2e:flame-baseline-range`, `e2e:flame-identity`, `e2e:flame-a11y`, `e2e:flame-diff-nobaseline`, `e2e:flame-diff-none`, `e2e:flame-mode-switch`, `e2e:flame-diff-fly`, `e2e:flame3d-nav`, `e2e:flame3d-controls`, `e2e:flame3d-modes` (PR, blocking), and the lab gates `bench:frame-flame-1e5` (CI report-only, lab-enforced with `FLAME_BENCH_GATE=enforce`), `bench:frame-flame3d-1e5` (lab, enforced) and `bench:flame-fly` (merge) |
| 1.41-rc | 2026-11-25 | #164 ([T25](T25-inspector-and-pivots.md)): §7.1 adds `unit:inspector-model`, `unit:inspector-pivots`, `unit:pivot-context`, `unit:escape-ladder`, `unit:inspector-members`, `unit:engine-select`, `unit:clipboard-denied`, `unit:log-selection`, `unit:selection-draw`, `e2e:inspector-open`, `e2e:inspector-sections`, `e2e:inspector-pivot-nav`, `e2e:inspector-escape`, `e2e:selection-sources`, `e2e:selection-logs`, `e2e:pivot-destination`, `e2e:inspector-keyboard`, `e2e:inspector-motion`, `golden:inspector` (PR, blocking) and `bench:inspector-redraw` (PR, report); `e2e:a11y-rooms` adds the Inspector |
| 1.42-rc | 2026-11-25 | #153 ([T24](T24-geo-schematic-and-widget-panels.md) part A): §7.1 adds `unit:board-spec-widgets`, `unit:classify-url`, `unit:markdown-links`, `unit:markdown-nodes`, `unit:markdown-iframe`, `unit:markdown-images`, `unit:markdown-interpolate`, `unit:removal-redaction`, `fuzz:markdown-nodes`, `unit:find-iframes`, `unit:import-text-iframe`, `unit:import-size-error`, `unit:clock-format`, `unit:clock-countdown`, `unit:countdown-due`, `unit:wall-clock`, `e2e:widget-text`, `e2e:widget-text-xss`, `e2e:widget-clock`, `e2e:widget-a11y` and `golden:widget-gallery`, and the report-only `bench:markdown-render` and `bench:clock-tick` |
| 1.43-rc | 2026-11-25 | #154 ([T21](T21-time-and-distribution-panels.md) part 2a, histogram): §7.1 adds `unit:dist-bins`, `unit:hist-worker` and `e2e:hist-inspect` (PR, blocking); `bench:rooms-long-tasks` adds the "histogram 2·10⁶ values" scenario under the same interim CI check; `golden:interim-gallery`, `golden:greyscale`, `e2e:table-csv`, `unit:board-spec`, `unit:summary-facts`, `unit:selection-draw` and `unit:inspector-model` gain the T21 H rows |
| 1.44-rc | 2026-11-25 | #206 ([T21](T21-time-and-distribution-panels.md) part 2a-ii, bucket histograms): `unit:dist-bins`, `unit:hist-worker`, `e2e:hist-inspect`, `e2e:table-csv`, `unit:inspector-model`, `unit:summary-facts`, `unit:selection-draw`, `golden:interim-gallery` and `golden:greyscale` gain the T21 B rows (B1 to B22, H8 rewritten, H21b); `bench:rooms-long-tasks` gains the "bucket histogram 1 995 000 samples" scenario under the same interim CI check; `ci:gallery-manifest` gains `histogram-buckets`. No new gate |
| 1.45-rc | 2026-11-25 | #68 Part B: §7.1 restates `unit:codec-roundtrip` and `unit:json-arrow-prop`, and adds `unit:schema-yaml`, `unit:dsf-writer-order`, `unit:part-ids`, `unit:dsf-header`, `unit:arrow-alignment`, `unit:coverage-complete` (B1), `unit:dsf-bounds`, `unit:dsf-fuzz-smoke`, `unit:fb-reader` (B2), `unit:limits-json`, `unit:wire-limits`, `unit:dsf-limits` (B3); T04-009/010 → `unit:dsf-bounds`, `unit:dsf-fuzz-smoke`; T04-005 → `unit:json-arrow-prop` |
| 1.46-rc | 2026-11-25 | #181 ([T24](T24-geo-schematic-and-widget-panels.md) part B1): §7.1 adds `unit:board-spec-board-list`, `unit:board-list-source`, `unit:board-list-rows`, `unit:list-coverage`, `unit:board-list-states`, `unit:board-list-mixed`, `unit:board-list-key`, `unit:list-keyboard`, `unit:list-table-csv`, `unit:import-board-list`, `itest:board-find`, `itest:board-tags`, `itest:board-list-snapshot`, `itest:board-tags-old-binary`, `itest:board-tags-validate` (I4), `e2e:widget-board-list` and `e2e:widget-lists-a11y` (PR, blocking), and the report-only `bench:widget-lists`; `itest:board-prefs` gains the `truncated` cases and `golden:widget-gallery` the three Board list pages |
| 1.47-rc | 2026-11-25 | #68 Part B2: `ci:spec-lint` adds `dash-wire-deps` (the normal dependencies of `dash-wire` are exactly `thiserror` and `bytemuck`) |
| 1.48-rc | 2026-11-25 | #181 ([T24](T24-geo-schematic-and-widget-panels.md) part B2): §7.1 adds `unit:entity-id`, `unit:change-source`, `unit:change-pager`, `unit:change-snapshot`, `unit:change-entity`, `unit:change-rows`, `unit:change-selection`, `unit:change-inspect`, `unit:change-mixed`, `unit:change-table-csv`, `unit:change-scope-text`, `unit:board-spec-change-feed`, `unit:import-change-feed`, `itest:annotations-entity`, `itest:annotations-scope`, `itest:annotations-scope-compile`, `itest:annotations-delete-scope`, `itest:annotations-keyset`, `itest:annotations-old-binary`, `itest:annotations-entity-validate` (I7) and `e2e:widget-change-feed` (PR, blocking); `e2e:widget-lists-a11y` and `golden:widget-gallery` gain the Change feed states and pages, and the report-only `bench:widget-lists` a 2 000-row Change feed (≤ 50 ms p95); `unit:pivot-context` C4 is the canonical `e=` entity set, added by #223 |
| 1.49-rc | 2026-11-25 | #184 ([T24](T24-geo-schematic-and-widget-panels.md) part E step 1a, geomap data): §7.1 adds `unit:geo-locate`, `unit:geo-geohash`, `unit:geo-decode`, `unit:geo-build`, `unit:geo-gazetteer-build`, `unit:geo-assets`, `unit:geo-load` and `ci:geo-data` (PR, blocking); `ci:bundle-size` adds the rows `geo-basemap` ≤ 40 000 B and `geo-gazetteer` ≤ 104 000 B |
| 1.50-rc | 2026-11-25 | #184 ([T24](T24-geo-schematic-and-widget-panels.md) part E step 1b, the geomap frame): §7.1 adds `unit:geo-rows`, `unit:geo-identity`, `unit:geo-basemap-draw`, `unit:geo-radius-project`, `unit:geo-camera`, `unit:geo-ownership`, `unit:geo-keys-engine`, `unit:geo-inertia`, `unit:geo-host`, `unit:geo-select-hover`, `unit:geo-plan`, `unit:geo-marks`, `unit:geo-coverage`, `unit:board-spec-geomap`, `unit:geo-list`, `unit:geo-list-keys`, `unit:geo-list-repair`, `unit:geo-targets`, `unit:geo-members`, `unit:inspector-nav`, `unit:inspector-viewkey`, `unit:geo-announce`, `unit:geo-nav`, `unit:geo-nav-life`, `unit:geo-inspect`, `unit:geo-single-group`, `unit:geo-table-csv`, `unit:geo-facts`, `unit:geo-states`, `e2e:geomap-offline`, `e2e:geomap-a11y` and `e2e:geomap` (PR, blocking) and the report-only `bench:geomap-markers` (≤ 16 ms p95); `golden:gallery` gains the three geomap pages; `unit:list-table-csv` is amended for the `csvCell` numeric exemption (T24-026) |
| 1.51-rc | 2026-11-25 | #173 Part 1 ([T22](T22-value-categorical-and-table-panels.md) I1, the categorical foundations): §7.1 adds the T22 block (`unit:category-reduce`, `unit:category-cap`, `unit:category-tiny`, `unit:coverage-text`, `unit:category-label`, `unit:category-duplicates`, `unit:category-subset-names`, `unit:category-unique-names`, `unit:category-bounds`, `unit:category-summary-facts`, `unit:category-table`, `unit:board-options`; PR); `unit:board-spec` covers board spec v3; `unit:list-table-csv` names `+x` as guarded |
| 1.52-rc | 2026-11-25 | #184 ([T24](T24-geo-schematic-and-widget-panels.md) part E step 2: URL state, sync, the map area, auto-vis row 8 and import): §7.1 adds `unit:map-params`, `unit:board-url-store`, `unit:board-url-queue`, `unit:url-budget`, `unit:url-echo`, `unit:url-time-init`, `unit:url-atomic`, `unit:geo-history`, `unit:geo-sync`, `unit:geo-sync-save`, `unit:geo-writers`, `unit:geo-area`, `unit:geo-area-results`, `unit:geo-area-consumers`, `unit:geo-area-scope`, `unit:board-spec-geomap-v8`, `unit:autovis-legacy`, `unit:autovis-logql`, `unit:autovis-explore`, `unit:editor-preview-legacy`, `unit:import-geomap`, `unit:import-geomap-fuzz` and `e2e:geomap-sync` (PR, blocking) and `bench:geo-area` (report-only on PR, p95 ≤ 2 ms enforced once the lab exists); `unit:autovis-table` adds row 8 and `unit:pivot-context` C5 and C6 |
| 1.53-rc | 2026-11-26 | #215 ([T24](T24-geo-schematic-and-widget-panels.md) part B1, I1): §7.1 `itest:board-find` adds the exact-tag (`finance`, `FINANCE`, `fin`) and `q`+`tag` cases and `tag=team:payments` → Ledger, Checkout overview; `itest:board-tags-old-binary` is run by `make itest-old-binary` (local, required for every change to the board schema or spec; hosted CI is not a gate), and its refused save is of "a head N saved" (the tags version, not v5); `unit:board-spec-geomap` and `unit:board-spec-geomap-v8` name the geomap and map-sync versions by change ([T24](T24-geo-schematic-and-widget-panels.md) §5.0), not by number; the widgets, board-list and change-feed gates name their versions and upcast from the immediately preceding version, and `unit:autovis-legacy`, `unit:autovis-logql` and `unit:editor-preview-legacy` name "before the map-sync version" and "the map-sync version or later" |
| 1.54-rc | 2026-11-26 | #173 Part 2 ([T22](T22-value-categorical-and-table-panels.md) I1, [ADR-0028](../adr/0028-chart-seam-bar-chart.md)): §7.1's T22 block adds `unit:frame-coverage`, `unit:category-colour`, `unit:barchart-layout`, `unit:barchart-labels`, `unit:barchart-fit-stages`, `unit:barchart-events`, `unit:barchart-selection`, `unit:barchart-ghost`, `unit:frame-data-categories` and `unit:barchart-plan` (PR) and the report-only `bench:frame-interim-categories`; `unit:autovis-table` adds row 11 beside row 8; `golden:interim-gallery` "eleven" → "sixteen" (the five bar charts), with baselines from the pinned e2e container (no hosted CI); `golden:greyscale` gains the five bar chart shots |
| 1.55-rc | 2026-11-26 | #198 Part 1 ([T24](T24-geo-schematic-and-widget-panels.md) A1): §7.1 adds `itest:board-spec-old-binary` (PR, blocking, run by `make itest-old-binary` for every board spec version change) and `itest:board-zones-grandfathered` (PR, blocking); `itest:board-tags-old-binary` skips unless the previous release predates the tags version (board spec 4); `unit:board-spec-widgets` notes that a `tz`'s existence is Go's, on writes, against the build's zone set |
| 1.56-rc | 2026-11-26 | #68 Part C1 (the engine in the browser): §7.1 `e2e:mode-matrix` defined for the engine legs; adds `golden:engine-line` (the browser engine on WebGL2/lavapipe vs the native renderer, mean ≤ 0.001, tile ≤ 0.05), `canvas2d parity` (sampled geometric parity: plot rect and a sampled line mask), `e2e:engine-recovery` and `ci:engine-gen`; `ci:probe-absent` scans every file and the fault sites; `e2e:csp-violations` engine leg under ADR-0026; WebGPU report-only in CI (SwiftShader cannot render; reason in `engine-legs.json`), real GPU on the hardware runner |
| 1.58-rc | 2026-11-26 | #68 Part C2a1 (the engine's input ring): §7.1 `e2e:shim-fuzz` is the adapter's records decoded identically in the probe build, with the rollover and wake cases; new `unit:input-ring`. Numbered after #216 Part 1's 1.57-rc |
| 1.57-rc | 2026-11-26 | #216 Part 1 ([T24](T24-geo-schematic-and-widget-panels.md) I2): §7.1 `itest:board-spec-old-binary` uses the newest version's fixture and refusal: at v6 N creates W from `v6-board-list.json` (first panel a board list), the previous release's create and save of W's spec → 400 `board.vis.kind.invalid` at `/panels/0/vis/kind`, and N saves V with a board list |
| 1.59-rc | 2026-11-26 | #198 Part 2a ([T24](T24-geo-schematic-and-widget-panels.md) A1; code review r1: computed keys, qualified `DOMParser`, `security/no-html-sink`, worker bundles in the module graph): §7.1 adds `ci:no-iframe` (the `security/no-iframe` rule in `ci:lint-ts`; PR, blocking), `unit:security-lint`, `unit:well-formed`, `unit:bundle-modules` and `unit:sanitise-bundle`; `ci:dep-audit` gains the module-graph check on every audited build; `unit:classify-url`, `unit:find-iframes` and `unit:import-text-iframe` (f11, f12) extended |
| 1.60-rc | 2026-11-26 | #198 Part 2b ([T24](T24-geo-schematic-and-widget-panels.md) A1): §7.1 adds `unit:markdown-depth`, `unit:markdown-root`, `unit:markdown-walk`, `unit:markdown-pathological`, `unit:markdown-flat-lines`, `unit:markdown-inline-depth`, `unit:markdown-surrogates`, `unit:markdown-xss-corpus` and `unit:xss-corpus-current` (PR, blocking); amends `fuzz:markdown-nodes` (the token sets, `checkInvariants` with `span`, `class`, `aria-hidden` and depth ≤ `MAX_DEPTH`, the imported result's invariants), `bench:markdown-render` (uncached), `unit:markdown-links` and `unit:markdown-images` (`ai` links, `/api/` and `/auth/` images) and `unit:sanitise-bundle` (the renderer in the probe). Numbered after #198 Part 2a's 1.59-rc; #173 Part 3a and #68 Part C2a2 are in flight with the same number, and whichever merges later renumbers |
| 1.61-rc | 2026-11-26 | #68 Part C2a2 ([ADR-0030](../adr/0030-engine-camera-controller-on-main.md)): §7.1 new `e2e:engine-camera`; `bench:shim-input-cost` report-only from #68 C2a2 (the synthetic subset); `e2e:shim-fuzz` adds DOM events. Numbered after #198 Part 2b's 1.60-rc |
| 1.62-rc | 2026-11-26 | #198 Part 3a ([T24](T24-geo-schematic-and-widget-panels.md) A1): §7.1 `ci:dep-audit` adds the Markdown module rules on each build's manifest; `unit:bundle-modules` adds the manifest fixtures; adds `unit:text-widget`, `unit:text-region`, `unit:text-overflow`, `unit:text-invalid`, `unit:text-widget-vars`, `unit:widget-add`, `unit:widget-editor`, `unit:widget-spec-roundtrip`, `unit:text-vis-roundtrip` and `unit:widget-registry-generic` |
| 1.63-rc | 2026-11-26 | #198 Part 3b ([T24](T24-geo-schematic-and-widget-panels.md) A1): §7.1 amends `e2e:widget-text` (the Add widget flow), `e2e:widget-text-xss` (the whole corpus in the browser against the load baseline, with canaries), `e2e:widget-a11y` (the Text rows) and `golden:widget-gallery` (the Text pages land); adds `unit:xss-e2e-cases`, `unit:widget-gallery-route` (PR, blocking) and `bench:text-widget-render` (report-only; `LONG_TASK_GATE=enforce`) |
| 1.64-rc | 2026-11-26 | #222 ([T24](T24-geo-schematic-and-widget-panels.md) part B2, I5): §7.1 `unit:entity-id` is in Go `entity/entity_test.go`; `itest:annotations-old-binary` runs by `make itest-old-binary` (local, skipping once the previous release has migration 5), with migration 5 beside a reader and the old binary listing N's entity rows |
| 1.65-rc | 2026-11-26 | #173 Part 3a ([T22](T22-value-categorical-and-table-panels.md) I1, [ADR-0029](../adr/0029-bar-chart-keys-and-brush.md)): §7.1's T22 block adds `unit:barchart-keys`, `unit:barchart-brush`, `unit:bar-list`, `unit:bar-list-selected`, `unit:bar-action`, `unit:mark-tooltip`, `unit:panel-table`, `unit:panel-table-active`, `unit:panel-table-button`, `unit:category-chart-table`, `unit:baseline-window` and `unit:barchart-options-field` (PR); `unit:barchart-events` (`PickEvent.source`, a drag brushes), `unit:board-options` (valid values on a kind change), `unit:inspector-model` (the `mark` target) and `unit:escape-ladder` (a marked listbox) amended. Numbered after #222's 1.64-rc (the earlier 1.56-rc to 1.64-rc rows are other issues') |
