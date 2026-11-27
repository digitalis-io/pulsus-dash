# Categorical panels: reduce, cap, names, meter, table and facts

The bar chart, the pie and the stat grid ([T22](../../designs/technical/T22-value-categorical-and-table-panels.md))
turn each series of a query result into one **mark**: a key, labels, a display name, one reduced
value, a threshold state and a baseline. Everything that is not drawing is a pure, synchronous
function of the client (`client/src/vis/reduce.ts`), so it is tested without a canvas and shared by
every renderer.

**Status (#173 Part 3b).** The transforms, the bar chart's model and fit (`client/src/vis/barchart.ts`),
the Canvas 2D bars ([charts](charts.md#bar-chart-adr-0028)), `CategoryChart`, the coverage meter
and the interactions (Part 3a: the keys and the brush, `barAction`, the tooltip lines, the table
view `PanelTable`, the `tooSmall` notice and the baseline helpers) are in place. Part 3b opens the
bar chart on boards ([bar chart panels](boards.md#bar-chart-panels-173-part-3b)) and on Explore
([`vis=barchart`](explore.md#the-bar-chart-visbarchart-173-part-3b)), and runs the baseline. A pie
panel is stored (board spec v3) but sends no query and shows "This chart type isn't available in
this version yet."

## The panel view (`boards/panelRun.ts`)

A saved bar chart is a **`category` view**: `{kind: 'category', model, baselineFailed, lang}`
(`categoryView(result, {title, rateApplied, panelVis, lang, baseline})`). Its model is
`barchartModel(result, {title, rateApplied, options: panelVis.options, thresholds:
panelVis.thresholds ?? null, base})`, with `base` the baseline result when the run has one, and
`baselineFailed` true when the baseline run failed. The cache key is every model input: the result
and the baseline (object identity, `WeakMap`s), then
`JSON.stringify([title, rateApplied, options ?? null, thresholds ?? null])`; nothing else is read
(no theme, no size). The view's `data-panel-state` is `frame` and its `data-panel-vis` `barchart`.

**Auto-vis by surface.** A board `auto` panel calls `autoVis` with the default set
(`SHIPPED_VIS`), on the stored spec and on the editor's draft, so it never becomes a `category`
view; Explore passes `EXPLORE_VIS` (`SHIPPED_VIS` ∪ {barchart}) and row 11 can fire there
(T22 §4.5).

**The key's `baselineMs`.** The panel run key is
`['data', 'panel', tenant, id, text, vars, kind, stepMs, fromMs, toMs, baselineMs]` (11 elements;
`PANEL_KEY_HEAD` stays 7). `baselineMs` is `OFFSET_MS[baselineOffset(vis.options, ghost)]` for a
bar chart and null otherwise, so a ghost toggle or an offset edit is a new key whose placeholder is
the previous outcome. The outcome's `baseline` is the shifted result, `'failed'`, or absent (no
baseline run).

**The linked cancellation.** With a `baselineMs`, `usePromPanelRun`'s query function makes one
`AbortController` for the run, aborted when the query's signal aborts; the main request and the
shifted one both use its signal. The main request's failure aborts the run (so the baseline stops)
and rejects with its own error; the baseline's failure resolves `'failed'`, never failing the
panel. `Promise.all` therefore settles with the main request's error first, and a baseline that
settles after the run aborted resolves an unread promise. See
[Boards › The baseline run](boards.md#the-baseline-run).

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
`anomaly` off: `CategoryChart` sets them on the spec, with no refit), and calls
`categoryRows(result, base, { reducer, categoryBy, sort, thresholds })`. `base` is the optional
baseline run's result (`barchartModel(…, { …, base })`, Part 3a): each row's `baseline` is the base
run's reduced value for the same key (null when the key is absent; duplicates keep the max), and
the model's `baseline` is the base run's completeness (null without one). The model keeps every
sorted row (`all`), the label, the merge counts, the run's completeness, `options.min`/`max`, and
the input result for `summaryFacts`.

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
text is a status line. `onNarrow` is optional (#216 Part 2a): without it a truncated run's notice
has no Narrow (a Board list that is not a search); with it, Narrow acts and then closes the popover.
`timeZone` (default the browser's) sets the zone of a list's `stale (HH:mm:ss)`.

## Auto-vis row 11 (VIZ-065, T22 §4.5)

`autoVis` gains row 11 after rows 5, 6 and 7 and before row 14: a `series` result with 2 to 50
distinct keys is a bar chart when it is instant with at most one sample per series, or a range
result on a panel with an explicit `options.reducer` (`reducer: true`). The row picks `barchart`
only when the caller's `available` set has it; the default, `SHIPPED_VIS` (line, bars, heatmap,
stat), does not, so boards keep their choice (T22 §4.5, owner). Explore passes `EXPLORE_VIS`
(Part 3b), which has it.

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

## Interactions (#173 Part 3a)

### The pick decision (`vis/barAction.ts`)

`barAction(pick, context)` turns an engine `pick` into what a surface does; `context` is
`{ model, surface: 'board' | 'explore', filters, origin, window }`, `origin` the Inspector origin
without its window and `window` the window the rows were reduced over.

| `pick` | Action |
|---|---|
| `keys` `[]` | `clear`: the selection is cleared |
| `gesture: 'brush'` | `brush` with the selection `{ keys, fromMs: null, toMs: null }` |
| a click on a key not in `model.all` | `none` |
| any other click | `click`: the Inspector `mark` target (the row, its members, `model.spec.unit`, the window, the panel and query of `origin`), `selection = selectionOf(target)` (the row's key, or its members' keys for an aggregate), and `filter` |

`filter` is set only on a board with a filter pair `filterPair(row, model.label)` = {k, v}: `{ key:
k, value: null }` (remove) when the board's filters already hold {k, v}, else `{ key: k, value: v }`.
Without a pair, and on Explore, it is null. `barHint(row, { model, surface })` says why a click
does not filter: on Explore `Filters apply on boards`; on a board without a pair `Can't filter: no
category label` or `Can't filter: <label> missing on this series`; else null. The board panel and
Explore apply the action (Part 3b; [Boards](boards.md#the-panel-body),
[Explore](explore.md#the-bar-chart-visbarchart-173-part-3b)).

### Tooltip lines

`CategoryChart` gives `ChartFrame` a `markLines(row)` function; `MarkTooltip` shows its lines, each
a `data-line`, after the name, value and state. In order: with the ghost on, `baseline <v>` for a
finite baseline, or in its place `baseline truncated` or `baseline limited (N warnings)` when the
baseline run is incomplete (T22-006); `barHint(row)` when a `context` is given and the hint is not
null; `Values are reduced over <from> – <to>` (hours and minutes in the page zone; a bar chart has
no crosshair, T22-011); and, with anomaly on and no score on the row, `No anomaly scores for this
query`.

### `CategoryChart` props

Besides the model, title, `onNarrow` and `sizeMemo`: `onPick(pick, returnFocus)` (the listbox is
the focus to return to; a table row's name button picks its row as a click), `context` (for the
tooltip's filter hint), `ghost` and `anomaly` (default false; set on the spec), `table` and
`onTable` (default false and absent; the caller keeps the flag), and `baselineFailed`, which adds
the note `Baseline unavailable: the shifted query failed.` to the line under the cell.

- **Shift+T** anywhere in the chart, with no Ctrl, Meta or Alt and not in an input, textarea,
  select or editable element, calls `onTable(!table)` and is prevented. Without `onTable` nothing
  happens and the key is not prevented.
- **The `tooSmall` notice** is a focusable `role="group"` named `<title>: panel too small — press
  Shift+T for the table`, showing the `tooSmall` text, so Shift+T works from it.
- **The table view:** with `table` on, the cell keeps its size and holds `PanelTable` over
  `fit.rows` instead of the frame or the notice; the meter stays. Opening focuses the grid; closing
  focuses the listbox when a frame is mounted, else the notice.

The gallery keeps one table flag per bar chart.

### The table view (`charts/PanelTable.tsx`, T22-013)

`PanelTable({ rows, title, caption?, closeLabel?, emptyText?, selected, onRow?, onClose })` is a
read-only grid over a `TableView` (`vis/reduce.ts`, re-exported here; #216 Part 2a):
`{columns, rows: {key, drawn, cells}[]}`. A bar chart's `PanelRows` is one (each row also has its
`mark`, whose key is the row's `key`); so is a list widget's table
([Board list](widgets.md#the-board-list-view-part-2a)).

- **Bar:** the caption (`caption`, default `<n> rows · <d> drawn`), then the kit buttons `Export
  CSV` and the way back (`closeLabel`, default `Show chart (Shift+T)`; `onClose`).
- **Null rows:** `rows: null` (a list with nothing to show yet) shows `emptyText` as a
  `role="status"` paragraph instead of the grid, and Export is disabled.
- **Grid:** `role="grid"`, named by the title, `aria-rowcount` n + 1, `aria-colcount` the column
  count, one tab stop, a sticky header row of the columns.
- **Rows:** virtualised (`useVirtualizer`, 28 px rows (`--size-table-row`), overscan 10). Each row
  is `role="row"` with the id `<tableId>-r<i>`, `aria-rowindex` i + 2, `data-row-key`,
  `data-drawn` (`yes` or `no`) and `aria-selected` (its key in `selected`); one `gridcell` per
  cell, the cells as `panelRows` wrote them. With `onRow`, the name cell is a button whose click
  calls `onRow(key, 'keyboard' for a keyboard click (detail 0) else 'pointer', button)`.
- **Keys on the grid** (only when the grid itself has focus; a name button keeps its own Enter and
  Space): the active row starts empty; the first arrow, Home or End sets it; ↑/↓, Home/End and
  PageUp/PageDown (⌊viewport / 28⌋ rows) move it, each scrolling it into view; Enter calls
  `onRow(key, 'keyboard', grid)`. `aria-activedescendant` names the active row; the range
  extractor keeps that row mounted at its own position when it is scrolled away. New `rows` clear
  it.
- **Export:** a `text/csv;charset=utf-8` Blob of `panelCsv(rows)` (any `TableView`) through an object URL and a
  detached `<a download="csvFileName(title)">`; the URL is revoked on the next task. An empty table
  reads `0 rows · 0 drawn` and exports the header.

### Baseline helpers (`boards/baseline.ts`, T22-012)

`baselineOffset(options, ghost)` is `options.baselineOffset`, else `1d` with the ghost on, else
null (no baseline run). `OFFSET_MS` holds 1 h, 1 d, 7 d and 28 d in ms; `shiftWindow(w, offset)`
moves both ends of the window back by it. Part 3b runs the shifted query (`usePanelRun`, above).

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

## Range data: JSON or DSF (#68 Part D2)

Every panel's range query goes through `HttpApi.queryRange`, and its answer is always the same
`RangeResult` (`data/decode.ts`). Only the transport differs.

| The page | Request | Decode |
|---|---|---|
| no range decoder (ST, Canvas 2D, before the first engine boot) | JSON, unchanged | `decodeRange` in TS |
| an MT engine booted | `Accept: application/vnd.pulsus.dash-stream;v=1, application/json;q=0.1` | the body goes unparsed to the engine, decoded on the pool (see [engine](engine.md#range-data-as-dsf-part-d2)) |

With a decoder:

| Answer | Behaviour |
|---|---|
| status ≠ 200 | the envelope's `ApiError` (`api/queryError.ts`), as before |
| 200 JSON (a BFF that does not serve DSF) | the JSON decode |
| 200 DSF, decoded | `rangeFromDecoded`, then the series array is registered against the engine's chunk |
| 200 DSF, an `error/1` row | `errorFromRow` |
| declined: `limit`, `ids`, `busy`, `gone` | the reader is cancelled and the request is sent once more, as JSON |
| `invalid` (a malformed body, T04-010), or a missing or invalid `dash.planned` | `ApiError('internal')`, shown by `errorView`'s generic text ("The query failed: …"), and the mark `rum:wire_invalid` `{route, message}`; no retry |
| abort | the reader is cancelled, the engine's decode aborted, and the promise rejects with the abort |

**`rangeFromDecoded(m, receivedAtMs)`** (`data/dsfRange.ts`) builds the result from the worker's
message:

| `RangeResult` field | From |
|---|---|
| `startMs`, `endMs`, `stepMs` | the head |
| `series[i]` | the head's key and labels; `timestamps` is the one shared `ts` (the same object for every series), `values` is `vs[i]` over the full grid (absent points NaN) |
| `planned` | `decodePlanned(JSON.parse(head.planned), '/planned')`, the JSON path's own validator; only this few-hundred-byte object is parsed on main |
| `completeness` | the final `coverage/1` row: `truncated`; `warnings` (plus the truncation reason when the writer truncated, for example `wire_limit`); `infos`; `queryId` = `upstream_query_ids[0]`; `readCache` from codes 0–3; `readCacheThroughMs` = `read_cache_through`; `dataAgeMs` = receipt time − `data_end`, at least 0 (null without `data_end`) |

**`errorFromRow(row, coverage, planned)`** rebuilds the envelope the BFF gives the same class before
the header and passes it to the JSON path's `queryError`, so both paths expose the same kind,
message, fields, position, action, query id and planned query. The query id comes from the
coverage's `upstream_query_ids[0]`, and `hint.reason` is not carried (no client code reads it). A
`virtual_unsupported` refusal never reaches a stream: the guard raises it before any request.

| `error/1` code | Envelope |
|---|---|
| 0 bad_query | `invalid`, field `/query` (`query.invalid`), `hint.position.offset` from the row |
| 1 too_broad | `too_broad`, `hint.action: 'narrow'` |
| 3 forbidden_scope | `scope_denied` |
| 4 upstream_unavailable | `unavailable` (the row's 502 or 503) |
| 5 timeout | `unavailable`, `hint.action: 'narrow'` |
| 7 rate_limited | `budget_exhausted` |
| 8 internal | `internal` |

The tests are `client/src/data/dsfRange.test.ts` (every D1 route fixture's decoded message,
`engine/fixtures/range-decoded/`, against the JSON body of the same request) and the `query range
dsf` cases of `client/src/api/HttpApi.test.ts`.

## Limits

- At most 200 bars are drawn (`validateFrameData` refuses more as `cap`); the rest are counted in
  the meter and listed in the table.
- A bar needs a 14 px band; below a cap of 2 the chart shows `tooSmall` instead.
- The name search tries at most 2^16 key subsets per row group; past 16 differing keys every
  differing key is used.
- The transforms allocate per run, not per frame.
- The table view formats nothing: its cells are the raw `panelRows` strings.

## Tests

`client/src/vis/reduce.test.ts` (`unit:category-reduce`, `-cap`, `-tiny`, `-label`,
`-duplicates`, `-subset-names`, `-unique-names`, `-bounds`, `-summary-facts`, `-table`,
`unit:coverage-text`), `client/src/vis/merge.test.ts` (the shared merge and the histogram's
equal conflict count), `client/src/data/csv.test.ts` (`csvCell`), and
`client/src/boards/options.test.ts` (`unit:board-options`). Part 2: `client/src/vis/barchart.test.ts`
and `client/src/charts/CategoryChart.test.tsx` (`unit:barchart-plan`, `unit:barchart-fit-stages`),
`client/src/charts/CoverageMeter.test.tsx` (the meter), `client/src/vis/autovis.test.ts` (row 11)
and the boundary tests in `boards/panelRun.test.ts` and `pages/board/PanelEditorKinds.test.tsx`.
Part 3a: `client/src/vis/barAction.test.ts` (`unit:bar-action`),
`client/src/charts/MarkTooltip.test.tsx` (`unit:mark-tooltip`), `client/src/charts/PanelTable.test.tsx`
(`unit:panel-table`, `-active`, `-button`), `client/src/charts/CategoryChart.test.tsx`
(`unit:category-chart-table`, `unit:category-tiny` (table)), `client/src/dev/GalleryPage.test.tsx`
and `client/src/boards/baseline.test.ts` (`unit:baseline-window`).
Part 3b: `client/src/boards/panelRun.test.ts` (`unit:panel-view-category`, the model cache, the
surfaces case of `unit:autovis-table`, the 11-element key), `client/src/boards/boardRun.test.tsx`
(`unit:panel-run-baseline`, `unit:panel-run-cancel`), `client/src/pages/board/BoardPanelsBars.test.tsx`
(the board and full-screen actions, the `unit:category-duplicates` selection),
`BoardPanelsMenu.test.tsx` (the toggles), `PanelEditorKinds.test.tsx` (the editor),
`BoardPage.test.tsx` (a stored `auto` panel stays a line), `pages/explore/ResultCard.test.tsx` and
`MetricsPage.test.tsx` (Explore), and the e2e spec `e2e/panels-categorical.spec.ts`
([Build and CI](../development/build-and-ci.md)).
The builders `byVersion`, `many`, `threeKeys` and the `barchart-dupes` series are in
`client/src/dev/categorySynth.ts`, shared with the gallery and re-exported by
`client/src/test/categoryFixtures.ts`.

## Designs

- [T22](../../designs/technical/T22-value-categorical-and-table-panels.md): T22-003, T22-004
  (names, visible labels), T22-005, T22-006 (cap, drawn cap, `tooSmall`, meter), T22-007 (the
  filter decision), T22-011 (tooltip lines), T22-012 (the baseline window and run), T22-013 (rows,
  CSV and the table view), T22-014 (facts), §4.1, §4.2, §4.3, §4.5 row 11 (by surface), §5.1,
  §5.2, §6.1, §10.3.
- [ADR-0029](../../designs/adr/0029-bar-chart-keys-and-brush.md) (the keys and the brush).
- [T25](../../designs/technical/T25-inspector-and-pivots.md) T25-002 (the `mark` target).
- [ADR-0028](../../designs/adr/0028-chart-seam-bar-chart.md) (the bar chart seam, the extent and
  the layout).
- [T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md) T24-026 (`csvCell`).
- [05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md): VIZ-004,
  VIZ-005, VIZ-027, VIZ-065 (row 11), VIZ-066 (rows and CSV text), VIZ-067, VIZ-068 (facts),
  VIZ-069.
- [ADR-0022](../../designs/adr/0022-chart-thresholds-and-stat-sparkline.md) (the value range).
- Range data as DSF: [ADR-0034](../../designs/adr/0034-grid-part-joined-into-one-chunk.md),
  [T04](../../designs/technical/T04-wire-format-and-data-plane.md) §5.2, T04-010, T04-012,
  [T03](../../designs/technical/T03-browser-runtime.md) T03-003.
