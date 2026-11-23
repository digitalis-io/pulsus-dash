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
known width stays in the store when the panel remounts (a refused drop resets the grid);
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

`framePlan` is computed once per result, vis and rate (`panelRun.ts` caches it in a `WeakMap` keyed
by the result), so a panel's remounts, full screen and the preview reuse the same frame data.

`data-panel-state` on the panel's root is the view kind or the message state, and `data-panel-vis`
the drawn vis of a frame. The completeness badge (`PanelNotices`: **Partial data** or **Warnings**,
labelled "`<badge>`: `<title>`") shows with any frame or message of an outcome and opens Explore's
`CompletenessNotice` in a popover.

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
`stubPanels.ts` are removed: panels have one query path per language (ADR-0018).

## Design references

- [ADR-0021](../../designs/adr/0021-query-planning-is-server-side.md): query planning on the server.
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
