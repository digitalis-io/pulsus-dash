# Categorical panels: reduce, cap, names, meter, table and facts

The bar chart, the pie and the stat grid ([T22](../../designs/technical/T22-value-categorical-and-table-panels.md))
turn each series of a query result into one **mark**: a key, labels, a display name, one reduced
value, a threshold state and a baseline. Everything that is not drawing is a pure, synchronous
function of the client (`client/src/vis/reduce.ts`), so it is tested without a canvas and shared by
every renderer.

**Status (#173 Part 1).** This page documents the transforms and the seam types. No panel calls
them yet: a board panel of kind `barchart` or `pie` is stored (board spec v3) but sends no query
and shows "This chart type isn't available in this version yet."
([pending kinds](boards.md#pending-kinds)). Part 2 adds the Canvas 2D bars, `framePlan` and the
meter on screen; Part 3 the filters, selection, Inspector, keyboard and the table view.

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

- At most 200 bars are drawn; the rest are counted in the meter and listed in the table.
- The name search tries at most 2^16 key subsets per row group; past 16 differing keys every
  differing key is used.
- The transforms allocate per run, not per frame.

## Tests

`client/src/vis/reduce.test.ts` (`unit:category-reduce`, `-cap`, `-tiny`, `-label`,
`-duplicates`, `-subset-names`, `-unique-names`, `-bounds`, `-summary-facts`, `-table`,
`unit:coverage-text`), `client/src/vis/merge.test.ts` (the shared merge and the histogram's
equal conflict count), `client/src/data/csv.test.ts` (`csvCell`), and
`client/src/boards/options.test.ts` (`unit:board-options`). The fixtures `byVersion`, `many`,
`threeKeys` and the `barchart-dupes` series are in `client/src/test/categoryFixtures.ts`.

## Designs

- [T22](../../designs/technical/T22-value-categorical-and-table-panels.md): T22-003, T22-004
  (names), T22-005, T22-006 (cap and meter text), T22-013 (rows and CSV), T22-014 (facts), §5.1,
  §5.2, §6.1, §10.3.
- [T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md) T24-026 (`csvCell`).
- [05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md): VIZ-005,
  VIZ-027, VIZ-066 (rows and CSV text), VIZ-068 (facts).
- [ADR-0022](../../designs/adr/0022-chart-thresholds-and-stat-sparkline.md) (the value range).
