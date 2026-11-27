# Chart engine (Rust)

For developers. The chart engine is the Rust renderer that draws chart frames behind the
`ChartFrame` seam ([ADR-0014](../../designs/adr/0014-typescript-react-web-client.md) §3), in place
of the interim Canvas 2D renderer ([Charts](charts.md)). It is built in four parts (issue #68):

| Part | Scope | State |
|---|---|---|
| A | The `engine/` workspace and the native core: tokens, units, colour, scales, value encoding, decimation, plot layout, scene, line mark, headless goldens and the parity fixtures | this page |
| B | Wire schemas and the Go DSF/Arrow writer (B1, [Arrow wire writer](../server/arrow.md)); the Rust DSF splitter, Arrow IPC reader and decoder into `Chunk` (B2, [below](#wire-decoding-dash-wire)); the shared wire limits (B3, [below](#limits-and-budgets)) | done |
| C1 | The engine in the browser: the WASM build, workers, WebGPU/WebGL2, the routing engine with Canvas 2D fallback and recovery, CSP, integrity, the size row ([below](#in-the-browser-part-c1)) | done |
| C2 | Input: the input ring, the camera controller, hover, selection, `dash-core-st` | planned |
| D | Arrow responses on the query routes and the data worker's byte pump | planned |

The engine is the default renderer
([ADR-0031](../../designs/adr/0031-gpu-engine-default-renderer.md), #256) and draws line frames
only; Canvas 2D draws everything else and every frame of a page that cannot run the engine
([below](#choosing-an-engine)). `?engine=canvas2d` forces Canvas 2D. Axis labels, ticks as text,
threshold and event labels, bars, heatmap and stat on the engine are #69.

## Workspace and crate layering

`engine/` is a Cargo workspace beside `client/` and `server/` (crates in `engine/crates/`, tooling
in `engine/xtask/`), edition 2024, toolchain pinned in `engine/rust-toolchain.toml`.

| Crate | Role | Layer ([T02](../../designs/technical/T02-vis-engine.md) §4.1) |
|---|---|---|
| `dash-tokens` | The design tokens as Rust constants (`tokens.rs`, generated) | shared |
| `dash-units` | `Unit` and `format_value`, byte-identical to the client's `formatValue` | L2 |
| `dash-colour` | `series_colour_index` (the client's `palette.ts` rule), `SeriesColour`, `GuideColour` | L2 |
| `dash-wire` | `Chunk`, `ChunkBuilder`, `ChunkId`; `SharedBytes`, the DSF `FrameSplitter`, its own Arrow IPC reader and `BodyDecoder` | data |
| `dash-scales` | `value_ticks` (the client's `valueTicks`), value encoding and segment clipping, column ranges, the CPU decimation passes | L2 |
| `dash-axes` | `layout_plot` (the client's `layoutPlot`), `value_axis` (auto, manual, held band) | L3 |
| `dash-scene` | `Scene`, `Viewport`, `Camera`, camera primitives, `LineSpec`, `VisSpec::from_json`, `FrameSummary`, `CommitEvent`, `build` | L4/L5 |
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
| `make engine-web-image` | Builds the engine web image from `engine/ci/web.Dockerfile` on the lavapipe image |
| `make engine-wasm`, `make engine-wasm-check` | The browser engine into `client/src/engine/wasm/gen/`; `ci:engine-gen` |
| `make engine-e2e`, `make engine-gpu-smoke` | The engine e2e suite; the adapters headless Chromium sees |
| `cargo xtask gen-layout [--check]`, `cargo xtask build-wasm [--out DIR]` | `layout.gen.ts` from `dash-protocol`; the threaded engine build |

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
  Node 24.22.3 (`unit:engine-fixtures`) and, for the TS, in every browser engine Playwright pins
  (Chromium, Firefox and WebKit, `e2e:ticks-parity`); other inputs and runtimes are not claimed.
  The TS takes its integer powers from the same V8 values as `js_pow` (#126): `pow10(k)` and
  `powBase(1000, p)` parse `1e…` as a decimal (correctly rounded in every engine) with 3
  overrides where V8's `**` differs (`10 ** 23`, `10 ** 210`, `1000 ** 70`), `powBase(1024, p)`
  is a table built by exact multiplication, and 2^1022 is a literal. `valueTicks.ts` uses no `**`
  (`unit:js-pow`), so no engine's own `pow` decides a tick.
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

`e2e:ticks-parity` checks, in every engine, that `pow10` and `powBase` equal all 855 rows of
`pow.json`, and that every row of `ticks.json` and `ticks-extreme.json` takes its recorded `path`
(`'nice'` or `'fallback'`) and equals its recorded `{min, max, ticks}` exactly.

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

In the browser that controller is #93's `FrameController` on the main thread, the same one the
Canvas 2D frame uses ([ADR-0030](../../designs/adr/0030-engine-camera-controller-on-main.md),
amending ADR-0014 §2 and ADR-0020 decision 4): the worker applies the camera, band and value view it
receives in Camera records and emits no `commit`. See [the camera
controller](#the-camera-controller-part-c2a2).

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
| `setSelection`, `select` (ADR-0025, #192) | not yet ported: the WASM engine must draw the selection in its layer pass (relevance, `opacity.dimmed`, the `focus` underlay, ring and inner stroke, the `selection` band) and emit `select` with the `HoverItem` under a click before it replaces `engine/index.ts`; the `opacity` module of `dash-tokens` carries `DIMMED` |

## Parity with the TS sources

Each Rust port is held to its TypeScript source by a JSON fixture in `engine/fixtures/`, written by
`client/scripts/engine-fixtures.ts` (seeded inputs; non-finite numbers as `"NaN"`, `"Infinity"`,
`"-Infinity"`):

| Fixture | TS source | Rust test |
|---|---|---|
| `format.json` | `i18n/format.ts` `formatValue` | `unit:number-format` |
| `ticks.json` | `canvas2d/valueTicks.ts`, whose powers come from `pow10` and `powBase` (no `**`, #126) | `unit:layout-parity` |
| `pow.json` | the JS engine's `**` under Node 24.22.3 (`10 ** k`, `1000 ** p`, `1024 ** p`), not the helpers it checks | `unit:layout-parity` (Rust `js_pow`), `unit:js-pow` (TS `pow10`, `powBase`) |
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
`golden:engine-overlay` (Part C2b) renders line-50 dark and light with a hover at the plot's centre
column and a box band over 20–40 % of the plot (`line-50-{dark,light}-overlay.png`); T1 and T2
agree within mean ꟻLIP 0.001 (the overlay's coverage is analytic, not byte-equal across tiers).

```
dash-golden render  --page line-50 --theme dark --size 1118x240 --dpr 1 --tier t1 [--value-range MIN,MAX] [--hover X,Y] [--box X0,X] --out a.png
dash-golden compare a.png b.png [--region x,y,w,h]… [--max 0.005] [--tile-max V]   # mean ꟻLIP (and the largest 8×8 tile mean); exit 1 above a limit
```

Baselines are written only by CI with the `golden-update` label (or `make engine-goldens-update`
in the image) and reviewed as images in the PR. The decimation references need no baseline:
`golden:decimation-raw` compares the decimated render with every raw sample drawn through the same
pipeline (zero differing pixels), and `golden:decimation-ref` compares it with an independent f64
rasteriser of the ADR-0014 §4 model (every sample pixel covered, nothing outside the shapes dilated
by one pixel, empty gap bands, the far crossing at the right column).

## Wire decoding (`dash-wire`)

`dash-wire` turns a DSF response body ([Arrow wire writer](../server/arrow.md#dsf-frames)) into
engine events. The path is:

```
fetch chunk ─► SharedBytes ─► FrameSplitter.push / next ─► Frame ─► BodyDecoder.frame ─► Vec<Event>
                                                                       end of input ─► finish ─► Verdict
```

### Why its own reader

The engine reads Arrow IPC with a small reader of its own, written for exactly the four v1
schemas B1 writes. It does not use the arrow-rs crates. On wasm32, `arrow-array` enables
`ahash/compile-time-rng`, which pulls in `tiny-keccak` (CC0-1.0). That licence is outside the
[ADR-0014](../../designs/adr/0014-typescript-react-web-client.md) §7 set (owner decision
2026-11-25). The only normal dependencies of `dash-wire` are `thiserror` and `bytemuck`. The
`dash-wire-deps` rule of `cargo xtask spec-lint` fails on any other one. CI also checks the crate
for `wasm32-unknown-unknown`.

### What it reads

| Item | Accepted |
|---|---|
| Messages | Schema and RecordBatch, metadata V5, little-endian; never DictionaryBatch |
| Types | `uint8/16/32/64` (unsigned), `float64` (DOUBLE), `bool`, `utf8`, `timestamp_ms` (MILLISECOND, `"UTC"`), `list<utf8>`, `fixed_size_list<float64?>` |
| Not accepted | dictionaries, body compression, variadic buffers, custom metadata on messages or fields, schema features, any other type |
| Schemas | `labels/1`, `metric_matrix.grid/1`, `coverage/1`, `error/1`: exactly B1's columns (count, order, name, type, nullability) and exactly their metadata keys |

An extra column is `Unsupported("column")`. A minor version that adds a column or key ships
together with the reader that knows it
([T04-002](../../designs/technical/T04-wire-format-and-data-plane.md#t04-002--schema-identity-and-evolution)).

### Flatbuffer bounds (`fb.rs`)

The Arrow metadata is a flatbuffer. The reader verifies every table it opens and treats any
violation as `IpcError::Flatbuffer`. It never panics.

- **Bounds.** Every read is a checked `get` with checked arithmetic. A table's vtable and object
  lie inside the buffer, with `vt_len` even and at least 4 and `obj_len` at least 4. A present
  field starts at offset 4 or later and ends inside the object. The fields of one table do not
  overlap.
- **Closed field set.** A field that the table's spec does not list is rejected as
  `Unsupported`, and the reader never follows it. This covers unknown vtable entries,
  `Message.custom_metadata`, `Schema.features`, `Field.custom_metadata`, `Field.dictionary` and
  `RecordBatch.compression`. A non-empty `variadicBufferCounts` is rejected too.
- **References.** Every `uoffset` is non-zero and points forward. The target's minimum size is
  in range before its contents are read.
- **Alignment.** Tables and the length prefixes of vectors and strings sit at 4-byte positions.
  Vtables sit at 2-byte positions. The data of `FieldNode` and `Buffer` vectors sits at 8-byte
  positions. Each scalar is aligned to its own size.
- **Strings and bools.** A string ends with a NUL byte and is valid UTF-8. A present bool is the
  byte 0 or 1.
- **No aliasing.** The reader records the extent of every object it visits and rejects any
  overlap. A vtable that several tables share counts once.
- **Two passes.** The first pass walks the whole message and records every extent, leaving
  strings and struct vectors as borrowed slices. Field names, metadata strings, nodes and
  buffers are copied (and strings UTF-8 checked) only after the overlap check passes. Objects
  are then disjoint, so the copies total at most the metadata length, and a byte budget enforces
  that. Many references to one large string are refused before anything is copied.
- **Metadata length and padding.** `L` must be the least value B1 would write for the
  flatbuffer's own length (the high-water mark rounded up to 8), else
  `Layout("metadata length")`. Every byte after the high-water mark must be 0, else
  `Layout("padding")`.
- **Work bounds.** At most 512 tables per message, 64 fields, 64 metadata pairs, nesting depth 4,
  128 nodes and 256 buffers.

### Layout checks (`ipc.rs`)

- **Message.** A message is `FF FF FF FF`, `L` (positive, a multiple of 8, in range), then the
  metadata and a body of exactly `bodyLength`. The body starts at a response-body offset that
  is a multiple of 64 (`Layout("body align")`). A Schema has `bodyLength` 0 and a RecordBatch a
  multiple of 8 (`Layout("body length")`).
- **Buffers.** Buffers are in body order and do not overlap (`Layout("overlap")`). They lie
  inside the body (`Bounds`). Their offsets are multiples of 8, and multiples of 64 in a
  `metric_matrix.grid/1` batch (`Layout("align")`).
- **Nodes.** Each node has `0 ≤ length ≤ 2³¹` and `0 ≤ null_count ≤ length`. A top-level node's
  length equals the batch length. Nodes and buffers must be consumed exactly (`Messages`).
- **Validity.** An empty bitmap is allowed only when `null_count` is 0. A non-empty bitmap covers
  `⌈length/8⌉` bytes, and its 0 bits equal `null_count` exactly. A non-nullable column has no
  nulls. Any of these failing is `Layout("nulls")`.
- **Offsets.** Offsets cover `(length + 1) × 4` bytes, start at exactly 0
  (`Layout("first offset")`) and never decrease. A list's child length equals the last offset
  (`Layout("list child")`). A fixed-size list's child length equals `length × size`.
- **Values.** Every value slice is cut to its logical length. Every UTF-8 value is validated.
- **Zero padding.** Every body byte outside a buffer's logical extent must be 0
  (`Layout("nonzero padding")`). This covers buffer tails, unused bitmap bits, the gaps between
  buffers and the tail after the last buffer.

### Decoder states (`decode.rs`)

Each part follows B2's state table:

| State | Frame | Result |
|---|---|---|
| new | `SCHEMA` (`labels/1`) | labels-open |
| new | `META` planned | data-planned (validated, no event) |
| new | `ERROR\|LAST` | `Upstream`, `PartEnd` (a part that never opened) |
| labels-open | `BATCH` | rows added; with `LAST`: `PartEnd`, labels-done |
| data-planned | `SCHEMA` (`metric_matrix.grid/1`) | `Grid` |
| data-open | `BATCH` | `Chunk` |
| data-open | `META` partial or final with `LAST` | `Coverage`, `PartEnd`; held until the labels part finishes |
| data-open | `META` partial without `LAST` | `Coverage`, then closing |
| data-open or closing | `ERROR\|LAST` | `Upstream`, `PartEnd` |

Any other frame fails the part with `Failed(Order)`. Other checks also fail only their own part
(T04-010), and the part's later frames are discarded:

- an unknown schema or a major other than 1 (`Schema`);
- bad grid metadata (`Schema`): `step_ms ≤ 0`, `len` of 0 or over `MAX_GRID_LEN` (2²²), or a
  `requested_start_ms` outside `[start_ms, start_ms + step_ms)` (computed as B1's unsigned
  difference, so no addition can overflow);
- a grid end that overflows i64 (`Schema`);
- a list size other than `len` (`Shape`);
- label rows that are not contiguous per series, a series with mixed key hashes, a half-null
  label, a null row next to a named row, or names that are not strictly increasing by bytes
  (`Shape`);
- a series spread over two labels batches, or repeated in the data (`DuplicateSeries`);
- a series with no labels (`MissingLabels`);
- a null slot whose bits are not `0x7FF8000000000000` (`NullBits`);
- a rank change (`Rank`);
- `VOLATILE` and `CACHED` bits that differ from the part's first frame, or from its linked part
  (`Order("flags")`);
- a value outside its closed set (`Value(field)`): phase, exactness, `read_cache`, error code,
  `dash.result`, `dash.source`, `dash.time_unit` or `dash.schema`.

`dash.labels_part` is checked at the data `SCHEMA`. It must name a labels part already seen in
the body that is not failed and is not the data part itself (`Schema("labels_part")`). It must
also have the same rank (`Schema("labels_part rank")`). When a labels part fails, every data part
linked to it fails in the same call with `Order("labels part failed")`, and any coverage it was
holding is discarded.

**Stream-level checks.** These fail every open part through `fail_stream`:
- an unknown flag bit (`Flags`);
- an END with a payload, a part, a rank or any flag (`Malformed("end")`);
- a PING with a payload or a part (`Malformed("ping")`);
- a PROGRESS or EVENT frame (`FrameType`);
- a payload length that is not a multiple of 8 (`Malformed("frame length")`);
- any part-0 frame other than END, PING and the one stream-level ERROR (`Malformed("part 0")`).

The stream-level `ERROR|LAST` on part 0 gives `Upstream { part: 0 }` and sets `stream_error()`.
A frame after END gives `Failed(Stream(AfterEnd))`.

### End of input and the verdict

At the end of input, call `FrameSplitter::finish()` first. If bytes remain, call
`fail_stream(Truncated)`. Then always call `BodyDecoder::finish()`.

- **END with open parts.** Each open part gets `Failed(Order("open at END"))` before `End`.
- **`finish`.** It fails every still-open part with `Stream(Truncated)` in part-id order. It
  emits `Truncated` if END never arrived, then always ends with `Event::Verdict`.
- **The verdict.** It is `Complete` only if END arrived, the stream did not fail, no part-0 ERROR
  came and no part failed. Otherwise it is `Incomplete(reason)`.
- **Coverage.** Every `Coverage` is provisional until the verdict. A response is complete for the
  meter only when the verdict is `Complete` and every part's last coverage is complete
  (`Coverage::complete`, `retention_limited`, `exact`; the rule is on the
  [Arrow page](../server/arrow.md#coverage)).
- **Repeated calls.** A second `finish` returns nothing. Frames after `finish` or `fail_stream`
  are ignored.

### Chunk ownership and the copy budget

- **Chunks own their data.** A published `Chunk` owns exact-size copies of its values
  (`Vec<f64>`, cut to the child length) and validity (`Vec<u64>` words, LSB first, trailing bits
  0; `None` when nothing is null). Chunk ids rise from `first_chunk_id`. A batch after
  `u64::MAX` fails its part with `Limit("chunk ids")`.
- **Shared labels.** `SeriesMeta.labels` is an `Arc<[(String, String)]>`. It is built once per
  series from its labels batch, and every chunk holds an `Arc` clone of it.
- **Slabs.** A frame inside one pushed chunk is a slice of it. For a frame that spans chunks,
  only the payload is copied, once, into a buffer that keeps its response-body position mod 64.
- **Nothing pinned.** The decoder drops every frame when `frame` returns. Once a slab's frames
  are consumed, its only owner is the caller, so slabs can be recycled at once. `push` returns
  `Busy` until the previous chunk is drained.
- **The copy budget**
  ([T04-015](../../designs/technical/T04-wire-format-and-data-plane.md#t04-015--at-most-two-copies-on-the-network-path)).
  The values are copied once into the chunk and once into GPU memory. This is one memcpy more
  than a zero-copy view. In exchange, retained memory is exactly the published values.
  `bench:decode-r1` reports the cost.
- **The join (Part D2,
  [ADR-0034](../../designs/adr/0034-grid-part-joined-into-one-chunk.md)).** The decoder makes one
  chunk per grid batch, because a part's series count is not known before it has streamed.
  `join::join_grid` joins a part's batch chunks, in arrival order, into the one chunk a frame draws
  (T02-002): one more exact-size copy of the values and validity, sized with checked arithmetic
  before anything is allocated (an overflow, or more than 2³¹ samples, is `JoinError::Size`). A
  part of exactly one batch is reused without a copy.

### Limits and budgets

The reader enforces the shared limits of
[`wire/schemas/limits.json`](../../wire/schemas/limits.json) (plan #68 B3,
[T04-010](../../designs/technical/T04-wire-format-and-data-plane.md#t04-010--decoders-bound-and-validate-everything)).
The values, the accounting and the writer's side are on the
[Arrow page](../server/arrow.md#limits). `dash_wire::limits` holds them as `pub const`s (plus
`cost::*`), and `unit:limits-json` checks every one against the file. Each count is computed
from validated offsets and lengths before the `Vec` or `String` it bounds is allocated.

| Limit | Default | Past it |
|---|---|---|
| open parts | 64 | the stream fails: every open part `Failed(Stream(Limit))` |
| distinct part ids per body | 1 024 | the stream fails |
| rows per batch | labels 1 048 576, grid 65 536 | the part fails (`Limit`) |
| series per data part, label rows per labels part, label bytes per labels part | 1 048 576, 4 194 304, 16 MiB | the part fails |
| META list elements (all lists), META or ERROR string bytes | 4 096, 1 MiB | the part fails (a part-0 ERROR fails the stream) |
| body budget | 64 MiB | the stream fails (`Limit("body budget")`) |
| value budget | 1 GiB | the stream fails (`Limit("value budget")`) |

- **Body budget.** A monotonic count of the bytes the decoder creates for the body: per part,
  per SCHEMA frame (debited before it is copied, and kept if it is rejected; its memory goes with the part, the charge
  stays), per series label set (charged once, when the labels batch builds the `Arc`; chunks
  only clone it), per chunk, per coverage and per error row. Never refunded.
- **Debit first, copy second.** A SCHEMA's accounted size is computed from the verified,
  still-borrowed flatbuffer and debited from the body budget before any of its strings is
  copied; the debit stays if the schema is then rejected, so repeated invalid schemas exhaust
  the budget. Past the budget, the stream fails with `Limit("body budget")`. The schema of a
  META or ERROR stream is compared with the canonical `coverage/1` or `error/1` schema from the
  borrowed message and never copied (its row is charged). `GridInfo.unit` and
  `GridInfo.planned` are `Arc<str>` shared with the part's schema, so a held grid event adds no
  second copy.
- **Retained forms that fit their charges.** A labels part keeps its series in one exact-size,
  id-ordered slice per labels batch (32 B per series; series ids must rise across the part, as
  B1 writes them, and a repeated or out-of-order id in a data part is `DuplicateSeries`); every
  series without labels shares one empty label set. A coverage list is a packed `StrList`
  (one allocation: 4 B per element plus its bytes). An `ErrorRow`'s message and suggestion are
  `Arc<str>`, so the decoder's stream-level copy and the emitted event share one allocation.
  A labels part keeps no copy of its accepted schema (its batches are read with the canonical
  `labels/1` columns) and a data part keeps only its two grid columns. Unit tests assert each
  form against its charge (`cost::SERIES` is 96 for this reason): the boxed labels and data
  state and their columns against the schema's fixed 256 B, a part's map slot against the part's
  256 B; `tests/limits_live.rs` also measures parts and schemas alone (live ≤ body budget used
  after every frame).
- **The bound.** With the decoder and every emitted event held, the heap they retain is at most
  the body budget used plus the value budget used (`tests/limits_live.rs`, live-byte counting
  allocator). The `Event` values themselves live in the caller's container
  (`size_of::<Event>()` each, at most 3 + 2 × linked parts per frame). On top, each frame uses
  scratch released before the next one, at most 4 × its payload length + 64 KiB: the column
  descriptors, the flatbuffer verifier's extents, a labels batch's series slice and one series'
  label vector, a list's end offsets, and the returned event vector.
- **Bounded diagnostics.** A `PartError::Schema` message quotes at most 64 bytes of the
  offending value, cut at a UTF-8 boundary and escaped, the quote capped at 128 bytes, so a
  failed part's diagnostic stays small whatever the input.
- **Value budget.** Per chunk, its values and validity words (8 × values + 8 × ⌈values / 64⌉),
  charged before they are allocated.
- **Part 0.** At most one stream-level ERROR; a second fails the stream (`Malformed("part 0")`).
  It is charged as an error row and is not a part.
- **API.** `BodyDecoder::new(first)` uses the defaults; `BodyDecoder::with_limits(first,
  Limits)` takes another set (tests use `limits-test.json`). `retained()` returns
  `(open parts, distinct part ids seen, body budget used)`.
- **The writer-valid guarantee.** The Go writer enforces the same limits first and turns each
  into an explicit outcome (split batches, `truncated` coverage, the stream-level ERROR), so a
  body it writes never fails here. `unit:dsf-limits` decodes every `limits-*.dsf` fixture with
  `limits-test.json` without a `Failed`, and `budget-over.dsf` (the same input written with the
  writer's budget check off) fails with `Limit`.

**Input and source bounds** (for Part D's byte pump):
- `FrameSplitter::push` measures a chunk by `SharedBytes::backing_len()`, the whole allocation,
  and refuses one above `MAX_CHUNK` (128 MiB) with `Limit("chunk")`, sticky.
  `FrameSplitter::retained_bytes()` (the current chunk, a split payload's buffer and the header
  buffer) stays at most `MAX_CHUNK + HEADER_LEN + MAX_PAYLOAD`, plus under 128 bytes of the
  payload buffer's alignment rounding.
- `slabs_from(data, body_offset, max)` copies a fetch chunk into fresh slabs whose backing
  allocations are at most `max` (a multiple of 64), each keeping its body offset mod 64. A slab
  at body offset `o` takes `min(remaining, max − o mod 64)` bytes. Part D feeds every fetch chunk
  through it with `max = MAX_CHUNK`, and never hands the splitter a slice of a larger buffer.
- Part D reads the Arrow body only with a BYOB reader into one `SOURCE_BUFFER` (1 MiB) buffer,
  rebinding to the buffer each read returns. Without BYOB support it uses the JSON route; if
  `getReader({ mode: "byob" })` throws on an Arrow response, it cancels the body unread and
  repeats the query as JSON. Memory per response is then bounded by the source buffer, the slab
  being filled, `retained_bytes()` and the two budgets.

### Gates

| Gate | Test | Checks |
|---|---|---|
| `unit:codec-roundtrip` (Rust) | `tests/codec_roundtrip.rs` | the five B1 fixtures decode to their `.expect.json`, plus the spot checks |
| `unit:dsf-header` (Rust) | `src/dsf.rs` | the B1 header bytes; version, reserved, type, flags and length faults |
| `unit:fb-reader` | `src/fb.rs`, `tests/alias_alloc.rs` | hand-built and mutated flatbuffers; aliased strings refused without copying (counting allocator): defaults, bounds, alignment, references, closed field set, aliasing, depth and table counts, metadata and frame lengths |
| `unit:dsf-bounds` | `tests/dsf_bounds.rs`, `tests/dsf_bounds_layout.rs` | split points, header and frame faults, state rules, links, padding, offsets, closed sets, IPC corruptions, arithmetic boundaries, end of input |
| `unit:dsf-fuzz-smoke` | `tests/fuzz_smoke.rs` | 25 000 seeded mutants per fixture: no panic, consistent chunks |
| `unit:arrow-alignment` (Rust) | `tests/arrow_alignment.rs` | every split point pins nothing; 8-but-not-64-aligned grid buffers and bodies are refused |
| `unit:coverage-complete` (Rust) | `src/coverage.rs` | `complete`, `retention_limited` and `exact` |
| `unit:limits-json` (Rust) | `src/limits.rs` | every limit, cost and reserve and `MAX_GRID_LEN` = `wire/schemas/limits.json` |
| `unit:dsf-limits` | `tests/dsf_limits.rs`, `tests/limits_alloc.rs` (counting allocator: schemas debited before copying, rejected schemas exhausting the budget, stream schemas never copied, one copy behind a held grid event, bounded diagnostics) | the source, input and byte-pump bounds; open and distinct parts, rows, labels, META and ERROR strings, the body and value budgets on built bodies; every writer-valid `limits-*.dsf` fixture and `budget-over.dsf` |
| `ci:spec-lint` (`dash-wire-deps`) | `xtask/tests/spec_lint.rs` | `dash-wire` depends only on `thiserror` and `bytemuck` |

The tests share a test kit (`tests/common/`) that reads and writes the Arrow flatbuffer tables
and DSF bodies used for the mutations. `dash-wire` is built with `opt-level = 2` in the dev
profile so that the split-point and fuzz tests stay fast.

## In the browser (Part C1)

Part C1 runs the engine in the page; since #256 it is the default renderer
([ADR-0031](../../designs/adr/0031-gpu-engine-default-renderer.md)): a chart frame uses it unless
the engine flag (the URL's `?engine=`, else the build's `VITE_ENGINE`) is `canvas2d` or the page
cannot run it. Axis text, bars, heatmap and stat stay with Canvas 2D until #69; Part C2 adds input: the input ring
(C2a1, [below](#the-input-ring-part-c2a1)), the camera controller (C2a2,
[below](#the-camera-controller-part-c2a2)), then hover and selection; Part D
streams Arrow data to a data worker.

### Choosing an engine

`client/src/engine/index.ts` calls `chooseEngine` (`select.ts`) once per page; the first match
wins:

| # | Condition | Engine |
|---|---|---|
| 1 | The flag (the URL's `?engine=`, else the build's `VITE_ENGINE`) is `canvas2d` | Canvas 2D |
| 2 | The session is marked failed (`failFlag.ts`: a trap, a second device loss, or a failed boot, below) | Canvas 2D |
| 3 | `?mode=mtr` or `?mode=static` (MT-R is #269, Static's PNGs #270) | Canvas 2D |
| 4 | No `OffscreenCanvas`, or neither WebGPU nor WebGL2 | Canvas 2D |
| 5 | `?mode=st`, not cross-origin isolated, or no `Atomics.waitAsync` | the routing engine on the **single-thread engine** (`mode: 'st'`, [below](#the-single-thread-engine-part-c2d2)) |
| 6 | Otherwise: no flag, `wasm`, empty or any other value | the routing engine (line frames on the engine, the other kinds on Canvas 2D); `?mode=t2` forces WebGL2 |

There are two overrides, and only `canvas2d` does anything: `?engine=canvas2d` on a page, and a
`VITE_ENGINE=canvas2d` build (the engine is still built in; the main e2e suite pins its builds this
way, [Build, test and CI](../development/build-and-ci.md#end-to-end-tests)). The URL beats the
build: `?engine=wasm` opts a page of a pinned build in.

**A failed boot marks the session** (`markOnFailure` in `failFlag.ts`, plan #256 §4.2). When the
engine does not boot (the integrity check refuses the wasm twice, a compile error, status 3 or 4,
or no status in 10 s), its frames stay on Canvas 2D with no notice, as before, and the session is
marked, so later pages take row 2 and make no engine request. The page's single `load()` promise
marks at most once. A module without the engine (the unit tests' `absent.ts`: `compileEngine`
throws `EngineAbsent`) is not marked, so building the engine takes effect at the next reload; the
console still shows `pulsus engine unavailable: …`.

**The accepted gap until #69** (ADR-0031). Engine line frames draw no axis labels or tick text,
and no threshold or event labels. Their summaries' `thresholdLabels` and `eventLabels` are `[]`:
there is no `ThresholdHit` or `EventHit`, event labels are not keyboard-reachable, and the summary
text carries no event count. `?engine=canvas2d` restores them.

Every chart canvas carries `data-engine`: `canvas2d`, `wasm-webgpu` or `wasm-webgl2` (in either
engine mode). With the engine, `<html>` carries `data-dash-status` (0 booting, 1 WebGPU, 2 WebGL2,
4 failed), `data-dash-mode` (`mt` or `st`) and `data-dash-adapter`.

### The single-thread engine (Part C2d2)

`dash-core-st` runs the engine where the shared-memory engine cannot: a page that is not
cross-origin isolated (a proxy stripped COOP or COEP), a browser without `Atomics.waitAsync`, or a
page opened with `?mode=st`. It needs OffscreenCanvas and a GPU API like the MT engine. Everything
the MT engine draws runs unchanged: the same Rust, the same TS frames, controller, events and record
format. Only the build, the worker topology and the input transport differ (T03 §9.2,
[ADR-0033](../../designs/adr/0033-st-render-worker-script.md)).

| | MT | ST |
|---|---|---|
| Build | `cargo xtask build-wasm` (`+atomics`, `build-std`, shared imported memory) → `gen/dash_core_mt*` | `cargo xtask build-wasm --st` (`--no-default-features --features st`, no `+atomics`, the module's own memory ≤ 2 GiB) → `gen-st/dash_core_st*` |
| Glue | `virtual:dash-engine` | `virtual:dash-engine-st` |
| Workers | `render.worker.ts` and the rayon pool | `render-st.worker.ts` only |
| CPU decimation (T2, far items) | rayon over series | the same loops, in order (`dash-scales` without `parallel`): the same output |
| Input | the shared input ring | `BatchRing`: the same records in transferred batches |
| Files | `assets/dash-engine-mt-*` | `assets/dash-engine-st-*` |

Both workers share their logic in `wasm/renderCore.ts`; `render.worker.ts` and
`render-st.worker.ts` differ only in their bindings and in starting the pool. The ST wasm is
integrity-checked against the signed manifest as the MT wasm is. Restart, fallback and the session
flag are as in MT: a failed ST boot marks the session.

**Features.** `dash-core` has `mt` (default: `dash-scales/parallel` and the pool) and `st`.
`dash-scales` has one feature, `parallel` (rayon), and no default features; the workspace
dependency turns default features off, so nothing pulls rayon into ST by unification
(`unit:st-features` checks `cargo tree`). `dash-golden` names `parallel`.
`unit:decimate-sequential` builds the `decimate-dump` example of `dash-scales` twice, sequential
and parallel, and requires byte-equal dumps.

**The batch handshake.** Main cannot write ST memory, so `wasm/ring.ts` splits the adapter's
record queue (`RecordQueue`: pending, coalescing per kind and frame, per-frame seqs, the cap of 8
waiting Selects per frame) from its sink:

1. Every call goes to pending. On main's animation frame, if no batch is in flight, up to 64 KiB of
   pending records are written, in order and in the input ring's format, into a batch buffer; each
   gets its seq there and `onPublish` fires. Then main posts `{t: 'input-batch', buf, len}` with
   `buf` transferred. Two buffers alternate.
2. The worker keeps the buffer, calls `engine_input_batch(bytes)` (the records are decoded by
   `input::drain_batch` and queued in the engine; a bad record counts in `INPUT_BAD` and skips the
   rest of the batch) and wakes its loop.
3. The next tick applies the queued records first (T03-019), then builds and presents. After that
   tick the worker posts `{t: 'input-ack', buf, depth, bad}` with `buf` transferred back.
4. `BatchRing.acked(buf, depth)` frees the buffer; the next animation frame may post again.

So at most one batch exists end to end, in transit, queued or unapplied. The `applied`
acknowledgements and `drawn` seqs are as in MT, so `settle` and every gate are unchanged. An ST
`stats()` adds `overflow` (Selects dropped by the cap), `batches` and `batchesInFlightMax` (the most
in flight: main's count, or the worker's `depth`).

**The banner.** When the engine booted in ST, `AppShell` shows one `EngineModeBanner` under the
header (`role="status"`, token colours, no close button), whichever frame booted the engine, with
the text for its reason (`engineMode()` in `engine/index.ts`, first match):

| Reason | When | Text |
|---|---|---|
| `forced` | `?mode=st` | "Reduced performance: the single-thread chart engine was requested for this page." |
| `isolation` | not cross-origin isolated | "Reduced performance: cross-origin isolation is off (ask your admin)." |
| `waitAsync` | isolated, no `Atomics.waitAsync` | "Reduced performance: this browser lacks a feature the fast chart engine needs." |

`engineMode()` is null before the first frame, `{mode: 'mt'}`, `{mode: 'st', reason}` or
`{mode: 'canvas2d'}` (a Canvas 2D page, a failed boot, or a fatal engine); `onEngineMode(cb)`
subscribes. No banner shows in any mode but ST.

**Limits.** No pool: CPU decimation runs on the one worker. T03 §9.2's ST ceiling of 10⁷ line
points is measured by `bench:frame-line-1e8`'s `1e7-st` cases, not enforced; a coverage note when
it binds comes with the coverage meter. MT-R (no OffscreenCanvas) and Static still draw with
Canvas 2D until #269 and #270.

### The routing engine (`route.ts`)

One routing frame per `ChartFrame`, bound on its first spec:

- **Bind.** A line spec waits for the engine to boot, then transfers the canvas
  (`transferControlToOffscreen`) to the render worker; any other kind, or an engine that did not
  boot (status 4, a compile or integrity failure, or no status in 10 s; `console.warn`), goes to
  Canvas 2D on the same canvas. The engine loads on the first chart frame: `wasm/engine.ts` is a
  lazy chunk.
- **State.** The routing frame keeps the latest spec, data, time window, theme, events, selection
  and size, and its listeners, and replays them, in that order, at every bind.
- **Kind swap.** An engine frame whose spec changes to another kind moves to Canvas 2D on a fresh
  canvas, without a notice, and stays there.
- **Fallback.** A frame the engine cannot draw (`failed`: its surface, or three failed read-backs in
  a row) moves to Canvas 2D: a fresh `<canvas>` (same class, role and label) goes after the current
  one, which stays for ChartFrame's reference, retired (`data-retired`, `hidden`,
  `aria-hidden="true"`, `display: none !important` from CSSOM and from `route.module.css`); a
  `MutationObserver` copies ChartFrame's label and class to the live canvas; the state is replayed
  and a notice reads "Recovered from an error: this chart uses the basic renderer." Dispose removes
  what the routing frame created; ChartFrame removes its own canvas. No component changed.

### The geomap on Canvas 2D (#234 Part 2)

The routing engine binds every kind but line to Canvas 2D, so a `geomap` spec always gets a
`Canvas2DFrame` ([ADR-0031](../../designs/adr/0031-gpu-engine-default-renderer.md)). That frame
delegates the kind to a scene in its own chunk
([ADR-0027](../../designs/adr/0027-geomap-frame-seam.md), [geomap](geomap.md#the-map-in-the-canvas-2d-engine-234-part-2)):

- **Lazy load.** The first `geomap` spec calls `loadGeoModule()`: one shared promise for the page,
  kept once it resolves; a rejection clears it, so the next `geomap` spec, on this frame or another,
  imports again. The frame logs the failure once (`pulsus map renderer unavailable: …`) and stays
  blank with no `drawn`.
- **Failure summary (#234 Part 3 §4.4a).** When the scene import rejects and the load's generation
  still matches, the frame is not disposed and its kind is still `geomap`, the frame emits exactly
  one `a11y` summary `{kind: 'geomap', geo: null, …}` (zero counts, the plot, no labels) and no
  `drawn`; otherwise it emits nothing. The summary type is unchanged: `geo: null` on a geomap
  summary means "the renderer could not load". `ChartFrameProps.onSummary` hands every summary to
  the caller after the frame's own state; the map host reads this one and shows its load-failure
  state with Retry, then Reload ([geomap](geomap.md#load-failure-geomapbody)). `Canvas2DOptions.loadGeo` replaces the
  loader in tests (`geoModuleLoader(imp)` builds one over any import).
- **Generation guard.** Each load takes `geoGen + 1`; leaving `geomap` and `dispose` bump `geoGen`.
  A module that resolves for an old generation, a disposed frame or another kind is kept (cached)
  and attaches nothing: no scene, no listener, no event.
- **Delegation.** The frame stores every input and forwards it to the scene: `setSpec`,
  `setData` (the `geo` frame data), `setSelection`, `setTheme`, `resize`, `setFocusMark` and
  `cameraKey`. On attach it replays the spec, data, theme, size, selection and focus mark. A
  camera key sent before the scene exists is dropped (it acts on the map shown). `setTimeWindow` and
  `setEvents` are stored and draw nothing. Until the scene exists the frame paints `map-water` and emits no `drawn`, so the host's
  pending state stays.
- **Drawing.** No layer cache: each frame the scene paints the visible canvas, the frame emits the
  `chart-draw` measure (`kind: 'geomap'`, `series` = the marks; `bench:geomap-markers` reads it), `a11y` when the summary's JSON changed, `chart-present` and `drawn`, and schedules
  another frame while an ease, a fling or a crossfade runs.
- **Input.** The scene's `GeoController` listens on the canvas (pointer, wheel, double-click,
  context menu) and on the key target (keydown); the shared time `FrameController` does not listen
  on a geomap, as on a stat. Leaving `geomap` disposes the scene and its listeners before the time
  camera listens again, and clears a hover it showed.
- **What a GPU engine reuses.** `engine/controller/geo/` (projection, camera, marks, pick and
  `GeoController`) imports no renderer: its listener, wheel and latch helpers are in
  `engine/controller/input.ts` (re-exported by `canvas2d/input.ts` and `canvas2d/gesture.ts`); a GPU geomap supplies a `GeoStage` (its marks, the shown
  rows' positions, a member's position and `redraw`) and replaces `engine/canvas2d/geo/`'s painter.
  `engine/controller/inertia.ts` is the T02-022 spring, for any camera that flings.

The seam additions it implements are Part 1's: `setFocusMark`, `cameraKey`, `FrameSummary.geo` and
the `geoCommit`, `geoBrush` and `geoMarks` events. The marks use `pattern-ink` and
`category-other` from `design/tokens.toml`.

### Workers and memory

The main thread never instantiates the module (T03-003). It fetches the wasm with the SHA-384 of
the BFF-verified `/asset-manifest.json` (`fetch(url, {integrity})`, one retry; without a manifest a
dev server fetches it plainly and a release build has no engine), compiles it
(`WebAssembly.compileStreaming`) and posts the `Module`:

| Thread | Does |
|---|---|
| main | routing frames and their state, the `Module`, the workers, the `pulsus-engine` Trusted Types policy |
| render (`wasm/render.worker.ts`) | instantiates the engine on a new shared memory (≤ 2 GiB), `engine_start` (control block, GPU), the frame table, one renderer and surface per frame, the frame loop on the worker's animation frames |
| pool × m (`wasm/pool.worker.ts`) | rayon threads on the same module and memory, started by the main thread when the render worker asks (`spawn-pool{ptr}`); m = `clamp(hwc − 3 − clamp(⌊hwc/4⌋, 1, 3), 1, 6)` |

Messages are in `wasm/protocol.ts` (tag `t`): `boot`, `create` (the canvas transferred), `spec`,
`data` (series cloned; heatmap and scalar `null`), `theme`, `dispose` and `input` (a wake-up) to
the render worker; `status`, `spawn-pool`, `events` (one JSON array per animation frame:
`created`, `applied`, `a11y`, `drawn`, `failed`, `tier`, `fatal`) back. The camera and the size
travel in the input ring, not as messages. Data enters the engine only through `Frames::set_chunk`; the TS
series become a chunk in the local id space (`IdSpace::Local`, 2⁶³…2⁶⁴), so Part D's decoder ids
(`IdSpace::Stream`, 0…2⁶³) never collide with them. The control block is `dash-protocol`'s layout
v1 (T03 §4.3); `client/src/engine/wasm/layout.gen.ts` is generated from it.

### Range data as DSF (Part D2)

In MT, a board or Explore range query reaches the engine as DSF, and the line frame takes the
decoded chunk by reference. The main thread never parses the data (T03-003): it reads the response
body as bytes and hands each read to the render worker, and the pool decodes it.

| Engine | Range data |
|---|---|
| MT, booted (status 1 or 2) | DSF, decoded on the pool, the chunk by reference |
| ST | JSON, as before (a resumable ST decode is #281) |
| Canvas 2D, or before the first boot | JSON, as before |

**The decoder slot.** `client/src/api/rangeDecoder.ts` holds the API layer's range decoder. It
imports nothing from `engine/`. When an MT backend boots, `engine/index.ts` fills the slot with
`streamDecoder(open, register)`: `open` is the backend's `openDecode`, and `register` records the
result's series array in `engine/wasm/chunkRefs.ts`. A failure for the session clears the slot. With
the slot filled, `HttpApi.queryRange` sends `Accept: application/vnd.pulsus.dash-stream;v=1,
application/json;q=0.1` (see [panels](panels.md#range-data-json-or-dsf-68-part-d2)).

**Messages** (`wasm/protocol.ts`; MT only):

| Direction | Message | What |
|---|---|---|
| main → render | `decode-begin {req}` | a decode; `req` is page-unique |
| main → render | `decode-chunk {req, buf}` | one read's exact bytes, in order, `buf` transferred |
| render → main | `decode-credit {req, bytes}` | bytes the pool has consumed |
| main → render | `decode-end {req}`, `decode-abort {req}` | the end of the body; the request's signal aborted |
| render → main | `decoded {req, chunk, epoch, head, ts, vs}` | the table id and epoch of the chunk, the head (grid, `dash.planned`, the final coverage, each series' key and labels), one shared `ts` and each series over the full grid (absent points NaN), `ts` and `vs` transferred |
| render → main | `decode-failed {req, kind, message, row?, coverage?, planned?}` | `error` (an `error/1` row), `limit` (a B3 limit), `invalid` (T04-010), `ids`, `busy` |
| main → render | `data-chunk {id, chunk, epoch}` | `setData` by reference |
| render → main | `chunk-missing {id, chunk}` | the chunk was evicted, or is of another epoch: the frame posts its values |
| main → render | `chunk-release {chunk, epoch}` | the registered array was collected |

**Backpressure** (`streamDecoder`):

- Each read goes whole. A view that spans its buffer transfers that buffer; any other view is
  copied (`slice`) to its exact bytes.
- Main counts the bytes posted minus the credits. At 8 MiB or more (`PAUSE_THRESHOLD_BYTES`) it
  stops reading, and resumes on the credit that brings the count under it. This is a pause
  threshold, not a cap: one read can take the count well past it.
- A read over B3's `max_chunk` (128 MiB) is never posted: main cancels the reader, aborts the
  decode and retries the request once as JSON.
- An abort cancels the reader and posts `decode-abort`, whether reading or paused.

**The worker** (`dash-core` `decode.rs`, `web/mod.rs`):

| Thread | Owns |
|---|---|
| main | the fetch and its reader (bytes only), the backpressure, the assembly, `chunkRefs` |
| render | the `DecodeService`, the chunk table and the id allocator; it never decodes |
| pool | feeding the `FrameSplitter` and `BodyDecoder`; `join_grid` |

`engine_decode_chunk` copies a read into 64-aligned slabs (`slabs_from`) and queues them. `pump`
starts at most one pool task per request; the task drains the queue in order and credits each slab.
At END it joins the batch chunks, drops them, and builds `ts` and `vs`. No lock is taken (T03-008):
a request's decoder state belongs to render or to its one running task, and moves between them
through channels. At each tick start `engine_decode_take` puts the decoded chunk in the table and
returns the messages for the worker to post. While a decode runs, `engine_wants_frame` stays true.
A body with other than one grid part is `invalid`.

**Ids, epochs and the table.**

- The table hands out `u32` ids from 1, increasing and never reused within a worker's life, so an
  id is exact as a JS number.
- At `u32::MAX` a decode fails with `ids` and is retried as JSON. A restart starts a new table.
- Every worker has a boot epoch (1, then +1 per restart), written as `BOOT_EPOCH` and passed in the
  `boot` message. `data-chunk` and `chunk-release` carry it, and the worker acts only on its own: a
  stale reference is answered `chunk-missing`, and a late finaliser's release is ignored.
- The chunks themselves take stream-space `ChunkId`s, a block of 2³² per request, so they never
  collide with the local ids of TS-built chunks in a renderer's caches.

**Data by reference** (`wasm/frame.ts`, `wasm/chunkRefs.ts`):

| Step | Behaviour |
|---|---|
| `WasmFrame.setData(d)` | `refOf(d.series)` of the current epoch → `data-chunk`; else the values, as before |
| `chunk-missing` | the frame posts the values of its last `setData` |
| restart | a new epoch: old references are stale, so values are posted |
| collected | the `FinalizationRegistry` posts `chunk-release`; a frame still holding the chunk keeps drawing it |
| pressure | unheld chunks beyond 256 MiB are evicted, least recently used first |

Only the identical array matches. A filtered, isolated or merged list (for example `framePlan`'s
isolated series, or a bar chart's common grid) is another array and goes by value. Chunks belong to
one request and are looked up only by their id, never by query, so tenants and scopes never share
one (T04-017).

**The memory contract**
([ADR-0034](../../designs/adr/0034-grid-part-joined-into-one-chunk.md)), and the only claim made:

| Memory | Bound |
|---|---|
| In flight | per decode, the B3 wire limits the decoder enforces (a frame payload of at most 64 MiB, a grid of at most 2²² points, the body and value budgets), × at most 2 decodes per worker |
| Completed | the table's chunks held by no frame, at most 256 MiB, LRU; plus main's arrays, held by the query cache |

**Fallbacks.**

| Outcome | What happens |
|---|---|
| `limit` (a B3 limit, a joined size over 2³¹ samples, a read over `max_chunk`) | one JSON retry |
| `ids` (the table's ids used up) | one JSON retry |
| `busy` (two decodes already open) | JSON at once; the DSF body is not read |
| `gone` (no running engine, or a restart or failure mid-decode) | one JSON retry |
| `error` (an `error/1` row) | its class's `ApiError` (`errorFromRow`) |
| `invalid` (T04-010), or a missing or invalid `dash.planned` | `ApiError('internal')` and the `rum:wire_invalid` mark; no retry |

**The probe** (fault builds, `?probe=1`) adds `decodes()` (begun, done, failed, aborted, retried as
JSON, by-reference `setData`), `chunks()` (the table's count and bytes, through
`engine_chunk_stats`) and `decoder(on)` (the slot off, or back). `main.tsx` exposes the query
client there as `__dashProbeQueries`, so the e2e suite can refetch and clear.

### The input ring (Part C2a1)

The camera (the time window, the value range and the value-label band), the size, the hover and
box band (the overlay) and the clicks of each engine frame go from the main thread to the render
worker through the control block's input ring
(T03 §5.4), one producer (`wasm/ring.ts`, one `InputRing` per engine memory) and one consumer
(`dash-core::input`), read at the start of each worker tick (T03-019).

**Records.** A 16-byte header `0 u8 kind · 1 u8 flags · 2 u16 size · 4 u32 seq · 8 f64 t_ms` (the
main thread's `performance.now()` at the call), little-endian, every size a multiple of 8:

| Kind | Name | Size | Payload |
|---|---|---|---|
| `0x00` | Wrap | — | continue at the start of the ring (written in a gap at the end that a record would cross) |
| `0x20` | Resize | 40 | `f32` CSS width, height and DPR, `u32` device width and height (`round(css × dpr)`), `u32` frame |
| `0x23` | Camera | 64 | `u32` frame, pad, `f64` view lo and hi (ms), value min and max (NaN = auto), band (NaN = measured) |
| `0x24` | Overlay (Part C2b) | 64 | `u32` frame, `u8` hover (0 none, 1 pointer, 2 key), `u8` box (0, 1), `u16` 0, `f64` pointer x and y (CSS px), `u32` key index, `u32` 0, `f64` box x0 and x (CSS px); fields a mode does not use are 0 |
| `0x25` | Select (Part C2b) | 40 | `u32` frame, `u32` 0, `f64` x and y (CSS px) |

`0x26` is reserved. The offsets are `dash-protocol::input`, generated into `layout.gen.ts`
(`REC_*`, `RESIZE_*`, `CAMERA_*`, `OVERLAY_*`, `SELECT_*`).

**Counters.** `INPUT_HEAD` (0x80, main) and `INPUT_TAIL` (0xC0, render) are free-running `u32` byte
counts: occupied = `(head − tail) mod 2³²`, the physical offset = `counter & 0xFFFF`. The producer
writes a record, then stores the head (release); the consumer loads the head (acquire), reads
`[tail, head)` and stores tail = head. They roll over 2³² freely.

**Coalescing.** A state record (Resize, Camera, Overlay) that does not fit waits on the main
thread, keyed by kind and frame: a later call of the same kind for the same frame replaces it
(deleted, then inserted at the end; `coalesced` counts these). A Select is discrete: its key is
unique, so it is never replaced, and a frame keeps at most 8 waiting; a 9th drops that frame's
oldest waiting Select, adds 1 to `INPUT_OVERFLOW` and warns once per frame (`pulsus engine: frame
<id> dropped a click (ring full)`). Up to 32 waiting records are published before a new one, which
waits behind any that remain; each animation frame publishes up to 256. Nothing else is dropped.

**Seqs.** Each frame numbers its records from 1 when they are published (never while they wait),
skipping 0 on the wire. The main thread keeps each frame's count as a 53-bit integer and extends
the worker's `u32` acknowledgements to it (`extendSeq`); the worker compares seqs modulo 2³²
(`seq_ge`). At the end of every tick that applied records of a frame the worker reports
`applied{id, seq}`, so a frame that never draws (size 0) is still acknowledged, at most one ring
(1 638 records) behind.

**Wake-up (T03-004 revised).** The render worker sleeps when it has nothing to draw: it sets
`INPUT_IDLE` (0xC8, 1 at boot) and re-checks the ring, ticking again if records arrived. After each
publish the producer compare-exchanges `INPUT_IDLE` 1 → 0 and, if it was 1, posts one `input`
message: at most one message per idle period, never a lost record.

**The `created` gate and frame ids.** `EngineHost` numbers frames from 1 per worker and never
reuses a number (a restart is a new worker, numbered afresh). A frame's Camera and Resize calls are
held, the latest of each kind, until the worker reports `created` for it; then they are published
in the order of their calls, and later calls at once. The worker refuses a `create` whose id is not
above the highest it has seen (`console.error`, no `created`). On dispose the main thread drops
the frame's held and waiting records and ignores its later events; the worker drops its state and
ignores later records for it.

**Presentation capture (ADR-0019).** When the worker submits a frame's draw list it captures
`{seq, rseq, css, dpr, series}`: the last record applied, the last Resize applied, the CSS size,
DPR and the series drawn. `drawn` reports exactly that capture, also when the presentation
completes later (a deferred read-back) after newer records were applied; a presentation that is
re-run reports nothing. On the main thread `WasmFrame` reports `drawn` only for its latest
`resize()` call: never while a Resize is held or waiting, only when the event's `rseq` is that
call's seq, and with the caller's own width, height and DPR (the ring carries `f32`).

**The camera.** `WasmFrame` sends only the cameras it is given (`setCamera`); it has no
`setTimeWindow`. The camera controller decides them (below).

**Errors.** A record that is not a multiple of 8, shorter than its header, past the head or the
end of the ring, the wrong size for its kind or of an unknown kind ends the batch: the rest is
skipped (tail = head), `INPUT_BAD` (0x4D10) counts it and the first is logged
(`pulsus engine: input record at <counter>`). A Camera with a non-finite or empty view, a
non-finite or empty value range or a negative band is counted the same way and leaves the camera
unchanged; the frame still redraws, so its `drawn` carries the record's seq. So is an Overlay
with hover above 2, box above 1, a non-finite pointer x or y (hover 1) or a non-finite box end
(box 1), and a Select with a non-finite x or y: the state stays, no `hover` or `select` follows.
A record of a disposed frame is ignored and not counted.

### The camera controller (Part C2a2)

`RoutingFrame` wraps each engine frame (`WasmFrame`, an `EngineFrame`) in a `ControlledFrame`
(`client/src/engine/controlled.ts`), which runs #93's `FrameController` (`engine/controller/`,
[charts.md](charts.md#zoom-and-pan-the-2d-camera-93)) on the main thread, on the canvas element
that stays in the page after its transfer ([ADR-0030](../../designs/adr/0030-engine-camera-controller-on-main.md)).
The camera goes as `setCamera`: one Camera record with the view, the value view (null = auto) and
the held band (null = measured), coalesced in the ring like any other. Since Part C2b the
controller's camera and overlay changes are batched: a task writes at most one Camera and one
Overlay ([below](#hover-select-and-the-overlay-part-c2b)), so a Ctrl or ⌘ wheel that zooms both
axes writes one Camera.

| `ControlledFrame` call | Controller | `WasmFrame` |
|---|---|---|
| `setSpec` | `setSpec`, then `layoutChanged` | `setSpec` |
| `setData`, `setTheme` | `layoutChanged` | same call |
| `setTimeWindow` | `setTimeWindow`, `layoutChanged` when it returns true | — (the camera carries the view) |
| `resize` | `resize`, `layoutChanged` | `resize` |
| `setEvents`, `setSelection` | — | same call (kept, not drawn) |
| `dispose` | `dispose` | `dispose` |

**The stage.** The controller reads the geometry of the frame on screen (`Stage.model()`): the
plot, the value domain and the value-label band. For an engine frame that is the stage of the
worker's last **completed** presentation, as Canvas 2D uses its last drawn layer. The worker builds
it with the draw list (`dash-scene::build_stage`: `StageInfo { plot, domain, band_w }`), captures it
at submit with the rest of the presentation (`Presented.stage`) and, when the presentation
completes, sends it before its `drawn`:

```json
{"t":"stage","id":1,"rseq":4,"stage":{"plot":{"x":50,"y":8,"width":742,"height":206},"domain":{"min":0,"max":30},"labelW":38}}
```

It is sent only for a presentation of the frame's current Resize, and only when (rseq, stage)
differs from the last one sent, so the first completion after any applied Resize always reports
and a stale one never does. `"stage": null` withdraws it: a presentation with no plot (no camera,
no data, an empty plot). A retried, re-run, failed or never-completed submission sends nothing.

On the main thread every `resize()` call blocks the stage until a `stage` or `drawn` of that call
arrives (no Resize held or waiting, and the event's `rseq` the call's seq); blocked `stage` events
are ignored. A zero size withdraws the stage at once (the worker draws nothing then). `onStage`
fires on every change. Since Part C2b the stage also carries `pickCount` (the samples of series 0,
0 with no series shown): the keyboard crosshair's range.

**The lag.** While a new layout is submitted, retried or awaiting its read-back, input keeps acting
on the stage on screen; the held band keeps the plot fixed through a gesture, so the anchor stays
under the pointer (`e2e:engine-camera` E1–E6).

**Withdrawal.** With no stage the controller ignores every gesture: no `preventDefault`, no camera,
no commit. A stage that becomes null during a gesture aborts it (`abortGesture`): a wheel's idle
timer is cleared, a press releases its pointer capture, and the view, value view and band return to
the committed camera (the last external `setSpec` or `setTimeWindow`, or the last emitted commit);
no `commit` or `brush` follows. An engine restart mid-gesture creates a new `ControlledFrame`: the
gesture is dropped without a commit, as on dispose.

**Cost.** Per DOM event the main thread runs the controller's arithmetic; the ring writes are
batched to at most one Camera and one Overlay per task (T03-003). `bench:shim-input-cost` times
each dispatch with the frame's flush, so both writes are included.

### Hover, select and the overlay (Part C2b)

Hover stays in the render worker ([ADR-0030](../../designs/adr/0030-engine-camera-controller-on-main.md)
decision 2): the main thread sends where the pointer or the key crosshair is, and the box band,
as an Overlay record, and a click as a Select record. The worker picks on the f64 originals of the
presentation and draws the overlay (crosshair, hover dots, box band) itself.

**Batching (`ControlledFrame`).** The controller's stage calls only mark what changed and schedule
one flush per task (`queueMicrotask`; the `defer` option in tests):

| Stage call | `ControlledFrame` |
|---|---|
| `redraw()` | the camera is dirty |
| `hover()`, `boxChanged()` | the overlay is dirty |
| `clearHover()` | a shown hover becomes `hover: null` at once; the overlay is dirty |
| `select(p)` | `flush()`, then `select(p.x, p.y)` (a Select record) |

`flush()` writes the camera (when there is a view), then the overlay: the key index when the
keyboard crosshair is on, else the pointer when it is in the plot, else none, and the box band
while a moved right drag runs. Every forwarding call (`setSpec`, `setData`, `setTimeWindow`,
`setTheme`, `setEvents`, `setSelection`, `resize`) runs the controller, flushes, then calls the
engine frame, so a Camera always precedes the Resize or spec it belongs with. Nothing is written
after `dispose`. Every layout input clears the hover, so it also writes an Overlay of none.

**In the worker** (`dash-core::frames`, `dash-scene::hover`):

| Step | Behaviour |
|---|---|
| Overlay applied | stores the hover and the box band and its seq (`oseq`); the frame is dirty, its layer is not |
| Select applied | picks at once on the presentation on screen (the last completed one): one `select` event, none while nothing is on screen (no completion yet, a zero size, no plot) |
| build | the layer (`build_frame`: the draw list, summary, stage and the pick snapshot) is rebuilt only when a layer input changed (spec, data, events, theme, Resize, Camera); otherwise the cached list is reused. When an Overlay was applied since the last build, the hover is recomputed on the list's pick and one `hover` event goes out with its `oseq`. Then the overlay item is appended last, so the list drawn in a tick carries the hover that tick emits (T02-024) |
| submit, complete | the presentation captures the pick snapshot; when it completes it becomes what clicks pick on |

The hover rules are the Canvas 2D line rules, ported bit for bit ([charts](charts.md#interaction-int-033-ia-020-subset)):
the pointer snaps to the nearest sample of series 0 (ties to the earlier), and every shown series
whose nearest sample is within half its own mean step gives a row (NaN omitted); the keyboard
crosshair is a sample index of series 0 at the plot's top. The main thread takes its key range
from the stage it has, which can be an older presentation's (new data shortened series 0 before
its stage arrived), so the worker clamps a key index to the last sample of the pick it uses
(`key_on`: End still means the last sample) and gives no hover when there is no sample; a hover
never carries a non-finite time or position. A click picks the row nearest the
pointer's y at the snapped time. The hover drawn stays until the next Overlay (Canvas 2D's
`lastHover`).

**The overlay** (`MarkItem::Overlay`, `dash-marks::overlay`): `drawOverlay`'s shapes in its order:
the 1 px crosshair at `round(xCss)` over the plot's height (`text-muted`), a dot of radius
2 × `chart-line` for each row whose y is inside the plot (its series colour), and the box band
(`brush`). One instanced quad per shape in CSS px × DPR, drawn after every line and guide of the
frame in a pass of its own, unclipped, with the line pipeline's blend; a rect covers each pixel by
its box overlap per axis, a disc by `clamp(r·dpr + 0.5 − d, 0, 1)`. The same on T1 and T2.

**Events** (render → main, with `stage` and the others):

```json
{"t":"hover","id":1,"oseq":7,"ev":{"source":"pointer","tMs":1795090680000,"xCss":274.0,"yCss":108,"rows":[{"key":"00000000000000a1","name":"{}","colourIndex":1,"value":9}]}}
{"t":"select","id":1,"item":{"kind":"point","key":"00000000000000a1","tMs":1795090680000,"value":9}}
```

The tick posts the `select` events of the drained records first, then each frame's `hover` and
`a11y`, the completions' `stage` and `drawn`, and `applied`.

**On the main thread** (`WasmFrame`): an Overlay before `created` is held (the latest); a click
before `created` is dropped (no stage can exist). A `hover` is accepted only for the latest
Overlay: none while an Overlay is held or waiting in the ring, and only when its `oseq` extends to
the last published Overlay's seq, so a hover of an Overlay older than a layout change never shows
(`e2e:engine-hover` H5). `select` is forwarded as `{source: 'pointer', item}`, ungated: it answers
what was on screen. `ControlledFrame` forwards a `hover` unless null follows null. `RoutingFrame`
emits `hover: null` once when it unbinds a frame whose last hover was shown (a restart, a fallback,
the kind swap).

**Probe hooks** (`__dashProbe`): `hovers(n)`, `selects(n)`, `key(n, key)` (a `keydown` on the
probe canvas, which is its own key target with `tabindex=0`), `flush(n)`; `settle(n)` flushes
first. The probe build adds `freeze(n, seq)`, `frozen(n)` and `unfreeze(n)`
(`engine_probe_freeze`, `engine_probe_unfreeze`): after its first completed presentation with seq
≥ `seq` the worker builds and presents nothing for the frame, so a screenshot shows exactly that
presentation.

### Thresholds and event markers (Part C2c1)

Line frames draw their threshold lines
([ADR-0022](../../designs/adr/0022-chart-thresholds-and-stat-sparkline.md)) and event lines
([ADR-0023](../../designs/adr/0023-chart-event-markers.md)) as Canvas 2D does (T02-009);
their labels (chips, glyphs, truncation, `+N`, leaders) come with the engine's text mark in #69,
with the axis labels.

**Thresholds** come in the spec JSON (`LineSpec.thresholds`): the first 8 lines in spec order; a
`null` value (what `JSON.stringify` writes for NaN and ±∞) is not drawn, the label is ignored until
#69, and an unknown state is a spec error. The auto value domain is widened by every finite value
(`with_thresholds`, TS `withThresholds`; the summary's `min` and `max` stay the data's); a pinned
axis wins. Each finite value whose y is inside the plot (edges included) is drawn at row
`round(y)`, 1 px high, dashed as Canvas 2D strokes from `plot.x` with `chart-dash` 5 and
`chart-dash-gap` 4 at offset 0: dash k from `plot.x + 9k`, 5 px wide and cut at the plot's right
edge, in its state colour (`watch`, `degraded`, `failing`, T02-004).

**Events** go to the worker as one message per change, their times only:

```json
{"t":"events","id":1,"atMs":[1795091400000,NaN]}
```

`atMs` is a `Float64Array` of every `EventMarker.atMs` in call order (NaN kept by structured
clone); `WasmFrame` posts it for each `setEvents` array that differs by identity from the last one,
and the worker stores it (`frame_set_events`, `Frames::set_events`) as a layer input. The layout
reserves the event label band (`EVENT_BAND` = one label line + `space.1` = 18 px above the plot,
`event_band`) once the frame holds an event, in view or not. Each finite event in view (ends
included), in ascending time, is a 1 px `text-muted` line at column
`round(plot.x + (at − lo)/(hi − lo)·plot.width)` over the plot's height. A column at or past the
plot's right edge (an event at the window's end, or one rounding to it) is drawn in the plot's last
column on an auto axis, so every event in view keeps a line (ADR-0023); under a pinned axis it is cut
at the edge and dropped there, as Canvas 2D clips it. Lines are drawn after the thresholds.

**On the main thread** (`ControlledFrame.setEvents`): the same array does nothing; a band flip (no
events to some, or back) moves the plot, so it is a layout change as in Canvas 2D (the hover is
cleared, an Overlay of none is written); then the frame flushes and forwards the call. The stage
moves at the next completion, by C2a2's rule.

**In the worker**: `build_frame` appends one `Overlay` item of the threshold rects, then the
event rects, after the guides and the line, when there are any; the layer cache keeps it, so a
hover frame reuses it and the hover's Overlay item follows it. The renderer draws Overlay items in
list order after every line and guide, unclipped; both marks are inside the plot by construction,
with or without a manual axis. The summary reports `thresholdLabels: []` and `eventLabels: []`
until #69.

Canvas 2D clips event lines only under a manual axis (`clipped`), so under an auto axis an event
at the window's end is stroked one column right of the plot; the engine draws it in the plot's
last column instead (`layer_parity` expects that rect, and the pinned case dropped).

### The selection highlight (Part C2c2)

Line frames draw the page selection
([ADR-0025](../../designs/adr/0025-chart-frame-selection.md), T25-006, T02-025) on the next frame,
with the unmatched series dimmed together as one layer
([ADR-0032](../../designs/adr/0032-selection-dims-as-one-layer.md)).

**The message.** `WasmFrame.setSelection(sel)` posts the selection to the worker, unless it equals
the last one posted (`sameSelection`: the same keys in order and the same interval); the first call
always posts. `null` goes as no keys and no interval:

```json
{"t":"selection","id":1,"keys":["00000000000000a1"],"fromMs":1795090200000,"toMs":1795090800000}
```

The worker stores it (`frame_set_selection`, `Frames::set_selection`) as a layer input, so the
layer is rebuilt once and a hover frame reuses it. A key becomes a `u64` only when it is exactly 16
lower-case hex digits (`SelectionIn::new`); any other string, `00000000000000A1` included,
matches nothing, as TS compares strings exactly. `ControlledFrame.setSelection` only flushes and
forwards the call: no layout change, no hover change. A restart replays the kept selection with the
frame's other inputs.

**Relevance and the build.** `matched` (TS `matchedKeys`) flags each shown series whose key is in
the selection. No flag set means nothing is dimmed: the Line item has no `emphasis` and is drawn
exactly as without a selection. Otherwise the item carries `Emphasis { matched, dimmed:
opacity.dimmed, focus, underlay_extra_css: 4 }`. The interval draws a band whatever the keys:
`selection_band` (TS `drawSelectionBand`) is one `selection`-coloured rect from `x(fromMs)`, at
least 1 device px wide, cut to the plot, or nothing when it lies wholly outside. It is the first
shape of the layer `Overlay` item, before the thresholds and events (Canvas 2D's order: series,
band, thresholds, events).

**The passes** (`dash-marks/src/line/passes.rs`). The series are decimated once. A matched
series' instances carry its rank r (1…m, in shown order) as their lane, and every other series
lane 0. Each pass writes the view uniform (`lane_only`, `guides`, `use_colour`, `colour`, the
width) and is its own submission:

| Pass | Draws | Onto |
|---|---|---|
| A1 | the guides (`lane_only` none) | the frame, which it clears |
| A2 | lane 0, the unmatched series at their colours and full alpha | the dim layer, cleared to transparent |
| A3 | the dim layer, one full-target triangle (`dim.wgsl`) at `dimmed` | the frame |
| B_r | lane r, `focus`, the line width + 4 CSS px | the frame |
| C_r | lane r at its colour | the frame |

The order is Canvas 2D's: every unmatched series dimmed, then each matched series' underlay and
line in shown order (ADR-0025 decision 4), so a later series' underlay covers an earlier one's line
where they cross. In the vertex shader an instance of another lane is a degenerate quad (all six
corners at one clip point outside the view). With one instance batch the passes reuse the
decimated instances: on T1 the same indirect args (P4–P5 run once, with A1), on the CPU path the
same buffer. With more batches the passes are outer and the batches inner, so the decimation
repeats per pass. T1's status read-back is the decimation's, once, and `drawn` and `Rerun` are
unchanged. Without an emphasis there is one pass, `lane_only` every lane: the draw of C2c1, bit for
bit.

**The dim layer.** One `Rgba8Unorm` texture per renderer (one renderer per frame) at the target's
device size, created on the first draw with an emphasis, made again on a resize, released on the
first list without one and with the renderer (device loss, restart). A2 draws into it with a
premultiplied blend (colour `SrcAlpha, OneMinusSrcAlpha`, alpha `One, OneMinusSrcAlpha`); A3
composites it with `One, OneMinusSrcAlpha`, so a pixel of coverage a and colour c ends as
`dst·(1 − a·d) + c·a·d`. Overlapping capsules and crossing series build up inside the layer as at
full alpha, and are dimmed once (ADR-0032); a per-instance alpha would build up to an effective
0.6–0.8 on dense lines.

**Cost.** While m series are matched: 3 + 2m submissions and one target-sized texture per frame.
Nothing extra while no series is matched. Measured, report-only, in the implementation report of
#68 Part C2c2.

### Tiers and the frame loop

`engine_start` asks for a WebGPU adapter and device (T1, status 1; the decimation passes run as
compute) and, failing that or with `forceT2`, WebGL2 (T2, status 2; decimation on the CPU and the
rayon pool, no compute pipeline and no storage buffer). On T1 each frame has its own surface on its
transferred canvas; on T2 every frame draws on one shared GL canvas at its own size and the image
goes to the frame's `bitmaprenderer`. Surfaces are `round(css × dpr)` px, `Bgra8Unorm` or
`Rgba8Unorm`, `Fifo`.

The renderer runs with `Sync::Defer`: it never waits. A T1 line item whose total is not known yet
is drawn within the current capacity and its status header is read back with `map_async`;
`Renderer::poll` then reports `Complete` (the frame was whole), `Rerun` (under-sized: the next
render sizes the instance buffer for the total) or, after three failed read-backs in a row,
`Failed`. `drawn` (ADR-0019) is reported only for a complete presentation, from its capture, never
at 0, with a `chart-draw` measure (`detail: {kind: 'line', series, frame}`); see
[presentation capture](#the-input-ring-part-c2a1).

### Failures

| Condition | Behaviour |
|---|---|
| No WebGPU adapter or device | WebGL2; neither: status 4, every frame on Canvas 2D |
| `failed` (surface, read-back) | that frame falls back |
| Device lost (handled at once, also while the loop is idle: the worker wakes itself) | one new device on the same canvases; if it lands on another tier (WebGPU lost, only WebGL2 left), every engine frame moves to Canvas 2D with the notice (`failed{tier}`) and later frames use the new tier; a second loss within 60 s, or no device at all, is fatal |
| The render worker throws after a `drawn`, the first time on the page | one restart: new render and pool workers from the same `Module`; every engine frame moves to a fresh transferred canvas, replayed, with the notice |
| The engine does not boot (integrity refused twice, a compile error, status 3 or 4, or no status in 10 s) | every frame stays on Canvas 2D without a notice; the session flag is set (not for a build without the engine) |
| A throw before any `drawn`, a second throw, a restart without status 1 or 2 in 10 s, or `fatal` | the session flag is set (`sessionStorage` `pulsus-dash.engine-failed`, and in memory for the page); every engine frame falls back; later frames and pages use Canvas 2D |
| A data or spec error | the frame's data or spec is cleared; `console.error` once |

Without storage the flag lasts for the page only; a reload tries the engine again.

### Debugging

- `?engine=canvas2d` on any page draws it with Canvas 2D (labels included); `&mode=t2` forces
  WebGL2; `data-engine` on the canvas and the `<html>` attributes show what runs. On a build pinned
  with `VITE_ENGINE=canvas2d` (the e2e builds), `?engine=wasm` opts in.
- After a failed boot the tab stays on Canvas 2D: clear `sessionStorage`
  `pulsus-dash.engine-failed` (or open a new tab) to try the engine again.
- The console: `pulsus engine unavailable: <reason>` (e.g. `engine_integrity_failed`),
  `pulsus engine: frame <id> spec|data: <error>`.
- The fault build (`VITE_ENGINE_FAULTS=1`, e2e only) takes `&fault=`: `surface` (the first line
  frame fails its surface), `trap` (the render worker throws after its first `drawn`, once),
  `trap2` (after every `drawn`), `gap` (ten samples of the first frame's first series become NaN),
  `empty` (every series value NaN) and `noline` (no line drawn, axes unchanged). The faults live
  in `client/src/engine/faults.ts`; each of its three call sites logs its sentinel
  (`__pulsus_engine_fault__:route|boot|worker`), and `ci:probe-absent` fails a release build that
  holds any of them.
- The engine probe (`client/src/dev/engineProbe.ts`): a fault build opened with `?probe=1` (and
  `?engine=wasm`) on a page that loads the chart engine (any page with a chart; `e2e:shim-fuzz`
  uses the gallery) sets `window.__dashProbe`, which makes probe frames on canvases at (0, 0)
  (`frame`, numbered 0, 1, … in call order), drives them (`call(n, 'setSpec' | 'setData' |
  'setTimeWindow' | 'resize', arg)`), waits until a frame has nothing held or waiting and the
  worker applied and, at a non-zero size, presented its last record (`settle`), and reads the
  last summary, the `drawn` events, the idle word, the counters and the ring's statistics. In the
  probe build (below) `inputLog()` returns the records the worker decoded and `?ringStart=<u32>`
  starts the counters there. Probe frames are `ControlledFrame`s (Part C2a2): `wheel(n, x, y,
  init)` (returns `defaultPrevented`) and `pointer(n, type, x, y, o)` dispatch events on the
  frame's canvas at canvas px, built as `test/engineHarness.ts` builds them; `commits(n)` and
  `brushes(n)` return its events; `fresh(o)` makes a frame, resolves with its first summary and
  disposes it (the engine's own layout for given inputs); `id(n)` is its engine id and
  `stats().enqueued` counts the Camera records probe frames enqueued. In the probe build,
  `synth(n, {series, points})` makes F1c the frame's data in the worker, and resolves with
  `{ok, bytes, reason?}`; `chunk(n)` describes the frame's chunk
  ([measuring frames](#measuring-frames-part-c2d1)).

### Building

`make engine-wasm` builds the engine with the pinned nightly (`+atomics`, `build-std`), wasm-bindgen
(`--target web`, no default module path) and `wasm-opt -O3` into the git-ignored
`client/src/engine/wasm/gen/` (in the engine web image; `make build` runs it, and `make client-dev`
runs it before the dev server). The `dash-engine` plugin (`client/config/dashEngine.ts`) resolves
`virtual:dash-engine` to that glue. Every build and dev server includes the engine (ADR-0031):
without both `dash_core_mt.js` and `dash_core_mt_bg.wasm`, `vite build` fails at `buildStart` and
the dev server refuses to start, with `the chart engine is not built (src/engine/wasm/gen/ is
missing): run make engine-wasm first` (`gen-probe/` and `make engine-wasm-probe` in the probe
build), also with `VITE_ENGINE=canvas2d` or `VITEST` set; there is no opt-out (`ci:engine-built`).
Only the unit tests run without it: `client/vitest.config.ts`, which only Vitest reads, uses
`absentEngine` (`wasm/absent.ts`) in its place; `ci:bundle-size` still reports
`missing-artefact:engine` for a tree without the engine. The engine's files are
`assets/dash-engine-*` (the wasm, its workers and adapter chunks). `make engine-wasm-check`
(`ci:engine-gen`) builds twice and requires byte-equal output, a committed `dash_core_mt.d.ts`
equal to the generated one, and `layout.gen.ts` equal to `cargo xtask gen-layout --check`.

The probe build is for `e2e:shim-fuzz` and `e2e:engine-hover` H1b only: `make engine-wasm-probe`
(`cargo xtask build-wasm --probe`) builds the engine with the `probe` feature
(`engine_probe_input`, the decoded records as JSON, at most 20 000; `engine_probe_ring_start`;
`engine_probe_freeze` and `engine_probe_unfreeze`, Part C2b; `engine_probe_synth`, Part C2d1)
into the git-ignored
`client/src/engine/wasm/gen-probe/`, and `make e2e-build-probe` builds the client with
`VITE_ENGINE_FAULTS=1 VITE_ENGINE_PROBE=1` (Vite then resolves `virtual:dash-engine` to
`gen-probe/`) into `client/dist-probe` and its stub BFF into `build/e2e-probe/pulsus-dash`.
`ci:probe-absent` requires `engine_probe_input`, `engine_probe_synth` and `engine_probe_chunk` in that tree's wasm
(`--expect-probe`) and fails every other tree, the fault build included, that holds either. The
probe build is also the one `make engine-bench` serves ([measuring frames](#measuring-frames-part-c2d1)).

### Tests in the browser

`make engine-e2e` runs `client/playwright.engine.config.ts` against the fault build (pinned to
Canvas 2D, so its engine specs pass `engine=wasm`) and, for the default legs of `e2e:mode-matrix`,
the unflagged release BFF (port 4176), `vite preview` of an unflagged build with its computed
manifest (4177) and the dev server (5175), in two Chromium projects of the engine web image:

| Project | Tier | Gated |
|---|---|---|
| `lavapipe` | WebGL2 through ANGLE on the pinned Mesa (`&mode=t2`) | everything |
| `swiftshader` | WebGPU on Dawn's SwiftShader adapter (Dawn lists no lavapipe adapter) | report-only: it cannot render in the image (`onSubmittedWorkDone` and `mapAsync` reject), so `client/e2e/engine-legs.json` makes its failures soft and the run prints `WebGPU leg report-only: <reason>` |

- `golden:engine-line`: the browser engine's canvas (status 2, llvmpipe, `wasm-webgl2`) against
  the native `dash-golden render` of the same page, theme, CSS size and DPR: equal sizes
  (`round(css × dpr)`), mean ꟻLIP ≤ 0.001, no 8 × 8 tile above 0.05; a 1 % shifted window and the
  `gap` fault must fail. Since Part C2b also `line-50` dark hovered at the plot's centre and with a
  box band over 20–40 % of the plot, against `render --hover x,y` and `--box x0,x`. Since Part
  C2c1 also `line-thresholds` and `line-events`, dark and light (`render --page line-thresholds`
  draws the `layer.json` case).
- `canvas2d parity`: sampled geometric parity with Canvas 2D: the plot rects are equal, and on 32
  points of Canvas 2D's line mask the engine draws (≥ 28 within ±1 device px), with ≤ 8 of 32
  background points touched; `noline` must fail. Anti-aliasing differs between the two renderers
  by design, so pixel identity is checked against the native renderer only. Since Part C2c1
  `line-thresholds` and `line-events`: the plot is `layer.json`'s, both renderers have the
  threshold rows (at each dash's centre) and event columns within ±1 device px outside Canvas 2D's
  label boxes, and the line mask holds outside them.
- `e2e:mode-matrix` (plan #256): M1 the engine with no flag (both projects) and M2 a board's line
  panel on the engine with its stat on Canvas 2D, on the release BFF; M3 `?engine=canvas2d`, M5–M12
  each fallback condition (no OffscreenCanvas, `mode=static`, `st`, `mtr`, not isolated, no GPU
  API, no `Atomics.waitAsync`, a failed session) on Canvas 2D with no engine request; M4 the pinned
  fault build; the integrity leg, then a reload with no engine request; M13–M14 the engine and the
  integrity leg on `vite preview`; M15 the engine on the dev server.
- `e2e:engine-recovery` and the engine leg of `e2e:csp-violations`.
- `e2e:shim-fuzz` (project `probe`: lavapipe, the probe build's BFF on port 4175, this spec only):
  two probe frames with the gallery's `line-50` data take 10⁴ seeded ops (resize, time window,
  spec; batches of 1–2 000, the first before the frames are created, the rest after their first
  summary); the worker's decoded log must equal the adapter's produced log record for record, more
  than one ring's worth must have passed, records must have been coalesced, none dropped (from
  Part C2b: only Selects past the per-frame cap, each counted), and the
  last window and `drawn` must be the last calls'. Two more cases cross 2³²
  (`ringStart` 0xFFFF_F000) and wake an idle worker with one record (settled within 1 s).
  Since Part C2a2 a fifth of the 10⁴ ops are DOM events on either canvas (wheels with
  deltaX/Y ±600, modes 0–2 and Shift, Ctrl or Meta; pointer down, move, up and cancel with buttons
  0–2; double clicks); every gesture is ended (`pointercancel`, then the wheel-idle commit) before
  the final ops, and each frame's last summary must show its last published Camera's view.
  Since Part C2b the DOM events add hover moves, clicks and arrow keys, so Overlay and Select
  records are decoded and compared too; `INPUT_BAD` must stay 0, and every Select the ring took is
  published or counted in `INPUT_OVERFLOW` (the per-frame cap).
- `e2e:engine-camera` (`lavapipe` gated, `swiftshader` report-only; the fault build with
  `?probe=1`): #93's camera cases on probe frames, each step settled (< 250 ms inside a gesture,
  asserted, so no wheel-idle commit comes early). E1: 100 seeded wheel steps keep the plot and the
  anchor (< 0.01 px); E2: a sub-minimum preview survives a wider external window (Part A C3);
  E3–E6: non-fitting and wider labels during a Y zoom and after a refetch keep the plot until a
  layout transition releases the band, then the plot is a fresh frame's (Part A C4), with the
  leftmost ink column of the first preview, last preview and final frames at the plot's x (± 1
  device px); E7: axis drags and double clicks (INT-008); E8: a wheel and a drag on the gallery's
  `line-50` change the URL.
- `e2e:engine-hover` (Part C2b; as `e2e:engine-camera`): H1 a pointer hover reports the snapped
  sample, its x and rows, changes only the crosshair column (±4 px, ≥ 90 % of the plot's rows) and
  the dot (the series colour within 8 per channel), and leaving restores the image exactly; H1b
  (project `probe`) freezes the frame at each Overlay's presentation and checks each carries its
  own crosshair only; H2 the keyboard crosshair (ArrowRight, End, Escape); H3 a click selects the
  point under it, a NaN sample nothing; H4 a right drag draws only the box band; H5 a hover of an
  Overlay older than a layout change never shows; H6 the gallery tooltip of an engine `line-50`
  equals Canvas 2D's.
- `e2e:engine-layer` (Part C2c1; as `e2e:engine-camera`): L1 thresholds `[20 watch, 40 failing]`
  widen the auto domain to `layer.json`'s and the watch row has ink on every dash run and none in
  the gaps; pinned to 0..30 the 40 line is gone; L2 an event reserves the band (the fixture's
  plot, 18 px lower), clears a shown hover and draws a `text-muted` column over ≥ 90 % of the plot's
  rows, and no events restore the plot; L3 the event column follows five wheel zooms (±1 device
  px) and leaves the view; L4 under a pinned axis an event at each window end is drawn at the
  plot's left column and nothing is drawn right of the plot; L5 on an auto axis an event at the
  window's end and one 1 s before it are drawn in the plot's last column, nothing right of it.
- `e2e:engine-selection` (Part C2c2; as `e2e:engine-camera`, S11 in `probe`) on `S3` (a1 rising,
  a2 falling, a3 flat; 800×240): S1 a2 selected: a1 dimmed mid-segment and at a joint, a2 at its
  colour, `focus` beside it, the summary unchanged; S1b line-50's series on a pinned axis: 400
  seeded ink pixels obey the one-layer rule `bg + (L − bg)·0.35` (L the unmatched series alone,
  ±6), mean alpha 0.35 ± 0.02; S1c a dot and a dense span of an unmatched series are dimmed too,
  engine and Canvas 2D; S10 crossings of dimmed series obey the rule in both renderers (±10), DPR
  1 and 2, and at DPR 2 the matched series and the crosshair sit at the same device positions; S2
  a foreign key changes nothing; S3 the band; S4 the band follows wheel zooms; S5 a hover keeps
  its rows and full-colour dots; S6 clearing restores the image exactly; S9 a2's underlay over
  a1's line at their crossing; S7 against `dash-golden render --select-keys --select-interval`;
  S11 the probe's `renew()` drops every renderer (as the same-tier restore after a device loss
  does) and S1 holds again. The engine leg of `e2e:selection-sources` (`inspector.spec.ts`) runs
  here too, against the http-mode BFF (port 4174).
- `bench:shim-input-cost` (project `probe`, report-only): 10⁴ wheels and 10⁴ pointer moves on a
  probe frame, 16 per animation frame, each dispatch timed with the frame's flush; prints p50, p99 and max per dispatch and per frame's group
  next to the catalogue limits (p99 ≤ 0.05 ms, callback ≤ 2 ms) and asserts only that every
  prevented wheel enqueued a record. The trusted-input leg, three runs and the limits as assertions
  wait for the reference lab (T05 §7.1).
- `make engine-gpu-smoke` prints the adapter each project sees and whether it renders.

Real-GPU WebGPU runs on a hardware runner later (follow-up).

### Measuring frames (Part C2d1)

Both renderers time their frames with User Timing:
- **`chart-draw`** is a measure from the start to the end of one draw. Its `detail` is `{kind,
  series, frame}`, where `frame` is `FrameInit.id` (ADR-0019). The engine's start and end are the
  worker's times on the main thread's clock.
- **`chart-present`** is a mark made exactly where the frame emits `drawn`: the visible canvas is
  complete at the caller's size. Its `detail` is `{frame}`. The engine marks it when the `drawn`
  event reaches the main thread (`wasm/frame.ts`); Canvas 2D marks it after the visible draw
  (`Canvas2DEngine.ts`). Neither is made at a zero size or after `dispose`.

Both are cleared from the buffer at once, so only a `PerformanceObserver` sees them. Filter them
by `detail.frame`, since every frame on the page marks.

**The harness** (`client/e2e/bench/frameBench.ts`) has these parts:
- **`drive(page, canvas, frameId, steps, boxMs)`** runs a script in the page, one step per
  animation frame: a wheel at the plot's centre, a drag from it, or a hover at a fraction of the
  plot. The plot comes from `data-plot` on the canvas or its frame. After the script it waits two
  frames and 500 ms, then keeps collecting until the frame has presented twice
  (`collectUntil`, run in the page from its source). If `boxMs` passes first it stops and sets
  `timedOut`. It returns the frame's `chart-present` times, its `chart-draw` spans, the span, the
  steps dispatched and `timedOut`.
- **`open(page, url)`** loads a page without Playwright's fake clock, which hides User Timing
  entries, and waits for a frame's first `a11y`.
- **`SCRIPT`** is 40 zoom-ins, a 40-step pan of −20 px per step, and 40 zoom-outs. **`HOVER`** is
  120 hover steps across the plot and back.
- **`report(info, results)`** appends to `test-results/bench/<gate>.json` and annotates.

`summarise` (`client/scripts/lib/benchStats.ts`) turns a drive into a `BenchResult`. The interval
between marks inside the span is the frame time, and the measures are the draw time; each reports
p50, p95, p99 and max by nearest rank (NaN, `null` in the JSON, when empty). `coalescing` is
steps per presented frame. `budgets` marks PRF-001 and PRF-002 `ok`, `over` or `n/a`. The gates and the JSON fields are in
[build and CI](../development/build-and-ci.md#frame-benches).

**10⁸ points without `setData`.** A `setData` of 10⁸ points would be 1.6 GB on the main thread
and a structured clone. Instead, the probe build's `synth(n, {series, points})` posts
`probe-synth{id, series, points}`. The worker's `engine_probe_synth` then calls
`Frames::synth_f1c`, which works as follows:
- It builds `pulsus-synth`'s F1c grid: `f1a_value(s, k)`, key hash `s`, label `s`, a step of
  `10⁶ / points` ms from 0.
- Values, offsets, series metas and each series' label strings are reserved with
  `try_reserve_exact`. The one infallible allocation left is each series' small shared label slice
  (`Arc<[_]>`, which has no fallible constructor on stable Rust), made after the large buffers. More than 2³¹
  samples, `points` of 0 or above 10⁶, an unknown frame or a failed reservation return `false`
  before the frame changes.
- On success the frame's previous chunk goes, with the cached layer and pick that read it. The
  new chunk goes in through `Frames::set_chunk` (the Part D seam), with a local chunk id, and the
  frame is dirty.

The worker answers `{t: 'probe-synth', id, ok, bytes}`, where `bytes` is the values' bytes, 0 when
not `ok`. The probe resolves with `{ok, bytes, reason?}`. When not `ok`, `reason` is one of:
- `alloc`: the worker's answer;
- `fatal` or `restart`: the engine went first;
- `timeout`: no answer in 120 s, or the third argument's milliseconds.

`synthFault('alloc' | 'silent' | 'fatal')` simulates one of these outcomes for the next `synth`
only, for the bench's outcome test. `failed(n)` lists the frame's `onFail` reasons, and `trap()`
(the probe build, message `probe-trap`) makes the render worker throw for real. `chunk(n)` asks the worker (`engine_probe_chunk`) for
`{series, points, bytes}` of the frame's chunk (points are series 0's samples), or null.

`bench:frame-line-1e8` treats `alloc` at 10⁸ as a host without the memory. It records each case
`skipped: 'memory'`, reloads the page for a fresh worker, and runs the cases at 10⁷ (1 000 ×
10⁴) as `1e7-…`. A `fatal` fails the run. A timeout or a restart records the case `timedOut` and
goes on after a reload. The wasm memory's ceiling is 2 GiB, and 10⁸ f64 values are 800 MB. On
the lavapipe gate host a 10⁸ synthesis takes about 4 s and each presentation about 3 s.

## Limits

- 500 series per line while the interim cap holds; at most 65 535 lanes, so every matched series
  of a selection has its own lane (m ≤ 500).
- Columns are CSS px (≤ 65 535); a viewport past `max_instances` is batched, never truncated.
- A chunk holds at most 2³¹ samples (`ChunkError::TooLarge`); timestamps must be finite and
  strictly increasing per series (`ChunkError::Order`).
- Wire decoding: a frame payload of at most 64 MiB (`MAX_PAYLOAD`), a grid of at most 2²² points
  (`MAX_GRID_LEN`, a B3 limit: `PartError::Limit("grid len")`), the flatbuffer and IPC work bounds
  above, and the shared limits and budgets ([above](#limits-and-budgets)).
- DSF range data (Part D2): MT only; at most 2 decodes in flight per worker; 256 MiB of unheld
  decoded chunks; each result is held twice while shown (the engine's chunk and main's arrays).
- The native renderer blocks on the status read after P3; the browser (`Sync::Defer`) draws within
  the current capacity, reads the header back without waiting and re-runs an under-sized frame,
  never reporting it as drawn.
- The value band is at least the widest compact label (`min_value_band`, as Canvas 2D's
  `minValueBand`), so the engine's plot rect equals Canvas 2D's.
- In the browser: line frames only; zoom, pan, axis drags, hover, click select and the box band
  work, and so do threshold lines and event lines without their labels (#69), and the
  `setSelection` highlight (bars, heatmap and stat highlights come with #69's marks); WebGPU
  is verified only report-only in the engine image (SwiftShader); one restart per page.
- A hover frame redraws the whole GPU frame from the cached layer list (at most one per tick, as a
  pan frame); hover answers come one tick after the Overlay is published. A click picks on the
  presentation on screen, which may lag the newest layout by one completed presentation.
- The stage lags the newest layout by one completed presentation (as Canvas 2D's model lags its
  inputs); a frame with no stage takes no gestures.
- The input ring: 64 KiB; a Resize or Select is 40 bytes, a Camera or Overlay 64, so at most 1 638
  records are in flight; waiting state records keep only the latest per kind and frame, and at most
  8 Selects per frame wait (older ones are dropped and counted). CSS sizes travel as `f32`
  (exact for 1/64 px below 2¹⁸ px); `drawn` reports the caller's values.

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
| T05-004, T05-005 | pinned lavapipe, ꟻLIP | `golden:gallery`, `golden:engine-line`, `unit:compare-tile-max` |
| T01-001, T03-001, T03-003 | the adapter imports only the seam; no WASM on main | ESLint, `wasm/engine.test.ts` |
| T03-005 | control block layout v1, generated TS | `unit:control-block-layout`, `ci:engine-gen` |
| T03-004 (revised), T03-006, T03-019, T03-020 | the input ring: idle-word wake-up, SPSC release/acquire, read at frame start, state records coalesced, only Selects past the per-frame cap dropped (counted) | `unit:input-ring` (`ring`, `ring_decode`, `ring_rollover`, `ring_stress`, `wake_interleavings`, `ring_fixture`), `e2e:shim-fuzz` |
| ADR-0019 | `drawn` of the presented capture, for the latest resize | `presentation_capture`, `wasm frame`, `probe settle` |
| T02-024, INT-033, INT-034, INT-025, T25-005 | hover and the overlay in the tick of the Overlay; click select on the presentation on screen; the Canvas 2D rules ported bit for bit | `unit:hover-parity` (`hover_parity`, `overlay_item_shapes`), `overlay_order`, `frames_overlay`, `frames_select`, `stage_pick_count`, `controlled hover`, `controlled batch`, `wasm frame hover`, `e2e:engine-hover`, `golden:engine-overlay` |
| T02-009, ADR-0022, ADR-0023, T02-004 | threshold lines and event lines as Canvas 2D's strokes; the auto domain and the event band | `unit:layer-parity` (`layer_parity`, `build_layer_items`), `spec_thresholds`, `layout_event_band`, `frames_events`, `wasm frame events`, `controlled events`, `e2e:engine-layer`, `golden:engine-overlay`, `golden:engine-line`, `canvas2d parity` |
| T03-022, ADR-0026 | CSP, Trusted Types, COEP | `e2e:csp-violations`, `unit:CSP` |
| T03-024 | no test hook in a release build; the probe export only in the probe build | `ci:probe-absent` |
| T03-025 | fallback and recovery | `routing`, `restart policy`, `e2e:engine-recovery`, `e2e:mode-matrix` |
| ADR-0031 | the engine is the default; only `canvas2d` forces Canvas 2D; a failed boot marks the session; every build includes the engine; the preview's computed manifest, loopback only | `select.test.ts` (U1–U19), `markOnFailure`, `ci:engine-built`, `previewManifest`, `e2e:mode-matrix` (M1–M15), `e2e:canvas2d-pin` |
| T18-006 | integrity-checked engine wasm | `wasm/integrity.test.ts`, `e2e:mode-matrix` (integrity leg) |
| PRF-009 | the engine row | `ci:bundle-size` |
| VIZ-001 | the line drawn in the browser | `golden:engine-line`, `canvas2d parity` |
| T04-001, T04-002, T04-005, T04-012 (subset) | Arrow decode into `Chunk`; exact schemas; coverage rule | `unit:codec-roundtrip`, `unit:coverage-complete` |
| T04-009, T04-010 | DSF header, splitter and decoder bounds; the shared limits and budgets | `unit:dsf-header`, `unit:fb-reader`, `unit:dsf-bounds`, `unit:dsf-fuzz-smoke`, `unit:limits-json`, `unit:dsf-limits` |
| T04-015 (as amended, ADR-0034) | one decode copy, nothing pinned; the join of a grid part's batches, a single batch reused | `unit:arrow-alignment`, `unit:join-grid` |
| T03-003, T04-010, T04-012, T04-013, T04-017, ADR-0034 | DSF range data decoded on the pool, never on main or render; limits retried as JSON, invalid bodies `internal`; aborts and failures release a request's state; ids and epochs; the unheld-chunk LRU; references by identity | `decode_service`, `limit_fallback`, `invalid_body`, `chunk_ids`, `chunk_table`, `query range dsf`, `read over max_chunk`, `range from decoded`, `error from row`, `invalid planned`, `chunk refs`, `e2e:engine-dsf` (E1–E6), `bench:decode-r1` (report-only) |
| ADR-0014 §7 | no arrow-rs; `thiserror` and `bytemuck` only | `ci:spec-lint` (`dash-wire-deps`) |
