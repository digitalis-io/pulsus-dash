# Widgets

A widget is board furniture: a panel without a query (T24-002). Board spec v5 (#198 Part 1) adds
the first two kinds, **Text** (Markdown or code) and **Clock** (the time in up to 12 zones, with an
optional countdown); board spec v6 (#216 Part 1) adds the **Board list**
([below](#board-list-in-progress)). This page covers what the client does with them in this version: the panel
union, the option defaults, the widget frame and the validation. The spec itself, with every key
and error, is on [the boards API page](../server/boards-api.md#widgets-text-and-clock-v5); the
user's view is [Boards](../user/boards.md#widgets).

**Coming later.** This version reads, shows, moves, duplicates, removes and saves widgets, but
draws no kind: each shows "This widget isn't available in this version yet." #198 Part 2a adds
the sanitiser's URL classifier, iframe finder and import conversion
([below](#sanitiser-modules-part-2a)), which no page uses yet; the Markdown renderer comes with
Part 2b; the Text view, its editor, adding a widget and the gallery with #198 Part 3; the Clock view with A2; the Board list view, editor and
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
| `src/security/sanitise/url.ts` | `classifyUrl`, `URL_FORBIDDEN`, `toWellFormed` (Part 2a) |
| `src/security/sanitise/findIframes.ts`, `feedback.d.ts` | `findIframes` and the type of the `parse5-sax-parser/feedback` alias (Part 2a) |
| `src/security/sanitise/importText.ts` | `convertImportedText`, `markdownLink`, the import notes and the size error (Part 2a) |

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

## Sanitiser modules (Part 2a)

Three pure modules under `src/security/sanitise/` that the Markdown renderer (Part 2b), the Text
view (Part 3) and the importers (#158, #17) build on. None fetches anything, none makes a DNS
lookup, and none is imported by a page yet, so the shipped build is unchanged. ESLint keeps the
parsers inside this directory ([below](#lint-rules)).

### URL classes (`url.ts`, T24-005, T18-011)

`classifyUrl(raw, appOrigin)` returns one of four classes and never throws. `raw` first passes
`toWellFormed`; the steps then run in order and the first match decides:

| # | Condition | Result |
|---|---|---|
| 1 | `URL_FORBIDDEN` matches: a C0 control, space, DEL, a C1 control or `\` anywhere | `rejected` |
| 2 | starts with `/`: parsed as `new URL(raw, appOrigin)` | `local` if it is same-origin and its pathname does not start with `//` (so `/a/../..//x` and `/.//x` are rejected); `href` is path-relative (`pathname + search + hash`), `host` the app's |
| 3 | starts with `http:`, `https:` or `mailto:` (any case) and parses | `mailto` with the parsed href; `external` with the parsed, normalised href and its host, unless it has a user name or password (then `rejected`) |
| 4 | anything else: other schemes (`javascript:`, `data:`, `blob:`, `file:`, `vbscript:`), look-alike or non-ASCII schemes, relative paths, `#…`, `''` | `rejected` |

A URL that does not parse is rejected. A host that is not valid (for example one holding U+FFFD) does
not parse.

**`toWellFormed(s)`** replaces every lone surrogate with U+FFFD and keeps valid pairs; the ES2023
lib has no `String.prototype.toWellFormed`. A lone surrogate in an accepted path therefore comes out
as `%EF%BF%BD`, and URL parsing and `encodeURIComponent` never see one.

### Finding iframes (`findIframes.ts`, T24-006)

`findIframes(html)` returns `{offset, line, src}` for each `iframe` start tag in an HTML fragment,
sorted by offset (the UTF-16 index; `line` is 1-based). `src` is the first `src` attribute decoded
as the HTML spec does, or `null`. The result is the **union**, de-duplicated by start offset, of:

- the `iframe` start-tag tokens of the spec tokenizer, which `ParserFeedbackSimulator` drives as the
  tree builder would (namespaces, raw text, RCDATA, CDATA in foreign content);
- the `iframe` elements of the `parse5.parse` tree, template contents included.

Each covers the other's gap: the tree drops `<select><iframe>`, and the tokenizer alone misses
`<select><title><select><iframe>`. Both keep the spec's handling of `<script>`, `<style>`,
`<textarea>`, `<title>`, `<xmp>`, `<plaintext>`, comments, CDATA, processing instructions and
`</ ` bogus comments, so no iframe is reported inside them. Over-counting only adds a link.

**Why the simulator.** `parse5-sax-parser`'s `SAXParser` extends `Transform` from `node:stream`,
which browsers lack. Its `ParserFeedbackSimulator` is the part that `SAXParser` wraps; the Vite
alias `parse5-sax-parser/feedback` (in `vite.config.ts` `resolve.alias`, for the build and vitest)
points at the package's `dist/parser-feedback-simulator.js`, which imports only `parse5`.
`feedback.d.ts` declares its type. The package is pinned exactly (8.0.1), and `unit:find-iframes`
checks on every input that the simulator's tokens equal `SAXParser`'s and that the aliased file
imports no `node:` module.

### Import conversion (`importText.ts`, T24 §5.4, T24-016, VIZ-056)

`convertImportedText(content, mode, appOrigin)` turns the iframes of an imported Text panel into
links. With `mode: 'code'` it returns the content unchanged with no notes. Otherwise:

1. One `commonmark` parse (the input is never altered). `findIframes` runs on each `html_block`
   literal (line = block start + hit line − 1) and once per leaf block (paragraph or heading) on its
   `html_inline` literals joined in order, so `<script>` + `'<iframe …>'` + `</script>` stays raw
   text (line = the leaf's start).
2. Each iframe whose `src` classifies as `local` or `external` gives the link
   `markdownLink(embeddedLinkLabel(host), href)`, label "Open embedded page (‹host›)", and the note
   `iframeToLink {line, host}`; any other gives `iframeNoLink {line}`. The notes are sorted by line,
   then `htmlNotRendered {count}` follows if there was any HTML (count = `html_block` +
   `html_inline` nodes).
3. The links of one top-level block (the `document` child holding the iframe) are joined with
   spaces and inserted just after the line terminator of the block's last line: a blank line, the
   links, a line end, and one more line end if the next line is not blank; at the end of input
   without a final terminator, a line end first. Lines split on `\r\n`, `\n` or `\r`, as commonmark
   does; after a lone `\r` the inserted line ends are `\r`, because a `\n` there would join it as one
   CRLF terminator and put the links inside the block.
4. `markdownLink(label, href)` escapes every ASCII punctuation character of the label with `\` and
   writes the destination as `<…>` with `&` → `&amp;` first, then `<`, `>` and `\` escaped.
5. If the result is over 65 536 UTF-8 bytes, the result is
   `{ok: false, reason: 'sizeLimit', links: n}`, with n the number of `iframeToLink` notes.

**Append-only.** The iframe HTML stays (the renderer drops it). The result's `inserted` is
`[{offset, text}]` in ascending offset order, offsets being UTF-16 indices in the input: removing the
entries in that order, each at its offset, gives the input back byte for byte.

**Report and errors.** `importNoteMessage(note)` is the report line, holding at most a host:

| Note | Message (en-GB) |
|---|---|
| `iframeToLink` | "Line ‹line›: the embedded page from ‹host› became a link." |
| `iframeNoLink` | "Line ‹line›: an embedded page without a usable address isn't shown." |
| `htmlNotRendered` | "HTML isn't shown (‹count› elements)." |

On `sizeLimit` the importer leaves that panel out, imports the rest and adds a `TextImportError`
`{kind: 'textTooLargeForLinks', panelIndex, sourceId?, links}` (`sourceId` only if the source id is
an integer). `textImportErrorMessage` gives "Text panel #‹index› (id ‹id›) is too large to add
embedded-page links (‹n› links). Shorten or split it in the source and import again.", without the
id part when there is none. No content, title or URL is copied into either; the source file is the
copy.

### Lint rules

The `security` ESLint plugin (`eslint/security-plugin.ts`) runs in `ci:lint-ts`:

| Rule | Files | Reports |
|---|---|---|
| `security/no-iframe` (`ci:no-iframe`, T08-009) | `src/**`, `e2e/**` | JSX `iframe`, `frame`, `frameset`, `object`, `embed`; `createElement` of one of those names in any case; JSX `srcDoc`; `new DOMParser`; `.createContextualFragment(` |
| `security/markdown-boundary` (ADR-0024) | `src/**` | `commonmark` outside `src/security/sanitise/`; `parse5` or `parse5-sax-parser/feedback` outside `findIframes.ts` (and its `feedback.d.ts`) and the sanitise tests; commonmark's `HtmlRenderer` or `XmlRenderer`; `minimist`; the bare `parse5-sax-parser` outside `findIframes.test.ts` |

The rule names are the plugin's own, so no `no-restricted-*` block overrides them. The one
exception in the tree is a reasoned disable in `src/test/labelInName.test.ts`, which parses static
markup in jsdom.

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
| `unit:classify-url`, `unit:well-formed` | `src/security/sanitise/url.test.ts`: the T24 §10 strings, other schemes, look-alikes, controls, credentials, lone surrogates in paths and hosts; nothing throws |
| `unit:find-iframes` | `src/security/sanitise/findIframes.test.ts`: the T24 §10 inputs, `<svg><style>`, upper case; the simulator's tokens equal `SAXParser`'s on every input; the aliased file imports no `node:` module |
| `unit:import-text-iframe` | `src/security/sanitise/importText.test.ts` with `api/fixtures/import/text-iframe.json`: f1, f3–f10 (T24 §10), f11 (f1 with CRLF and CR line ends), f12 (a list item and a block quote, each followed by a paragraph); exact `inserted` and notes, the inverse, the re-parsed link destinations |
| `unit:import-size-error` | same: a 65 500-byte panel over the limit; the error and messages hold no content |
| `unit:security-lint` | `scripts/security-plugin.test.ts`: each rule case, the allowed cases, and the full config applying both rules |

## Designs

- [T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md): T24-002 (widgets are
  furniture), T24-003 (widget spec), §5.0 and §5.1 (the widgets version), T24-020 to T24-026 and
  T24-028 (list widgets, the board list's sources, rows, ranking, snapshot and meter, keys, table,
  CSV, facts and import), T24-029 (old servers), §4.6 and §5.5 to §5.7 (the board-list version and
  modules), §11 (the parts); Part 2a: T24-005 (URL classification), T24-006 (`findIframes`),
  T24-016 and §5.4 (import), §5.2.
- [T18](../../designs/technical/T18-security.md): T18-011 (URL scheme allowlist).
- [T08](../../designs/technical/T08-dom-component-kit.md): T08-009 (`ci:no-iframe`).
- [ADR-0024](../../designs/adr/0024-markdown-runtime-dependencies.md) (the Markdown dependencies).
- [05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md): VIZ-053
  (staged), VIZ-057, VIZ-027, VIZ-060, VIZ-065, VIZ-066, VIZ-056 (import, unit level).
- [T11](../../designs/technical/T11-postgres-schema.md): T11-015, T11-016 (the v4 → v5 and v5 → v6
  identity upcasts).
- [ADR-0014](../../designs/adr/0014-typescript-react-web-client.md),
  [ADR-0015](../../designs/adr/0015-go-bff.md).
