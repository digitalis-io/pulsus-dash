# The Inspector, the shared selection and the Esc ladder

A click on a chart mark, a log line or a stat tile **selects** it and opens the **Inspector**: a
floating sheet with the target's value, raw details, labels, pivot chips and the query. The
selection is shared by every panel of the page, which draws it on its next frame. One **Esc
ladder** per page clears the kinds' own state, then the selection, then the Inspector. This page
covers the code in `client/src/inspector/` and its wiring; the design is
[T25](../../designs/technical/T25-inspector-and-pivots.md) and
[ADR-0025](../../designs/adr/0025-chart-frame-selection.md), the look is mockup
[41-inspector](../../designs/mockups/41-inspector.svg).

## The host

`InspectorHost` (`inspector/host.tsx`) is mounted once per page: `BoardPage` (the board editor),
`MetricsPage` and `LogsPage` (T25-001). It owns, in memory only:

- the page **selection** (`Selection`: series or stream keys and an optional `[fromMs, toMs)`);
- the **Inspector** state: the request it shows, its sequence number, whether it is collapsed and
  the request's **navigation stack** (a pure reducer, `inspector/store.ts`; see
  [The navigation stack](#the-navigation-stack-234-part-4));
- the **registries** of member resolvers and Esc providers (`Map`s in refs). Member resolvers are
  a stack per panel (#234 Part 3 §4.9): the newest live registration answers, its disposer removes
  only its own entry and the one before answers again (a full screen closing, StrictMode's
  re-mount). Esc providers: the last registration wins, and a disposer removes only its own entry.
  A `geo:` run id is answered from the open request's **top view** (`resolveGeoMembers`), never
  from a registration;
- the page's one `document` `keydown` listener (the Esc ladder) and the live region.

| Prop | Board | Explore |
|---|---|---|
| `surface` | `'board'` | `'explore'` |
| `filters` | the board's `f=` filters, in URL order | `[]` (Explore applies none until I3) |
| `originKey(panelId)` | JSON of the panel's `[query, vis]`, or null when the panel is gone | the page's `q` |
| `onEditQuery(origin)` | opens the panel editor for `origin.panelId` | focuses the query editor |

Kinds reach the host only through hooks:

| Hook | Returns |
|---|---|
| `useInspector()` | `InspectorHostApi` (`inspect`, `select`, `registerMembers`, `resolveMembers`, `registerEscape`), or null without a host |
| `useSelection()` | the page selection, or null |
| `useInspectedPanelId()` | the board panel the Inspector was opened from (the origin outline, T25-014) |
| `useChartInspect(origin)` | `{ onInspect, onEmptyClick }` for `ChartFrame` and `LogStream`; `{}` without a host |

**Lifetime (T25-012).** The Inspector shows a snapshot. A refresh or a window change keeps it; it
closes when `originKey` of its panel changes (the panel removed, its query or vis edited, Explore
ran another query) or the path changes. Leaving the page (another route, tenant or board) unmounts
the host, and everything goes with it. A tenant change that keeps the page mounted (Back or Forward
between two tenants on the same Explore route) resets the host before it renders: the selection, the
sheet (with no close fade), and the live region's text and pending write all go, so nothing of one
tenant shows in another (T25 §8). The pages' result areas are keyed by tenant as well (Explore ›
Metrics' Result card, Explore › Logs' results column), so a cached result of the new tenant is drawn
on a new canvas and engine frame and in a new log list; a board is keyed by tenant and board, so its
panels' canvases are new too. The selection survives a close.

## The payload

A kind sends one `InspectRequest` (`inspector/types.ts`):

| Field | Meaning |
|---|---|
| `origin` | `surface`, `panelId` (null on Explore), `title`, `query` (board: the panel's expanded text; Explore: `q`; null before a run), the Context `window` at the gesture, `unit` |
| `target` | one member of `InspectorTarget`: `point` (line, bars), `bucket` (heatmap), `value` (stat), `logLine`, `mark` (the bar chart, #173 Part 3a), `geo` (the map, #234 Part 3) |
| `selection` | what the inspect selects: `selectionOf(target)` |
| `source`, `returnFocus` | pointer or keyboard; the element focus returns to on close |

`inspectorModel(req, env)` (`inspector/model.ts`) is pure. It renders every target into the fixed
sections, in order: header, value, details, labels, members (when the target has them), pivots,
query and actions (T25-003). Empty sections say why: "No labels", "No query: run the panel first".
Values go through `formatValue` with a "Raw" fact; NaN reads "no value"; times are in the page's
zone to the millisecond, and a log line also shows its exact nanoseconds (T25-004).

| Target | Primary | Details | Selection |
|---|---|---|---|
| `point` | the value in the panel's unit | Raw, Time | `{[key], null, null}` |
| `bucket` | the count in the count unit | Range (`≤ hi`, `lo – hi`, `> lo`), Raw count, From – to | `{[], tMs, toMs}` |
| `value` | the value; a crossed threshold shows its state colour and glyph | Raw, Time (if any), State (if any) | `{[key], null, null}`, or none for a scalar |
| `logLine` | the line (monospace, scrolls past 120 px) | Level, Time in ns, Local time; Metadata and Parsed labels | `{[streamKey], ms, ms + 1}` |
| `mark` | the value in the target's unit (`no data` when not finite); a crossed threshold shows its state; no subheading | Raw, Baseline (finite only), State (if any), Series key, Reduced over `<from> – <to>` (`formatClockMs`) | `{[key], null, null}`, or the members' keys for an aggregate |

A `mark` target is `{ type: 'mark', target: InspectTarget }`, where `InspectTarget` (also in
`inspector/types.ts`) is `{ panelId, kind: 'barchart', title, mark, members, unit, window, query }`:
the reduced mark, its members (null until I3), the unit and the window it was reduced over. It has
no instant: the announcement has no time, the pivots keep the origin window, and Explore opens with
`vis=barchart`. Its labels are the mark's; members are not listed yet (I3). `barAction`
([Categorical panels](panels.md#the-pick-decision-visbaractionts)) builds it from a bar's `pick`.

### The geo target (#234 Part 3)

`{ type: 'geo', target: GeoInspectorTarget }` (`vis/geo/targets.ts`) is a snapshot of the map's
rows built by `geoTarget`; `inspectorModel` renders it with `inspector/geoModel.ts`
([T24 §4.13](../../designs/technical/T24-geo-schematic-and-widget-panels.md),
[T25 §4.9](../../designs/technical/T25-inspector-and-pivots.md)). The heading is the target's
title; the selection is its rows' keys.

| Kind | Subheading | Primary | Details | Members | Pivots |
|---|---|---|---|---|---|
| `marker` | the place, else the location status | the value; a crossed state | Value status (OK, No value, Infinite, Out of range), Location (4 dp) or its status, Source `‹key› ‹code› (‹provider›)` (coordinates: `‹key› lat, lon`), Location detail `‹status›: ‹detail›` (when not placed), Group (`… (in other (n))` for an aggregated row), Draw (On the map, Not placed, Outside the map, Not drawn: no usable value, Not drawn: cap) | — | the `mark` pivots over the origin window, from the row's labels |
| `cluster` | `near ‹seed place›` | `min – max` | Worst state, Values | its rows (names, with their labels) | none |
| `aggregate` | `‹n› groups, ‹m› series` | `min – max` | — | its member groups (final labels, with `{groupBy: value}`) | none |
| `group` | `‹m› series` | `min – max` | Worst state, Values | its rows | none |

Members show entries 0–7 with their label maps; with more than eight, `resolve` is
`{panelId, runId: 'geo:' + id}`, and the host answers it from the open request's top view. `next`
opens an entry's deeper view (#234 Part 4): a `cluster` or `group` row → the `marker` of that row,
an `aggregate` entry → its `group`; each selects its own rows and is titled by the entry's text. A
marker has no members. The announcement is `Inspector: `, then `Level ‹d + 1›: ` for a view at
depth d > 0, then a marker's `‹name›, ‹value›[, ‹state›]`, a cluster's `Cluster of ‹n›, near
‹place›[, worst ‹state›]`, the aggregate's `other (n), ‹n› groups, ‹m› series` or a group's
`‹label›, ‹m› series[, worst ‹state›]`.

### The navigation stack (#234 Part 4)

A member entry can open a deeper view inside the open request
([T25 §4.8](../../designs/technical/T25-inspector-and-pivots.md)). The views are a stack in the
host's state, never new requests: nothing is fetched, so there is nothing to race, and every view
is built from the root target's snapshot (a refresh never changes an open view).

| Piece | What it is |
|---|---|
| `NavView` (`types.ts`) | `{ target, selection, title }`: one deeper view |
| `InspectorState.nav` | the pushed views, in order; `[]` at rest. The **top** is `topOf(state)`: the last view, else `req.target` |
| `push {seq, depth, view}` | applies only while a request is open, `seq` is its `seq` and `depth` is `nav.length`; the selection becomes the view's, and a collapsed sheet expands. Anything else is a no-op: an entry of an older request, a second press before the next render, a press after a close |
| `pop {to}` | for `0 ≤ to < nav.length`: keeps `nav.slice(0, to)`; the selection becomes the new top's (`req.selection` at 0); a collapsed sheet expands, so an Esc pop from the tab shows and focuses the parent's heading |
| reset | `inspect`, `close`, a matching `originChanged` and `reset` empty the stack; `select` keeps it |
| `MemberSection.next` | `(i) => NavView \| null`: geo targets only; null for every other kind, whose entries stay plain text |

The sheet renders `inspectorModel({ ...req, target: top }, env, nav.length)`. With a non-empty
stack its header shows **Back to ‹previous›** (the title of the view below, else the root's
heading), a `pop` to `nav.length − 1`, and the **Inspector path**: a `<nav aria-label="Inspector
path"><ol>` of the root heading and each view's title, where every item but the last is a `pop`
button to its depth. With `next`, every text entry, shown or expanded, is a button that pushes its
view at the render's `seq` and depth.

**`viewKey`** = `${seq}:${nav.length}:${topKey}`, `topKey` the top's id for a `geo` target and
`root` for every other kind (so for them it changes exactly when `seq` does). It is the identity
of:

- the content (its React key: the members' expanded state starts over in each view);
- the layers (an inert leaving layer for 150 ms, at most one; none under reduced motion);
- the heading focus: every push and pop focuses the new `h2`, whatever the open's source; a
  keyboard open focuses it as before;
- the live region: one write per change, at most one per 500 ms, the latest wins; a text equal to
  the last one is cleared and rewritten on the next frame, so it is read again.

The Esc ladder pops before it clears the selection, and the stack goes with the request: a close,
the origin panel removed or its query or vis changed, a route change and a tenant reset (T25-012).
A marker view's pivots use the request's origin window, so a window change after the push does not
move them.

**Member ids.** `resolveMembers(panelId, runId)` with a `geo:` run id answers from the host's own
state: when the top is a `geo` target, the request's origin is `panelId` and `runId` is `'geo:' +
top.id`, it returns `resolveGeoMembers(top, runId)` (every entry's text and labels, from the
snapshot); otherwise null, which the sheet shows as stale. No panel instance holds geo state, so a
board panel, its full screen and the editor preview answer alike in any mount order. Other run ids
use the per-panel resolver stack.

### Adding a kind

1. Add a member to `InspectorTarget` and a case to `body()` in `model.ts` (and to `visOf`,
   `pivotInstant` and `selectionOf`).
2. Build the target in the kind and call `onInspect(target, source, returnFocus)` from
   `useChartInspect(origin)`; fields repeated from the origin must be equal (T25-002).
3. If the kind has its own Esc steps (a search field, a brush), register them with
   `registerEscape(panelId, { pre, post })`. `pre()` and `post()` return the next step or null.
4. If its members resolve lazily, register `registerMembers(panelId, resolver)` and dispose it
   on unmount.

## Gestures (T25-005)

| Kind | Pointer | Keyboard |
|---|---|---|
| line, bars, heatmap | a click on the plot: the engine's `select` event names the mark (an empty click clears the selection) | Enter or Space on the crosshair slider inspects its selected row |
| stat | a transparent "Inspect <title>" button over the tile | Enter or Space on it |
| logs | a row click (not while a text selection is anchored in the row) | Enter on the list focuses its first visible row; ↑ and ↓ move by one row; Enter or Space inspects |

A click is a left press with no modifier that travelled less than `chart-brush-min` (4 px,
Euclidean) and committed no camera move; anything more is the camera's. Series-table rows (Explore
and the board legend) have a leading **Select** toggle (T25-016): it writes the selection, and
pressing it again clears it. The series name still isolates.

## Selection drawing

Every `ChartFrame` reads `useSelection()` and calls `frame.setSelection(sel)`; the engine draws it
in its layer pass on the next frame, in every panel including the source (T02-025, ADR-0025). A
frame dims only if one of the keys is among its own series; otherwise it draws only the interval:

| Kind | Drawing |
|---|---|
| line | unselected series at `opacity.dimmed` (0.35); each selected series over a `focus` underlay 4 px wider |
| bars | unselected segments dimmed; a selected segment gets a 2 px inner `focus` stroke |
| line, heatmap with an interval | a `selection` band over `[fromMs, toMs)`, at least one device pixel wide |
| stat | its key selected: a 2 px `focus` ring inside the tile |

The frame host mirrors the keys in `data-selection-keys`. `LogStream` matches rows itself
(`logRowMatch`): a matching row gets the `selection` background, a 2 px `focus` bar, the hidden
word "selected" and `data-selected`; when the selection is relevant to the stream (a key among its
loaded streams, or an interval with no keys) the other rows show their line in `text-muted`
(`data-muted`), never a lowered alpha (VL-009).

## The Esc ladder (T25-007)

The host's one `document` listener (bubble phase) skips an event that is not Escape, is already
`defaultPrevented` or `isComposing`, comes from inside `[role=dialog]`, `[role=menu]`,
`[role=listbox]` or `.cm-editor` (unless every such owner around it is marked
`data-escape-ladder`, as a bar chart's mirror listbox is, ADR-0029), comes from an `input`, `textarea` or `select` not marked
`data-escape-ladder`, or arrives while an `[aria-modal=true]` element exists. Otherwise each Esc
runs the first step that applies and prevents the default:

1. the active kind's `pre` step (for example "clear the field" for a marked search field);
2. pop the navigation stack (`pop {to: nav.length − 1}`), while it is not empty;
3. clear the selection;
4. close the Inspector (focus returns to `returnFocus`, else the origin panel, else `main`);
5. the active kind's `post` step.

The active kind is the Inspector's origin when focus is in the sheet, else the panel holding focus
(`[data-panel-id]`), else the last panel pressed. The crosshair and a press in progress keep their
own Esc in `ChartFrame` and the engine.

## Pivots and their Context (T25-009, T25-010)

The chips, in order: Explore (boards only), Logs ±1 min, Traces, Profiles, Entity, Label filter.
An enabled chip is a link: a plain or Shift click navigates in place; ⌘ or Ctrl and the middle
button open a new tab (INT-036 interim). A disabled chip stays focusable, dashed, described by its
reason, which is also listed under the chips.

| Chip | Available when | Goes to |
|---|---|---|
| Explore | the board panel has run (`origin.query`) | `exploreHrefFor(tenant, lang, vis, search, text)`: the panel's expanded query, with the Context's time and refresh; no `f=` |
| Logs ±1 min | the logs selector has a matcher | Explore › Logs at the target's instant ± 1 min (a bucket: its column ± 1 min; no instant: the origin window), refresh off, `q` the selector |
| Traces, Profiles, Entity | never in I1 | — |
| Label filter | from I3 | — |

**The logs selector** is the target's identity AND the translated filters, every constraint kept:
the identity is `service_name`, else `job` translated; a log line uses every stream label. The
IA-027 interim seed translates `job` to `service_name` = the part after the last `/` (dropped when
empty), drops `instance`, and keeps any other key. Matchers are deduplicated, sorted by key then
value, and LogQL-escaped (`\`, `"`, LF). A filter that sets an identity key to another value stays
too, so the destination honestly matches nothing.

**Context lines** under each enabled chip:

- `Carried: time, filters · Not carried yet: baseline` when the chip carries every active filter,
  else `Carried: time · Not carried yet: baseline`;
- Explore with filters: `Filters not applied in Explore yet: env, instance` (unique keys, URL
  order);
- Logs: `Not carried to logs: instance` for each dropped filter key, and `Context filter
  job=shop/web conflicts with this target: no logs can match` per conflicting filter.

## Actions and copy (T25-015)

Copy value and Copy query write the clipboard on the click only (T08-021); a refusal shows
"Couldn't copy" for 4 s. ✎ calls `onEditQuery`. Pin, Create alert and Ask AI ✦ are
`aria-disabled` with their M-UI4 reasons until `capabilities.{investigations, alerting, ai}`.

## The sheet (T25-008, T25-013)

`<aside role="complementary">` labelled by its `h2`, fixed over the content column: inset
`size.inspector-inset` from the header, the right and the bottom, `size.inspector` wide (at most
the content width less 24 px). It never reflows the board, so nothing re-queries.

- **Material:** `material-menu` with `material-filter` (a 24 px backdrop blur and 180 %
  saturation), a 1 px `hairline`, `elevation-2`, `radius.md`. Without `backdrop-filter` support,
  under `prefers-reduced-transparency: reduce` or under forced colours it is opaque `surface-1`
  without the blur; a browser without the reduced-transparency query keeps the material ([Visual design](visual-design.md#elevation-and-materials)). While a modal dialog is open the sheet steps aside.
- **Motion:** it opens with a fade and a 16 px slide over `motion.float-open` (200 ms); a new view
  (a new target, a push or a pop: a new `viewKey`) crossfades the body over 150 ms (the outgoing
  layer is `inert` and `aria-hidden`; a third view drops it at once); a close fades over 150 ms.
  Under `prefers-reduced-motion` every change is instant.
- **Collapse:** a 40 px tab (`size.inspector-tab`) at the right edge holds Expand. A new target
  expands it.
- **Focus:** a pointer open keeps focus; a keyboard open, a push and a pop focus the heading. Tab
  order: Back and the path (with a stack; they sit above the heading), heading, Collapse, Close,
  Copy value, member buttons, pivot chips, Copy query, ✎, actions. A close by Esc or Close returns
  focus as the ladder says; an automatic close moves focus only when it was in the sheet.
- **Live region:** one polite region outside the sheet gets the model's `announce` text once per
  `viewKey`, at most once per 500 ms (the latest wins, T08-018); the same text again is cleared and
  rewritten on the next frame.
- **Source cue:** the origin board panel has a `size.focus-ring` (3 px) `focus` outline at a `size.focus-offset` (1 px) offset
  (`data-inspector-origin`).

## Tokens

| Token | Value | Use |
|---|---|---|
| `color.material-menu` | dark `#1E2127EB`, light `#FAFBFCE6`; `color.surface-1` without translucency | the sheet |
| `color.selection` | `accent` at 16 % | the band, selected log rows and table rows |
| `opacity.dimmed` | 0.35 | unselected marks |
| `size.inspector`, `size.inspector-tab`, `size.inspector-inset` | 360, 40, 12 px | the sheet |
| `radius.md` | 10 px (was `radius.float`) | the sheet |
| `elevation.2`, `material.filter` | the menu elevation; `blur(24px) saturate(180%)` | the sheet |
| `motion.float-open` | 200 ms | the opening |

## Limits

- Nothing is persisted and there is no API: the selection and the Inspector die with the page.
- Traces, Profiles, Entity and Label filter are listed but disabled; Pin, Create alert and Ask AI
  arrive with M-UI4; the dock and split views are later issues (T25 §11).
- Members appear only for kinds that have them (state runs, marks, flames: #170, #173, #177).

## Tests

`unit:inspector-model`, `unit:inspector-pivots`, `unit:pivot-context` (`model.test.ts`);
`unit:inspector-members`, `unit:geo-members` (`members.test.ts`); `unit:escape-ladder`,
`unit:escape-skips`, `unit:host-registries`, `unit:inspector-collapse`, `unit:inspector-nav`,
`unit:geo-members-fullscreen` (`host.test.tsx`); `unit:inspector-nav` and `unit:inspector-viewkey`
(`store.test.ts`); `unit:clipboard-denied`, `unit:inspector-focus`, `unit:inspector-crossfade`,
`unit:inspector-viewkey` (`Inspector.test.tsx`); `unit:engine-select`, `unit:selection-draw`
(the engine); `unit:inspect-target`, `unit:chart-inspect`, `unit:series-select`,
`unit:log-selection`, `unit:log-inspect`; the end-to-end rows in `e2e/inspector.spec.ts`;
`bench:inspector-redraw` (report).

## Design references (T25 map)

| Rule | Where |
|---|---|
| T25-001 one host per page | `InspectorHost` in `BoardPage`, `MetricsPage`, `LogsPage` |
| T25-002 envelope and union | `inspector/types.ts`, `charts/inspectTarget.ts`, `LogStream` |
| T25-003, T25-004 sections and raw values | `inspector/model.ts`, `Inspector.tsx` |
| T25-005 gestures | engine `select` (`canvas2d/select.ts`), `ChartFrame`, `LogStream` |
| T25-006 shared selection | `host.tsx`, `canvas2d/selection.ts`, `logRowMatch` |
| T25-007 Esc ladder | `inspector/escape.ts`, `host.tsx` |
| T25-008 focus and live region | `Inspector.tsx`, `host.tsx` |
| T25-009, T25-010 pivots and Context | `inspector/pivots.ts`, `model.ts`, `boards/exploreLink.ts` |
| T25-011 members | `inspector/members.ts`; entry buttons in `Inspector.tsx`; geo `next` in `geoModel.ts` |
| T25-012 lifetime | `host.tsx` (`originKey`), `store.ts` (the stack goes with the request) |
| T25 §4.8 navigation stack | `inspector/store.ts` (`nav`, `push`, `pop`, `topOf`, `viewKey`), `Inspector.tsx` (Back, the path), `host.tsx` (the Esc pop, member ids) |
| T25-013 look and motion | `Inspector.module.css` |
| T25-014 source cue | `PanelFrame` (`data-inspector-origin`) |
| T25-015 actions | `Inspector.tsx` |
| T25-016 table-row source | `SeriesTable` |
