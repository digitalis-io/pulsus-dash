# Categorical panels: reduce, cap, names, meter, table and facts

The bar chart, the pie and the stat grid ([T22](../../designs/technical/T22-value-categorical-and-table-panels.md))
turn each series of a query result into one **mark**: a key, labels, a display name, one reduced
value, a threshold state and a baseline. Everything that is not drawing is a pure, synchronous
function of the client (`client/src/vis/reduce.ts`), so it is tested without a canvas and shared by
every renderer.

**Status (#173 Part 2).** The transforms, the bar chart's model and fit (`client/src/vis/barchart.ts`),
the Canvas 2D bars ([charts](charts.md#bar-chart-adr-0028)), `CategoryChart` and the coverage
meter are in place, and the chart gallery draws five bar charts. No board or Explore surface
offers the bar chart yet: a board panel of kind `barchart` or `pie` is stored (board spec v3) but
sends no query and shows "This chart type isn't available in this version yet."
([pending kinds](boards.md#pending-kinds)), and no auto-vis `available` set holds `barchart`.
Part 3 adds it to boards with the filters, selection, Inspector, keyboard and the table view.

## The pipeline

For one run (and an optional baseline run over the shifted window, T22-012):

1. `categoryRows(result, base, { reducer, categoryBy, sort, thresholds })` merges duplicate
   series, reduces each to a mark, finds the category label, names the marks, sets each state
   with `stateOf` (`vis/thresholds.ts`), matches the baseline by key, and sorts. It returns every
   row before the cap (`CategoryResult`: `rows`, `label`, `duplicates`, `conflicts`, and the
   baseline run's `{ duplicates, conflicts }` or null).
2. `capMarks(rows, cap)` picks the rows to draw; the cap is `barCap(plotExtentCss)` =
   min(200, ⌊extent / 14⌋) for a bar chart (`BAR_CAP` 200, a 14 px band per bar, T22-004).
3. `categoryCoverage(…)` builds the frame's `Coverage`, and `coverageText(coverage)` the meter
   text.
4. `panelRows`, `panelCsv` and `summaryFacts` read **all** rows, not just the drawn ones.

The seam types live in `client/src/data/frames.ts`: `Reducer`, `Mark`, `CategoryMember`,
`CategoryRow` (a `Mark` with `members`, non-null only on an `other (n)` aggregate, which comes
with the pie in T22 I3) and `Coverage`. Every field is `readonly`. `Mark.anomaly` is null until
anomaly scores exist (Epic #9).

## The bar chart's model and fit (#173 Part 2)

`barchartModel(result, { title, rateApplied, options, thresholds })` runs once per result and
options, without a size. It reads `barchartOptions`, takes the unit `/s` after a rate rewrite
(else none), builds the `BarchartSpec` (orientation and value labels from the options; the
panel's thresholds as seam lines with `thresholdLines`, when the panel has thresholds; `ghost` and
`anomaly` off), and calls `categoryRows(result, null, { reducer, categoryBy, sort, thresholds })`.
The model keeps every sorted row (`all`), the label, the merge counts, the run's completeness, no
baseline (Part 3 runs it), `options.min`/`max`, and the input result for `summaryFacts`.

`fitBarchart(model, { width, height }, measure)` fits the model to a cell, `measure` being the
text width in the axis font:

1. `cap = barCap(categoryExtent(spec, width, height))`. `categoryExtent`
   (`engine/canvas2d/layout.ts`) is the plot's category extent exactly as every engine lays it
   out: horizontal, `height − 8 − (thresholds ? 18 : 0) − 26`; vertical,
   `width − (48 + 8 + 4) − 8 − (thresholds ? 18 : 0)` (the 48 px value band, the gap, the tick,
   the right padding and a glyph column).
2. **`tooSmall`** when the cap is below 2 with 2 or more rows, or 0 with one row: the notice text
   is `tooSmallText(all, unit)` (`too small: 5 bars (min 2.32 3, max 2.31 120)`).
3. Otherwise `capMarks(all, cap)`.
4. With `min` or `max` set, `spec.valueRange = resolveBounds(min, max, auto)`, auto being
   [min(0, drawn finite values, thresholds), max(0, …)]; without them the engine's auto axis
   applies.
5. `outside = outsideCount(drawn, valueRange)`, then `categoryCoverage`.
6. **Value-axis fit.** With the shared `barLayout` (below), while the plot is shorter than
   `minPlotPx` (2 × the width of `MMMM`) along the value axis, the fit hides the names
   (`spec.names = 'hidden'`), then the value labels (`valueLabels: false`), then gives
   `tooSmall`. `hidden` records the stage: `none`, `names` or `namesValues`. No frame mounts with
   a plot that short.
7. `rows = panelRows('barchart', all, drawn, unit)` and `facts = summaryFacts(…)`.

Every `tooSmall` draws nothing, so its coverage has `drawn` 0 (the meter reads `showing 0 of 5`,
never `100 %`) and every table row is `no`.

### The layout (`engine/canvas2d/barLayout.ts`)

`barLayout(spec, rows, cssW, cssH, measure)` returns the plot, the visible names (null when
hidden), the value-label rooms and the name band. The fit calls it with an offscreen measure, the
draw with the layer's context, so both agree.

| | Horizontal (default) | Vertical |
|---|---|---|
| Name band | left: the widest `glyph name` + 8, at most ⌊0.4 · width⌋ | below the plot: the widest name + 8, at most ⌊0.4 · height⌋; text at −90° |
| Plot | x = band + 8 + 4 + left room; y = 8 (+ 18 with thresholds); height = the extent; width = the rest − 8 − right room | x = 48 + 8 + 4; width = the extent; y = 8 + top room; height = the rest − bottom room − band |
| Value labels | right room = the widest non-negative label + 4; left room = the widest negative label + 4 (only with a negative value) | top and bottom rooms of one label line (14 px), the bottom one only with a negative value |

Rooms are 0 with value labels off. The names come from `distinctLabels` (`engine/canvas2d/text.ts`):

1. each name is fitted to the room with `fitMiddle` (`head…tail`, the tail at least half of the
   kept characters; one kept character is the head);
2. labels that are still equal get ` (1)`, ` (2)`, … (1-based among them, in row order), the name
   fitted into the room left after the suffix;
3. labels equal after that get ` (i)`, i being the draw index, until all differ.

Names are never thinned. When a name must be shortened in a room narrower than `MMMM`, or a label
does not fit or keeps no character of its name, **every** name is hidden: the band becomes 0 (or a
glyph column of 18 px when rows have states). Full names stay in the rows, the `mark` event and the
tooltip.

### `CategoryChart` and the meter

`CategoryChart` (`client/src/charts/CategoryChart.tsx`) observes its cell and fits the model at
the cell's whole-pixel size (the caller's `sizeMemo` first). It mounts a `ChartFrame` with the
fit's spec and data, or shows the `tooSmall` text in place of the plot. Under the cell, one line of
the control height holds the meter and, when names or value labels are hidden by the fit or by
the layout, a note: `Names hidden — panel too narrow`, `Values hidden — panel too narrow` or
`Names and values hidden — panel too narrow`. A resize that keeps the cap and the stage keeps the
fit object, so the frame is not given new data; a 0 × 0 cell keeps the last fit.

`CoverageMeter` (`client/src/charts/CoverageMeter.tsx`) shows `coverageText(coverage)`. When the
run or the baseline run is truncated or has warnings, the text is a ghost button (`Coverage:
<text>`) whose popover has a `This query` and/or a `Baseline (shifted window)` section, each that
run's completeness notice (its warnings, and Narrow the time range when truncated). Otherwise the
text is a status line.

## Auto-vis row 11 (VIZ-065, T22 §4.5)

`autoVis` gains row 11 after rows 5, 6 and 7 and before row 14: a `series` result with 2 to 50
distinct keys is a bar chart when it is instant with at most one sample per series, or a range
result on a panel with an explicit `options.reducer` (`reducer: true`). The row picks `barchart`
only when the caller's `available` set has it; the default, `SHIPPED_VIS` (line, bars, heatmap,
stat), does not, so boards and Explore keep their choice until Part 3 passes the board set and
`reducer`.

## Options and defaults

The panel's `vis.options` (board spec v3, [the boards API](../server/boards-api.md#visoptions-v3))
holds the reducer, `categoryBy`, `sort`, `orientation`, `valueLabels`, `min`, `max` and
`baselineOffset` of a bar chart. `barchartOptions(options)` (`client/src/boards/options.ts`) fills
the defaults: `last`, no baseline, `''` (use the effective label), `valueDesc`, `horizontal`,
value labels on, and no bounds.

## Reduce and merge (T22-003)

`reduceSeries(series, reducer)` reduces over the **finite** samples: `last` and `first` are the
last and first finite samples, `mean`, `min`, `max` and `sum` are as named, and `count` is the
number of finite samples. With no finite sample the result is NaN (`count` gives 0). An instant
result is not reduced: its sample is the value.

Series with the same key are one series (T04-004). `mergeDuplicates(series, source)` groups them
by key, in first-seen order, and combines each group with `mergeKey` (`client/src/vis/merge.ts`),
the same merge the histogram uses (T21), so both count the same conflicts:

| Source | Merge | Conflict |
|---|---|---|
| range | the finite samples joined by timestamp, ascending; the max where several share one | each timestamp shared by 2 or more samples |
| instant | each series' latest finite sample; the latest timestamp wins, the max on a tie | only a tie at that latest timestamp |

`duplicates` is the number of series combined away (Σ group size − 1). The baseline run is merged
the same way, so baselines still match by key. A scalar result is one row keyed
`0000000000000000` (`SCALAR_KEY`).

## The category label and names (T22-004, T22-005)

`effectiveLabel(series, categoryBy)` is `categoryBy` when set; otherwise the one label key
(`__name__` included) whose value varies across the rows, counting an absent key as a value. With
fewer than 2 rows, or with no key or several keys varying, there is none.

`markNames(rows, label, aggregates?)` names every row before the cap:

1. The base is the raw value of the label when it is non-empty, otherwise `seriesName(labels)`.
   A raw value that is `other`, ends in ` (<digits>)`, starts with `"` or holds a control
   character is shown as `JSON.stringify(value)` (`"other"`, `"2.31 (1)"`), so it never reads as
   an aggregate or a suffix.
2. Rows that share a base get the shortest set of label keys that sets each apart: the keys on
   which the row differs from another member are searched breadth-first, by size, each size in key
   order (all of them when more than 16 keys differ). The parts are appended with ` · `: a present
   value is quoted as `seriesName` quotes it (`region="eu"`), an absent key is `region absent`.
   For example `2.31 · region="us"`, `2.31 · region="eu"`, `2.30`.
3. Names still equal, counting the `aggregates` (such as `other (4)`), get ` (1)`, ` (2)`, … in
   key order. Aggregates are never suffixed. Keys, filters and the table are unchanged.

`filterPair(mark, label)` is the board filter a click on a bar applies (Part 3): `{ key, value }`,
or `{ reason: 'noLabel' }` / `{ reason: 'missing', label }`, whose `filterBlockText` is
`Can't filter: no category label` or `Can't filter: <label> missing on this series` (T22-007).

## Sort and cap (T22-006)

`valueDesc` and `valueAsc` put NaN last and break ties by name, then key (code-unit order);
`label` sorts by name, then key; `none` keeps the result's order.

`capMarks(sorted, cap)` draws everything that fits. Over the cap it keeps, in this order: the max
finite row and the min finite row (the first in sort order on a tie), then rows in the worst
non-OK state (by `SEVERITY`: failing, degraded, watch) up to max(1, ⌊cap / 10⌋), then further rows
in sort order. The drawn rows keep the sort order. `cap` ≤ 0 draws nothing; a cap below 2 is the
`tooSmall` notice of Part 2, whose text is `tooSmallText(all, unit)`:
`too small: 250 bars (min 1 1, max 250 250, 1 failing)`.

## The coverage meter (VIZ-027)

`categoryCoverage` records the pre-cap `total`, the `drawn` count, what the cap kept (`keptMin`,
`keptMax`, `keptWorst`), the worst state over all rows (`worstState`, null when none is non-OK)
and how many rows in it were not drawn (`omittedWorst`), the values outside a fixed range
(`outside`, from `outsideCount`), the merge counts, and the run's and the baseline run's
`Completeness` as received.

`coverageText(coverage, timeZone?)` joins the parts that apply with ` · `, in this order; with none
it reads `100 %`. Counts are en-GB grouped (`1,000`).

| Part | Text |
|---|---|
| list widgets (`unknown`) | `coverage unknown`, `tags not yet known for k board(s)`, `all k pages loaded · may have changed while loading` |
| the run | `truncated`; `limited (N warning(s))` |
| geomap counts (`geo`, #184; zeros omitted) | `k not placed`, `k ambiguous`, `locations unavailable`, `k outside the map`, `k without a usable value (a missing, b infinite, c out of range)` |
| the baseline run | `baseline truncated`, else `baseline limited (N warning(s))` |
| the cap (drawn < total) | `showing X of N`, then `; kept min, max, K <state>` (only what was kept), then `; J <state> not shown` |
| fixed bounds | `K value(s) outside the fixed range` |
| the merge | `k duplicate series combined`, then `; c conflicts (max kept)` |
| list widgets (`staleAtMs`) | `stale (HH:mm:ss)` in `timeZone` (default the browser's) |
| map area (`area`, T24-098; zeros omitted) | `k outside the map area`, `k without a location`, `map area not applied to k (locations unavailable)` |

A list widget keeps nothing, so its cap part is just `showing X of N`.

## Bounds (ADR-0022)

`resolveBounds(min, max, auto)` maps `options.min`/`max` onto the auto value range: an absent
bound takes the auto value, except that only `min` with min ≥ auto max gives max = min + span, and
only `max` with max ≤ auto min gives min = max − span (span is the auto span, or 1 when that is 0).
With auto [0, 120]: (500, absent) → [500, 620]; (absent, −10) → [−130, −10]. The server has
already refused |v| > 1e15 and min ≥ max.

## Baseline delta (T22-012)

`deltaText(v, b)` is `▲`, `▼` or `=`, a space, `formatValue(|d|)` and ` %`, with
d = (v − b) / |b| × 100 (70 against 35 → `▲ 100 %`). It is null when b is null, 0 or not finite,
or v is not finite.

## Table rows and CSV (T22-013, T24-026)

`panelRows('barchart', all, drawn, unit)` has the columns `name, value, baseline, state, drawn,
shown as`, and one row per real mark of `all`, in order. A drawn key is `yes` with its own name; a
member of a drawn aggregate is `yes` with the aggregate's name; any other row is `no` with an empty
`shown as`. Numbers are `String(v)`, and NaN or null is an empty cell.

`panelCsv(rows)` writes the header and every row, each cell through `csvCell`
(`client/src/data/csv.ts`), with CRLF line endings. `csvCell` prefixes `'` to a cell that starts
with `=`, `+`, `-`, `@`, TAB or CR, unless the whole cell is a number
(`^[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|Infinity)$`, no `m` flag) with no line terminator (LF,
CR, U+0085, U+2028, U+2029): `-6.25`, `+1`, `1e5` and `-Infinity` stay as they are, while `-1+2`
becomes `'-1+2` and `-1` followed by LF is guarded. It then quotes per RFC 4180 when the cell holds
`"`, `,`, CR or LF. `csvFileName(title)` replaces every character outside `[A-Za-z0-9_-]` with
`_` and adds `.csv` (`CPU % host` → `CPU___host.csv`; an empty title gives `panel.csv`).

## Summary facts (VIZ-068, T22-014)

`summaryFacts('barchart', title, result, all, unit, baselineCompleteness)` fills `SummaryFacts`
for the screen-reader summary (its text comes with #160):

- **focus**: among the finite marks, the worst state, else the highest value; ties go to the higher
  value, then the lower key;
- `current`: the focus mark's formatted value and name;
- `change`: the largest |Δ| between consecutive finite samples of the focus key in the merged
  result (the first on ties), with `from`, `to` and `atMs` the time of the later sample; null for
  instant and scalar results and with fewer than 2 finite samples;
- `extent`: the min and max of the finite mark values (every pre-cap mark);
- `baselineRatio`: current ÷ the focus mark's baseline, only when both are finite, the baseline is
  not 0 and the baseline run is complete (not truncated, no warnings).

With no finite mark, all four are null.

## Limits

- At most 200 bars are drawn (`validateFrameData` refuses more as `cap`); the rest are counted in
  the meter and listed in the table.
- A bar needs a 14 px band; below a cap of 2 the chart shows `tooSmall` instead.
- The name search tries at most 2^16 key subsets per row group; past 16 differing keys every
  differing key is used.
- The transforms allocate per run, not per frame.

## Tests

`client/src/vis/reduce.test.ts` (`unit:category-reduce`, `-cap`, `-tiny`, `-label`,
`-duplicates`, `-subset-names`, `-unique-names`, `-bounds`, `-summary-facts`, `-table`,
`unit:coverage-text`), `client/src/vis/merge.test.ts` (the shared merge and the histogram's
equal conflict count), `client/src/data/csv.test.ts` (`csvCell`), and
`client/src/boards/options.test.ts` (`unit:board-options`). Part 2: `client/src/vis/barchart.test.ts`
and `client/src/charts/CategoryChart.test.tsx` (`unit:barchart-plan`, `unit:barchart-fit-stages`),
`client/src/charts/CoverageMeter.test.tsx` (the meter), `client/src/vis/autovis.test.ts` (row 11)
and the boundary tests in `boards/panelRun.test.ts` and `pages/board/PanelEditorKinds.test.tsx`.
The builders `byVersion`, `many`, `threeKeys` and the `barchart-dupes` series are in
`client/src/dev/categorySynth.ts`, shared with the gallery and re-exported by
`client/src/test/categoryFixtures.ts`.

## Designs

- [T22](../../designs/technical/T22-value-categorical-and-table-panels.md): T22-003, T22-004
  (names, visible labels), T22-005, T22-006 (cap, drawn cap, `tooSmall`, meter), T22-013 (rows and
  CSV), T22-014 (facts), §4.1, §4.5 row 11, §5.1, §5.2, §6.1, §10.3.
- [ADR-0028](../../designs/adr/0028-chart-seam-bar-chart.md) (the bar chart seam, the extent and
  the layout).
- [T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md) T24-026 (`csvCell`).
- [05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md): VIZ-004,
  VIZ-005, VIZ-027, VIZ-065 (row 11), VIZ-066 (rows and CSV text), VIZ-067, VIZ-068 (facts),
  VIZ-069.
- [ADR-0022](../../designs/adr/0022-chart-thresholds-and-stat-sparkline.md) (the value range).
