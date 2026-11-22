# Explore: metrics (data and rules)

The Explore metrics page (issue #63) is built in three parts. This page documents **Part A**, the
modules that decide what the page sends and draws, without drawing it (each rule is a pure,
table-tested function), and **Part B**, the PromQL editor chunk: a library the page loads lazily
([Editor chunk](#editor-chunk)). The page itself (Part C) extends this page when it lands.

Requirements: [SRF-030](../../designs/product/04-surfaces.md#srf-030--metrics-auto-vis-and-multiple-queries)
(auto-vis subset), [SRF-031](../../designs/product/04-surfaces.md#srf-031--metric-browser-and-series-table)
(series rows and sort), [SRF-027](../../designs/product/04-surfaces.md#srf-027--promql-editor)
(completion data), [VIZ-065](../../designs/product/05-visualisation-catalogue.md#viz-065--auto-vis-rules)
(Table 5-13 rows 5, 6, 7 and 14) and [IA-022](../../designs/product/02-information-architecture.md#ia-022--deep-links-reproduce-the-view)
(the `q`, `vis` and `rate` keys); for the editor, SRF-027 (highlighting, completion, the run error
underlined) and [INT-032](../../designs/product/03-interaction-model.md#int-032--window-step-and-zoom-keys)
(window keys are not taken from the editor). Design rules: [T09-009](../../designs/technical/T09-query-editors.md)
(client half: sent-to-source index mapping), [T04-010](../../designs/technical/T04-wire-format-and-data-plane.md)
(the decoder seam), [T06-025](../../designs/technical/T06-bff-architecture.md) (the e2e data source
reads `Connected`); [ADR-0014](../../designs/adr/0014-typescript-react-web-client.md),
[ADR-0015](../../designs/adr/0015-go-bff.md) ("Query validation": PulsusDB validates),
[ADR-0017](../../designs/adr/0017-react-router.md) and
[ADR-0018](../../designs/adr/0018-query-language-modules.md) (one `QueryLanguage` per language).

## Modules

| Module                                              | What it does                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/editor/lang/types.ts`                          | Types shared with the editor: `QueryShape` (the bare selector and its source slice, the metric names, `histogram_quantile`, the value type), `UNKNOWN_SHAPE`, `Diagnostic`, `LangId`, `LanguageDeps`, `QueryLanguage` (T09 §5.1), `PromSource`. No run-time imports, so the route chunk can use it without the editor chunk |
| `src/explore/plan.ts`                               | The run planner: `planRun`, `metricType`, `formatDuration`, `toSourceIndex`, `utf8Length`, `MAX_QUERY_BYTES`                                                                                                                                                                                                                |
| `src/explore/seriesRows.ts`                         | The series table's rows: `seriesRows`, `sortRows`, `nextSort`, `toggleIsolation`, `TABLE_ROWS` (500, the engine's series cap)                                                                                                                                                                                               |
| `src/vis/autovis.ts`                                | `ExploreResult` and its adapters `fromRange`, `fromInstant`; `autoVis`, `chooseVis`                                                                                                                                                                                                                                         |
| `src/vis/histogram.ts`                              | `isHistogram`, `histogramBuckets`, `isolateBucket`: Prometheus buckets as heatmap counts                                                                                                                                                                                                                                    |
| `src/vis/framePlan.ts`                              | `framePlan`, `canIsolate`, `scalarSeries`, `SCALAR_KEY`: the `<ChartFrame>` spec and data for every vis and result                                                                                                                                                                                                          |
| `src/state/exploreParams.ts`, `useExploreParams.ts` | The URL codec of `q`, `vis`, `rate` and its hook                                                                                                                                                                                                                                                                            |
| `src/api/*`, `src/data/decode.ts`                   | The four `/prom/*` reads and their decoders                                                                                                                                                                                                                                                                                 |

## The run planner

`planRun(text, shape, meta, {rate, stepMs})` returns the request (`RunPlan`). The first matching
row wins; "bare" is `shape.bareSelector` (a top-level selector with a metric name) and `sel` its
exact source text; `w` is `formatDuration(rateWindowMs(stepMs))` (below); "rate" means the chip is
on and the step is known:

| Condition                      | Sent query                     | Chip shown | Rate applied | Heatmap rule may apply                         | Kind                                                  |
| ------------------------------ | ------------------------------ | ---------- | ------------ | ---------------------------------------------- | ----------------------------------------------------- |
| bare histogram bucket, rate    | `sum by (le) (rate(<sel>[w]))` | yes        | yes          | yes                                            | range                                                 |
| bare histogram bucket, no rate | the text                       | yes        | no           | no                                             | range                                                 |
| bare counter, rate             | `rate(<sel>[w])`               | yes        | yes          | no                                             | range                                                 |
| bare counter, no rate          | the text                       | yes        | no           | no                                             | range                                                 |
| otherwise                      | the text                       | no         | no           | a `_bucket` metric and no `histogram_quantile` | instant for a scalar or string value type, else range |

- **Metric types.** `metricType(name, meta)` reads the first metadata entry of the name, else of
  the base name without one of `_bucket`, `_count`, `_sum`, `_total`; a `_count` or `_sum` of a
  histogram or summary is a counter; a type outside counter, gauge, histogram, summary is
  `unknown`. A name is a counter when its type is `counter` or it ends in `_total`; a histogram
  bucket when it ends in `_bucket` and its type is `histogram` or `unknown`.
- **Window.** `rateWindowMs(step) = max(4 × step, step + S, 4 × S)`, with `S` =
  `DEFAULT_SCRAPE_S` = 15 s, the scrape interval assumed for every target until a per-binding
  value exists. The window therefore never holds fewer than four scrapes: at a step of 15 s or
  less it is `1m` (a 1 h range at 1 200 px has a 5 s step and gets `1m`, not `20s`, which would be
  gappy at a 15 s scrape and empty at 30–60 s); above that it is 4 × step (30 s → `2m`). The
  `step + S` term never sets the window on its own while the `4 × step` term is present (it is
  below 4 × step for a step of S/3 or more, and below 4 × S under it); it is kept so the formula
  matches the reference client's once `S` is per binding. `formatDuration` writes the largest of
  `d`, `h`, `m`, `s` that divides the window (60 000 ms → `1m`, 240 000 ms → `4m`). The step is
  the client's mirror of the BFF grid (`data/step.ts`); the BFF re-grids, so only the window text
  depends on it.
- **Deviation from the posted plan: rate window floor from the reference client behaviour.**
  Plan #63 §3.3 wrote the window as `4 × step`. The study of the clients PulsusDB was tested with
  found that window too short at small steps; the floor of `max(step + S, 4 × S)` is that
  client's. Both rewrites (counter and histogram) use it.
- **Size limit.** The limit applies to the **sent** text: `bytes = utf8Length(query)` and
  `tooLong = bytes > 65 536` (the BFF's limit, #62). The rewrite adds 8 bytes plus the window text
  (counter) or 22 plus it (histogram): 10 or 24 at `1m`, so a source text that fits can still be
  refused. `utf8Length` counts a lone
  surrogate as 3 bytes, as the BFF sees it after JSON decoding. Part C sends nothing when
  `tooLong`.
- **Source index (T09-009).** A rewritten plan keeps the source slice at `sentStart` (5 for a
  counter, 18 for a histogram). `toSourceIndex(plan, i)` maps an index of the sent text back to
  the editor text, or `null` outside the slice (the error is then in the rewrite).
- **Validation.** Nothing here parses PromQL. The shape comes from Part B's analyser; PulsusDB
  validates the query ([ADR-0015](../../designs/adr/0015-go-bff.md)).

## Auto-vis (VIZ-065)

`autoVis({histogram, rateApplied, result})` applies Table 5-13 in order; the first match wins:

| Row | Condition                                                               | Vis     |
| --- | ----------------------------------------------------------------------- | ------- |
| —   | a string result                                                         | none    |
| 5   | `histogram` and a series result whose buckets convert (`isHistogram`)   | heatmap |
| 6   | `rateApplied`                                                           | line    |
| 7   | a scalar, or an **instant** result of exactly one series with one point | stat    |
| 14  | otherwise                                                               | line    |

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

| Vis     | Series result                                                                                                                                               | Scalar result                                              | String result   |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------- |
| line    | the series (or the isolated one)                                                                                                                            | the scalar as one point (`scalarSeries`, key `SCALAR_KEY`) | notice `string` |
| bars    | as line, on one grid (below), or notice `tooManyTimestamps` when the grid is too large; spec `stacking: 'normal'`, `categoryLabel: ''`, `categoryOrder: []` | as line                                                    | notice `string` |
| stat    | the series (or the isolated one)                                                                                                                            | the scalar                                                 | notice `string` |
| heatmap | `histogramBuckets`, or notice `noBuckets` when it is null                                                                                                   | notice `noBuckets`                                         | notice `string` |

**Bars grid.** Bars need every series on the same timestamps. A range result already is; the
series of an instant result can each have their own. `commonGrid(series)` then puts every series
on the sorted union of all timestamps, with NaN (a gap) where a series has no sample. Line and stat
keep each series' own timestamps.

The grid holds one value per series and distinct timestamp, so disjoint timestamps multiply: 500
series of 1 000 disjoint timestamps would need 250 million values. `commonGrid` counts the distinct
timestamps first and returns `null`, allocating no grid, when series × distinct timestamps passes
`MAX_GRID_CELLS` (500 series × 11 000 steps = 5 500 000, about 44 MB). `framePlan` then returns
notice `tooManyTimestamps` with the bars spec: no series is dropped silently, and line still draws
every series on its own timestamps.

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

| Key    | Read                                                                             | Written             |
| ------ | -------------------------------------------------------------------------------- | ------------------- |
| `q`    | the first value (`+` is a space)                                                 | omitted when empty  |
| `vis`  | the first of the values that is `line`, `bars`, `heatmap` or `stat`; else `auto` | omitted when `auto` |
| `rate` | `off` when the first value is `off`; else `auto`                                 | `rate=off` only     |

The keys are written after the time Context, with every other key, sorted by key. The `metrics`
route's loader replaces a non-canonical search with its canonical form, so
`?vis=pie&q=up&from=now-1h&to=now&refresh=off&q=x` opens as
`?from=now-1h&to=now&refresh=off&q=up` without a new history entry. `useExploreParams()` returns
the keys and `set(partial, {replace})`, which keeps the time Context.

## API

Four `Api` methods read the #62 `/prom/*` routes of the BFF ([PulsusDB client and the PromQL
routes](../server/pulsusdb.md)); each takes the tenant, an unknown tenant is `ApiError('notFound')`
and other errors map as for `queryRange`. Responses are decoded by `data/decode.ts` (T04-010).

| Method                                                             | Route                                       | Query                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `promLabels(tenant, {fromMs, toMs, match?, limit?})`               | `GET /api/dash/v1/prom/labels`              | `tenant`, `from`, `to`, `match` repeated in order (omitted when empty), `limit` (1–10 000; the BFF's default is 1 000) |
| `promLabelValues(tenant, name, …)`                                 | `GET /api/dash/v1/prom/label/{name}/values` | as `promLabels`                                                                                                        |
| `promSeries(tenant, {fromMs, toMs, match: [one or more], limit?})` | `GET /api/dash/v1/prom/series`              | as `promLabels`; `match` required                                                                                      |
| `promMetadata(tenant, {metric?, limit?})`                          | `GET /api/dash/v1/prom/metadata`            | `tenant`, `metric`, `limit`                                                                                            |

The stub API serves fixed completion data: the metadata of the e2e `metadata` transcript, five
metric names, `["a","b"]` for any other label, and no series.

## Editor chunk

The PromQL editor (Part B) is CodeMirror 6 with the Lezer PromQL grammar of
`@prometheus-io/codemirror-promql` and `@prometheus-io/lezer-promql` (pinned versions in
[JavaScript supply chain](supply-chain.md#query-editor)). It is a library: nothing in Part B imports
it from a page, so the build emits no editor chunk yet. Part C loads it with a dynamic import of
`src/editor/editor.ts`, which exports `PromQLEditor`, `promql` and `createPromSource`.

### Modules

| Module                                 | What it does                                                                                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/editor/editor.ts`                 | The chunk entry, the only module a page imports from the chunk                                                                                                                                                                                 |
| `src/editor/lang/index.ts`             | `LANGUAGES`: a static table from `LangId` to a lazy import of the language's `QueryLanguage` (ADR-0018). PromQL resolves `lang/promql/promql.ts`; `logql`, `traceql` and `profile` reject with `LanguageUnavailableError` until they are built |
| `src/editor/lang/promql/promql.ts`     | `promql: QueryLanguage`: `shape` (`analysePromQL`), `diagnosticsOf`, `utf8ToIndex`, `editor(deps)` and `detect`                                                                                                                                |
| `src/editor/lang/promql/extensions.ts` | `promqlExtensions(source)`: the Lezer PromQL language (its completion and linter off), the highlight style, and the completion source as `autocomplete` language data                                                                          |
| `src/editor/lang/promql/promSource.ts` | `createPromSource(deps)`: the completion lookups over `Api.prom*` and the suggest cache                                                                                                                                                        |
| `src/editor/lang/promql/promClient.ts` | `matcherContextAt`, `selectorOf`, `decodeLabelName`, `toPrometheusClient`, `promqlCompleteStrategy`: the package's completion over a `PromSource`                                                                                              |
| `src/editor/suggestCache.ts`           | `SuggestCache`, `suggestKey`, `windowBucket`, `suggestCache` (the module instance)                                                                                                                                                             |
| `src/editor/completionGuard.ts`        | `completionGuard()`, `overLimitField`: no completion while an IME composes or above 128 KB                                                                                                                                                     |
| `src/editor/view.ts`                   | `createPromQLView`, `setDocument`, `insertAtSelection`, `showDiagnostics`                                                                                                                                                                      |
| `src/editor/theme.ts`                  | `promqlTheme`, `promqlHighlight` (tokens only)                                                                                                                                                                                                 |
| `src/editor/PromQLEditor.tsx`          | The React host                                                                                                                                                                                                                                 |
| `src/explore/promMetadata.ts`          | `promMetadataQuery(api, tenant)`: the page's metric-metadata query, also read by completion. No editor import, so the page can use it before the chunk loads                                                                                   |
| `src/explore/querySize.ts`             | `QUERY_BYTE_LIMIT` (131 072), `queryBytes`, `overQueryLimit` (T09-015)                                                                                                                                                                         |

Each language lives in `src/editor/lang/<id>/` and implements `QueryLanguage` (T09 §5.1). No
language directory imports another: ESLint `no-restricted-imports` fails a file in
`src/editor/lang/<id>/` that imports from another language's directory. Shared code
(`suggestCache.ts`, `completionGuard.ts`, `theme.ts`, `lang/types.ts`) lives outside them.

### `QueryLanguage` (ADR-0018)

| Member                                       | PromQL                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lang`                                       | `'promql'`                                                                                                                                                                                                                                                                                                                                       |
| `editor(deps: LanguageDeps)`                 | `promqlExtensions(createPromSource(deps))`. `LanguageDeps` is `{api, queryClient, tenant, window, cache?}`: the BFF client, the TanStack client, the tenant (the suggest-cache key, T09-014; there is no `scope_fp` while data scopes are deferred, D12), the window shown now (read on each lookup) and the cache (default the module instance) |
| `shape(text)`                                | `analysePromQL` ([below](#shape-analyser))                                                                                                                                                                                                                                                                                                       |
| `diagnosticsOf(text, error, toSource, sent)` | [Run diagnostics](#run-diagnostics)                                                                                                                                                                                                                                                                                                              |
| `detect(prefix)`                             | `0` (no claim): ⌘K query detection (INT-038) is not built yet                                                                                                                                                                                                                                                                                    |

### Host, shadow root and CSP

`PromQLEditor` renders an empty `<div data-editor-host>` (with `className`). Its mount effect
creates an inner `<div>`, attaches an **open shadow root** to it, and mounts the view there; the
cleanup destroys the view and removes the inner host. Because the inner host is created inside the
effect, StrictMode's second run attaches to a new element. In a shadow root, CodeMirror's style
modules (`style-mod` 4.1.4) are adopted as constructed stylesheets, which the CSP
`style-src 'self'` allows; mounted in the document they would append a `<style>` element, which it
blocks. CodeMirror sets inline styles only through CSSOM, and none of the 17 packages assigns
`innerHTML`, calls `insertAdjacentHTML`, `eval` or `new Function`, so Trusted Types has no sink to
block. Custom properties inherit into the shadow tree, so the theme follows `data-theme`.

| Prop                    | Behaviour                                                                 |
| ----------------------- | ------------------------------------------------------------------------- |
| `value`                 | When it changes and differs from the document, `setDocument` replaces it  |
| `onChange(text)`        | Every change, typed or programmatic                                       |
| `onRun()`, `onEscape()` | The run keys; Escape when no completion popup is open                     |
| `source: PromSource`    | Read at each lookup: a new source takes effect at once                    |
| `diagnostics`           | Shown when the array identity changes                                     |
| `label`, `placeholder`  | Read at mount (`aria-label` on `.cm-content`, which has `role="textbox"`) |
| `ref`                   | `{focus(), insert(text)}`, no-ops before mount                            |

`setDocument` and `insertAtSelection` are each one undo event in the same history as typing
(T09-006): `setDocument` puts the caret at the end, `insertAtSelection` after the inserted text.
Neither moves focus. `showDiagnostics` shows run diagnostics with severity `error`, clamped to the
document; `[]` clears them.

### Keys (T09-004)

| Key                                        | Action                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Shift+Enter, Ctrl+Enter (⌘+Enter on a Mac) | `onRun`                                                                                                                      |
| Enter                                      | A newline, or accepts the selected completion while the popup is open                                                        |
| Escape                                     | Closes the completion popup if one is open; otherwise `onEscape`                                                             |
| Tab                                        | Accepts the selected completion while the popup is open; otherwise it is not handled, so focus moves on (no `indentWithTab`) |
| Ctrl+Space                                 | Opens completion                                                                                                             |

The editor is 12 lines high at most, then it scrolls.

### Extensions

In order: `history()`; `autocompletion` (120 ms typing delay, at most 100 options rendered, no
icons, no default keymap, one override source: the guarded language source); the completion keys
with a guarded Enter; the run, Escape and guarded Tab keys (highest precedence, above the default
keymap's Mod-Enter); `closeBracketsKeymap`, `defaultKeymap`, `historyKeymap`; `closeBrackets()`,
`bracketMatching()`; the PromQL language extensions; the theme; the placeholder; the `aria-label`;
an update listener for `onChange`; the guard. There is **no linter**: only PulsusDB decides whether
a query is valid (T09-002, ADR-0015), so the editor places no diagnostic of its own.

The language source reads the completion context from the syntax tree. On a long document the
incremental parse may not have reached the caret when a request runs, so the source first parses up
to the caret (`forceParsing`, at most 100 ms) and reads the state that holds the tree. A 1 KB query
is always parsed already.

### Completion guard (T09-005, T09-015)

`completionGuard()` wraps the completion source and the accept commands (Enter and Tab). While it is
**blocked**, nothing opens, is looked up or is accepted, and editing, undo, highlighting,
`onChange` and `onRun` go on.

- **Composition.** At `compositionstart` an open or pending popup is closed (CodeMirror re-filters
  an open list on every change, so closing is the only way it is not reordered or replaced). While
  composing, the source returns nothing without a lookup, a pending query CodeMirror starts from the
  typed text is closed, and a result that arrives is held; Enter and Tab accept nothing. At
  `compositionend` every held result is dropped, and 20 ms later (CodeMirror flushes the composed
  text first) completion runs once against the current text if the text changed, a popup was
  closed or a result was held, in any composition since the last re-evaluation. Each
  `compositionstart` cancels the pending re-evaluation and keeps that intent, so only the last of
  several compositions re-evaluates, and an empty last one still refreshes for an earlier one. jsdom has no IME: the unit tests use synthetic
  `CompositionEvent`s, and Part C's `e2e:editor-ime` drives a real composition in Chromium.
- **Size.** `overLimitField` measures the document's UTF-8 bytes (`TextEncoder`) on every change
  (exact fast paths decide without encoding up to 43 690 UTF-16 units and above 131 072). Above
  131 072 bytes (not at it) completion pauses, and an open popup closes when the document grows past
  the limit; shortening the query resumes completion at the next typing or Ctrl+Space. Part C
  shows `explore.error.queryTooLarge` and refuses Run while the draft is over the limit. Between
  Part A's 65 536-byte limit on the sent query and this one, completion works and Run is refused
  with `explore.error.tooLong`.

### Completion data

```
keystroke ─► CodeMirror (120 ms typing delay) ─► guard ─► HybridComplete (codemirror-promql, Lezer context)
   ─► PrometheusClient (promClient.ts) ─► PromSource (promSource.ts) ─► SuggestCache.get
         ─► miss: Api.promLabelValues / promLabels / promSeries ─► BFF /api/dash/v1/prom/* ─► PulsusDB
   metricNames() then metricMetadata() ─► SuggestCache.track ─► TanStack ['prom', tenant, 'metadata'] (shared with the page)
   ◄─ options filtered by prefix locally; detail = the metric type, info = its help
```

**Lookups** (`createPromSource`). The source takes a generation token from
`cache.retainTenant(tenant)` once. Each lookup reads the window once and keys the cache by
`(tenant, 'promql', kind, label, selector, bucket)`, the bucket being `floor(toMs / 15 min)`; the
request carries the window of the first miss, so later windows in the same bucket share it
(T09-007).

| Method              | Request                                                                                           | Resolves                 |
| ------------------- | ------------------------------------------------------------------------------------------------- | ------------------------ |
| `metricNames()`     | `promLabelValues(tenant, '__name__', {from, to, limit: 10 000})`, all names, filtered locally     | the values               |
| `labelNames(m)`     | `promLabels(tenant, {from, to, match: [m] if m, limit: 1 000})`                                   | the values               |
| `labelValues(n, m)` | `promLabelValues(tenant, n, {from, to, match: [m] if m, limit: 1 000})`                           | the values               |
| `series(m)`         | `promSeries(tenant, {from, to, match: [m], limit: 1 000})`; `''` sends nothing                    | the label sets           |
| `metadata()`        | `queryClient.query(promMetadataQuery(api, tenant))` through `cache.track` (not cached in the LRU) | `{name: [{type, help}]}` |

Names, label names and label values are asked over the window snapped to whole minutes (start
floored, end ceiled, one minute when the two meet); series over whole seconds. These are the
request shapes PulsusDB is tested with. A source never rejects: any error, abort or ended generation
resolves `[]` (`{}` for metadata), and nothing is logged or shown, so the popup offers static items
only (T09 §9).

**Context** (`promqlCompleteStrategy`). For each request the strategy reads the enclosing
`LabelMatchers` from the request's own state (`matcherContextAt`), in the package's order (quoted
metric name, quoted matchers, unquoted matchers), and marks the matcher under the caret by its
range. The selector sent for label values leaves out **only** that matcher: completed matchers stay,
`job=""` and `job!=""` included, and each kept matcher is copied as typed, delimiters and escapes
included (`up{a='x"y'}`, ``up{a=`x"y`}``, `up{"a\"b"="x"}`). With no matcher kept the selector is
the bare metric. The edited label's name is decoded before it is sent (`"a\"b"` → `a"b`; PromQL's
Go-style unquoting; an undecodable name sends nothing). If the package's matcher list does not equal
the tree's, nothing is sent, so a package update that reads the tree differently cannot widen the
context; the through-view tests then go red.

### Suggest cache (`SuggestCache`)

| Rule         | Value                                                                                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Size         | 2 000 keys, least recently got out first; eviction never aborts or withholds a result                                                                                                                                                                                                                  |
| TTL          | 60 s from settle; a rejected load is not kept                                                                                                                                                                                                                                                          |
| Sharing      | an in-flight or fresh entry is shared: one request per key                                                                                                                                                                                                                                             |
| Supersede    | starting a lookup of a kind aborts the in-flight lookup of the same kind with another key, even if it was evicted; an evicted in-flight lookup is re-joined by its own key                                                                                                                             |
| Generations  | `retainTenant(t)` with the retained tenant joins the current generation; another tenant, or `clear()`, ends it: every entry and tracked call (metadata included) is dropped, in-flight requests are aborted, and their callers reject `AbortError` at once, even if the response never comes (T09-014) |
| Ended tokens | a call with a token of an ended generation, or for another tenant, runs no `load` (an old source after `a → b → a` or `clear()` sends nothing)                                                                                                                                                         |
| Unmount      | a destroyed view aborts nothing; in-flight lookups settle into the cache                                                                                                                                                                                                                               |

All state belongs to the main thread and changes synchronously.

### Shape analyser

`analysePromQL(text)` parses with `@prometheus-io/lezer-promql`. Any error node gives
`UNKNOWN_SHAPE`. Otherwise the top expression (comments skipped) gives the bare selector and its
source slice (a top-level `VectorSelector` with a metric name), the metric names of every
`VectorSelector` in order, whether `histogram_quantile` is called, and the value type: number
literals scalar, string literals string, `scalar()`, `time()` and `pi()` scalar, a binary
expression scalar only when both sides are, matrix and subquery selectors matrix, parentheses,
unary, `offset` and `@` modifiers their operand's type, anything else vector. It runs per run or
URL change, never per keystroke (about 0.4 ms for 1 KB).

### Run diagnostics

`diagnosticsOf(text, error, toSource, sent)` underlines PulsusDB's `queryInvalid` error (T09-009).
The error's `position` is a byte offset into the sent text: `utf8ToIndex` maps it to the UTF-16
index of the code point that holds that byte, and Part A's `toSourceIndex` maps that to the editor
text (the rate rewrite adds text around it). At the end of the text the last code point is marked;
a surrogate pair is marked whole. With no position, one out of range or one inside text the
planner added, the whole query is marked and the message gets " (position unknown)". The message
stays PulsusDB's text, its `1:52:` prefix included. Any other error places nothing.

### Highlighting (T09 §4.8)

| Tags                                                                                                                                                                                | Colour                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `keyword`, `operatorKeyword` (aggregations), `modifier` (`by`, `without`, `offset`, `bool`, `on`, `ignoring`, `group_left`, `group_right`), `logicOperator` (`and`, `or`, `unless`) | `syn-keyword`                                 |
| `function(variableName)`                                                                                                                                                            | `syn-func`                                    |
| `string`                                                                                                                                                                            | `syn-string`                                  |
| `number` (numbers and durations)                                                                                                                                                    | `syn-number`                                  |
| `labelName`                                                                                                                                                                         | `syn-label`                                   |
| `variableName` (metric names)                                                                                                                                                       | `text`                                        |
| operators, brackets, comments                                                                                                                                                       | `text-muted`                                  |
| `invalid`                                                                                                                                                                           | `text` (no client-side error colour, T09-002) |

The run error is a wavy `accent` underline, not a state colour: a query error is not an entity
state (VL-003).

### Testing an editor in jsdom

Tests build a view with `viewIn(o)` (`src/test/viewIn.ts`): a host on `document.body`, an open
shadow root, a mount `<div>` in it; `destroyViews()` after each test. Keys go through
`runScopeHandlers(view, keydown, 'editor')`; jsdom is not a Mac, so Mod is Ctrl. After
`startCompletion`, wait for `completionStatus === 'active'`, then 100 ms (CodeMirror ignores
accept keys for 75 ms after a popup opens). `fakePromSource(F)` (`src/test/fakePromSource.ts`)
returns fixed data and records each call (`'labelValues job up'`). Compositions are synthetic
`CompositionEvent`s on `view.contentDOM` with `input.type.compose` transactions.
`src/test/editorDom.ts` (imported by `viewIn` and the host test) defines what jsdom lacks: text
ranges without layout (`getClientRects`, `getBoundingClientRect`), which CodeMirror measures when it
scrolls the caret into view, and `execCommand`, which its selection read in a shadow root falls back
to on focus. Vitest resolves `@prometheus-io/codemirror-promql` to its ES module build (it has
no `exports` map, and its CommonJS build would load a second `@codemirror/state`), as the browser
build does.

## Gates

| Gate                                                                                                                                      | File                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit:explore-plan`                                                                                                                       | `src/explore/plan.test.ts`: the planner rows, the sent-size boundary (at the `1m` window), the rate window rows (set by 4 × S, by 4 × step, and the proof that step + S never sets it), metric types, durations, the source index, byte length                                                                                                                                                                         |
| `unit:autovis-table`                                                                                                                      | `src/vis/autovis.test.ts`: one fixture per rule, rule order, range never stat, the override                                                                                                                                                                                                                                                                                                                            |
| `unit:heatmap-buckets`                                                                                                                    | `src/vis/histogram.test.ts`: complete, missing single and grouped samples, groups with differing bounds, row isolation, and many-group, many-bound allocation checks: Float64 elements allocated stay within the output plus the axis, eligibility allocates none, and doubling the groups doubles the allocation (`src/test/allocations.ts` counts them). Wall-clock times are printed only, never asserted (T05-006) |
| `unit:frame-plan`                                                                                                                         | `src/vis/framePlan.test.ts`: every vis × result valid, bars over instant series with unequal timestamps, the bars grid bound (500 series × 1 000 disjoint timestamps gives the notice with allocation linear in the input; exactly `MAX_GRID_CELLS` draws, one more timestamp gives the notice), scalar overrides, heatmap row isolation and restore                                                                   |
| `unit:series-rows`                                                                                                                        | `src/explore/seriesRows.test.ts`                                                                                                                                                                                                                                                                                                                                                                                       |
| `unit:explore-params`                                                                                                                     | `src/state/exploreParams.test.ts`, with `useExploreParams.test.tsx` and the `router` explore canonical test                                                                                                                                                                                                                                                                                                            |
| `unit:decode-frames` (prom)                                                                                                               | `src/data/decode.test.ts`                                                                                                                                                                                                                                                                                                                                                                                              |
| `unit:columns` (merge keeps missing)                                                                                                      | `src/engine/canvas2d/columns.test.ts`                                                                                                                                                                                                                                                                                                                                                                                  |
| `bench:frame-interim-heatmap`                                                                                                             | `e2e/perf-heatmap-draw.spec.ts` ([Build, test and CI](../development/build-and-ci.md#tests))                                                                                                                                                                                                                                                                                                                           |
| `unit:promql-shape`                                                                                                                       | `src/editor/lang/promql/promql.test.ts`: the 23 shape rows (comments, value types, `histogram_quantile`, error nodes)                                                                                                                                                                                                                                                                                                  |
| `unit:promql-diagnostics`                                                                                                                 | `src/editor/lang/promql/promql.test.ts`: bytes to UTF-16 (multi-byte, pairs, lone surrogates), positions D1–D9, and a position inside the rate rewrite through Part A's planner                                                                                                                                                                                                                                        |
| `unit:suggest-cache`                                                                                                                      | `src/editor/suggestCache.test.ts`: C1–C18, with no unhandled rejection in any case                                                                                                                                                                                                                                                                                                                                     |
| `unit:prom-source`                                                                                                                        | `src/editor/lang/promql/promSource.test.ts`: S1–S14 (requests, buckets, supersede, failures, series, tenant switches, metadata, ended tokens, the minute and second windows)                                                                                                                                                                                                                                           |
| `unit:prom-client`                                                                                                                        | `src/editor/lang/promql/promClient.test.ts`: `selectorOf`, `decodeLabelName`, `matcherContextAt` and `toPrometheusClient` rows                                                                                                                                                                                                                                                                                         |
| `unit:editor-keys`, `unit:editor-completion`, `unit:editor-doc`, `unit:editor-diagnostics`, `unit:editor-no-linter`, `unit:editor-styles` | `src/editor/view.test.ts`                                                                                                                                                                                                                                                                                                                                                                                              |
| `unit:editor-composition`, `unit:editor-size`                                                                                             | `src/editor/completionGuard.test.ts`: K1–K5, Z1–Z6                                                                                                                                                                                                                                                                                                                                                                     |
| `unit:query-size`                                                                                                                         | `src/explore/querySize.test.ts`: Q1–Q6                                                                                                                                                                                                                                                                                                                                                                                 |
| `unit:editor-host`                                                                                                                        | `src/editor/PromQLEditor.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                     |
| `unit:lang-table`                                                                                                                         | `src/editor/lang/index.test.ts`                                                                                                                                                                                                                                                                                                                                                                                        |
| `unit:window-keys`                                                                                                                        | `src/state/useWindowKeys.test.tsx`: an editable element in a shadow root, a shadow host in a dialog, and an event without a path                                                                                                                                                                                                                                                                                       |

The editor's budgets (PRF-005 keystroke work, `bench:editor-keystroke`; PRF-009 editor chunk,
`ci:bundle-size`) and its browser gates (`e2e:csp-violations`, `e2e:lazy-load`, `e2e:editor-ime`)
are Part C's, where a page first loads the chunk.

Editor design rules: [T09](../../designs/technical/T09-query-editors.md) T09-001 (one interface per
language), T09-002 (no client-side validity), T09-003 (Lezer highlighting), T09-004 (keys), T09-005
(composition), T09-006 (one history), T09-007 (lookups, window bucket, supersede), T09-009 (run
error position), T09-014 (cache keyed by tenant, dropped on switch), T09-015 (128 KB);
[ADR-0014](../../designs/adr/0014-typescript-react-web-client.md) §1 (CodeMirror), §7 (supply
chain), §9 (CSP).
