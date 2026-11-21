# Explore: metrics (data and rules)

The Explore metrics page (issue #63) is built in three parts. This page documents **Part A**: the
modules that decide what the page sends and draws, without drawing it. Each rule is a pure,
table-tested function. The editor (Part B) and the page itself (Part C) extend this page when they
land.

Requirements: [SRF-030](../../designs/product/04-surfaces.md#srf-030--metrics-auto-vis-and-multiple-queries)
(auto-vis subset), [SRF-031](../../designs/product/04-surfaces.md#srf-031--metric-browser-and-series-table)
(series rows and sort), [SRF-027](../../designs/product/04-surfaces.md#srf-027--promql-editor)
(completion data), [VIZ-065](../../designs/product/05-visualisation-catalogue.md#viz-065--auto-vis-rules)
(Table 5-13 rows 5, 6, 7 and 14) and [IA-022](../../designs/product/02-information-architecture.md#ia-022--deep-links-reproduce-the-view)
(the `q`, `vis` and `rate` keys). Design rules: [T09-009](../../designs/technical/T09-query-editors.md)
(client half: sent-to-source index mapping), [T04-010](../../designs/technical/T04-wire-format-and-data-plane.md)
(the decoder seam), [T06-025](../../designs/technical/T06-bff-architecture.md) (the e2e data source
reads `Connected`); [ADR-0014](../../designs/adr/0014-typescript-react-web-client.md),
[ADR-0015](../../designs/adr/0015-go-bff.md) ("Query validation": PulsusDB validates) and
[ADR-0017](../../designs/adr/0017-react-router.md).

## Modules

| Module | What it does |
|---|---|
| `src/editor/lang/types.ts` | Types shared with the editor: `QueryShape` (the bare selector and its source slice, the metric names, `histogram_quantile`, the value type), `UNKNOWN_SHAPE`, `Diagnostic`, `QueryLanguage`, `PromSource`. No run-time imports, so the route chunk can use it without the editor chunk |
| `src/explore/plan.ts` | The run planner: `planRun`, `metricType`, `formatDuration`, `toSourceIndex`, `utf8Length`, `MAX_QUERY_BYTES` |
| `src/explore/seriesRows.ts` | The series table's rows: `seriesRows`, `sortRows`, `nextSort`, `toggleIsolation`, `TABLE_ROWS` (500, the engine's series cap) |
| `src/vis/autovis.ts` | `ExploreResult` and its adapters `fromRange`, `fromInstant`; `autoVis`, `chooseVis` |
| `src/vis/histogram.ts` | `isHistogram`, `histogramBuckets`, `isolateBucket`: Prometheus buckets as heatmap counts |
| `src/vis/framePlan.ts` | `framePlan`, `canIsolate`, `scalarSeries`, `SCALAR_KEY`: the `<ChartFrame>` spec and data for every vis and result |
| `src/state/exploreParams.ts`, `useExploreParams.ts` | The URL codec of `q`, `vis`, `rate` and its hook |
| `src/api/*`, `src/data/decode.ts` | The four `/prom/*` reads and their decoders |

## The run planner

`planRun(text, shape, meta, {rate, stepMs})` returns the request (`RunPlan`). The first matching
row wins; "bare" is `shape.bareSelector` (a top-level selector with a metric name) and `sel` its
exact source text; `w` is `formatDuration(4 × stepMs)`; "rate" means the chip is on and the step
is known:

| Condition | Sent query | Chip shown | Rate applied | Heatmap rule may apply | Kind |
|---|---|---|---|---|---|
| bare histogram bucket, rate | `sum by (le) (rate(<sel>[w]))` | yes | yes | yes | range |
| bare histogram bucket, no rate | the text | yes | no | no | range |
| bare counter, rate | `rate(<sel>[w])` | yes | yes | no | range |
| bare counter, no rate | the text | yes | no | no | range |
| otherwise | the text | no | no | a `_bucket` metric and no `histogram_quantile` | instant for a scalar or string value type, else range |

- **Metric types.** `metricType(name, meta)` reads the first metadata entry of the name, else of
  the base name without one of `_bucket`, `_count`, `_sum`, `_total`; a `_count` or `_sum` of a
  histogram or summary is a counter; a type outside counter, gauge, histogram, summary is
  `unknown`. A name is a counter when its type is `counter` or it ends in `_total`; a histogram
  bucket when it ends in `_bucket` and its type is `histogram` or `unknown`.
- **Window.** `formatDuration` writes the largest of `d`, `h`, `m`, `s` that divides the window
  (20 000 ms → `20s`, 240 000 ms → `4m`). The step is the client's mirror of the BFF grid
  (`data/step.ts`); the BFF re-grids, so only the window text depends on it.
- **Size limit.** The limit applies to the **sent** text: `bytes = utf8Length(query)` and
  `tooLong = bytes > 65 536` (the BFF's limit, #62). The rewrite adds 11 bytes (counter) or 25
  (histogram), so a source text that fits can still be refused. `utf8Length` counts a lone
  surrogate as 3 bytes, as the BFF sees it after JSON decoding. Part C sends nothing when
  `tooLong`.
- **Source index (T09-009).** A rewritten plan keeps the source slice at `sentStart` (5 for a
  counter, 18 for a histogram). `toSourceIndex(plan, i)` maps an index of the sent text back to
  the editor text, or `null` outside the slice (the error is then in the rewrite).
- **Validation.** Nothing here parses PromQL. The shape comes from Part B's analyser; PulsusDB
  validates the query ([ADR-0015](../../designs/adr/0015-go-bff.md)).

## Auto-vis (VIZ-065)

`autoVis({histogram, rateApplied, result})` applies Table 5-13 in order; the first match wins:

| Row | Condition | Vis |
|---|---|---|
| — | a string result | none |
| 5 | `histogram` and a series result whose buckets convert (`isHistogram`) | heatmap |
| 6 | `rateApplied` | line |
| 7 | a scalar, or an **instant** result of exactly one series with one point | stat |
| 14 | otherwise | line |

A range result is never a stat: the BFF puts it on the grid, so a series with one sample is a
series with gaps. `chooseVis(param, auto)` returns the URL's `vis` when it is not `auto`.

## Histogram buckets

`histogramBuckets(series)` is `null` unless every series has an `le` label (`+Inf`, `Inf` or a
finite number), all series share their timestamps and at least one bound is finite.
`isHistogram(series)` checks only these conditions, without converting; auto-vis and
`canIsolate` use it. Bounds are the
distinct `le` values, ascending. A **group** is the series with the same labels without `le`.

- Each group's cumulative value at a bound is the sum of its series with that bound; it is
  **missing** when the group has no series with that bound or any of them has a non-finite sample.
  The lower bound of the first interval is 0.
- A group's count in an interval is `max(0, upper − lower)` of its own cumulative values, missing
  when either is missing. Cumulative values of different groups are never subtracted.
- A cell is the sum of every group's count, and **missing (NaN)** when any group's count is
  missing: no partial sum. A missing sample blanks its interval and the one above; a group without
  a bound blanks the interval ending there and the one starting there. A frame whose cells are all
  NaN is still a heatmap (an empty grid).

The conversion is linear in the input and the output: each group visits only its own bounds, and
the intervals blanked by a group without a bound are set once for every timestamp.

The engine draws a NaN cell as no fill and no hover row, and skips it in the summary. When the
heatmap has more columns than CSS px, a merged pixel column is missing when any merged bucket is
missing ([Charts](charts.md#marks)).

## Frames and isolation

`framePlan(vis, result, {isolatedKey, title, rateApplied})` returns `{spec, data, notice}`. When
`data` is not null, `validateFrameData(spec, data)` is null; when it is null, Part C mounts no
`<ChartFrame>` and shows the notice. The unit is `/s` when the rate was applied, else none; on a
heatmap it is the count unit.

| Vis | Series result | Scalar result | String result |
|---|---|---|---|
| line | the series (or the isolated one) | the scalar as one point (`scalarSeries`, key `SCALAR_KEY`) | notice `string` |
| bars | as line, on one grid (below); spec `stacking: 'normal'`, `categoryLabel: ''`, `categoryOrder: []` | as line | notice `string` |
| stat | the series (or the isolated one) | the scalar | notice `string` |
| heatmap | `histogramBuckets`, or notice `noBuckets` when it is null | notice `noBuckets` | notice `string` |

**Bars grid.** Bars need every series on the same timestamps. A range result already is; the
series of an instant result can each have their own. `commonGrid(series)` then puts every series
on the sorted union of all timestamps, with NaN (a gap) where a series has no sample. Line and stat
keep each series' own timestamps.

**Isolation.** On line, bars and stat, isolating a row keeps only that series (an `le` row is its
raw cumulative series). On a heatmap, `isolateBucket(series, key)` keeps the full view's axis and
bounds and fills only that series' row with its group's term of the full view's sum; every other
cell is NaN, and a row whose group lacks the interval's lower bound has no fill. A key that is not
in the result gives the full view. `toggleIsolation(current, key)` returns `null` for the
isolated row, so a second click restores the full view. `canIsolate(vis, result)` is true for a
series result with a vis, except a heatmap whose buckets do not convert.

**Series rows.** `seriesRows(result)` gives one row per series in response order: the series name,
its colour index, the last and the largest non-NaN value (±Inf included), `null` when none; a
scalar is one row `scalar`, a string none. `sortRows` sorts by name or numerically with `null` last
in both directions, ties by name then key; `nextSort` starts `series` ascending and `last`, `max`
descending, and flips on the same column.

## URL keys (IA-022)

| Key | Read | Written |
|---|---|---|
| `q` | the first value (`+` is a space) | omitted when empty |
| `vis` | the first of the values that is `line`, `bars`, `heatmap` or `stat`; else `auto` | omitted when `auto` |
| `rate` | `off` when the first value is `off`; else `auto` | `rate=off` only |

The keys are written after the time Context, with every other key, sorted by key. The `metrics`
route's loader replaces a non-canonical search with its canonical form, so
`?vis=pie&q=up&from=now-1h&to=now&refresh=off&q=x` opens as
`?from=now-1h&to=now&refresh=off&q=up` without a new history entry. `useExploreParams()` returns
the keys and `set(partial, {replace})`, which keeps the time Context.

## API

Four `Api` methods read the #62 `/prom/*` routes of the BFF ([PulsusDB client and the PromQL
routes](../server/pulsusdb.md)); each takes the tenant, an unknown tenant is `ApiError('notFound')`
and other errors map as for `queryRange`. Responses are decoded by `data/decode.ts` (T04-010).

| Method | Route | Query |
|---|---|---|
| `promLabels(tenant, {fromMs, toMs, match?, limit?})` | `GET /api/dash/v1/prom/labels` | `tenant`, `from`, `to`, `match` repeated in order (omitted when empty), `limit` (1–10 000; the BFF's default is 1 000) |
| `promLabelValues(tenant, name, …)` | `GET /api/dash/v1/prom/label/{name}/values` | as `promLabels` |
| `promSeries(tenant, {fromMs, toMs, match: [one or more], limit?})` | `GET /api/dash/v1/prom/series` | as `promLabels`; `match` required |
| `promMetadata(tenant, {metric?, limit?})` | `GET /api/dash/v1/prom/metadata` | `tenant`, `metric`, `limit` |

The stub API serves fixed completion data: the metadata of the e2e `metadata` transcript, five
metric names, `["a","b"]` for any other label, and no series.

## Gates

| Gate | File |
|---|---|
| `unit:explore-plan` | `src/explore/plan.test.ts`: the planner rows, the sent-size boundary, metric types, durations, the source index, byte length |
| `unit:autovis-table` | `src/vis/autovis.test.ts`: one fixture per rule, rule order, range never stat, the override |
| `unit:heatmap-buckets` | `src/vis/histogram.test.ts`: complete, missing single and grouped samples, groups with differing bounds, row isolation, and a many-group, many-bound time bound |
| `unit:frame-plan` | `src/vis/framePlan.test.ts`: every vis × result valid, bars over instant series with unequal timestamps, scalar overrides, heatmap row isolation and restore |
| `unit:series-rows` | `src/explore/seriesRows.test.ts` |
| `unit:explore-params` | `src/state/exploreParams.test.ts`, with `useExploreParams.test.tsx` and the `router` explore canonical test |
| `unit:decode-frames` (prom) | `src/data/decode.test.ts` |
| `unit:columns` (merge keeps missing) | `src/engine/canvas2d/columns.test.ts` |
| `bench:frame-interim-heatmap` | `e2e/perf-heatmap-draw.spec.ts` ([Build, test and CI](../development/build-and-ci.md#tests)) |
