# T02 — Vis engine

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.0-rc · 2026-11-18 |
| **Milestone** | M-UI0 (L0 runtime, M1/M3/M4/M8, decimation) → M-UI1 (axis system, overlays, band, Time Ribbon, gallery) → M-UI5 (panel parity breadth) |
| **Related ADRs** | [ADR-0003](../adr/0003-wgpu-rendering.md), [ADR-0007](../adr/0007-in-house-vis-engine.md), [ADR-0001](../adr/0001-rust-wasm-everywhere.md), [ADR-0002](../adr/0002-no-js-ui-framework.md), [ADR-0012](../adr/0012-derived-state-in-postgres.md) |
| **Source draft** | plans/tech/T02-vis-engine.md (not tracked) |

## 1. Context & problem

Browser JavaScript only proxies bytes and events (T01-001 in [T01](T01-frontend-architecture.md)).
That rules out every existing JS charting, mapping, 3D and graph-diagram library. **Every visualisation in
[05](../product/05-visualisation-catalogue.md) is built by us**, on wgpu (WebGPU, falling back to
WebGL2), and must meet the [09](../product/09-performance-contract.md) frame and volume contract.

This stays tractable because we do not build ~40 charts. We build:
1. about 12 GPU **mark primitives** (L1);
2. a shared layer of **scales, axes, legends, layouts, picking and interaction** (L2–L4);
3. each vis as a **declarative composition** of those (L5): a few hundred lines of Rust each, with
   no shaders of its own.

This is the grammar-of-graphics approach, implemented as a
GPU-native retained scene. The same grammar is the future third-party extensibility surface
([05 §11](../product/05-visualisation-catalogue.md#11-panel-parity-map)).

This document is **authoritative** for the mark primitives, the scene and viewport model, the axis
system, the shared L2–L4 layers, the vis → primitive mapping, capability tiers and the vis build
order. Data arrives as Arrow chunks ([T04](T04-wire-format-and-data-plane.md)); threads and memory
are [T03](T03-browser-runtime.md); tests are [T05](T05-testing-and-performance.md).

## 2. Goals / non-goals

**Goals**
- Every vis in [05](../product/05-visualisation-catalogue.md) as a spec over shared primitives, so
  LOD, picking, theming and the universal interactions are implemented once.
- Meet the scale targets of [05](../product/05-visualisation-catalogue.md) and the volumes of
  [09 §5](../product/09-performance-contract.md#5-volume-targets-single-viewport-or-scene) at
  60 fps, and ≥ 45 fps p99 on reference (b).
- Axes on a par with high-performance charting libraries: any number per side, per-axis interaction, time-shifted comparison axes.
- Identical look on WebGPU (T1) and WebGL2 (T2), and a native headless renderer for goldens and
  server-side images.
- Deterministic pixels for the same data, inputs and seed on the canonical backend.

**Non-goals**
- Layout-engine algorithms in depth (T14 (draft)); this doc lists them and their marks.
- DOM components: tooltips, legends with controls, the Inspector and tables of ≤ 10k rows are
  rendered by [T08](T08-dom-component-kit.md) from models this engine computes.
- Query planning and step choice ([T07](T07-scene-query-planner.md)).

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [VIZ-001](../product/05-visualisation-catalogue.md#viz-001--gpu-rendering-in-one-shared-scene) | §4.1, §4.6 | `e2e:no-dom-vis` |
| [VIZ-002](../product/05-visualisation-catalogue.md#viz-002--every-vis-is-a-composition-of-shared-mark-primitives) | §4.1, §4.8 | `ci:spec-lint` |
| [VIZ-003](../product/05-visualisation-catalogue.md#viz-003--universal-interactions-on-every-vis) | §4.6 | `replay:universal-interactions` |
| [VIZ-004](../product/05-visualisation-catalogue.md#viz-004--scale-targets-per-vis) | §4.2, §4.9, §7 | `bench:frame-gallery` (every page at its scale target, (b)) |
| [VIZ-005](../product/05-visualisation-catalogue.md#viz-005--lod-never-hides-signal-silently) | §4.4 | `unit:decimation-prop`; `golden:gallery` (density page shows the coverage reduction) |
| [VIZ-006](../product/05-visualisation-catalogue.md#viz-006--line-decimation-is-visually-lossless) | §4.4 | `golden:decimation-ref`; `replay:progressive` (rollup → raw switch) |
| [VIZ-007](../product/05-visualisation-catalogue.md#viz-007--band-collapses-the-crowd-and-keeps-outliers) | §4.4 | `golden:gallery` (band page, 800 series, 3 outliers, "797 in band") |
| [VIZ-008](../product/05-visualisation-catalogue.md#viz-008--scatter-density-and-point-modes) | §4.4, §4.9 | `bench:frame-scatter-1e7`; `replay:universal-interactions` (point click at < 10⁵ visible) |
| [VIZ-010](../product/05-visualisation-catalogue.md#viz-010--line-area-and-bar-style-options) | §4.5 | `golden:gallery` (style-option pages vs reference renders from the source tool) |
| [VIZ-011](../product/05-visualisation-catalogue.md#viz-011--overlays-on-any-time-vis) | §4.5 | `golden:gallery` (overlay pages, Line and Heatmap); `replay:per-axis` (overlays survive pan/zoom) |
| [VIZ-013](../product/05-visualisation-catalogue.md#viz-013--axes-are-first-class-objects) | §4.3 | `golden:gallery` (axes page: 3 left + 1 right) |
| [VIZ-014](../product/05-visualisation-catalogue.md#viz-014--axis-patterns-and-default-triggers) | §4.3 | `unit:axis-patterns` (Table 5-2 triggers, manual override) |
| [VIZ-015](../product/05-visualisation-catalogue.md#viz-015--time-shifted-comparison-axis) | §4.3 | `replay:compare-axis` |
| [VIZ-018](../product/05-visualisation-catalogue.md#viz-018--axis-count-hint) | §4.3 | `unit:axis-patterns` |
| [VIZ-019](../product/05-visualisation-catalogue.md#viz-019--axis-colour-and-ownership-glyph) | §4.3, §4.5 | `golden:greyscale` (axis-ownership glyphs) |
| [VIZ-020](../product/05-visualisation-catalogue.md#viz-020--per-axis-interaction) | §4.3 | `replay:per-axis`; `unit:axis-layout-prop` |
| [VIZ-021](../product/05-visualisation-catalogue.md#viz-021--crosshair-reads-every-bound-axis) | §4.3 | `replay:crosshair-sync` |
| [VIZ-022](../product/05-visualisation-catalogue.md#viz-022--overlays-declare-their-axis) | §4.3 | `unit:axis-layout-prop` (pan on axis A leaves marks on axis B pixel-identical); `replay:per-axis` |
| [VIZ-027](../product/05-visualisation-catalogue.md#viz-027--coverage-meter-on-every-viewport) | §4.4, §4.6 (co-satisfied with T04) | `replay:truncation` |
| [VIZ-039](../product/05-visualisation-catalogue.md#viz-039--bullet-preferred-for-value-vs-threshold) | §4.7 | `unit:autovis-table` |
| [VIZ-042](../product/05-visualisation-catalogue.md#viz-042--rows-are-selection-sources) | §4.6 | `replay:selection-sources` |
| [VIZ-054](../product/05-visualisation-catalogue.md#viz-054--markdown-and-html-are-always-sanitised) | §4.5 (canvas text; co-satisfied with T08, T18) | `unit:text-flow-sanitise` |
| [VIZ-057](../product/05-visualisation-catalogue.md#viz-057--field-configuration-parity) | §4.5 | `golden:native-browser` (field-config page: browser vs native identical); `unit:number-format` |
| [VIZ-065](../product/05-visualisation-catalogue.md#viz-065--auto-vis-rules) | §4.7 | `unit:autovis-table`; `e2e:deep-link` (override persists on reload) |
| [VIZ-066](../product/05-visualisation-catalogue.md#viz-066--table-view-and-csv-for-every-vis) | §4.6 (co-satisfied with T08) | `e2e:table-csv` |
| [VIZ-067](../product/05-visualisation-catalogue.md#viz-067--colour-is-never-the-only-channel) | §4.2 | `golden:greyscale` |
| [VIZ-069](../product/05-visualisation-catalogue.md#viz-069--gallery-is-the-vis-test-corpus) | §4.9 (co-satisfied with T05) | `ci:gallery-manifest` |
| [VIZ-070](../product/05-visualisation-catalogue.md#viz-070--gallery-runs-on-seeded-synthetic-data) | §4.9 (co-satisfied with T05) | `e2e:gallery-offline`; `golden:gallery` (two seeded runs identical) |
| [IA-003](../product/02-information-architecture.md#ia-003--scenes-are-trees-of-viewports) | §4.6 | `unit:scene-model` |
| [IA-014](../product/02-information-architecture.md#ia-014--the-space-camera-transitions-never-page-loads) | §4.6 | `replay:space-transitions` |
| [IA-020](../product/02-information-architecture.md#ia-020--time-ribbon-is-always-visible) | §4.6 | `replay:time-ribbon` |
| [INT-002](../product/03-interaction-model.md#int-002--cursor-anchored-zoom) | §4.6 | `unit:camera-controller` (100 random wheel steps, < 1 px drift) |
| [INT-003](../product/03-interaction-model.md#int-003--inertia) | §4.6 | `unit:camera-controller` (settle 300 ± 50 ms, no overshoot, interrupt next frame) |
| [INT-004](../product/03-interaction-model.md#int-004--smooth-programmatic-transitions) | §4.6 | `bench:camera-transition`; `replay:reduced-motion` |
| [INT-007](../product/03-interaction-model.md#int-007--mouse-and-trackpad-bindings) | §4.6 (co-satisfied with T03) | `replay:mouse-bindings` |
| [INT-008](../product/03-interaction-model.md#int-008--per-axis-pan-zoom-and-fit) | §4.3 | `replay:per-axis` |
| [INT-017](../product/03-interaction-model.md#int-017--time-scrub) | §4.6 | `replay:time-scrub` |
| [INT-025](../product/03-interaction-model.md#int-025--window-brush) | §4.6 | `replay:time-ribbon` |
| [INT-026](../product/03-interaction-model.md#int-026--global-time-cursor-and-replay) | §4.3, §4.6 | `replay:crosshair-sync` |
| [INT-028](../product/03-interaction-model.md#int-028--live-mode) | §4.6 (co-satisfied with T04) | `replay:live-scroll` |
| [INT-030](../product/03-interaction-model.md#int-030--comparison-baseline-ghost) | §4.3, §4.5 | `golden:gallery` (ghost page); `replay:compare-axis` |
| [INT-031](../product/03-interaction-model.md#int-031--events-on-the-time-axis) | §4.5, §4.6 | `replay:events-markers` |
| [INT-033](../product/03-interaction-model.md#int-033--hover-tooltip) | §4.6 | `replay:universal-interactions` (value, labels, Δ within one frame) |
| [AUD-041](../product/01a-audiences-and-perspectives.md#aud-041--show-data-trust) | §4.4, §4.6 (co-satisfied with T04) | `golden:gallery` (gap page shows a break); `replay:truncation` |
| [VL-001](../product/08-visual-language.md#vl-001--dark-first-themes-both-designed) | §4.2 | `golden:gallery` (dark tokens); `ci:token-lint` |
| [VL-002](../product/08-visual-language.md#vl-002--neutral-series-palette-with-stable-identity-colours) | §4.2 | `ci:palette-check`; `unit:colour-hash` |
| [VL-003](../product/08-visual-language.md#vl-003--state-colours-are-reserved-for-health) | §4.2 | `ci:token-lint` (state tokens only on health encodings) |
| [VL-006](../product/08-visual-language.md#vl-006--ramps) | §4.2 | `ci:spec-lint` (diverging ramp only on delta encodings) |
| [VL-008](../product/08-visual-language.md#vl-008--cvd-safe-palettes-and-wall-high-contrast) | §4.2 | `ci:palette-check` |
| [VL-010](../product/08-visual-language.md#vl-010--fonts) | §4.2 | `e2e:font-origin` |
| [VL-011](../product/08-visual-language.md#vl-011--canvas-text-matches-dom-text) | §4.2 | `e2e:text-dom-match` |
| [VL-012](../product/08-visual-language.md#vl-012--numbers-for-humans) | §4.5 | `unit:number-format` |
| [VL-013](../product/08-visual-language.md#vl-013--density-modes) | §4.2 | `golden:gallery` (Compact and Comfortable variants) |
| [VL-014](../product/08-visual-language.md#vl-014--purposeful-motion-only) | §4.2 | `replay:motion-audit` |
| [VL-015](../product/08-visual-language.md#vl-015--no-spinners-on-data) | §4.2, §4.4 | `replay:progressive` (no spinner; shimmer only after 300 ms) |
| [VL-016](../product/08-visual-language.md#vl-016--reduced-motion) | §4.2, §4.6 | `replay:reduced-motion` |
| [VL-019](../product/08-visual-language.md#vl-019--layout-grid) | §4.6 | `golden:gallery` (layout audit: 4 px grid, 8 px gutters, 6 px radius) |
| [VL-020](../product/08-visual-language.md#vl-020--fixed-glyph-language) | §4.2 | `ci:spec-lint` (glyphs only from the `Glyph` enum and one icon set) |
| [VL-022](../product/08-visual-language.md#vl-022--component-and-mark-libraries-share-the-tokens) | §4.2 | `ci:token-lint` |
| [PRF-001](../product/09-performance-contract.md#prf-001--frame-rate-during-interaction) | §4.2, §4.4, §7 | `bench:frame-gallery`; `bench:frame-high-hz` |
| [PRF-002](../product/09-performance-contract.md#prf-002--frame-rate-floor) | §4.2, §4.4, §7 | `bench:frame-gallery` |
| [PRF-007](../product/09-performance-contract.md#prf-007--camera-transition-duration) | §4.6 | `bench:camera-transition` |
| [PRF-016](../product/09-performance-contract.md#prf-016--10⁸-line-chart-points) | §4.4 | `bench:frame-line-1e8`; `golden:gallery` (1 ms adjacency at epoch-scale timestamps) |
| [PRF-017](../product/09-performance-contract.md#prf-017--10⁷-scatter-points) | §4.4, §4.9 | `bench:frame-scatter-1e7` |
| [PRF-018](../product/09-performance-contract.md#prf-018--10⁴-series-per-scene) | §4.4 | `bench:frame-series-1e4` |

## 4. Design

### 4.1 Layered architecture

```
 ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 │ L5  Vis specs        timeseries · heatmap · scatter · table-grid · flame · waterfall ·     │
 │                      atlas-graph · city · hexwall · geomap · schematic · sankey · …       │  ← declarative, no GPU code
 ├───────────────────────────────────────────────────────────────────────────────────────────┤
 │ L4  Guides & interaction   axes/ticks · gridlines · legends · crosshair · brush · lasso ·  │
 │                            tooltip anchors · zoom/pan controllers · selection model        │
 ├───────────────────────────────────────────────────────────────────────────────────────────┤
 │ L3  Layout engines   squarified treemap · force (Barnes–Hut) · layered (Sugiyama) ·         │
 │                      edge bundling · Sankey · hex/grid tiling · flame/icicle · waterfall ·  │  ← layout worker
 │                      text flow · map projection · schematic constraints                    │
 ├───────────────────────────────────────────────────────────────────────────────────────────┤
 │ L2  Scales & transforms   linear · log · symlog · time (tz-aware) · discontinuous time ·    │
 │                           band · ordinal · colour (sequential/diverging/categorical/        │
 │                           threshold) · stacking · binning · decimation · KDE · reduce       │
 │                           (Rust, shared with the local engine and the BFF)                  │
 ├───────────────────────────────────────────────────────────────────────────────────────────┤
 │ L1  Mark primitives (instanced GPU pipelines, §4.2)                                         │
 ├───────────────────────────────────────────────────────────────────────────────────────────┤
 │ L0  Scene & GPU runtime   retained scene graph · viewports/cameras · buffer arena over     │
 │                           SharedArrayBuffer · pipeline cache · picking ID buffer · frame    │
 │                           scheduler · WebGPU/WebGL2 capability tiers · native backend      │
 └───────────────────────────────────────────────────────────────────────────────────────────┘
```

- **L0–L2 are written once** and sized for the performance contract.
- **L3** algorithms are pure Rust, run in the layout worker, and are unit-tested natively.
- **L5 specs** are data plus encodings, so new vis types are cheap, and so is dashboard import
  mapping.

#### T02-001 — Every vis is an L5 spec over L1 marks
**MUST** — Every vis MUST be an L5 spec that composes L1 mark primitives, L2 scales and L3 layouts.
A spec MUST NOT contain WGSL, create a pipeline or call wgpu directly. A spec that needs a new
visual technique MUST get it as a new or extended L1 primitive owned by the vis-platform team.

#### T02-002 — Instanced, columnar, one draw per mark type per viewport
**MUST** — Each mark primitive MUST be instanced and fed from columnar (Arrow-layout) buffers in the
chunk arena or render staging slabs ([T04 §5.7](T04-wire-format-and-data-plane.md#57-zero-copy-path-from-network-to-gpu)).
Within one viewport, marks of one type MUST be drawn in one draw call per pipeline state,
independent of how many series or axes they belong to (§4.3).

### 4.2 Mark primitives (L1)

Every pixel of every vis comes from one of these pipelines.

| # | Mark | GPU technique | Used by |
|---|---|---|---|
| M1 | **Polyline** | Instanced segments with miter/round joins in the vertex shader; screen-space width; dashes via a distance attribute; per-vertex colour; breaks at null validity | Line, trend, XY lines, sparkline, routes, thresholds, gridlines, event markers |
| M2 | **Area / band** | Triangle strip between two y columns (y0/y1); stacking computed in L2 | Area, stacked, min/max band, confidence cone, baseline ghost |
| M3 | **Rect** | Instanced quads with optional corner radius and border via an SDF in the fragment shader | Bars, heatmap cells, status history, state timeline, treemap, bar gauge, bullet, waterfall spans, flame frames, table-grid cells, calendar, Time Ribbon density strip |
| M4 | **Point / sprite** | Instanced quads with SDF shapes (circle, square, diamond, triangle, cross) or atlas icons; size, colour and alpha per instance | Scatter (10⁷), XY/bubble, exemplars, markers, event glyphs |
| M5 | **Arc / wedge / ring** | Instanced quads; arc evaluated analytically in the fragment shader (no tessellation) | Pie/donut, gauge, node health rings, RED donuts, radar fill (with M7) |
| M6 | **Edge / curve** | Quadratic/cubic Bézier and great-circle arcs evaluated in the vertex shader; width/colour along t; **flow particles** as a time-animated M4 pass along the same curve | Atlas edges, bundled edges, Sankey links, geo arcs, schematic connectors |
| M7 | **Path / polygon** | CPU tessellation (`lyon`) in the layout worker → indexed triangles, cached; outline via M1 | GeoJSON regions, schematic shapes, hulls (incident boundaries, territories), radar, violin |
| M8 | **Text** | MSDF glyph atlas; shaping in the layout worker (`rustybuzz` / `cosmic-text`); instanced glyph quads; per-glyph colour; clipping and ellipsis in L4 | Axes, labels, legends, logs, GPU table grid, node labels, flame labels |
| M9 | **Image / icon** | Texture atlas (SVG icons rasterised at needed sizes with `resvg`); instanced quads | Icons, entity glyphs, the glyph language, schematic images, chart thumbnails |
| M10 | **Density field** | Compute shader splats points into a float texture (KDE / count) → colormap pass. WebGL2 tier: additive blending into a float FBO | Zoomed-out scatter, geo heatmap, "too many points" fallback anywhere |
| M11 | **Mesh / box (3D)** | Instanced boxes and hexagonal prisms with simple lighting + SSAO-lite; height-field mesh for surfaces | City, 3D surface, trace skyline, extruded hexbins |
| M12 | **Raster / vector tile** | Raster tiles as textured quads; vector tiles (MVT, decoded in a satellite worker with `prost`) → M7 + M1 + M8 | Geomap basemaps |

Cross-cutting mark features, implemented once in L0/L1:
- **Picking.** Every mark writes an instance ID to an offscreen ID buffer. Hover and click read one
  pixel, so hit-testing is O(1) at any count. On the WebGL2 tier the ID buffer uses R32UI where it is
  supported, and RGBA8 packing otherwise. Axis bands own an ID range (§4.3).
- **Clipping and scissoring** per viewport and per stacked lane.
- **Transitions.** Tweening between two instance buffers for the 250 ms morphs and the 150 ms data
  crossfade, done on the GPU by interpolating attributes.
- **State encodings** (five-state health, victim dashed ring, active-alert pulse) are uniforms and
  attributes shared by all marks, so semantic state looks identical everywhere (T02-003).
- **Dash patterns and hatching** (Unknown, NoData, maintenance, victim) are made in the fragment
  shader, not textures.
- **Colour.** All blending is in linear space. Every colour comes from the generated tokens
  ([T01 §4.5](T01-frontend-architecture.md#45-one-token-source-for-canvas-and-dom)), which the DOM
  shares.

#### T02-003 — State is always encoded twice
**MUST** — Every health-state encoding MUST set both the state colour token and the state glyph or
ring style from one shared `StateEncoding` uniform block: OK `ok` ●, Watch `watch` ◐, Degraded
`degraded` ◉, Failing `failing` ■, Unknown `unknown` with hatch ○. Rings are solid (normal / origin),
dashed (victim) or pulsing at 1 Hz with low amplitude (active, un-acknowledged alert). Series
identity on multi-axis or multi-series views MUST also carry a non-colour channel (dash pattern,
marker shape or legend glyph).

#### T02-004 — Colours come only from tokens, by role
**MUST** — Marks MUST take colours only from the generated tokens through typed roles:
`SeriesColour` (from `series-1`…`series-8`), `StateColour` (from `ok`…`unknown`, reachable only through
`StateEncoding`), `SequentialRamp` (perceptually uniform, single-hue for density, OKLab-interpolated
LUT) and `DivergingRamp` (blue ↔ red, constructible only from a `DeltaEncoding`). A spec MUST NOT be
able to bind a state colour to an ordinary series or a diverging ramp to a non-delta field.

#### T02-005 — Stable series colour
**MUST** — A series' colour MUST be `series-{1 + (key_hash mod 8)}`, where `key_hash` is the
`xxh3_64` of the canonical label set ([T04 §4.2](T04-wire-format-and-data-plane.md#42-conventions-for-every-schema)),
so the same series has the same colour on every chart, in every session and after reload. A user
override MAY pin a colour per series key.

#### T02-006 — Canvas text uses the DOM's fonts
**MUST** — M8 MUST render from MSDF atlases built from the same self-hosted Inter (UI, tabular
numerals where numbers align) and JetBrains Mono (data, code, labels) font files that the DOM loads,
and shape with the same OpenType features. Canvas and DOM text of the same string at the same size
MUST differ by ≤ 1 px in advance width and baseline. No font MAY be fetched from a third-party host.

#### T02-007 — Motion is enumerated
**MUST** — The engine MUST animate only through the `Motion` enum: camera transition (≤ 250 ms,
ease-out), data crossfade (150 ms), active-alert ring pulse (1 Hz), edge particles, the loading
shimmer (viewport edge, only after a load has taken > 300 ms) and LIVE scroll (§4.6). No spinner MAY
be drawn on data. With `prefers-reduced-motion`, transitions and crossfades MUST be instant cuts,
particles MUST be replaced by static dashes whose thickness encodes traffic, and the alert pulse MUST
become a static double ring.

Theme and density are token sets (dark default; light from M-UI5; wall high-contrast from M-UI6;
Comfortable and Compact density, Wall ×1.6 from M-UI6), switched by the `Prefs` message. The
palette validator (`xtask palette-check`) checks every palette in every theme for CVD
distinguishability (deuteranopia, protanopia, tritanopia), the series palette for equal lightness
(±3 L*), and the wall variant for ≥ 7:1 text and ≥ 3:1 state-mark contrast against `canvas`.

#### T02-008 — One glyph language
**MUST** — Glyphs (◆ deploy, ⚙ config, ⚑ flag, ⚠ alert, ⊕ probable origin, ✚ investigation, ✦ AI,
⟶ pivot, the five state glyphs, ⫽ axis break) MUST be drawn only through the `Glyph` enum, which
maps each to exactly one meaning and to one single-weight line icon set in the M9 atlas.

### 4.3 Axis system

This serves the patterns in [05 §1.1](../product/05-visualisation-catalogue.md#11-axes-as-a-design-tool)
(Table 5-2), with a first-class axis model of ids, alignment and binding. It is the engine side
that [05](../product/05-visualisation-catalogue.md) refers to as "T02 §3.1" (renumbered here to fit
the template).

**Axis model.** An `Axis` has:
- `id` (`AxisId`, a short string unique in the viewport);
- `role` (X | Y);
- `alignment` (Top | Bottom | Left | Right | Centre(base value));
- `scale` (time | linear | log | symlog | discontinuous-time | band);
- `visible_range`, with an auto-fit policy (`grow_by`, soft min/max, or manual);
- `manual_pin: bool`, set by any per-axis interaction and cleared by fit;
- `stack_group` (axes in the same group split the plot's height or width into lanes);
- `style` (colour, background tint, border side, label format, ownership glyph);
- `interaction` flags (drag-pan, wheel-zoom, static);
- `origin` (`Auto` | `User`), so auto-configuration never overrides user axes.

Marks, thresholds, annotations and event markers bind by `x_axis_id` / `y_axis_id`. Omitting them
binds to the default pair. Viewport specs carry an `axes[]` array, and the single-axis case is sugar
for it.

**Coordinate transform.** Each axis contributes one affine (or log, symlog or discontinuous)
transform from data space to plot space. The transforms are packed into a per-viewport uniform array
of at most 16 axes. Every mark instance carries an 8-bit axis-pair index, so series on different
axes share a draw call, and no re-upload happens when one axis pans: only its uniform changes.
Discontinuous time uses a piecewise-linear table (≤ 64 segments) in a small storage buffer (a
texture on T2). Data offsets are relative to the chunk origin (T02-014), and each axis transform is
computed in f64 on the CPU before it is written to the f32 uniform.

**Layout solver.** Each frame, axis bands are measured. Tick labels are shaped in the layout
worker, and the widest label is kept across the hysteresis window. The plot rect is the remainder
after the bands. Stacked lanes are laid out with a gap and a lane title (≤ 8 lanes, M-UI2).
Central axes are drawn inside the plot at the data position of their base value. "Draw behind
axes" sets the plot rect to the full viewport and draws the bands translucently on top.

**Picking and interaction.** Axis bands are pick targets (an ID range in the picking buffer). The
interaction controller routes:
- drag on a band to a single-axis pan;
- wheel on a band to a single-axis zoom around the cursor;
- double-click on a band to fit that axis and clear its manual pin.

Each produces a `Command::AxisRange` into the state store ([T03 §4.4](T03-browser-runtime.md#44-state-ownership)),
so it is undoable, and sets `manual_pin`, which shows the manual-range pin glyph on the axis.

**Comparison (time-shifted) axis.** When the baseline ghost (`Shift+C`, M-UI1) or A/B Everything
(`C`, M-UI6) is on, the comparison window gets its own Top time axis, styled in the comparison
colour and labelled in real time ("last Tue 14:00"), not as an offset. A drag on it emits
`Command::CompareOffset(Δt)`, so the offset is shared, undoable and visible to collaborators
(T17 (draft)). "Align on onset" (M-UI3, SHOULD) calls the T15 (draft) Stage-1 onset detector for
both windows and sets the offset.

**Crosshair.** The crosshair inverts every bound axis at the cursor and reports per-axis values,
including the comparison window's real time, as one line ("12:22 · 1.8k rps · p99 2.4 s · last Tue
12:22 · 0.4 s"). Snapping is per series, on its own axes. The cursor instant is the Context's global
time cursor, so every time viewport in the scene draws it in the same frame.

**Auto-configuration.** `dash-axes::auto` applies the Table 5-2 triggers in order: incompatible units
→ secondary Y; Compare on → comparison top X; range > 3 decades → log/symlog; Lens header → stacked
lanes (M-UI2); Compare "Difference" → central axis (M-UI3); live on wall → static X (M-UI5); known
recurring gaps → discontinuous (M-UI5); side-by-side with a vertical list → rotated (M-UI4);
wall/TV or tiles < 200 px → draw behind axes (M-UI5). Patterns are gated by the milestone feature
set.

#### T02-009 — Axes are first-class and bindable
**MUST** — A viewport MUST accept any number of axes per side (engine limit 16 per viewport). Every
series, threshold, annotation and event marker MUST name, or default to, the axis it is bound to, and
MUST be positioned only through that axis's transform.

#### T02-010 — Panning one axis never moves marks bound to another
**MUST** — A change to one axis's range MUST change only that axis's uniform. Every mark bound to a
different axis MUST be pixel-identical before and after.

#### T02-011 — Axis bands do not jitter
**MUST** — Axis band widths MUST grow immediately and MUST shrink only after 500 ms of stable
measurement. Bands MUST NOT overlap, and tick labels MUST NOT collide, including across stacked
lanes.

#### T02-012 — Per-axis interaction is undoable and visible
**MUST** — Drag, wheel and double-click on an axis band MUST affect only that axis, MUST go through
the state store as an undoable command, and MUST set or clear the manual-range pin accordingly.

#### T02-013 — Auto-configuration is bounded and yields to the user
**MUST** — Auto-configuration MUST create at most 2 axes per side (stacked lanes excluded) and MUST
apply a Table 5-2 pattern only when its trigger holds, its milestone is enabled and the viewport's
axes have `origin = Auto`. Adding a third axis on one side by hand MUST be allowed and MUST raise the
"consider stacking" hint. When more than one axis is on a dimension, each axis MUST take its series'
colour and each series MUST show the matching ownership glyph in the legend.

### 4.4 LOD, decimation and precision

| Strategy | Mechanism | Coverage disclosure |
|---|---|---|
| Line decimation | GPU compute (T1) or pool SIMD (T2): per pixel column, min/max/first/last of every series; deterministic (fixed chunking, order-independent reductions) | none needed: visually lossless |
| Rollup → raw switch | When the visible step drops below the stored rollup resolution, the viewport asks the planner for raw data ([T07](T07-scene-query-planner.md)) and keeps drawing the rollup until raw arrives | source badge changes to raw/exact |
| Band + outliers | When a viewport holds > 50 series of one metric: per pixel column min/max/avg across series (M2) plus every series that leaves the band (M1); legend "N in band" | none: outliers are always drawn |
| Scatter | M4 sprites with density-based alpha; above the tier's sprite ceiling of visible points, M10 density field; below 10⁵ visible points, individually pickable sprites | "density view" |
| Heatmap / status history | Re-bucket/re-bin to pixel width on GPU; worst state wins when merging states | "re-binned ×n" |
| Memory pressure | Raw chunks dropped for rollups ([T04](T04-wire-format-and-data-plane.md)) | "reduced resolution (memory)" |
| Tier ceiling | T2 ceilings (§4.9) | "density view: WebGL2 tier" |

**Gaps.** A null in the validity bitmap breaks M1 and M2 strips. The default null handling is
"gaps": absent samples are drawn as gaps and never interpolated. "Connect under a threshold" and
"zero" are explicit options (§4.5).

#### T02-014 — Precision: f32 relative to a per-chunk origin
**MUST** — Values and timestamps MUST be uploaded as f32 relative to a per-chunk origin (`t_rel`,
`v_rel`), and every camera and axis transform MUST be composed in f64 on the CPU before it is reduced
to f32. Adjacent 1 ms samples at epoch-scale timestamps MUST render at distinct x positions at the
deepest zoom.

#### T02-015 — Decimation is visually lossless and deterministic
**MUST** — Line decimation MUST keep min, max, first and last per pixel column per series, so that
for every pixel column the raw extremes appear in the output, and MUST produce identical pixels for
identical inputs on every frame and thread count.

#### T02-016 — LOD keeps extremes and says so
**MUST** — Every LOD reduction MUST preserve outliers, peaks and worst states, and every reduction
that is not visually lossless MUST be reported to the viewport's coverage model, which is merged with
the wire coverage block ([T04 §5.3](T04-wire-format-and-data-plane.md#53-coverage-block-coverage1-r10)).

#### T02-017 — Band collapses the crowd and keeps outliers
**MUST** — When a time-series viewport with vis "auto" holds more than 50 series of the same metric,
it MUST draw the min/max/avg band, MUST draw individually every series outside the band, and MUST
list the rest in the legend as "N in band".

### 4.5 Shared layers (L2–L4)

These make charts feel professional, and they take longer than the shaders.

| Component | Must handle |
|---|---|
| **Time scale and ticks** | Nice intervals from ms to years; DST transitions; per-user and per-viewport time zone (IANA db, `chrono-tz`, lazily loaded); multi-timezone axes; fiscal weeks; relative ("−7d") and real-time comparison labels |
| **Numeric ticks and units** (`dash-units`) | Nice numbers; log/symlog decades; the full unit catalogue ([05 §10](../product/05-visualisation-catalogue.md#10-vis-configuration-field-config-parity)); SI/IEC prefixes; durations ("1h 3m"); currency; locales. Human formatting: `2.84 s`, `1.2k rps`, `€38k/h`, `since 12:22 (40 min)` |
| **Label collision** | Axis label thinning, node and flame label culling, greedy placement with priorities, ellipsis; no overlapping text ever (`rstar` index) |
| **Legends** | List/table legends with values, click to isolate, shift-click to multi-select; colour-ramp and size legends; axis-ownership glyphs. Interactive legends render in DOM from a core model |
| **Colour scales** (`dash-colour`) | Perceptual ramps (OKLab interpolation), categorical palettes stable per series key, threshold scales, CVD-safe sets (T02-004, T02-005) |
| **Decimation and binning** | §4.4 |
| **Style options** | Interpolation (linear, smooth, step-before, step-after); null handling (gaps, connect under a threshold, zero); gradient (opacity, hue, scheme); stacking groups; log/symlog; soft min/max; negative-Y transform; per-series overrides (M-UI5 for the full Table 5-10 override set) |
| **Overlays** | Baseline ghost band (M2 on the comparison axis) and anomaly band (expected range); threshold lines and areas; time regions; event markers (◆ ⚙ ⚠ as M1 verticals + M9 glyphs); exemplars (M4, M-UI2); forecast (dashed M1 + M2 cone); annotations; cursor sync. Each overlay declares its axis (T02-009). Anomaly and forecast bands read Dash-derived baselines from Postgres virtual sources ([ADR-0012](../adr/0012-derived-state-in-postgres.md)) |
| **Field configuration** (`dash-fieldcfg`) | Units and formatting, thresholds, legends, tooltips (M-UI1); value mappings, overrides, data links, transformations, repeat (M-UI5). Compiled into core, the BFF and the native renderer |
| **Text flow** | Logs, GPU table grid, Markdown on canvas: wrapping, ANSI colours, JSON pretty-print. Markdown is parsed (`pulldown-cmark`) into styled glyph runs; raw HTML and script are dropped and counted |
| **Interaction controllers** | §4.6 |
| **Tooltips and Inspector anchors** | Computed in Rust; rendered in DOM by the shell at a GPU-provided anchor, so they are accessible and selectable |
| **A11y mirror and table view** | Per viewport: table model generated from the same chunks ([05 §13](../product/05-visualisation-catalogue.md#13-accessibility-of-data-vis)); screen-reader summary at M-UI6 |

#### T02-018 — One formatting and field-config implementation
**MUST** — Units, number formatting, thresholds, value mappings and overrides MUST be evaluated by
the single `dash-fieldcfg` / `dash-units` implementation, linked into the browser core, the BFF and
the native renderer, so the same input produces byte-identical labels and colours everywhere.

#### T02-019 — Canvas text never executes markup
**MUST** — Text flow MUST render Markdown only as styled glyph runs and MUST drop raw HTML, script,
event handlers and iframes. Canvas text MUST NOT be handed to the DOM as HTML. DOM-rendered Markdown
is sanitised by [T08](T08-dom-component-kit.md) under [T18](T18-security.md)'s rules.

### 4.6 Interaction controllers and the scene

**Scene model.** A scene is a tree of viewports (L0). Each viewport node holds:
- a data binding (a signal query or an entity-relative template, resolved by
  [T07](T07-scene-query-planner.md));
- a vis spec (`auto` or explicit, with the user override persisted with the viewport);
- a camera and `axes[]`;
- overlays.

Viewports are laid out on the 4 px grid with 8 px gutters, 6 px corner radius and 1 px `hairline`
borders, in CSS px multiplied by `dpr`. Off-screen viewports neither render nor query.

**Space residency.** The scene stack is resident: the previous scene's buffers, camera and chunks
stay in memory, so "back" and `Esc` show the previous scene in the first frame with no query. Under
memory pressure at least the immediate parent scene is kept.

**Camera controllers** (`dash-scene::camera`):
- **Zoom anchor.** Zoom is computed in f64 data space about the data coordinate under the pointer,
  which is re-inverted after the zoom so that it stays under the pointer (< 1 px drift). In 3D, dolly
  moves toward the picked point.
- **Inertia.** A flick (release velocity above 0.3 px/ms) continues as a critically damped spring,
  `x(t) = (1 + ωt)·e^(−ωt)` with ω = 19.4 s⁻¹, which settles within 2 % in 300 ms and never
  overshoots. Any new input record stops it on the frame that reads the record.
- **Programmatic transitions** (focus, back, dive, AI "show me") are eased flights (ease-out) of
  ≤ 250 ms, with in-flight morphing of the clicked object into the next frame. With reduced motion
  the next frame shows the final pose.
- **Committed moves.** A move is committed at gesture end (pointer up after inertia settles; wheel
  idle 300 ms; transition end; key repeat end). Each commit is pushed to camera history
  ([T03 §4.6](T03-browser-runtime.md#46-url-history-and-camera-encoding)).

**Input mapping.** The [03 §4.1](../product/03-interaction-model.md#41-mouse-and-trackpad-primary)
mouse/trackpad table is implemented by the L4 controller, consuming pointer and wheel records from
the input ring ([T03 §5.4](T03-browser-runtime.md#54-input-ring-record-format)): wheel zooms X around
the cursor, `Shift`+wheel zooms Y, `Ctrl`/`⌘`+wheel zooms both; left drag pans with inertia; right
drag box-zooms; middle drag pans; `Alt`+left drag brushes time; hover drives crosshair and tooltip;
click selects; double-click fits (2D) or dives (3D); axis-band gestures are per-axis (§4.3).
Keyboard actions arrive as commands from the keymap ([T03 §4.5](T03-browser-runtime.md#45-keymap-and-input-contexts)).

**Universal interactions.** Every L5 spec implements the `Universal` trait: hover crosshair synced on
time, click → Inspector, brush, baseline ghost, anomaly overlay and pivot chips. A spec where an
interaction has no meaning (a time crosshair on a categorical bar chart) MUST still accept it and
return a reason string, which the tooltip shows.

**Selection model.** Selection is a set of keys (series key, entity id, span id) in the Context.
Marks, DOM table rows (`Command::Select` from the shell) and the Inspector all write the same
selection, and every viewport highlights the selected keys.

**Tooltips.** On a hover record, the controller picks the instance, reads the f64 originals from the
arena, formats value, labels and Δ vs the Context baseline, and emits a `TooltipAnchor` on the
core → ui ring in the same frame. The shell renders it on its next animation frame.

**Time Ribbon.** A reserved GPU viewport at the bottom of the canvas: an M3 anomaly-density strip and
M9 event glyphs across a zoomable long range, with the active window as a brush. Dragging an edge
resizes the window, dragging the body moves it, and the wheel zooms the overview strip; the Context
time updates on release. Events are clickable and set a before/after comparison around them.

**Time scrub.** `Space` held (≥ 250 ms, [T03 §4.5](T03-browser-runtime.md#45-keymap-and-input-contexts))
plus horizontal motion moves the global time cursor in proportion to the Ribbon scale, every frame;
release commits.

**LIVE.** In LIVE mode the X transform advances every frame by the frame-clock `dt` (sub-pixel), not
by the data refresh interval. New points append to the open chunk and are picked up by the same
uniform, so the line scrolls smoothly with no jump larger than 1 px.

#### T02-020 — Scenes are trees of viewports
**MUST** — Every GPU surface MUST be a scene of viewports, each with a data binding, vis, camera/axes
and overlays, and a viewport MUST keep all four when it is moved between scenes.

#### T02-021 — Zoom is cursor-anchored
**MUST** — Every zoom MUST keep the data point under the pointer under the pointer, in 2D and 3D,
with < 1 px drift per step.

#### T02-022 — Inertia is a critically damped spring
**MUST** — Flick-pan inertia MUST follow the critically damped spring above (settling in
300 ± 50 ms, no overshoot), and MUST stop on the frame in which any new input record is read.

#### T02-023 — Universal interactions everywhere
**MUST** — Every L5 spec MUST implement the `Universal` trait. A spec MUST NOT reject a universal
interaction; where it does not apply, it MUST return a reason for the tooltip.

#### T02-024 — Hover answers within one frame
**MUST** — Hover → picking → `TooltipAnchor` MUST complete inside the frame that consumed the hover
record, and the crosshair MUST move in every time viewport of the scene in that same frame.

#### T02-025 — Selection is shared
**MUST** — Selections from marks, table rows and the Inspector MUST write the same Context selection,
and every viewport MUST highlight it on the next frame.

#### T02-026 — Space moves are camera transitions and scenes stay resident
**MUST** — Moving between Space scenes MUST be a camera transition of ≤ 250 ms (an instant cut with
reduced motion). The previous scene MUST stay resident, so returning to it draws its previous data in
the first frame without a new query.

#### T02-027 — LIVE scrolls by the frame clock
**MUST** — In LIVE mode, the time axis MUST advance by wall-clock frame time every frame, so motion is
sub-pixel and never jumps by more than 1 px on a data refresh.

### 4.7 Auto-vis

`dash-autovis` is a pure function `(data shape, signal, metric type, series count, thresholds,
perspective preset, milestone features) → vis id`. It applies
[05 §12](../product/05-visualisation-catalogue.md#12-auto-vis-decision) Table 5-13 top to bottom and
returns the first rule whose vis is available at the build's milestone. A Perspective changes only
the encoding preset. Rule 7 returns Bullet when the single value has a threshold or target, never
Gauge; Gauge remains available explicitly and on import.

#### T02-028 — Auto-vis is Table 5-13, first match wins
**MUST** — Auto-vis MUST evaluate Table 5-13 in order and take the first match restricted to the
milestone feature set, MUST NOT let a Perspective change which rule matches, and MUST honour a
persisted user override.

### 4.8 Every vis in 05 mapped to primitives

| Vis | Marks | Scales/guides | Layout |
|---|---|---|---|
| Line / area / bars over time | M1, M2, M3 | time × linear/log, axes, legend, thresholds | — |
| Band + outliers | M2, M1 | same | outlier selection (L2) |
| Heatmap / status history / calendar | M3 | time × band, colour ramp | binning |
| State timeline | M3, M8 | time × band, value mappings | run-length merge |
| Scatter | M4 → M10 at density | time × linear/log | — |
| Box / OHLC / violin | M3, M1, M7 | band × linear | KDE (violin) |
| Histogram / CDF / ECDF | M3, M1 | linear × linear | binning |
| XY / bubble / trend / regression | M4, M1 | linear/log × linear/log, size, colour | regression (L2) |
| Parallel coordinates | M1, M8 | N linear axes | — |
| Bar chart / bar gauge / bullet | M3, M8 | band × linear | sort |
| Gauge / pie / donut / radar | M5, M7, M8 | angular | — |
| Stat | M8, M1 (sparkline) | — | text fit |
| Table grid (> 10k rows) | M3, M8, M1, M5 (mini-cells) | per column | virtual scroll |
| Treemap / sunburst | M3 / M5, M8 | colour | squarified / radial |
| Sankey / funnel | M6, M3, M8 | — | Sankey |
| Atlas topology / node graph | M4/M5 nodes, M6 edges + particles, M7 hulls, M8 | colour/size | force, layered, bundling |
| City / 3D surface / skyline | M11, M8 | height/colour | treemap / grid |
| Hexbin wall / cluster detail | M3 or M4 (hex SDF), M8 | colour | nested tiling |
| Geomap (all layers) | M12, M4, M7, M6, M10, M8 | projection | — |
| Schematic | M7, M6, M8, M9, M4 | bindings | constraints |
| Log stream | M8, M3 (gutter) | — | text flow |
| Waterfall | M3, M1, M8 | time × band | waterfall |
| Flame / icicle | M3, M8 | — | flame |
| Time Ribbon | M3, M9, M1 | time | — |

Every vis reuses something, and only the layout engines are vis-specific.

**Layout engines (L3)**, detailed in T14 (draft):

| Engine | Vis | Notes |
|---|---|---|
| Force-directed (Barnes–Hut, incremental, stable seeds) | Atlas topology, node graph | Runs continuously in the layout worker; positions persisted per org for spatial memory |
| Layered / Sugiyama | Causal path, dependency mini-map, Sankey ordering | Crossing minimisation; time-budgeted |
| Edge bundling | Atlas at scale | Hierarchical bundling by segment |
| Squarified treemap / sunburst | Treemap (cardinality explorer, M-UI1), City, sunburst | Stable ordering for animation |
| Hex / grid tiling (nested) | Hexbin wall, cluster detail | Nested packing by parent group |
| Flame / icicle / sandwich | Profiles | Merging, diff values |
| Waterfall | Traces | Critical-path computation; collapsing |
| Sankey | Journeys, routing traffic | Node ordering + link routing |
| Map projections | Geomap, globe | Web Mercator, equirectangular, orthographic globe |
| Schematic constraints | Schematic editor | Anchors, snapping, alignment |
| Text flow | Logs, table grid, Markdown on canvas | Wrapping, ANSI colours, JSON pretty-print |

### 4.9 Capability tiers and the gallery

| Tier | Detection | Differences |
|---|---|---|
| **T1 WebGPU** | `navigator.gpu` adapter (probed via the shim, confirmed in render) | Compute shaders: GPU decimation, KDE splat, binning, band reduce, particle simulation |
| **T2 WebGL2** | Fallback | Same marks. Compute steps run on the CPU in the pool (multithreaded WASM SIMD) or as render-to-texture passes. Visible-sprite ceiling for M4 of 2–3 × 10⁶ points; above it M10 density (additive float FBO) takes over |
| **Native** | Server / CI | Same renderer headless (Vulkan/Metal/DX12, or Mesa lavapipe pinned for goldens, [T05](T05-testing-and-performance.md)) for chart images in notifications ([07](../product/07-alerting.md)), reports, PDF export, the Static mode ([T03 §9](T03-browser-runtime.md#9-failure-modes--degradation)) and golden tests |

The 10⁷-point scatter target holds on both tiers: on T2, 10⁷ points are held and drawn as a density
field whenever more than the sprite ceiling is visible, and individual sprites are needed only below
10⁵ visible points ([VIZ-008](../product/05-visualisation-catalogue.md#viz-008--scatter-density-and-point-modes)), well under the ceiling.

**Gallery.** The showcase gallery ([05 §14](../product/05-visualisation-catalogue.md#14-showcase-gallery))
is generated from the `fixtures/` manifest ([T05 §4.2](T05-testing-and-performance.md#42-gallery--corpus-and-golden-image-tests)).
Each entry names a spec, its seeded `pulsus-synth` dataset at the vis's target volume and its
variants. The gallery build links `pulsus-synth` into core, which generates Arrow chunks directly
into the arena, so a page runs without a PulsusDB and produces the same frames for the same seed.

#### T02-029 — T1 and T2 look the same
**MUST** — A spec MUST produce the same image on T1 and T2 within the real-GPU golden threshold. Only
scale ceilings MAY differ, and a binding ceiling MUST be disclosed by the coverage meter.

#### T02-030 — Same seed, same pixels
**MUST** — With the same spec, seed, inputs and canonical backend, the engine MUST produce identical
images. Core MUST read time only through the `Clock` trait, seed every RNG, and use order-
deterministic reductions ([T05 §4.4](T05-testing-and-performance.md#44-deterministic-input-replay-pdrec)).

#### T02-031 — No vis without a gallery page
**MUST** — A spec MUST NOT be registered in the vis registry unless its `fixtures/` manifest entry
exists; the registry and the gallery are generated from the same manifest.

### 4.10 What we reuse

Pure-Rust crates that compile to WASM. Building from scratch means no JS, not hand-rolling every
algorithm. Licences and WASM size are checked in M-UI0 ([T03 §7.3](T03-browser-runtime.md#73-wasm-size-budget)).

| Need | Crate(s) |
|---|---|
| GPU abstraction | `wgpu` (WebGPU + WebGL2 + native) |
| Maths | `glam` |
| Tessellation, curves | `lyon`, `kurbo` |
| Polygon triangulation (geo) | `earcutr` |
| Text shaping, layout, fonts | `rustybuzz`, `cosmic-text`, `swash` / `ttf-parser` |
| MSDF atlas | Generated at build time (msdf-atlas-gen) for UI fonts, plus a runtime Rust MSDF generator for fallback glyphs (e.g. `fdsm`) |
| SVG icons | `resvg` / `usvg` (rasterised into the atlas) |
| Markdown | `pulldown-cmark` (no HTML pass-through) |
| Columnar data | `arrow-ipc`, `arrow-array`, `arrow-buffer` (no umbrella crate) |
| Time zones | `chrono` + `chrono-tz` (tz data split and lazy-loaded) |
| Geo | `geo`, `geojson`, `prost` for MVT tile decoding |
| Graphs | `petgraph` (algorithms); force and bundling layouts written ourselves |
| Spatial index | `rstar` (label collision, lasso, map hit-tests) |
| Image decode | `image` (PNG/JPEG for schematic images, tiles) |
| Threads | `wasm-bindgen-rayon` |

Deliberately **not** used: CPU plotting crates (`plotters`) and game engines (Bevy). They are wrong
for retained, instanced 10⁷-mark scenes.

## 5. Interfaces

| Interface | Direction | Notes |
|---|---|---|
| `VisSpec` (serde, versioned) | Board/viewport config ↔ engine | Declarative: marks, encodings, `axes[]`, overlays, style options; stored with the viewport ([T11](T11-postgres-schema.md)) |
| `Chunk` handles | data workers → render | Immutable `Arc<Chunk>` from the chunk table ([T03 §4.3](T03-browser-runtime.md#43-shared-memory-layout-and-ownership)) |
| `Command` (`AxisRange`, `CompareOffset`, `Select`, `Brush`, `SetBaseline`, `TimeCursor`) | controllers → state store | Undoable ([T03 §4.4](T03-browser-runtime.md#44-state-ownership)) |
| `TooltipAnchor`, `InspectorModel`, `A11ySummary` (table model), `CoverageChanged`, `LegendModel` | core → shell | [T03 §5.3](T03-browser-runtime.md#53-core--shell-messages) |
| Native render API `render(spec, chunks, size, dpr, theme) → PNG + text-region list` | BFF / CI | Used by notifications, Static mode and goldens |

## 6. Data & storage

| Data | Where |
|---|---|
| Instance and staging buffers | Core shared arena (staging) and GPU (instances) |
| Glyph, icon and density textures | GPU; atlases cached immutably over HTTP |
| Vis specs, axis overrides, manual pins | Viewport config in Postgres ([T11](T11-postgres-schema.md)); session state in the Context |
| Layout positions (Atlas spatial memory) | Postgres, per org (T14 (draft)) |
| Baselines and anomaly scores for overlays | Postgres virtual sources via the planner ([ADR-0012](../adr/0012-derived-state-in-postgres.md)) |

## 7. Performance budget

| Primitive / scene | Volume | (a) | (b) | Gate |
|---|---|---|---|---|
| M1 polyline + GPU decimation, pan/zoom | 10⁸ points held, 1 000 series | median ≥ 60 fps; p99 ≤ 16.7 ms target | p99 ≤ 22.2 ms | `bench:frame-line-1e8` |
| M2 band + M1 outliers | 10⁴ series | as above | as above | `bench:frame-series-1e4` |
| M4 point (T1) / M10 density | 10⁷ | as above | as above | `bench:frame-scatter-1e7` |
| M4 sprites (T2) | 2–3 × 10⁶ visible | as above | as above | `bench:frame-scatter-1e7` (T2 leg) |
| M3 heatmap | 10k × 200 cells | as above | as above | `bench:frame-gallery` |
| M3 + M8 flame (M-UI2) | 10⁵ frames | as above | as above | `bench:frame-gallery` |
| M8 log stream (M-UI2) | 10⁶ lines | as above | as above | `bench:frame-gallery` |
| Atlas (M-UI3) | 10⁴ nodes / 5 × 10⁴ edges | as above | as above | `bench:frame-gallery` |
| Camera transition | — | ≤ 250 ms | ≤ 250 ms | `bench:camera-transition` |
| Render-worker frame CPU (excl. GPU) | heaviest gallery page | — | ≤ 8 ms p99 | `bench:frame-gallery` |
| Hover → tooltip anchor | — | same frame | same frame | `bench:input-photon` |

High-Hz displays: ≥ 120 fps median on a 120 Hz display ([PRF-001](../product/09-performance-contract.md#prf-001--frame-rate-during-interaction)), gate `bench:frame-high-hz`.

## 8. Security, tenancy & RBAC

- The engine renders only data the BFF has already scoped and masked ([T04 §8](T04-wire-format-and-data-plane.md#8-security-tenancy--rbac));
  masked values render as `‹masked›`.
- Canvas text never executes markup (T02-019). Images in schematics and tables are proxied
  same-origin by the BFF ([T03 §5.7](T03-browser-runtime.md#57-http-headers-the-runtime-requires)).
- No vis embeds an iframe. Third-party vis modules (M-UI6) run as satellites under
  [T18](T18-security.md)'s sandbox rules.

## 9. Failure modes & degradation

| Failure | Behaviour |
|---|---|
| No WebGPU | T2: same marks, CPU or render-to-texture compute; ceilings disclosed |
| GPU device lost | Re-create the device and re-upload from arena chunks; the last frame stays on screen (≤ 500 ms) |
| Pipeline compile slow | First scene's marks (M1/M3/M4/M8) first; the rest in idle frames |
| Missing glyph in the atlas | Runtime MSDF generation for the fallback glyph in the layout worker |
| Data exceeds the tier ceiling | LOD (§4.4) with coverage disclosure, never a silent cap |
| Font not loaded yet | Text waits on the atlas; the layout is not drawn with a substitute font (no metric jump) |

## 10. Testing

[T05](T05-testing-and-performance.md) owns the gates. Specific to the engine:
- **Golden images** for every gallery page and every mark primitive, on the native headless renderer,
  with ꟻLIP thresholds and text-region rules ([T05 §4.2](T05-testing-and-performance.md#42-gallery--corpus-and-golden-image-tests)).
- **Frame-time benchmarks** per primitive and per gallery page at target volume.
- **Property tests:** decimation never hides a spike; ticks never overlap from 40 to 8 000 px in any
  time zone including DST days; no two axis bands overlap; tick labels never collide across stacked
  lanes; a pan on axis A leaves every mark bound to axis B pixel-identical.
- **Visual-design review gate.** Typography, spacing and colour are reviewed against
  [08](../product/08-visual-language.md) from the gallery before a vis ships. A from-scratch engine
  can look home-made; this gate is how we avoid it.

## 11. Rollout

Milestones follow the vis tables of [05](../product/05-visualisation-catalogue.md) and
[12](../product/12-roadmap.md).

| Milestone | Engine work | Vis unlocked |
|---|---|---|
| **M-UI0** | L0 runtime, picking, tiers; M1, M3, M4, M8, M10 (density for scatter); time/linear scales, basic axes, pan/zoom with inertia and cursor anchor; GPU decimation; Arrow → buffers; token pipeline | Line, scatter (proves [09](../product/09-performance-contract.md)) |
| **M-UI1** | M2, M9 (glyph language); axis system (§4.3): multiple axes per side, secondary Y, log/symlog, per-axis interaction, **time-shifted comparison axis with the baseline ghost**; overlays; legends, crosshair sync, thresholds, units; band + outliers; squarified treemap layout; Time Ribbon; auto-vis; table view model; gallery skeleton from the manifest | Line, area/stacked, bars over time, band, heatmap, stat, bullet, treemap (cardinality explorer), Time Ribbon |
| **M-UI2** | Stacked lanes; text flow; waterfall and flame layouts; GPU table grid; exemplars; sparkline and small multiples; diff flame ghost | Logs, traces, profiles, span scatter at 10⁷, sparkline, small multiples, bar chart |
| **M-UI3** | M5, M6 (+ particles), M7, M11; force, layered, bundling, hex layouts; GPU morph transitions; central axis; align on onset; Atlas deviation glow | Atlas (topology/city), hexbin wall, cluster detail, node graph, compare bars, state timeline |
| **M-UI4** | Alert layers on all of the above; native headless renderer for notification images; rotated time axis | Alert views ([07](../product/07-alerting.md)), segments matrix, SLO burn chart |
| **M-UI5** | M12; map projections; Sankey; schematic editor; static and discontinuous time axes; draw behind axes; value mappings and overrides; light theme; remaining L5 specs | Geomap, schematic, Sankey, pie/gauge/radar, XY/trend, parallel coordinates, calendar, status history, box/violin: full panel parity ([05 §11](../product/05-visualisation-catalogue.md#11-panel-parity-map)) |
| **M-UI6+** | Wall density and high-contrast tokens; screen-reader summaries; declarative third-party spec; sandboxed WASM vis modules | Extensibility, wall mode |

**Risk and mitigation.** The breadth of L2–L4 (ticks, text, legends, time zones) and Geomap (tiles
plus text labelling is a product in itself) are where a from-scratch engine usually slips. A
dedicated vis-platform team owns L0–L4; feature teams write L5 specs; Geomap starts with a minimal
basemap (bundled GeoJSON outlines via M7) before full vector tiles.

## 12. Alternatives considered

| Alternative | Why not |
|---|---|
| A web charting library per vis | Forbidden by [ADR-0001](../adr/0001-rust-wasm-everywhere.md)/[ADR-0002](../adr/0002-no-js-ui-framework.md); no shared picking, LOD or replay |
| One bespoke renderer per vis | ~40 renderers; inconsistent LOD and theming; violates [VIZ-002](../product/05-visualisation-catalogue.md#viz-002--every-vis-is-a-composition-of-shared-mark-primitives) |
| CPU plotting crates (`plotters`) | Immediate-mode, CPU-bound; cannot hold 10⁸ points at 60 fps |
| Game engine (Bevy) | Too large; ECS overhead for retained instanced marks |
| Per-axis re-upload of instance data | Breaks T02-010 and costs bandwidth on every pan |
| Axis labels in DOM | Cannot stay frame-synchronous with the canvas during pan; text would drift |

## 13. Open questions

1. Is a 16-axis-per-viewport engine limit enough for imported dashboard panels with many overrides?
   Measure on the M-UI5 import corpus.
2. Δ vs baseline in tooltips ([INT-033](../product/03-interaction-model.md#int-033--hover-tooltip)) when no baseline is set in the Context: show the
   Perspective's default baseline, or omit Δ with "no baseline"? Proposed: the Perspective default
   (−7d for SRE and Engineer).
3. Particle simulation on T2: CPU in the pool, or vertex-shader analytic positions (no state)?

**Resolved during formalisation**

1. **Milestones follow 05.** The draft's build order put state timeline and status history in M-UI1
   and the time-shifted X axis in M-UI3. [05](../product/05-visualisation-catalogue.md) puts state
   timeline at M-UI3, status history at M-UI5, sparkline at M-UI2, and the time-shifted comparison
   axis at M-UI1 with the baseline ghost ([VIZ-015](../product/05-visualisation-catalogue.md#viz-015--time-shifted-comparison-axis)). Treemap moves to M-UI1 (cardinality
   explorer) and Bullet to M-UI1 ([VIZ-039](../product/05-visualisation-catalogue.md#viz-039--bullet-preferred-for-value-vs-threshold)). Stacked lanes are M-UI2 and central axes M-UI3.
2. **Five states, five glyphs.** State encodings now name the [08](../product/08-visual-language.md)
   glyphs, including Failing ■ (T02-003).
3. **Section numbering.** The axis system, §3.1 in the draft, is §4.3 here because §3 is the
   Satisfies table. [05](../product/05-visualisation-catalogue.md) §1.1 still says "T02 §3.1".
4. **Derived overlays (D2).** Anomaly and forecast bands read baselines from Postgres virtual
   sources ([ADR-0012](../adr/0012-derived-state-in-postgres.md)); the engine has no write path.
5. **T2 scatter ceiling vs 10⁷.** Reconciled in §4.9: the ceiling applies to visible sprites; density
   covers the rest.
6. **Text flow and Markdown** now drop HTML explicitly (T02-019), aligning with [VIZ-054](../product/05-visualisation-catalogue.md#viz-054--markdown-and-html-are-always-sanitised).

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft. Restructured to the template; added design rules T02-001 to T02-031; axis system expanded (auto-configuration, manual pin, ownership glyphs, comparison axis at M-UI1); LOD and precision rules; camera controller constants; auto-vis; glyph and state encodings per 08 (Failing ■); build order aligned with 05 milestones; Satisfies table |
