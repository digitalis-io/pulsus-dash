# Charts

Every chart in the client is one `<ChartFrame>` on one `<canvas>`, drawn by a chart engine behind the
seam of [ADR-0014](../../designs/adr/0014-typescript-react-web-client.md) §3 (amended by
[ADR-0019](../../designs/adr/0019-chart-frame-drawn-event-and-frame-id.md),
[ADR-0020](../../designs/adr/0020-chart-camera-commit-and-value-range.md),
[ADR-0022](../../designs/adr/0022-chart-thresholds-and-stat-sparkline.md),
[ADR-0023](../../designs/adr/0023-chart-event-markers.md),
[ADR-0025](../../designs/adr/0025-chart-frame-selection.md) and
[ADR-0028](../../designs/adr/0028-chart-seam-bar-chart.md)). Until the Rust/WASM
engine lands (#68), the engine is the in-house **interim Canvas 2D renderer** in
`client/src/engine/canvas2d/` (ADR-0014 §4; no charting library, VIZ-001, T01-002). It draws five
kinds: line, stacked bars, heatmap, stat and the bar chart ([below](#bar-chart-adr-0028)). This page covers the seam, the frame data and its
validation, number formatting, colours, axes, interactions (including zoom and pan), accessibility,
limits and the chart gallery.

## The seam

`src/engine/api.ts` holds the types the application uses; nothing else in the engine is imported by
application code.

| Type | Meaning |
|---|---|
| `VisSpec` | `line`, `bars` (`stacking: 'normal'`, `categoryLabel`, `categoryOrder`), `heatmap` (`unit`, `countUnit`), `stat` or `barchart` (`BarchartSpec`, below); each has a `title` and a `unit`. Line and bars take an optional `valueRange` (`{ min, max }`, `min < max`, finite): the user's value-axis pin; absent means auto (#93). Line and bars also take an optional `thresholds` (`ThresholdLine[]`: `{ value, state, label }`, `state` `watch`, `degraded` or `failing`; at most 8 drawn, in order; [ADR-0022](../../designs/adr/0022-chart-thresholds-and-stat-sparkline.md)). Data, never code |
| `BarchartSpec` | `barchart` (ADR-0028): `title`, `unit`, `orientation` (`horizontal` or `vertical`), `valueLabels`, `names?: 'hidden'` (set by the panel's fit), `valueRange?`, `thresholds?`, `ghost` (a dashed bar at each finite baseline) and `anomaly` (nothing drawn until Epic #9) |
| `FrameData` | `series` (`SeriesFrame[]`), `heatmap` (`HeatmapFrame`), `scalar` (`ScalarFrame`) or `categories` (`CategoryRow[]`, at most 200, in draw order, and the panel's `Coverage`; ADR-0028), from `src/data/frames.ts` |
| `ChartEngine.createFrame(canvas, { timeZone, keyTarget })` | One frame per canvas. `keyTarget` is the element whose key presses move the crosshair (the slider); `null` for stat and barchart |
| `ChartFrame` | `setSpec`, `setData`, `setTimeWindow`, `setTheme`, `setEvents(events)` (ADR-0023: replaces the frame's `EventMarker[]`, `{ id, atMs, endMs, kind, title }` with `kind` `deploy`, `config`, `flag` or `annotation`; `[]` = none), `setSelection(sel)` (ADR-0025: the page selection `{ keys, fromMs, toMs }` drawn in the next frame; `null` = none; an equal value redraws nothing), `resize(cssW, cssH, dpr)`, `on(event, cb)` → unsubscribe, `dispose()` |
| Events | `a11y` (`FrameSummary`: kind, series shown and total, window, min, max, last, plot rectangle, `valueAxis`: `{ min, max, manual }` for line and bars, `null` for heatmap and stat, `thresholdLabels`: the threshold label boxes `{ box, text, clipped }` in stack order, `[]` for heatmap and stat, ADR-0022, and `eventLabels`: the event label boxes `{ box, x, ids, text, clipped }` in x order, `[]` for stat, ADR-0023), `hover` (`HoverEvent` or `null`), `brush` (`{ fromMs, toMs, gesture: 'drag' \| 'zoomOut' }`), `select` (ADR-0025: `{ source, item }` for a click on the plot, `item` the `HoverItem` under it — `point` `{ key, tMs, value }` or `bucket` `{ index, tMs, toMs, count }` — or `null` for an empty click), `drawn` (#90), `commit` (`CommitEvent`, #93: `{ window, value, gesture }`; below), and for the bar chart `mark` (`MarkEvent` `{ source, key, index, xCss, yCss, rows }` or `null`) and `pick` (`{ keys, gesture }`; `keys` `[]` is an empty click). A bar chart's summary also carries `coverage` (copied from the data), `namesHidden` and `valuesHidden` |

`src/engine/index.ts` exports `defaultChartEngine()` (one `Canvas2DEngine` per page) and
`ChartEngineContext` (React context, default `defaultChartEngine()`). Tests provide a fake engine
through the context (`src/test/fakeEngine.ts`).

### Who owns what

| Concern | Owner |
|---|---|
| Context window and URL | The application. `ChartFrame` turns a `brush` event into a `setRange` (box zoom; absolute times, pushed) or `zoom out` (double-click) action of `useTimeContext().dispatch`, and a `commit` with a `window` into the same `setRange` push. The engine only proposes windows |
| Value-axis pin | The `ChartFrame` instance (`useState`), keyed by the spec's kind and unit. It is passed back to the engine as `valueRange` in the spec. It is not in the URL or the Context, and is lost on unmount, reload, or a kind or unit change |
| Validation, notices, tooltip, summary label, crosshair slider, Reset Y axis button | `ChartFrame` (`src/charts/`) |
| Scales, ticks, marks, picking, the camera (view, gesture, changed axes, band hold), layer cache | The engine frame; discarded on `dispose()` |

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
| `cap` | `<n>` bars is more than the 200 a bar chart draws |

A `barchart` needs `categories`: `kind` unless it gets them, then `cap` over 200 rows, then `key`
for the first key that is not 16 hex digits or repeats. Its empty data is no rows with
`EMPTY_COVERAGE`.

`seriesName(labels)` prints `name{k="v", …}`: `__name__` first, the other keys sorted, `{}` when
there are no other labels.

## Numbers (VL-012, T08-027)

`formatValue(v, unit, digits = 3)` in `src/i18n/format.ts` formats every number the charts show.
At the default three digits: three significant digits (from 100 the rounded integer), trailing
zeros dropped. `digits` 4 to 17 gives `toPrecision(digits)` at every magnitude, trailing zeros
dropped (`1234` at 4 → `1.234k`, `123.456` at 5 → `123.46`, `6.999999999999999` at 17 →
`6.9999999999999991`); the histogram's edge labels use it (T21-013).

| Unit | Examples |
|---|---|
| `none` | `0`, `0.0123`, `1.2k`, `-1.2k`, `1P` (SI prefixes k, M, G, T, P from 1 000; none below 1) |
| `suffix` | `1.2k rps` |
| `time` (`base` ns, us, ms or s) | `150 ns`, `120 ms`, `2.84 s`, `1 min`; the largest of ns, µs, ms, s, min, h, d whose value is at least 1; `0` → `0 s` |
| `bytes` | `512 B`, `1023 B`, `1 KiB`, `1.5 GiB` (IEC, ×1 024) |
| `percent` / `percentunit` | `38 %` from 38 / from 0.38 |

A value that rounds up to the next unit is carried (`999.6 ms` → `1 s`, `59.99 s` → `1 min`,
`1048575 B` → `1 MiB`). `NaN` is `—`, infinities `+Inf` and `-Inf`.

**Out-of-range form (T21-013, #208).** When the value converted to the unit's base (×100 for
`percentunit`, seconds for `time`) is c ≥ 1e21 or 0 < c < 1e−12, it is written as
`toPrecision(digits)` in exponent form plus the base tail, as `formatCompact` does: `1e21` →
`1e+21` (was `1000000P`), `2.5e22` → `2.5e+22`, `1e-4` ns → `1e-13 s` (was `0.0001 ns`), `1e22` B →
`1e+22 B` (was `8881784 PiB`), `5e21` rps → `5e+21 rps`. Every other output is unchanged
(`1e19` percentunit stays `1e+21 %`, `1e-13` stays `1e-13`). Axis tick labels follow, so a value
axis of such ticks can be narrower; the Rust port (`dash-units` `format_value`, three digits only)
matches byte for byte on `engine/fixtures/format.json`, and `dash-axes` on `layout.json`. `formatHourMinute` and
`formatDayMonth` are the axis label formats (`14:05`, `19 Nov`).

`formatCompact(v, unit)` (#93) is the form of a value label under a held band: the sign, at most
four significant characters (three significant digits), an SI prefix (p, n, µ, m, k, M, G, T, P, E)
and the unit's tail. It never truncates.

| Unit | Converted value | Tail | Examples |
|---|---|---|---|
| `none` | v | (none) | `0.000015` → `15µ`; `-1234` → `-1.23k`; `999600` → `1M` |
| `suffix` | v | ` <suffix>` | `-0.00002` rps → `-20µ rps` |
| `percent` / `percentunit` | v / v · 100 | ` %` | `1234567` → `1.23M %` |
| `bytes` | v | ` B` | `1536` → `1.54k B` (SI, exact in value) |
| `time` | v in seconds | ` s` | ms `-3590000` → `-3.59k s` |

Zero is `0` plus the tail; `NaN` and infinities are as `formatValue`. Outside
`1e-12 ≤ |converted| < 1e21` there is no prefix: the plain three-digit form is used (`1e-13`,
`1e+21`), which can be wider than the band (the label is then chipped). `compactSamples(unit)` lists
the widest compact label per prefix, `-88.8<prefix><tail>`.

## Colours (VL-002, VL-006, T01-010, T02-004, T02-005)

All chart colours come from `src/styles/tokens.ts`, generated from `design/tokens.toml`:
`seriesPalette` (the eight `series-N` colours per theme, in order) and `sequentialRamp` (the nine
`ramp-N` colours per theme, one hue, lightness stepped evenly), plus `surface-1` (background),
`hairline` (grid), `text-muted` (axis text and crosshair), `text` (stat value) and `brush` (the brush
band). State colours are never used for series (VL-003). They reach the marks only through
`StateEncoding` (`src/theme/stateEncoding.ts`, T02-004): each state has `colour` (its token per
theme), and `themeColours(t).state[s]` is `StateEncoding[s].colour[t]`, used only by the threshold
lines and labels. The marks take the state glyphs from `StateEncoding[s].glyph` as well.

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

- **Layout.** The plot starts after the value-label band, 8 px and the 4 px tick; 8 px from the
  top and right; the time axis takes 4 px of tick, 2 × 4 px of padding and one 14 px label line at
  the bottom. Stat has no axes. The band is the widest value label, but never narrower than the
  widest **compact** label of the unit (`minValueBand`: the 11 samples `-88.8p` … `-88.8E` plus the
  unit's tail, measured in the axis font; 42 px for plain numbers, 56 px for durations
  (`-88.8µ s`); T02-011 as amended by #93). Heatmaps use the same minimum for their bucket labels.
- **Held band** (#93). While the camera is worked the band keeps its width (below, "The band
  hold"). Each tick label is then drawn in full when it fits, else in compact form
  (`formatCompact`), else whole inside the plot: left edge at `plot.x + 4 px`, over the marks, on a
  chip in the tooltip surface colour with the corner radius and up to 4 px padding. The chip shows
  the full label when it fits the plot width, else the compact form; its padding shrinks, down to
  zero, so the chip stays inside the plot. When neither form fits the plot (a plot only a few
  pixels wide), that tick's label is omitted and its gridline remains: a label is never drawn
  partially or outside the plot
  ([T02-011](../../designs/technical/T02-vis-engine.md#t02-011--axis-bands-do-not-jitter), as
  amended by #93).
- **Value axis** (line, bars). Auto: the domain includes 0 and the data (bars: the stacked totals).
  Steps are 1, 2 or 5 × 10^k in units of 1 000^p (1 024^p for bytes), widened until labels are at
  least label height + 2 px apart. Grid lines are hairlines. Manual (`valueRange` set): the domain is
  exactly the range, the ticks are those of the range inside it (1e-9 relative tolerance), and the
  marks are clipped to the plot (`save`, `rect`, `clip`, `restore`); hover dots outside the plot are
  not drawn. `valueTicks` (`canvas2d/valueTicks.ts`, #97) always finishes, for every finite domain:
  - **Nice search** (`niceValueTicks`). It runs only on finite ends with `min ≤ max`, both
    magnitudes ≤ 1e300 and a span under 2^1023; at most 64 step iterations (`MAX_TICK_STEPS`), at
    most 10 001 ticks (`MAX_TICK_COUNT` intervals), and `ticks − 1 ≤ floor(h / (label + 2))`. It
    gives up (null) outside that domain, when equal ends cannot be widened (`min + 1 === min`), when
    no step fits in 64 iterations, or on any non-finite result.
  - **Short plots.** Three ticks need both gaps to hold a label, two need a plot at least
    label + 2 px tall (16 px at the 14 px label), and below that a single tick is drawn: the end
    nearer zero (the lower end on a tie).
  - **Collision check.** After the search, every tick is mapped through the renderer's own y
    (`tickY`, built on `valueFraction`); if two adjacent ticks are equal or a drawn gap is below
    (label + 2)·(1 − 1e-9) px, the nice result is dropped for the fallback. The 1e-9 relative
    slack (`GAP_TOLERANCE`) only absorbs the rounding of the y subtraction
    ([T02-011](../../designs/technical/T02-vis-engine.md#t02-011--axis-bands-do-not-jitter)).
  - **Fallback** (`extremeTicks`): `[lo, lo/2 + hi/2, hi]` when the midpoint is strictly inside and
    both drawn gaps hold a label, else `[lo, hi]` when the plot holds one gap, else the end nearer
    zero. Equal ends are first widened toward zero (`4..4` → `2..4`, `0..0` → `0..1`).
  - **Overflow mapping.** When the domain span `max − min` overflows (for example −MAX..MAX), the y
    mapping uses the halved form `(v/2 − min/2) / (max/2 − min/2)`, so the line and its labels stay
    finite; otherwise the arithmetic is unchanged.
  - **Changed outputs** (#97 plan §4.3). Ends beyond ±1e300 now get the fallback (0..1e301 →
    `[0, 5e300, 1e301]`); spans a few ulps wide that gave one tick with `min === max` now get the
    fallback; plots under one label gap show one tick instead of two; and a nice result whose
    12-digit rounding repeats a tick (a relative span under about 1e-11, such as 1..1 + 1e-11)
    gets the fallback. Everywhere else the output is byte-identical to before. Labels that format
    to the same three significant digits without their pixels colliding are a number-format
    matter, not a collision.
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
- **Stat.** The formatted value, centred, in 32 px semibold. With series data whose first series has
  at least one finite value in the window, and a frame at least 104 px tall (`SPARK_MIN_H`), a
  **sparkline** runs under it: the rect `{ x: 12, y: h − 8 − 32, width: w − 24, height: 32 }`, the
  window across it, the min to max of the series' finite values inside the window from its bottom to its top (mid-height when they
  are equal), in the series colour, 1.5 px with round joins. It is a trend glyph: it joins the
  finite points inside the window across absent and non-finite ones (a sparse series on the step
  grid is mostly absent points), and a single finite point is a dot of radius 1.5 px. The value
  then sits at `(h − 32 − 8) / 2`. A scalar, a series with no finite value in the window or a
  shorter frame draws the value alone, centred, as before.

### Threshold lines (ADR-0022, #64 Part B)

On line and bars, after the series and before the value-label chips (`engine/canvas2d/thresholdMark.ts`):

| Step | Rule |
|---|---|
| Domain | The auto value domain is `withThresholds(min, max, thresholds)`: the data's (line) or the post-merge stacked totals' (bars, with 0) min and max, widened to every finite threshold; the axis still includes 0. A pinned `valueRange` is used unchanged. `FrameSummary` min, max and last stay data-only |
| Line | For the first 8 thresholds with a finite value inside the plot: dashed (`size.chart-dash` 5 px, `size.chart-dash-gap` 4 px), 1 px (`border.hairline`), in `colours.state[state]`, at `Math.round(y) + 0.5` across the plot. A threshold outside a pinned axis draws no line |
| Label text | `${glyph} ${label}` for every finite threshold, drawn or not, in `AXIS_FONT` and the state colour, on a `colours.chip` box `LABEL_HEIGHT` tall with `space.1` padding, from `plot.x + space.2` |
| Place | Above its line (`y − 4 − H`), or below it when that would leave the plot; at the plot's top or bottom edge for a line off a pinned axis |
| Width | At most `maxW = max(0, min(plot.width − 16, round(plot.width / 2)))`: a longer text keeps its longest code-point prefix that fits with `…` (or the glyph alone), and is `clipped` |
| Stack | Labels sorted by their place (ties in spec order) are pushed down so none overlaps (gap 4 px); if the last passes the plot's bottom, the boxes are shifted up whole, keeping their height and gap |
| Overflow | If the first box then leaves the plot's top, `n = floor((plot.height + 4) / (H + 4))` boxes fit: the first `n − 1` stay and the rest become one `+N` chip (axis text colour, `clipped`, `text` = their full texts joined by `; `) |
| Leader | A label moved from its place, or whose line is off-axis, gets a 1 px vertical leader in its state colour at `plot.x + 4`, from the box's middle to its line (or the plot edge) |

The layer redraws on every camera preview, so the lines and labels move with the value axis.

### Event markers

On line, bars and heatmap (`engine/canvas2d/eventMark.ts`, [ADR-0023](../../designs/adr/0023-chart-event-markers.md),
#64 Part C). Stat ignores events. A frame without events draws exactly as before. An empty
heatmap (no timestamps or no bounds) draws no axes or cells but still draws and reports its events.

| Step | Rule |
|---|---|
| Band | Once the last `setEvents` held at least one event, in view or not, the plot starts at `space.2 + EVENT_BAND` (`EVENT_BAND` = `LABEL_HEIGHT + space.1` = 18 px) and is shorter by it (`layoutPlot(…, eventBand)`), so a pan never moves the plot. `setEvents([])` gives today's layout |
| In view | Events with a finite `atMs` inside the drawn window (the preview's during a gesture), sorted by `(atMs, id)`, at `x = Math.round(xOf(atMs)) + 0.5` of the frame's time transform |
| Line | Solid, 1 px (`border.hairline`), in `colours.event` (`text-muted`), from the plot's top to its bottom, one per event in view. Order: axes, series (paths, bars, cells), thresholds, **event lines**, value-label chips, **event labels**, overlay. Clipped to the plot when the value axis is pinned |
| Text | `${glyph} ${title}` with ◆ deploy, ⚙ config, ⚑ flag (`theme/glyphs.ts`, T02-008); a note is its title alone. `AXIS_FONT`, `colours.axisText`, `textBaseline: 'top'`, at `y = space.2`, through `fillText` only (T02-019) |
| Groups | In order, an event joins the current group while it is less than `size.target-min` (24 px) right of the group's first line, else it starts a group |
| Bounds | The band is `[L, R] = [plot.x, plot.x + plot.width]`. Group i's anchor is `a_i = max(L, firstX_i − 4)`, its limit `a_{i+1} − 4` (the last's is `R`), and `lo_i` is the previous box's right `+ 4` (the first's is `L`). No box leaves `[L, R]` or comes within 4 px of another |
| Forms | A single event's forms are the full label, `fitText` (the longest prefix of at least 2 code points with `…`, `engine/canvas2d/text.ts`) and the short form (the glyph, or the first code point with `…`). A group of two or more is a chip: `+N`, or `99+` past 99 |
| Place | (a) Left-aligned at `a_i` with room `limit − a_i`: the full label, then `fitText`. (b) Else right-aligned at the limit with room `limit − lo_i`: every form. (c) Else the group merges into the previous placed group as a chip, which is placed again from (a); repeated as needed. (d) With no previous group, every group becomes one chip with limit `R`; if neither (a) nor (b) fits it, there is one box `{ x: L, width: R − L }` without text holding every id |
| Summary | One `EventLabelBox` per placed group: `box` (`y = space.2`, `LABEL_HEIGHT` tall, the drawn width), `x` (its first member's line), `ids` in `(atMs, id)` order, `text` (every member's full label joined by `; `) and `clipped` (anything but a whole single label). Every event in view is in exactly one box. The boxes are part of the summary, so a change emits `a11y` again |

`setEvents` with the same array does nothing. A change that gains or loses every event moves the
plot, so it clears the hover as any layout input does; other changes redraw the layer only. The
layer redraws on every camera preview, so the markers follow a pan or a zoom before its commit.

### The same rules on the engine (#68 Part C2c1)

The WASM engine's line frames draw the threshold lines and event lines by these rules
([engine](engine.md#thresholds-and-event-markers-part-c2c1)): the first 8 thresholds, the
`withThresholds` auto domain, the dashes as Canvas 2D strokes them (from `plot.x`, 5 on 4 off,
offset 0, cut at the plot's right edge), the event band once the frame holds an event, and one
`text-muted` column per event in view. Their labels wait for the engine's text mark (#69), so its
summary's `thresholdLabels` and `eventLabels` stay empty. One difference: on an auto axis an event
at the window's end (or rounding to it) is drawn in the plot's last column, where Canvas 2D strokes
it one column outside the plot (it clips only under a pinned axis, as the engine does then).

The parity fixture `engine/fixtures/layer.json` (`client/scripts/engine-fixtures-layer.ts`, part of
`npm run engine-fixtures`) runs `drawLayer` with a recording 2D context on the gallery's
`line-thresholds` and `line-events` and on cases with thresholds above, below and inside the data,
a NaN, 10 lines, a pinned axis, a line at the plot's top, no events, events out of view, NaN, at
both window ends (auto and pinned) and 30 s apart, at 1118×240 and 300×150 at DPR 1 and 2 (and
800×240 for the probe cases). Each frame records the plot, the domain, the label band, the event
band, `layoutPlot` with it, every dashed stroke (its y, ends, pattern, offset, colour and dash runs)
and every event stroke (its x, colour and clip), and the summary's label boxes. The Rust tests
(`layer_parity`, `layout_event_band`) and the browser tests (`e2e:engine-layer`,
`canvas2d parity`) read it; `unit:engine-fixtures` keeps it fresh.


## Interaction (INT-033, IA-020 subset)

| Input | Effect |
|---|---|
| Pointer over the plot | Line: the crosshair snaps to the nearest sample of the first series; every series whose nearest sample is within half its own step is listed. Bars and heatmap: the bucket under the pointer. Heatmap pointer: the bucket row under the pointer (`≤ 0.5 s`, or `> 10 s` for the `+Inf` band) |
| Zoom and pan | The 2D camera, below |
| Focus the crosshair slider, then `→` / `Home` or `←` / `End` | The crosshair starts at the first or last sample (bucket). Then `←` `→` move by one, `PageUp` / `PageDown` by ten, `Home` / `End` to the ends; `Escape` or leaving the slider hides it. Ctrl, Meta and Alt combinations are left to the browser |
| `↑` / `↓` on the slider | Selects the previous or next row of the tooltip; the slider's value text reads it |
| A click on the plot (left, no modifier, < 4 px of travel, no camera move) | The engine emits `select` with the mark under it; `ChartFrame` calls `onInspect(target, 'pointer', slider)`, or `onEmptyClick()` when nothing is under it ([the Inspector](inspector.md)) |
| `Enter` or `Space` on the slider (keyboard crosshair) | `onInspect` with the slider's selected row, source `keyboard` |
| A stat tile with `onInspect` | A transparent "Inspect <title>" button over the tile inspects its value |

`ChartFrame` takes two optional props from `useChartInspect` ([the Inspector](inspector.md)):
`onInspect(target, source, returnFocus)` and `onEmptyClick()`; without them a click selects
nothing, Enter is ignored and a stat has no inspect button. It reads the page selection
(`useSelection()`), passes it to the engine with `setSelection`, and mirrors its keys in
`data-selection-keys` (`''` for none). The engine draws the selection in the layer pass
(ADR-0025): unselected line series and bar segments at `opacity.dimmed` when the selection names one
of the frame's own series, a `focus` underlay under a selected line, a 2 px inner `focus` stroke on
a selected bar segment, a 2 px `focus` ring on a selected stat, and a `selection` band for an
interval on line and heatmap.

**One rule set, two engines (#68 Part C2b).** The hover and click rules live in
`canvas2d/pick.ts` (`hoverAt`: the keyboard crosshair or the pointer's nearest sample, and
`hoverRows`), `canvas2d/select.ts` (`pickItem`, line: the hover row nearest the pointer's y) and
`data/frames.ts` (`seriesName`). The WASM engine's render worker uses a Rust port of the line
rules (`dash-scene::hover`: `hover_at`, `pick_item`, `series_name`, with `nearest_index`), with the
same arithmetic in the same order so every number is bit-equal. `npm run engine-fixtures`
writes `engine/fixtures/hover.json` from the TS functions (line-50 at every 6th sample, line-gaps,
line-1, two series of 15 s and 60 s steps, NaN samples, a manual axis; key indices 0, n − 1 and
n; 200 seeded pointers; names with quotes, backslashes, newlines, no `__name__` and keys that sort
differently by UTF-16 code unit than by code point), and `unit:hover-parity` checks the port
against it. Change the TS rule, rewrite the fixture, and the port must follow. The engine draws
the crosshair, dots and box band as `drawOverlay` does
([the engine](engine.md#hover-select-and-the-overlay-part-c2b)); the tooltip stays DOM for both.

The tooltip is DOM, beside the crosshair (flipped left at the frame's right edge), positioned with
CSSOM (`style.translate`, allowed by the CSP, T18-004). It shows the time and the rows sorted by value
(descending, then name), 20 at a time with "Rows a–b of n". With the pointer, the 20-row window
follows the pointer's height over the plot: the top of the plot shows rows 1–20, the bottom the last
20, so every series can be reached. With the keyboard, the window is centred on the selected row.

## Zoom and pan: the 2D camera (#93)

The Canvas 2D frame holds an orthographic 2D camera (T02 §4.6) as render-local state: a **view**,
the time window and the value range it draws. Every wheel, pinch, swipe or drag event changes the
view and redraws the frame from the data it already holds, with no request (T01-005). When the
gesture ends (300 ms with no wheel, or the pointer is released) the frame emits one `commit` event,
and `ChartFrame` applies it: the window becomes the Context window (one `setRange` push, so one
history entry and on a board every panel follows), and a value range becomes the chart's pin. The
code is in `src/engine/canvas2d/camera.ts` (the math), `input.ts` (input classification) and
`src/engine/controller/controller.ts` (the gesture state machine, `FrameController`).

**One controller for both engines** (#68 Part C2a2, [ADR-0030](../../designs/adr/0030-engine-camera-controller-on-main.md)).
`FrameController` was moved out of `Canvas2DFrame` unchanged: its state (the base window, the view,
the value view, the gesture, the held band, the right press, the zone, the pointer and the key
index), its listeners and every method of the gesture machine, with only these substitutions: the
frame's layer model became `Stage.model()` (`plot`, `valueDomain`, `labelW`, `pickCount`), a layer
redraw `Stage.redraw()`, a hover update `Stage.hover()`, the click's `select` `Stage.select(p)`, a
box-band redraw `Stage.boxChanged()`, and the bar chart's input the `BarHooks`. The Canvas 2D frame
is its stage over its last drawn layer; an engine frame's stage is the engine's last completed
presentation (`ControlledFrame`, [engine.md](engine.md#the-camera-controller-part-c2a2)). The #93
tests (`canvas2d/*.test.ts`, `test/cameraKit.ts`, `test/engineHarness.ts`) run unchanged against
the Canvas 2D frame; `e2e:engine-camera` runs the same cases against engine frames. Two additions
serve engine frames only: the **committed camera** (the window, value view and band of the last
external `setSpec` or `setTimeWindow`, or of the last emitted commit or fit) and `abortGesture()`,
which drops a running gesture when the stage is withdrawn and restores the committed camera, with no
`commit` or `brush`.

### Inputs (line, bars, heatmap; stat has none)

| Input (where) | Action | Commit |
|---|---|---|
| Wheel (plot) | Zoom time about the pointer | `{ window, gesture: 'wheel' }` after 300 ms idle |
| Pinch: `Ctrl`+wheel with a fractional `deltaY` (plot) | Zoom time about the pointer | As wheel |
| Safari `gesturestart` / `gesturechange` / `gestureend` (plot) | Zoom time about the pointer by `lastScale / scale`; `Ctrl` wheels between start and end are ignored | As wheel |
| `Shift`+wheel (plot) | Zoom values about the pointer (line, bars); heatmap: consumed, no change | `{ value, gesture: 'wheel' }` |
| `Ctrl`/`⌘`+wheel with whole-number steps, or `⌘` (plot) | Zoom time and values about the pointer (heatmap: time only) | `{ window, value }` |
| Horizontal two-finger swipe, `|deltaX| > |deltaY|` (plot) | Pan time | `{ window, gesture: 'wheel' }` |
| Wheel anywhere else | Not consumed: the page scrolls | — |
| Left or middle drag of 4 px or more (plot, x-axis band) | Pan time; the content follows the pointer | `{ window, gesture: 'pan' }` (plot) or `'axis'` (band) on release |
| Left drag of 4 px or more (y-axis band; line, bars) | Pan values, from the auto domain when unpinned | `{ value, gesture: 'axis' }` on release |
| Right drag, or `Alt`+left drag, of 4 px or more (plot) | Box zoom: on release the dragged span, both ends snapped to the brush unit (the smallest of 1 s … 1 d that is at least 4 px of time), at least 1 s | `brush { gesture: 'drag' }` |
| A press that moves less than 4 px | Nothing (a click) | — |
| Double-click (plot) | Zoom out: twice the window, around its centre | `brush { gesture: 'zoomOut' }` |
| Double-click (y-axis band; line, bars) | Value axis back to auto, when pinned | `{ value: 'auto', gesture: 'fit' }` |
| Reset Y axis button | Value axis back to auto; focus moves to the crosshair slider | None (`ChartFrame` state) |
| `Escape` on the slider, `pointercancel`, `lostpointercapture` during a press | Cancel: the view and value range are restored, no commit, no box | — |
| Left press with `Ctrl` and not `⌘` (macOS secondary click), touch pointers | Ignored | — |

The pinch test is a heuristic (owner-delegated decision of 2026-11-21): a mouse that reports
fractional `Ctrl`+wheel steps zooms time only, and a pinch with whole-number steps zooms both axes.
Both outcomes are accepted and pinned by `input.test.ts`. Every consumed wheel and handled press
calls `preventDefault()` (no page scroll, browser zoom, text selection or middle-button
autoscroll); a wheel during a press is consumed and ignored.

| Constant (`input.ts`) | Value |
|---|---|
| `WHEEL_IDLE_MS` | 300 ms: a wheel gesture commits after this long without a consumed wheel |
| `WHEEL_ZOOM_PER_PX`, `PINCH_ZOOM_PER_PX` | factor = exp(px · k), k = 0.002 (a 100 px notch zooms × 1.221) or 0.01 for a pinch |
| `WHEEL_LINE_PX`, `WHEEL_MAX_PX` | `deltaMode` 1 is 16 px a line, `deltaMode` 2 is one plot height; \|px\| is clamped to 400 per event |
| `DRAG_MIN_PX` | 4 px (`size.chart-brush-min`) |
| `PAGE_WHEEL_LATCH_MS` | 300 ms (the scroll latch) |

Zones: the **plot** (edges included), the **x-axis band** below the plot within its x range, the
**y-axis band** left of the plot within its y range (line and bars only). The canvas carries the
zone under the pointer in `data-zone` and the press in progress in `data-gesture` (`pan`, `box`,
`axis-x`, `axis-y`); the cursors follow them (`grab`, `ew-resize`, `ns-resize`, `grabbing`,
`crosshair`).

### Wheel and page scroll

A wheel over a plot is consumed unless the page saw an unconsumed wheel in the last 300 ms: then a
scroll already in progress keeps scrolling as it passes over a chart. This holds while the chart's
own wheel gesture is still pending too (zoom, scroll the page elsewhere, come back within 300 ms:
the page keeps scrolling, and the pending zoom commits as usual). One passive `wheel` listener
per page (`windowWheelLatch`, created with the first frame) records the `timeStamp` of every wheel
no listener prevented. A wheel over an axis band, a margin, the title, the Reset Y axis button or
outside charts is never consumed, so the page scrolls, and `Ctrl`+wheel outside plots zooms the page
as before.

### Context menu

On the plot, neither a right drag nor a right click opens the browser's menu: a right press in the
plot sets a flag that the next `contextmenu` consumes (`preventDefault`), and that a 0 ms timer
after the release, or the next press, clears. This covers both event orders (menu on press, menu
after release). A `contextmenu` with no right press in the plot (the menu key, `Shift+F10`, a right
click on an axis band or elsewhere) is not touched. The application has no context menu of its own.

### The gesture and its commit

| State | Meaning |
|---|---|
| idle | The view is the base window (the last `setTimeWindow`, or the last committed view) |
| wheel | Entered by a consumed wheel, swipe or pinch; every further one re-arms the 300 ms timer; a handled press commits it at once |
| press | Entered by a handled press; it moves the view once it has moved 4 px (box: horizontally); ends on release (commit or box), or on cancel |

The preview is f64 and is not rounded, except that time pans of a view narrower than the minimum
span move by whole ms (decided from the preview's own span). Each step records which axes it moved;
a commit carries only those axes:

- `window` is the whole-ms view (`Math.round` of both ends) when the gesture moved time and that
  differs from the base window; else `null`.
- `value` is the preview value range when the gesture moved values and that differs from the spec's
  `valueRange`; else `null`. Nothing is emitted when both are `null`.
- After a commit the frame adopts the whole-ms view as its base, so it never shows the old window
  while the URL catches up. A `setTimeWindow` during a gesture that has moved time changes only the
  base (the user's move wins); during one that has not, it is applied at once.

Limits: the time span stays between `max(1 s, ceil(plot width) ms)` and 3 650 days, inside
`0 … 9999-12-31T23:59:59.999Z`; the value span between `1e-9 · max(1, |anchor|)` and `1e300`, inside
`±1e300`. A zoom-in on a window already below the minimum changes nothing; a zoom-out goes to at
least the minimum. The point under the pointer stays under it while the width changes; the view is
shifted only when it would leave the bounds. Because the minimum is about 1 ms per CSS px, the one
rounding at the commit moves the time under the pointer by at most `0.5 · plot width / (span − 1)`
px, under 0.51 px on any width, and every window the camera emits is one the Context accepts.

### The band hold

The plot's `x` and `width` depend only on the canvas width, the kind and the value-label band, so
the frame holds the band from the first camera move: the plot does not move under the pointer
during the gesture, at its commit, or when the refetched data arrives (T02-021). Wider labels are
compacted or chipped (see Axes).

| Event | Band |
|---|---|
| A preview step | Held at the width of the frame on screen |
| Gesture end, commit, `setData`, `setSpec` with the same kind and unit and a set `valueRange`, the echoed `setTimeWindow` equal to the base window, any `setTimeWindow` during a gesture | Kept |
| A press that moved, then cancelled (`Escape`, `pointercancel`, `lostpointercapture`); `resize` to another size; `setSpec` with another kind or unit; `setSpec` whose `valueRange` goes from set to absent (Reset Y axis, the fit commit); an idle `setTimeWindow` to another window (picker, keys, Back, auto-refresh, another panel's commit); the pointer leaving the canvas while idle | Released: the next draw measures the labels again, and full labels return |

### The value-axis pin in `ChartFrame`

A `commit` with a value range stores a pin (`{ key: kind|unit, range }`) and the spec passed to the
engine gains `valueRange`. While pinned, a **Reset Y axis** button (accessible name
`Reset Y axis: <title>`) sits over the plot's top-left corner, placed through CSSOM. Pressing it, or
a `'auto'` commit, clears the pin. A kind or unit change clears it during render, so returning to
the old kind or unit starts unpinned. On a board, a panel whose window alone changed keeps its
previous result until the new one arrives (`usePanelRun`'s `placeholderData` with
`sameExceptWindow` over the key head, [Boards: panel runtime](boards.md#placeholder-and-loading)),
so a commit does not unmount the chart or drop its pin; a query, variable or language change still
shows `Loading`, and a visualisation change redraws the same result.

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
- While the value axis is pinned, the summary label ends `Y axis fixed at <min> to <max>.` and the
  Reset Y axis button (at least 24 × 24 px) is in the tab order after the slider.
- With thresholds, the summary label ends `Thresholds: <state> <label>; ….` listing every threshold
  in spec order (drawn, stacked, truncated or off-axis). Each `clipped` label box (truncated, or the
  `+N` chip) gets a focusable target over the canvas (`[data-threshold-hit]`, `role="img"`, named by
  the full text), at least 24 × 24 px about the box's centre (T08-010), placed through CSSOM from
  the last summary, with a tooltip of the full text on hover and focus. Stat and heatmap have none.
- With event markers (ADR-0023), every event label box, clipped or not, gets a focusable target
  (`[data-event-hit]`, `role="img"`, `data-event-x` = the box's first line), at least 24 × 24 px
  about the box's centre and kept inside the frame, so a box without text at the plot edge stays
  reachable (T08-010). Its tooltip and accessible name list the box's events,
  `<kind> · <title> · <time>` (with `–<end>` for a ranged event; kinds "Deploy", "Config change",
  "Feature flag", "Note"), joined by `; `, in the frame's time zone (`eventText`). The summary
  label then ends `Events in view: <n>.`. A click on a marker does nothing yet (click-to-compare is
  INT-030).
- When more than 500 series arrive, a status notice says "Showing 500 of <n> series".
- A browser without a 2D canvas context shows "This browser cannot draw charts." instead.

## Histogram transforms (#208 Part 1)

The transforms of the histogram panel over raw values live in `src/vis/transforms/`
([T21](../../designs/technical/T21-time-and-distribution-panels.md) T21-012 to T21-016). Nothing in
the app calls them yet: the panel, its Canvas 2D drawing, tooltip, meter popover, table and the
`bin` Inspector target come with #208 Part 2. They are pure and run in a per-panel worker.

| Module | What it does |
|---|---|
| `histogram.ts` | `histogram(input, source, o, q)`: the whole pipeline; hit regions, brush, selection reads, CDF/ECDF, meter, popover lines, summary facts |
| `bins.ts` | `binEdges`, `scaleOf`, `binIndex`, `displayCollapsed` (T21-013), re-exported by `histogram.ts` |
| `slice.ts` | `Slicer`, `checkStep`, `yieldToMain`: 8 ms steps (`STEP_MS`) for scans on the main thread |
| `histogram.worker.ts` | the worker: `onHistogramMessage`, `resultTransfer` |
| `histogramClient.ts` | the main thread: `runHistogram`, `disposeHistogram` |

The frame types (`HistogramFrame`, `SourceGroup`, `HistogramGroup`, `HistogramCoverage`, `Labels`)
and `histogramFrameValid` are in `src/data/frames.ts`; `LINE_DASHES`, `OTHER_DASH` and the four
pattern constants in `src/engine/patterns.ts`; `SummaryFacts` in `src/engine/api.ts`. No seam
member uses them yet.

### Options

`HistogramOptions`: `binMode` `auto` | `count` | `width`, `binCount` (1…200), `binWidth` (value
units, or null), `scale` `linear` | `log`, `groupBy` (a label, or null), `groupMode` `stack` |
`overlay`, `cumulative` `none` | `cdf` | `ecdf`, and the panel `unit` (for the display guard).

### Pipeline

1. Any series with an `le` label → `{kind: 'buckets', leSeries}`: an interim notice ("Histogram
   buckets: choose Heatmap; …") until bucket histograms (#212); nothing is binned.
2. More than `MAX_HIST_SAMPLES` = 2 000 000 samples (NaN included) → `{kind: 'tooMany', samples}`.
3. Per key: ±∞ samples count as `infinite`; the rest merge (T22-003): range by timestamp, the max
   on a shared timestamp (each shared timestamp is one conflict); instant the latest finite sample,
   the max on a tie (one conflict only when the tie is at the latest timestamp).
   Each extra series of a key is a duplicate.
4. Source groups: no `groupBy` → one group "all values"; else the raw label value, "`<L>` absent"
   without it. A value equal to `other`, ending in ` (<digits>)` or equal to "`<L>` absent" is
   shown quoted; names still equal get ` (1)`, ` (2)`, … in key order. Name order is
   `Intl.Collator('en', {numeric: true})`, then code-unit order. `groupKey` is FNV-1a 64 over
   `${L}\u0000${v}` (absent: `${L}\u0001`).
5. The first exclusion that applies: outside the drawable domain (0, or 1e−290 ≤ |v| ≤ 1e290) →
   `outOfRange`; on `log`, ≤ 0 → `nonPositive`.
6. received 0 → `{kind: 'empty'}`; drawable 0 → `{kind: 'noneShown', sourceGroups}`.
7. Bins (below) over the pooled drawable values; counts per drawn group (`counts[g·k + i]`), a CSR
   of each series' counts per bin (`contrib`, by key), the sorted values per source group
   (`sorted`, for the exact ECDF) and type-7 quartiles.

**Drawn groups (T21-014).** Without `groupBy`: one group, `solid`, `LINE_DASHES[0]`, colour 0.
With it: the 7 largest source groups by drawable (ties by name), in name order, with
`CATEGORY_PATTERNS[j]`, `LINE_DASHES[j]` and `seriesColourIndex`; the rest are one group
`other (n)` (key `other`, `grid`, `OTHER_DASH`, colour index −1 = `category-other`), last. A source
group with no drawable value is not drawn (`drawnAs` −1).

### Bins (T21-013)

Edges are in value units, k + 1 finite and strictly increasing, 1 ≤ k ≤ 200, e₀ = min and e_k = max
exactly; [eᵢ, eᵢ₊₁), the last bin closed. Binning runs on v (linear) or log10 v (log), with every
span and width normalised by S = 10^`scaleOf(min, max)`. S and every nice width use the exact power
`Number('1e' + e)`, which is the same in every JS engine (`10 ** 290` is not); only log-axis edges
10^x and the terminal log rule use `10 ** x`.

| Mode | Rule |
|---|---|
| `count` c | c ≤ 200 evenly spaced edges |
| `width` w | aligned to multiples of w; a width that is 0, subnormal or gives k > 200 widens to nice(span/200), then the next nice value (1, 2, 2.5, 5 × 10ᵉ) while k > 200; `widenedTo` is the width used |
| `auto` | Freedman–Diaconis h = 2·IQR·n^(−1/3) (Sturges when IQR = 0), clamped to 5…200 bins, a nice width, then as `width` |
| min = max | one bin of width nice(\|v\|·0.1) (1 at 0) around v |

Anything else invalid (|q| > 2⁵², or still k > 200 after the widening steps) falls back to `count`
20. The guard then checks every edge is finite, increasing, positive on log and that adjacent
edges differ at `formatValue(e, unit, 17)`; if not, k is reduced to the largest that passes, down to
one bin [min, max] (`adjusted` = k; `collapsed` when its two edges still read the same). Finally, on
log, a bin whose log10 edges are equal becomes one decade centred on log10 min (`adjusted` 1).
`binLabels(edges, unit)` picks the least digits 3…17 at which every adjacent label differs; a
collapsed frame has one label "≈ " + `formatValue(e₀)`. `binRangeText` is "from – to".

### Hit regions and the value brush (T21-015)

`binLayout(f, scale, mode, width, height)` gives the edges in plot CSS px (`edgePx`: px[0] = 0, px[k]
= W exactly), the count maximum and each group's bar top and bottom. `binAtPx`: outside [0, W] →
−1, else the largest i with px[i] ≤ px, and W → the last bin. `hitTestBin`: stacked segments are
hit at least 4 px tall (grown upward), the column's top segment 3 px higher, top-down; overlaid
bars by the nearest top within 4 px, else the containing bar with the smallest count (ties: the
lower group). `brushBins(f, l, p₀, p₁)` selects the bins whose pixel extent overlaps [p₀, p₁] and
returns the raw edges `from`, `to`. `binSeries` (the keys of the series with a value in [from, to))
and `selectedCounts` (the selection's counts per group and bin, null when no key matches) scan the
CSR and call `checkStep` every 10 000 entries, so a long scan yields every 8 ms and an aborted one
rejects with an `AbortError`.

### Worker and lifecycle (T21-016, PRF-005)

`runHistogram(panelId, runId, input, source, o, q, signal)` keeps one worker per panel:

1. A pending run of the panel is rejected with an `AbortError` and its worker terminated — always
   first, so an early result also supersedes it.
2. `le` series, the sample cap and an empty input are answered on the main thread, without a
   worker.
3. Otherwise each series is copied in chunks of ≤ 25 000 samples (an empty series as one empty
   entry; later chunks carry `cont: true`). When a step reaches 8 ms after an entry, the batch is
   posted with its buffers transferred, and the run yields (`MessageChannel`). The last batch is
   posted with `last: true` and no yield.
4. The worker appends the entries per `runId` and, on the last, replies with the result, its
   frame buffers transferred. The reply of an older run, or to a terminated worker, is dropped; an
   error reply or a worker `error` rejects with an `Error` and terminates the worker; a result
   resolves the run and the worker stays for the next run.
5. Aborting `signal` terminates the worker and rejects with an `AbortError`;
   `disposeHistogram(panelId)` (on unmount, Part 2) does the same and forgets the panel.

Memory at the cap is about 64 MB in the worker. Tests replace the clock, the yield and the worker
with `setHistogramEnv` (`src/test/fakeHistogramWorker.ts`).

### Meter, popover and facts

`histogramMeterParts(c, unit)` lists, in order: `truncated`, `limited (N warnings)`, "k ≤ 0 not shown
(log)", "k infinite values not shown", "k values out of range not shown", "k duplicate series
combined; c conflicts (max kept)", "bin width widened to W (200-bin cap)", "bins adjusted to k
(number limits)"; none → `100 %`. `histogramCoverageText` joins them with " · ". Counts go through
`formatValue(n, none)` (2 000 000 → `2M`); the widened width through the panel unit.
`exclusionLines` gives the popover lines per source group ("B: 1 ≤ 0, 1 infinite", members of
`other (n)` as "B (in other (3)): …"), `noneShownText` the plot text of `noneShown`, and
`summaryFacts` "median <p50>; mode <bin> (<count> of <drawable>)" with the drawable extent.

### Fixtures

`src/vis/transforms/fixtures/histogram.json` holds the T21 §10 bin rows (H1–H4, H24–H26: values,
options, edges, counts, `widenedTo`, `adjusted`, `outOfRange`) and pixel rows (edge px, hits,
brushes), every number as its exact `String(x)`; interior edges, edges of the terminal log rule
(`terminalLog`) and brush endpoints compare at a relative 1e−12, other end edges exactly, and a
brush's `from`/`to` equal the frame's own edges exactly. The engine port (#209) runs the same file. Gates: `unit:dist-bins`,
`unit:summary-facts`, `unit:selection-draw`, `unit:hist-worker`, `unit:number-format`.

## Bar chart (ADR-0028)

The bar chart (`kind: 'barchart'`, #173 Part 2) draws the rows of a `categories` frame in data
order, one bar each. The panel computes the rows, the cap and the fit
([Categorical panels](panels.md#the-bar-charts-model-and-fit-173-part-2)); the engine never caps.
`engine/canvas2d/barchart.ts` lays the frame out with `barLayout` (the same function the fit uses)
and draws, in the layer pass:

- **Value axis:** horizontal, below the plot, ticks `valueTicks(lo, hi, plot width, 72, base)` with
  vertical hairlines and `formatValue` labels; vertical, in the 48 px band left of the plot, ticks
  `valueTicks(lo, hi, plot height, 14, base)`, compact labels shortened to the band. The auto
  domain is [min(0, drawn values, thresholds), max(0, …)], nice-rounded; a `valueRange` is used as
  it is (`valueAxis.manual` true).
- **Bars:** the category extent divided by the row count is the band; a bar is
  max(1, round(0.7 · band)) thick, centred, from x(0) to x(v), both clamped to the domain. Its
  colour is the state colour when the row has a state, else `series-{1 + seriesColourIndex(row)}`
  (T22-004). No gradient, pattern or shadow (T22-001). A non-finite value has no bar and the value
  label `no data`.
- **Names:** right-aligned in the name band (rotated −90° below the plot when vertical), the state
  glyph before the name in its state colour. Hidden names leave only the glyphs, in an 18 px
  column.
- **Value labels:** past the bar end, outside the bar, in the rooms the layout keeps, so the
  label of a bar clipped at the plot edge or of a negative bar shows whole.
- **Thresholds:** a dashed line in the state colour across the value axis; its glyph above the plot
  (horizontal) or right of it (vertical). Each glyph's box goes out in `thresholdLabels` with the
  text `glyph label` and `clipped: true`, so `ChartFrame` puts a focusable target with the full text
  over it.
- **Ghost** (`spec.ghost`, a finite `baseline`): after the bar, a 1 px dashed `text-muted`
  rectangle of the bar's thickness from 0 to the baseline.
- **Selection** (ADR-0025): with a relevant selection, the other bars, names and values at
  `dimmed`, and a focus ring inside each selected bar; no selection or a foreign one makes exactly
  the calls of no selection. Intervals and event markers are ignored.

Input: a bar chart has no camera and no crosshair (`keyTarget` is null and there is no slider).
`engine/canvas2d/barInput.ts` emits `mark` when the band under the pointer changes (the band
spans the name band and the plot across the category axis) and `null` once on leaving, and `pick`
`{ keys: [key] or [], gesture: 'click' }` for a left press without a modifier released within
4 px. Wheel, Safari gestures, double click, the context menu and keys are ignored; `hover`,
`brush`, `commit` and `select` are never emitted. The brush is #173 Part 3.

`ChartFrame` shows `MarkTooltip` beside the marked bar (full name, value, `■ Failing` for a state,
`baseline <v>` with the ghost), passes `pick` to `onPick`, labels the canvas `<title>: <n> bars`
(then the thresholds), describes it (`aria-describedby`) with `BarList`, a visually hidden,
non-focusable list of every drawn bar in draw order (`<full name>: <value>`, then `, <state>` with
thresholds) and a last item `k more not shown` for the rows the cap left out, and shows no
`Showing X of N series` notice: `CategoryChart`'s meter states
the coverage. Under `engine=wasm` the bar chart stays on Canvas 2D until the engine implements
ADR-0028.

## Limits

- At most 500 series per frame (the rest are dropped with the notice), at most one polyline point
  per CSS px per series (ADR-0014 §4, with the §4 note on extremes), one value axis and one time axis.
- Drawing is on the main thread (T01-003 interim exception) with a cached layer; there is no worker,
  GPU decimation or level of detail until #68.
- No legend inside the frame (board panels draw theirs in the DOM, [Boards](boards.md)), cursor sync,
  Δ vs baseline or keyboard brushing yet. At most 8 threshold lines.
  Event markers are points on the time axis: a ranged event shows its end in the tooltip only (no
  region), and a click on a marker sets no comparison yet.
- Camera (#93): no inertia after a flick, no wheel zoom on an axis band (the page scrolls), no value
  zoom on heatmaps, no touch gestures, no keyboard value zoom, and no live following by other
  panels during a gesture (they follow at the commit). The band does not shrink after a 500 ms
  delay yet (T02-011's hysteresis arrives with the engine).

## The chart gallery

`/t/:tenant/dev/gallery` (development and stub builds only: the route is in the router only when
`import.meta.env.DEV` or `VITE_API_MODE` is not `http`, so `http` builds contain neither the route
nor its chunk; CI checks the `http` build's manifest). There is no navigation entry. The page draws
sixteen charts: eleven frames from seeded synthetic data for the current window (`src/dev/synth.ts`,
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
| `line-thresholds` | Request latency with an SLO threshold, 3 series (s), watch at 250 ms and failing at 300 ms (#64 Part B) |
| `stat-sparkline` | p99 latency with a sparkline, 1 series × 120 points (ms) |
| `line-extreme` | Values near the largest finite number, 1 series × 1 440 points mapped onto [−MAX, MAX] (#97) |
| `line-events` | Request rate with deploy and change markers, 1 series × 1 440 points (`rps`): a deploy at 30 % of the window, and a config and a feature flag change 30 s apart at 70 %, gathered into a `+2` chip (#64 Part C) |

and five bar charts (#173 Part 2, `src/dev/galleryBars.ts`), each a `barchartModel` in
`CategoryChart`, horizontal, its canvas `--size-chart` high with the meter line below:

| Id | Chart |
|---|---|
| `barchart` | `byVersion` (40, 7, 120, 3, 15): series colours, names and values |
| `barchart-thresholds` | `byVersion` and a `2.28` row of −20, watch at 30 and failing at 100: state colours and glyphs, two dashed lines, the `120` and `-20` labels whole |
| `barchart-dupes` | {2.31, eu} 50, {2.31, us} 70, {2.30, eu} 20 by `version`: `2.31 · region="us"`, `2.31 · region="eu"`, `2.30` |
| `barchart-subset` | {2.31} 40 and {2.31, region="∅"} 60 by `version`: `2.31 · region="∅"` and `2.31 · region absent` |
| `barchart-cap` | `many` (250 rows, only the 10 failing): the cap of ⌊206 / 14⌋ = 14 keeps the max, the min and the failing row |

`?…&bench=categories` shows only `barchart-cap`, 600 px wide with a 2 800 px category extent, so
it draws 200 bars (`bench:frame-interim-categories`).

The same window always gives the same pixels; the gallery is the corpus of
`golden:interim-gallery`, `golden:greyscale` (the five bar charts with the canvas in greyscale) and
`bench:frame-interim-line` ([Build, test and CI](../development/build-and-ci.md)).
The minimum value band (#93) widened the band of the line, bars and heatmap charts, so their
baselines were re-baselined once under the `golden-update` label; stat is unchanged. The two #64 Part B
entries, `line-extreme` (#97) and `line-events` (#64 Part C) got their baselines from CI under the same label. They are not Rust parity fixtures:
`scripts/engine-fixtures.ts` selects `PARITY_LINE_IDS` (`line-1`, `line-50`, `line-gaps`,
`line-600`) and projects each summary to its parity fields, so `engine/fixtures/` is unchanged. The
script (and `scripts/threshold-draw-probe.ts`) load a CSS module as a class-name proxy, so
`StateEncoding` loads in Node.

## Replacing the engine (#68)

The WASM engine implements the same `ChartEngine` interface and is returned by
`defaultChartEngine()`; only `engine/index.ts` changes. Its line frames already run the camera
controller above (Part C2a2): zoom, pan, axis drags, the band hold and the commits behave as on
Canvas 2D; since Part C2b hover, the keyboard crosshair, the click's `select` and the box band do
too (the same rules, ported), and since Part C2c1 the threshold lines and the event lines with
the event band. It implements the threshold labels and the stat sparkline (ADR-0022), the event
labels (ADR-0023, as M9 glyphs), the selection and the `select` item (ADR-0025), and the bar chart (ADR-0028: the
`categories` data, `categoryExtent` and `barLayout` exactly, `mark`, `pick` and the drawing) before
it replaces `engine/index.ts`. The canvas is already created per frame
lifetime, so it can be transferred to the render worker, and `keyTarget` lets the adapter forward key
presses as the Canvas 2D engine does. Frames from the BFF arrive as Arrow (`FrameData` gains that
form in #68/#62).

## Design references

[ADR-0014](../../designs/adr/0014-typescript-react-web-client.md) §3, §4;
[ADR-0020](../../designs/adr/0020-chart-camera-commit-and-value-range.md) (`commit`, `valueRange`,
`valueAxis`); [ADR-0025](../../designs/adr/0025-chart-frame-selection.md) (`setSelection`,
`select`); [ADR-0022](../../designs/adr/0022-chart-thresholds-and-stat-sparkline.md)
(`thresholds`, `thresholdLabels`, the stat sparkline);
[ADR-0023](../../designs/adr/0023-chart-event-markers.md) (`setEvents`, `eventLabels`, the event
mark); [ADR-0028](../../designs/adr/0028-chart-seam-bar-chart.md) (the bar chart: `barchart`,
`categories`, `mark`, `pick`, `coverage`, the extent and the layout);
[T22](../../designs/technical/T22-value-categorical-and-table-panels.md) (T22-001, T22-004,
T22-006, T22-008, §5.1);
[ADR-0007](../../designs/adr/0007-in-house-vis-engine.md);
[05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md) (VIZ-001 library
clause, VIZ-010 gaps and stacking, VIZ-011 threshold lines and event markers, VIZ-022, VIZ-013, VIZ-067, VIZ-069, Table 5-1
Stat);
[08 Visual language](../../designs/product/08-visual-language.md) (VL-002 and Table 8-1a, VL-003,
VL-006, VL-012); [03 Interaction model](../../designs/product/03-interaction-model.md) (INT-001 and INT-002
for 2D charts, INT-007, INT-008 subset, INT-025, INT-031 subset, INT-033, and the §4.1 note of 2026-11-21);
[02 Information architecture](../../designs/product/02-information-architecture.md) (IA-020 subset);
[T01](../../designs/technical/T01-frontend-architecture.md) (T01-002, T01-003, T01-009, T01-010),
[T02](../../designs/technical/T02-vis-engine.md) (T02-003, T02-004, T02-005, T02-009, T02-011 as
amended, T02-021, §4.5, §4.6),
[T03](../../designs/technical/T03-browser-runtime.md) (T03-009, T03-013, T03-016 subset, §4.4),
[T05](../../designs/technical/T05-testing-and-performance.md) (T05-002),
[T21](../../designs/technical/T21-time-and-distribution-panels.md) (T21-012 to T21-016, §5, §10; #208 Part 1),
[T08](../../designs/technical/T08-dom-component-kit.md) (T08-010, T08-027),
[T18](../../designs/technical/T18-security.md) (T18-004).
