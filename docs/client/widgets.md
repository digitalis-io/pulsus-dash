# Widgets

A widget is board furniture: a panel without a query (T24-002). Board spec v5 (#198 Part 1) adds
the first two kinds, **Text** (Markdown or code) and **Clock** (the time in up to 12 zones, with an
optional countdown); board spec v6 (#216 Part 1) adds the **Board list**
([below](#board-list-in-progress)). This page covers what the client does with them in this version: the panel
union, the option defaults, the widget frame and the validation. The spec itself, with every key
and error, is on [the boards API page](../server/boards-api.md#widgets-text-and-clock-v5); the
user's view is [Boards](../user/boards.md#widgets).

**Coming later.** This version reads, shows, moves, duplicates, removes and saves widgets, but
draws no kind: each shows "This widget isn't available in this version yet." The Markdown
renderer and the import conversion come with #198 Part 2; the Text view, its editor, adding a
widget and the gallery with #198 Part 3; the Clock view with A2; the Board list view, editor and
states with #216 Part 2. Until then only boards written through the API have widgets.

| Module | Role |
|---|---|
| `src/api/types.ts` | `PanelSpec = DataPanelSpec \| WidgetPanelSpec`, `WidgetKind`, `DataVisKind`, `CodeLanguage`, `ClockZone`, `ClockCountdown` |
| `src/widgets/spec.ts` | `WIDGET_KINDS`, `PENDING_WIDGETS`, `isWidgetKind`, `isWidgetPanel`, `isDataPanel`, `textOptions`, `clockOptions` |
| `src/widgets/WidgetBody.tsx` | the widget's body |
| `src/pages/board/WidgetFrame.tsx` | the widget's panel chrome on a board |
| `src/boards/spec.ts`, `src/boards/options.ts` | the v5 and v6 rules of `checkBoardSpec`; the option tables |
| `src/widgets/lists/` | the list widgets' snapshot, focus repair, table and CSV (shared with the change feed) |
| `src/widgets/boardList/` | the board list's options, rows, facts and test fixtures |
| `src/import/boardList.ts` | a dashboard list panel's options as a board list |

## The panel union

The OpenAPI `Panel` has `query` optional and `vis.kind` any of eleven kinds. The client's types
describe only valid specs:

```ts
type WidgetKind = 'text' | 'clock' | 'boardList';
type DataVisKind = Exclude<PanelVisKind, WidgetKind>; // auto … pie
interface DataPanelSpec { query: PanelQuery; vis: PanelVis & { kind: DataVisKind }; … }
interface WidgetPanelSpec { query?: never; vis: PanelVis & { kind: WidgetKind }; … }
type PanelSpec = DataPanelSpec | WidgetPanelSpec;
```

`isWidgetPanel(p)` and `isDataPanel(p)` narrow a panel by its kind. Every reader of `query` takes a
`DataPanelSpec`, so the compiler guards them all ([the panel runtime](boards.md#widgets-and-the-query-typing-198-part-1)).
`HttpApi` builds the union from the wire spec: a widget kind is a widget, and a data panel without
a query is a `badResponse` (the server never sends one).

## Option defaults

`textOptions(o)` and `clockOptions(o)` read a panel's `vis.options` with the T24 §5.1 defaults,
and `boardListOptions(o)` with the T24 §5.5 ones ([below](#board-list-in-progress)); the stored
spec keeps only the keys that were set. `mode` is shared with the board list: `textOptions` takes it
only when `isTextMode` (`markdown`, `code`; `DEFAULT_TEXT_MODE` otherwise).

| Function | Field | Default |
|---|---|---|
| `textOptions` | `mode` | `markdown` |
| | `content` | `''` |
| | `language` | `plaintext` (used in `code` mode only) |
| `clockOptions` | `zones` | `[{ tz: '', label: '' }]`: one row in the Context zone, labelled with its city |
| | `hourCycle` | `auto` |
| | `seconds` | `false` |
| | `date` | `true` |
| | `countdown` | `null` (none) |

## The widget frame

`PanelFrame` branches first: a widget renders `WidgetFrame`, a data panel `DataPanelFrame` (the
panel as it was before widgets). Both keep `PanelFrame`'s props, its `memo` and its `ref`.

```text
<section class=panel data-panel data-panel-id data-grid data-vis data-panel-state="widget" data-widget="" tabIndex=-1>
  PanelHeader: <h3> title · Panel menu [Duplicate, Remove] · Move or resize (Edit mode)
  <WidgetBody>: a PENDING_WIDGETS kind → EmptyState "This widget isn't available in this version yet."
```

A widget has no run, viewport tracking, `ChartFrame`, Inspector, Open in Explore, Copy query or
Full screen (T24-002). In Edit mode its header is the drag handle and Move or resize works as for
any panel; Duplicate and Remove are the panel menu's ([the panel menu](boards.md#the-panel-menu)).
A selected widget opens no panel editor: `BoardPage` opens it only for a data panel, so a save that
the server refuses at a widget's pointer selects the widget (`data-selected`) without a dialog.

`PENDING_WIDGETS` (`text` until #198 Part 3, `clock` until A2, `boardList` until #216 Part 2) lists the kinds drawn as "not
available yet"; a kind leaves it when its view ships. The en-GB text is `widget.kindUnavailable`.

## Validation

`checkBoardSpec` runs the server's v5 and v6 rules in the same order, with the same pointers and keys,
and en-GB texts for each (`field.board.…`):

| Key | Text |
|---|---|
| `board.panel.query.forbidden` | A widget has no query. |
| `board.panel.query.required` | Add a query. |
| `board.options.mode.invalid` | Choose a listed mode. |
| `board.options.sort.invalid` | Choose a listed sort order. |
| `board.options.query.invalid` | Use up to 100 characters without control characters, in search mode only. |
| `board.options.tag.invalid` | Use one valid tag, in tag mode only. |
| `board.options.limit.invalid` | Use a whole number from 1 to 50. |
| `board.options.content.tooLong` | Use at most 65 536 bytes. |
| `board.options.language.invalid` | Choose a listed language (code mode). |
| `board.options.zones.invalid` | Use 1 to 12 known time zones, labels up to 64 characters. |
| `board.options.zones.duplicate` | This time zone is listed twice. |
| `board.options.hourCycle.invalid` | Choose auto, 12-hour or 24-hour. |
| `board.options.countdown.invalid` | Use a time with an offset, a 1–64 character label, and count up or hide. |

The limits are `MAX_CONTENT_BYTES` (65 536 UTF-8 bytes), `MAX_ZONES` (12) and 64 for a zone name
(bytes) and a zone or countdown label (characters). `TZ_NAME` is the zone name form;
`isRfc3339Offset(s)` is the server's `validRFC3339Offset`, digit for digit (the shared rows hold
both together). The client checks a zone's **form** only: it holds no zone list, and does not ask
the browser (`Intl` accepts and refuses names the server's build does not). Whether a zone exists is
the server's answer on a create or a save, `board.options.zones.invalid` at the zone's `/tz`.

`OPTION_ORDER`, `OPTION_TYPES` (`array` for `zones`, `object` for `countdown`), `OPTION_MEMBERS`
and `OPTION_KEYS` (`text`: `mode`, `content`, `language`; `clock`: `zones`, `hourCycle`, `seconds`,
`date`, `countdown`; `boardList`: `sort`, `mode`, `query`, `tag`, `limit`) equal `api/fixtures/board-spec/option-keys.json`, as the Go tables do.

## Board list (in progress)

A board list lists boards on a board (T24-020): the principal's Starred or Recent boards, a title
search, or the boards with one tag. Part 1 (#216) ships the spec, the API pages
([the panel runtime](boards.md#board-list-pages-and-filters-216-part-1)) and every pure module; the
view, its sources, states, keys, editor and the Shift+T table are Part 2. A stored board list shows
the widget frame's "not available yet".

**Options** (`widgets/boardList/options.ts`, the spec on
[the boards API page](../server/boards-api.md#board-list-boardlist-v6)): `boardListOptions(o)` gives
`{mode: 'starred', query: '', tag: null, limit: 10, sort: 'default'}` for the keys not set; a `mode`
that is not a board list's reads as `starred`. `MAX_BOARD_QUERY` (100) and `BOARD_LIMIT` (1–50)
are in `boards/options.ts`.

**Snapshot and meter** (`widgets/lists/snapshot.ts`, T24-024). A `ListSnapshot<R>` is one answer's
rows under its query key, with a `Coverage` and `fetchedAtMs`. `listCoverage(loaded, shown,
truncated, staleAtMs, unknown?)` sets `total` and `drawn` (at most the loaded), the truncation and
nothing else, so `coverageText` reads `showing 10 of 12`, `100 %`, `truncated · showing 10 of
1,000`, `coverage unknown` or `tags not yet known for 3 boards`, with `· stale (12:31:05)` after a
failed refetch (`withStale`). `listSetSize` is `aria-setsize`: the loaded count, or −1 when the
answer is truncated or its coverage unknown. `csvCell` is re-exported from `data/csv.ts`.

**Rows** (`widgets/boardList/rows.ts`). `boardSnapshot(key, page, {mode, q, tag, currentUid, shown,
nowMs})` builds the snapshot in the server's order:

| Answer | Rows | Coverage |
|---|---|---|
| Starred, Recent | tags `[]`, `updatedAt` null | as sent |
| search, tag | tags as sent (`null` = "tags unknown"), `updatedAt` as sent | `tagsStale` > 0 → `tags not yet known for k board(s)` |
| an old server, search | the titles that contain `q` (ASCII case folded; `''` keeps all), tags `null` | `coverage unknown`, not truncated |
| an old server, tag | none, and the notice `tagNeedsServer` | `coverage unknown` |

Rows with the same title show `‹title› · ‹uid›`; the board that holds the widget is `current`, and
`boardRowName` gives `‹display›, this board`. `rankingCaption('incidents', {investigations: false})`
is "Ranking by use during incidents is available with investigations (M-UI4)" (T24-023); the order
never depends on `sort`.

**Keys** (`widgets/lists/focus.ts`, T24-025). `repairActive(prevKey, prevIndex, keys)` keeps the
active row by key; if it is gone, the row at its old index (clamped) is active and `gone` is true;
with no previous key the first row; an empty list has none (`index` −1).

**Table, CSV and facts** (`widgets/lists/table.ts`, `widgets/boardList/facts.ts`, T24-026).
`boardListTable` has the columns `title,uid,tags,updated_at`: tags `;`-joined, `unknown` when not
known, empty when none; `updated_at` ISO 8601 UTC or empty. `listCsv` writes it as RFC 4180, CRLF,
each cell through `csvCell` (`=SUM(1)` → `'=SUM(1)`; `-6.25` unchanged). `boardListFacts(title,
mode, snapshot)` gives `current` `{text: '12 boards', series: 'Starred'}`, `1,000+ boards` when
truncated, with ` (coverage unknown)`, ` (stale)` or ` (coverage unknown, stale)`; null without a
snapshot.

**Import** (`import/boardList.ts`, T24-028, T24 §4.6). `importBoardList(src)` maps a dashboard list
panel's options (`showStarred`, `showRecentlyViewed`, `showSearch`, `maxItems`, `query`, `tags`,
`keepTime`) to board list options and report notes. The mode is the first list enabled (none:
starred); search with a valid tag becomes tag mode; `maxItems` is clamped to 1–50. Each note is
English text, in this order: the mode note, malformed options ("Option maxItems malformed: default
used"), the dropped or cut tags and search text, the clamp, "Links keep the time range" for
`keepTime: false`, and "Option ‹key› not mapped" for every other key, sorted.

**Mixed versions.** A tab of the previous release meets a v6 board as a bad response; a v5 server
refuses a board list on a write (`board.vis.kind.invalid`). No client writes one before Part 2.

## Tests

| Gate | File |
|---|---|
| `unit:widget-spec` | `src/widgets/spec.test.ts`: the defaults and `isWidgetPanel` per fixture panel |
| `unit:widget-frame` | `src/pages/board/BoardWidgets.test.tsx`: `v5-widgets.json` on a board; five widget sections with their title and the unavailable text, no Explore, Full screen or chart; the menu; one query (the data panel); a selected widget opens no editor; a duplicated widget saves without a query |
| `unit:board-spec-widgets`, `unit:board-spec` (v5 rows) | `src/boards/spec.test.ts`: the v5 fixture and its canonical SHA-256 (the Go suite holds the same), the `w-*` rows of `invalid.json`, the widget limits, `isRfc3339Offset` |
| `unit:board-options` | `src/boards/options.test.ts`: the tables equal `option-keys.json` |
| `unit:board-variables` | `src/boards/variables.test.ts`: a text widget's `$region` is not a variable |
| `unit:board-spec-board-list` | `src/boards/spec.test.ts`: `v6-board-list.json` and its SHA-256, the 14 `bl-` rows with their texts, the bounds, `boardListOptions`; `BoardWidgets.test.tsx`: a stored v6 board, five lists not available, one query |
| `unit:board-list-rows` | `src/widgets/boardList/rows.test.ts` (fixtures B and S in `fixtures.ts`) |
| `unit:list-coverage` | `src/widgets/lists/snapshot.test.ts` |
| `unit:list-table-csv` | `src/widgets/lists/table.test.ts`: the guard block, B, S, `unknown` tags, the facts |
| `unit:list-keyboard` (pure) | `src/widgets/lists/focus.test.ts` |
| `unit:board-list-source`, `unit:board-list-mixed` (API) | `src/api/HttpApiBoardList.test.ts`, `src/api/StubApi.test.ts`: the URLs, the old-server decoding and snapshots, the stub's filter and truncation |
| `unit:import-board-list` | `src/import/boardList.test.ts`: I1–I12 |

## Designs

- [T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md): T24-002 (widgets are
  furniture), T24-003 (widget spec), §5.0 and §5.1 (the widgets version), T24-020 to T24-026 and
  T24-028 (list widgets, the board list's sources, rows, ranking, snapshot and meter, keys, table,
  CSV, facts and import), T24-029 (old servers), §4.6 and §5.5 to §5.7 (the board-list version and
  modules), §11 (the parts).
- [05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md): VIZ-053
  (staged), VIZ-057, VIZ-027, VIZ-060, VIZ-065, VIZ-066.
- [T11](../../designs/technical/T11-postgres-schema.md): T11-015, T11-016 (the v4 → v5 and v5 → v6
  identity upcasts).
- [ADR-0014](../../designs/adr/0014-typescript-react-web-client.md),
  [ADR-0015](../../designs/adr/0015-go-bff.md).
