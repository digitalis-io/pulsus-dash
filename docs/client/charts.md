# Charts

Every chart in the client is one `<ChartFrame>` on one `<canvas>`, drawn by a chart engine behind the
seam of [ADR-0014](../../designs/adr/0014-typescript-react-web-client.md) §3. Until the Rust/WASM
engine lands (#68), the engine is the in-house **interim Canvas 2D renderer** in
`client/src/engine/canvas2d/` (ADR-0014 §4; no charting library, VIZ-001, T01-002). It draws four
kinds: line, stacked bars, heatmap and stat. This page covers the seam, the frame data and its
validation, number formatting, colours, axes, interactions, accessibility, limits and the chart
gallery.

## The seam

`src/engine/api.ts` holds the types the application uses; nothing else in the engine is imported by
application code.

| Type | Meaning |
|---|---|
| `VisSpec` | `line`, `bars` (`stacking: 'normal'`, `categoryLabel`, `categoryOrder`), `heatmap` (`unit`, `countUnit`) or `stat`; each has a `title` and a `unit`. Data, never code |
| `FrameData` | `series` (`SeriesFrame[]`), `heatmap` (`HeatmapFrame`) or `scalar` (`ScalarFrame`), from `src/data/frames.ts` |
| `ChartEngine.createFrame(canvas, { timeZone, keyTarget })` | One frame per canvas. `keyTarget` is the element whose key presses move the crosshair (the slider); `null` for stat |
| `ChartFrame` | `setSpec`, `setData`, `setTimeWindow`, `setTheme`, `resize(cssW, cssH, dpr)`, `on(event, cb)` → unsubscribe, `dispose()` |
| Events | `a11y` (`FrameSummary`: kind, series shown and total, window, min, max, last, plot rectangle), `hover` (`HoverEvent` or `null`), `brush` (`{ fromMs, toMs, gesture: 'drag' \| 'zoomOut' }`), `select` (reserved; never emitted by the interim engine) |

`src/engine/index.ts` exports `defaultChartEngine()` (one `Canvas2DEngine` per page) and
`ChartEngineContext` (React context, default `defaultChartEngine()`). Tests provide a fake engine
through the context (`src/test/fakeEngine.ts`).

### Who owns what

| Concern | Owner |
|---|---|
| Context window and URL | The application. `ChartFrame` turns a `brush` event into a `setRange` (drag; absolute times, pushed) or `zoom out` (double-click) action of `useTimeContext().dispatch`. The engine only proposes windows |
| Validation, notices, tooltip, summary label, crosshair slider | `ChartFrame` (`src/charts/`) |
| Scales, ticks, marks, picking, brush gesture, layer cache | The engine frame; discarded on `dispose()` |

### Frame lifecycle

`ChartFrame` creates the canvas in its mount effect (not in JSX), so a later
`transferControlToOffscreen()` (#68) survives StrictMode's mount, unmount and mount. The effect
re-runs only when the engine, the time zone or "is stat" changes. It pushes the current spec, data,
window and theme, observes the host with `ResizeObserver` (→ `resize` with `devicePixelRatio`), and
watches `matchMedia('(resolution: <dpr>dppx)')` for DPR changes. Cleanup unsubscribes, disconnects,
calls `dispose()` and removes the canvas. Later prop changes call `setSpec`, `setData`,
`setTimeWindow` and `setTheme`; the theme comes from `html[data-theme]` through
`useResolvedTheme()`.

Inside the engine, every input stores its value, clears the hover and schedules one animation
frame. The frame redraws the layer canvas only when an input changed, records
`performance.measure('chart-draw', { detail: { kind, series } })` (then clears it), emits `a11y` when
the summary changed, and blits the layer under the overlay (crosshair, hover dots, brush band). At
most one `hover` is emitted per frame. Every draw starts with `setTransform(dpr, 0, 0, dpr, 0, 0)`,
and the backing store is `round(css × dpr)`.

### Adding a chart

Render `<ChartFrame spec={…} data={…} />` inside the shell (it needs the time Context and the time
zone). Give the spec a title (it names the crosshair slider and starts the summary label) and a
unit. The frame takes the full width of its container; line, bars and heatmap are
`--size-chart` (240 px) high and stat `--size-chart-stat` (120 px). With `fill` (board panels and
their full-screen view) the frame has class `fill` (`height: 100%`) instead, and takes the height of
its container, which must have a definite height; the canvas follows through the `ResizeObserver`.

## Frame data and validation

`src/data/frames.ts`:

- **`SeriesFrame`**: `key` (the BFF's `key_hash`, 16 lower-case hex digits), `labels`, `timestamps`
  (ms, strictly increasing) and `values` (`Float64Array`, same length; `NaN` is a gap).
- **`HeatmapFrame`**: `timestamps` (column starts), `bounds` (bucket upper bounds, increasing; the
  last may be `+Inf`), `counts` (row-major by time, `counts[t·B + b]`).
- **`ScalarFrame`**: `value`, `timestampMs`.

`line` and `bars` need series, `heatmap` a heatmap, `stat` a scalar or series (the last finite value
of the first series). `validateFrameData(spec, data)` returns the first problem, in this order; the
component then sends `emptyFrameData(spec)` to the engine and shows "This chart cannot show its
data: <reason>".

| Code | Reason shown |
|---|---|
| `kind` | the data does not match the chart type |
| `key` | series key `<key>` is not a 16-digit hex hash |
| `length` | series `<key>` has `<n>` timestamps and `<m>` values |
| `order` | series `<key>` timestamps are not increasing (heatmap columns report the key `heatmap`) |
| `cells` | expected `<T>` × `<B>` heatmap cells, got `<n>` |
| `bounds` | heatmap bucket bounds are not increasing (or a bound other than the last is not finite) |
| `finite` | heatmap needs at least one finite bucket bound (e.g. `[+Inf]`) |
| `grid` | category `<key>` does not share the bar time buckets |

`seriesName(labels)` prints `name{k="v", …}`: `__name__` first, the other keys sorted, `{}` when
there are no other labels.

## Numbers (VL-012, T08-027)

`formatValue(v, unit)` in `src/i18n/format.ts` formats every number the charts show, with three
significant digits (from 100 the rounded integer) and trailing zeros dropped.

| Unit | Examples |
|---|---|
| `none` | `0`, `0.0123`, `1.2k`, `-1.2k`, `1P` (SI prefixes k, M, G, T, P from 1 000; none below 1) |
| `suffix` | `1.2k rps` |
| `time` (`base` ns, us, ms or s) | `150 ns`, `120 ms`, `2.84 s`, `1 min`; the largest of ns, µs, ms, s, min, h, d whose value is at least 1; `0` → `0 s` |
| `bytes` | `512 B`, `1023 B`, `1 KiB`, `1.5 GiB` (IEC, ×1 024) |
| `percent` / `percentunit` | `38 %` from 38 / from 0.38 |

A value that rounds up to the next unit is carried (`999.6 ms` → `1 s`, `59.99 s` → `1 min`,
`1048575 B` → `1 MiB`). `NaN` is `—`, infinities `+Inf` and `-Inf`. `formatHourMinute` and
`formatDayMonth` are the axis label formats (`14:05`, `19 Nov`).

## Colours (VL-002, VL-006, T01-010, T02-004, T02-005)

All chart colours come from `src/styles/tokens.ts`, generated from `design/tokens.toml`:
`seriesPalette` (the eight `series-N` colours per theme, in order) and `sequentialRamp` (the nine
`ramp-N` colours per theme, one hue, lightness stepped evenly), plus `surface-1` (background),
`hairline` (grid), `text-muted` (axis text and crosshair), `text` (stat value) and `brush` (the brush
band). State colours are never used for series (VL-003).

A series' colour depends only on its own labels and key, never on the chart, the order or the other
series:

1. If it has a `level` label (else a `detected_level` label) whose lower-cased value is in
   [08](../../designs/product/08-visual-language.md#vl-002--neutral-series-palette-with-stable-identity-colours)
   Table 8-1a, it takes that colour: `error`, `err`, `critical`, `crit`, `fatal`, `alert`,
   `emergency` → `series-6`; `warn`, `warning` → `series-2`; `info`, `informational`, `notice` →
   `series-1`; `debug` → `series-5`; `trace` → `series-4`.
2. Otherwise `series-{1 + (key_hash mod 8)}`, the low three bits of the key's last hex digit.

Heatmap cells use `ramp[min(8, floor(9 · count / max))]`; zero counts are not filled.

## Axes

- **Layout.** The plot starts after the widest value label, 8 px and the 4 px tick; 8 px from the
  top and right; the time axis takes 4 px of tick, 2 × 4 px of padding and one 14 px label line at
  the bottom. Stat has no axes.
- **Value axis** (line, bars). The domain includes 0 and the data (bars: the stacked totals). Steps
  are 1, 2 or 5 × 10^k in units of 1 000^p (1 024^p for bytes), widened until labels are at least
  label height + 2 px apart. Grid lines are hairlines.
- **Time axis.** Steps from 1 s to 12 h and 1, 2, 7 and 14 days; the smallest step whose labels fit
  is used. Sub-day candidates are generated on the local wall clock in the browser zone and converted
  with `'compatible'` disambiguation; a candidate that does not move forward in time (the repeated
  hour when clocks go back) is dropped, and the missing hour when clocks go forward is simply absent.
  Labels: `HH:MM:SS` under a minute, `HH:MM`, and the date (`19 Nov`) at local midnight. Labels that
  would leave the plot or come closer than 8 px to the previous one are dropped. If the chosen step
  leaves no label inside a very short window, smaller steps are tried.
- **Heatmap bucket axis.** Each bucket spans its numeric interval: a log scale when there are at
  least two finite bounds, the first is positive and they cover at least three decades; otherwise
  linear. The first bucket spans from one bucket ratio (log) or from 0 (linear) below the first bound;
  if the first bound is 0 or negative, it starts one bucket width below it (`[0, 5, +Inf]` → `(-5, 0]`);
  a single bound of 0 is shown as `(-1, 0]`. A final `+Inf` bucket gets its own band at the top,
  labelled `+Inf`, with a 2 px gap below it. Log ticks are the powers of ten (plus 2 and 5 × 10^k when
  they fit).

## Marks

- **Line.** The first 500 series in input order. Each series is reduced to one column per CSS px
  (ADR-0014 §4): the polyline has one vertex per column (at its last value), and a column with several
  samples also gets a 1-px span from min to max for each NaN-free run, so every raw extreme is
  visible and no span crosses a gap. A NaN breaks the path (even inside a column); columns with no
  sample are joined over. A lone sample between gaps is a dot. Line width 1.5 px, round joins.
- **Stacked bars.** Categories (`labels[categoryLabel]`) stack in `categoryOrder`, then the unlisted
  ones by name; the first 500 are drawn. Bucket *i* spans from its start to the next bucket's start
  (the last one by the previous step); bars are 1 px narrower than their span. When there are more
  buckets than CSS px, buckets are merged per pixel column and their values summed; a bucket whose
  interval (its start to the next start; the last one by the previous step) overlaps the window is
  kept and clipped to it, and buckets wholly outside the window are dropped, never merged into the
  edge columns.
- **Heatmap.** Cells per column and bucket, merged per pixel column like bars, except that a
  merged cell is missing (no fill) when any merged bucket's count is missing (NaN); hover and the
  a11y summary read the raw buckets. A NaN cell is never filled and has no hover row (#63,
  [T02 §4.4](../../designs/technical/T02-vis-engine.md#44-lod-decimation-and-precision) gaps rule).
- **Stat.** The formatted value, centred, in 32 px semibold.

## Interaction (INT-033, IA-020 subset)

| Input | Effect |
|---|---|
| Pointer over the plot | Line: the crosshair snaps to the nearest sample of the first series; every series whose nearest sample is within half its own step is listed. Bars and heatmap: the bucket under the pointer. Heatmap pointer: the bucket row under the pointer (`≤ 0.5 s`, or `> 10 s` for the `+Inf` band) |
| Drag (primary button) across at least 4 px | A brush band; on release the window is the dragged range, both ends snapped to the nearest multiple of the brush unit, the smallest of 1 s, 5 s, 10 s, 15 s, 30 s, 1 min, 5 min, 15 min, 30 min, 1 h and 1 d that is at least 4 px of time. The new absolute window is pushed to the URL. Escape (on the slider) or a cancelled pointer drops the band |
| Double-click on the plot | Zoom out: twice the window, around the centre (as `-`) |
| Focus the crosshair slider, then `→` / `Home` or `←` / `End` | The crosshair starts at the first or last sample (bucket). Then `←` `→` move by one, `PageUp` / `PageDown` by ten, `Home` / `End` to the ends; `Escape` or leaving the slider hides it. Ctrl, Meta and Alt combinations are left to the browser |
| `↑` / `↓` on the slider | Selects the previous or next row of the tooltip; the slider's value text reads it |

The tooltip is DOM, beside the crosshair (flipped left at the frame's right edge), positioned with
CSSOM (`style.translate`, allowed by the CSP, T18-004). It shows the time and the rows sorted by value
(descending, then name), 20 at a time with "Rows a–b of n". With the pointer, the 20-row window
follows the pointer's height over the plot: the top of the plot shows rows 1–20, the bottom the last
20, so every series can be reached. With the keyboard, the window is centred on the selected row.

## Accessibility (T01-007)

- The canvas is `role="img"` with the summary label
  `<title>: <kind>, <n> series, <range>. Min <min>, max <max>, last <last>.` (heatmap: `<n> buckets`,
  values in the count unit). Line: min and max over every shown value, last = the highest last value.
  Bars: over the stacked totals, last = the last bucket's total. Heatmap: over all cell counts, last =
  the last column's total. Stat: the value.
- Line, bars and heatmap have a focusable `role="slider"` "Crosshair: <title>" over the plot
  (`aria-valuemin`/`max` = the window, `aria-valuenow` = the crosshair time, `aria-valuetext` =
  `<time>: <name> <value>, <i> of <n>` or "Use the arrow keys to read values"). Pointer input passes
  through it to the canvas.
- When more than 500 series arrive, a status notice says "Showing 500 of <n> series".
- A browser without a 2D canvas context shows "This browser cannot draw charts." instead.

## Limits

- At most 500 series per frame (the rest are dropped with the notice), at most one polyline point
  per CSS px per series (ADR-0014 §4, with the §4 note on extremes), one value axis and one time axis.
- Drawing is on the main thread (T01-003 interim exception) with a cached layer; there is no worker,
  GPU decimation or level of detail until #68.
- No legend, cursor sync, click to select, Inspector, Δ vs baseline or keyboard brushing yet.

## The chart gallery

`/t/:tenant/dev/gallery` (development and stub builds only: the route is in the router only when
`import.meta.env.DEV` or `VITE_API_MODE` is not `http`, so `http` builds contain neither the route
nor its chunk; CI checks the `http` build's manifest). There is no navigation entry. The page draws
seven charts from seeded synthetic data for the current window (`src/dev/synth.ts`,
`src/dev/gallery.ts`, seed `GALLERY_SEED` = 20261120 plus the entry index; keys from a development
FNV-1a stand-in for `key_hash`, `src/dev/keyHash.ts`):

| Id | Chart |
|---|---|
| `line-1` | Request rate, 1 series × 1 440 points (`rps`) |
| `line-50` | Request latency, 50 series × 1 440 points (ms) |
| `line-gaps` | Queue depth with gaps, 3 series (a NaN run, periodic NaNs, a lone point) |
| `line-600` | Pod memory, 600 series × 60 points (bytes; 500 shown) |
| `heatmap` | Request latency distribution, 60 columns × 12 buckets (5 ms … 10 s, `+Inf`) |
| `bars` | Log volume by level, 5 levels × 60 buckets |
| `stat` | p99 latency, 2.84 s |

The same window always gives the same pixels; the gallery is the corpus of
`golden:interim-gallery` and `bench:frame-interim-line` ([Build, test and CI](../development/build-and-ci.md)).

## Replacing the engine (#68)

The WASM engine implements the same `ChartEngine` interface and is returned by
`defaultChartEngine()`; only `engine/index.ts` changes. The canvas is already created per frame
lifetime, so it can be transferred to the render worker, and `keyTarget` lets the adapter forward key
presses as the Canvas 2D engine does. Frames from the BFF arrive as Arrow (`FrameData` gains that
form in #68/#62).

## Design references

[ADR-0014](../../designs/adr/0014-typescript-react-web-client.md) §3, §4;
[ADR-0007](../../designs/adr/0007-in-house-vis-engine.md);
[05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md) (VIZ-001 library
clause, VIZ-010 gaps and stacking, VIZ-013, VIZ-069);
[08 Visual language](../../designs/product/08-visual-language.md) (VL-002 and Table 8-1a, VL-006,
VL-012); [03 Interaction model](../../designs/product/03-interaction-model.md) (INT-033);
[02 Information architecture](../../designs/product/02-information-architecture.md) (IA-020 subset);
[T01](../../designs/technical/T01-frontend-architecture.md) (T01-002, T01-003, T01-009, T01-010),
[T02](../../designs/technical/T02-vis-engine.md) (T02-004, T02-005),
[T03](../../designs/technical/T03-browser-runtime.md) (T03-013),
[T05](../../designs/technical/T05-testing-and-performance.md) (T05-002),
[T08](../../designs/technical/T08-dom-component-kit.md) (T08-027),
[T18](../../designs/technical/T18-security.md) (T18-004).
