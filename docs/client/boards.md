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
| `src/boards/boardHealth.ts` | `BoardHealthContext`, `useBoardHealthStore`, `useReportHealth` (the health status line, [below](#panel-chrome-and-the-health-status-line-282-part-2a)) |
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
- `vars` is `panelVars(text, vars)`: the value of each variable the text references
  (`referencedVariables`: `$name` and `${name}`, not `$__…` macros, at most 64 characters), sorted
  by name; `{}` when it references none. Unreferenced variables are not sent. A variable the board
  defines sends a `VarValue` (`{values: […]}` or `{all: regex}`), one it does not define the URL's
  first value as a plain string ([board variables](#board-variables-289)).
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
['data', 'panel', tenant, id, text, vars, kind, stepMs, fromMs, toMs, baselineMs]   // a run
['data', 'panel', tenant, id, text, null]                                           // idle: nothing can be sent
```

The head is indices 0–6 (`PANEL_KEY_HEAD`). `baselineMs` is a bar chart's baseline offset in ms,
or null when the panel runs no baseline ([below](#the-baseline-run)); a LogQL panel's is always
null. `vars` is the JSON of the `panelVars` pairs. The idle
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
| a pending kind (Pie, Map; PromQL or LogQL) | message `kindUnavailable` | "This chart type isn't available in this version yet." |
| PromQL, visualisation Logs | message `logs` | "A metric query has no log lines. Choose Auto or a chart." |
| blank text | message `empty` | "Add a query" |
| a referenced variable whose selection is over 200 values or 65 536 bytes | message `variableTooMany` | "Too many values selected for ‹label›" (no request) |
| a referenced variable without a value (unset, waiting for another, or its list failed) | message `variable` | "Set a value for `$a, $b` to run this panel" |
| the language module failed | message `langFailed` | "PromQL support could not be loaded. Reload the page." |
| over 128 KB, or the server's 413 | message `refused` | `refusalText('queryTooLarge')` or `refusalText('tooLong')` |
| any other error | error | "Something went wrong", the `errorView` text and, for a query error with a position, " (line L, column C)"; Narrow when the error is about the window |
| no outcome yet, or a referenced variable's list is loading (the idle key) | loading | "Loading" |
| a string result | message `string` | "String result: …" |
| `framePlan` notice | message `noBuckets` / `tooManyTimestamps` | Explore's texts |
| saved Bar chart, a series or scalar result | `category` ([below](#bar-chart-panels-173-part-3b)) | |
| LogQL | the LogQL rows ([below](#panel-views)) | |
| otherwise | frame | `framePlan(chooseVis(saved or auto, autoVis(planned, result)), …)` |

The client checks (the 128 KB pre-check and the referenced-variable hint) are hints made before a
request. The server is the authority: a 400 whose fields are all `variable.missing` gives the same
`variable` state with the server's names (in field order), and a 413 (`query.sent_too_large` with
`planned`, or `query.too_large_to_plan`) the `refused` state with the 64 KiB text. Positions in a
query error arrive as byte offsets into the raw text (the server maps them, ADR-0021 §3), so the
diagnostics use the identity map (T09-009). The line is 1-based, split on `\n`; the column counts
code points.

`framePlan` is computed once per result, vis, units and isolated series (`panelRun.ts` caches it
in a `WeakMap` keyed by the result, `${vis}|${JSON.stringify(units)}|${isolatedKey ?? ''}`), so a
panel's remounts, full screen and the preview reuse the same frame data, and a unit edit plans
afresh.

`panelView(run, panel.vis, title)` takes the panel's whole `vis`. A frame view also carries the
result (`result`, for the legend and isolation), its resolved `units` ([below](#panel-units-290)),
the panel's `thresholds`
(`panel.vis.thresholds ?? null`) and `legend` (`panel.vis.legend?.mode ?? 'table'`). On line and
bars its spec has `thresholds = thresholdLines(thresholds, spec.unit)` (the seam lines of
[ADR-0022](../../designs/adr/0022-chart-thresholds-and-stat-sparkline.md)); heatmap and stat specs
never carry them. `panelFrame(view, key)` is the frame with series `key` isolated (the cached
`framePlan` isolation, thresholds carried over), and `legendRows(result)` the legend rows
(`seriesRows`, cached per result).

### Bar chart panels (#173 Part 3b)

Board spec v3 (#173 Part 1, [the boards API](../server/boards-api.md#visoptions-v3)) stores the
kinds `barchart` and `pie` and their `vis.options`. Part 3b draws the bar chart on boards: a saved
`barchart` panel of a series or scalar result is a **category view** (`categoryView`,
`boards/panelRun.ts`) holding the panel's `barchartModel` (T22 §4.2,
[Categorical panels](panels.md)), with `data-panel-state="frame"` and `data-panel-vis="barchart"`.
The model is cached on every input: the result and the baseline result by object identity, then
the title, the rate, `vis.options` and `vis.thresholds` by their JSON, so a rename or an options
edit builds a new model and a remount (the Edit grid, full screen, the preview) reuses it. A
LogQL bar chart (the `logs-frame` path, or a stream panel's series phase) is a category view of
the metric answer, without a baseline. A string result is the `string` message.

**Auto is unchanged.** A board `auto` panel calls `autoVis` with the default set (`SHIPPED_VIS`),
on the stored spec and on the editor's draft alike, so row 11 never fires on a board and a stored
`auto` panel never switches to bars (T22 §4.5, owner): the bar chart is chosen in the editor.
Map-sync's `legacyAuto` ([T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md)
T24-099, #237) brings rows 8 and 11 to panels saved from then on.

**Pie stays pending.** `PENDING_KINDS` (`boards/options.ts`) is `{pie}`: such a panel is blocked
before anything is sent, in both languages (`pre` = `kindUnavailable`), shows the message above,
and keeps its saved spec. The editor lists Pie only as the disabled option of a panel that stores
it; Open in Explore opens it on Auto. The geomap left the set in #234 Part 3
([below](#map-panels-234-part-1)).

#### The panel body

`CategoryPanel` (`pages/board/PanelFrame.tsx`) renders `CategoryChart` with the model, the
panel's session toggles and the pick context `{surface: 'board', filters, origin, window}`:
the board's `f=` filters (`BoardFiltersContext`, provided by `BoardPage` from `useBoardParams`),
the Inspector origin of the panel and the Context window. The coverage meter's **Narrow** opens
Explore with the panel's query (`vis=barchart`), or zooms in when the panel has no Explore link yet
(T22-006). `onPick` decides with `barAction` and the panel applies it:

| Action | Effect, in order |
|---|---|
| `click` | `onInspect(target, source, returnFocus)`: writes the bar's selection and opens the Inspector on the `mark` target; then the filter toggle when the bar has a label pair (`setFilter`, a push) |
| `brush` | `onSelect(selection, 'brush')`: the keys are the selection, no Inspector |
| `clear` (an empty pick) | `onEmptyClick()`: the selection is cleared |
| `none` | nothing |

A table row's name button picks its row as a click. **Full screen** renders the same body with the
same toggles and actions; because the modal makes the Inspector inert, a click there closes the
dialog first, then inspects with focus returning to the panel's listbox (else the panel). A brush
and a clear act in place. The editor's preview has the pick context but no pick, and no table
toggle.

**Filters are interim** (T22-007): a click toggles `f=<label>=<value>` (a filter already holding
that pair is removed, any other value of the label is replaced) and the filter bar shows the chip,
but no panel query reads `f=` until #193, so nothing runs again. The query and vis stay the same,
so the Inspector stays open (T25-012). Bars without a label pair say why in the tooltip
(`barHint`).

#### The panel menu toggles

A category view's menu adds, after Copy query, three session toggles (`useState` in the panel,
never saved, shared with full screen):

| Item | Off / on | Effect |
|---|---|---|
| Show as table / Show chart | `table` | the `PanelTable` view (also Shift+T in the chart) |
| Show baseline ghost / Hide baseline ghost | `ghost` (PromQL only) | the dashed baseline outline; with no `baselineOffset`, a 1 d baseline run |
| Show anomalies / Hide anomalies | `anomaly` | the anomaly flag on the spec; the tooltip says there are no scores |

#### The baseline run

`usePromPanelRun` takes `ghost`. For a `barchart` panel the offset is
`baselineOffset(vis.options, ghost)` (the option, else 1 d with the ghost on, else none) and
`baselineMs = OFFSET_MS[offset]`, the key's last element; any other kind has none. With an offset
the panel's one query function sends the main request and the same body on the window moved back
by `baselineMs` (range: both ends, the same `widthPx`; instant: `atMs`), under one run controller
linked to the query's signal:

| Case | Result |
|---|---|
| both answer | the main outcome with `baseline` = the shifted result; the bars carry its values (tooltip `baseline <v>`, the ghost, the meter's baseline completeness) |
| the baseline fails | the main outcome with `baseline: 'failed'`: the panel never fails, the bars draw without a ghost and the note "Baseline unavailable: the shifted query failed." shows |
| the main request fails | the run controller aborts the baseline; the panel shows the main error as before |
| the query's signal aborts (a new key, an unmount) | both requests abort; the run rejects with the main request's `AbortError` (no error view) |

A late baseline after the controller aborted settles an unread promise. The offset is outside the
key's head, so a ghost toggle keeps the previous outcome as the placeholder. With neither the
option nor the ghost the panel sends one request, as before.

#### Bar chart options and a kind change (#173 Parts 3a and 3b)

The editor offers **Bar chart** after Stat (Part 3b). For a bar chart it shows Thresholds and
`BarchartOptionsField` (`pages/board/BarchartOptionsField.tsx`) in place of Legend: `errorAt(key)`
reads the field errors at `/vis/options/<key>`, and a change writes `{...vis, options}`, or drops
`options` when no key is left. The field edits a bar chart's `vis.options` (T22 §6.1): Reducer (Last, First, Mean, Min, Max, Sum, Count),
Category label (a text field, placeholder `Automatic`, trimmed; empty removes the key), Sort
(Value, descending; Value, ascending; Name; Query order), Orientation (Horizontal, Vertical),
Value labels (a checkbox), Min and Max (text fields: empty removes the key, a finite number writes
it, anything else shows `Enter a number` and writes nothing) and Baseline (None, 1 h, 1 d, 7 d,
28 d; None removes the key). An absent key shows its default; no key left gives `undefined`.
`errorAt(key)` (the validator's message) shows under its field; `readOnly` disables every field.

A kind change (`withKind`) keeps only the options the new kind allows **with a valid value**:
`keepOptions(kind, options)` keeps a key when `optionValueValid(kind, key, value)` holds
(`boards/spec.ts`: the validator's own shape and rules run on a one-panel board holding only that
key; a `language` is checked as for `mode: code`, a board list's `query` as for `mode: search`
and its `tag` as for `mode: tag`), then drops `max` when min ≥ max and `textMode`
when it is `value` with the `grid` layout. So a stat's `orientation: 'auto'` does not survive a
change to the bar chart (T22 §6.1).

`data-panel-state` on the panel's root is the view kind or the message state (`frame` for a
category view), and `data-panel-vis` the drawn vis of a frame or `barchart`. The completeness badge (`PanelNotices`: **Partial data** or **Warnings**,
labelled "`<badge>`: `<title>`") shows with any frame or message of an outcome and opens Explore's
`CompletenessNotice` in a popover.

### Board tags (#215)

Board spec v4 ([the boards API](../server/boards-api.md#board-spec-v4)) adds the optional `tags`:
0 to 16 unique tags of `^[a-z0-9][a-z0-9_.:/-]{0,63}$`. The client accepts and keeps them, and
since #216 Part 2b edits them from the Edit toolbar's **Tags** button ([below](#the-tags-field-216-part-2b)).

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

`canonicalJson` is unchanged: heads come canonical from the server, where `tags: []` is stored as
no key, and `setTags` deletes the key when the head has none (below). The list's `tags`, `applied`
and `tagsStale` members are read by the API layer
([board list pages](#board-list-pages-and-filters-216-part-1)).

#### The tags field (#216 Part 2b)

**State.** `setTags` (`boards/editorState.ts`, in `EDITS`, so refused while saving) writes the
draft's tags:

| Action | Draft |
|---|---|
| `setTags` with tags | `{...draft, tags: [...tags]}` |
| `setTags []`, the head has `tags` | `{...draft, tags: []}` |
| `setTags []`, the head has no `tags` | the `tags` key deleted, so typing the tags back out leaves the draft clean |

A save sends the draft as before; the client's `checkBoardSpec` rules above still run first.

**Adding** (`boards/tags.ts`, pure). `addTags(tags, input)` splits on commas and white space,
lower-cases each piece (the rule is lower-case only, so a typed capital never means another tag)
and adds the pieces in order. Empty pieces are skipped; it stops at the first piece that is not a
`TAG_PATTERN` tag (`invalid`), is already present (`duplicate`), or would be the 17th (`full`), and
returns that piece and the rest as `rest`, joined by `, `. `tagError(fields)` is a save's first
error at `/tags` or `/tags/<i>`.

**The field** (`pages/board/BoardTagsButton.tsx`, `BoardTagsField.tsx`). In Edit mode a **Tags**
button follows Add section: its visible text is its whole name, "Tags" or "Tags (n)" (no
`aria-label`), its tag icon is a mask in the board route's CSS (`Board.module.css`, not the kit
`Icon`), and it is disabled while busy. It opens a popover dialog "Board tags": the tags as 20 px
muted chips (`--size-list-chip`), each with a × (`Remove tag ‹tag›`), then "Add a tag" with its
help. Return, or a newly typed or pasted comma or white space (the input holds more separators than
before), adds through `addTags`; what cannot be added stays in the input, and editing it commits
nothing until the next separator or Return. It shows `field.board.tags.invalid`, `field.board.tags.duplicate` or "A board has at
most 16 tags", and the text clears on typing. Backspace in an empty input removes the last tag; a
×'s removal moves focus to the next ×, else the input; at 16 tags the input is disabled and its help
says why. Esc closes the popover onto the trigger.

**Errors.** `tagsUnsupported(f)` (`boards/fieldMessages.ts`) is `/tags` with
`board.json.unknownKey`: a server older than board spec v4 refusing the key. `saveFieldMessage`
reads it as "This server does not accept board tags yet", on the status line (where every
non-panel error already shows) and, through `tagError`, under the chips; any other tags error shows
its `fieldMessage` in both places.

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
| `boardVariables` (`variables.ts`) | the data panels' queries, then the Markdown Text panels' content (Part 3a, below) |
| `HttpApi` `toBoard` | the wire spec: a widget kind becomes a `WidgetPanelSpec`; a data panel without a query is a `badResponse` |

`checkBoardSpec` checks the v5 rules as the server does, in the same order and with the same
pointers and keys ([the widgets page](widgets.md#validation)); the client does not know which zones
exist, so `w-zone-unknown` is the one `invalid.json` row whose `client_fields` (none) differ.

### Text widgets and the widget registry (#198 Part 3a)

Part 3a draws Text panels and lets the board add and edit widgets through one registry
([the widgets page](widgets.md#text-widget-part-3a)).

**Add widget.** In Edit mode, `AddWidgetMenu` (`pages/board/AddWidgetMenu.tsx`) follows Add panel
in the toolbar ("Add widget") and in each section header ("Add widget to ‹section›"). It is a
`MenuTrigger` button listing the defs of `WidgetRegistryContext` by label, disabled while busy.
Choosing one dispatches `addWidget` with the def's `newVis()` and `size` (and the section's grid
from a section header). The reducer selects the new panel, so the widget editor opens.

**The reducer** (`boards/editorState.ts`):

```ts
type WidgetPatch = { title?: string; vis?: WidgetPanelSpec['vis'] };
| { type: 'addWidget'; vis: WidgetPanelSpec['vis']; size: { w: number; h: number }; grid?: GridRef }
| { type: 'updateWidget'; id: string; patch: WidgetPatch }
```

| Action | Rule |
|---|---|
| `addWidget` | Shares `addPanel`'s path (`addAt(s, grid, size, make)`): at `MAX_PANELS` it announces `board.fullPanels`; with no `firstFree(size)` cell `board.full`; a collapsed section opens; it adds `{id: nextPanelId, title: '', grid, vis}` and selects it. A data `vis.kind` changes nothing |
| `updateWidget` | `{...p, ...patch}` on a widget whose kind equals `patch.vis?.kind`, or with no vis in the patch; otherwise nothing changes |
| `updatePanel` | unchanged: on a widget only `title` applies |

Both are in `EDITS`, so neither applies while a save is in flight. The reducer needs no registry:
the caller passes the def's vis and size.

**The widget editor.** `BoardPage` keeps `dialogPanel` for data panels and adds `dialogWidget`: Edit
mode, a selected panel, `isWidgetPanel`, and a def for its kind in the registry. It renders
`WidgetEditor` (`pages/board/WidgetEditor.tsx`) with the def, the panel's pointer, the last save's
fields, the mirrored status line and `original`, the head's vis of the panel (undefined for a new
panel). `onChange` dispatches `updateWidget`, Remove panel `removePanel`, and Done `select(null)`.
Focus then follows the panel editor's rule (`focusAfterEditor`): the panel's menu, or Add panel when
the panel is gone. A widget's panel menu has Edit panel only when its kind has a def (Clock keeps
Duplicate and Remove; the board list has a def since #216 Part 2b). While the widget editor reports
a local field text it cannot write (`onLocalInvalid`), `BoardPage` holds it as `editorInvalid` and
refuses `save()`, from the Save button and ⌘S / Ctrl+S, with "Fix the highlighted field in the
panel editor first" and no request; it clears when the field is fixed or the editor closes
([the board list editor](widgets.md#the-board-list-editor-part-2b)).

**Text variables (T24-008).** `boardVariables` lists the data panels' references first, as before.
After them come the references in each Markdown-mode Text's `content`, in panel order and without
duplicates. Code mode and other widgets add none. A Text panel's body passes only the referenced,
set variables to the renderer (`textVars`), so a change to another variable renders no Text panel.

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
treat the answer as of unknown coverage ([widgets](widgets.md#board-list)).

A **503** from any boards call (the configuration store is down) is `ApiError('unavailable')`
(#216 Part 2a; before, `unknown`): the Board list shows "The configuration store is unavailable",
and the view recorder still counts it as ambiguous, so a 503 `recordView` reconciles Recent as a
`network` or `unknown` failure does ([the view recorder](README.md)).

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

### Map panels (#234 Part 1)

Board spec v7 ([the boards API](../server/boards-api.md#geomap-geomap-v7)) adds the data kind
`geomap`. `checkBoardSpec` checks its options as the server does (the `geomap-` rows of
`invalid.json` and `v7-geomap.json`); `groupBy` and `view` may be `null`, the same as absent.
`geomapOptions(o)` (`boards/options.ts`) fills the defaults: auto location, `last`, size by value
4–20, colour by group, no `groupBy`, circles, auto labels, clustering and wheel zoom on, and no
stored view (fit).

A map panel runs its query as any PromQL or LogQL frame panel does, and `panelView` routes it to
the map host (#234 Part 3, [geomap](geomap.md#the-map-panel-234-part-3)): after the blocked rows it
is `{kind: 'geomap'}` (the host draws loading and errors itself), or `notMetric` for a LogQL log
answer. `PanelRun` carries `placeholder` (the outcome is the previous key's) and `retry()` for the
host. The editor lists **Map** with the other kinds; it saves `{kind: 'geomap'}` with every option
at its default (there is no options fieldset yet), and shows Thresholds but no Legend. A save to a server older than v7 is refused
with `board.vis.kind.invalid` at the geomap panel's `…/vis/kind`; the board page shows that one
error as "This server does not support map panels yet" under the status line
(`saveFieldMessage`, `boards/fieldMessages.ts`), and the panel editor shows the same text at its
Visualisation field (`kindFieldMessage`). Every other field error, one under a geomap's
options included, keeps its own text: a v7 server never reports `geomap` as an invalid kind.

### Board variables (#289)

Board spec v9 adds saved variable definitions (`variables`, [the API](../server/boards-api.md#board-variables-v9)).
Their values are in the board URL only; nothing about a pick is saved.

| Module | Holds |
|---|---|
| `state/boardParams.ts` | `readBoardParams(rest, defined)`: `var-<name>` may repeat; a defined variable's values are decoded with the `$` escape and kept canonically encoded, distinct, in address order; `ALL_TOKEN`, `decodeValue`, `encodeValue`, `withVarValues` |
| `state/useBoardParams.ts` | `setVarValues(name, encoded \| null)`: a navigation (Back undoes it), refused with `url.tooLong` over the budget |
| `boards/variableQuery.ts` | `parseVariableQuery(lang, text)`, the server's `varquery.Parse` |
| `boards/resolveVariables.ts` | `resolveVariables(defs, address, lists, legacy)`: each variable's `VarState`, in spec order; `sortValues`, `selectionBytes`, `displayOf` |
| `boards/useVariableLists.ts` | the value lists and the states of a board |
| `boards/variableBlock.ts` | what a panel's references block: missing, too many, loading |
| `boards/variablesSpec.ts` | the v9 rules, the server's `spec/variables.go` |
| `pages/board/VariablePicker.tsx`, `kit/ListBox.tsx` | the chip and the picker |

**The address and the `$` escape.** For a defined variable a bare `$__all` is All; any other value
that starts with `$` loses one `$` when read, and a literal that starts with `$` is written with one
more (`$__all` the literal is `var-node=$$__all`). The 1 to 200 code-point limit applies to the
decoded value, so the parameter may be 201. A variable the board does not define is read raw, as
before. The saved `default` uses the same encoding.

**Resolution** (`resolveVariables`, pure): a query variable that references an earlier variable
waits (`waiting{on}`) while that one is waiting, failed, too large or unset, and loads while it
loads. Then the selection S: a constant's value; the decoded address values, over the saved
default, over the first listed value (`unset` when the list is empty); a single-select variable
keeps S[0]. S = All gives `{all: allValue ?? '.*'}`, never the expanded list. Otherwise
`{values: S}`, or `tooMany` when S has more than 200 values or `selectionBytes(S)` (UTF-8 bytes of
`JSON.stringify(S)`) is over 65 536: no request sends it. A list that failed gives `failed` unless S
came from the address or the default. A selected value the list no longer holds stays selected.
`display` is the value, `first +N` or "All"; Markdown Text panels show it (`displayVars`). Sorts:
`alpha*` by UTF-16 code units; `num*` by `Number()`, values that are not numbers last in code-unit
order; `none` as served.

**Lists** (`useVariableLists`): a custom variable's values, sorted, with no request. A query
variable's list is `api.variableValues(tenant, {lang, query, fromMs, toMs, vars, limit: 1000})`
under `['varValues', tenant, uid, name, text, varsJson, fromMs, toMs]` (`staleTime: Infinity`, no
retry, no placeholder). The key exists only once the variables its query references are ready, so
lists load in spec order and a dependent fetches again when a value it uses changes. `refresh:
load` keeps the window of the board's first ready render; `timeChange` follows the window. Retry
refetches; a new key, a tenant switch or an unmount aborts the request in flight.

**Panels** read `BoardRunContext`: `vars` (the ready values), `states`, `displayVars` and `labels`.
A panel's key holds its `[name, VarValue]` pairs as JSON, so only the panels whose pairs change run
again (T07-013). A loading reference holds the idle key ("Loading"); a `tooMany` one shows "Too
many values selected for ‹label›"; a waiting, failed or unset one "Set a value".

**The bar**, in order: a chip per defined variable but constants (spec order), the text chip of
each referenced variable the board does not define, the filters, `+ Filter`. A chip is a 28 px
capsule: the muted label, the value (ellipsised), a chevron; Loading shimmers and is `aria-busy`;
waiting reads "Waiting for ‹label›"; failed "Values unavailable" and too large "Selection too
large; use All or narrow the search", each with the degraded state glyph. Its name is "Variable
‹label›: ‹display›" (`aria-haspopup="dialog"`, `aria-expanded`).

**The picker** (a `Popover` with a dialog "Variable ‹label›"): React Aria `Autocomplete` with a
`SearchField` (focus starts there) and the kit `ListBox` (virtual focus, `aria-activedescendant`).
Rows: All (with `includeAll`), the selected values the list does not hold, tagged "custom" (named
"‹value›, custom", shown whatever the search), up to 200 listed matches and then "N more, type to
narrow", and "Use ‹text›" when the search matches nothing. A truncated list adds "List truncated:
type a value". Single-select: choosing a row commits it and closes. Multi-select: rows toggle a
draft (All clears the rows, a row clears All); when one more row would pass 200 values or 65 536
bytes the rows it would add are disabled and "Selection too large; use All or narrow the search"
shows, All staying enabled. **Apply** (or ⌘/Ctrl+Enter) commits the draft; Escape or a click
outside discards it; **Reset to default** removes the URL values; **Retry** refetches a failed list.
A polite region says "Loading values", "Values unavailable", "‹n› matches" and "‹n› selected".
Focus returns to the chip.

**The stub** plans structured values with the same contexts and regex position rules
(`api/stub/vars.ts`) and answers `variableValues` from its label values; the server's probe guard
is not mirrored (the fixture's `server_only` cases). `StubApi` imports the planner mirror on
demand (`api/stub/planners.ts`, started when a `StubApi` is made) and the variables mirror only
for a request with a structured value (`api/stub/varsCore.ts` `loadMirror`), so neither is in the
initial chunk.

Gates: `unit:board-params-multi`, `unit:resolve-variables`, `unit:variable-lists`,
`unit:variable-too-many`, `unit:board-variables-run`, `unit:variable-picker`, `unit:variable-query`,
`unit:board-spec` (TS), `unit:plan-parity` (TS) and `e2e:board-variables`; SRF-017 (subset),
IA-006, IA-022, T07-013, T07-031, T08-007.

### Panel units (#290)

Board spec v8, the units version ([the boards API](../server/boards-api.md#panel-units-v8)), stores
one unit per data panel in `vis.unit`: `{id}` with an id of the catalogue, or `{id: 'custom',
suffix}`. `checkBoardSpec` checks it as the server does (the `unit-` rows of `invalid.json`,
`v8-units.json`). The catalogue is `UNIT_CATALOGUE` in `src/vis/units.ts`, 19 ids in five groups:

| Group | Ids (runtime `Unit`) |
|---|---|
| General | `count` (`none`, SI prefixes), `none` (`plain`), `custom` (its suffix) |
| Time | `seconds`, `milliseconds`, `microseconds`, `nanoseconds` (`time` s, ms, us, ns) |
| Data | `bytes` (IEC), `bytesSI`, `bits` (SI), `bitsIEC` |
| Rate | `perSecond` (`/s`), `reqPerSecond` (`req/s`), `bytesPerSecond`, `bytesSIPerSecond`, `bitsPerSecond`, `bitsIECPerSecond` |
| Percent | `percent` (0–100), `percentUnit` (0–1) |

`unitOf(vis.unit)` is the runtime unit ([Charts › Numbers](charts.md#numbers-vl-012-t08-027)).
Every panel plan resolves its units with one pure function, `panelUnits(vis, kind, rateApplied)`
(T22-015), where `kind` is the drawn kind after Auto (`chooseVis`'s result, so an Auto histogram is
a heatmap):

| Stored `vis.unit` | Not a heatmap: `value` | Heatmap: `value` (bucket bounds) | `count` (heatmap counts) |
|---|---|---|---|
| absent | `/s` after the rate rewrite, else `none` | `none` | `/s` after the rewrite, else `none` |
| set | `rated(unitOf(u))` after the rewrite, else `unitOf(u)` | `unitOf(u)`, never rated | `/s` after the rewrite, else `none` |

`rated` (T22-017) makes `none` `/s`, a suffix `x/s`, and bytes and bits per second; time and
percent stay. `framePlan` uses `value` on line, bars and stat and `{unit: value, countUnit: count}`
on a heatmap; `barchartModel` (whose cache key now holds the resolved unit instead of the rate) and
`panelGeo` use `value`. The frame view carries `units`, and `panelFrame` isolates a series with the
same units, so a heatmap's bounds and counts survive isolation. A log volume frame (Bars on a log
query) and the log stream ignore `vis.unit`; Explore stores no unit and resolves
`panelUnits(undefined, vis, rateApplied)`, its output unchanged.

Every surface already formats from `spec.unit`: the Canvas 2D axes (ticks by `tickBase`), the
legend table and compact legend, the stat tile, tooltips, the frame's accessible text, the
Inspector's value (`7.77` with the unit `d` small) and the header chip (`unitLabel`: `in B/s`).
Thresholds stay in the raw base unit
([ADR-0022](../../designs/adr/0022-chart-thresholds-and-stat-sparkline.md)): a stat in seconds has a
threshold of `604800`, labelled in the unit; the editor's placeholders use the preview's unit.

**The picker.** `UnitField` (`pages/board/UnitField.tsx`) is the first field after Visualisation
for every data kind but Logs. It is a Select of **Auto** and the catalogue under its five group
headers (the kit `Select` takes `group` on its options and renders `ListBoxSection`s; the keyboard
skips the headers and type-ahead works across groups). Each option reads "name · example" in its
unit (`Bytes/s (IEC) · 1.5 KiB/s`); Custom has no example. Auto removes `vis.unit`; Custom writes
`{id: 'custom', suffix: ''}` and shows a Suffix field, invalid until typed (1 to 16 code points, no
spaces: "Suffix: 1 to 16 characters, no spaces", linked to the field; the draft's `checkBoardSpec`
blocks the save). When the preview's query was rated and the rewrite changes the unit, the field
says "Shown per second (B/s): the query is rated"; when the preview draws a heatmap (stored, or
Auto resolving to one: the editor passes the drawn kind), it says "Bucket bounds in B, counts per
second: the query is rated" instead, since a heatmap's bounds are never rated. A kind change keeps the unit (`withKind`).

**An older server.** A server before the units version refuses `vis.unit` with
`board.json.unknownKey` at the panel's `…/vis/unit`. The board page shows it as "This server does
not support panel units yet" (`unitsUnsupported`, `saveFieldMessage`), and so does the panel
editor's Unit field. A v7 binary cannot read a v8 head at all (`ErrSchemaTooNew`, 503).

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
| stat | `.statStack[data-stat-stack]`: the chart cell filling the body, and `[data-stat-threshold]` over it as the subline (with `data-crossed` when the value crossed a step). The chip is the header's tag, `[data-stat-chip][data-state]` (`StateGlyph` variant `tag`), when the panel has thresholds ([Panels › Stat tiles](panels.md#stat-tiles-282-part-2a)) |
| heatmap | the chart alone: no legend; thresholds are ignored |

- **Layout.** `useLegendLayout()` observes the stack's content height (one `ResizeObserver`): the
  table from `size.board-legend-table-min` (240 px) and while not yet measured, compact below. The
  stack fills the body, so the legend's own height never changes the layout. A 4-row panel is
  compact; 6 rows and up have a table.
- **First frame (#90).** The stack is measured once when it attaches (in the commit), and a line
  or bars chart mounts only then, so the layout is final before the chart is sized. In the same
  commit the chart cell's size goes into the panel's size memo, which the chart pre-sizes from: a
  chart under a legend, or a stat's full-body chart, is sized once and draws in its first frame.
- **Compact.** One chip per series (`[data-legend-item]`, 24 px tall, `title` = the full name,
  `data-series` = its colour index + 1) with its swatch, name and last value; "Legend table"
  (`[data-legend-table]`) opens the same table in a popover dialog named by the caption. The chip's
  look is in [Panels › Legend chips](panels.md#legend-chips-282-part-2a).
- **Isolation and sort.** `isolatedKey` and the sort are `PanelChart` state: never saved, never in
  the URL, and no request (the frame is `panelFrame(view, key)`). The isolation applies only while
  the rows still have the key.
- **Highlights.** `cellState(v)` is `stateOf(thresholds, v)` limited to watch, degraded and failing;
  mean, max and last are highlighted: `td.stateCell[data-state]` with the glyph (`aria-hidden`) and
  the hidden state name.
- **Stat.** `v = statValue(view.data)` (finite, else null). The chip is `unknown` for no value, the
  crossed step's state, or `ok`; the text is the crossed step (in its state's colour, `data-crossed`)
  or the next step (muted), as `<glyph> <displayText>`. `panelHealth(view)` is that chip state for a
  stat frame with thresholds, else null.

## Panel chrome and the health status line (#282 Part 2a)

The board's look ([VL-004, VL-017 and VL-019 as amended](../../designs/product/08-visual-language.md),
[Visual design](visual-design.md)):

| Element | Look |
|---|---|
| Panel (`.panel`) | `surface-1`, 8 px corners, `elevation-card` (its ring replaces the border; the 1 px border is transparent and draws in `CanvasText` under forced colours) |
| Header | 36 px (`size.board-panel-header`): the title (13 px semibold), the unit, the stat tag, the completeness badge (4 px corners); the tools fade in over `motion.quick` on hover and focus |
| Failing stat panel | `data-stat-state="failing"` and the failing StateEncoding class: `elevation-state`, a ring and a glow in the failing colour (`failing-glow`). Under forced colours a 2 px `CanvasText` border. The ring encodes health together with the tag's glyph (VL-007); no other state has a ring |
| Edited panel (Edit mode, `data-selected`) | a 3 px `accent` outline at 1 px offset |
| Dragged panel | `elevation-3` |
| Grid | 12 columns of 40 px rows with 12 px gaps (`size.board-gap`; `GAP` in `boards/layout.ts`). Saved boards keep their grid units, so an 8-row panel is 404 px tall (was 432) |
| Page | 12 px between the bar, the status lines and the grids; notices are `surface-2` with 6 px corners, no dashed border |
| Edit toolbar (`[role=group][data-mode="edit"]`) | a `surface-2` tray, 8 px corners, 4 px padding and gap; the Tags chips have 3 px corners |

**The health status line.** In the bar, after the Context summary, `<span data-board-health>` shows
the failing glyph ■ (`aria-hidden`, the failing colour) and "1 panel failing" or "n panels failing"
in `text-muted` 12 px; nothing when none is failing. It is not a live region: each panel's tag
carries its own state.

Each mounted board panel (`DataPanelFrame`) calls `useReportHealth(panel.id, panelHealth(view) ===
'failing')`: it reports when the value changes and forgets the panel on unmount. `BoardPage` owns
`useBoardHealthStore()`: the reports are a `Map` in a ref, and the count is state that changes only
when the number of failing panels does. So the line counts the panels **in view**: a collapsed
section's panels are unmounted and do not count until it is expanded, and full screen and the
editor preview render the body without the frame, so they never report a second time. A
`PanelFrame` without the provider (outside a board) reports nothing.

**The quick presets.** The header's time control shows the 15m, 1h, 6h, 24h and 7d presets inline
from 1280 px wide (IA-020 as amended): a SegmentedControl named "Quick range", each option named by
its visible label, then its full range ("1h (Last 1 hour)", so the name starts with what is shown,
WCAG 2.5.3). The current range's preset is checked, none for any other range;
choosing one sets `from=now-<range>&to=now`. The trigger still opens the time range dialog.

### The editor's Thresholds and Legend

`ThresholdsField` and the Legend select follow Visualisation (and the Unit field, #290). Every vis edit is one `updatePanel`
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
`/t/<tenant>/explore/metrics<board time>&q=<expanded>` plus `&vis=<kind>` unless the kind is Auto,
Logs or Pie (a bar chart opens `vis=barchart`, #173 Part 3b); for LogQL, `/t/<tenant>/explore/logs<board time>&q=<expanded>`, and null without
`expanded` (a stream panel's is its pager's `planned`, `streamMeta`). For PromQL `run.expanded` is
`planned.expanded` of the **current key's own** response: the data the key was fetched under
(`PanelOutcome.key`, compared with `sameKey`) and not a placeholder, or, after an error, the
rejection's `detail.planned`. Without it (gated, blocked, a first fetch in flight, a placeholder
from a previous key, an error without `planned`) the link is null: the menu item is disabled and
the header tool is a disabled button with the same name. A same-key refetch (Refresh under an
absolute window) keeps the link.

## The panel menu

Edit panel, **Duplicate**, **Remove**, **Open in Explore** (a React Aria `MenuItem` with `href`,
routed through the app's router) and Copy query; a bar chart adds its three toggles
([above](#the-panel-menu-toggles)). Duplicate and Remove dispatch `enterEdit`, then
`duplicatePanel` (the copy at `firstFree` of the same grid, title "`<title>` (copy)" cut to 200
code points, announced in the live region) or `removePanel` (focus then moves to Add panel); both
are disabled while a save is in flight.

A widget's menu has **Edit panel** when its kind has a registry def (Text, #198 Part 3a), then
**Duplicate** and **Remove** (T24-002): no Open in Explore, Copy query or Full screen. A duplicated
widget keeps its `vis` and has no `query`.

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
| `logs-frame` (Bar chart), stream `series` (Bar chart) | `series` | `category` of the answer, no baseline; the menu has no ghost item | `barchart` |
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
- Text widgets, Add widget and the widget editor (#198 Part 3a):
  [T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md) T24-008, T24-014, §5.2a;
  [05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md) VIZ-053 (the
  Text row); [T08](../../designs/technical/T08-dom-component-kit.md) T08-011.
- Panel units (#290): [T22](../../designs/technical/T22-value-categorical-and-table-panels.md)
  T22-015, T22-016, T22-017 and §6.2; [08 Visual language](../../designs/product/08-visual-language.md)
  VL-012; [05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md) VIZ-057
  (the units subset of Table 5-10); [T08](../../designs/technical/T08-dom-component-kit.md) T08-007,
  T08-008, T08-027; [T11](../../designs/technical/T11-postgres-schema.md) T11-016 (the v7 upcast).
- Board tags (#215): [T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md) T24-029
  and §5.5; [T11](../../designs/technical/T11-postgres-schema.md) T11-016 (the v3 upcast).
- The tags field and Save blocked by an invalid editor field (#216 Part 2b):
  [T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md) T24-029 (the field,
  `setTags`, the older server's text), T24-021 (the editor's search text), §5.2a;
  [T08](../../designs/technical/T08-dom-component-kit.md) T08-007, T08-008.
- Board spec v3 and the pending kinds (#173 Parts 1 and 2):
  [T22](../../designs/technical/T22-value-categorical-and-table-panels.md) §6.1 (`vis.options`),
  T22-002 and §4.5 (row 11 is not in the boards' set);
  [T11](../../designs/technical/T11-postgres-schema.md) T11-016 (the v2 upcast); the categorical
  transforms are on [the panels page](panels.md).
- Bar chart panels (#173 Part 3b):
  [T22](../../designs/technical/T22-value-categorical-and-table-panels.md) T22-006 (the meter's
  Narrow), T22-007 (the board filter, interim until #193), T22-008 (selection and brush), T22-011
  (the toggles), T22-012 (the baseline run), T22-013 (the table view), §4.5 (board auto keeps the
  default set); [T25](../../designs/technical/T25-inspector-and-pivots.md) T25-006, T25-012;
  [05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md) VIZ-003,
  VIZ-027, VIZ-037, VIZ-066;
  [ADR-0028](../../designs/adr/0028-chart-seam-bar-chart.md),
  [ADR-0029](../../designs/adr/0029-bar-chart-keys-and-brush.md).
