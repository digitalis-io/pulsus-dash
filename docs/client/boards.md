# Boards: panel runtime

How a board panel runs its PromQL query (#64 Part A): the run hook and its key, the window epoch,
the time gate on first open, visible-only queries, the panel states and menu, and the query field
of the panel editor. The board page itself (modes, saving, sections, the filter bar) is in
[Client application › Boards](README.md#boards); the user's view is [Boards](../user/boards.md).

| Module | Role |
|---|---|
| `src/boards/usePanelRun.ts` | the run hook: inputs, key, query, the facts read back |
| `src/boards/panelRun.ts` | the key (`panelRunKey`, `panelIdleKey`, `sameExceptWindow`, `sameKey`) and `panelView` |
| `src/boards/variableRefs.ts` | `referencedVariables`, `panelVars` |
| `src/boards/boardRun.tsx`, `boardRunContext.ts` | `BoardRunProvider` and `BoardRunContext` (vars, widths, visibility, `timeReady`); the window epoch |
| `src/boards/visibility.ts`, `panelWidths.ts` | the shared viewport tracker; the panel width store |
| `src/boards/boardTime.ts` | `boardTimeInit`, `isTimeReady` (first open) |
| `src/boards/exploreLink.ts` | `exploreHref` |
| `src/boards/useQueryLanguage.ts` | one `LANGUAGES.promql()` per page load |
| `src/pages/board/PanelFrame.tsx`, `PanelNotices.tsx`, `PanelQueryField.tsx`, `PanelEditor.tsx` | the panel chrome, the completeness badge, the editor's Query field |

## What a panel sends (ADR-0021)

A panel sends **inputs, never a planned text** (T06-029): the server's `prom.Plan` (#112)
substitutes, rewrites and size-checks the query and returns `planned`.

| Route | Request |
|---|---|
| range | `queryRange(tenant, {query: text, fromMs, toMs, widthPx, vars, rate: true})` |
| instant | `queryInstant(tenant, {query: text, atMs: toMs, vars, stepMs})` |

- `text` is the panel text as saved, raw (or the dialog's run text, below).
- `vars` is `panelVars(text, vars)`: the `var-<name>` values of the URL for the variables the text
  references (`referencedVariables`: `$name` and `${name}`, not `$__…` macros, at most 64
  characters), sorted by name; `{}` when it references none. Unreferenced variables are not sent.
- `widthPx` is the panel body's width, read through a ref when the query function runs (a width
  change within one step does not refetch). `stepMs` is `promGrid(fromMs, toMs, widthPx).stepMs`
  for both routes; the instant route sends it so the server can size `$__interval` and the rate
  window.
- The route comes from the Lezer `shape(text).valueType` of the **raw** text (`runKind`, shared
  with Explore): `instant` for a scalar or string, else `range`. A scalar whose `$var` breaks the
  parse goes to the range route and draws as a one-series line; the saved override Stat still
  applies (plan R7).

From the response, `planned.rateApplied` and `planned.histogram` feed auto-vis and the unit ("in
/s"), and `planned.expanded` feeds Open in Explore. The hook reads no metric metadata: the server
(or the stub's planning mirror) resolves the types.

## The key

```
['data', 'panel', tenant, id, text, vars, kind, stepMs, fromMs, toMs]   // a run
['data', 'panel', tenant, id, text, null]                               // idle: nothing can be sent
```

The head is indices 0–6 (`PANEL_KEY_HEAD`). `vars` is the JSON of the `panelVars` pairs. The idle
key is used while the run is blocked, the language or width is unknown, or the board's time is not
set; it is never enabled. The prefix `['data']` puts panels under the shell's refresh rule
([Client application › Routes](README.md#routes-adr-0017): every `['data']` key carries the
resolved window). `vis.kind` is not in the key: the result does not depend on it, so a
visualisation change is a redraw (`framePlan` of the same outcome), never a request.

### Placeholder and Loading

`placeholderData` keeps the previous outcome only when the previous key was a run key with the
same head and did not end in an error (`sameExceptWindow`): a time change, a zoom or pan commit
(#93), a relative refresh or a resize that changes the step keeps the chart mounted, with the
shimmer after 300 ms. A head change (query, variables, kind, tenant) shows `Loading` until the
result (#90). Another tenant's data never shows: the tenant is in the head.

### Freshness: the window epoch

The queries use `staleTime: Infinity`, so a result is fresh until marked. `BoardRunProvider` marks
every `['data', 'panel', tenant]` query invalid **without refetching**
(`invalidatePanelEpoch`: `invalidateQueries({queryKey, refetchType: 'none'})`) on the first render
with `timeReady` (a board open) and on every change of the resolved window (`fromMs:toMs`). The
mark is a layout effect, so it lands before the panels' passive effects move their observers to
the new keys. Then:

| Event | Requests |
|---|---|
| board open | each visible panel once (a cached result from an earlier visit is marked) |
| time change, including A → B → A | each visible panel once, cached or not; off-screen panels when they scroll in |
| scroll out and in, same epoch | none: a success clears the mark |
| Refresh now, absolute window | `refreshNow()` cancels and invalidates `['data']`: visible panels once; off-screen ones when they scroll in |
| Refresh now, relative window | the window moves: new keys and a new epoch, one request per visible panel |
| variable change | only the panels whose `vars` element changes (T07-013) |
| visualisation change | none |

Explore's keys keep their own freshness (#63); the epoch covers panel keys only.

## The board's time on first open (IA-002)

The tenant loader (`app/router.tsx`) leaves a board URL with neither `from` nor `to` to the page
(no normalising redirect). `BoardEditor`'s first-open effect calls
`boardTimeInit({search, linkState, saved, nowMs, timeZone})`:

| # | Link state | URL has `from` or `to` | Saved time | Navigation |
|---|---|---|---|---|
| I1 | any | no | set | the saved time (through `contextReducer`'s `setRange`; a rejected one leaves the default) |
| I2 | any | no | none | the normalised default (`now-1h` to `now`) |
| I3 | a board link | yes | set | the saved time, unless the URL already holds it |
| I4 | otherwise | | | none |

It makes at most one `replace` navigation (the time and the cleared link state), ticks the clock
when the window changes, and sets the target. `timeReady` latches while rendering once
`isTimeReady(target, params, search)` holds (the URL has `from` and `to`, and they are the
target's); until then every panel and the preview use the idle key, whatever the language, board
and query caches hold. The board query itself and the picker's metadata are not gated.

## Visible-only queries (T07-012 v1)

`BoardRunProvider` owns one `IntersectionObserver` for the board (`createVisibilityTracker`: root
the viewport, `rootMargin` `0px`, threshold 0; no prefetch). Each `PanelFrame` observes its root
element (`useInViewport`); a panel queries while it intersects the viewport or is at full screen,
and the editor's preview always. Without `IntersectionObserver` every panel is visible. A collapsed
section renders no grid, so its panels mount nothing and query nothing. A panel scrolled out keeps
its request in flight (it fills the cache) and starts no new one.

`PanelFrame` writes its body width into the board's width store (`panelWidths.ts`); the dialog's
run reads it (`usePanelWidth`), so the preview sends the panel's width and shares its key. The last
known width stays in the store when the panel remounts (the Edit grid replaces the View grid);
the provider reconciles the store with the board's live panel ids (`livePanels`), so a deleted
panel's width goes and a new panel that reuses its id starts without it.

## Panel states (`panelView`)

First match; the text is from `messages.en-GB.ts`.

| Condition | View | Text |
|---|---|---|
| LogQL | message `unsupported` | "Runs when LogQL support lands" (#67) |
| visualisation Logs | message `logs` | "The log stream arrives with LogQL panels" |
| blank text | message `empty` | "Add a query" |
| a referenced variable without a value | message `variable` | "Set a value for `$a, $b` to run this panel" |
| the language module failed | message `langFailed` | "PromQL support could not be loaded. Reload the page." |
| over 128 KB, or the server's 413 | message `refused` | `refusalText('queryTooLarge')` or `refusalText('tooLong')` |
| any other error | error | "Something went wrong", the `errorView` text and, for a query error with a position, " (line L, column C)"; Narrow when the error is about the window |
| no outcome yet | loading | "Loading" |
| a string result | message `string` | "String result: …" |
| `framePlan` notice | message `noBuckets` / `tooManyTimestamps` | Explore's texts |
| otherwise | frame | `framePlan(chooseVis(saved or auto, autoVis(planned, result)), …)` |

The client checks (the 128 KB pre-check and the referenced-variable hint) are hints made before a
request. The server is the authority: a 400 whose fields are all `variable.missing` gives the same
`variable` state with the server's names (in field order), and a 413 (`query.sent_too_large` with
`planned`, or `query.too_large_to_plan`) the `refused` state with the 64 KiB text. Positions in a
query error arrive as byte offsets into the raw text (the server maps them, ADR-0021 §3), so the
diagnostics use the identity map (T09-009). The line is 1-based, split on `\n`; the column counts
code points.

`framePlan` is computed once per result, vis, rate and isolated series (`panelRun.ts` caches it in a
`WeakMap` keyed by the result, `${vis}|${rateApplied}|${isolatedKey ?? ''}`), so a panel's
remounts, full screen and the preview reuse the same frame data.

`panelView(run, panel.vis, title)` takes the panel's whole `vis`. A frame view also carries the
result (`result`, for the legend and isolation), `rateApplied`, the panel's `thresholds`
(`panel.vis.thresholds ?? null`) and `legend` (`panel.vis.legend?.mode ?? 'table'`). On line and
bars its spec has `thresholds = thresholdLines(thresholds, spec.unit)` (the seam lines of
[ADR-0022](../../designs/adr/0022-chart-thresholds-and-stat-sparkline.md)); heatmap and stat specs
never carry them. `panelFrame(view, key)` is the frame with series `key` isolated (the cached
`framePlan` isolation, thresholds carried over), and `legendRows(result)` the legend rows
(`seriesRows`, cached per result).

`data-panel-state` on the panel's root is the view kind or the message state, and `data-panel-vis`
the drawn vis of a frame. The completeness badge (`PanelNotices`: **Partial data** or **Warnings**,
labelled "`<badge>`: `<title>`") shows with any frame or message of an outcome and opens Explore's
`CompletenessNotice` in a popover.

## Thresholds, legends and stat tiles (#64 Part B)

Board spec version 2 adds two optional members to a panel's `vis`
([Boards API](../server/boards-api.md#board-spec-v2)):

```json
"vis": {
  "kind": "line",
  "thresholds": { "direction": "above", "steps": [{ "value": 1.5, "state": "degraded", "label": "SLO" }] },
  "legend": { "mode": "hidden" }
}
```

`client/src/boards/spec.ts` checks them with the server's rules, order, pointers and keys: a
`number` shape kind (a finite number; the editor's draft can hold `NaN`, which is
`board.json.type`), then direction, 1–8 steps, a value of 0 or `MIN_THRESHOLD_ABS` (1e-9) ≤ |v| ≤
`MAX_THRESHOLD_ABS` (1e15), no duplicate value, state, label and legend mode.

### The evaluator (`vis/thresholds.ts`)

The one threshold evaluator of the client (T02-018 in the interim client): the legend highlight,
the stat chip and the threshold labels all use it.

| Function | Rule |
|---|---|
| `crosses(t, s, v)` | above: v ≥ s.value; below: v ≤ s.value; false for NaN; ±Inf compare normally |
| `crossed(t, v)` | the most severe step v crosses (watch < degraded < failing); ties go to the furthest (above: the largest value; below: the smallest) |
| `stateOf(t, v)` | null without thresholds; `unknown` for null or NaN; `ok` when nothing is crossed; else the crossed step's state |
| `nextStep(t, v)` | above: the smallest value > v; below: the largest value < v; for null or NaN, the first step in the direction; null when every step is crossed |
| `displayText(t, s, unit)` | the label when it has a non-space character, else `≥ <value>` (above) or `≤ <value>` (below) |
| `thresholdLines(t, unit)` | the seam lines: finite steps in spec order, labelled with `displayText` |

### The panel body

`PanelChart` renders by the drawn vis (`view.vis`):

| Vis | DOM |
|---|---|
| line, bars | `.frameStack[data-legend]`: the chart cell, then the legend when `legend` is `table` and there are rows: `[data-panel-legend="table"]` (`SeriesTable` with Mean, Max, Last, at most `LEGEND_ROWS` = 50) or `LegendCompact` (`[data-panel-legend="compact"]`) |
| stat | `.statStack[data-stat-stack]`: `[data-stat-chip][data-state]` (`StateGlyph`) when the panel has thresholds, the chart cell, then `[data-stat-threshold]` (with `data-crossed` when the value crossed a step) |
| heatmap | the chart alone: no legend; thresholds are ignored |

- **Layout.** `useLegendLayout()` observes the stack's content height (one `ResizeObserver`): the
  table from `size.board-legend-table-min` (240 px) and while not yet measured, compact below. The
  stack fills the body, so the legend's own height never changes the layout. A 4-row panel is
  compact; 6 rows and up have a table.
- **First frame (#90).** The stack is measured once when it attaches (in the commit), and a line
  or bars chart mounts only then, so the layout is final before the chart is sized. In the same
  commit the chart cell's size goes into the panel's size memo, which the chart pre-sizes from: a
  chart under a legend, or a stat under its chip, is sized once and draws in its first frame.
- **Compact.** One button per series (`[data-legend-item]`, at least 24 px tall, `title` = the full
  name) with its swatch, name and last value; "Legend table" (`[data-legend-table]`) opens the same
  table in a popover dialog named by the caption.
- **Isolation and sort.** `isolatedKey` and the sort are `PanelChart` state: never saved, never in
  the URL, and no request (the frame is `panelFrame(view, key)`). The isolation applies only while
  the rows still have the key.
- **Highlights.** `cellState(v)` is `stateOf(thresholds, v)` limited to watch, degraded and failing;
  mean, max and last are highlighted: `td.stateCell[data-state]` with the glyph (`aria-hidden`) and
  the hidden state name.
- **Stat.** `v = statValue(view.data)` (finite, else null). The chip is `unknown` for no value, the
  crossed step's state, or `ok`; the text is the crossed step (in its state's colour, `data-crossed`)
  or the next step (muted), as `<glyph> <displayText>`.

### The editor's Thresholds and Legend

`ThresholdsField` and the Legend select follow Visualisation. Every vis edit is one `updatePanel`
of a `vis` built from `panel.vis` by spread, so a kind change keeps the thresholds and the legend;
Legend Table and the last threshold's removal delete their member (the saved spec has no key).
**Add threshold** starts at `{ direction: 'above', steps: [{ value: 0, state: 'degraded' }] }`, then
adds the largest finite value + 1 (above) or the smallest − 1 (below); it is disabled at 8.

Each Value field keeps its own text. On every change the trimmed text is matched against
`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$` and stored as its number, or as `NaN` with the local
error "Enter a number"; a number outside the range is stored as typed and shows the range error at
once. Either local error replaces the save error under the field. The draft's `checkBoardSpec`
stops the save on `NaN` (`board.json.type`) or the range (`board.thresholds.value.range`), so
nothing invalid is sent. The text is re-seeded only when the value changes from outside and the text
does not already read as it. Rows are memoised by index, so a keystroke renders one row
(`bench:rooms-long-tasks` "board editor, 8 thresholds").

## Open in Explore

`exploreHref(tenant, panel, search, run.expanded)`: for PromQL,
`/t/<tenant>/explore/metrics<board time>&q=<expanded>` plus `&vis=<kind>` unless the kind is Auto
or Logs; for LogQL, `/t/<tenant>/explore/logs<board time>&q=<saved text>`. `run.expanded` is
`planned.expanded` of the **current key's own** response: the data the key was fetched under
(`PanelOutcome.key`, compared with `sameKey`) and not a placeholder, or, after an error, the
rejection's `detail.planned`. Without it (gated, blocked, a first fetch in flight, a placeholder
from a previous key, an error without `planned`) the link is null: the menu item is disabled and
the header tool is a disabled button with the same name. A same-key refetch (Refresh under an
absolute window) keeps the link.

## The panel menu

Edit panel, **Duplicate**, **Remove**, **Open in Explore** (a React Aria `MenuItem` with `href`,
routed through the app's router) and Copy query. Duplicate and Remove dispatch `enterEdit`, then
`duplicatePanel` (the copy at `firstFree` of the same grid, title "`<title>` (copy)" cut to 200
code points, announced in the live region) or `removePanel` (focus then moves to Add panel); both
are disabled while a save is in flight.

## The panel editor's Query field (§3.8, §4.4)

For PromQL the Query field is `PanelQueryField`: the metric picker, the Run hint, **Run query**
(disabled until the editor chunk loads, or while read-only), Explore's `PromQLEditor` (label
"Query") and one status row (a field error, or "Press Shift+Enter or Run query to update the
preview."). Typing changes the draft (`updatePanel`) per change; the dialog's **run text**
(`BoardPage` state `editRun`) is what the preview and the panel behind run:

| Event | Run text | Requests |
|---|---|---|
| dialog opens on a panel | its saved text | none new (shared key) |
| typing | unchanged | none |
| Run, Shift+Enter, Mod+Enter, text differs | the text | one, shared |
| same, text equal | unchanged | `cancelQueries` then `invalidateQueries` on `['data', 'panel', tenant, id]`: abort and rerun |
| focus leaves the field, text differs | the text | one |
| dialog closes | cleared: the panel runs its draft text | one if the last text did not run |

Escape inside the editor is the editor's: it closes the completion list, or moves focus to Run
query; the field stops it from reaching the dialog, so a second Escape (on Run query) closes the
window (T09-004). The Run keys render the run synchronously (`flushSync`), so the preview shows it
in the next frame. The editor view mounts one animation frame after the field, so opening the
dialog, or switching a panel to PromQL, does not create it in the same task
(`bench:rooms-long-tasks`). `PromQLEditor`'s inner host is a tab stop that delegates focus into
its shadow root and on to the text: the dialog's focus containment walks the light DOM only, so
without it Tab would skip the editor. If the editor chunk fails to load, the field is a plain text area with "The
query editor could not be loaded. Reload the page to try again." A LogQL panel keeps #90's text
area.

While the board saves or discards (read-only), the editor is read-only (`EditorState.readOnly`
through a compartment, `aria-readonly`), the metric picker is disabled, and Run query, the Run keys
and the run on leaving the field do nothing, so nothing typed can be lost or run.

## The stub

`StubApi.queryRange` and `queryInstant` plan through the stub's planning mirror and honour the test
hooks `pulsus-dash.stub.queryDelayMs` and `pulsus-dash.stub.failQuery` (they replace #90's
`panelDelayMs` and `failPanelData`), leaving a `stub:query` mark per call
([Client application › StubApi](README.md#stubapi)). `Api.panelData`, `PanelData` and
`stubPanels.ts` are removed: panels have one query path per language (ADR-0018). On b-1, Request
rate has two thresholds (watch 1500, degraded 2500 "Capacity") and Error ratio two (degraded 0.01,
failing 0.05 "SLO breach").

## Design references

- [ADR-0021](../../designs/adr/0021-query-planning-is-server-side.md): query planning on the server.
- [ADR-0022](../../designs/adr/0022-chart-thresholds-and-stat-sparkline.md): threshold lines and the
  stat sparkline on the seam.
- [05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md): VIZ-057 and
  VIZ-011 (subsets: thresholds, legends), VIZ-067 (state glyphs);
  [08 Visual language](../../designs/product/08-visual-language.md): VL-003, VL-007 (the tile);
  [T11](../../designs/technical/T11-postgres-schema.md) T11-016 (the v1 upcast).
- [04 Surfaces](../../designs/product/04-surfaces.md): SRF-030 (auto-vis on panels), SRF-017
  (subset: variables re-query only their panels).
- [05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md): VIZ-065,
  Table 5-13 rows 5, 6, 7, 14.
- [02 Information architecture](../../designs/product/02-information-architecture.md): IA-002,
  IA-003, IA-020.
- [T07 Scene and query planner](../../designs/technical/T07-scene-query-planner.md): T07-012,
  T07-013.
- [T09 Query editors](../../designs/technical/T09-query-editors.md): T09-001, T09-004, T09-009,
  T09-010, T09-015.
- [09 Performance contract](../../designs/product/09-performance-contract.md): PRF-030, PRF-031
  (board subsets); [08 Visual language](../../designs/product/08-visual-language.md): VL-015 (the
  shimmer).
