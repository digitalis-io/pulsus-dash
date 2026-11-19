# Line chart

The M-UI0 line chart: up to 1 024 series and 10⁸ points held in the browser, drawn by the M1 line
mark with GPU decimation, panned and zoomed at frame rate. Open it with `?scene=line` on the runtime
page (the #23 rect scene stays the default). The data is synthetic (`pulsus-synth`), sent through
the real wire format (`metric_matrix.grid/1`), so the decode, upload and draw paths are the ones the
data plane (epic #2) will feed.

Implements [PRF-001, PRF-002, PRF-005 and PRF-016](../../designs/product/09-performance-contract.md)
(60 fps clauses; measured in CI, gated on the reference lab), the Line row of
[VIZ-004](../../designs/product/05-visualisation-catalogue.md) and the line clauses of VIZ-005 and
VIZ-006, [INT-002 and INT-003](../../designs/product/03-interaction-model.md), and the design rules
[T02-002, T02-014, T02-015, T02-016, T02-021, T02-022](../../designs/technical/T02-vis-engine.md),
[T04-002, T04-010, T04-015](../../designs/technical/T04-wire-format-and-data-plane.md),
[T05-007 and T05-010](../../designs/technical/T05-testing-and-performance.md), following
[ADR-0001](../../designs/adr/0001-rust-wasm-everywhere.md),
[ADR-0002](../../designs/adr/0002-no-js-ui-framework.md) and
[ADR-0007](../../designs/adr/README.md).

## Data path

```
data-0 (ST: render_start): pulsus-synth rows → GridEncoder::batch → Slab::copy_from [copy 1]
                           → GridDecoder::decode [zero-copy] → prepare → LineTable::publish_chunk
render, per frame:         drain input → LineScene; layer → LineLayout, LineMark;
                           ≤ 2²¹ samples: pin, rel_bits, build_pyramid, upload [copy 2], add_series;
                           camera step; frame; decimate if changed; axes; line; submit; coverage
```

| Stage | Crate | What happens |
|---|---|---|
| Generate | `pulsus-synth::line` | `series(seed, preset, id)`: a daily triangle wave plus a random walk, up to 3 gaps of 1 000–5 000 samples, rare spikes of 20× the amplitude, random NULLs (`null_ratio`), isolated samples (`isolate_every`). Seed 24. Only `+ − × ÷ abs` on `f64`, so wasm32 and native agree bit for bit; `tests/golden/line-stats.toml` pins the statistics of the three presets. |
| Encode | `dash-wire::grid` | One Arrow IPC stream message per batch of `series_per_batch(len)` = `clamp(1 MiB / (8·len), 1, 64)` series: `series_id` UInt32, `values` FixedSizeList(Float64 nullable, len), `dash.*` metadata (`dash.source = "synth"`). |
| Copy 1 | `dash-wire::slab` | `Slab::copy_from` copies the message into a 64-byte aligned allocation. |
| Check, decode | `dash-wire::grid` | `check_message` verifies the whole message (marker, metadata length, declared body length = the bytes present) before Arrow sees it; `GridDecoder::decode` then reads it with `FileDecoder` (`require_alignment`) into one `GridSeries` per row, whose values and validity are views into the slab. |
| Publish | `dash-core-mt::line_table` | One immutable `LineChunk` per series (values, validity, `Prepared {v_ref, min, max}`), in id order, in a lock-free table of 1 024 `ArcSwapOption` slots (T03-007). |
| Copy 2 | `dash-core-mt::line_render` | Per frame at most `max(1, 2²¹ / n)` series: `rel_bits` converts to `f32(v − v_ref)` bits (NULL for invalid or non-finite), `build_pyramid` builds the min/max pyramid, `LineMark::upload_series` writes both textures. |

The render worker never waits on data-0 and never takes a lock: it pins what is published.

## Precision

Samples sit at their true positions. Each series stores `f32(v − v_ref)` bits with
`v_ref = (min + max) / 2`; the camera keeps `t_left_rel_ms` relative to the layer start, in `f64`:

| Quantity | Computed as | Why it is exact enough |
|---|---|---|
| `x(k)` | `(f32(k − k0) + c0) · s`, `k0 = ⌊κ⌋`, `c0 = f32(k0 − κ)`, `s = f32(step / ms_per_px)`, κ = `t_left_rel / step` clamped to ±2²³ | `k − k0` < 2²⁴ is exact in `f32`; error < 10⁻³ px at the deepest zoom |
| `y(b)` | `(f32(b) + d_i) · a_y`, `d_i = f32(v_ref_i − v_bottom)`, `a_y = f32(1 / v_per_px)` | on-screen error ≤ 0.2 px |
| column | `col(k) = ⌊x(k)⌋` | the CPU, T1 and T2 compute the same two IEEE operations (add, then multiply) |

At the deepest zoom (`ms_per_px = step / 16`) adjacent 1 ms samples are 16 device px apart
(PRF-016).

## Decimation (T02-015)

The plot's device-pixel columns `c ∈ [−4, plot_w + 4)` plus two edge slots form the **slots**:
slot 0 holds the last sample left of the columns (`k_l`), the last slot the first sample right of
them (`k_r`). `Columns::new` finds each column's first sample with the same `col` the GPU uses.

Per (series, slot) the decimation pass writes a 32-byte **record**: up to three null-separated runs
`[min, max]`, then the slot's last sample and the next sample (the connector). A slot with more than
three runs stores the overall `[min, max]` and `OVERFLOW_BITS`; the draw then recomputes its runs
from the raw values. The pass walks a 16-ary min/max pyramid (levels with `16^ℓ < n`, at most 4):
it climbs to the largest block that fits the slot and is not mixed NULL/non-NULL, descends into
mixed blocks, and compares values only as integers (an order key of the `f32` bits). The CPU
function `dash_scales::lod::decimate_series` is the specification; T1 (compute) and T2
(render-to-texture) produce bit-identical records (`golden:decimation-ref`).

| | T1 (WebGPU) | T2 (WebGL2) |
|---|---|---|
| Pass | compute, `@workgroup_size(64)`, dispatch `(⌈tile_w/64⌉, S, tiles)` | one render pass per tile layer, full-screen triangle |
| Output | two `Rgba32Uint` storage textures | two `Rgba32Uint` targets (32 B per sample, the WebGL2 limit) |
| Device limits | `downlevel_defaults` (compute, 4 storage textures) | `downlevel_webgl2_defaults` |

The pass runs only when the frame changed (camera, canvas or an upload).

**Textures.** Values (`R32Uint`) and the pyramid (`Rgba32Uint`) are 2D arrays `tex_w × tex_w ×
layers`, `tex_w = min(4096, max_texture_dimension_2d)`; a single layer is only as tall as its data.
Records are `tile_w × S × tiles`, `tile_w = min(slots, max_dim)`: a plot wider than the device's
texture limit tiles across layers, and every column is still drawn. On T2 every array texture has
at least two layers (GL makes a one-layer texture a plain 2D texture). If the series do not fit
(`S > max_dim`, or more value layers than `max_texture_array_layers`), only the first
`LayoutError::TooLarge { max_series }` series are drawn and the page says so.

## Drawing: column coverage

One draw (`draw(0..12·slots·S)`, scissored to the plot) draws two quads per record: the runs of the
slot's column (part 0) and the connector to the next sample (part 1). The quads are pulled by vertex
index (quad `v / 6`, corner `[0, 1, 2, 2, 1, 3][v % 6]`) rather than instanced: software
rasterisers (SwiftShader in CI, lavapipe in the golden gate) pay a fixed cost per instance, which
made the instanced form about 8× slower there. Positions are snapped to the 1/64 px grid of line
coverage before the coverage is computed.
A fragment's coverage is `clamp(h + 0.5 − √(dx² + dy²), 0, 1)` with `h` = half the line width,
`dx` = the column distance and `dy` the vertical distance from the row centre to the run extents
(part 0) or to the connector's y-range inside the column (part 1). Colour and alpha blend with
`{One, One, Max}`, so overlapping series and parts give the coverage of their union. NULLs break
runs and connectors (gaps); non-finite values are gaps too.

**Line coverage (VIZ-006).** A pixel is covered iff the raw polyline (segments between consecutive
valid samples, and isolated valid samples), at positions quantised to 1/64 px, touches its square.
`dash_scales::raster::raw_mask` computes it exactly with integers from the raw samples, independent
of the records; the GPU mask pass (`LineMark::draw_mask`, 64-bit products emulated in `u32` pairs)
must equal it pixel for pixel, with no missing or extra pixel. The draw uses the same 1/64 px
positions, so every covered pixel is lit. Anti-aliasing is outside this definition (a dropped
sample can change the shade of a neighbouring pixel), which is why the golden test compares
coverage masks, plus the visual image against a reference that draws every raw segment.

## Coverage line (T02-016, VIZ-005)

Decimation is visually lossless, so it is not a reduction. When fewer series are drawn than
requested, the render worker posts `{t: "coverage", reasons}` and `boot.js` sets
`<html data-dash-coverage>`; `web/index.html` shows one line per reason under the tier badge
(`role="status"`):

| Reason | When | Text |
|---|---|---|
| `loading` | fewer series drawn than held (and capped), and no load failure | Loading data: not every series is drawn yet |
| `st-ceiling` | ST mode holds fewer series than requested (10⁷ points) | Not every series is shown: single-thread mode limit |
| `texture-ceiling` | the GPU textures cap the series | Not every series is shown: GPU texture limit |
| `load-failed` | a wire error stopped the load | Some series failed to load |

`""` (every series drawn) hides the line. The full coverage meter (VIZ-027) comes with the shell.

## Camera (T02-021, T02-022)

| Input | Effect |
|---|---|
| Wheel | zoom by `2^(px/400)` about the point under the pointer (`px` = `deltaY`, else `deltaX`, × 1 / 16 / plot height by `deltaMode`); no modifier: time only; Shift: values only; Ctrl or Meta: both |
| Drag (button 0, starting in the plot) | pan; the data follows the pointer (device px) |
| Release faster than 0.3 CSS px/ms (over the last 50 ms) | flick: critically damped inertia, `D(τ) = v₀(2 − (2 + ωτ)e^(−ωτ))/ω`, ω = 0.0194/ms; ends when `(1 + ωτ)e^(−ωτ) < 0.02` (≈ 300 ms), no overshoot |
| Any input record | stops inertia first |

The window always overlaps the data on both axes: pans and inertia clamp it, and inertia that
reaches a bound stops there. Over empty space the zoom anchor is the nearest data end. Scales are
limited to `[step/16, 4·n·step/plot_w]` ms/px and `[r·10⁻³, r·100]/plot_h` per px (`r` = the value
range). Until the user moves the camera, it fits the data (time over the plot width, values ± 5 %)
whenever a series arrives or the canvas changes.

Gridlines, axis lines and 4 CSS px ticks come from `dash_axes::minimal::segments` (1-2-5 value
ticks, a time ladder from 1 ms to weeks) and are drawn by `SegmentMark` as anti-aliased capsules.
Labels wait for M8 text.

## Memory

| At 1 000 × 100 000 | Size |
|---|---|
| WASM: slabs (values + validity, Arrow) | ≈ 0.8 GB |
| GPU: values (`R32Uint`, 6 layers of 4 096²) | 0.4 GB |
| GPU: pyramid (`Rgba32Uint`) | 0.1 GB |
| GPU: records (`Rgba32Uint` × 2, `R32Uint`), per 1 290 slots | ≈ 46 MB |

## Flags

| Flag | Effect |
|---|---|
| `?scene=line` | the line chart: 1 000 series × 100 000 points |
| `&series=N&points=M` | `N ∈ [1, 1024]`, `M ∈ [2, 10⁶]`, `N·M ≤ 10⁸`; anything else gives the defaults |
| `&mode=t2` | WebGL2 (T2 decimation) |
| `&fault=line-layers-1` | probe builds: one texture layer (forces the texture ceiling) |
| `&fault=line-wire` | probe builds: truncates the second wire message (forces a load failure) |

ST mode holds at most 10⁷ points (`series ≤ 10⁷ / points`), loaded by the render worker before the
GPU starts; Full mode loads every series on data-0.

## Tests and gates

| Gate | What |
|---|---|
| `test` | `pulsus-synth` presets and statistics; the codec, slab and hostile messages; decimation properties (runs equal a naive scan, extremes kept, identical over thread counts, spike kept, 1 ms adjacency); line coverage cases; ticks and axes; camera (anchor, clamps, inertia, bounds); line scene uniforms, fit and coverage; WGSL validation and GLSL ES 300 output; layout sizes; tier limits; the chunk table and loader |
| `golden` (`golden:decimation-ref`, blocking) | lavapipe (Mesa pinned in `ci/tools.toml`): GPU records equal `decimate_series` on T1 and T2; the mask pass equals `raw_mask` with zero missing and extra pixels for `line-1e8` and `line-gappy` at five views and DPR 1 and 2, per series and merged; the decimated image equals the reference image (every raw segment) on T1 and T2; tiling; T2 limits; NULL gaps; spikes; 1 ms adjacency; same seed, same pixels |
| `e2e` | the line page on T1, T2 (including a 3 000 CSS px wide canvas), ST, the texture ceiling, a load failure, wheel anchoring, flick and interrupt, the hostile messages inside the wasm32 core, and the `bench:frame-line-1e8` run |

**`bench:frame-line-1e8`.** The `@webgpu line_1e8_pan_zoom` test loads 10⁸ points, warms up 5 s,
then loops for `DASH_BENCH_MS` (20 s) over: drag −400 px in 20 steps over 500 ms; 10 wheel steps
in; a 300 px flick; 10 wheel steps out. It writes `traces/frame-line-1e8.json`
(`{scene, series, points, tier, decimation, warmupMs, loopMs, loadMs, intervalsMs[]}`) and the
Chrome trace `traces/long-tasks-line-1e8.json`. In CI the frame times are **reported** (p50, p95,
p99, the machine-B verdict); a missing report or fewer than 10 intervals fails; the trace is a
blocking PRF-005 check like the other projects. `DASH_BENCH_PROFILE=lab` (30 s warm-up, 3 × 60 s)
is the reference-lab run, judged by `dash_lab::frames::judge_frames` (median ≤ 16.7 ms on machines
A, B and C; p99 ≤ 22.2 ms on B) and `judge_long_tasks` (no main-thread task over 16 ms); it blocks
merges once the lab exists.

## Limits

- One layer, synthetic data, ≤ 1 024 series, ≤ 10⁶ points per series, ≤ 10⁸ points.
- An overflow slot (more than three runs) recomputes its runs per fragment: exact, but slow for
  dense random NULLs.
- Every frame draws `2·slots·S` quads (≈ 2.6 M at 1 280 CSS px and 1 000 series); empty ones are
  degenerate. On SwiftShader (CI) a 10⁸-point frame takes about 2 s; frame rates are measured on
  the reference lab.
- A GPU out-of-memory error while creating the textures shows Failed; device-loss recovery is
  M-UI1.
- Gridlines use the axis colour; colours are provisional tokens (`dash-tokens::spike`) until the
  token set (epic #3); the light-theme blend is revisited with M-UI5.
- No labels, legends, tooltips or picking yet.

## Design mapping

| Code | Design |
|---|---|
| `crates/pulsus-synth` (`rng`, `line`) | T05 §4.5, T05-010 |
| `crates/dash-wire` (`grid`, `slab`) | T04 §4.3, T04-002, T04-010, T04-015 |
| `crates/dash-scales::lod` | T02 §4.4, T02-014, T02-015 |
| `crates/dash-scales::raster` | VIZ-006 line coverage, T05 §4.2 |
| `crates/dash-scales::ticks`, `crates/dash-axes::minimal` | minimal axes (M-UI0) |
| `crates/dash-scene::camera` | T02-021, T02-022, INT-002, INT-003 |
| `crates/dash-scene::line` | T02-016, VIZ-005 (coverage), T02-014 |
| `crates/dash-marks::line`, `segment`, `line_*.wgsl` | T02 §4.2 M1, T02-002, T02-015 |
| `crates/dash-gpu::tier::required_limits` | PRF-044 tiers |
| `crates/dash-core-mt` (`flags`, `line_table`, `line_load`, `line_render`) | T03-007, T03 §9.2, T04 §5.7 |
| `crates/dash-golden` | T05 §4.2, T05-004, `golden:decimation-ref` |
| `crates/dash-lab::frames`, `xtask e2e` (`check_bench`) | T05-007, PRF-001, PRF-002, PRF-005, `bench:frame-line-1e8` |
