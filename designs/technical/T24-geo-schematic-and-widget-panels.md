# T24 — Geo, schematic and widget panels

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.1-rc · 2026-11-25 |
| **Milestone** | M-UI1 (sanitiser, links) → M-UI5 (widgets) |
| **Related ADRs** | [ADR-0007](../adr/0007-in-house-vis-engine.md), [ADR-0012](../adr/0012-derived-state-in-postgres.md), [ADR-0014](../adr/0014-typescript-react-web-client.md), [ADR-0015](../adr/0015-go-bff.md), [ADR-0024](../adr/0024-markdown-runtime-dependencies.md) |
| **Source draft** | plans/153, plans/181 (not tracked) |

This document is the board **widgets**, the **geomap** and the **schematic**. It is written in parts
(§2): part A, here, defines the shared widget rules, the **Text / Markdown** widget with the one
Markdown renderer every vis and widget uses, and the **Clock / time zones** widget (rules T24-001 to
T24-018). Part B1 adds the **Board list** widget, the list-widget rules that every list widget shares,
board tags and the board search of the BFF (rules T24-020 to T24-029). Parts B2–K add their rules in
their own ID blocks.

## 1. Context & problem

[VIZ-053](../product/05-visualisation-catalogue.md#viz-053--widgets-available) asks for the Table 5-9
widgets on boards. Text renders Markdown with `{{entity}}` and Context variables, and Clock is a
multi-zone NOC clock with a countdown to a maintenance window.
[VIZ-054](../product/05-visualisation-catalogue.md#viz-054--markdown-and-html-are-always-sanitised)
asks that any Markdown or HTML a vis or widget renders is sanitised, and
[VIZ-056](../product/05-visualisation-catalogue.md#viz-056--no-arbitrary-iframes) that no iframe is
embedded: an imported iframe becomes a link that opens in a new tab, and the import report notes it.
[T18-013](T18-security.md#t18-013--markdown-renders-to-nodes-never-to-html-strings) needs a CommonMark
parser that yields a tree, and
[T08-011](T08-dom-component-kit.md#t08-011--markdown-cannot-produce-html) drops every HTML node.

The approach: widgets are DOM, with no query and no 3D form. Markdown is parsed by `commonmark` into a
tree and rendered to React elements per a `board` or `ai` policy, with URLs parsed and classified and
removals recorded without content. Import only appends links. Clock uses one due-time scheduler.

**Part B1.** VIZ-053's Board list row asks for a list of boards on a board: starred, recently viewed,
found by a search or by a tag. [SRF-026](../product/04-surfaces.md#srf-026--board-library) asks the
board library for tags, search, starred and recently viewed, and to rank boards used during
incidents. The Board list is a DOM list widget, honestly 2D (T24-001), that reads only BFF config
routes. Its list rules (T24-020, T24-024 to T24-027) are shared with the list widgets of later parts.
The BFF gains one migration: a `boards.tags` cache with a `tags_version` stamp, repaired on read.
`/boards` gains `q` and `tag`, and the list answers gain `applied` and `truncated`.

## 2. Goals / non-goals

Goals (part A): the T24 skeleton and its part map; the shared widget rules; the Text / Markdown widget
and its renderer, URL rule and removal log; the import conversion of iframes into links; the Clock
widget with zones, 12/24 h, a countdown and day and night cues without colour; board spec v4.

Non-goals (part A):
- parts B–K;
- opt-in basic HTML (T18-013);
- the image proxy (T18-014, A3 in §11);
- GFM tables and syntax highlighting;
- Text `renderMode: perRow` rendering;
- any 3D form.

Goals (part B1): the shared list-widget rules (snapshot, meter, keyboard, table, CSV, facts, states
and look); the Board list widget with its starred, recent, search and tag modes; board tags in the
board spec and their cache in Postgres; the `/boards` search and tag filter, `applied` and
`truncated`; the Dashboard list import; board spec v5.

Non-goals (part B1):
- part B2 (the Change feed widget, the `change` target and the log panel gaps);
- the "used during incidents" ranking (I3 in §11; SRF-026 is staged);
- star toggles on list rows;
- the board library page;
- the headless renderer.

**Part map.** Each part is designed under its own issue and adds its rules in its block.

| Part | Scope | Issue | Rules | Requirement ID if needed |
|---|---|---|---|---|
| A | Text / Markdown and Clock widgets, sanitiser and link rule (this revision) | #153 | T24-001–019 | VIZ-125 (reserved, unused) |
| B1 | Board list widget, shared list-widget rules, board tags and the `/boards` search (this revision) | #181 (step 1) | T24-020–029 | — |
| B2 | Change feed widget, the `change` target and log panel gaps | #181 (step 2) | T24-030–039 | VIZ-126 |
| C | Alert / incident list widget | #182 | T24-040–059 | VIZ-127 |
| D | Feed widget fetched by the BFF | #183 | T24-060–079 | VIZ-128 |
| E | Geomap 2D core: location sources, markers, offline basemap, camera and bounds filter | #184 | T24-080–099 | VIZ-129 |
| F | Geomap basemap pipeline and routes layer | #185 | T24-100–119 | VIZ-130 |
| G | Geomap M-UI5 layers: heatmap / hexbin, choropleth, network, day/night, track | #186 | T24-120–139 | VIZ-131 |
| H | Geomap true 3D: globe and extruded regions | #187 | T24-140–159 | VIZ-132–133 |
| I | Schematic model, viewer, data binding and audited actions | #188 | T24-160–179 | VIZ-134 |
| J | Schematic editor | #189 | T24-180–199 | — |
| K | Schematic import and auto-schematic | #190 | T24-200–219 | — |

Part A defines T24-001 to T24-018; T24-019 and VIZ-125 stay unused. Part B1 defines T24-020 to
T24-029.

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [VIZ-031](../product/05-visualisation-catalogue.md#viz-031--3d-only-when-it-encodes-a-dimension), [VIZ-086](../product/05-visualisation-catalogue.md#viz-086--true-3d-only) | §4.1 (T24-001, T24-003) | `unit:board-spec-widgets`; `golden:widget-gallery` |
| [VIZ-053](../product/05-visualisation-catalogue.md#viz-053--widgets-available) (Text and Clock rows) | §4.1 (T24-002, T24-008 to T24-012), §5.1 | `e2e:widget-text`; `e2e:widget-clock` |
| [VIZ-054](../product/05-visualisation-catalogue.md#viz-054--markdown-and-html-are-always-sanitised) | §4.1 (T24-004, T24-006, T24-007), §4.2 | `unit:markdown-nodes`; `fuzz:markdown-nodes`; `e2e:widget-text-xss` |
| [VIZ-056](../product/05-visualisation-catalogue.md#viz-056--no-arbitrary-iframes) | §4.1 (T24-005, T24-006, T24-016), §5.4 | `unit:markdown-iframe`; `unit:find-iframes`; `unit:import-text-iframe`; `fuzz:markdown-nodes`; `e2e:widget-text-xss` |
| [VIZ-057](../product/05-visualisation-catalogue.md#viz-057--field-configuration-parity) | §4.1 (T24-003), §5.1 | `unit:board-spec-widgets` |
| [VIZ-060](../product/05-visualisation-catalogue.md#viz-060--standard-panel-types-import-11) (Text and Clock rows) | §4.4 (T24-016), §5.4 | `unit:import-text-iframe`; `unit:import-size-error` |
| [VIZ-065](../product/05-visualisation-catalogue.md#viz-065--auto-vis-rules) | §4.1 (T24-002: never auto-picked) | `e2e:widget-text` (no query) |
| [VIZ-066](../product/05-visualisation-catalogue.md#viz-066--table-view-and-csv-for-every-vis), [VIZ-068](../product/05-visualisation-catalogue.md#viz-068--screen-reader-summary-per-viewport) | §4.1 (T24-002, T24-009, T24-017) | `e2e:widget-a11y` |
| [VIZ-067](../product/05-visualisation-catalogue.md#viz-067--colour-is-never-the-only-channel), [VIZ-069](../product/05-visualisation-catalogue.md#viz-069--gallery-is-the-vis-test-corpus) | §4.1 (T24-013, T24-015), §10 | `golden:widget-gallery` |
| [VL-012](../product/08-visual-language.md#vl-012--numbers-for-humans) | §4.1 (T24-012) | `unit:clock-countdown`; `unit:countdown-due` |
| [VL-014](../product/08-visual-language.md#vl-014--purposeful-motion-only), [VL-016](../product/08-visual-language.md#vl-016--reduced-motion) | §4.1 (T24-015) | `e2e:widget-clock` |
| [T08-009](T08-dom-component-kit.md#t08-009--no-iframes), [T08-011](T08-dom-component-kit.md#t08-011--markdown-cannot-produce-html) (refined) | §4.1 (T24-004, T24-006) | `unit:markdown-nodes`; `unit:markdown-iframe` |
| [T18-011](T18-security.md#t18-011--url-scheme-allowlist) (refined) | §4.1 (T24-005, T24-008) | `unit:classify-url`; `unit:markdown-links`; `unit:markdown-interpolate` |
| [T18-013](T18-security.md#t18-013--markdown-renders-to-nodes-never-to-html-strings) (refined) | §4.1 (T24-004), §5.2 | `unit:markdown-nodes`; `fuzz:markdown-nodes` |
| [T18-014](T18-security.md#t18-014--external-images-only-through-a-signed-proxy) (amended: interim) | §4.1 (T24-018) | `unit:markdown-images` |
| [VIZ-053](../product/05-visualisation-catalogue.md#viz-053--widgets-available) (Board list row; part B1) | §4.1 (T24-020 to T24-023), §5.5 | `unit:board-list-source`; `unit:board-list-rows`; `e2e:widget-board-list` |
| [VIZ-027](../product/05-visualisation-catalogue.md#viz-027--coverage-meter-on-every-viewport) (part B1) | §4.1 (T24-024, T24-029), §4.5 | `unit:list-coverage`; `unit:board-list-states`; `unit:board-list-key`; `unit:board-list-mixed`; `itest:board-list-snapshot` |
| [VIZ-031](../product/05-visualisation-catalogue.md#viz-031--3d-only-when-it-encodes-a-dimension), [VIZ-086](../product/05-visualisation-catalogue.md#viz-086--true-3d-only) (part B1) | §4.1 (T24-020), §5.5 | `unit:board-spec-board-list` |
| [VIZ-060](../product/05-visualisation-catalogue.md#viz-060--standard-panel-types-import-11) (Dashboard list row) | §4.1 (T24-028), §4.6 | `unit:import-board-list` |
| [VIZ-065](../product/05-visualisation-catalogue.md#viz-065--auto-vis-rules) (part B1) | §4.1 (T24-002, T24-020: no query, never auto-picked) | `unit:board-spec-board-list` |
| [VIZ-066](../product/05-visualisation-catalogue.md#viz-066--table-view-and-csv-for-every-vis), [VIZ-068](../product/05-visualisation-catalogue.md#viz-068--screen-reader-summary-per-viewport) (part B1) | §4.1 (T24-025, T24-026) | `unit:list-table-csv`; `unit:list-keyboard`; `e2e:widget-lists-a11y` |
| [VIZ-067](../product/05-visualisation-catalogue.md#viz-067--colour-is-never-the-only-channel), [VIZ-069](../product/05-visualisation-catalogue.md#viz-069--gallery-is-the-vis-test-corpus) (part B1) | §4.1 (T24-027), §10 | `golden:widget-gallery` |
| [VL-016](../product/08-visual-language.md#vl-016--reduced-motion) (part B1) | §4.1 (T24-027) | `e2e:widget-lists-a11y` |
| [SRF-026](../product/04-surfaces.md#srf-026--board-library) (staged: starred, recent, search and tags; the ranking is I3, §11) | §4.1 (T24-021, T24-023, T24-029), §5.6, §6 | `itest:board-find`; `itest:board-tags`; `unit:board-list-rows` |

## 4. Design

### 4.1 Design rules

#### T24-001 — True 3D or honest 2D
**MUST** — (VIZ-086.) 3D is a real engine scene (depth, orbit/pan/dolly, occlusion,
[VL-023](../product/08-visual-language.md#vl-023--one-key-light-and-ambient) light), and its third axis
is a real dimension (VIZ-031). 2D never fakes depth (bevels, extrusions, shadows, isometric, tilts,
shading). Text and Clock are 2D.

#### T24-002 — Widgets are furniture
**MUST** — A **content** widget (Text, Clock) has no query, `ChartFrame`, selection, `InspectorTarget`,
`SummaryFacts`, table or CSV; its DOM text is the content. A **list** widget follows T24-020. No widget
is auto-picked.

#### T24-003 — Widget spec
**MUST** — Widgets omit `query` (`board.panel.query.forbidden`), and data panels need it
(`board.panel.query.required`). Keys not in §5.1 (e.g. `depth`) → `board.json.unknownKey`.

#### T24-004 — One Markdown renderer
**MUST** — `renderMarkdown` (§5.2) walks the `commonmark` tree into §4.2 elements only, with no HTML
string sink. Table cells, feeds, tooltips and AI output reuse it.

#### T24-005 — URL classification
**MUST** — Link, image and import-iframe URLs pass `classifyUrl` after interpolation:
- a match of `URL_FORBIDDEN` → rejected;
- `/`-leading → `new URL(raw, appOrigin)`, `local` iff it is same-origin and its pathname is not `//…`;
- absolute → `http(s):` without credentials (`external`) or `mailto:` (links only);
- anything else is rejected.

A kept link renders as `<a target="_blank" rel="noopener noreferrer nofollow">` with a glyph and a
hidden "(opens in a new tab)". A rejected one renders as text and records `linkScheme`.

#### T24-006 — Iframes never render
**MUST** — Every HTML node is dropped (T08-011), with one removal per `html_block` and one per leaf
block's inline HTML (joined as in §5.4): `iframe` if `findIframes` finds one ("Embedded page not shown
(line n): add a link"), else `html`. Import (§5.4) turns iframes into links (VIZ-056).

#### T24-007 — Removal log carries no content
**MUST** — A `Removal` is `{kind, line}`, never text, URLs or values. The editor lists one i18n line per
removal; `logRemovals` does one `console.debug({panelId, removals})` per distinct result.

#### T24-008 — Interpolation on the tree
**MUST** — `$name`/`${name}` (`VARIABLE_REF`) and `{{entity}}` are replaced after parsing, in `text`
nodes and destinations only (destinations: `encodeURIComponent`, then T24-005). Code and `__` macros
stay literal. Unresolved references stay literal and log `unresolved`. `{{entity}}` is
`useContextEntity()` (`null` for now).

#### T24-009 — Structure
**MUST** — Heading n → `<h{min(n+3,6)}>`. The body is `role="region"` labelled by the title, with
`tabIndex=0` if it overflows.

#### T24-010 — Zones
**MUST** — A zone row shows the time, the label (else the IANA city), the date (if `date`), the UTC
offset and the day difference (§4.3). `tz: ''` is the Context zone. A zone the browser rejects shows
"Unknown time zone ‹tz›" in its row.

#### T24-011 — One scheduler
**MUST** — One `wallClock` (§5.3) sets one timeout at the earliest `due`, notifies those due, and
re-arms. While the page is hidden there is no timer; when it becomes visible it notifies all and
re-arms. It runs on wall time.

#### T24-012 — Countdown
**MUST** — `r = to − now`. The text floors `r`: `in ‹d› d ‹h› h` / `‹h› h ‹m› min` / `‹m› min` /
`‹s› s` for r ≥ 1 d / h / min / s, else `now`. For r ≤ 0: `countUp` shows `since HH:MM (‹elapsed›)`
(VL-012), or `hide` hides the row.

`countdownDue` is the first ms at which the text changes: `now + (r mod u) + 1`, with u = 1 h / 1 min /
1 s for r ≥ 1 d / 1 min / 1 s; `now + r` below 1 s; after `to`, with e = −r, `now + u − (e mod u)`,
with u = 1 s / 1 min.

A polite announcement is made when the text first reads 15, 5 or 1 min, or `since … (0 s)`, not on
first render, and once on resume after a crossing while hidden.

#### T24-013 — Day/night without colour
**MUST** — An hour in [06, 18) shows `sun` and "day", else `moon` and "night", with a neutral tint
only.

#### T24-014 — Widget states
**MUST** — An empty Text shows "This text panel is empty" (view) or "Write Markdown" (edit). Invalid
options never render.

#### T24-015 — Look
**MUST** — Inter 14/22 (Compact 13/20), code in JetBrains Mono; clock tabular figures at 32/24/18 px
(1 / 2–4 / more zones); a 4 px grid, 16 px padding and hairline rows. The only motion is a 150 ms
crossfade, cut under reduced motion.

#### T24-016 — Import
**MUST** — Import follows §4.4. `convertImportedText` (§5.4) only inserts: removing `inserted` gives
the input. Report entries carry at most a host.

#### T24-017 — Keyboard and SR
**MUST** — Tab reaches the region (if it overflows), then the links. A zone row is `role="group"`
labelled "‹label›, ‹time›, ‹date›, ‹day/night›, ‹offset›". The clock text is not live.

#### T24-018 — Render policy
**MUST** — `board`: a `local` image → `<img>`; an `external` one → a link (alt text or host; T18-014
interim); anything else → alt text. An image not rendered as `<img>` logs `image`. `ai`
([T18](T18-security.md) §4.10): no `<img>` or other auto-loading element; images → alt text and
`image`; links show their host.

#### T24-020 — List widgets
**MUST** — A list widget (`boardList`; part B2 adds `changeFeed`) has no `query` (T24-003), is never
auto-picked (VIZ-065), is DOM with no 3D form, reads only BFF config routes and writes nothing. It has
a snapshot (T24-024), a coverage meter, a table, CSV and facts (T24-026), and keys (T24-025). Board rows
have no selection and no Inspector: a board is neither a series key nor an interval
([T25-006](T25-inspector-and-pivots.md#t25-006--shared-selection)).

#### T24-021 — Board list sources
**MUST** — Each mode reads one route under one react-query key:
- `starred`: `listStarred`, key `['starred', tenant]` (the sidebar's key), in title order;
- `recent`: `listRecent(tenant, signal, 50)`, key `['recent', tenant, 50]`;
- `search`: `listBoards(tenant, signal, {q})` (`''` → no `q`), and `tag`: `listBoards(tenant, signal,
  {tag})`; key `['boards', tenant, 'find', q, tag]`, in `updated` descending order.

`q` is the trimmed search field, committed 250 ms after the last key. There is no `placeholderData`;
the focus refetch is `'always'`. The field holds at most 100 characters and starts at the `query`
option. A Cc character shows the inline "Search text cannot contain control characters" and commits
nothing. The field is marked `data-escape-ladder` and registers the
[T25-007](T25-inspector-and-pivots.md#t25-007--one-esc-ladder) pre step "clear the field". Case
folding is ASCII-only.

#### T24-022 — Board rows
**MUST** — A row is one `<a>` to `/t/<tenant>/board/<uid>` + `contextSearchString(time)`, with
`BOARD_LINK_STATE`, as in `SidebarBoards`. Loaded rows with equal titles show `‹title› · ‹uid›` (the
uid in mono, muted). The board that holds the widget has `aria-current="page"` and "this board". Search
and tag rows show at most 3 tag chips and `+k`, or a muted "tags unknown" when `tags` is null, and
`updated d MMM HH:mm`.

#### T24-023 — Board limit, ranking
**MUST** — The list shows `limit` rows. "Show more" adds `limit` rows (up to the loaded rows) and moves
focus to the first new row. A refresh keeps the shown count, clamped to the loaded rows.
`sort: 'incidents'` while `CAPABILITIES.investigations` is false gives the default order and the
caption "Ranking by use during incidents is available with investigations (M-UI4)".

#### T24-024 — List snapshot and meter
**MUST** — A `ListSnapshot` is keyed by (tenant, source, effective filter), which is the query key.
Consumers read only the current key's snapshot (§4.5). A key change hides the old snapshot at once:
the widget is pending, then ok, or an error with no rows. Within a key, a refetch replaces the snapshot
atomically, and a failed refetch keeps it with `staleAtMs`.

The meter is [T22-006](T22-value-categorical-and-table-panels.md#t22-006--caps-keep-the-signal)
`coverageText` over `Coverage`: `total` = the loaded rows, `drawn` = the shown rows,
`query.truncated` from the answer, `query.warnings` `[]`, and nothing kept, so the cap text is
`showing X of N`. The T22-006 list members add a leading part, `coverage unknown` (`unknown` with
reason `oldServer`) or `tags not yet known for k board(s)` (reason `tagsStale`), and a trailing
`stale (HH:mm:ss)` (`staleAtMs`). Each suppresses `100 %`. The order is unknown, truncated, cap, stale. With no snapshot the meter reads
`loading` or `unavailable`. The meter's Narrow focuses the search field (search mode only).

#### T24-025 — List keyboard, SR, focus repair
**MUST** — Tab order: the search field → the list → "Show more" → the meter. The list is a `<ul>` with
one roving tab stop: ↑/↓, Home/End, PageUp/PageDown (±10 rows); Enter follows the link.
- The active row is kept by key. If its row is gone, the row at its old index (clamped) becomes
  active, and focus follows only if it was in the list.
- An empty list moves the active element to the empty text `<p tabIndex=-1>`; an error to Retry.
- A new search makes the first row active, and focus stays in the field.
- Accessible names are `‹display›[, this board]`. `aria-setsize` is the loaded count, or −1 when the
  answer is truncated or its coverage is unknown.
- Polite announcements ([T08-018](T08-dom-component-kit.md#t08-018--announcements-are-rate-limited)):
  `‹n› boards` or the empty text, once per settled search; on a refresh only "‹display› is no longer
  listed".

#### T24-026 — Table, CSV, facts
**MUST** — Shift+T shows the snapshot's rows in the kit table (#173,
[T22-013](T22-value-categorical-and-table-panels.md#t22-013--table-view-and-csv)). The CSV is RFC 4180
with the header `title,uid,tags,updated_at`: tags `;`-joined, `unknown` when `tags` is null, empty when
there are none; `updated_at` in ISO 8601 UTC. A cell that starts with `=`, `+`, `-`, `@`, TAB or CR
gets a leading `'` first (`csvCell`). Facts: `current` = `{text: '‹N›[+] boards'` plus
` (coverage unknown)` or ` (stale)`, `series: ‹mode label›}`, and the other members are null; with no
snapshot the facts are null.

#### T24-027 — List states, look
**MUST** — States and texts follow §4.5. "Loading…" shows after 300 ms (`useDelayedFlag`). Rows are
36 px, with the T24-015 type and grid, hairlines, hover `surface-2`, a 2 px `focus` ring and 20 px
chips, and no state colour. Only rows new on a refresh fade in (150 ms), cut under reduced motion.

#### T24-028 — Board list import
**MUST** — Import follows §4.6 exactly, with one report note per absent-but-meaningful, malformed,
dropped, cut or clamped option.

#### T24-029 — Board tags and compatibility
**MUST** — `BoardSpec.tags` holds 0–16 unique `AnnotationTag`s (`board.tags.invalid`,
`board.tags.duplicate`). `boards.tags` caches the head spec's tags and is fresh iff
`tags_version = head_version`; every head move by this binary sets both. A list first repairs at most
200 stale rows in its own committed transaction (a failure leaves them stale), then reads the rows,
the truncation and `tagsStale` in one statement (§6). A stale row is returned with `tags: null`
("tags unknown") and never matches by tag. `tagsStale` counts every live stale row of the org, and
`tagsStale > 0` sets `unknown`.

**Old server** (no `applied` in the answer): `unknown`; `truncated` is not trusted; search filters the
titles client-side; tag mode shows "Filtering by tag needs a newer server", with no rows and no chips.
Old binaries cannot move a v5 head (`ErrSchemaTooNew`). A 400 `board.json.unknownKey` at `/tags` on a
save shows "This server does not accept board tags yet".

### 4.2 Markdown node table (`commonmark` → output)

| Node | Output |
|---|---|
| paragraph | `<p>` |
| heading n | `<h{min(n+3,6)}>` |
| block_quote | `<blockquote>` |
| list | `<ul>` / `<ol start ≤ 999 999>` |
| item | `<li>` |
| thematic_break | `<hr>` |
| code_block | `<pre><code data-lang>` (info word `[a-z0-9-]{1,20}`) |
| text | text (interpolated, T24-008) |
| softbreak | `' '` |
| linebreak | `<br>` |
| emph, strong, code | `<em>`, `<strong>`, `<code>` |
| link | T24-005 |
| image | T24-018 |
| html_block, html_inline | T24-006 |
| anything else | dropped (`html`) |

No source attribute is copied. The output is pure and memoised.

### 4.3 Clock formats (`Intl.DateTimeFormat`)

The date is `weekday:'short', day:'numeric', month:'short'`; the offset is `longOffset`, with `GMT`
shown as `UTC`. The day difference is the zone date − the Context-zone date. `since` uses the first
zone.

### 4.4 Import mapping (#158, #17)

- **Text:** `mode` (`html` → `markdown`); `code.language`, or `plaintext` (noted);
  `convertImportedText(content, mode)`, with a report line per note; `ok: false` → §5.4 step 5.
- **Clock:** `timezone` → `zones[0].tz` (`''` if absent or "browser"; unknown → noted); `clockType`
  `12 hour` / `24 hour` / `custom` → `h12` / `h23` / `auto` (custom noted); countdown/countup with
  `countdownSettings.endCountdownTime` and `endText` → `countdown {to, label, after:'countUp'}`.
- Other keys are dropped ("Option ‹key› not mapped"); lines matching `^\s*\|.*\|\s*$` are noted
  "Markdown table shown as text".

### 4.5 List widget states (T24-024, T24-027)

| State | Rows | Meter | Table / CSV | Facts |
|---|---|---|---|---|
| key change (debounced filter, mode, tenant) | the old key's rows hidden at once | — | — | — |
| pending, no snapshot for this key | "Loading…" after 300 ms | `loading` | "Loading…" / disabled | null |
| empty | the empty text (below) | `100 %` or `coverage unknown` | none / header only | `0 boards` |
| ok | the snapshot | `coverageText` | the snapshot | the snapshot |
| error, no snapshot for this key | "Couldn't load boards" + Retry (503: "The configuration store is unavailable") | `unavailable` | the error / disabled | null |
| same-key refetch failed | rows kept, "Couldn't refresh: showing boards from HH:mm:ss" + Retry | `… · stale (HH:mm:ss)` | the snapshot | `… (stale)` |
| refetch ok | the new snapshot (T24-023, T24-025) | recomputed | new | new |

Empty texts: "No starred boards. Star a board with ☆ in its header" · "No recently viewed boards" ·
"No boards match ‘‹q›’" · "No boards tagged ‹tag›".

**Cancellation:** on a key change the widget unsubscribes. React-query aborts the request only when no
observer remains, and the old answer never renders in this widget. The debounce timer is cleared on
unmount.

### 4.6 Board list import (VIZ-060; Dashboard list → `boardList`; #158, #17)

- Defaults: `showStarred` true, `showRecentlyViewed` and `showSearch` false, `maxItems` 10, `query`
  `''`, `tags` `[]`. A wrong type → the default and "Option ‹key› malformed: default used". `sort` is
  `default`.
- The mode is the first enabled of starred, recent and search. None → starred and "No list enabled:
  starred used"; more than one → "Only the first list (‹mode›) kept: add another Board list for
  ‹modes›". The mode note comes first in the report.
- Search: tags are lower-cased; an invalid one → "Tag ‘‹t›’ dropped: not a valid tag". The first valid
  tag → tag mode; the other valid tags → "Tags not kept: ‹list› (a board list filters by one tag)";
  search text → "Search text dropped in tag mode". With no valid tag, Cc characters are removed
  ("Control characters removed from search text"), then the text is cut to 100 code points ("Search
  text cut to 100 characters").
- Other modes with search text or tags → "Search text and tags dropped: they apply to search only".
- `maxItems` is clamped to 1–50 ("Item limit ‹m› clamped to ‹l›"); `keepTime: false` → "Links keep the
  time range"; other keys, sorted → "Option ‹key› not mapped".

## 5. Interfaces

### 5.1 Board spec v4 (OpenAPI, Go, TS)

`query` becomes optional; `Vis.kind` adds `text` and `clock`; `Vis.options` (#173) gains the keys
below (errors are `board.options.‹…›`):

| Key | Type / bounds | Default | Kinds | Error |
|---|---|---|---|---|
| mode | `markdown`\|`code` | `markdown` | text | `mode.invalid` |
| content | string ≤ 65 536 UTF-8 bytes | `''` | text | `content.tooLong` |
| language | `plaintext`\|`json`\|`yaml`\|`sql`\|`promql`\|`logql`\|`go`\|`shell` | `plaintext` | text, code mode only | `language.invalid` |
| zones | 1–12 × `{tz, label ≤ 64}`; `tz` `''` or loadable by Go `time.LoadLocation` (embedded tzdata), not `Local` | `[{tz:'',label:''}]` | clock | `zones.invalid`, `zones.duplicate` |
| hourCycle | `auto`\|`h12`\|`h23` | `auto` | clock | `hourCycle.invalid` |
| seconds, date | bool | `false`, `true` | clock | — |
| countdown | absent or `{to: RFC 3339 with offset, label 1–64, after: 'countUp'\|'hide'}` | absent | clock | `countdown.invalid` |

Go decides validity; the v3 → v4 upcaster is the identity
([T11-016](T11-postgres-schema.md#t11-016--document-upcasters-are-golden-tested)); the fixtures are
`v4-widgets.json` and `invalid.json`.

`isWidgetPanel(p)` narrows `PanelSpec` and guards every `panel.query` read; `textOptions` and
`clockOptions` fill the defaults; `PanelFrame` branches first to `<WidgetBody>`.

### 5.2 Renderer (`client/src/security/sanitise/`)

```ts
// url.ts
export type UrlClass = { kind: 'local'; href: string; host: string } | { kind: 'external'; href: string; host: string }
  | { kind: 'mailto'; href: string } | { kind: 'rejected' };
export const URL_FORBIDDEN = /[\u0000- \u007F-\u009F\\]/;
export function classifyUrl(raw: string, appOrigin: string): UrlClass;
// markdown.tsx
export type RenderPolicy = 'board' | 'ai';
export type RemovalKind = 'html' | 'iframe' | 'linkScheme' | 'image' | 'unresolved';
export interface Removal { readonly kind: RemovalKind; readonly line: number } // block start line
export function renderMarkdown(src: string, env: { vars: ReadonlyMap<string, string>; entity: string | null },
  opts: { policy: RenderPolicy; appOrigin: string; headingOffset?: number /* 3 */ }): { node: ReactNode; removals: readonly Removal[] };
export function renderCode(src: string, language: CodeLanguage): ReactNode;
export function findIframes(html: string): readonly { line: number; src: string | null }[];
export function logRemovals(panelId: string, removals: readonly Removal[]): void;
```

Both options are required.

**`findIframes`** returns the **union**, de-duplicated by start offset and sorted, of (a) the `iframe`
elements in the `parse5.parse` tree (template content included) and (b) the `iframe` start-tag tokens
from `parse5-sax-parser`; both with `sourceCodeLocationInfo`, spec attribute decoding and the first
duplicate `src` (or `null`).

**Rule:** a destination is recovered if either the spec tree or the spec tokenizer sees an iframe start
tag. Each covers the other's gap (tree: `<select><iframe>`; SAX: `<select><title><select><iframe>`);
both keep the raw-text, RCDATA, comment and CDATA protection; over-counting only adds a link.

Dependencies ([ADR-0024](../adr/0024-markdown-runtime-dependencies.md)): `dependency-policy.json`
`runtimeAllowlist` += `commonmark`, `parse5`, `parse5-sax-parser`; `runtimeClosure.markdown` = those
plus `entities`, `mdurl`, `minimist`; pins `commonmark` 0.31.2, `parse5` 8.1.1 (moves from
devDependencies), `parse5-sax-parser` 8.0.1; `@types/commonmark` as a dev dependency.

### 5.3 Wall clock (`client/src/state/wallClock.ts`)

```ts
export interface WallClock { now(): number; subscribe(cb: () => void, due: (now: number) => number): () => void }
export function createWallClock(nowFn?: () => number, timers?: Timers, doc?: Pick<Document, 'hidden' | 'addEventListener'>): WallClock;
export const boundaryDue = (unitMs: number) => (now: number) => now - (now % unitMs) + unitMs;
export function countdownDue(toMs: number): (now: number) => number;
export function useWallClock(due: (now: number) => number): number;
```

### 5.4 Import conversion (`sanitise/importText.ts`, called by #158 and #17)

```ts
export type ImportNote = { kind: 'iframeToLink'; line: number; host: string } | { kind: 'iframeNoLink'; line: number }
  | { kind: 'htmlNotRendered'; count: number };
export function convertImportedText(content: string, mode: 'markdown' | 'code', appOrigin: string):
  | { ok: true; content: string; notes: readonly ImportNote[]; inserted: readonly { offset: number; text: string }[] }
  | { ok: false; reason: 'sizeLimit'; links: number };
export interface TextImportError { kind: 'textTooLargeForLinks'; panelIndex: number; sourceId?: number; links: number }
export function markdownLink(label: string, href: string): string; // [esc(label)](<href: & → &amp;, < > \ escaped>)
```

The conversion is **append-only** (VIZ-056 needs a link and a report). `mode: 'code'` → unchanged, with
no notes. Otherwise one parse:

1. `findIframes` runs on each `html_block` literal (line = block start + `line` − 1) and once per leaf
   block on its `html_inline` literals joined in order, so `<script>` + `'<iframe …>'` + `</script>`
   stays raw text (line = leaf start).
2. Each iframe with a `local` or `external` `src` gives `markdownLink('Open embedded page (‹host›)',
   href)` and `iframeToLink {line, host}`; otherwise `iframeNoLink {line}`. The notes are sorted by
   line, then `htmlNotRendered {count}`.
3. A top-level block's links (space-joined) are inserted at E, just after its last line's newline:
   `"\n" + links + "\n"`, plus `"\n"` before a non-blank next line, with a leading `"\n"` at EOF
   without a newline. The iframe HTML stays (it is dropped at render).
4. `markdownLink` escapes label punctuation; `<dest>` has `&` → `&amp;` and `<`, `>`, `\` escaped.
5. **Size:** if the result exceeds 65 536 UTF-8 bytes it returns `{ok: false, reason: 'sizeLimit',
   links: n}`. The importer omits that panel, imports the rest, and adds a `TextImportError`
   (`sourceId` if an integer): "Text panel #‹index› (id ‹id›) is too large to add embedded-page links
   (‹n› links). Shorten or split it in the source and import again." No content is copied; the source
   file is the copy.

### 5.5 Board spec v5 (part B1; OpenAPI, Go, TS)

Spec v5 is the next version after part A's v4 (#198), or the next free version, with an identity
upcaster (T11-016). `BoardSpec` gains `tags` (T24-029), and `Vis.kind` adds `boardList` with the
options below. Go decides validity; TS = Go on the fixtures `v5-board-list.json` and `invalid.json`.
Other keys → `board.json.unknownKey`. Errors are `board.options.‹…›`.

| Key | Type / bounds | Default | Error |
|---|---|---|---|
| mode | `starred`\|`recent`\|`search`\|`tag` | `starred` | `mode.invalid` |
| query | string ≤ 100, no Cc (as `q`, §5.6), only with `search` | `''` | `query.invalid` |
| tag | `AnnotationTag`, required iff mode `tag` | absent | `tag.invalid` |
| limit | integer 1–50 | 10 | `limit.invalid` |
| sort | `default`\|`incidents` | `default` | `sort.invalid` |

`boardListOptions` fills the defaults. `isWidgetPanel` includes `boardList`, and `<WidgetBody>` (#198)
adds it.

### 5.6 BFF contract (part B1; spec first, [ADR-0015](../adr/0015-go-bff.md))

```yaml
/boards get: q { 1–100 chars, no Cc (U+0000–001F, U+007F–009F) } → 400 boards.q.invalid; tag { AnnotationTag } → 400 boards.tag.invalid
BoardList: + applied { q?, tag? } (required; what was applied), + tagsStale (required int ≥ 0)
BoardSummary: + tags (required, [AnnotationTag] ≤ 16, or null = stale)
BoardRefList: + applied {} (required), + truncated (required; starred reads 201, recent limit + 1)
BoardSpec: + tags (optional, ≤ 16, uniqueItems, AnnotationTag)
```

```go
type BoardFilter struct{ Q, Tag string } // core; "" = absent
// OrgTx (RLS): RepairBoardTags(ctx) (int64, error);
//   ListBoards(ctx, f) ([]BoardSummary, truncated bool, tagsStale int64, error);
//   ListStarred(ctx, user) and ListRecent(ctx, user, limit) ([]BoardRef, bool, error);
//   MoveBoardHead and InsertBoard take tags.
// Service.ListBoards: tx 1 repairs (an error or timeout is logged without content and never fails the
// list), then tx 2 lists; both on the read-write pool (T11 replicas serve only audit and import dry
// runs) and the request context (a cancel rolls back).
```

### 5.7 Client list modules (part B1; `api/Api.ts`, `widgets/lists/`, `widgets/boardList/`)

```ts
listBoards(tenant: string, signal?: AbortSignal, f?: { q?: string; tag?: string }): Promise<BoardPage>;
listStarred(tenant: string, signal?: AbortSignal): Promise<RefPage>;   // SidebarBoards reads .items
listRecent(tenant: string, signal?: AbortSignal, limit?: number): Promise<RefPage>;
export interface BoardPage { items: (BoardSummary & { tags: string[] | null })[]; truncated: boolean;
  applied: { q?: string; tag?: string } | null; tagsStale: number }
export interface RefPage { items: BoardRef[]; truncated: boolean; applied: {} | null }   // applied null = old server
// widgets/lists/snapshot.ts (shared with part B2)
export interface ListSnapshot<R> { key: readonly unknown[]; rows: readonly R[]; coverage: Coverage; fetchedAtMs: number }
export function listCoverage(loaded: number, shown: number, truncated: boolean, staleAtMs: number | null,
  unknown?: Coverage['unknown']): Coverage;   // no `applied` → oldServer; else tagsStale > 0 → tagsStale
export function csvCell(v: string): string;   // the T24-026 guard, then RFC 4180
// widgets/boardList/
export function boardListOptions(o?: Record<string, unknown>): BoardListOptions;  // { mode; query; tag: string | null; limit; sort }
export interface BoardRow { uid: string; title: string; display: string; tags: readonly string[] | null;
  updatedAt: string | null; current: boolean }
export function boardSnapshot(key: readonly unknown[], r: BoardPage | RefPage,
  o: { mode; q; tag; currentUid; shown; nowMs }): { snapshot: ListSnapshot<BoardRow>; notice: 'tagNeedsServer' | null };
// also: repairActive(prevKey, prevIndex, keys), boardListTable(s), boardListFacts(title, mode, s | null),
// importBoardList(src) → { options; notes: string[] }
```

## 6. Data & storage

Board spec v4 (§5.1) is stored as the board document is today; the v3 → v4 upcaster is the identity
(T11-016). There is no new table, route or storage: widgets fetch nothing and make only safe GETs
(links and `local` images).

**Part B1.** Board spec v5 (§5.5) is stored the same way, with an identity upcaster. Migration 4 adds
the `boards.tags` cache ([T11](T11-postgres-schema.md) §4.3); it is metadata-only and keeps the N+1
window (T11-012, T11-013). The repair and the list (T24-029) run as two transactions:

```sql
-- migrations/00004_board_tags.sql (lock_timeout 5s, statement_timeout 5min; metadata-only)
ALTER TABLE boards ADD COLUMN tags text[] NOT NULL DEFAULT '{}', ADD COLUMN tags_version bigint NOT NULL DEFAULT 0;
ALTER TABLE boards ADD CONSTRAINT boards_tags_max CHECK (cardinality(tags) <= 16) NOT VALID;
-- I4 (next release): ALTER TABLE boards VALIDATE CONSTRAINT boards_tags_max;

-- name: RepairBoardTags :execrows — tx 1, committed alone; SET LOCAL statement_timeout '2s', lock_timeout '500ms'
WITH s AS (SELECT id FROM boards WHERE org_id = $1 AND deleted_at IS NULL AND tags_version <> head_version
           ORDER BY id LIMIT 200 FOR UPDATE SKIP LOCKED)          -- locked rows: no head move can interleave
UPDATE boards b SET tags = coalesce(ARRAY(SELECT jsonb_array_elements_text(v.spec->'tags')), '{}'), tags_version = b.head_version
FROM s, board_versions v WHERE b.org_id = $1 AND b.id = s.id AND v.org_id = $1 AND v.board_id = b.id AND v.version = b.head_version;

-- name: ListBoards :many — tx 2, ONE statement (one snapshot); always ≥ 1 row
WITH m AS (
  SELECT b.uid, b.title, b.tags, b.tags_version = b.head_version AS fresh, b.head_version, v.created_at, v.author_kind, v.author_id,
         (sqlc.arg(q)::text = '' OR strpos(lower(b.title COLLATE "C"), lower(sqlc.arg(q)::text COLLATE "C")) > 0
            OR (b.tags_version = b.head_version AND lower(sqlc.arg(q)::text COLLATE "C") = ANY (b.tags)))
     AND (sqlc.arg(tag)::text = '' OR (b.tags_version = b.head_version AND sqlc.arg(tag)::text = ANY (b.tags))) AS hit
  FROM boards b JOIN board_versions v ON v.org_id = b.org_id AND v.board_id = b.id AND v.version = b.head_version
  WHERE b.org_id = $1 AND b.deleted_at IS NULL),
st AS (SELECT count(*) FILTER (WHERE NOT fresh) AS tags_stale FROM m)   -- every stale row, returned or not
SELECT st.tags_stale, h.uid, h.title, CASE WHEN h.fresh THEN h.tags END AS tags, h.head_version, h.created_at, h.author_kind, h.author_id
FROM st LEFT JOIN LATERAL (SELECT * FROM m WHERE hit ORDER BY created_at DESC, uid LIMIT 1001) h ON true
ORDER BY h.created_at DESC NULLS LAST, h.uid;   -- the all-NULL sentinel exists only when nothing matched
-- uid NULL = no rows; > 1 000 rows = truncated. MoveBoardHead / InsertBoard: SET tags = $5, tags_version = <new head>.
-- ListStarred LIMIT 201; ListRecent LIMIT $3 + 1
```

`strpos` (not `LIKE`) means `%` and `_` in `q` are plain characters. `lower(… COLLATE "C")` folds ASCII
only, so `zürich` does not match `ZÜRICH`.

## 7. Performance budget

The Markdown and parse5 code loads as lazy chunks within the ADR-0014 §8 budgets (ADR-0024).
Report-only: `bench:markdown-render` (64 KiB ≤ 16 ms p95) and `bench:clock-tick` (20 Clocks × 12 zones
≤ 2 ms per tick).

Part B1: list widgets render plain DOM, without virtualisation (1 000 rows fit). Report-only:
`bench:widget-lists` (a 1 000-row re-render ≤ 16 ms p95).

## 8. Security, tenancy & RBAC

- One renderer with no HTML string sink (T24-004, [T18-005](T18-security.md#t18-005--one-trusted-types-sink),
  T18-013); every URL is classified after interpolation (T24-005, T18-011).
- Removals and import errors carry no content (T24-007, §5.4 step 5).
- AI output loads no image or other auto-loading element (T24-018, T18 §4.10). Until the image proxy
  ships, no external image is loaded (T18-014 interim).
- Tenancy: widgets fetch and store nothing; RLS is unchanged.
- Part B1: every board query runs in `OrgTx` under RLS (T11-003); org B is in every itest. The list
  GET writes only the tags cache, in a separate short transaction (at most 200 rows, `SKIP LOCKED`,
  2 s, on the primary); a failed repair leaves rows stale, and its log carries no titles.
- CSV cells are guarded against formula injection (`csvCell`, T24-026). Search uses `strpos`, so `q`
  has no wildcards; folding is ASCII-only.

## 9. Failure modes & degradation

| Risk | Handling |
|---|---|
| URL bypass, log or report leaks, AI images | `classifyUrl` and the fuzz gate; content-free removals and errors; `ai` has no `<img>` |
| Tenancy; spec versions | No fetch or storage; safe GETs; the next spec version |
| Ticks; zones | The due-time scheduler (T24-011); Go decides zone validity; a bad zone → one row (T24-010) |
| Tenancy (part B1) | `OrgTx` under RLS; org B in the itests |
| Rolling upgrade | One migration (N+1); an old binary's head move leaves the row stale → `unknown` until repaired; old binaries cannot move a v5 head (`ErrSchemaTooNew`); an old server answers without `applied` (T24-029) |
| A GET that writes | A separate short transaction, ≤ 200 rows, `SKIP LOCKED`, 2 s, on the primary; a failure leaves rows stale and never fails the list |
| A failed refetch; a late answer | The snapshot is kept with `staleAtMs`; an answer for an old key never renders (T24-024) |

## 10. Testing

Written first in the implementation issues. Origin `https://dash.test`; all fail today.

| Test | File | Setup | Expected | Covers |
|---|---|---|---|---|
| `unit:board-spec-widgets` | spec.test.ts, validate_test.go | fixtures | valid → none; text + `query` → `board.panel.query.forbidden`; line without → `.required`; clock `depth` → `unknownKey`; 13 zones, `tz:'Mars/Base'` → `zones.invalid`; duplicate zone → `.duplicate`; 65 537 bytes → `content.tooLong`; `to:'2026-11-26 14:00'` → `countdown.invalid`; TS = Go; v3 upcasts | T24-003, VIZ-031, 057 |
| `unit:classify-url` | sanitise/url.test.ts | strings | rejected: `/\t/evil.test`, `/a/../..//evil.test`, `/.//evil`, `/\\evil.test`, `//evil.test`, ` /x`, `/x\u0085`, `https://u:p@x.test/`, `JaVaScRiPt:x`, `data:,x`, `boards/b1`; local: `/boards/b1?x=1#h`, `/%5Cevil.test` (unchanged); external: `HTTPS://X.TEST` → `https://x.test/`; mailto: `mailto:o@x.test` | T24-005 |
| `unit:markdown-links` | sanitise/markdown.test.tsx | inputs L (below) | a → text + `linkScheme`; t → `/%09/e.test`; b, d, e → new-tab `<a>` | T24-005 |
| `unit:markdown-nodes` | same | `"<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n**ok**"`; `# A\n###### F\n1000000. x` | DOM `<p><strong>ok</strong></p>`, removals `[{html,1},{html,3}]`; `<h4>`, `<h6>`, `<ol start="999999">` | VIZ-054, T24-009 |
| `unit:markdown-iframe` | same | `<iframe src="https://s.test/"></iframe>`; `<div>t<iframe src="/b"></iframe></div>`; `a <script>'<iframe src="/b">'</script>` | nothing rendered; removals `[iframe]`, `[iframe]`, `[html]` | T24-006 |
| `unit:markdown-images` | same | inputs I (below); `board`, then `ai` | board: `<img src="/l.svg">`, link "g", text "d", `<img src="/%09/e.test">`; ai: 4 texts + `image`, no `img` | T24-018, T18-014 |
| `unit:markdown-interpolate` | same | inputs V (below) | text `Env prod prod $missing $__from {{entity}}`; code `$env`; href `?q=a%20b%26c`; y → text + `linkScheme` | T24-008 |
| `unit:removal-redaction` | same | `[x](javascript:fetch('https://u:hunter2@e.test/?token=abc'))`; `<a href="https://e.test/?token=abc">` | `[{linkScheme,1}]`, `[{html,1}]`; editor text and `console.debug` JSON lack `hunter2`, `token`, `e.test` | T24-007 |
| `fuzz:markdown-nodes` | sanitise/markdown.fuzz.test.ts | 10 000 inputs (seed 20261125), both policies, import | tags ⊆ §4.2; attributes ⊆ `href target rel src alt loading start data-lang`; URLs re-classify; `ai` no `img`; import inverse | VIZ-054, 056 |
| `unit:find-iframes` | sanitise/findIframes.test.ts | `<iframe data-src="a" src="b">`, `<iframe title='src="x"'>`, `<iframe src="b" SRC="c">`, `<iframe src="?a&copy=1">`, `<!-- x --!><iframe src=y>`, `<!--><iframe src=z>`, `<select>`/`<table>`/`<frameset>`/`<template>`/`<svg>`/`<select><title><select>` + `<iframe src=w>`; then `<script>`, `<textarea>`, `<title>`, `<style>`, `<xmp>`, `<plaintext>`, `<![CDATA[`, `<?x`, `</ ` before `<iframe src=x>` | `b`, `null`, `b`, `?a&copy=1`, `y`, `z`, `w` ×6; none for the rest or `<svg><![CDATA[…]]>`; no duplicates | T24-006 |
| `unit:import-text-iframe` | sanitise/importText.test.ts | f1, f3–f10 | exact `inserted`, `notes`; removing `inserted` gives the input byte-for-byte; hrefs f1 `https://x.test/a)b?q=%5B1%5D&r=%3C2%3E`, f3 `https://x.test/?a=&copy;&b=&#169;&c=&amp;d&e=1`, f5 as listed; f4/f6–f10 as listed | VIZ-056, T24-016 |
| `unit:import-size-error` | same | 65 500-byte panel "Payroll", `src` with `?token=SECRET123` | error `{kind:'textTooLargeForLinks', panelIndex, sourceId, links:1}`; JSON and message lack `SECRET123`, `Payroll` | T24-016 |
| `unit:clock-format` | widgets/clock/format.test.ts | 12:34:56Z, Context London, en-GB | Tokyo `21:34` `Thu 26 Nov` `UTC+09:00` night; New York `07:34` `UTC−05:00` day; Auckland `01:34` `Fri 27 Nov` `+1 day` night; UTC `12:34` `UTC` day; `h12` Tokyo `9:34 pm` | T24-010, 013 |
| `unit:clock-countdown` | same | `to` 14:49:56Z, 12:35:38Z, 12:34:56Z, 12:22:56Z, +2 d 3 h | `in 2 h 15 min`, `in 42 s`, `since 21:34 (0 s)`, `since 21:22 (12 min)`, `in 2 d 3 h`; `hide` + past → no row | T24-012 |
| `unit:countdown-due` | state/wallClock.test.ts | `to` fixed; r in ms | r → (text, due, next): 125 000 (`2 min`, +5 001, `1 min`); 120 000 (`2 min`, +1, `1 min`, announced); 960 000 (`16 min`, +1, `15 min`, announced); 60 000 (`1 min`, +1, `59 s`); 1 000 (`1 s`, +1, `now`); 1 (+1, `since … (0 s)`, announced); after-`to` e 59 999 (+1 → `1 min`). Property (200 s → −130 s, 137 ms steps): text changes exactly at due | T24-011, 012 |
| `unit:wall-clock` | same | fake timers; zone + countdown | one timer at earliest due; hidden at r = 90 s → none; visible at 30 s → all notified, `in 30 s` announced once; last unsubscribe clears | T24-011 |
| `e2e:widget-text` | e2e/widgets.spec.ts | `"# R\n[S](https://s.test)\nEnv $env"`, env=prod | `h4`; `_blank` link; env=dev → "Env dev", no query | VIZ-053 |
| `e2e:widget-text-xss` | same | `unit:markdown-nodes` input + iframe line; payloads set `window.__xss` | `__xss` unset; no CSP violation or page error; no `iframe`; removals `[html, html, iframe]` | VIZ-054, 056 |
| `e2e:widget-clock` | same | `page.clock` 12:34:56Z; Tokyo, NY; countdown to 12:35:56Z; reduced motion too | `in 1 min`, silent; +1 s `in 59 s`; +59 s `since 21:35 (0 s)`, announced; no transition if reduced | T24-012, VL-016 |
| `e2e:widget-a11y` | same | both, view/edit | axe clean; T24-017 order; "Tokyo, 21:34, Thu 26 Nov, night, UTC+09:00" | T24-017, VIZ-066, 068 |
| `golden:widget-gallery` | e2e/widget-gallery.spec.ts | 5 pages × dark/light/grey, fixed clock | CI baseline (0.1, ≤ 0.2 %) | VIZ-069, 067 |

Markdown inputs for the rows above (one per line, as written in the test):

```text
L  [a](javascript:x)   [t](</\t/e.test>)   [b](https://x.test/p)   [d](/b)   [e](mailto:o@x.test)
I  ![l](/l.svg)   ![g](https://x.test/g.png)   ![d](data:,x)   ![s](</\t/e.test>)
V  vars {env:'prod', q:'a b&c', u:'javascript:x'}; Env $env ${env} $missing $__from {{entity}}   `$env`
   [x](https://x.test/?q=$q)   [y]($u)
```

`ci:dep-audit` and `ci:no-iframe` still pass. Report-only: `bench:markdown-render` (64 KiB ≤ 16 ms
p95), `bench:clock-tick` (20 Clocks × 12 zones ≤ 2 ms per tick). No itest until A3. Every gate is in
[T05 §7.1](T05-testing-and-performance.md#71-gate-catalogue).

Fixtures `api/fixtures/import/text-iframe.json` (all pass in a prototype; ⏎ is a newline, a leading
number is a line number):

```text
f1 1 Intro <iframe src="https://x.test/a)b?q=[1]&amp;r=<2>"></iframe> end⏎2 <div>⏎3 keep <b>me</b>⏎4 <iframe src="https://intended.test/"></iframe>
   5 </div>⏎6 after⏎7⏎8 `<iframe src="https://code.test/">` and \<iframe src="https://esc.test/">⏎9⏎10 <iframe src="javascript:alert(1)"></iframe>
   after 1: ⏎[Open embedded page \(x\.test\)](<https://x.test/a)b?q=[1]&amp;r=%3C2%3E>)⏎⏎; after 6: ⏎[…](<https://intended.test/>)⏎
   notes [{iframeToLink,1,x.test},{iframeToLink,4,intended.test},{iframeNoLink,10},{htmlNotRendered,4}]
f3 <iframe src="https://x.test/?a=&amp;copy;&amp;b=&amp;#169;&amp;c=&amp;amp;d&amp;e=1"></iframe>
   insert ⏎[Open embedded page \(x\.test\)](<https://x.test/?a=&amp;copy;&amp;b=&amp;#169;&amp;c=&amp;amp;d&amp;e=1>)⏎
f4 1  0  `<iframe src="https://code.test/">`⏎3 <script>const e = '<iframe src="https://s1.test/">';</script>
   5 <style>/* <iframe src="https://s2.test/"> */</style>
   7 x <textarea><iframe src="https://s3.test/"></textarea> <title><iframe src="https://s4.test/"></title> y
   9 <iframe src="https://real.test/"><iframe src="https://inner.test/"></iframe>⏎11     <iframe src="https://indented.test/">⏎13 <plaintext><iframe src="https://p.test/">
   insert after 9 only (real.test); notes [{iframeToLink,9,real.test},{htmlNotRendered,11}]
f5 <iframe src="https://x.test/?a=1&copy=2&b=&copy;&c=&notit;&d=&#169=x"></iframe>
   href https://x.test/?a=1&copy=2&b=%C2%A9&c=&notit;&d=%C2%A9=x (= browser's src URL)
f6 B = `<iframe src="https://s.test/"></iframe>⏎` + 65 442 × `x` + `⏎` (65 483 bytes; insert is 53) → 65 536 bytes, converted;
   one more `x` → `{ok:false, sizeLimit, links:1}`; B with mode code → `ok`, unchanged, notes []
f8 <div><!-- a --!><iframe src="https://bang.test/"></iframe></div>⏎⏎x <!-- b --!> <iframe src="https://bang2.test/"></iframe> y
   inserts after 1 and 3; notes [{iframeToLink,1,bang.test},{iframeToLink,3,bang2.test},{htmlNotRendered,3}]
f9 lines 1, 3, 5, 7: <select><iframe src="https://sel.test/"></iframe></select> · a <select><iframe src="https://sel2.test/"></select> b ·
   <frameset><iframe src="https://fs.test/"></frameset> · <template><iframe src="https://tpl.test/"></template> → a link after each; 4 iframeToLink, {htmlNotRendered,11}
f10 <select><title><select><iframe src="https://x.test/"></iframe></select></title></select>⏎⏎a ‹same with y.test› b
   links after 1, 3; notes [{iframeToLink,1,x.test},{iframeToLink,3,y.test},{htmlNotRendered,16}]
f7 lines 1–13 (blank between): <![CDATA[<iframe src="https://c1.test/">]]> · a <![CDATA[<iframe src="https://c2.test/">]]> b ·
   <?x <iframe src="https://p1.test/"> ?> · a <?x <iframe src="https://p2.test/"> ?> b · <!DOCTYPE <iframe src="https://d.test/">> ·
   <div></ <iframe src="https://b.test/">x</div> · <div><!--><iframe src="https://after.test/"></div>
   only insert: after 13, after.test; notes [{iframeToLink,13,after.test},{htmlNotRendered,7}]
```

### 10.1 Part B1 tests

Written first in I1 and I2 (§11); all fail today: nothing exists yet.

**Fixture B:** 12 starred refs in server order: Checkout (`ck-1`), Checkout (`ck-2`), Edge, Gateway,
Inventory, NOC overview, Orders, Payments (`pay`), PSP API, Search, Shipping, Web; `truncated: false`.
**Fixture S:** org A: "Checkout overview" `[team:payments]`, "CHECKOUT latency", "Zürich edge",
"ZÜRICH core", "payments" `[payments]`, and 1 002 "bulk-n" (distinct `created_at`); org B:
"checkout b".

| Test | File | Setup | Expected | Covers |
|---|---|---|---|---|
| `unit:board-spec-board-list` | boards/spec.test.ts, validate_test.go | `{}`; tag mode, no tag; starred + tag; 101-char query; `query:'a\tb'` (`\t` = U+0009 TAB); recent + query; limit 0/51/2.5; `sort:'care'`; `depth:1`; board tags ×17/`['A']`/`['a','a']` | Defaults `{starred,'',null,10,default}`; `tag.invalid` ×2, `query.invalid` ×3, `limit.invalid` ×3, `sort.invalid`, `board.json.unknownKey`, `board.tags.invalid` ×2, `.duplicate`; TS = Go; v4 upcasts; the editor shows the Cc text for `a\tb` (U+0009) and sends nothing | T24-029, T24-021, VIZ-031 |
| `unit:board-list-source` | widgets/boardList/source.test.tsx | Stub Api, fake timers | T24-021 calls and keys; `'  Checkout '` → `{q:'Checkout'}`; `''` → no `q`; keys at 0/100/200 ms → one key change and request at 450 ms, the previous rows shown until then | T24-021 |
| `unit:board-list-rows` | widgets/boardList/rows.test.ts | B, current `pay` | `Checkout · ck-1`, `Checkout · ck-2`, the rest plain; `pay` "this board"; `incidents` → B order + the caption | T24-022, T24-023 |
| `unit:list-coverage` | widgets/lists/snapshot.test.ts | `listCoverage` → `coverageText`; `unknown` via `boardSnapshot` (no `applied`; `tagsStale` 1, 3) | (12,10) `showing 10 of 12`; (12,12) `100 %`; (1000,10,trunc) `truncated · showing 10 of 1,000`; (0,0) `100 %`; (3,3,oldServer) `coverage unknown`; (3,3,tagsStale 1) `tags not yet known for 1 board`, 3 → `tags not yet known for 3 boards`; stale 12:31:05 `stale (12:31:05)`; Narrow in search only | T24-024, VIZ-027 |
| `unit:board-list-states` | widgets/boardList/states.test.tsx | Stub: ok B → the refetch fails at 12:31:05 → Retry ok, B minus Orders, Edge → "Edge v2"; also 503 | `Loading…` at 300 ms, `loading`, facts null; 12 rows; failure: rows kept, the notice, `showing 10 of 12 · stale (12:31:05)`, CSV 12 rows, `12 boards (stale)`; Retry: 11 rows, "Edge v2", CSV without Orders, `11 boards`; 503 → the store text, `unavailable` | T24-024, T24-026, T24-027 |
| `unit:board-list-mixed` | widgets/boardList/mixed.test.tsx | No `applied`: starred `{items:B, truncated:false}`; search `check` → S org-A items / `[]`; tag `team:payments` → S org-A items / `[]`. New server `tagsStale: 3`; a save → 400 at `/tags` | Starred `coverage unknown · showing 10 of 12`, setsize −1; search → 2 checkout rows, no chips / "No boards match ‘check’", both `coverage unknown`; tag (both) → the T24-029 notice, no rows, `coverage unknown`; `tags not yet known for 3 boards`; the editor text | T24-029 |
| `unit:board-list-key` | widgets/boardList/key.test.tsx | Deferred stub: `check` settled (2 rows); type `pa`→`pay` within 250 ms; a second widget on `check`; tenant `acme` → `beta`; `pay` rejects | At 450 ms (commit) no `check` row, CSV disabled, facts null; `check`'s refetch kept while widget 2 observes, aborted when it leaves; late `check` answers never render in widget 1; no `acme` row after `beta` (render log); `pay` → "Couldn't load boards", no rows, `unavailable` | T24-024 |
| `unit:list-keyboard` | widgets/lists/keyboard.test.tsx | B, limit 10, focus on row 4 (Gateway) | ↓×3 from 1 → 4; End → 10; Home → 1; PageDown → 10; Show more, Enter → 11 focused. A refetch without Gateway → Inventory (row 4) focused, "Gateway is no longer listed"; focus outside the list stays; empty → the empty text; error → Retry; Esc clears the search, the next Esc reaches the T25 ladder | T24-025 |
| `unit:list-table-csv` | widgets/lists/table.test.ts | Titles `=SUM(1)`, `+1`, `-prod`, `@x`, `\tx`, `\rx` (`\t` = U+0009 TAB, `\r` = U+000D CR), `a,b`, `say "hi"`, `ok`; B; S | `'=SUM(1)`, `'+1`, `'-prod`, `'@x`, `'\tx`, `"'\rx"`, `"a,b"`, `"say ""hi"""`, `ok`; B rows: empty tags, `updated_at`; S `Checkout overview` tags `team:payments`; a `tags: null` row → `unknown`, and the row shows "tags unknown"; facts `{'12 boards','Starred'}`, S `1,000+ boards` | T24-026, VIZ-066, VIZ-068 |
| `unit:import-board-list` | import/boardList.test.ts | I1–I9 (below) | Options (`sort:'default'`) and notes exactly as listed | T24-028, VIZ-060 |
| `itest:board-find` | store/boards_itest_test.go | S | `q=` checkout → 2 org-A rows, updated desc; zürich → Zürich edge; ZÜRICH → ZÜRICH core; payments → payments; `%` → none; bulk → the 1 000 newest in `created_at DESC, uid` order, truncated, the 2 oldest absent; `tag=team:payments` → Checkout overview; 101 chars, `Bad Tag` → the §5.6 400s; org B sees only "checkout b" | T24-021, tenancy |
| `itest:board-tags` | same | Org A saves `tags:['a','b']`, then none, then v1's spec again. Org B saves and lists | `[a,b]`, `[]`, `[a,b]`; B's save of A's uid → 404; B's repair touches 0 A rows; `tag=a` in B → none | T24-029, tenancy |
| `itest:board-list-snapshot` | same; two connections, barriers; a labelled fault injection sets `tags_version` 0 on X (head `[a]`, title "X checkout") | (1) Conn 2 row-locks X; conn 1 lists `tag=a`; release; conn 2 lists; conn 1 lists. (2) Between conn 1's repair and read, conn 2 commits a schema-3 head move on Z. (3) `tag=zzz`. (4) X locked: an unfiltered list; `q=checkout`. (5) A repair error (tracer), a timeout (`pg_sleep`). (6) A cancel during the repair | (1) X absent, `tagsStale` 1; then present, 0. (2) Z counted, never `100 %`. (3) the sentinel only: `[]`, stale 1. (4) X returned with `tags: null`, `tagsStale` 1, both times. (5) 200, stale counted, the log without titles. (6) both roll back. One SELECT per list | T24-029 |
| `itest:board-tags-old-binary` | CI job in I1 | 10 000 boards in 2 orgs at schema 3, a looping reader; migration 4; the base-commit binary beside N. The old service creates Y, saves Z; N saves X `[a]`; the old service saves X | No rewrite (`relfilenode`), the reader waits ≤ 1 s, 17 tags fail; the old binary starts (4 = 3 + 1) and passes `itest:board-crud`; `tag=a`: `tagsStale` 2 (Y, Z); the old save of X → `ErrSchemaTooNew`, nothing written; the next N list: Y, Z `{}`, `tag=a` → X, 0 | T11-012, T11-013, T11-015 |
| `itest:board-tags-validate` (I4) | same | Schema 4 with all rows ≤ 16 tags; apply the I4 migration | `pg_constraint.convalidated` true; an UPDATE to 17 tags fails | T11-013 |
| `itest:board-prefs` (amended) | existing | 201 starred; 200; 51 views, limit 50 | `truncated` true, false, true | T24-021 |
| `e2e:widget-board-list` | e2e/widgets.spec.ts | Stub BFF; B; search over S | 10 rows + Show more; "check" → one request 250 ms after the last key, 2 rows, "2 boards" announced once; hrefs carry `from`/`to`; ⌘-click → a new tab | VIZ-053, T24-021–023 |
| `e2e:widget-lists-a11y` | same | Widgets in the loading (held 2 s), empty, error 500, stale, unknown, ok B and `bulk` states; view, edit; reduced motion | axe clean in each; focus to the empty `<p>` / Retry; `Payments, this board`; the T24-025 order; setsize 12 / −1 (`bulk`, unknown); no transition when reduced | T24-025, T24-027, VL-016 |
| `golden:widget-gallery` (amended) | e2e/widget-gallery.spec.ts | + `widget-board-list` (B), `widget-board-list-search` (S), `widget-board-list-states` (loading, stale, unknown, empty); 3 themes | CI baseline (0.1, ≤ 0.2 %) | VIZ-069, VIZ-067 |

Import cases for `unit:import-board-list` (Dashboard list options → `boardList` options and notes, in
order; every result has `sort:'default'`, and `query:''`, `tag:null`, `limit:10` unless shown):

```text
I1 {}                                                              → starred; no notes
I2 {showStarred:true, showRecentlyViewed:true, maxItems:80}        → starred, limit 50; "Only the first list (starred) kept: add another Board list for recent", "Item limit 80 clamped to 50"
I3 {showStarred:false, showSearch:true, tags:['Team-A','b c','ops'], query:'x'}
                                                                   → tag, tag 'team-a'; "Tag ‘b c’ dropped: not a valid tag", "Tags not kept: ops (a board list filters by one tag)", "Search text dropped in tag mode"
I4 {showStarred:false, showSearch:true, query:'a' × 120}           → search, query 'a' × 100; "Search text cut to 100 characters"
I5 {showStarred:'yes', maxItems:'many', keepTime:false, folderUID:'abc', includeVars:true}
                                                                   → starred; "Option showStarred malformed: default used", "Option maxItems malformed: default used", "Links keep the time range", "Option folderUID not mapped", "Option includeVars not mapped"
I6 {showStarred:false, showRecentlyViewed:false, showSearch:false} → starred; "No list enabled: starred used"
I7 {showStarred:false, showSearch:true, tags:['!!']}               → search; "Tag ‘!!’ dropped: not a valid tag"
I8 {showRecentlyViewed:false, query:'x', maxItems:0}               → starred, limit 1; "Search text and tags dropped: they apply to search only", "Item limit 0 clamped to 1"
I9 {showStarred:false, showSearch:true, query:'a\tb\u0007c'}       → search, query 'abc' (removed: U+0009 TAB, U+0007 BEL); "Control characters removed from search text"
```

Report-only: `bench:widget-lists` (a 1 000-row re-render ≤ 16 ms p95). `ci:dep-audit` passes. Every
gate is in [T05 §7.1](T05-testing-and-performance.md#71-gate-catalogue).

## 11. Rollout

Implementation issues, filed after this design merges:

| Issue | Scope | Depends on | Covers |
|---|---|---|---|
| A1 — Text, renderer, spec v4 | §5.1, §5.2, §5.4, editor, gallery `widget-text`, `widget-text-removals` | #173 | T24-001–009, T24-014–018 |
| A2 — Clock | §5.3, editor, gallery `widget-clock-1`, `widget-clock-4`, `widget-clock-countdown` | A1 | T24-010–015, T24-017 |
| A3 — Image proxy | T18-014 route, rewrite | T18 §4.9 egress guard | T18-014 |

A1 needs #173 (board spec v3) and ships v4 (or the next free version). The implementation writes
`docs/client/widgets.md` (behaviour, Markdown, URLs, import, Clock) and updates
`docs/client/boards.md`, `docs/user/boards.md`, `docs/server/boards-api.md` and
`docs/client/supply-chain.md` (widget panels, the v4 keys, the `markdown` dependencies).

Part B1 implementation issues, filed after this design merges:

| Issue | Scope | Depends on | Covers |
|---|---|---|---|
| I1 — BFF: board tags, `/boards` search, `applied`, `truncated` | §5.6, §6, migration 4, the itests, `docs/server/boards-api.md`, `docs/server/database.md` | #198 | T24-021, T24-029 |
| I2 — Board list widget, list modules, editor tags field | §5.5, §5.7, the unit, e2e and golden tests, gallery `widget-board-list`, `widget-board-list-search`, `widget-board-list-states`; `docs/client/widgets.md`, `docs/user/boards.md` | I1, #198, #173 | T24-020–028 |
| I3 — Incident-use ranking (needs design) | SRF-026 "used during incidents" | IA-007 | T24-023 |
| I4 — Validate `boards_tags_max` (next release) | §6 `VALIDATE CONSTRAINT`, `itest:board-tags-validate` | I1 released | T24-029 |

I1 writes the new `/boards` parameters, fields and errors, migration 4, the tags freshness and repair
and I4 into the server docs. I2 writes the Board list (modes, options, meter, keys, CSV, mixed server
versions) into `docs/client/widgets.md`, and adding a Board list and board tags into
`docs/user/boards.md`.

## 12. Alternatives considered

Rejected:
- a separate sanitiser ([T08](T08-dom-component-kit.md) §12);
- hand-written HTML scanning;
- one parser mode (the tree or the tokenizer alone each misses a context, §5.2);
- `DOMParser` (a Trusted Types sink, T18-005).

Part B1, rejected:
- client-side board search (it misses boards past 1 000);
- tags read only from the head spec (a list would detoast specs of up to 2 MiB);
- two migrations (an N+1 window problem);
- virtualised list rows (1 000 rows fit plain DOM).

## 13. Open questions

None.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-25 | #153 part A: created: the part map and ID blocks for parts A–K; rules T24-001 to T24-018; the Markdown node table, clock formats and import mapping; board spec v4, the renderer, wall clock and import conversion interfaces; tests and fixtures; the implementation issues A1–A3; [ADR-0024](../adr/0024-markdown-runtime-dependencies.md) |
| 1.1-rc | 2026-11-25 | #181 part B1 (step 1): the part map splits B into B1 (T24-020–029) and B2 (T24-030–039, VIZ-126); T24-002 amended (content widgets; list widgets follow T24-020); rules T24-020 to T24-029 (list widgets, Board list sources, rows, limit and ranking, snapshot and meter, keyboard and focus repair, table, CSV and facts, states and look, import, board tags and compatibility); §4.5 list states, §4.6 Board list import; §5.5 board spec v5, §5.6 the `/boards` contract, §5.7 the client list modules; §6 migration 4 and the repair and list queries; §7–§9, §10.1 tests and fixtures, §11 issues I1–I4, §12. [T22-006](T22-value-categorical-and-table-panels.md#t22-006--caps-keep-the-signal) gains the optional `Coverage` list members; [T11](T11-postgres-schema.md) §4.3 migration 4 |
