# T25 — Inspector and pivots

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.7-rc · 2026-11-26 |
| **Milestone** | M-UI2 (host, selection, Esc ladder, pivots on boards and Explore) → M-UI4 (Pin, Create alert, Ask AI) |
| **Related ADRs** | [ADR-0007](../adr/0007-in-house-vis-engine.md), [ADR-0014](../adr/0014-typescript-react-web-client.md), [ADR-0017](../adr/0017-react-router.md), [ADR-0021](../adr/0021-query-planning-is-server-side.md), [ADR-0025](../adr/0025-chart-frame-selection.md), [ADR-0027](../adr/0027-geomap-frame-seam.md), [ADR-0029](../adr/0029-bar-chart-keys-and-brush.md) |
| **Source draft** | plans/164, plans/184 (not tracked) |

This document is the chart **Inspector**, the shared **selection**, the **Esc ladder** and the **pivot
chips** for every vis (rules T25-001 to T25-016, mockup [41-inspector](../mockups/41-inspector.svg)).
[T21](T21-time-and-distribution-panels.md), [T22](T22-value-categorical-and-table-panels.md) and
[T23](T23-graph-trace-profile-and-hierarchy-panels.md) cite this payload as normative.

## 1. Context & problem

[INT-034](../product/03-interaction-model.md#int-034--click-selects-and-opens-the-inspector) asks that a
click selects and opens an Inspector with labels, raw values, the query, pivot chips and actions.
[INT-035](../product/03-interaction-model.md#int-035--pivot-chips-keep-context) and
[IA-026](../product/02-information-architecture.md#ia-026--context-propagation) ask that pivots keep
Context, and [INT-016](../product/03-interaction-model.md#int-016--esc-and-enter-ladder) asks for one
`Esc` ladder. T21–T23 each emit an Inspector payload, so the contract must be shared: a panel per kind
would drift.

The approach: one host per page (board, Explore › Metrics, Explore › Logs) owns the **selection**, the
**Inspector** and the **Esc ladder**. Kinds send one `InspectRequest`, whose `type` union carries the
T21–T23 payloads unchanged. One pure `inspectorModel()` renders them all. Pivots are links built from
the full Context. Behaviour that needs later surfaces is **staged by product amendments** (INT-034,
INT-036, IA-026, IA-027), each with interim acceptance and a delivering issue (§11). The look is a
floating translucent sheet, one elevation, and 200 ms ease-out.

## 2. Goals / non-goals

Goals: the host, the payload union, the shared selection with its highlight in every panel, the Esc
ladder, the fixed Inspector sections, the pivot chips with their disclosed Context, and the look.

Non-goals (out of scope):
- the dock host ([VL-018](../product/08-visual-language.md#vl-018--floating-dockable-panels), T08 §4.4);
- the Traces, Profiles and Entity pivots;
- Correlate's pinned inspectors;
- the IA-026 focus-instant marker;
- the M-UI4 actions themselves (Pin, Create alert, Ask AI).

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [VIZ-003](../product/05-visualisation-catalogue.md#viz-003--universal-interactions-on-every-vis) | §4.1 (T25-001, T25-005, T25-009) | `e2e:inspector-open` |
| [INT-016](../product/03-interaction-model.md#int-016--esc-and-enter-ladder) | §4.1 (T25-007) | `unit:escape-ladder`; `e2e:inspector-escape` |
| [INT-016](../product/03-interaction-model.md#int-016--esc-and-enter-ladder), [INT-034](../product/03-interaction-model.md#int-034--click-selects-and-opens-the-inspector) (#184: the navigation stack and the `geo` target) | §4.1 (T25-007, T25-008, T25-011), §4.8, §4.9 | `unit:inspector-nav`; `unit:inspector-viewkey`; `unit:geo-inspect` |
| [INT-034](../product/03-interaction-model.md#int-034--click-selects-and-opens-the-inspector) (staged) | §4.1 (T25-003, T25-004, T25-015) | `e2e:inspector-sections`; `unit:inspector-model` |
| [INT-035](../product/03-interaction-model.md#int-035--pivot-chips-keep-context), [IA-026](../product/02-information-architecture.md#ia-026--context-propagation) (staged) | §4.1 (T25-009, T25-010) | `unit:inspector-pivots`; `unit:pivot-context`; `e2e:pivot-destination` |
| [INT-036](../product/03-interaction-model.md#int-036--pivot-opens-as-a-split) (staged) | §4.1 (T25-009) | `e2e:inspector-pivot-nav` (with sections) |
| [IA-027](../product/02-information-architecture.md#ia-027--label--attribute-translation) (staged) | §4.1 (T25-010) | `unit:pivot-context` |
| [T02-025](T02-vis-engine.md#t02-025--selection-is-shared) | §4.1 (T25-006, T25-016) | `unit:selection-draw`; `unit:log-selection`; `e2e:selection-sources`; `e2e:selection-logs` |
| [VL-014](../product/08-visual-language.md#vl-014--purposeful-motion-only), [VL-016](../product/08-visual-language.md#vl-016--reduced-motion) | §4.4 (T25-013) | `e2e:inspector-motion`; `golden:inspector` |

## 4. Design

### 4.1 Design rules

#### T25-001 — One host per page
**MUST** — `BoardPage`, `MetricsPage` and `LogsPage` each mount one `InspectorHost`. Kinds use only
`InspectorHostApi` and never render their own detail panel.

#### T25-002 — Envelope and union
**MUST** — Kinds emit `InspectRequest` (§5). The T21–T23 payloads travel unchanged under their `type`,
and fields repeated from `origin` MUST be equal (a unit test per kind). A new kind adds a member and an
`inspectorModel` case.

#### T25-003 — Fixed sections
**MUST** — `inspectorModel` is pure. The sections, in order: header, value, details, labels, members (if
any), pivots, query, actions. The five INT-034 sections are always present, and an empty one says why
("No labels"; "No query: run the panel first").

#### T25-004 — Raw values
**MUST** — `formatValue`, plus "Raw <String(value)>". Times are in the page's zone, `HH:mm:ss.SSS`; a log
time is the exact ns as a decimal string. NaN reads "no value".

#### T25-005 — Gestures
**MUST** — §4.2. A click is a left press with no modifier that moved < `chart-brush-min` px and committed
no camera move.

#### T25-006 — Shared selection
**MUST** — One page `Selection`, in memory only (T21-009).
- **Write:** `select(sel, source)` from any source (mark, table row, brush, member row), which never
  opens or closes the Inspector; `inspect` writes `req.selection` and opens.
- **Read:** `useSelection()`.
- **Propagation (I1):** every `ChartFrame` reads it from context and calls `frame.setSelection(sel)`,
  and the engine draws it on the next frame (T02-025), in every panel including the source.
- **Relevance:** a frame dims only if at least one selection key is in its own data. Otherwise (a
  foreign key, such as a log stream key on a line panel) it draws only the interval.
- **Line:** a matched series is drawn last, its stroke over a `focus` underlay 4 px wider; the others
  at `dimmed` alpha.
- **Bars:** unmatched segments at `dimmed`; matched ones with a 2 px inner `focus` stroke.
- **Heatmap and line, with an interval:** a `selection` band over [fromMs, toMs), at least 1 device px
  wide.
- **Stat:** its key matched → a 2 px `focus` ring inside the tile.
- Empty keys and a null interval leave every mark as it was.
- New tokens: `dimmed` = 0.35 (alpha), `selection` = `accent` at 16 %. The frame host also mirrors
  `data-selection-keys`.
- **LogStream** reads `useSelection()` too. A row matches when its `streamKey` is in the keys (if any
  are given) and its time is in [fromMs, toMs) (if an interval is given). Matching rows get a
  `selection` background, a 2 px `focus` bar in the gutter, `data-selected=""` and the hidden text
  "selected". Muting follows the relevance rule: when a selected key is one of the panel's loaded
  streams, or the selection has an interval and no keys, non-matching rows show their line in
  `text-muted`. A selection whose keys are all foreign mutes nothing: the DOM form of `dimmed`, because
  alpha on text would break VL-009 contrast. A null selection restores every row.
- A log row inspect writes {[streamKey], tsMs, tsMs + 1}, so time panels mark the instant.

#### T25-007 — One Esc ladder
**MUST** — The host owns one `document` `keydown` listener (bubble). It skips events that are
`defaultPrevented` or `isComposing`, events inside `[role=dialog]`, `[role=menu]`, `[role=listbox]` or
`.cm-editor` (CodeMirror keeps its own Esc), events in an `input`, `textarea` or `select` **not** marked
`data-escape-ladder`, and any event while `[aria-modal=true]` exists. An owner (`[role=listbox]` and
the others) marked `data-escape-ladder` is not skipped, unless another unmarked owner surrounds it
(amended by #173 Part 3a: a bar chart's mirror listbox, [ADR-0029](../adr/0029-bar-chart-keys-and-brush.md)).

A kind's own search or filter field is marked `data-escape-ladder`. It registers its local Esc as the
kind's pre step ("clear the field", which applies while the field is non-empty), and focus stays in the
field.

Each Esc runs the first step that applies: the **active kind's `pre`** → **pop** (`pop {to: nav.length
− 1}`, while the navigation stack is non-empty, §4.8) → clear selection → close Inspector → the
**active kind's `post`**; then `preventDefault`. The active kind is the Inspector's
origin when focus is inside it; else the panel holding focus; else the last panel pressed. Kinds
register with `registerEscape`. Only a press cancel and the keyboard crosshair stay local in
`ChartFrame`. T23-011 = pre [exit Fly, clear brush, clear search], post [re-root, overview].

#### T25-008 — Focus and SR
**MUST** — `<aside role="complementary">` labelled by an `h2` (`tabIndex=-1`). A pointer open keeps
focus; a keyboard open focuses the heading, and so does every `push` and `pop` (§4.8), whatever the
open's source. Close focuses `returnFocus` if it is connected, else the
origin `[data-panel-id]`, else `main`. `model.announce` goes to one polite region (≤ 1 per 500 ms,
latest wins; T08-018), written once per `viewKey` change (§4.8); a text equal to the last one is
cleared and rewritten on the next frame, so it is announced again. Tab order: collapse, close, copies, members, pivots, ✎, actions. Disabled items
stay focusable (`aria-disabled`, `aria-describedby` = the reason).

#### T25-009 — Pivot chips
**MUST** — §4.3, in a fixed order, as `<a href>`. INT-036 interim: plain or Shift-click navigates;
⌘/Ctrl or middle-click opens a new tab. A chip that does not apply to the surface is omitted. An
unavailable chip is listed, disabled, with its reason as visible text.

#### T25-010 — Pivot Context
**MUST** — `pivotContext` carries **every `ContextSearch` member** except the time members a pivot sets
(from, to, refresh), plus the active **filters** (board `f=`, in URL order).
- **Explore** (until I3 makes it apply `f=`): the href carries no `f=`, and the Context line reads
  "Filters not applied in Explore yet: env, instance"; board panels do not apply `f=` either ("No panel
  query reads them yet"), so Explore shows what the panel showed.
- **Context line:** under each enabled chip, "Carried: time, filters · Not carried yet: baseline" (it
  lists only the members the destination drops).
- **Translation:** cross-signal pivots translate them with the built-in seed (IA-027 interim): `job` →
  `service_name` = the part after the last `/` (dropped if empty); `instance` → not carried; any other
  key → the same key. Filters not carried are named under the chip ("Not carried to logs: instance").
- **Logs selector:** the target's identity (`service_name`, else the translated `job`; for `logLine`,
  every stream label) **AND** the translated filters: every constraint is kept, and nothing overrides
  anything. When a translated filter and the identity set different values for one key, both matchers
  stay (sorted by key, then value; identical matchers appear once), so the destination honestly matches
  nothing, and the line reads "Context filter job=shop/web conflicts with this target: no logs can
  match". Values are LogQL-escaped (`\`, `"`, LF).
- **Map area** (#184 step 2, [T24-098](T24-geo-schematic-and-widget-panels.md#t24-098--map-area)):
  only while the board's `geo=` is effective, the filters gain "map area" and the destination never
  gets it (no `geo=` in any href): Explore "Filters not applied in Explore yet: ‹keys›, map area";
  logs, traces and profiles "Not carried to ‹dest›: …, map area". An inactive `geo=` is never
  disclosed.

#### T25-011 — Members, two lists
**MUST** — **texts** (≤ 8 shown of `textCount`) and **runs** (≤ 8 shown of `memberCount`; omitted when
0), each with its own "+k more" (k = count − shown). With a non-null `next` (§5; `geo` targets only),
every text entry, shown or expanded, is a `<button>` that pushes `next(i)` (§4.8); with `next` null the
entries stay plain. The first press resolves once:
`resolveMembers(panelId, runId)` for `stateRun`; `mark` lists are already complete. A result is
**complete** iff texts.length = textCount and members.length = memberCount. The pressed list then shows
everything (scrolling at ≤ 240 px) with "Show fewer", and the other list keeps its own button. A `null`
or mismatched result is **stale**: both lists keep 8, and "The full list is no longer available: the
panel has new data" replaces the buttons. A new target resets the state.

**Bins (#154).** A `bin` target has one section: texts (≤ 8 shown of `count`) with parallel
`labels`, and `runs` null. Its `resolve.runId` is the target's `binId` (the bin's series) or
`${binId}:groups` (an `other` bin's member groups). A result is complete iff texts.length = count
and, when `labels` is present, labels.length = texts.length. The panel's resolver returns null when
the `frameSeq` in the id is not its current frame; null or incomplete is stale, as above. Each
resolved entry with labels gets its own chips (T25-009). `expandMembers` keeps the labels parallel to the texts, for the entries shown first (`texts.labels`) and for the resolved list (`MemberList.labels`), so expanding never drops a chip.

#### T25-012 — Lifetime
**MUST** — A snapshot, kept through refresh and window changes. It closes when the origin panel is
removed or its query or vis changes, when Explore runs a different query, and on route change; its
navigation stack (§4.8) goes with it.

#### T25-013 — Look and motion
**MUST** — §4.4. It floats over the content and never reflows it; it collapses to a 40 px tab. Under
reduced motion nothing animates; under reduced transparency or forced colours it is opaque `surface-1`.

#### T25-014 — Source cue
**MUST** — On a board, the origin panel has a 2 px `focus` outline at a 2 px offset, with no animation.

#### T25-015 — Actions, staged
**MUST** — The copy actions write the clipboard on the gesture only (T08-021); on refusal, "Couldn't
copy" shows for 4 s. ✎ is `onEdit(panelId)` on a board and `QueryEditorHandle.focus()` on Explore.
Pin, Create alert and Ask AI ✦ follow `env.capabilities.{investigations, alerting, ai}`, which are
false until [IA-007](../product/02-information-architecture.md#ia-007--investigations),
[ALR-010](../product/07-alerting.md#alr-010--create-alert-from-every-inspector) and
[AI-030](../product/06-ai-copilot.md#ai-030--ask-ai-from-the-inspector) (M-UI4). Their reasons:
"Available with investigations (M-UI4)", "… alerting (M-UI4)", "… the AI assistant (M-UI4)".

#### T25-016 — Table-row source
**MUST** — Series-table rows (Explore, board legend table) gain a leading 24 px toggle "Select <name>"
(`aria-pressed` = key selected). It calls `select({keys:[key], fromMs:null, toMs:null},
{kind:'tableRow', panelId})`, or `select(null)` when already selected. The name button still isolates.

### 4.2 Gestures and targets (T25-005)

| Kind | Pointer click | Keyboard | Target · selection |
|---|---|---|---|
| line | The hover row whose y is nearest the pointer y at the snapped time (ties: earlier draw order); no row → `item: null` → `select(null)` | Enter/Space on the crosshair: `sortedRows(hover.rows)[selected]` | `point` · {[key], null, null} |
| bars | The stacked segment containing the pointer y, else the nearest by y (ties: lower stack index) | As line | `point`, named by its category value |
| heatmap | The bucket under the pointer | The selected keyboard row | `bucket`: lower = bounds[i−1], null for i = 0; toMs = the next column start, or tMs + the last column width · {[], tMs, toMs} |
| stat | A transparent `<button>` "Inspect <title>" over the frame | Enter/Space | `value`: the first series' last finite sample, or the scalar (key null); state = the `statState` chip |
| logs | A row click (not while a text selection is anchored in the row) | Rows `tabIndex=-1`; Enter on the scroller focuses the first visible row; ↑/↓; Enter/Space inspects; if the focused row unmounts, focus goes to the scroller | `logLine` · {[streamKey], tsMs, tsMs + 1} |
| barchart (#173 Part 3a, [T22](T22-value-categorical-and-table-panels.md) §4.3) | A click on a bar (a press without a modifier released within `chart-brush-min`); a drag across bars brushes them | Enter/Space on the mirror listbox picks the focused bar; Shift+arrow brushes | `mark` · {[key], null, null} (an aggregate: its members' keys); a brush writes `select` with source `brush` · {the brushed keys, null, null} |
| Change feed ([T24-035](T24-geo-schematic-and-widget-panels.md#t24-035--selection-inspector)) | A row click | Enter/Space on the row button | `change` · {['change:' + id], atMs, (endMs ?? atMs) + 1} |
| geomap ([T24-092](T24-geo-schematic-and-widget-panels.md#t24-092--selection-and-inspector)) | The last-drawn mark under the pointer (T24-091); `other (n)` in the legend | Enter/Space on a mark-list button or the legend entry | `geo` `marker` · {[key], null, null}; `cluster` · {its keys, null, null}; `aggregate` · {the aggregate's keys, null, null} |

### 4.3 Pivots (T25-009, T25-010); t = pivot instant

| Pivot | Available when | `href` | Reason when unavailable |
|---|---|---|---|
| Explore | board, and `origin.query` ≠ null | `exploreHref(tenant, panel, ctx.search, text)` (no `f=` until I3) | "Run the panel to open it in Explore" |
| Logs ±1 min | the logs selector (T25-010) is non-empty | `/t/<tenant>/explore/logs` + `contextSearchString({...ctx.search, from: abs(t−60 000), to: abs(t+60 000), refresh: 'off'}, writeLogsParams([], {q, dir: 'backward', wrap: false}))` | "No log stream label on this series (needs service_name or job)" |
| Traces · Profiles · Entity | never in I1 | — | "Traces are not available yet" · "Profiles are not available yet" · "The entity catalogue is not available yet" |
| Label filter | from I3 | Explore with `f=<k>=<v>` added | "Filtering Explore by a label arrives with label filters" |

t is `point` tMs, `logLine` Number(tsNs / 10⁶), `stateRun` atMs, `value` tMs, `change` atMs. `bucket` uses
[tMs − 60 s, toMs + 60 s). `mark`, `flame` and a null tMs use the origin window, and `bin` and `geo` use the origin window.

**`geo` (#184, T24 part E step 1b).** A `marker` has the `mark` pivots over the origin window, from its
labels (T25-010 unchanged); a `cluster`, the `aggregate` and a `group` have no pivots (§4.9).

**`change` (#181, T24 part B2).** The Explore chip is omitted (the origin has no query). Logs ±1 min
takes its identity from `pivots.ts` `identity()`, which gains `change`: an entity of kind `service`
gives `service_name` = its last ident value; anything else (organisation-wide or another kind)
disables the chip with "This change has no service". `pivotInstant` is `atMs`, and `logsSelector`
applies T25-010 unchanged (the translated filters, conflicts and LogQL escaping).

### 4.4 Look (T25-013; tokens added by I1 in `design/tokens.toml`)

| Element | Specification |
|---|---|
| Placement | Inset 12 px from the right, top (below the header) and bottom of the content column; width `size.inspector` 360, ≤ content − 24 |
| Material | `surface-float` (dark `#12151AF0`, light `#FFFFFFF0`) + `backdrop-filter: blur(20px) saturate(140%)`; 1 px `hairline`; the kit Popover's shadow; `radius.float` 10 |
| Type and rhythm | Padding 20, with 20 between sections and hairline rules. Headings 11 px semibold, +0.06 em, upper case, `text-muted`. Title 16 semibold with an ellipsis. Value 32 `display`, tabular, with its unit at 16 muted; state colour and glyph only for a crossed threshold. Labels mono 12 |
| Chips | 28 px pill, `surface-2`, hairline, 16 px icon, 13 px label, ↗. Hover: border `accent` at 40 %. Unavailable: dashed and `text-muted`, with the reasons in 12 px below |
| Motion | Open: opacity and translateX 16→0 over 200 ms `easing-out`. Close 150 ms. New target, and each `push` or `pop` (a new `viewKey`, §4.8): 150 ms crossfade, the leaving layer inert, at most one leaving layer (the newest wins). Reduced motion: instant, no leaving layer |
| Tokens (I1) | `color.surface-float`, `color.selection`, `size.inspector` 360, `size.inspector-tab` 40, `size.inspector-inset` 12, `radius.float` 10, `motion.float-open` 200, and the `[opacity]` table (`dimmed` 0.35), emitted to CSS, TypeScript and Rust |

### 4.5 Mockup 41

[41-inspector](../mockups/41-inspector.svg): 1440×900, dark: fixture P (§10) on the board "checkout
overview", with 2 enabled and 4 disabled chips, the 3 staged actions and the origin outline. Callouts:
① material, ② disclosed pivots, ③ the Esc ladder, ④ collapse.

### 4.6 Behaviour

| State | Event | Next |
|---|---|---|
| any | inspect | open on req; selection = req.selection; seq + 1 |
| any | select(sel) | selection = sel; Inspector unchanged |
| Esc | the provider's `pre` returns a step | it runs |
| Esc | no pre, selection ≠ null | selection null |
| Esc | no pre, no selection, open | closed; focus per T25-008 |
| Esc | none of the above | the provider's `post` step, if any |
| open | push {seq, depth, view} with `seq` = the current seq and `depth` = nav.length | nav + view; selection = view.selection |
| any | any other push | no-op |
| open, nav non-empty | pop {to} (to < nav.length) | nav.slice(0, to); selection = the new top's (or `req.selection`) |
| open | originChanged(origin), close | closed; nav [] |
| any | inspect, reset | nav [] |

The host owns the state (`useReducer`) and the registries (`Map`s in refs). There is no I/O, so
nothing needs cancelling.

### 4.7 The `change` target (#181, T25-002)

`inspectorModel` for `change` ([T24](T24-geo-schematic-and-widget-panels.md) §5.10, `changeTarget`):

| Section | Content |
|---|---|
| Header | Heading: the kind glyph and word (`◆ Deploy`, `⚙ Config change`, `⚑ Feature flag`, `Note`); subheading `HH:mm:ss.SSS` of `atMs` |
| Value | Primary: the text as authored (`primaryKind: 'line'`, plain text) |
| Details | At; Ends and Duration (T24-012 floor) for a range; Entity (the T24-034 entity text, or `organisation-wide`); Tags; Id |
| Labels | `kind` and `ident` of the entity (the ident values joined ` / `); "No labels" when organisation-wide |
| Pivots | §4.3 (`change`) |
| Query | null: "No query: changes are recorded, not queried" |

`announce` is `‹word›: ‹text›, HH:mm:ss`.

### 4.8 The in-request navigation stack (#184, T25-007, T25-008, T25-011)

A member entry can open a deeper view inside the open request: the geomap's aggregate lists its
groups, a group lists its rows, and a row opens its marker. The views are a stack in the host's
state, never new requests, so there is nothing to race.

- **State.** `InspectorState.nav` holds `NavView`s `{target, selection, title}` (§5); [] at rest. The
  **top** is the last of `nav`, else `req.target`.
- **Push.** `push {seq, depth, view}` applies iff a request is open, `seq` equals the state's `seq`
  and `depth` equals `nav.length`: `nav` gains the view and the selection becomes its selection.
  Anything else is a no-op, so a stale entry (an older request, a double press in one tick) does
  nothing.
- **Pop.** `pop {to}` (`to < nav.length`) keeps `nav.slice(0, to)`, and the selection becomes the new
  top's (`req.selection` at `to` 0).
- **Reset.** `inspect`, `close`, a matching `originChanged` and `reset` empty `nav`.
- **Content.** The sheet renders `inspectorModel({...req, target: top}, env)`. With `nav` non-empty
  it shows "Back to ‹previous title›" (a `pop` to `nav.length − 1`) and a breadcrumb `<nav
  aria-label="Inspector path"><ol>` of the titles, the earlier ones as `pop` buttons.
- **`viewKey`** = `${seq}:${depth}:${topKey}`, where `topKey` is the top's id for a `geo` target and
  `'root'` for every other kind (so for them it changes iff `seq` does). It replaces `seq` as the
  per-view identity of: the content key (a remount resets the members' state); the layers (§4.4: an
  inert leaving layer for 150 ms, instant under reduced motion, at most one leaving); the `h2` focus
  (each push and pop, from any open source, T25-008); and the live region (one write per change, ≤ 1
  per 500 ms, the latest wins; the same text is cleared and rewritten on the next frame).
- **Esc** pops before it clears the selection (T25-007).

### 4.9 The `geo` target (#184, T25-002)

`inspectorModel` for `{type: 'geo'; target: GeoInspectorTarget}`
([T24](T24-geo-schematic-and-widget-panels.md) §5.16, `geoTarget`) follows T24 §4.13: the four
kinds `marker`, `cluster`, `aggregate` and `group`, their header, details, members and pivots, and
the `announce` text (with `Level ‹d + 1›: ` at depth d > 0). Its members section (T25-011) has
`texts` (entries 0–7 of n, with parallel `labels`), `runs` null, `resolve` `{panelId, runId: 'geo:'
+ target.id}` when n > 8 (else null), and `next`: a `cluster` or `group` entry i → the `marker` of
row i; an `aggregate` entry i → the `group` of entry i (`geoTarget({kind: 'group', from, entry:
i})`); each with its keys as the selection and its title. A target is a snapshot: a refresh that
removes a row leaves the open views and their entries as they were (T25-012).

## 5. Interfaces

Types in `client/src/inspector/`; every field is `readonly`.

```ts
type Labels = Readonly<Record<string, string>>;
export interface InspectOrigin { surface: 'board' | 'explore'; panelId: string | null; title: string;
  query: { lang: 'promql' | 'logql'; text: string } | null /* board run.expanded; Explore q */; window: TimeWindow; unit: Unit | null }
export type InspectorTarget =   // I1; #170 adds {type:'stateRun'; target}, #173 'mark', #177 'flame'; #154 adds {type:'bin'; target}; #181 adds 'change' (below)
  | { type: 'point'; vis: 'line' | 'bars'; key: string; labels: Labels; name: string; tMs: number; value: number }
  | { type: 'bucket'; index: number; tMs: number; toMs: number; lower: number | null; upper: number; count: number; countUnit: Unit }
  | { type: 'value'; key: string | null; labels: Labels; name: string; value: number; tMs: number | null; state: State | null }
  | { type: 'logLine'; streamKey: string; labels: Labels; tsNs: bigint; level: LogLevel; line: string; metadata: Labels | null; parsed: Labels | null }
  | { type: 'change'; id: string; kind: EventKind; text: string; atMs: number; endMs: number | null; tags: readonly string[];
      entity: Change['entity'] /* T24 §5.10; null = organisation-wide */ }
  | { type: 'geo'; target: GeoInspectorTarget /* T24 §5.16; #184 */ }
  | { type: 'mark'; target: InspectTarget /* T22 §5.1; #173 Part 3a */ };
// `mark` cases: selectionOf = {members' keys, or [mark.key] when members is null; null; null};
// pivotInstant null (the origin window); visOf 'barchart'; inspectorModel: subheading '', primary
// formatValue(value, unit) (`no data` if not finite), primaryState a crossed state; facts Raw, Baseline
// (finite only), State (if set), Series key, Reduced over `formatClockMs(from) – formatClockMs(to)`;
// labels byKey(mark.labels); members null (I3); announceNoTime; copy String(value)
// a `bin` from a bucket source: header `bucketRangeText`, members are families (T21-067)
export interface Selection { keys: string[]; fromMs: number | null; toMs: number | null }
export interface SelectionSource { kind: 'mark' | 'tableRow' | 'brush' | 'member'; panelId: string | null }
export interface InspectRequest { origin: InspectOrigin; target: InspectorTarget; selection: Selection;
  source: 'pointer' | 'keyboard'; returnFocus: HTMLElement | null }
// members.ts (State = T21 HealthState)
export interface MemberFacts { fromMs: number; toMs: number; text: string; state: State | null }
export interface MemberList { texts: string[]; members: MemberFacts[]; labels?: Labels[] /* parallel to texts; per-entry chips (T25-009) */ }
export interface MemberSection { texts: { shown: string[]; count: number; labels?: Labels[] /* parallel to shown; per-entry chips (T25-009) */ }; runs: { shown: MemberFacts[]; count: number } | null;
  resolve: { panelId: string; runId: string } | null /* null = complete */;
  next: ((i: number) => NavView | null) | null /* #184: geo targets only; null for every other kind (plain entries) */ }
export interface NavView { target: InspectorTarget; selection: Selection; title: string }   // §4.8
export function expandMembers(m: MemberSection, r: MemberList | null): { texts: string[]; runs: MemberFacts[]; labels: Labels[] | null } | 'stale';
// labels: parallel to texts; from m.texts.labels for the shown entries and from r.labels once resolved; null when the section has none (T25-011)
// host.tsx (InspectorContext null → no host: kinds neither inspect nor select)
export interface EscapeProvider { pre(): (() => void) | null; post(): (() => void) | null }   // the next step, or null
export interface InspectorHostApi { inspect(r: InspectRequest): void; select(s: Selection | null, src: SelectionSource): void;
  registerMembers(panelId: string, r: (runId: string) => MemberList | null): () => void;  // last wins; disposer removes its own
  resolveMembers(panelId: string, runId: string): MemberList | null; registerEscape(panelId: string, p: EscapeProvider): () => void }
export function useSelection(): Selection | null;
// store.ts
export interface InspectorState { req: InspectRequest | null; seq: number; selection: Selection | null; collapsed: boolean;
  nav: readonly NavView[] /* §4.8; [] at rest */ }
export type InspectorAction = { type: 'inspect'; req: InspectRequest } | { type: 'select'; sel: Selection | null }
  | { type: 'close' } | { type: 'toggleCollapsed' } | { type: 'originChanged'; panelId: string | null } | { type: 'reset' }
  | { type: 'push'; seq: number; depth: number; view: NavView } | { type: 'pop'; to: number };   // push, pop: #184 (§4.8)
// viewKey = `${seq}:${depth}:${topKey}` (§4.8): the content key, the layers, the h2 focus and the live region
// model.ts
export interface Pivot { id: 'explore' | 'logs' | 'traces' | 'profiles' | 'entity' | 'labelFilter'; label: string;
  href: string | null; reason: string | null /* set ⇔ href null */; notCarried: string[];
  context: string[] /* the Context lines under an enabled chip (T25-010); [] when disabled */ }
export interface PivotContext { search: ContextSearch; filters: BoardFilter[] }
export function inspectorModel(req: InspectRequest, env: { tenant: string; ctx: PivotContext; timeZone: string;
  capabilities: { investigations: boolean; alerting: boolean; ai: boolean } }): InspectorModel;
export interface InspectorModel { heading: string; subheading: string /* HH:mm:ss.SSS or '' */;
  primary: string; primaryKind: 'value' | 'line'; primaryState: State | null /* a crossed threshold */;
  facts: { label: string; value: string }[]; labels: [string, string][] /* by key */;
  extraLabels: { title: 'Metadata' | 'Parsed'; labels: [string, string][] }[];
  members: MemberSection | null; pivots: Pivot[]; query: { lang: 'PromQL' | 'LogQL'; text: string } | null;
  actions: { id: 'pin' | 'alert' | 'ai'; label: string; reason: string | null }[]; announce: string; copyValue: string }
// engine/api.ts
export type HoverItem = { kind: 'point'; key: string; tMs: number; value: number }
  | { kind: 'bucket'; index: number; tMs: number; toMs: number; count: number };   // T21 adds 'segment', 'bin'
export interface SelectEvent { source: 'pointer' | 'keyboard'; item: HoverItem | null }   // replaces the reserved type
// ChartFrame, LogStream: onInspect?(t, source, returnFocus); ChartFrame: onEmptyClick?() → select(null)
```

## 6. Data & storage

None. The selection and the Inspector state are in memory only, per page (T25-006, T25-012). Nothing is
persisted and there is no new API route.

## 7. Performance budget

The redraw report (`bench:inspector-redraw`) runs with a selection and the Inspector open: p95 ≤ +10 % (MINOR). It measures
`backdrop-filter` and selection redraws. The sheet never reflows the board, so nothing re-queries.

## 8. Security, tenancy & RBAC

Hrefs carry only the route's tenant; labels and filters come from that tenant's Context. State is per
page and dropped on a tenant switch. There is no new data path, and RLS is unchanged.

## 9. Failure modes & degradation

- **Esc ownership.** One ladder, in T23-011 order, whatever has focus. Dialogs, menus and editors are
  skipped (T25-007).
- **Stale or lost data.** Snapshots show absolute times. Member lists that no longer match are declared
  stale, never shown half-complete (T25-011). Filters that are not carried are named (T25-010).
- **Clipboard refused.** "Couldn't copy" for 4 s (T25-015).

## 10. Testing

Written first in I1 unless tagged.

Fixture P: a board origin {p1, "p99 latency", promql `histogram_quantile(0.99, x)`, unit s}, the point
{k1, {job shop/checkout, quantile 0.99}, 2026-11-19T13:41:20Z, 2.84}, tenant acme, UTC, search
{now-1h, now, refresh 30s}, no filters, all capabilities false.

| Test name | File | Setup | Assertion / expected value | Fails today because | Covers |
|---|---|---|---|---|---|
| unit:inspector-model | inspector/model.test.ts | P | heading "p99 latency"; subheading 13:41:20.000; primary `formatValue(2.84,'s')`; facts include "Raw 2.84"; labels [job, quantile]; explore and logs **enabled**; the other 4 null with the §4.3 reasons; the 3 staged actions show the M-UI4 reasons; announce `Inspector: p99 latency, ${formatValue(2.84,'s')} at 13:41:20` | no `inspector/` | INT-034, T25-003/004/015 |
| unit:inspector-model edge | same | value {NaN, {}} with query null; bucket {0, upper 0.1}; bucket {3, 1, +Inf}; logLine {tsNs 1763559680123456789n} | "no value", "No labels", "No query: run the panel first"; `Range ≤ ${formatValue(0.1,'s')}`; `Range > ${formatValue(1,'s')}`; "Time 1763559680123456789 ns" | same | T25-003/004 |
| unit:inspector-pivots | same | P; labels {service_name `pay"ments`}, {job checkout}, {job `shop/`}; logLine {service_name a, env x} | logs href path `/t/acme/explore/logs`, from 2026-11-19T13:40:20.000Z, to 2026-11-19T13:42:20.000Z, refresh off, q `{service_name="checkout"}`; then `{service_name="pay\"ments"}`; `checkout`; null with the job reason; `{env="x",service_name="a"}` | same | INT-035, T25-010 |
| unit:pivot-context | same | C1: P with f=env=prod, f=instance=10.0.0.1:9090, f=job=shop/web. C2: each `DEFAULT_CONTEXT` key set to a non-default value. **C3 (added by I6):** `base=-7d`. **C4 (added by #223, T24 part B2 I6):** `e=bb7487bd-100d-a998-e0f0-3c65f11da1a7` (checkout@e1, [T12](T12-entity-catalogue.md) §4.5). **C5, C6 (added by #184 step 2, T24 part E E3a):** C5 `f=env=prod` with an effective `geo`; C6 its scope not a writer, then a writer again | C1: logs q `{env="prod",service_name="checkout",service_name="web"}`, notCarried ["instance"], and the line reads "Context filter job=shop/web conflicts with this target: no logs can match". C1′ (f=job=shop/checkout instead): q `{env="prod",service_name="checkout"}`, with no conflict line; the Explore href has no `f`, and its line reads "Filters not applied in Explore yet: env, instance, job"; the logs line reads "Not carried yet: baseline". C2: every key other than from, to and refresh is carried by both hrefs. C3: both hrefs have `base=-7d`, and no line names the baseline. C4: both hrefs have `e=bb7487bd-100d-a998-e0f0-3c65f11da1a7` unchanged (the canonical `EntityId`, never a name), and no line names the entity set. C5: Explore "Filters not applied in Explore yet: env, map area"; logs "Not carried to logs: map area"; no `geo` in either href. C6: no map-area disclosure, then C5's lines back | same | IA-026, IA-027, INT-035 |
| unit:escape-ladder | inspector/host.test.tsx | (a) provider p1: pre [exitFly, clearBrush, clearSearch], post [reroot, overview]; inspect(P); focus on the Inspector heading; 8 × Esc. (b) a fake flame search `<input data-escape-ladder>` with value "foo", registered as pre clearSearch; P inspected; focus in the input; 5 × Esc. (c) an unmarked `<input>` | (a) exitFly, clearBrush, clearSearch, clearSelection, close, reroot, overview; the 8th Esc is not `defaultPrevented`; after close, focus is on `returnFocus`. (b) Esc 1: value "" and focus still in the input; then clearSelection, close, reroot, overview. (c) no step runs | no ladder | INT-016, T23-011, T25-007 |
| unit:inspector-members | inspector/members.test.ts | texts 8 of 10, runs 8 of 12, resolve {P2, P2:K:r0}; resolver (a) 10 texts and 12 members, (b) null, (c) 10 and 11 | (a) "+2 more" and "+4 more"; pressing runs → 12 rows with "Show fewer", while texts stay 8 with "+2 more"; pressing that → 10. (b), (c) → `'stale'`: both keep 8, the note shows, no buttons. A new target resets. `resolveMembers('P1','P2:K:r0')` → null | no members | T25-011, T21-005 |
| unit:engine-select | engine/canvas2d/Canvas2DEngine.select.test.ts | line series at y 40 and 120: a click at y 110, a 10 px drag, a gap; 3 stacked bars: the middle, then 6 px above the top; heatmap bucket 2 | k2; none; `null`; middle; top; bucket 2 | no `select` | T25-005 |
| unit:change-inspect (#181) | inspector/model.test.ts | [T24](T24-geo-schematic-and-widget-panels.md) §10.2 fixture C: c4; c2; c2 + f=job=shop/web; a service named `a"b\c` + LF + `d` | c4: heading `Note`, Duration `17 min`, Entity `organisation-wide`, Logs disabled ("This change has no service"); c2: Logs `{service_name="payments"}` over 12:18:02–12:20:02; with the filter `{service_name="payments",service_name="web"}` and the T25-010 conflict line; the odd name → `{service_name="a\"b\\c\nd"}` | no `change` member | T25-002, T25-010 |
| unit:inspector-nav (#184) | inspector/store.test.ts, inspector/host.test.tsx | [T24](T24-geo-schematic-and-widget-panels.md) §10.5 | as T24 §10.5: push and pop rules, the stale and closed no-ops, reset, the Esc ladder with pop, Back and the breadcrumb | no `nav` | T25-007, §4.8 |
| unit:inspector-viewkey (#184) | inspector/Inspector.test.tsx | T24 §10.5 | as T24 §10.5: one inert leaving layer, focus and announcements per `viewKey`; `point` behaves as today | no `viewKey` | T25-008, §4.4 |
| unit:clipboard-denied | inspector/Inspector.test.tsx | `writeText` rejects; Copy value; fake timers | "Couldn't copy" shown, then gone at 4 000 ms | new | T25-015 |
| e2e:inspector-open | e2e/inspector.spec.ts | stub board with line, bars, heatmap, stat and logs; Explore › Metrics and › Logs | per kind, a click opens the "Inspector" aside within 250 ms + 1 frame, with heading and value; Enter does the same and focuses the heading; the board origin is outlined; Explore has no Explore chip | new | VIZ-003, T25-001/014 |
| e2e:inspector-sections, e2e:inspector-pivot-nav | same | P's stub series, clicked at 13:41:20 | sections in order; 2 chips enabled and 4 disabled with visible reasons; 3 actions disabled. Logs opens Explore › Logs at ±1 min with q `{service_name="checkout"}`; a plain click and Shift-click navigate and Back restores the board; Ctrl-click opens a new page with the same href | new | INT-034, INT-035, INT-036 |
| e2e:inspector-escape | same | keyboard crosshair on p1, then Enter | Esc 1 on the slider clears the crosshair; Tab into the Inspector; Esc 2 clears the selection; Esc 3 closes it and focus returns to the slider; with the panel editor open, Esc closes only the editor | new | INT-016 |
| e2e:selection-sources | same | Panels A and B (line) on one query (k1, k2); press "Select k1" in A's legend table; then again | B (and A) on the next frame: k1 drawn last over the focus underlay and k2 at 0.35 alpha (screenshot `selection-b` of B matches, and differs from `selection-none`); no Inspector; pressing again → `selection-none` | no highlight | T02-025, T25-006/016 |
| e2e:selection-logs | e2e/inspector.spec.ts | Board with logs panels L1 and L2 on one query (stream s1 rows at 12:00:10 and 12:00:40; s2 at 12:00:20), a line panel B (k1) and a heatmap H. (a) Click the s1 row at 12:00:10 in L1. (b) Esc twice. (c) Click H's bucket [12:00:00, 12:00:30). (d) Click the s2 row in L2. (e) "Select k1" in B's legend | (a) Next frame, in L1 and L2: only the s1 row at 12:00:10 has `data-selected` and the focus bar; the s1 row at 12:00:40 and the s2 row are unselected and `text-muted`. B is not dimmed and shows a 1 px band at 12:00:10. (b) Every row is restored. (c) The rows at 12:00:10 and 12:00:20 are selected in both panels, and the 12:00:40 row is muted. (d) Only the s2 row is selected, in L1 too (propagation from L2). (e) Foreign key: no row is selected or muted in L1 or L2 | no log selection | T02-025, T25-006 |
| unit:log-selection | logs/LogStream.test.tsx | Rows 0 s1@1000, 1 s2@1500, 2 s1@2500. Selections: {[s1],null,null}; {[],1000,2000}; {[s1],1000,1001} (a log click); {[x],null,null} (foreign); null | selected [0,2], muted [1]; selected [0,1], muted [2]; selected [0], muted [1,2]; selected none, muted none; selected none, muted none | new | T25-006 |
| e2e:pivot-destination | e2e/inspector.spec.ts | Board URL with f=env=prod; P inspected; follow Logs, then Back and follow Explore | the Explore › Logs request (stub) has a query containing `env="prod"` and `service_name="checkout"`, and its results are the stub's env=prod stream only; the Explore › Metrics request q equals the panel's expanded text, with no `f` in the URL; the board showed "Filters not applied in Explore yet: env" under the Explore chip before the click | new | IA-026, INT-035, T25-010 |
| e2e:inspector-keyboard | same | Tab to the log scroller, Enter, ↓, Enter; then Tab through | row 2 is inspected; Tab order per T25-008; a disabled chip is described by its reason; the live region equals `announce` | new | T25-008 |
| e2e:a11y-rooms (ext.), golden:inspector, e2e:inspector-motion | a11y-rooms, golden-gallery, inspector specs | open and collapsed; dark, light, forced colours; reduced motion on and off | axe 0, targets ≥ 24 px; screenshots match, forced colours opaque; reduce = final styles on the first frame, normal = a 200 ms opacity transition | new | T25-013, VL-014/016 |
| unit:selection-draw | engine/canvas2d/Canvas2DEngine.selection.test.ts | Recording context; `setSelection({keys:['k1'], fromMs:null, toMs:null})` on line, bars and stat; `{keys:[], fromMs:1000, toMs:2000}` on heatmap | line: k2 stroked at globalAlpha 0.35, then a focus stroke 4 px wider, then k1; bars: k2 segments at 0.35 and a 2 px focus inner stroke on k1; stat: focus ring; heatmap: a `selection` fill over x(1000)–x(2000); `setSelection(null)` → the same calls as without a selection | no `setSelection` | T02-025, T25-006 |

Also: the redraw report with a selection and the Inspector open (`bench:inspector-redraw`, p95 ≤ +10 %, MINOR). Every gate is in
[T05 §7.1](T05-testing-and-performance.md#71-gate-catalogue).

## 11. Rollout

The behaviour that needs later surfaces is staged by product amendments, each with interim acceptance
and a delivering issue: INT-034 and INT-036 in [03](../product/03-interaction-model.md), IA-026 and
IA-027 in [02](../product/02-information-architecture.md). T21-009 changes: Esc and an empty click clear
the selection first, and closing is a separate step.

| Issue | Scope | Depends on | Unblocks |
|---|---|---|---|
| I1 Inspector host, selection with highlight, ladder, wiring | T25-001…016, §4.2–§4.4 and §5 for line, bars, heatmap, stat and logs on boards and Explore, including `setSelection` drawing; tokens; docs | — | #170, #173, #177 |
| I3 Label filters in Explore | Explore reads `f=`; `prom.Plan` and `logs.Plan` add equality matchers to every selector (an OpenAPI input); the Explore chip carries `f=` and its line goes; the Label filter chip | I1 | #173 |
| I4 Split-view pivots (M-UI2, Epic #7) | INT-036 in full: the default split, a shared cursor, `\` | I1 | INT-036 |
| I5 Tenant translation table (M-UI2, Epic #7) | IA-027 in full: Postgres (RLS), BFF route, admin editor; it replaces the seed | I1 | IA-027 |
| I6 Context baseline (INT-030, M-UI2, Epic #5) | `ContextSearch.baseline` (URL `base`), carried by pivots; `unit:pivot-context` C3 | I1 | INT-035 in full |

The `change` target (§4.7, §5) is delivered by [T24](T24-geo-schematic-and-widget-panels.md) §11 I6
(the Change feed), which documents it in `docs/client/inspector.md`. The navigation stack and the
`geo` target (§4.8, §4.9) are delivered by T24 §11 E2 (the geomap frame), which documents them there
too.

I1 writes `docs/client/inspector.md` (host, payload, selection, Esc providers, adding a kind, pivots,
staging, tokens, T25 map) and updates the user pages for boards, Explore › Metrics and Explore › Logs
(inspect, select, keyboard, pivots).

## 12. Alternatives considered

Rejected:
- a panel per kind (it drifts);
- a reflowing column (widths drive the query step);
- a modal (it hides the chart);
- kind-local Esc (it fails when focus is in the Inspector);
- (#184) a new host request per member step (requests race; the stack is in one request), and nested
  member lists (T25-011 stays flat).

## 13. Open questions

None blocking. The translucent material is new; switching to opaque `surface-1` changes one token.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-25 | #164: created: rules T25-001 to T25-016, the `InspectRequest` union, the shared selection and its highlight, the Esc ladder, pivots with disclosed Context, the look and motion, tests, the implementation issues I1 and I3–I6; mockup 41-inspector. Code review r1: the Profiles and Entity reasons are written in full; the redraw report is the T05 gate `bench:inspector-redraw` |
| 1.1-rc | 2026-11-25 | #154 ([T21](T21-time-and-distribution-panels.md) part 2a): §5 `InspectorTarget` gains `{type:'bin'; target}` and `HoverItem` gains `bin`; `MemberList.labels?` and `MemberSection.texts.labels?` (parallel to the texts; per-entry chips, T25-009); T25-011 adds the bin rule (one section, resolver ids `binId` and `${binId}:groups`, completeness with labels, `frameSeq` staleness); §4.3: `bin` uses the origin window. Code review r1: `expandMembers` returns the parallel `labels` for the shown and the resolved entries |
| 1.2-rc | 2026-11-25 | #206 ([T21](T21-time-and-distribution-panels.md) part 2a-ii): §5 comment: a `bin` from a bucket source has the header `bucketRangeText` and lists families as members (T21-067) |
| 1.3-rc | 2026-11-25 | #192 (I1): §4.4 lists the tokens I1 adds (`size.inspector-tab`, `size.inspector-inset`, `motion.float-open`, the `[opacity]` table); §5 gives `Pivot.context` and the `InspectorModel` fields; `MemberList` and `expandMembers` in code follow #154's labels; ADR-0025 records the seam's `setSelection` and `select` item |
| 1.4-rc | 2026-11-25 | #181 ([T24](T24-geo-schematic-and-widget-panels.md) part B2), per T25-002: §5 `InspectorTarget` gains `{type:'change'; id; kind; text; atMs; endMs; tags; entity}`; §4.2 adds the Change feed row (selection `{['change:' + id], atMs, (endMs ?? atMs) + 1}`); §4.3 t = `atMs` for `change`, no Explore chip, Logs ±1 min from a `service` entity (`identity()` + `change`) or disabled "This change has no service"; §4.7 the `change` model; §10 `unit:change-inspect`, and `unit:pivot-context` C4 uses the canonical `e=` entity set (added by #223) instead of `ent=service:checkout`; §11 delivered by T24's I6 |
| 1.5-rc | 2026-11-25 | #184 ([T24](T24-geo-schematic-and-widget-panels.md) part E step 1b, the geomap), per T25-002: §5 `InspectorTarget` gains `{type:'geo'; target}`, `MemberSection` gains `next`, `InspectorState` gains `nav` (`NavView`) and `InspectorAction` `push` and `pop`; §4.8 the in-request navigation stack and `viewKey` (content key, layers, `h2` focus, live region); §4.9 the `geo` target; T25-007 (Esc pops before it clears), T25-008, T25-011 (entries as buttons with `next`) and T25-012 amended; §4.2 the geomap row, §4.3 `geo` pivots, §4.4 the navigation motion, §4.6 push and pop; §10 `unit:inspector-nav`, `unit:inspector-viewkey`; §11 delivered by T24's E2 |
| 1.6-rc | 2026-11-25 | #184 ([T24](T24-geo-schematic-and-widget-panels.md) part E step 2): T25-010 gains the map-area disclosure (the filter "map area" while `geo=` is effective, never carried; `unit:pivot-context` C5, C6) |
| 1.7-rc | 2026-11-26 | #173 Part 3a (T22 I1), per T25-002: §5 `InspectorTarget` gains `{type:'mark'; target: InspectTarget}` with its `selectionOf`, `pivotInstant`, `visOf` and `inspectorModel` cases; T25-007: an owner marked `data-escape-ladder` (the bar chart's mirror listbox, [ADR-0029](../adr/0029-bar-chart-keys-and-brush.md)) is not skipped; §4.2 gains the barchart row (click, Enter/Space, brush → `select` source `brush`) |
