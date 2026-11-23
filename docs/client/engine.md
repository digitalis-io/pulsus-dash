# Chart engine (Rust, native core)

For developers. The chart engine is the Rust renderer that will draw chart frames behind the
`ChartFrame` seam ([ADR-0014](../../designs/adr/0014-typescript-react-web-client.md) §3), in place
of the interim Canvas 2D renderer ([Charts](charts.md)). It is built in four parts (issue #68):

| Part | Scope | State |
|---|---|---|
| A | The `engine/` workspace and the native core: tokens, units, colour, scales, value encoding, decimation, plot layout, scene, line mark, headless goldens and the parity fixtures | this page |
| B | Wire schemas, the Go DSF/Arrow writer, the Rust DSF parser and Arrow decode into `Chunk` | planned |
| C | The browser runtime: WASM builds, workers, the `WasmEngine` adapter, input, CSP | planned |
| D | Arrow responses on the query routes and the data worker's byte pump | planned |

Until Part C the browser still draws every chart with the Canvas 2D renderer; nothing in this part
is loaded by the client. Axis labels, ticks as text, bars, heatmap and stat are #69.

## Workspace and crate layering

`engine/` is a Cargo workspace beside `client/` and `server/` (crates in `engine/crates/`, tooling
in `engine/xtask/`), edition 2024, toolchain pinned in `engine/rust-toolchain.toml`.

| Crate | Role | Layer ([T02](../../designs/technical/T02-vis-engine.md) §4.1) |
|---|---|---|
| `dash-tokens` | The design tokens as Rust constants (`tokens.rs`, generated) | shared |
| `dash-units` | `Unit` and `format_value`, byte-identical to the client's `formatValue` | L2 |
| `dash-colour` | `series_colour_index` (the client's `palette.ts` rule), `SeriesColour`, `GuideColour` | L2 |
| `dash-wire` | `Chunk`, `ChunkBuilder`, `ChunkId` (Part B adds the decoders) | data |
| `dash-scales` | `value_ticks` (the client's `valueTicks`), value encoding and segment clipping, column ranges, the CPU decimation passes | L2 |
| `dash-axes` | `layout_plot` (the client's `layoutPlot`), `value_axis` (auto, manual, held band) | L3 |
| `dash-scene` | `Scene`, `Viewport`, `Camera`, camera primitives, `LineSpec`, `FrameSummary`, `CommitEvent`, `build` | L4/L5 |
| `dash-marks` | Mark descriptions (`DrawList`, `MarkItem`, `DrawnEvent`); with feature `gpu`, the line renderer and the WGSL passes | L1 |
| `dash-gpu` | `GpuContext` (headless lavapipe), `Tier`, `FrameTarget`, `HeadlessTarget` | L0 |
| `pulsus-synth` | Seeded data: the gallery's line entries and the decimation reference fixtures | test |
| `dash-golden` | Golden renders, ꟻLIP comparison, the decimation references, the `dash-golden` CLI | test |
| `xtask` | `cargo xtask spec-lint` | tooling |

Two layering rules are checked by `cargo xtask spec-lint` (`ci:spec-lint`,
[T02-001](../../designs/technical/T02-vis-engine.md#t02-001--every-vis-is-an-l5-spec-over-l1-marks)):
`dash-scene` has no dependency, direct or transitive, on `wgpu`, `naga` or `dash-gpu` (it uses
`dash-marks` for its descriptions only, with no feature enabled); and only `dash-marks` contains
`.wgsl` files. `dash-marks` never depends on `dash-scene`.

## Commands

Run from the repository root unless stated otherwise. The `make` targets run in the pinned lavapipe
image ([Build, test and CI](../development/build-and-ci.md#engine)); `cargo` commands run in
`engine/` on the host.

| Command | What it does |
|---|---|
| `make engine-image` | Builds the image from `engine/ci/lavapipe.Dockerfile` (`DOCKER=podman` for Podman) |
| `make engine-test` | `cargo nextest run --workspace --exclude dash-golden` in the image |
| `make engine-lint` | `cargo fmt --check`, `cargo clippy -D warnings`, `cargo xtask spec-lint`, `cargo deny check` in the image |
| `make engine-goldens` | The golden tests (`cargo test -p dash-golden --release golden_`) in the image |
| `make engine-goldens-update` | The same with `GOLDEN_UPDATE=1`: writes `engine/crates/dash-golden/goldens/*.png` |
| `cargo xtask spec-lint` | The crate-graph, WGSL and image-literal checks; exit 1 with each violation |
| `cargo test --workspace` | Every test on the host; the GPU tests need a lavapipe (llvmpipe) Vulkan adapter, and `golden_gallery` fails outside the image because it asserts the pinned Mesa |
| `npm run engine-fixtures -- --write` (in `client/`) | Rewrites `engine/fixtures/*.json` from the TS sources |

## The line pipeline

`dash-scene::build(&Viewport)` turns one viewport into a `DrawList` and the `a11y` summary; the
renderer draws the list. Both are pure functions of their inputs: the caller sets the camera and the
label band ([gesture policy](#cameras-and-gesture-policy)).

```
 Viewport ──build──► value_axis (auto | manual) ─► choose_encoding ─► DrawList { Guides, Line }
                                                                          │
 Renderer.render ─► ranges (cached) ─► values (cached per ChunkId, Encoding)
                    T1: P1 → P2 → P3 ─► read total ─► size or batch ─► P4 → P5 ─► draw (indirect)
                    T2 and far items: dash-scales::decimate (CPU) per batch ─► write ─► draw
```

`build` for a line spec: the shown series are the first `max_series` (500 while the interim cap
holds, ADR-0014 §4); the statistics are the client's `lineStats`; the value axis is
`value_axis(Line, …, manual = camera y, band = viewport band)`; the encoding is
`choose_encoding(chunk finite range, axis domain, plot height × DPR)`; it emits one guide hairline
per tick at `round(y)` and the line item; a manual axis sets the scissor to the plot rect. No data,
no window, an unsupported kind or an empty plot gives the clear only and no summary.

`Renderer::render` returns `Some(DrawnEvent)` only for a complete frame at a non-zero size with at
least one item (the `drawn` event of ADR-0019, #90; Part C emits it).

## Decimation

Columns are whole CSS px of the plot, as the interim `lineColumns`: a sample at `t` belongs to
column `clamp(floor((t − from)/(to − from)·n), 0, n − 1)` when `from ≤ t ≤ to`, computed in f64 on
the CPU ([T02-014](../../designs/technical/T02-vis-engine.md#t02-014--precision-f64-on-the-cpu-f32-relative-to-an-encoding-origin)).
`column_ranges` gives one u32 table for a grid chunk (relative to the series start) and one per
series for explicit timestamps.

Five passes, the same on the GPU (T1, compute) and the CPU (T2, and far items on any tier):

| Pass | Per | Does |
|---|---|---|
| P1 reduce | (series, column) | `ColOut` (40 B): first and last finite u, flags (gap before the first sample, inside, after the last, all gaps), the exact number of NaN-free runs and runs 0 and 1 inline |
| P2 count | series | instances per series |
| P3 scan | all series | `starts` (exclusive prefix from G, the guide count), `total`, draw-indirect args |
| P4 emit | series, columns in order | per column: its runs, then the segment into it, then a dot; writes `span_at` and the join flags back |
| P5 spill | (series, column) with > 2 runs | re-scans the column and writes run k at `span_at + k` |

What is drawn ([VIZ-006](../../designs/product/05-visualisation-catalogue.md#viz-006--line-decimation-is-visually-lossless), [T02](../../designs/technical/T02-vis-engine.md) §4.4):

- every NaN-free run of a column is one round-capped vertical capsule from its max to its min; a
  run of one sample that no segment reaches is a dot of radius `width_css`;
- the segment into a column joins the previous drawn column's **last** sample to this column's
  **first**, unless a gap lies between them (a trailing gap, an all-gap column, a leading gap);
- every capsule has round caps.

So the coverage equals a drawing of every raw point: consecutive collinear capsules inside a column
cover the same pixels as one capsule from their min to their max. `golden:decimation-raw` proves it
with zero differing pixels.

Determinism: every comparison of two values is on an order-preserving integer key of their f32
bits (`f32` order with ±0 equal), so GPU denormal handling cannot change a choice, and the T1 and
T2 paths give byte-equal `ColOut` and instances (`unit:decimation-tier-parity`). P1 and P5 run in
parallel over series on rayon; the result does not depend on the pool size.

**Sizing and batching.** On T1 the renderer reads `total` after P3 (a blocking map of the status
buffer, native only). If `G + total ≤ max_instances` (the device's buffer limits / 16), the instance
buffer grows to the next power of two (from 2²⁰, never shrunk) and the viewport is one indirect
draw. Otherwise it is drawn in ⌈(G + total)/max⌉ batches of P4, P5 and one draw each, in index order,
so the pixels equal one draw (T02-002 note).

**Buffer lifetimes** ([T04](../../designs/technical/T04-wire-format-and-data-plane.md) §5.7):

| Artefact | Rebuilt when | Never rebuilt on |
|---|---|---|
| column ranges | new chunk, pan, zoom, resize, DPR change | theme; a value-range change that keeps the window and plot width |
| encoded values (per ChunkId, Encoding) | the frame's encoding has no resident buffer for the chunk | pan, zoom, resize with the same encoding |
| `ColOut`, counts, starts, status | grow with the item, never shrunk | — |

Before allocating, `render` releases every encoded-value buffer its draw list does not reference,
so a chunk has one resident encoding and a dropped chunk none after the next render. Values are
encoded through one 16 MiB slab per slice (T1); each slice is submitted and waited for before the
next is written, so at most one slice is queued (≤ 32 MiB transient with the driver's copy). On T2
the encoded slab in CPU memory is the decimation input, and the CPU path decimates, uploads, draws
and releases one batch at a time, so at most one batch of instances (≤ `max_instances` × 16 B) is
held. `debug_counters` reports both peaks (`staging_outstanding_max`, `cpu_instance_bytes_peak`).
If a wait fails, the upload stops, the incomplete values buffer is dropped (never cached), the
frame is not drawn (`render` returns `None`, so no `drawn`) and `last_error()` holds the error.
The test hooks `debug_counters`, `debug_resident`, `debug_ranges`,
`read_decimation`, `last_draws` and `render_instances` exist for `unit:buffer-lifetime`,
`unit:decimation-tier-parity`, `unit:decimation-batches` and `golden:decimation-raw`.

## Geometry

CSS px; device px = CSS × DPR. `y(u) = plot.y + plot.height − (u − ou)·ku`, column x =
`plot.x + col + 0.5`.

| Kind | Geometry | Coverage |
|---|---|---|
| segment | capsule from the previous drawn column's last value to this column's first, radius `width_css/2` (1.5/2 CSS px) | `clamp(r + 0.5 − d, 0, 1)` in device px |
| span | vertical capsule at the column centre from a run's max to its min, radius `width_css/2` | as segment |
| dot | disc at the column centre, radius `width_css` | as segment |
| hline (guide) | x ∈ plot, y ∈ [round(y), round(y) + 1) | 1 |

The vertex shader maps (x, y, lane z) through the viewport's `view_proj`, divides by w and only then
extrudes in device px. It clips each capsule's device segment to the target's rows ± (r + 2) px
before extruding: a cut end takes the bound as its y and its x from the cut parameter, so a far end
(around 10¹⁰ px) never reaches the rasterizer. Near a capsule end the fragment uses the distance to
that end itself, so coverage there depends only on that end's coordinates.

## Value encoding and precision

Values are uploaded as f32 `u = (v − v_ref)·2^−exp` ([T02-014](../../designs/technical/T02-vis-engine.md#t02-014--precision-f64-on-the-cpu-f32-relative-to-an-encoding-origin)):

- `Encoding::of(lo, hi)` takes the exact span (`hi − lo`, or `hi/2 − lo/2` doubled when that
  overflows; subnormal spans are exact), `v_ref` in [lo, hi] and `exp` so that the span·2^−exp is in
  [0.5, 1). Constant data has no data encoding.
- `choose_encoding` keeps the data's encoding when it is adequate for the axis and plot height (no
  overflow, y error ≤ 2⁻⁸ device px for plots up to 2¹⁴ device px, and both axis ends inside the
  clip box |u| ≤ 2²⁴), else uses the axis's own encoding. A pure function of (data range, axis, plot
  height).
- A line whose data lies beyond the clip box is a **far item**: it is decimated on the CPU on both
  tiers and each segment is clipped in f64 before encoding (`clip_segment`, 1-D Liang–Barsky on
  value); a cut end carries its parameter t and lands on the f64 line, so crossings are exact to
  `dx·2⁻²³` px. Spans and dots use clamped u.
- `value_ticks` ports the client's `niceValueTicks` and `extreme_ticks(lo, hi, height_px,
  label_height_px)` its `extremeTicks` (#97). They equal the TS on the fixture inputs
  (`ticks.json`, `ticks-extreme.json`, including the power and decade edge rows), checked under
  Node 24.22.3 (`unit:engine-fixtures`) and, for the TS, in the browser engines Playwright pins
  (`e2e:ticks-parity`, under the rule below); other inputs and runtimes are not claimed. WebKit's
  `**` differs from V8's in the last bits for some large powers (#126), which the rule allows for.
  `value_ticks` returns None outside its domain (non-finite input, an end beyond ±1e300, a span of
  2^1023 or more), where the search does not finish in 64 steps (a zero span after
  `min + 1 === min`, or a range straddling zero on a plot under 2·(label + 2) px tall), and when two
  drawn ticks are closer than one label gap (`ticks_fit`: through `tick_y`, the renderer's y,
  halved when the span overflows; gap ≥ (label + 2)·(1 − 1e-9)). A two-tick result on a plot under
  label + 2 px keeps the end nearer zero. `value_axis` then uses `extreme_ticks`:
  `[lo, lo/2 + hi/2, hi]` when both mapped gaps hold a label, `[lo, hi]` when the plot holds one
  gap, else the end nearer zero (lo on a tie). The integer powers `10 ** k`, `1000 ** p` and
  `1024 ** p` come from a table of the values V8 computes (`dash-scales::js_pow`), because V8's
  `Math.pow` is not correctly rounded (`10 ** -5` is 9.999999999999999e-6); `pow.json` checks the
  table.

The `e2e:ticks-parity` rule (#97 plan §10 Q1):

> **Path parity, every engine, every row.** Every row of `ticks.json` and `ticks-extreme.json`
> carries `path: 'nice' | 'fallback'`, generated under the pinned Node 24.22.3. `'fallback'`
> means `fn === 'extremeTicks'` or `niceValueTicks(...) === null`; this includes the collision
> rejection, which returns null. Each engine computes its own path in-engine the same way. A path
> that differs from the recorded `path` fails in every engine and every class. Classes are
> assigned from the recorded `path`, with gap = label + 2:
> - **F** (`path === 'fallback'`): exact `{min, max, ticks}` in every engine.
> - **S** (`path === 'nice'`, `height ≤ 2·gap`): exact in Chromium and Firefox. In WebKit, the
>   tick count and every tick are exact (−0 compared numerically); `min` and `max` are each exact
>   or within 4 ulps of the recorded value (`ulpDistance` on the IEEE-754 bit patterns); and P1
>   to P7 hold on WebKit's own result.
> - **N** (`path === 'nice'`, `height > 2·gap`): exact in Chromium and Firefox. In WebKit, exact,
>   or P1 to P7 hold.

Supported domain: every finite axis `lo < hi` (spans 2⁻¹⁰⁷⁴ to 2·MAX) and every f64 value; there is
no finite input outside it. Timestamps stay f64; samples 1 ms apart at epoch scale land in
different columns at the deepest zoom (`unit:epoch-adjacency`).

## Cameras and gesture policy

`Camera` is an enum with one variant now, `Plot2D { x, y }`: x is the time range in unrounded f64
ms, y is `Auto` or `Manual(range)`. `PlotCamera::idle(window, spec)` uses the spec's `valueRange`
when it is valid (finite, min < max), else auto. `Camera::view_proj` composes the clip transform in
f64; `Orbit3D` (#94) adds a variant, a depth-tested pipeline and a lane depth without changing the
line mark.

The engine has **camera primitives only**, bit-equal to the client's camera arithmetic (#93):
`zoom_about(span, f, factor, limits)` (exact no-op when the span does not change),
`pan_by(span, fraction, limits, step)` (the caller picks the quantisation step), `contain`, `fx`,
`fy` and `to_window` (ECMAScript `Math.round` of both ends, to ≥ from + 1). The gesture policy —
which step, when the label band is held, when to commit — is the application's controller, which
sets `Viewport.camera` and `Viewport.band` (`Band::Measure` or `Band::Fixed(w)`). Under
`Band::Fixed` the plot rect depends only on (kind, size, band); a label wider than the band has
`fits = false` and #69 draws it on a chip inside the plot.

## Colour and blending

Slots 0–7 are `SERIES_PALETTE[theme][series_colour_index(key, labels)]`, slot 8 is `hairline`, the
clear is `surface-1`. Colours are sRGB-encoded `Rgba8` bytes, equal to the CSS hex; the targets are
`Rgba8Unorm`/`Bgra8Unorm` (never `*Srgb`) and blending is `src-alpha, one-minus-src-alpha` in
sRGB-encoded space, so token alphas composite as in CSS and Canvas 2D (T02 §4.2). Only
`SeriesColour` and `GuideColour` can be named by a spec; state colours are not reachable from
`dash-scene`.

## Seams for #90, #93 and #94

| Contract | Provided by Part A |
|---|---|
| `drawn`, `FrameInit.id` (ADR-0019) | `Renderer::render → Option<DrawnEvent>`; `Viewport.frame_id` is stored and never changes pixels |
| `VisSpec.valueRange` (line) | `LineSpec.value_range` (serde `valueRange`), `ValueRange::validated`, the manual axis and its scissor |
| `FrameSummary.valueAxis` | always set for a line: the drawn domain and whether it is manual |
| `commit` (ADR-0020) | `CommitEvent`, `ValueCommit` (`{min, max}` or `"auto"`), `Gesture`, `camera::to_window`; no commit rule |
| camera arithmetic | `camera::{zoom_about, pan_by, contain, fx, fy, to_window}` |
| held band | `Band::Fixed(w)`, `AxisLabel.fits` |
| #94 3D | `Camera` enum, f64 `view_proj`, a 16-bit lane in every instance, extrusion after the divide |

## Parity with the TS sources

Each Rust port is held to its TypeScript source by a JSON fixture in `engine/fixtures/`, written by
`client/scripts/engine-fixtures.ts` (seeded inputs; non-finite numbers as `"NaN"`, `"Infinity"`,
`"-Infinity"`):

| Fixture | TS source | Rust test |
|---|---|---|
| `format.json` | `i18n/format.ts` `formatValue` | `unit:number-format` |
| `ticks.json`, `pow.json` | `canvas2d/valueTicks.ts`; the JS engine's `**` | `unit:layout-parity` |
| `ticks-extreme.json` | `canvas2d/valueTicks.ts` `valueTicks` and `extremeTicks`: 32 fixed rows, 8 fallback-fit rows, 57 power and decade edge rows and 300 seeded rows over the whole finite range, short plots included (#97) | `unit:layout-parity` (`value_ticks_or_extreme_match_ts`) |
| `layout.json` | `canvas2d/layout.ts` `layoutPlot` and draw.ts's value axis (via `drawLayer` with label widths from the monospace advance) | `unit:layout-parity` |
| `columns.json` | `canvas2d/columns.ts` `lineColumns` (plus each column's first sample) | `unit:columns-parity` |
| `palette.json` | `canvas2d/palette.ts` `seriesColourIndex` | `unit:colour-hash` |
| `synth.json` | `dev/synth.ts` `synthLines` via `dev/gallery.ts` | `unit:synth-parity` |
| `summary.json` | `canvas2d/summary.ts` `frameSummary` via `drawLayer` | `unit:frame-summary-parity` |

A change to any of those TS files (or `drawLineSeries`, `keyHash.ts`, the tokens) must regenerate
the fixtures (`npm run engine-fixtures -- --write`) and keep the Rust port equal: `npm test` fails on
a stale fixture (`unit:engine-fixtures`), and `engine.yml` runs on those paths to check Rust against
the new fixtures. `layout.json` is written with no minimum value band (`minBand: 0`) and no held
band: the interim renderer's T02-011 minimum (the widest compact label of the unit, #93) applies to
the engine when #69 adds labels, and the fixtures are regenerated with it then. Label widths are `ceil(chars × font.advance.mono × font.size.xs)`, which equals
`measureText` for JetBrains Mono once the font is loaded (Part C checks that in Chromium).

## Goldens

`dash-golden` renders the gallery line pages headless on lavapipe in the pinned image and compares
them with `engine/crates/dash-golden/goldens/*.png` by mean ꟻLIP ≤ 0.005
([T05-005](../../designs/technical/T05-testing-and-performance.md)): line-1, line-50, line-gaps and
line-600 in dark and light at 1118 × 240, line-50 dark at DPR 2, and line-50 dark with a manual
value range (the middle 40 % of the auto domain). Each page must render byte-equal on T1 and T2 and
twice in a row, and the adapter must be llvmpipe at the Mesa version in `engine/tools.toml`.

```
dash-golden render  --page line-50 --theme dark --size 1118x240 --dpr 1 --tier t1 [--value-range MIN,MAX] --out a.png
dash-golden compare a.png b.png [--region x,y,w,h]… [--max 0.005]   # prints the mean ꟻLIP; exit 1 above --max
```

Baselines are written only by CI with the `golden-update` label (or `make engine-goldens-update`
in the image) and reviewed as images in the PR. The decimation references need no baseline:
`golden:decimation-raw` compares the decimated render with every raw sample drawn through the same
pipeline (zero differing pixels), and `golden:decimation-ref` compares it with an independent f64
rasteriser of the ADR-0014 §4 model (every sample pixel covered, nothing outside the shapes dilated
by one pixel, empty gap bands, the far crossing at the right column).

## Limits

- 500 series per line while the interim cap holds; at most 65 535 lanes.
- Columns are CSS px (≤ 65 535); a viewport past `max_instances` is batched, never truncated.
- A chunk holds at most 2³¹ samples (`ChunkError::TooLarge`); timestamps must be finite and
  strictly increasing per series (`ChunkError::Order`).
- The native renderer blocks on the status read after P3; Part C re-runs an under-sized frame
  instead and never reports it as drawn.

## Design rules and gates

| Rule | Where | Gates |
|---|---|---|
| T02-001 | crate layering, WGSL only in `dash-marks` | `ci:spec-lint` |
| T02-002 | one draw per viewport, ordered batches past the limit | `unit:decimation-batches` |
| T02-014 | column ranges in f64, per-draw value encoding, f64 segment clipping | `unit:value-encoding`, `unit:segment-clip`, `unit:epoch-adjacency`, `unit:buffer-lifetime` |
| T02-015, VIZ-006 | one capsule per run, first/last joins | `golden:decimation-raw`, `golden:decimation-ref`, `unit:columns-parity`, `unit:decimation-prop` |
| T02-029 | T1 = T2 | `unit:decimation-tier-parity`, `golden:gallery` |
| T02-030 | seeded data, deterministic passes | `golden:gallery`, `unit:decimation-prop` |
| T03-008 | no `std::sync::Mutex`/`RwLock` | `ci:engine-lint` |
| T03-021 | fixed chunking on rayon | `unit:decimation-prop` |
| T05-004, T05-005 | pinned lavapipe, ꟻLIP | `golden:gallery` |
