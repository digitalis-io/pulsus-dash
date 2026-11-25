# Chart engine (Rust, native core)

For developers. The chart engine is the Rust renderer that will draw chart frames behind the
`ChartFrame` seam ([ADR-0014](../../designs/adr/0014-typescript-react-web-client.md) §3), in place
of the interim Canvas 2D renderer ([Charts](charts.md)). It is built in four parts (issue #68):

| Part | Scope | State |
|---|---|---|
| A | The `engine/` workspace and the native core: tokens, units, colour, scales, value encoding, decimation, plot layout, scene, line mark, headless goldens and the parity fixtures | this page |
| B | Wire schemas and the Go DSF/Arrow writer (B1, [Arrow wire writer](../server/arrow.md)); the Rust DSF splitter, Arrow IPC reader and decoder into `Chunk` (B2, [below](#wire-decoding-dash-wire)); the shared wire limits (B3, [below](#limits-and-budgets)) | done |
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
| `dash-wire` | `Chunk`, `ChunkBuilder`, `ChunkId`; `SharedBytes`, the DSF `FrameSplitter`, its own Arrow IPC reader and `BodyDecoder` | data |
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
  `bench:decode-r1` will report the cost.

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

## Limits

- 500 series per line while the interim cap holds; at most 65 535 lanes.
- Columns are CSS px (≤ 65 535); a viewport past `max_instances` is batched, never truncated.
- A chunk holds at most 2³¹ samples (`ChunkError::TooLarge`); timestamps must be finite and
  strictly increasing per series (`ChunkError::Order`).
- Wire decoding: a frame payload of at most 64 MiB (`MAX_PAYLOAD`), a grid of at most 2²² points
  (`MAX_GRID_LEN`), the flatbuffer and IPC work bounds above, and the shared limits and budgets
  ([above](#limits-and-budgets)).
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
| T04-001, T04-002, T04-005, T04-012 (subset) | Arrow decode into `Chunk`; exact schemas; coverage rule | `unit:codec-roundtrip`, `unit:coverage-complete` |
| T04-009, T04-010 | DSF header, splitter and decoder bounds; the shared limits and budgets | `unit:dsf-header`, `unit:fb-reader`, `unit:dsf-bounds`, `unit:dsf-fuzz-smoke`, `unit:limits-json`, `unit:dsf-limits` |
| T04-015 (as amended) | one decode copy, nothing pinned | `unit:arrow-alignment` |
| ADR-0014 §7 | no arrow-rs; `thiserror` and `bytemuck` only | `ci:spec-lint` (`dash-wire-deps`) |
