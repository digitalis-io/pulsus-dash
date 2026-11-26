# Boards: panel runtime

How a board panel runs its PromQL query (#64 Part A) or its LogQL query (#67,
[below](#logql-panels-67)): the run hook and its key, the window epoch, the time gate on first
open, visible-only queries, the panel states and menu, and the query field of the panel editor;
and the board's event markers (#64 Part C). The board page itself (modes, saving, sections, the filter bar) is in
[Client application › Boards](README.md#boards); the user's view is [Boards](../user/boards.md).
Widget panels (board spec v5: Text and Clock, no query) are on [the widgets page](widgets.md); a
widget never reaches anything on this page.

| Module | Role |
|---|---|
| `src/boards/usePanelRun.ts` | the run hook: the language's hook (`usePromPanelRun` or `useLogPanelRun`); PromQL's inputs, key, query, the facts read back |
| `src/boards/useLogPanelRun.ts`, `logPanel.ts` | a LogQL panel's run (the stream and frame paths) and its pure parts |
| `src/boards/panelRun.ts` | the key (`panelRunKey`, `panelIdleKey`, `sameExceptWindow`, `sameKey`) and `panelView` |
| `src/boards/variableRefs.ts` | `referencedVariables`, `panelVars` |
| `src/boards/boardRun.tsx`, `boardRunContext.ts` | `BoardRunProvider` and `BoardRunContext` (vars, widths, visibility, `timeReady`); the window epoch |
| `src/boards/visibility.ts`, `panelWidths.ts` | the shared viewport tracker; the panel width store |
| `src/boards/boardTime.ts` | `boardTimeInit`, `isTimeReady` (first open) |
| `src/boards/boardEvents.ts` | `useBoardEvents`, `BoardEventsContext`, `NO_EVENTS`, `toMarkers` (event markers) |
| `src/boards/exploreLink.ts` | `exploreHref` |
| `src/boards/useQueryLanguage.ts` | one `LANGUAGES[id]()` per language per page load; `null` loads none |
| `src/pages/board/PanelFrame.tsx`, `PanelNotices.tsx`, `PanelEditor.tsx` | the panel chrome (a widget's `WidgetFrame`, else `DataPanelFrame`), the completeness badge, the editor |
| `src/pages/board/PanelQueryField.tsx`, `PanelLogqlField.tsx`, `useQueryFieldRun.ts` | the editor's Query field per language and their shared run rules |

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
known width stays in the store when the panel remounts (a refused drop resets the grid);
the provider reconciles the store with the board's live panel ids (`livePanels`), so a deleted
panel's width goes and a new panel that reuses its id starts without it.

## Panel states (`panelView`)

First match; the text is from `messages.en-GB.ts`.

| Condition | View | Text |
|---|---|---|
| a pending kind (Bar chart, Pie; PromQL or LogQL) | message `kindUnavailable` | "This chart type isn't available in this version yet." |
| PromQL, visualisation Logs | message `logs` | "A metric query has no log lines. Choose Auto or a chart." |
| blank text | message `empty` | "Add a query" |
| a referenced variable without a value | message `variable` | "Set a value for `$a, $b` to run this panel" |
| the language module failed | message `langFailed` | "PromQL support could not be loaded. Reload the page." |
| over 128 KB, or the server's 413 | message `refused` | `refusalText('queryTooLarge')` or `refusalText('tooLong')` |
| any other error | error | "Something went wrong", the `errorView` text and, for a query error with a position, " (line L, column C)"; Narrow when the error is about the window |
| no outcome yet | loading | "Loading" |
| a string result | message `string` | "String result: …" |
| `framePlan` notice | message `noBuckets` / `tooManyTimestamps` | Explore's texts |
| LogQL | the LogQL rows ([below](#panel-views)) | |
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

### Pending kinds

Board spec v3 (#173 Part 1, [the boards API](../server/boards-api.md#visoptions-v3)) stores the
kinds `barchart` and `pie` and their `vis.options`, before boards can draw them (the bar chart
comes to boards with #173 Part 3, the pie with T22 I3). `PENDING_KINDS` (`boards/options.ts`) lists
them. #173 Part 2 ships the bar chart's engine seam, drawing, fit and meter
([Charts](charts.md#bar-chart-adr-0028), [Categorical panels](panels.md)), shown only in the chart
gallery: boards keep both kinds pending. Such a panel is blocked before anything is sent, in both languages
(`usePanelRun`/`useLogPanelRun` set `pre` to `kindUnavailable`, ahead of every other check), so it
makes no request, and shows the message above. Its saved spec, options included, is kept as it
is. Open in Explore opens such a panel's query on Auto, and a LogQL panel of a pending kind maps to
the `logs-frame` path (unused while it is blocked). The editor lists Bar chart and Pie only as the
disabled option of a panel that stores them. The auto-vis row 11 (bar chart) is not in the boards'
`available` set either, so an `auto` panel with a `reducer` over a few range series is still a line
(`unit:autovis-table`, and the boundary tests in `boards/panelRun.test.ts` and
`pages/board/PanelEditorKinds.test.tsx`).

`data-panel-state` on the panel's root is the view kind or the message state, and `data-panel-vis`
the drawn vis of a frame. The completeness badge (`PanelNotices`: **Partial data** or **Warnings**,
labelled "`<badge>`: `<title>`") shows with any frame or message of an outcome and opens Explore's
`CompletenessNotice` in a popover.

### Board tags (#215)

Board spec v4 ([the boards API](../server/boards-api.md#board-spec-v4)) adds the optional `tags`:
0 to 16 unique tags of `^[a-z0-9][a-z0-9_.:/-]{0,63}$`. The client accepts and keeps them; it has
no editor for them yet (the tags editor and the Board list widget come with #216).

- `checkBoardSpec` (`boards/spec.ts`) checks them as the server does, with the same pointers and
  keys: more than `MAX_BOARD_TAGS` (16) at `/tags` (`board.tags.invalid`), then each item against
  `TAG_PATTERN` (`board.tags.invalid`) and the earlier items (`board.tags.duplicate`), after the
  time and before the panels. The shared `invalid.json` rows and `v4-board-tags.json` hold the two
  suites together, the canonical form's SHA-256 included.
- The editor never drops them: every action rebuilds the draft from the previous one, and turning
  off **Save current time range** (`setTime` with `null`) removes only `time`. A tagged board opens,
  edits and saves with its tags unchanged.
- The en-GB texts are `field.board.tags.invalid` ("Use at most 16 tags of lower-case letters,
  digits and _ . : / -, each up to 64 characters") and `field.board.tags.duplicate` ("Use each tag
  once").

`canonicalJson` is unchanged: the client never creates `tags`, and heads come canonical from the
server, where `tags: []` is stored as no key. The list's `tags`, `applied` and `tagsStale` members
are read by the API layer ([board list pages](#board-list-pages-and-filters-216-part-1)).

### Widgets and the query typing (#198 Part 1)

Board spec v5 ([the boards API](../server/boards-api.md#widgets-text-and-clock-v5)) makes `query`
optional and adds the widget kinds `text` and `clock`. `PanelSpec` is the union
`DataPanelSpec | WidgetPanelSpec` (`api/types.ts`): a data panel has a `query`, a widget has none
(`query?: never`). Every reader of `query` takes a `DataPanelSpec` and gets one through
`isDataPanel` (`widgets/spec.ts`), with no `!` and no cast, so `npm run typecheck` finds any new
reader that forgets the widgets:

| Reader | Takes |
|---|---|
| `usePanelRun`, `panelView`, `exploreHref`, `logPanelPath`, `withKind` | a data panel (`DataPanelSpec`, `DataVisKind`) |
| `PanelFrame` | any panel: a widget renders `WidgetFrame`, a data panel `DataPanelFrame` (today's body) |
| `PanelEditor`, `PanelPreview` | a data panel only: `BoardPage` opens the editor, and sets the edited run, only when `edit` and the selected panel `isDataPanel` |
| `updatePanel` (`editorState.ts`) | a `PanelPatch` of a data panel's title, query or vis; on a widget only the title applies |
| `boardVariables` (`variables.ts`) | data panels only: a widget has no variables |
| `HttpApi` `toBoard` | the wire spec: a widget kind becomes a `WidgetPanelSpec`; a data panel without a query is a `badResponse` |

`checkBoardSpec` checks the v5 rules as the server does, in the same order and with the same
pointers and keys ([the widgets page](widgets.md#validation)); the client does not know which zones
exist, so `w-zone-unknown` is the one `invalid.json` row whose `client_fields` (none) differ.

### Board list pages and filters (#216 Part 1)

The board list calls of `Api` (`api/Api.ts`) return pages, so a list can tell what the server
applied and whether it stopped early (T24 §5.7):

```ts
listBoards(tenant, signal?, f?: { q?: string; tag?: string }): Promise<BoardPage>;
listStarred(tenant, signal?): Promise<RefPage>;
listRecent(tenant, signal?, limit?: number): Promise<RefPage>;   // limit defaults to RECENT_LIMIT (5)
```

| Type | Members |
|---|---|
| `BoardPage` | `items` (`BoardListItem`: a `BoardSummary` with `tags`, `null` when not known), `truncated`, `applied` (`{q?, tag?}`, or `null` from an old server), `tagsStale` |
| `RefPage` | `items` (`BoardRef`), `truncated`, `applied` (`{}`, or `null` from an old server) |

`HttpApi` sends `q` only when it is non-empty and `tag` only when it is given (`GET
/api/dash/v1/boards?q=x&tag=a`), and `limit` on every Recent call. An **old server** (one before
the board search, #215) answers without `applied`; `HttpApi` checks each member with `Object.hasOwn`
(the generated types call them required) and decodes a missing `applied` as `null`, `tagsStale` as
0, an item's `tags` as `null` and a Starred or Recent `truncated` as `false`. The list modules then
treat the answer as of unknown coverage ([widgets](widgets.md#board-list-in-progress)).

`StubApi` answers as the BFF: `q` matches when the ASCII-lower title contains the ASCII-lower `q`
or that equals a tag, `tag` when it equals a tag, and both must hold; most recently updated first;
the item tags are the spec's (`[]` for none); `applied` is the filter sent and `tagsStale` 0. Its
`truncated` is computed before the cut, as the BFF's: boards over 1 000, starred over 200, recent
over the limit.

`SidebarBoards` and the board header's star read `.items`; their query keys (`['boards', tenant]`,
`['starred', tenant]`, `['recent', tenant]`) are unchanged, so the invalidations of
`invalidateBoardLists` and `BoardPrefs` still reach them.

Board spec v6 ([the boards API](../server/boards-api.md#board-list-boardlist-v6)) adds the widget kind
`boardList`. `checkBoardSpec` checks its rules as the server does (the `bl-` rows of `invalid.json`
and `v6-board-list.json`, the canonical SHA-256 included). `mode` and `sort` are shared keys, so
their readers guard them: `textOptions` takes `mode` only when `isTextMode` (else `markdown`), and
`barchartOptions` `sort` only when `isChartSort` (else `valueDesc`).

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
of a `vis` built from `panel.vis` by spread, so a kind change keeps the thresholds and the legend.
A kind change goes through `withKind(vis, kind)`, which also keeps only the `vis.options` keys the
new kind allows (`keepOptions`, the `OPTION_KEYS` table) and drops the `options` member when none
is left, so the draft stays valid. A stored pending kind (Bar chart, Pie) shows in the
Visualisation select as a disabled option: the select names it, and it cannot be chosen for another
panel;
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

To keep opening the editor out of one long task, the Thresholds and Legend fields mount in the
animation frame after the dialog, and the threshold rows then appear two per frame; a row added
after that renders at once. `PanelChart` is memoised, so an edit to one panel, or opening the
editor, does not render the other panels' charts and legends again.

## Event markers

A board reads its event markers once per resolved window, for every panel (#64 Part C, INT-031,
[ADR-0023](../../designs/adr/0023-chart-event-markers.md)). The annotations come from Postgres
through `Api.listAnnotations` ([Annotations API](../server/annotations-api.md)); the chart draws
them ([Charts › Event markers](charts.md#event-markers)).

`useBoardEvents(tenant, enabled)` (`src/boards/boardEvents.ts`) is one `useQuery`:

| Option | Value |
|---|---|
| `queryKey` | `['data', 'events', tenant, fromMs, toMs]`: the resolved window, under the `['data']` prefix |
| `queryFn` | `api.listAnnotations(tenant, { fromMs, toMs }, signal)`: `GET /api/dash/v1/annotations?from&to` (no `limit`: the server's 500) |
| `enabled` | `timeReady && allPanels(spec).length > 0` in `BoardPage`: the top grid and every section, collapsed ones included |
| `staleTime`, `refetchOnWindowFocus`, `placeholderData` | `0`, `false`, `keepPreviousData` |

It returns `{ markers, truncated, failed }`. The items become `EventMarker`s
(`{ id, atMs: at, endMs: end_at, kind, title: text }`), sorted by `(atMs, id)` and memoised on the
data, so every panel gets the same array. `failed` is a rejection that is not an abort; it carries
no markers. Outside a board (`BoardEventsContext`'s default, `NO_EVENTS`) there are none.

| Trigger | Events request |
|---|---|
| Board open | One, once the board's time is ready |
| Window change | A new key; the old request is aborted, and the old markers stay until the new ones arrive |
| Refresh now, absolute window | `refreshNow` cancels the in-flight `['data']` queries, then invalidates `['data']`: the request is aborted and made again |
| Refresh now, relative window | A new key, as a window change |
| A panel scrolls in or out | None |
| Failure | The notice "Events could not be loaded."; no markers; the panels are unaffected |

The panel queries keep their own rules: the window epoch of `BoardRunProvider` marks only
`['data', 'panel', tenant]`, so the events query is not part of a panel's request count.

`BoardPage` provides the result through `BoardEventsContext` and shows
`<p role="status" data-board-events-notice>` above the grids: "Events could not be loaded." when
`failed`, "Showing the newest 500 events in this time range." when `truncated`, and empty
otherwise. `PanelChart` (`PanelFrame.tsx`) reads the context and passes `markers` to its
`ChartFrame` as `events`, on line, bars, heatmap and stat panels (stat draws none), and in the full
screen view and the editor's preview. The stub (`StubApi.listAnnotations`) has no annotations.

## Open in Explore

`exploreHref(tenant, panel, search, run.expanded)`: for PromQL,
`/t/<tenant>/explore/metrics<board time>&q=<expanded>` plus `&vis=<kind>` unless the kind is Auto
or Logs; for LogQL, `/t/<tenant>/explore/logs<board time>&q=<expanded>`, and null without
`expanded` (a stream panel's is its pager's `planned`, `streamMeta`). For PromQL `run.expanded` is
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

A widget's menu has **Duplicate** and **Remove** only (T24-002): no Edit panel (Part 3 adds it for
Text), Open in Explore, Copy query or Full screen. A duplicated widget keeps its `vis` and has no
`query`.

## The panel editor's Query field (§3.8, §4.4)

For PromQL the Query field is `PanelQueryField`: the metric picker, the Run hint, **Run query**
(disabled while the editor chunk is loading, or while read-only; enabled with the fallback), Explore's `PromQLEditor` (label
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
without it Tab would skip the editor. For LogQL the field is
`PanelLogqlField`: the same layout without the picker, Explore › Logs' `LogQLEditor` from
`useLogqlModules` (placeholder `explore.logs.placeholder`), and a completion source made by
`editor.createLogSource({api, queryClient, tenant, window})` once per editor, api, query client and
tenant (T09-014; the window is read at each lookup). Both fields take their run rules (the draft
ref, the Run keys through `flushSync`, the run on leaving, the Escape guard) from
`useQueryFieldRun`. A language change keeps the text, so the field and the run follow it. A Run of
the same text also adds one to `editRun.seq`, which reaches the edited panel and the editor as
`runSeq`: a LogQL stream preview's new pager.

### When an import fails (#147)

If the editor chunk fails to load (`modules.editorFailed`), either field (PromQL and LogQL) is
`QueryFallback` (`pages/explore/QueryFallback.tsx`), a plain text area, with "The query editor
could not be loaded. Reload the page to try again." Run query stays enabled, and Shift+Enter or
Mod+Enter run it, unchanged text included; the field's other run rules (`useQueryFieldRun`) hold
too, and it is read-only while the board saves. A language-only failure (`modules.failed` without
`editorFailed`) shows the alert, never the text area: the editor that loads later keeps the text.

A field whose imports failed runs the edited panel (the preview and the panel behind) degraded:
`PanelQueryField` reports `modules.failed` through `onDegraded`, `BoardPage` keeps it as
`editRun.degraded`, and both runs get `PanelRunInput.degraded`. Without a loaded language a PromQL
query then goes to the range route (`runKind(text, null, true)`), so a scalar draws as a flat line
and a string literal gets the server's range error; errors carry no editor diagnostics. Other panels
keep their `langFailed` state. The 128 KB refusal (T09-015) and blank text still send nothing.
LogQL runs need no language, so `useLogPanelRun` ignores `degraded`.

| Field modules | Field | Alert | Run query | Edited panel's run |
|---|---|---|---|---|
| loading | loading placeholder | — | disabled | as before |
| editor mounted, nothing failed | editor | — | enabled unless read-only | as before |
| editor failed (language loaded, pending or failed) | `QueryFallback` | yes | enabled unless read-only | degraded |
| language failed, editor pending | empty placeholder | yes | disabled | degraded |
| language failed, editor mounted | editor | yes | enabled unless read-only | degraded |

Tests: `PanelEditorFallback.test.tsx` (B1: the editor fails, the PromQL text area runs on Run
query and the three Run keys), `PanelEditorFallback.bothFailed.test.tsx` (B2: both imports fail,
the edited panel runs degraded on the range route; the 128 KB refusal sends nothing) and
`PanelLogqlField.fallback.test.tsx` (the LogQL text area, Meta+Enter included).

While the board saves or discards (read-only), the editor is read-only (`EditorState.readOnly`
through a compartment, `aria-readonly`), the metric picker is disabled, and Run query, the Run keys
and the run on leaving the field do nothing, so nothing typed can be lost or run.

## LogQL panels (#67)

`usePanelRun(a)` calls both hooks on every render: `usePromPanelRun(a, !logql)` and
`useLogPanelRun(a, logql)`, and returns the active one's run. The inactive hook has an idle key,
starts no pager and loads no language (`useQueryLanguage(null)`), so a PromQL-only board never
imports LogQL. Nothing is planned in the browser (ADR-0021 §2): the panel sends its raw text and
`vars = Object.fromEntries(panelVars(text, vars))` (`{}` included). The saved vis picks the path
(`logPanelPath`):

| Vis | Path | Requests |
|---|---|---|
| Auto, Logs | stream | a `LogPager` (`useLogPager`): `queryLogs` pages of `limit` 1 000, the first without `cursor` |
| Bars | `logs-bars` | under the panel key: `queryLogs({...req, limit: 1})` (the kind probe) and `queryVolume(req)` in parallel |
| Line, Heatmap, Stat | `logs-frame` | under the panel key: the kind probe only |

`req` is `{query: text, fromMs, toMs, widthPx, vars}`.

### The stream path

The pager input is `{tenant, query, vars, fromMs, toMs, widthPx: step.widthPx, direction}`, with
the width held per grid step (`useStepWidth`), and its generation
`${refreshEpoch}.${runSeq}.${driftSeq}`. `streamInput(enabled, held, next)` is the run the panel
holds, set while rendering on every render: visible (or full screen, or the preview) → the next
run; scrolled out → the next run only when it has the held run's `logPagerKey` and generation
(T07-012: the pager and its lines are kept), else none. A null run disposes the pager (its
requests abort). So a new window, text, variable, direction, refresh (`refreshEpoch`), Run of the
same text (`runSeq`) or drift's Run again (`driftSeq`) is a new pager: at once on screen, on
scrolling in off screen. The panel behind its open editor (`editing`) holds none; the preview owns
one, and Done gives the panel a new one. The order, wrap and `driftSeq` are the hook's state, not
saved and not in the URL.

The view (`PanelView` kind `stream`) is `LogStream` with `prefetchRows` `PANEL_PREFETCH_ROWS` (50),
so a board of log panels loads one page each until a reader scrolls near an end. While the panel's
full screen is open its body shows "Shown at full screen" (`streamHidden`), so one pager has one
list. A first page that fails is the panel's error (`firstPageError`); later pages and drift are
`LogStream`'s sentinels. The completeness badge reads `streamMeta(state).completeness` (the
merged notices of the pages), and `expanded` `streamMeta(state).planned?.expanded`.

### The frame path

One TanStack query under `panelRunKey(tenant, id, {text, vars: JSON.stringify(panelVars(…))},
path, stepMs, window)` (kind `logs-bars` or `logs-frame`), with PromQL's options: the window epoch,
the refresh, the placeholder across a window change, and the preview sharing the key. Its function
is `fetchLogFrame(api, tenant, req, path === 'logs-bars', signal)`:

1. One inner `AbortController` follows `signal` (a listener added once, removed when the fetch
   settles).
2. Bars: the volume starts at once; its rejection is always handled.
3. The probe; a rejection aborts the volume and rejects.
4. A metric answer (`kind: 'series'`) aborts the volume: `{result: fromRange(probe), logKind:
   'series'}`.
5. A log answer without volume: an empty series result, `logKind: 'streams'`.
6. A log answer with volume: `{result: fromRange(volume), logKind: 'streams', volume}`; the
   volume's rejection rejects.

Every outcome has `planned: fromLogqlPlanned(probe.planned)` (the LogQL facts, `valueType`
`unknown`, no rate or histogram facts).

### Panel views

After the blocked and error rows (`empty`, `variable`, `refused` as PromQL's):

| Path | Answer | View | `data-panel-vis` |
|---|---|---|---|
| stream | no pager, or pending | `loading` | |
| stream | `streams` | `stream` | |
| stream | `series`, Auto | frame `line` of `fromRange(state.series)` (cached per answer) | `line` |
| stream | `series`, Logs | message `logs`: "A metric query has no log lines. Choose Auto or a chart." | |
| `logs-bars` | `streams` | frame `volumePlan(volume)`, thresholds, legend, `volume: true` | `bars` |
| `logs-bars`, `logs-frame` | `series` | frame of the saved vis (PromQL's code) | the vis |
| `logs-frame` | `streams` | message `notMetric`: "Line, Heatmap and Stat draw metric queries. Choose Auto, Logs or Bars for log lines." | |
| frame | no outcome | `loading` | |

`panelFrame(view, key)` on a volume frame keeps its spec (the level stack, `VOLUME_STACK`) and
draws only the series of `key` (cached per data and key). The editor's Auto option reads
"Auto (Logs)" for a stream answer, "Auto (Line)" for any metric answer, else "Auto".

### Tests

`unit:log-panel-path`, `unit:stream-input`, `unit:fetch-log-frame`, `unit:stream-meta` and
`unit:logql-planned` (`boards/logPanel.test.ts`), the LogQL rows of `unit:panel-view`,
`unit:explore-link`, `unit:query-language`, `unit:from-range-frame` and
`unit:log-stream-prefetch`; `unit:board-log-panels` (`pages/board/BoardLogPanels.test.tsx`,
cases BL1–BL29 on `test/boardLogKit.tsx`: a `StubApi` whose `queryLogs` and `queryVolume` return
deferreds the test settles, the fake LogQL editor, panel bodies of 1000 × 240). The e2e specs are
`e2e:board-logql-save`, `-brush` and `-paging` (`e2e/board-logql.spec.ts`, on the fake through the
http-mode BFF; [Build and CI](../development/build-and-ci.md)), and the board rows of
`e2e:a11y-rooms`, `e2e:csp-violations` and the keyboard loop L34.

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
- [ADR-0023](../../designs/adr/0023-chart-event-markers.md): event markers on the seam;
  [03 Interaction model](../../designs/product/03-interaction-model.md): INT-031 (subset: markers on
  board time panels; click-to-compare is INT-030).
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
  T09-010, T09-014, T09-015.
- LogQL panels (#67): [04 Surfaces](../../designs/product/04-surfaces.md) SRF-033, SRF-036 (board
  subsets); [05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md)
  VIZ-034, VIZ-065; [T03](../../designs/technical/T03-browser-runtime.md) T03-016 (the volume
  brush); [T08](../../designs/technical/T08-dom-component-kit.md) T08-007, T08-010;
  [ADR-0018](../../designs/adr/0018-query-language-modules.md) §5 (languages through `LANGUAGES`).
- [09 Performance contract](../../designs/product/09-performance-contract.md): PRF-030, PRF-031
  (board subsets); [08 Visual language](../../designs/product/08-visual-language.md): VL-015 (the
  shimmer).
- Widgets and the panel union (#198 Part 1):
  [T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md) T24-002, T24-003, §5.1;
  [05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md) VIZ-053
  (staged), VIZ-057.
- Board tags (#215): [T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md) T24-029
  and §5.5; [T11](../../designs/technical/T11-postgres-schema.md) T11-016 (the v3 upcast).
- Board spec v3 and the pending kinds (#173 Parts 1 and 2):
  [T22](../../designs/technical/T22-value-categorical-and-table-panels.md) §6.1 (`vis.options`),
  T22-002 and §4.5 (row 11 not available on boards until Part 3);
  [T11](../../designs/technical/T11-postgres-schema.md) T11-016 (the v2 upcast); the categorical
  transforms are on [the panels page](panels.md).
