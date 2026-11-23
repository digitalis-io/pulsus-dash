# Explore: metrics (data, rules, the editor chunk and the page)

The Explore metrics page (issue #63) is built in three parts. This page documents **Part A**, the
modules that decide what the page sends and draws, without drawing it (each rule is a pure,
table-tested function); **Part B**, the PromQL editor chunk, a library the page loads lazily
([Editor chunk](#editor-chunk)); and **Part C**, the page itself ([Page](#page)). The LogQL editor
of issue #66 Part A shares the editor chunk's host, guard, cache and diagnostics
([LogQL (`lang/logql`)](#logql-langlogql)). How to use the
page is in the user guide, [Explore: metrics](../user/explore-metrics.md).

Requirements: [SRF-030](../../designs/product/04-surfaces.md#srf-030--metrics-auto-vis-and-multiple-queries)
(auto-vis subset), [SRF-031](../../designs/product/04-surfaces.md#srf-031--metric-browser-and-series-table)
(series rows and sort), [SRF-027](../../designs/product/04-surfaces.md#srf-027--promql-editor)
(completion data), [VIZ-065](../../designs/product/05-visualisation-catalogue.md#viz-065--auto-vis-rules)
(Table 5-13 rows 5, 6, 7 and 14, from the server's `planned` facts) and [IA-022](../../designs/product/02-information-architecture.md#ia-022--deep-links-reproduce-the-view)
(the `q`, `vis` and `rate` keys); for the editor, SRF-027 (highlighting, completion, the run error
underlined) and [INT-032](../../designs/product/03-interaction-model.md#int-032--window-step-and-zoom-keys)
(window keys are not taken from the editor). Design rules: [T09-009](../../designs/technical/T09-query-editors.md)
(client half: positions arrive in raw bytes), T09-010 and T09-015 (the server plans and checks the
sent size), [T06-029](../../designs/technical/T06-bff-architecture.md) (the server builds the final
query), [T04-010](../../designs/technical/T04-wire-format-and-data-plane.md)
(the decoder seam), [T06-025](../../designs/technical/T06-bff-architecture.md) (the e2e data source
reads `Connected`); [ADR-0014](../../designs/adr/0014-typescript-react-web-client.md),
[ADR-0015](../../designs/adr/0015-go-bff.md) ("Query validation": PulsusDB validates),
[ADR-0017](../../designs/adr/0017-react-router.md) and
[ADR-0018](../../designs/adr/0018-query-language-modules.md) (one `QueryLanguage` per language) and
[ADR-0021](../../designs/adr/0021-query-planning-is-server-side.md) (query planning is
server-side).

## Modules

| Module                                              | What it does                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/editor/lang/types.ts`                          | Types shared with the editor: `QueryShape` (the bare selector and its source slice, the metric names, `histogram_quantile`, the value type), `UNKNOWN_SHAPE`, `Diagnostic`, `LangId`, `LanguageDeps`, `QueryLanguage` (T09 §5.1), `PromSource`. No run-time imports, so the route chunk can use it without the editor chunk |
| `src/explore/metricKind.ts`                         | `MetricKind`, `kindOfType`, `metricKind(name, own)`: the suffix rules of a metric's type, for the picker's descriptions and the StubApi mirror. Nothing here decides the text sent                                                                                                                                          |
| `src/explore/seriesRows.ts`                         | The series table's rows: `seriesRows`, `sortRows`, `nextSort`, `toggleIsolation`, `TABLE_ROWS` (500, the engine's series cap)                                                                                                                                                                                               |
| `src/vis/autovis.ts`                                | `ExploreResult` and its adapters `fromRange`, `fromInstant`; `autoVis`, `chooseVis`                                                                                                                                                                                                                                         |
| `src/vis/histogram.ts`                              | `isHistogram`, `histogramBuckets`, `isolateBucket`: Prometheus buckets as heatmap counts                                                                                                                                                                                                                                    |
| `src/vis/framePlan.ts`                              | `framePlan`, `canIsolate`, `scalarSeries`, `SCALAR_KEY`: the `<ChartFrame>` spec and data for every vis and result                                                                                                                                                                                                          |
| `src/state/exploreParams.ts`, `useExploreParams.ts` | The URL codec of `q`, `vis`, `rate` and its hook                                                                                                                                                                                                                                                                            |
| `src/api/*`, `src/data/decode.ts`                   | The four `/prom/*` reads and their decoders                                                                                                                                                                                                                                                                                 |

## The run path

The server plans every PromQL run ([query planning](../server/pulsusdb.md#query-planning-adr-0021),
ADR-0021): the page sends the text the user wrote and the inputs, and reads every fact about what
was sent from the result's `planned`.

| The page sends | Range | Instant (a scalar or string value type) |
|---|---|---|
| `query` | the URL query `q`, as is | as is |
| the rate chip | `rate` (`true` unless `rate=off`) | — |
| the width and step | `widthPx` (the server derives the step) | `stepMs` (the grid step of the window at the chart's width) |

`runKind(q, lang)` picks the route from the Lezer shape: instant for a scalar or string value
type, else range; it never changes the text sent. The server rewrites a bare counter to
`rate(<selector>[w])` and a bare histogram bucket to `sum by (le) (rate(<selector>[w]))` behind the
chip, substitutes `$__interval` and `$__rate_interval` at the step, and refuses a planned text over
64 KiB with 413. The page reads:

| Fact | Used for |
|---|---|
| `planned.rateCandidate` | the Rate applied chip is shown |
| `planned.rateApplied` | auto-vis rules 5 and 6, the `/s` unit, the frame plan's rate flag |
| `planned.histogram` | auto-vis rule 5 (heatmap) |
| `planned.query` | "Sent query: …" when it differs from the text that ran |

The metric types are the server's (a per-binding cache; without them only names ending in
`_total` are rated, with a completeness warning): the page no longer waits for the metadata, which
it still reads for the picker and completion.

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

`queryRange(tenant, {query, fromMs, toMs, widthPx, timeoutMs?, vars?, rate?})` and
`queryInstant(tenant, {query, atMs, timeoutMs?, vars?, stepMs?})` send the raw text; `vars`, `rate`
and `step_ms` are in the body only when given. Both results carry `planned: PlannedQuery`
(`query`, `expanded`, `bytes`, `valueType`, `rateCandidate`, `rateApplied`, `histogram`, and
`stepMs`, `rateWindowMs` when set), decoded by `decodePlanned`. Errors map, first match:

| Status and body | `ApiError` |
|---|---|
| 413 with `query.sent_too_large` or `query.too_large_to_plan` | `queryTooLong`, `detail {planned?, hint?, queryId?}` (`planned` absent only with `hint.reason` `processing_cap`) |
| 400 with `variable.missing`, `/step_ms` or a `/vars…` pointer | `invalid`, `fields` camel-cased |
| 400 `virtual_unsupported`; 400 on `/query` | `queryInvalid` (`detail.position` a byte offset into the **raw** query) |
| 404, 422, 429, 502, 503, 504, other | as before |

Every `detail` carries `planned` when the server sent one (every error raised after planning); a
malformed `planned` is left out.

The LogQL methods plan on the server too (plan #116, [LogQL
planning](../server/pulsusdb.md#logql-planning)). `queryLogs(tenant, {query, fromMs, toMs,
widthPx, limit?, direction?, cursor?, timeoutMs?, vars?})` and `queryVolume(tenant, {query, fromMs,
toMs, widthPx, timeoutMs?, vars?})` send the raw text, with `vars` in the body only when given.
Both kinds of `LogsResult` (`streams` and `series`) and the `VolumeResult` of `queryVolume` (a
`RangeFrame` with `planned`) carry `planned: LogqlPlannedQuery` (`query`, `expanded`, `bytes`,
`stepMs`), decoded by `decodeLogqlPlanned`; a body without it is a `DecodeError` at `/planned`.
A LogQL error's `planned` is decoded by `decodeLogqlPlanned` (`queryError` takes the decoder), so
`ApiErrorDetail.planned` is `PlannedQuery | LogqlPlannedQuery`; readers that serve both languages use
only `query`, `expanded` and `bytes`. The mapping rows above apply unchanged: a 413 with
`query.sent_too_large` or `query.too_large_to_plan` is `queryTooLong`, and `variable.missing`,
`variable.unrepresentable` or another `/vars…` pointer is `invalid`.

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

### The StubApi planner mirror

`StubApi` plans as the server does, so `npm run dev` and the tests see the same `planned` facts
and refusals. `src/api/stub/plan.ts` mirrors `prom.Plan` on the UTF-8 bytes of the text
(`prepare`, `classify`, `floorStep`, `expandedAt`, `plan`, the byte guard `reservedIn`, the metric
kinds and the window); `src/api/stub/promShape.ts` (loaded with `await import`, so Lezer stays out
of the initial chunk) gives `stubShape(text)`: the Lezer shape when `typeCheck` passes, else the
unknown shape. `typeCheck` mirrors the server parser's type rules on the Lezer tree: function
argument types and arity from `src/api/stub/promFunctions.ts` (`STABLE_FUNCTIONS`, the parser's
stable functions), scalar comparisons without `bool`, set operators and vector matching on
non-vectors, experimental aggregators, subqueries of a matrix, the target of `offset` and `@`,
selectors whose matchers all match the empty string, and aggregation parameters.

`plan.ts`'s substitution follows the PromQL lexical states of the server (`"…"`, `'…'`,
`` `…` `` and `#` comments, a comment ending at LF or CR), encodes values written into `"…"` and
`'…'` by the same table, and refuses `variable.unrepresentable` as the server does, before any
metadata read. `promShape.ts` reads string literals by the upstream lexer's escape rules
(`unquote`: `\a`…`\v`, `\xHH`, octal, `\u`, `\U`, only the opening quote escaped, a literal
U+FFFD refused); `typeCheck` fails on a literal that does not unquote, as the server's parser
does. Lezer's `LineComment` runs to LF only, so `stubShape` first runs `endCommentsAtCR`, which
writes every CR that ends a comment as an LF and keeps every offset. Its known limitations, stub
mode only: regular-expression dialects (the empty string is tested with JavaScript's engine and
no pattern is refused), number lexing, and a Lezer grammar that lags or leads the server's
parser.

The stub's private `plan` follows the route order: `prepare`; Classify and the byte guard on the
substituted text (a refusal never reads metadata); the step; `promMetadata` only when the plan
needs types, raced against 2 s (a failure or the timeout plans without types and adds
`WARN_TYPES_UNAVAILABLE`); `plan`; the guard on the planned text. Each refusal is the `ApiError`
HttpApi gives for the gateway's body.

`src/api/stub/plan.test.ts` and `promShape.test.ts` run every case of the shared fixture
`wire/fixtures/plan/promql.json` (the Go planner runs the same file) and require the server's
results, shapes and function table exactly.

`src/api/stub/logsPlan.ts` mirrors `logs.Plan` the same way, on the UTF-8 bytes of the text:
`prepareLogs` (the checks, the LogQL substitution with its encoding of values written into `"…"`
strings and the `variable.unrepresentable` refusal, and the classification of the substituted
text), `checkCap`, `plan` (the macros at the step, the volume template, the 64 KiB limit and the
classification of the planned text), `classifyLogs` (the selector reader, decoding `"…"` values by
Go's `strconv.Unquote` rules and dropping CRs from backtick values), `volumeRange`,
`logsRateWindowMs` and `logsFormatDuration`. The stub's private `planLogs` is synchronous and
follows the LogQL route order: `prepareLogs`; a `virtual` or `mixed` class is refused as
`RESERVED_MATCHER`; the byte guard on the substituted text; `checkCap`; `plan`; then the class and
the byte guard of the planned text, both refusing with `planned`. `queryLogs` and `queryVolume`
plan at the `promGrid` step and return their synthetic page and frames with `planned`.
`src/api/stub/logsPlan.test.ts` runs every case of `wire/fixtures/plan/logql.json` (the `classify`
and `plan` groups and the tables, loaded by `logsPlanFixture.ts`) by the same outcome rules as the
Go runner.

The LogQL mirror has no comment state (#121): PulsusDB's LogQL has no comments, so the substitution
scan and the selector reader treat a `#` outside strings as an ordinary byte and skip no text.
`prepareLogs` refuses a top-level `#` as the server does (row 9b, on the substituted text before
the classification, and again in `plan` on the final text): 400 `/query` `query.invalid`, the
message `unexpected '#' at byte <N>: LogQL has no comments` and `hint: {position: {offset: N}}`,
with N mapped back to the raw text. `StubApi`'s `toApiError` passes that offset as
`detail.position`, as `HttpApi` reads `hint.position` from the gateway's body, so the editor
underlines the `#` in stub mode too. `substituteLogs` (marked `@internal`, tests only) is the
substitution before row 9b, which the classify runner reads.

The ESLint block `eslint/stub-plan-boundary.ts` (`@typescript-eslint/no-restricted-imports`, regex
`(^|/)stub/(plan|promShape|promFunctions|logsPlan|logsPlanFixture)(\.ts)?$`) refuses an import of
`stub/plan`, `stub/promShape`, `stub/promFunctions`, `stub/logsPlan` or `stub/logsPlanFixture`
outside `src/api/StubApi.ts` and `src/api/stub/`, with the message
`api/stub/plan is the StubApi planner mirror: only StubApi imports it (ADR-0021 §4).`; tests
outside the directory use literal texts instead (`unit:stub-plan-boundary` checks the rule).

## Editor chunk

The PromQL editor (Part B) is CodeMirror 6 with the Lezer PromQL grammar of
`@prometheus-io/codemirror-promql` and `@prometheus-io/lezer-promql` (pinned versions in
[JavaScript supply chain](supply-chain.md#query-editor)). The page loads it with a dynamic import of `src/editor/editor.ts`, which exports `PromQLEditor`,
`promql` and `createPromSource`; `LANGUAGES.promql()` loads `lang/promql/promql.ts`. The LogQL
editor (#66) has its own entry, `src/editor/logqlEditor.ts` (`LogQLEditor`, `logql`,
`createLogSource`, the `QueryEditorHandle` type), so the Logs page never loads the PromQL parser;
`LANGUAGES.logql()` loads `lang/logql/logql.ts`. All of them are named `editor-*` in the build
([Chunk naming and the closure budget](#chunk-naming-and-the-closure-budget)).

### Modules

| Module                                 | What it does                                                                                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/editor/editor.ts`                 | The chunk entry, the only module a page imports from the chunk                                                                                                                                                                                 |
| `src/editor/lang/index.ts`             | `LANGUAGES`: a static table from `LangId` to a lazy import of the language's `QueryLanguage` (ADR-0018). PromQL resolves `lang/promql/promql.ts`, LogQL `lang/logql/logql.ts`; `traceql` and `profile` reject with `LanguageUnavailableError` until they are built |
| `src/editor/lang/promql/promql.ts`     | `promql: QueryLanguage`: `shape` (`analysePromQL`), `editor(deps)` and `detect`; re-exports `utf8ToIndex` and `positionDiagnostics` as `diagnosticsOf` |
| `src/editor/lang/diagnostics.ts`       | `utf8ToIndex`, `positionDiagnostics`: the run diagnostics of every language ([Run diagnostics](#run-diagnostics)) |
| `src/editor/lang/lookupWindow.ts`      | `minuteWindow`, `secondWindow`: the windows of completion lookups |
| `src/editor/lang/logql/lexer.ts`       | `scanAt`, `lexLogQL`, `startLex`, `advance`: the LogQL scanner and its mode stack |
| `src/editor/lang/logql/grammar.ts`     | The static word lists (`FUNCTIONS`, `CONVERSIONS`, `KEYWORDS`, `STAGES`, `GROUP_WORDS`) |
| `src/editor/lang/logql/context.ts`     | `caretContext`, `selectorOf`, `firstSelector`, `VAR_REF`: the LogQL caret context |
| `src/editor/lang/logql/complete.ts`    | The two LogQL completion slots, `replacing`, `lookupKeyOf`, `logqlLookupKeyAt`, `escapeDoubleQuoted`, `LOGQL_COMPLETION` |
| `src/editor/remoteLookups.ts`          | `RemoteLookups` (one view's in-flight lookup and its epoch), `afterQuiet`, `remoteLookupsPlugin(lookups, keyAt)`, `RELEASE_ON_CHANGE`, `REMOTE_DEBOUNCE_MS`, `MAX_LOOKUP_DOC`: shared by the LogQL and PromQL slots (#107) |
| `src/editor/lang/logql/logSource.ts`   | `createLogSource(deps)`: the LogQL lookups over `Api.logLabels`, `Api.logLabelValues` and the suggest cache |
| `src/editor/lang/logql/extensions.ts`  | `logqlLanguage` (the `StreamLanguage`), `logqlExtensions(source)` |
| `src/editor/lang/logql/logql.ts`       | `logql: QueryLanguage` |
| `src/editor/lang/promql/extensions.ts` | `promqlExtensions(source)`: the Lezer PromQL language (its completion and linter off), the highlight style, the lookup plugin, and the two completion slots as `autocomplete` language data |
| `src/editor/lang/promql/complete.ts`   | `PROMQL_COMPLETION`, `analysisAt` (the recording run), `recordingSource`, `withSignal`, `LOCAL_SECTION`, `REMOTE_SECTION`, `promqlLocalSource`, `promqlRemoteSource` (#107) |
| `src/editor/lang/promql/replace.ts`    | `replaceRange`, `replacing`: the range an accepted PromQL option replaces (#107) |
| `src/editor/lang/promql/promSource.ts` | `createPromSource(deps)`: the completion lookups over `Api.prom*` and the suggest cache                                                                                                                                                        |
| `src/editor/lang/promql/promClient.ts` | `matcherContextAt`, `selectorOf`, `decodeLabelName`, `toPrometheusClient`, `promqlCompleteStrategy`: the package's completion over a `PromSource`                                                                                              |
| `src/editor/suggestCache.ts`           | `SuggestCache`, `suggestKey`, `windowBucket`, `suggestCache` (the module instance)                                                                                                                                                             |
| `src/editor/completionGuard.ts`        | `completionGuard()`, `overLimitField`: no completion while an IME composes or above 128 KB                                                                                                                                                     |
| `src/editor/view.ts`                   | `createQueryView`, `CompletionTiming`, `languageCompletionAt`, `createPromQLView`, `setDocument`, `insertAtSelection`, `setReadOnly`, `showDiagnostics` |
| `src/editor/probe.ts`                  | The bench probes: `probedDispatch` (each `view.update`) and `completionProbe()` (the PromQL slots' work, #107) |
| `src/editor/theme.ts`                  | `promqlTheme`, `promqlHighlight` (tokens only)                                                                                                                                                                                                 |
| `src/editor/QueryEditorHost.tsx`       | The React host shared by the languages ([Host](#host-shadow-root-and-csp)) |
| `src/editor/PromQLEditor.tsx`          | `QueryEditorHost` with the PromQL extensions and `PROMQL_COMPLETION` |
| `src/editor/LogQLEditor.tsx`           | `QueryEditorHost` with the LogQL extensions and `LOGQL_COMPLETION` |
| `src/editor/logqlEditor.ts`            | The Logs page's chunk entry |
| `src/explore/promMetadata.ts`          | `promMetadataQuery(api, tenant)`: the page's metric-metadata query, also read by completion. No editor import, so the page can use it before the chunk loads                                                                                   |
| `src/explore/querySize.ts`             | `QUERY_BYTE_LIMIT` (131 072), `queryBytes`, `overQueryLimit` (T09-015)                                                                                                                                                                         |

Each language lives in `src/editor/lang/<id>/` and implements `QueryLanguage` (T09 §5.1). No
language directory imports another: ESLint `no-restricted-imports` fails a file in
`src/editor/lang/<id>/` that imports from another language's directory. Shared code
(`suggestCache.ts`, `completionGuard.ts`, `remoteLookups.ts`, `probe.ts`, `theme.ts`, `view.ts`,
`lang/types.ts`, `lang/diagnostics.ts`, `lang/lookupWindow.ts`) lives outside them.

### `QueryLanguage` (ADR-0018)

| Member | PromQL | LogQL |
| --- | --- | --- |
| `lang` | `'promql'` | `'logql'` |
| `editor(deps: LanguageDeps)` | `promqlExtensions(createPromSource(deps))`. `LanguageDeps` is `{api, queryClient, tenant, window, cache?}`: the BFF client, the TanStack client, the tenant (the suggest-cache key, T09-014; there is no `scope_fp` while data scopes are deferred, D12), the window shown now (read on each lookup) and the cache (default the module instance) | `logqlExtensions(createLogSource(deps))`, the same `LanguageDeps` |
| `shape(text)` | `analysePromQL` ([below](#shape-analyser)) | `UNKNOWN_SHAPE` for every text: LogQL has one range route, so no route choice needs a shape, and the page reads log versus metric from the response's `kind` (`streams` or `series`) ([ADR-0021](../../designs/adr/0021-query-planning-is-server-side.md) §4) |
| `diagnosticsOf(text, error, toSource, sent)` | `positionDiagnostics` ([Run diagnostics](#run-diagnostics)) | the same function, with the identity map |
| `detect(prefix)` | `0` (no claim): ⌘K query detection (INT-038) is not built yet | `0` |

### Host, shadow root and CSP

`QueryEditorHost` (`src/editor/QueryEditorHost.tsx`) is the host of every language; `PromQLEditor`
and `LogQLEditor` are thin wrappers that pass it a `language` builder and a `CompletionTiming`
(`PROMQL_COMPLETION`, `LOGQL_COMPLETION`). Each wrapper keeps its `source` in a ref and builds its
extensions once over a proxy that forwards every lookup and its signal to the current source, so a new `source` takes effect at the next lookup; the props and exports of
`PromQLEditor` are unchanged, and `QueryCard` and `PanelQueryField` use it as before.

The host renders an empty `<div data-editor-host>` (with `className`). Its mount effect
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
| `source`                | `PromSource` or `LogSource` (wrappers): read at each lookup               |
| `readOnly`              | No edits while true; `aria-readonly` on `.cm-content` (#64)               |
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

`createQueryView(o)` builds every language's view; `createPromQLView` is `createQueryView` with
`promqlExtensions(source)` and `PROMQL_COMPLETION`. In order: `history()`; `autocompletion` (the
language's `CompletionTiming`: both languages no typing delay and two override sources, PromQL also
`updateSyncTime` 0 (`updateSyncMs`); at most 100 options rendered, no icons, no default keymap; each override source is
`languageCompletionAt(i)` through the guard, slot `i` of the language's `autocomplete` data); the completion keys
with a guarded Enter; the run, Escape and guarded Tab keys (highest precedence, above the default
keymap's Mod-Enter); `closeBracketsKeymap`, `defaultKeymap`, `historyKeymap`; `closeBrackets()`,
`bracketMatching()`; the language extensions; the theme; the placeholder; the `aria-label`;
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
keystroke ─► CodeMirror (no typing delay) ─► guard ─► slot 0: analysisAt ─► HybridComplete over recordingSource
                                                       (codemirror-promql, Lezer context; no request)
                                                       ─► statics (functions, keywords, durations …) + the lookups the context needs
                                          └─► guard ─► slot 1: the same analysis; none needed ─► null
                                                       else afterQuiet(120 ms) ─► RemoteLookups.signalFor(key)
   ─► HybridComplete over withSignal(source) ─► PrometheusClient (promClient.ts) ─► PromSource (promSource.ts)
   ─► SuggestCache.get(…, signal) ─► miss: Api.promLabelValues / promLabels / promSeries ─► BFF /api/dash/v1/prom/* ─► PulsusDB
   metricNames() then metricMetadata() ─► SuggestCache.track ─► TanStack ['prom', tenant, 'metadata'] (shared with the page)
   ◄─ the options the local run did not return; filtered by the text before the caret; detail = the metric type, info = its help
```

**Lookups** (`createPromSource`). The source takes a generation token from
`cache.retainTenant(tenant)` once. Each lookup reads the window once and keys the cache by
`(tenant, 'promql', kind, label, selector, bucket)`, the bucket being `floor(toMs / 15 min)`; the
request carries the window of the first miss, so later windows in the same bucket share it
(T09-007).

Every lookup method takes the caller's `signal` last (`metricNames(signal?)`, `labelNames(m,
signal?)` …) and passes it to `SuggestCache.get`, so a released lookup is cancelled once no other
caller holds it (#107).

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
| Key          | `JSON.stringify([tenant, lang, kind, label, selector, bucket])`; `lang` is `'promql'` or `'logql'`, so the two languages never share an entry |
| Sharing      | an in-flight or fresh entry is shared: one request per key                                                                                                                                                                                                                                             |
| In flight    | no entry is superseded by another key, in any language (#107). Every pending entry is also tracked by its key apart from the LRU (`inflight`), so an evicted one is re-joined by its own key and is still released by its last signalled caller |
| Caller interest | `get(g, parts, load, signal?)`: an already aborted `signal` rejects `AbortError` at once and runs no `load`. While the entry is in flight, a call without a signal pins it; a call with one holds it until the signal aborts. When the last holder aborts and nothing pins it, the entry is dropped: its request is aborted and its key removed, so nothing aborted is cached. A settled entry ignores signals |
| Generations  | `retainTenant(t)` with the retained tenant joins the current generation; another tenant, or `clear()`, ends it: every entry and tracked call (metadata included) is dropped, in-flight requests are aborted, and their callers reject `AbortError` at once, even if the response never comes (T09-014) |
| Ended tokens | a call with a token of an ended generation, or for another tenant, runs no `load` (an old source after `a → b → a` or `clear()` sends nothing)                                                                                                                                                         |
| Unmount      | a destroyed PromQL or LogQL view releases its interest (its `RemoteLookups` aborts its signal); the request aborts only when no other view or unsignalled caller holds it |

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

`positionDiagnostics(text, error, toSource, sent)` (`lang/diagnostics.ts`; `promql.diagnosticsOf`
and `logql.diagnosticsOf`) underlines PulsusDB's `queryInvalid` error (T09-009).
The server maps PulsusDB's position to the raw text (ADR-0021 §3), so the page passes the identity
mapping and the text itself as `sent`: `utf8ToIndex` maps the byte offset to the UTF-16 index of the
code point that holds that byte. A position the server could not map (inside a rate rewrite) does
not arrive. At the end of the text the last code point is marked;
a surrogate pair is marked whole. With no position, one out of range or one inside text the
planner added, the whole query is marked and the message gets " (position unknown)". The message
stays PulsusDB's text, its `1:52:` prefix included. Any other error places nothing.

For LogQL every caller passes `logql.diagnosticsOf(text, error, (i) => i, text)`: the server maps
PulsusDB's offset to the raw text and gives none inside the volume template or a value it inserted
([LogQL positions](../server/pulsusdb.md#logql-positions)). `planned.query` never places an
underline: an offset read against it would land after the template's prefix.

| Run error (LogQL) | Diagnostics |
| --- | --- |
| `queryInvalid` with `detail.position` (a byte offset into the raw text) | one underline at the code point holding that byte; past the end, the whole text with " (position unknown)" |
| `queryInvalid` without a position (400 `virtual_unsupported`; an offset inside the volume template or an inserted value) | the whole text, " (position unknown)" |
| `invalid` (`variable.missing`, `variable.unrepresentable`, another `/vars…` or `/step_ms` field) | none: a field error, shown by the caller's status line |
| `queryTooLong` (413 `query.sent_too_large` with `planned`, `query.too_large_to_plan`, or `hint.reason` `processing_cap`) | none |
| any other kind, a non-`ApiError`, or an empty text | none |

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

### LogQL (`lang/logql`)

LogQL is the second `QueryLanguage` ([ADR-0018](../../designs/adr/0018-query-language-modules.md)
§5). Nothing here decides whether a query is valid (T09-002), plans it or substitutes variables
(ADR-0021 §2): the browser keeps the editor, highlighting and completion (ADR-0021 §4).

**Scanner** (`lexer.ts`, T09-003). One context-free `scanAt(s, i, inRaw)` cuts the text into
tokens; it drives both the CodeMirror `StreamLanguage` (line by line, resumable) and `lexLogQL`, the
whole-text lexer of the caret context, so the two never drift. It never throws: any text lexes into
contiguous tokens. First match at `i`:

| Text | Token |
| --- | --- |
| a backtick string continued from an earlier line | `rawString` to the next `` ` `` (closed), else to the end |
| spaces, tabs, CR, LF | `space` |
| `"` | `string`: `\` escapes the next code unit; ends after the closing `"`, or unclosed before a LF or at the end |
| `` ` `` | `rawString` to the next `` ` `` (LF allowed), else unclosed to the end |
| `\|=` `\|~` `\|>` `!>` | `lineFilter` |
| `\|` | `pipe` |
| `=~` `!~` `!=` `=` | `matchOp` |
| `==` `>=` `<=` `>` `<` | `cmpOp` |
| `+ - * / % ^` | `arith` |
| `{ } ( ) [ ] ,` | brackets and `comma` |
| a digit | `number`; with a unit, `duration` (`5m`, `1h30m`, `5µs`), `bytes` (`10KB`, `3MiB`) or `error` (`5x`) |
| `[A-Za-z_]` | `ident` |
| anything else | `error` over one code point (`#`, `$`, an emoji) |

**No comments.** PulsusDB's LogQL has no comments (#121). The scanner has no comment state: a `#`
outside a string is one `error` token, highlighted `invalid` like any other character LogQL does not
use, and the text after it is scanned as LogQL. So a selector after a `#` still completes. The
language data has no `commentTokens`, so the comment commands (`Mod-/`) change nothing. A run with a
top-level `#` is refused by the server with 400 `query.invalid` at the `#`'s byte offset, and the
editor underlines the `#` (T09-009). The editor adds no diagnostic of its own before a run
(T09-002).

**Mode stack.** `advance` keeps a stack of frames: `{` opens a selector (`brace`), `(` a `group`
after `by`, `without`, `on`, `ignoring`, `group_left` or `group_right` and a `paren` otherwise, `[`
a range (`bracket`). A closer pops only its own frame (`)` closes `paren` and `group`); an
unmatched closer is ignored. At most 64 frames are kept; deeper openers are counted and popped
first.

**Highlighting** (`extensions.ts`; colours of [Highlighting](#highlighting-t09-48)):

| Token | Tag |
| --- | --- |
| `ident` in a selector or grouping (checked first: `json` in `{json="1"}` is a label) | `labelName` |
| `ident` in `FUNCTIONS` or `CONVERSIONS` | `function(variableName)` |
| `ident` in `KEYWORDS` or `STAGES` | `keyword` |
| other `ident` | `variableName` |
| `string`, `rawString` (a backtick string over two lines stays a string) | `string` |
| `number`, `duration`, `bytes` | `number` |
| operators, `comma`, brackets | `operator`, `brace`, `paren`, `squareBracket` |
| `error` | `invalid` (no error colour) |

**Caret contexts** (`caretContext(text, pos)`). The token holding the caret is a string the caret
is inside (or at the end of, when unclosed), or a word, number, duration or digit-led error ending at
or running over the caret; a token that starts at the caret is not it. The mode stack and the last
two significant tokens before it decide:

| Context | When | Completes from | Lookup |
| --- | --- | --- | --- |
| `labelValue` | in a selector, after `name` and a matcher operator; quoted (`"` or `` ` ``) or not yet quoted | slot 1 | `labelValues(name, selector)` |
| `labelName` | in a selector, after `{` or `,` | slot 1 | `labelNames(selector)` |
| `stage` | after `\|` | slot 0 | `STAGES` |
| `duration` | in a range `[…]` | slot 0 | `1m 5m 10m 15m 30m 1h 6h 12h 24h` |
| `grouping` | in `by (…)` and the like, after `(` or `,` | slot 1 | `labelNames(first selector)` |
| `function` | at the start, after `(`, `,`, an operator, `and`, `or`, `unless` or `bool` | slot 0 | `FUNCTIONS` |
| `none` | in a line filter string, after a closed selector, anything else | — | — |

**Scope.** The selector of a lookup is the other complete matchers of the caret's selector (name,
operator, closed string) at its own depth, copied as written and joined by `, ` in `{…}`, matchers
after the caret included; the matcher being edited is left out, and so is any matcher whose value
holds a variable reference (`$name`, `${name}`): the browser never substitutes, and a literal `$app`
would narrow the lookup to nothing (T09-010). With no matcher left the scope is `null`, and the BFF
never receives `{}`. A grouping lookup is scoped by the query's first selector.

**Log source** (`createLogSource(deps)`). It retains the tenant's generation once. Each lookup reads
the window once, sends it snapped to whole minutes (`minuteWindow`), `limit` 1 000 and `query` only
when there is a scope, exactly as written; it is cached under `(tenant, 'logql', kind, label,
selector, bucket)` and passes the caller's signal to the cache.

| Method | Request |
| --- | --- |
| `labelNames(selector, signal?)` | `Api.logLabels(tenant, {fromMs, toMs, query?, limit: 1000}, signal)` → `GET /api/dash/v1/logs/labels` |
| `labelValues(name, selector, signal?)` | `Api.logLabelValues(tenant, name, {…}, signal)` → `GET /api/dash/v1/logs/label/{name}/values` |

Any error resolves `[]` and nothing is shown or logged (T09 §9): a bad selector, a reserved
`{source="pulsus-dash"}` scope the server refuses (400 `virtual_unsupported`, `queryInvalid`),
`tooBroad`, `busy`, `timeout`, `unavailable`, `network`, `badResponse`, an abort or an ended
generation. A new tenant needs a new source; retaining it aborts the old tenant's calls (T09-014).

### Completion timing

Both languages have two completion slots, so static lists do not wait for the lookup debounce
(T09-007, T09 §7: ≤ 16 ms for local completions). The shared parts (`RemoteLookups`, `afterQuiet`,
`remoteLookupsPlugin`) are in `src/editor/remoteLookups.ts`; each language passes the plugin its
own `LookupKeyAt`.

#### LogQL

The LogQL view uses `LOGQL_COMPLETION` (no typing delay, two slots). Every context belongs to
exactly one slot, and the other slot returns `null` synchronously, so CodeMirror never merges local
and remote options in one list.

| Moment | Slot 0 (local) | Slot 1 (remote) |
| --- | --- | --- |
| a typed character in a stage, function or duration context | the list at once (the first frame after the key) | `null` |
| a typed character in a label context | `null` | `afterQuiet(ctx, 120)`: every document change aborts the wait and starts a new one, so the lookup starts 120 ms after the last keystroke |
| Ctrl+Space (`startCompletion`) | after CodeMirror's 50 ms explicit start | no wait |
| Backspace | no new query (CodeMirror's `activateOnTyping`) | the same |

A fetch already started belongs to the view's `RemoteLookups` (one per view, created by
`logqlExtensions`), not to the CodeMirror query. `remoteLookupsPlugin` checks every document or
selection change while a lookup is pending:

| After the fetch started | Effect |
| --- | --- |
| a change whose caret context has the same key (typing `e` in `{app="w‸"}`) | kept; the next query of that key gets the same signal and shares the cache entry (one request) |
| a change to another key (`{pod="‸"}`) or to a non-remote context | this view's signal is aborted, which releases only this view's interest: the request aborts (and is not cached) only when no other view or unsignalled caller holds it |
| a query of another key in the same view | the old signal is aborted first (the same release) |
| the view is destroyed, or the document is over 131 072 code units | aborted |

An open remote result re-filters within its `validFor` without a new query. The guard wraps both
slots (T09-005, T09-015).

#### PromQL (#107)

The PromQL view uses `PROMQL_COMPLETION` (`{typingDelayMs: 0, slots: 2, updateSyncMs: 0}`), defined
in `lang/promql/complete.ts`. Both slots run the package's `HybridComplete`, so there is no PromQL
context classifier of our own:

- **Slot 0 (local)** awaits `analysisAt(state, pos, explicit)`: the package over
  `recordingSource(calls)`, a `PromSource` whose lookups record their call and resolve `[]` (so
  nothing is sent). The run yields the static options (functions, aggregations, keywords,
  operators, modifiers, durations, numbers, snippets) and the lookups the context needs, in call
  order; the **key** is `JSON.stringify(calls)`, or null with none. The analysis is memoised in one
  module-level entry by (document, syntax tree, position, explicit), so both slots of a request share
  one run. Slot 0 returns the statics in `LOCAL_SECTION`; with no statics it returns an empty result
  when the key is not null (so it holds a result whenever slot 1 can), else `null`.
- **Slot 1 (remote)** returns `null` at once when the key is null. Otherwise it records the view's
  epoch, waits `afterQuiet(ctx, 120)`, and starts nothing if the wait was aborted or the view changed
  or was destroyed meanwhile (`lookups.current(epoch)`). Then it runs the package over
  `withSignal(source, lookups.signalFor(key))` and keeps only the options the local run did not
  return (by identity: the package returns its module-level option objects; `offset` and `bool`,
  which it builds anew without a `type`, by label), in `REMOTE_SECTION`. A rejection resolves `null`.

`updateSyncMs: 0` is CodeMirror's `updateSyncTime`: without it a finished local slot would wait up
to 100 ms for the pending remote one before the list opens.

| `sum(r‸up)`, one key | Task | What happens |
| --- | --- | --- |
| 0 | input | CodeMirror queues its query with `setTimeout(0)`; the lookup plugin bumps the epoch |
| ~0 | timer | slot 0: the recording run (microtasks only), the functions from `from` 4 to the caret; slot 1: the memoised analysis, key `[["metricNames"]]`, then `afterQuiet(120)`; CodeMirror accepts slot 0 at once (`updateSyncTime` 0) |
| ~0 | timer | the local list opens, filtered by `r` (T09 §7: ≤ 16 ms) |
| 120 | timer | `signalFor(key)`; the package run over the real source; `cache.get(…, signal)`; the BFF on a miss |
| 120 + fetch | microtask | the metric names with their metadata, the statics left out, below every local option (T09-008) |

| Change while a lookup waits or is in flight | The wait (`afterQuiet`) | The in-flight fetch (`RemoteLookups`) |
| --- | --- | --- |
| any document change: a key of the same lookup (`sum(ra‸up)`), another key (`up{instance="‸"}`), a context without lookups (`rate(up[5‸`) | aborted by CodeMirror; slot 1 restarts, so the lookup starts 120 ms after the last key | `RELEASE_ON_CHANGE` gives no key, so the view's signal is aborted in the same update. The cache releases this view's hold; with no holder left the request aborts and is not cached. The next lookup gets a new signal |
| any selection change | — | the same |
| a query of another key in the same view | — | `signalFor` aborts the old signal first |
| the view is destroyed, or the document is over 131 072 code units | aborted | aborted |
| another view's lookup, any key | — | never affected (no supersession); another view's hold on the same request keeps it alive |

The epoch covers a context CodeMirror does not abort: when `languageCompletionAt` builds a fresh
context after `forceParsing`, its `afterQuiet` runs to the end, so the slot checks the epoch before
it starts anything. Every step is synchronous, so no stale result acts on a newer lookup.

**Order of an open list (T09-008).** A late result (one that settles while the list is open, with
no edit since it opened) never moves the highlighted item or anything above it: within one request
slot 0 settles first (both await the same analysis; slot 1 then waits and fetches); slot 0 holds a
result whenever slot 1 can, with the package's `from` and `validFor`, so CodeMirror keeps or
re-queries both together; and remote options rank below local ones (`REMOTE_SECTION` rank 1,
`LOCAL_SECTION` rank 0). The section headers are `completion-section` elements with
`style.display = 'none'` and `aria-hidden="true"` (set through CSSOM, so the CSP allows them), so
the list looks like one list. After an edit CodeMirror re-filters by the new prefix and keeps the
selected option when it survives the filter.

### Accepting a completion

`replacing(text, kind)` is every LogQL option's `apply`. At accept time it measures the caret
context again on the current document and, when its kind is the option's, replaces `[from, end)`:
the whole token or value under the caret, never a suffix of it and never a `}`. The result's `to`
stays the caret, so CodeMirror still filters by the typed prefix (`w` in `{app="w‸rong"}` shows
`web`).

| Under the caret | `end` |
| --- | --- |
| a quoted value that is well closed (its closing quote is there and `}` or `,` follows) | before the closing quote (spaces and commas inside it are value) |
| a quoted value that is not well closed (unclosed; or closed and followed by anything else, the end of the query included) | the first `"`, `` ` ``, `}`, `,` or whitespace at or after the caret, else the end; the closing quote is appended unless that stop is the value's own quote |
| a name, word, unquoted value or range | the end of the token |
| nothing | the caret |

Values are escaped for the quote in use: `\`, `"`, LF, CR and tab inside `"…"`; backtick strings
are inserted as is and values holding a backtick are not offered there; an unquoted value is
inserted in double quotes. Examples: `{app="w‸rong"}` → `{app="web"}`; `{app="w‸rong` →
`{app="web"`; `{app=w‸x}` → `{app="web"}`; `rate({a="b"}[1‸0m])` → `rate({a="b"}[1h])`.

**PromQL** (#107, `lang/promql/replace.ts`). Each PromQL result's `to` is the caret, so CodeMirror
filters by the text before it. `replacing(o, section)` wraps every option: at accept time it reads
`replaceRange(view.state, to)` on the current syntax tree and replaces `[from, end)` with the
option's text (its `apply` string, else its label) plus `suffix`; a snippet's own `apply` is called
with `end`. With `n` the node before the caret, the first row that matches applies, and `end` is
never before the caret:

| # | Under the caret | `end`, `suffix` |
| --- | --- | --- |
| 0 | the tree does not reach the caret | the caret |
| 1 | an error node | the caret |
| 2 | after a closed function call body `(…)` | the caret |
| 3 | inside `{…}`, `by (…)`, a call's `(…)`, `[…]` or a subquery | before the closing bracket |
| 4 | a label value that is **well closed**: its closing quote is there and not escaped (an even run of `\` before it, for `"` and `'`), and `}` or `,` is the next non-space | before the closing quote |
| 5 | a label value that is not well closed (unclosed; or closed and followed by anything else, the end of the query included) | the first unescaped `"`, `'`, `` ` ``, `}`, `,` or whitespace at or after the caret, else the end; the value's quote is appended unless that stop is the quote itself |
| 6 | any other node (a metric, label or function name) | the end of the token |

Rows 1–4 and 6 are the package's own end rule (`computeEndCompletePosition` in 0.316.0, which it
does not export); `unit:promql-replace` P checks the equality with the package on 350 carets of a
15-query corpus. Row 5 is LogQL's rule for a value that is not well closed. In row 5 a `\` and the
character after it are value inside `"…"` and `'…'` (a caret right after a `\` starts the scan one
character later); backtick strings have no escapes. Values are escaped by the package for `"` and
`\` in every quote. Examples (R1–R18): `{app="w‸rong"}` → `{app="web"}`; `up{app="w‸rong` →
`up{app="web"`; `up{app="w‸rong}` → `up{app="web"}`; `up{app="w‸rong, x="1"}` →
`up{app="web", x="1"}`; `up{app="w‸x, y"}` → `up{app="web"}`; `up{app="w‸x\"z` → `up{app="web"`;
`up{ap‸xx="v"}` → `up{app="v"}`; `htt‸p_requests_tot{job="a"}` → `http_requests_total{job="a"}`;
`sum by (jo‸x) (up)` → `sum by (job) (up)`.

### Completion probe

`bench:promql-completion-latency` installs `window.__pulsusCompletionProbe` (`COMPLETION_PROBE_GLOBAL`)
before the page loads, as `bench:editor-keystroke` installs the editor probe. `promqlExtensions`
reads it once per view (`completionProbe()`); a probe set later is never called, and in normal use
there is none and the slots never call `performance.now()`. The slots report their main-thread work
in ms, each when it ends, and no timer spans an await: each part is one synchronous segment.
`slot0entry` and `slot1entry` run from a slot's entry to its await on the shared analysis (the
slot that runs first computes the analysis inside its entry, so it is counted once); `slot0` runs
from resuming to slot 0's result, `slot1pre` from resuming to slot 1's wait, and `slot1post` from
the remote run settling to the result built. The fetch wait is not counted, and neither is
anything that runs while a slot waits on the analysis (other microtasks, and the package's own
continuation of the analysis): it falls between segments. A reader takes the union of the
intervals `[end − ms, end]`; the bench does (`src/test/completionWork.ts`).

### The LogQL editor harness (`dev/logql-editor`)

`/t/<tenant>/dev/logql-editor?q=<text>` renders the real `LogQLEditor` (accessible name `LogQL
query`, page title `LogQL editor bench`) over an in-memory `LogSource` that answers at once
(`app`, `env`, `level`, `pod`; values `checkout`, `web`), so the editor benches time the client,
not a network. The route sits next to the chart gallery inside the dev-and-stub-build condition of
`router.tsx`, so http builds leave it out (CI's "http build has no gallery" step covers every
`src/dev/` module). The page loads the editor with a dynamic import of `logqlEditor.ts`; its own
chunk is not an `editor-*` chunk.

### Testing an editor in jsdom

Tests build a view with `viewIn(o)` (`src/test/viewIn.ts`): a host on `document.body`, an open
shadow root, a mount `<div>` in it; `destroyViews()` after each test. Keys go through
`runScopeHandlers(view, keydown, 'editor')`; jsdom is not a Mac, so Mod is Ctrl. After
`startCompletion`, wait for `completionStatus === 'active'`, then 100 ms (CodeMirror ignores
accept keys for 75 ms after a popup opens). `fakePromSource(F)` (`src/test/fakePromSource.ts`)
returns fixed data and records each call (`'labelValues job up'`); `FM`, `FQ` and `FH` are the data of
the mid-token, quoted-value and T09-008 rows, and `pendingPromSource()` holds each lookup until
released and settles `[]` when its signal aborts (a lookup without a signal throws). Compositions are synthetic
`CompositionEvent`s on `view.contentDOM` with `input.type.compose` transactions. LogQL tests use
`fakeLogSource(FL)` and `pendingLogSource()` (`src/test/fakeLogSource.ts`: fixed data, or calls
held until released and settled `[]` when their signal aborts), the caret cases of
`src/test/logqlContextCases.ts` (`‸` marks the caret), and fake timers for the 120 ms debounce. jsdom
has no `ShadowRoot.delegatesFocus`, so the host test reads it from the `attachShadow` call.
`src/test/editorDom.ts` (imported by `viewIn` and the host test) defines what jsdom lacks: text
ranges without layout (`getClientRects`, `getBoundingClientRect`), which CodeMirror measures when it
scrolls the caret into view, and `execCommand`, which its selection read in a shadow root falls back
to on focus. Vitest resolves `@prometheus-io/codemirror-promql` to its ES module build (it has
no `exports` map, and its CommonJS build would load a second `@codemirror/state`), as the browser
build does.

## Page

Explore › Metrics (`src/pages/explore/`, Part C) is two cards: **Query** and **Result**. It adds no
server, wire or database change.

### Components and state owners

| Module | Owns or renders |
|---|---|
| `MetricsPage.tsx` | The state owner. The draft in a ref (typing re-renders nothing unless a flag flips), `dirty` (draft ≠ `q`), `draftOver` (`overQueryLimit(draft)`), `runRefusal`, `sort`, `isolatedKey` (D-ISO), the editor and Run button refs, and the `PromSource` (`useMemo` on the editor module, API, query client and tenant; the window is read through a ref on each lookup) |
| `QueryCard.tsx` | `PromQL` tag, `MetricPicker`, Run hint, **Run** (disabled until `runReady`, described by the status row), the editor or its placeholder (`Loading the editor…`, or an alert when the chunk failed to load), the status row |
| `QueryStatus.tsx` | `statusView` and its rendering: `refused` and `error` as `role="alert"` (Narrow for `tooBroad` and `timeout`), `limit`, `waiting` and `ok` as `role="status"`, else nothing |
| `MetricPicker.tsx` | React Aria `ComboBox` (`Metric`), opens on focus; while its list is open the rest of the page is `inert` as well as `aria-hidden` (`src/kit/inertOutside.ts`), released on close, on Tab and before a pick moves focus to the editor; names are `['prom', tenant, 'pickerNames']` (60 s stale), asked only after the first open; options from `metricOptions` (at most 100, type and help); Enter with no option highlighted picks the first match |
| `ResultCard.tsx` | Toolbar (`SegmentedControl` *Visualisation*, the **Rate applied** chip, **Sent query** when the server rewrote it (`planned.query`)), `CompletenessNotice`, the chart host (always mounted, so its width is known before the first Run; the 2 px shimmer after 300 ms, `aria-busy`), `<ChartFrame>` or the notice text, `SeriesTable` |
| `CompletenessNotice.tsx` | `Partial data` badge with its warnings and Narrow when truncated; `Warnings` badge without truncation; `Notes` for infos; five items each, then `and n more` |
| `SeriesTable.tsx` | Sortable table (Series, Last, Max) in a focusable scrolling region; row buttons isolate (`aria-pressed`) when the vis can isolate; others dimmed; first 500 rows |
| `src/kit/inertOutside.ts` | `inertOutside(keep)`: `inert` on everything outside `keep` (and React Aria's live announcer), new nodes included; an idempotent release removes only its own. React Aria's ComboBox hides the page with `aria-hidden` only, which leaves its controls focusable (axe `aria-hidden-focus`) |
| `src/kit/SegmentedControl.tsx` | React Aria `ToggleButtonGroup`, single selection: a `radiogroup` whose arrow keys move the one tab stop; the selected option cannot be deselected |
| `src/explore/useExploreRun.ts` | The run: `runnable`, `runKind`, `refusalOf`, `exploreRunKey`, `useExploreRun` (below) |
| `src/explore/useEditorModules.ts` | Starts `LANGUAGES.promql()` and `import('../editor/editor')` on mount; a rejection sets `failed` |
| `src/explore/useDelayedFlag.ts`, `useElementWidth.ts` | True once a flag has been on for a delay; the chart host's content width in whole CSS px through one `ResizeObserver` (`0` is `null`) |
| `src/explore/statusText.ts`, `metricOptions.ts` | Error, outcome and refusal texts; the picker filter and descriptions |

### The run hook and D-RUN

`useExploreRun({tenant, q, inputs, widthPx, window})`, `inputs = {lang, stepMs, rate}`:

- `kind = runKind(q, lang)`: null for blank text or before the language loads.
  `runnable(inputs)`: the language and the step are known (the step is
  `promGrid(fromMs, toMs, widthPx).stepMs`).
- `refusal = refusalOf(q)`: `queryTooLarge` above 128 KB of UTF-8 (T09-015); nothing else is
  refused here, the server checks the planned size.
- The query key is `['data', 'explore', tenant, q, kind, rate, fromMs, toMs, step]`; the request
  is enabled when `kind` is known, the inputs are runnable and there is no refusal. A rate toggle is
  a new key and one request. A new key aborts the old request (TanStack Query aborts the signal of a
  query that loses its observer; PRF-030). `widthPx` is read through a ref, so a width change
  within one step does not refetch.
- The outcome is `{text: q, planned, result, durationMs}`, `planned` from the response.
- `placeholderData` keeps the previous key's outcome only from the same tenant, so a window-only
  change keeps the chart frame and its data (the frame is not remounted).
- **D-RUN:** the last success that is not a placeholder is kept in hook state with its tenant.
  `shown` is null when `q` is empty; on an error it is the kept outcome; otherwise the current data,
  else the kept outcome. An error or a pending key never blanks the chart. `last` lives for the
  page mount only.
- `rerun()` = `cancelQueries({queryKey: key, exact: true})`, then `refetch()`: the cancel (revert)
  aborts the request in flight, its first fetch included, and dispatches no error; the refetch
  starts a new request. `refetch({cancelRefetch: true})` alone would reuse a first fetch.
- `error` is null for an `AbortError`.

### Run order and refusals

`runReady` = the editor chunk loaded and `runnable(inputs)`. Until then **Run** is disabled and the
status reads `Run is available once the chart has a size.` The page does not wait for metric types.

Run (button, Shift+Enter, Mod+Enter), first match, on the draft `d`:

| Case | Effect |
|---|---|
| `d` blank | `q` removed (push): the empty state, no request |
| `overQueryLimit(d)` | `queryTooLarge` alert; no navigation, no request (QC1) |
| not `runReady` (only a key reaches this) | nothing |
| `d ≠ q` | `q = d` (push): a new key |
| `d = q` | `rerun()` |

A draft between 64 KiB and 128 KB is run: `q` is written, the server answers 413 and the status
shows `explore.error.tooLong` (ADR-0021 consequences; QC1 now holds only for the 128 KB
pre-check). While the draft is over 128 KB the same text shows as a status (the T09-015
explanation). A URL query over 128 KB (a shared link) shows the refusal as an alert and sends
nothing.

The status line, first match: a refused Run; the draft over 128 KB; the URL query refused; not
ready; the run error ([below](#errors-and-status)); the outcome (`3 series · step 5 s · 120 ms`,
`1 series · 120 ms`, `Scalar · …`, `String · …`).

### Errors and status

| Error | Status text (alert) | Narrow |
|---|---|---|
| `queryInvalid` | the first diagnostic's message (with ` (position unknown)` when PulsusDB gave none), else the message; the editor underlines it while the draft is unchanged | — |
| `tooBroad` | the message | yes |
| `timeout` | `The query timed out. Narrow the time range or the query.` | yes |
| `busy` | `Too many queries are running for this tenant. Try again in a moment.` | — |
| `unavailable` | `PulsusDB is unavailable: <message>` | — |
| `network` | `The server could not be reached.` | — |
| `notFound` | `This tenant no longer exists.` | — |
| `queryTooLong` | `The query to send, with any rate applied, is over 64 KiB, the most the server accepts. Shorten it.` | — |
| any other | `The query failed: <message>` | — |
| `AbortError` | not shown | — |

Narrow dispatches the Context `zoom in` (the middle half of the window). Diagnostics are
`lang.diagnosticsOf(q, error, (i) => i, q)` while the draft equals `q`, else `[]`; the editor sees
a new array only when those inputs change. A missing variable (Explore has no variables) is the
generic `The query failed: no value for variable $name`.

### Empty query, string results and isolation

- `q` empty: the Result card shows only the chart host with the empty state; no toolbar, notice,
  frame or table, even with a previous success (which stays cached for Back).
- A string result is drawn as `String result: <value>` under every vis option; the first option
  reads `Auto` (no auto vis), otherwise `Auto (<vis>)`.
- `isolatedKey` survives new results: `framePlan` ignores a key the result lacks, and then no row
  is pressed or dimmed. Row buttons show only when `canIsolate(vis, result)`; swatches only when
  the vis is not a heatmap.

### Ownership and lifetimes

| Resource | Owner | Lifetime |
|---|---|---|
| Editor and language modules | `useEditorModules` state; the browser's module cache | page mount; one fetch per page load |
| `PromSource` | `MetricsPage` | until the tenant changes (a new source retains the new tenant in the suggest cache, T09-014) |
| Run query, metadata, picker names | the `QueryClient` | `gcTime` defaults |
| `last`, `isolatedKey`, `sort`, draft state | React state | page mount (not in the URL) |
| `ResizeObserver` | `useElementWidth` | while the host is attached |
| `<ChartFrame>` and its engine frame | `ResultCard` | while there is frame data; a window-only change keeps it |

All work runs on the main thread in React effects and TanStack callbacks; the only timer is
`useDelayedFlag`'s (cleared on change and unmount), and one run query is observed at a time.

### Refresh, time changes and the chart (ADR-0019, #93)

The header's **Refresh now** and the auto-refresh tick call the shell's `refreshNow()`, which
cancels and then invalidates `['data']`, so a request in flight (a first fetch included) is aborted
and a new one starts; with a relative window the window moves and a new key runs. A time change
(picker, brush, window keys, a chart zoom or pan commit) is a new key. Explore passes no `pending`
prop to `<ChartFrame>` (ADR-0019): the frame is kept across reruns with the previous data drawn, so
the only blank canvas is the first draw, under the shimmer. A chart zoom or pan commit (#93) is a
Context `setRange` inside `<ChartFrame>`, a time change here, and the frame survives the refetch
because a window-only key change keeps its data.

### Chunk naming and the closure budget

`vite.config.ts` names every chunk that holds an editor module `assets/editor-<hash>.js`
(`build.rolldownOptions.output.chunkFileNames`). Editor modules are `src/editor/` except
`lang/index.ts` and `lang/types.ts` (the route imports them), and the 17 packages of
`dependency-policy.json` `runtimeClosure.query-editor`. Rollup's own split is kept (no manual
chunks). The editor imports some modules from other chunks: the initial entry (React, `t`), shared
chunks and the route chunk, where Rollup places `explore/promMetadata` and `explore/querySize`
because the route loads first.

`ci:bundle-size` measures the editor closure: the files of the `editorModules` entries
(`src/editor/editor.ts`, `src/editor/lang/promql/promql.ts`, `src/editor/lang/logql/logql.ts` and
`src/editor/logqlEditor.ts`; all but the last in `required.lazyModules`, because `logqlEditor.ts` is
a manifest entry only in builds with the LogQL harness route until the Logs page imports it, and an
entry missing from the manifest is skipped) and every `assets/editor-*.js` file reachable from them
through static manifest imports, walking only through `editor-*` files; other imported chunks keep
their own initial or lazy rows, so each byte is counted once. The stub build measures 7 files, about
135 KB brotli (budget 175 000 for the union, ADR-0014 §8); the route chunk `MetricsPage-*` keeps its
own `lazyChunk` row (budget 120 000). See
[Build, test and CI](../development/build-and-ci.md#bundle-budgets).

### Testing the page

Page tests mock the editor chunk with `src/test/fakeEditor.tsx`:
`vi.mock('../../editor/editor', () => import('../../test/fakeEditor'))`. Its `PromQLEditor` is a
`<textarea>` controlled from `value` as the real host is (a changed value replaces the text and is
reported through `onChange`), with the Run keys, Escape, `focus()`, `insert()` and the latest
diagnostics in `data-diagnostics`. `createPromSource` returns a `fakePromSource` of
`fakeEditorSource.data` (default `F`, which a test may replace); `promql` and `LANGUAGES` are the
real modules. `src/test/exploreTestKit.tsx` renders the app with a fake engine and has spies that
answer, reject or hold `queryRange` and `queryInstant`; their results carry
`plannedAs(query, facts?, stepMs?)`, the `planned` of a text sent as is (a test of histogram or
rate behaviour passes the facts the server would give). The chart host has no width until a test
calls `resizeAll` (a browser's `ResizeObserver` reports on observe), so tests that render the page
install the fake `ResizeObserver`.

## Gates

| Gate                                                                                                                                      | File                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit:plan-parity` (TS), `unit:plan-shape` (stub) | `src/api/stub/plan.test.ts`, `promShape.test.ts`: every case of `wire/fixtures/plan/promql.json` through the stub path (plan or refusal, `to_source`, `needsTypes`, Classify, the window, metric kinds, bytes, the byte guard), and the stub shape and function table equal to the Go parser's |
| `unit:stub-plan-boundary` | `scripts/stub-plan-boundary.test.ts`: the mirror import refused at `src/explore/x.ts`, allowed at `src/api/StubApi.ts` |
| `unit:autovis-table`                                                                                                                      | `src/vis/autovis.test.ts`: one fixture per rule, rule order, range never stat, the override                                                                                                                                                                                                                                                                                                                            |
| `unit:heatmap-buckets`                                                                                                                    | `src/vis/histogram.test.ts`: complete, missing single and grouped samples, groups with differing bounds, row isolation, and many-group, many-bound allocation checks: Float64 elements allocated stay within the output plus the axis, eligibility allocates none, and doubling the groups doubles the allocation (`src/test/allocations.ts` counts them). Wall-clock times are printed only, never asserted (T05-006) |
| `unit:frame-plan`                                                                                                                         | `src/vis/framePlan.test.ts`: every vis × result valid, bars over instant series with unequal timestamps, the bars grid bound (500 series × 1 000 disjoint timestamps gives the notice with allocation linear in the input; exactly `MAX_GRID_CELLS` draws, one more timestamp gives the notice), scalar overrides, heatmap row isolation and restore                                                                   |
| `unit:series-rows`                                                                                                                        | `src/explore/seriesRows.test.ts`                                                                                                                                                                                                                                                                                                                                                                                       |
| `unit:explore-params`                                                                                                                     | `src/state/exploreParams.test.ts`, with `useExploreParams.test.tsx` and the `router` explore canonical test                                                                                                                                                                                                                                                                                                            |
| `unit:decode-frames` (prom)                                                                                                               | `src/data/decode.test.ts`                                                                                                                                                                                                                                                                                                                                                                                              |
| `unit:columns` (merge keeps missing)                                                                                                      | `src/engine/canvas2d/columns.test.ts`                                                                                                                                                                                                                                                                                                                                                                                  |
| `bench:frame-interim-heatmap`                                                                                                             | `e2e/perf-heatmap-draw.spec.ts` ([Build, test and CI](../development/build-and-ci.md#tests))                                                                                                                                                                                                                                                                                                                           |
| `unit:promql-shape`                                                                                                                       | `src/editor/lang/promql/promql.test.ts`: the 23 shape rows (comments, value types, `histogram_quantile`, error nodes)                                                                                                                                                                                                                                                                                                  |
| `unit:promql-diagnostics`                                                                                                                 | `src/editor/lang/promql/promql.test.ts`: bytes to UTF-16 (multi-byte, pairs, lone surrogates), positions D1–D9, and a raw-byte position placed by the identity mapping                                                                                                                                                                                                                                        |
| `unit:suggest-cache`                                                                                                                      | `src/editor/suggestCache.test.ts`: C1–C19 (C5, C17: no in-flight entry is superseded by another key, evicted or not; C19: an evicted in-flight LogQL entry is re-joined by its key), the key by language, a LogQL get that leaves an in-flight PromQL entry alone, and the caller signals G1–G7, with no unhandled rejection in any case |
| `unit:promql-completion`, `unit:promql-replace`, `unit:promql-completion-timing`, `unit:promql-cancel` | `src/editor/lang/promql/complete.test.ts`: Q1–Q9 (the two slots per context, results at the caret, sections, the recording run sends nothing), R1–R18 (whole documents after accepting), P1–P7, P9, P10 (timing and T09-008 order under fake timers), Y1–Y13 (release on every change, the epoch, the real stack across views), Z1 (`unit:promql-completion-probe`: the two slots' probe intervals overlap and count once, on an injected clock); `src/editor/lang/promql/replace.test.ts`: E1–E18 and the package parity P; P8 in `src/editor/PromQLEditor.test.tsx` |
| `unit:logql-lex`, `unit:logql-state` | `src/editor/lang/logql/lexer.test.ts`: L1–L16, a 1 000-text property (contiguous tokens, never throws), S1–S5 |
| `unit:logql-highlight` | `src/editor/lang/logql/extensions.test.ts`: H1–H7 |
| `unit:logql-context` | `src/editor/lang/logql/context.test.ts`: C1–C49 and C9b (`src/test/logqlContextCases.ts`) |
| `unit:logql-completion`, `unit:logql-replace`, `unit:logql-cancel` | `src/editor/lang/logql/complete.test.ts`: K1–K13 (each context in one slot, slot 0 never a promise), M1–M21 (whole documents after accepting), X1–X9 (in-flight lookups kept, released and shared, over `pendingLogSource` and the real source and cache) |
| `unit:log-source` | `src/editor/lang/logql/logSource.test.ts`: S1–S8 |
| `unit:lookup-window` | `src/editor/lang/lookupWindow.test.ts` |
| `unit:logql-diagnostics` | `src/editor/lang/logql/logql.test.ts`: D1–D9 (D8: the offset counts in the raw text, never in `planned.query`) |
| `unit:diagnostics-shared` | `src/editor/lang/diagnostics.test.ts`: PromQL re-exports the shared functions |
| `unit:logql-editor`, `unit:logql-completion-timing` | `src/editor/LogQLEditor.test.tsx`: the host (shadow root, label, run keys, Escape, diagnostics, completion and accept, a rerendered source, read-only, composition, unmount); T1–T4 under fake timers |
| `unit:router-dev-logql` | `src/app/router.test.tsx` |
| `unit:prom-source`                                                                                                                        | `src/editor/lang/promql/promSource.test.ts`: S1–S15 (requests, buckets, the caller's signal passed to every lookup, failures, series, tenant switches, metadata, ended tokens, the minute and second windows)                                                                                                                                                                                                                                           |
| `unit:prom-client`                                                                                                                        | `src/editor/lang/promql/promClient.test.ts`: `selectorOf`, `decodeLabelName`, `matcherContextAt` and `toPrometheusClient` rows                                                                                                                                                                                                                                                                                         |
| `unit:editor-keys`, `unit:editor-completion`, `unit:editor-doc`, `unit:editor-diagnostics`, `unit:editor-no-linter`, `unit:editor-styles` | `src/editor/view.test.ts`                                                                                                                                                                                                                                                                                                                                                                                              |
| `unit:editor-composition`, `unit:editor-size`                                                                                             | `src/editor/completionGuard.test.ts`: K1–K5, Z1–Z6                                                                                                                                                                                                                                                                                                                                                                     |
| `unit:query-size`                                                                                                                         | `src/explore/querySize.test.ts`: Q1–Q6                                                                                                                                                                                                                                                                                                                                                                                 |
| `unit:editor-host`                                                                                                                        | `src/editor/PromQLEditor.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                     |
| `unit:lang-table`                                                                                                                         | `src/editor/lang/index.test.ts`: PromQL and LogQL load (LogQL's shape is `UNKNOWN_SHAPE`), TraceQL and profiles reject |
| `HttpApi` and `StubApi` log completion | `src/api/HttpApi.test.ts`, `src/api/StubApi.test.ts` |
| `unit:window-keys`                                                                                                                        | `src/state/useWindowKeys.test.tsx`: an editable element in a shadow root, a shadow host in a dialog, and an event without a path                                                                                                                                                                                                                                                                                       |
| `unit:explore-run-size` | `src/pages/explore/MetricsPage.test.tsx`: R1–R8 (128 KB of draft or URL query refused before sending; drafts whose plan is over 64 KiB sent and answered 413 by the stub; `rate=off`; the width arriving after the draft; metric types the stub's, not a gate) |
| Page component tests | `src/pages/explore/MetricsPage.test.tsx` (run on load, no metadata wait, scalar, histogram, string, supersede, frame kept, refresh, interval refresh, refresh and rerun during the first fetch, shimmer, errors, partial data, warnings, rate and vis, run keys, escape, picker, away and back, empty query, isolation, tenant switch, heatmap isolation), `SeriesTable`, `MetricPicker`, `CompletenessNotice`, `src/kit/SegmentedControl.test.tsx`, `src/pages/board/BoardPage.test.tsx` (Refresh leaves panel queries) |
| Hook and helper tests | `src/explore/useExploreRun.test.tsx`, `useDelayedFlag.test.tsx`, `useElementWidth.test.tsx`, `statusText.test.ts`, `metricOptions.test.ts` |
| `e2e:explore-sends-inputs` | `e2e/explore-metrics.spec.ts` (in `e2e:metrics-autovis counter`): the request body holds the raw `http_requests_total` and `rate: true`; the fake records `rate(http_requests_total[1m])` |
| `e2e:explore-completion`, `e2e:metrics-autovis`, `e2e:editor-error-on-run`, `e2e:series-table`, `e2e:explore-cancel`, `e2e:explore-truncation`, `e2e:explore-refresh`, `e2e:lazy-load` (explore) | `e2e/explore-metrics.spec.ts` (against `pulsus-fake` through the http-mode BFF; lazy-load on the stub build) |
| `e2e:explore-picker-inert` | `e2e/explore-metrics.spec.ts` (http BFF, three engines): P1–P6, the page inert while the list is open; Tab, Shift+Tab, Escape, a pointer press outside and a pick each release it |
| `inertOutside`, `MetricPicker inert`, `unit:editor-probe` | `src/kit/inertOutside.test.ts`, `src/pages/explore/MetricPicker.test.tsx`, `src/editor/view.test.ts` (the editor probe and the completion probe, each read once per view) |
| `e2e:deep-link` (explore) | `e2e/deep-link.spec.ts` |
| `e2e:editor-ime` | `e2e/editor-ime.spec.ts` (Chromium) |
| `bench:editor-keystroke` | `e2e/perf-editor-keystroke.spec.ts` (Chromium): a PromQL case on Explore › Metrics and a LogQL case on the `dev/logql-editor` harness; the editor's update per key through `src/editor/probe.ts` (p95 ≤ 2 ms) and a trace of the keys through `scripts/longTasks.ts`; the interim CI check blocks, the rest with `EDITOR_BENCH_GATE=enforce` ([Build, test and CI](../development/build-and-ci.md#tests)) |
| `bench:logql-completion-latency` | `e2e/perf-logql-completion.spec.ts` (Chromium): keydown to popup on the harness, local and remote ([Build, test and CI](../development/build-and-ci.md#tests)) |
| `bench:promql-completion-latency` | `e2e/perf-promql-completion.spec.ts` (Chromium): keydown to popup on Explore › Metrics, local (a 1 KB query) and remote, the work per local key (`keyWork`, the union of the probes' intervals) and long tasks; its arithmetic and enforce gate in `src/test/completionWork.ts`, checked by `src/test/completionWork.test.ts` (W1–W3, G1–G3) ([Build, test and CI](../development/build-and-ci.md#tests)) |
| `e2e:a11y-rooms`, `e2e:csp-violations` (explore) | `e2e/a11y-rooms.spec.ts`, `e2e/keyboard.spec.ts` (L32, `e2e/keyboardExplore.ts`), `e2e/csp-violations.spec.ts` |
| `ci:bundle-size` (editor closure) | `scripts/bundle-size.test.ts` (h)–(k) and the real build |

The editor's budgets are measured with the page: PRF-005 keystroke work by `bench:editor-keystroke`
(report only on shared CI) and PRF-009 by the editor closure row of `ci:bundle-size`; its browser
gates are `e2e:csp-violations`, `e2e:lazy-load` and `e2e:editor-ime`.

Editor design rules: [T09](../../designs/technical/T09-query-editors.md) T09-001 (one interface per
language), T09-002 (no client-side validity), T09-003 (Lezer highlighting for PromQL, the stream
tokenizer for LogQL), T09-004 (keys), T09-005
(composition), T09-006 (one history), T09-007 (lookups, window bucket, the two slots of each
language and their release), T09-008 (late results never move the highlighted item), T09-009 (run error position), T09-010 (no substitution in a lookup scope), T09-014
(cache keyed by tenant, dropped on switch), T09-015 (128 KB);
[ADR-0014](../../designs/adr/0014-typescript-react-web-client.md) §1 (CodeMirror), §7 (supply
chain), §9 (CSP).
