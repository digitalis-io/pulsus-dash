# Widgets

A widget is board furniture: a panel without a query (T24-002). Board spec v5 (#198 Part 1) adds
the first two kinds, **Text** (Markdown or code) and **Clock** (the time in up to 12 zones, with an
optional countdown); board spec v6 (#216 Part 1) adds the **Board list**
([below](#board-list-in-progress)). This page covers what the client does with them in this version: the panel
union, the option defaults, the widget frame and the validation. The spec itself, with every key
and error, is on [the boards API page](../server/boards-api.md#widgets-text-and-clock-v5); the
user's view is [Boards](../user/boards.md#widgets).

**Coming later.** This version draws the **Text** widget, adds it from "Add widget" and edits it
in the widget editor (#198 Part 3a, [below](#text-widget-part-3a)); the other kinds still show
"This widget isn't available in this version yet." #198 Part 2a added the sanitiser's URL
classifier, iframe finder and import conversion ([below](#sanitiser-modules-part-2a)) and Part 2b
the Markdown renderer ([below](#markdown-renderer-part-2b)), which the Text widget now uses. Part
3b added the widget gallery, the browser tests (the whole XSS corpus in three engines) and the
render bench ([below](#text-browser-tests-part-3b)). The Clock view follows with A2; the Board list
view, editor and states with #216 Part 2.

| Module | Role |
|---|---|
| `src/api/types.ts` | `PanelSpec = DataPanelSpec \| WidgetPanelSpec`, `WidgetKind`, `DataVisKind`, `CodeLanguage`, `ClockZone`, `ClockCountdown` |
| `src/widgets/spec.ts` | `WIDGET_KINDS`, `PENDING_WIDGETS`, `isWidgetKind`, `isWidgetPanel`, `isDataPanel`, `textOptions`, `clockOptions` |
| `src/widgets/WidgetBody.tsx` | the widget's body: a Text's `TextBody`, else "not available" for a pending kind |
| `src/pages/board/WidgetFrame.tsx` | the widget's panel chrome on a board |
| `src/widgets/registry.tsx` | `WidgetDef`, `WidgetRegistry`, `WIDGETS`, `TEXT_DEF`, `WidgetRegistryContext`, `useWidgetDef` (Part 3a) |
| `src/widgets/text/TextBody.tsx` | `TextBody`, `textVars`, `loadTextMarkdown`: the Text view in the board route's chunk (Part 3a) |
| `src/widgets/text/TextMarkdown.tsx` | `TextContent`, `TextRemovals`: the one dynamic entry that imports the renderer (Part 3a) |
| `src/widgets/text/ChunkBoundary.tsx`, `TextEditorBody.tsx`, `textVis.ts`, `Text.module.css` | the entry's error boundary, the editor body, the vis writer and the styles (Part 3a) |
| `src/pages/board/WidgetEditor.tsx`, `AddWidgetMenu.tsx` | the widget editor dialog and the "Add widget" menu (Part 3a) |
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
  PanelHeader: <h3> title · Panel menu [Edit panel (kinds with a def), Duplicate, Remove] · Move or resize (Edit mode)
  <WidgetBody>: text → TextBody (named by the <h3>); a PENDING_WIDGETS kind → EmptyState "This widget isn't available in this version yet."
```

A widget has no run, viewport tracking, `ChartFrame`, Inspector, Open in Explore, Copy query or
Full screen (T24-002). In Edit mode its header is the drag handle and Move or resize works as for
any panel; Duplicate and Remove are the panel menu's ([the panel menu](boards.md#the-panel-menu)).
A selected widget never opens the panel editor: `BoardPage` opens that only for a data panel. A
selected widget whose kind has a registry def opens the widget editor
([below](#the-widget-editor)); one without (Clock, Board list) opens none, so a save that the
server refuses at its pointer selects it (`data-selected`) without a dialog.

`PENDING_WIDGETS` (`clock` until A2, `boardList` until #216 Part 2) lists the kinds drawn as "not
available yet"; a kind leaves it when its view ships (Text left it with Part 3a). The en-GB text is
`widget.kindUnavailable`.

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

## Text widget (Part 3a)

A Text panel's body is `TextBody` (`src/widgets/text/TextBody.tsx`), in the board route's chunk.
It validates the panel first and loads the Markdown code only when there is content to render.

### The region and its states

`TextBody` always draws one named region, whatever its state:

```text
<div role="region" {aria-labelledby=<the frame's h3> | aria-label="Preview: ‹title or Text›"}
     tabIndex={overflows ? 0 : undefined} data-text-body data-text-state=empty|invalid|loading|error|content>
  <div data-text-measure>  … the state's content …  </div>
</div>
```

On a board the region is named by the frame's heading (`RegionName` `{labelledBy}`); in the
editor's preview by `widget.text.previewLabel`, "Preview: Runbook", or "Preview: Text" for an
untitled panel (`{label}`). The state is decided in this order on every render:

| # | `data-text-state` | When | Shows |
|---|---|---|---|
| 1 | `invalid` | `widgetVisErrors(panel)` is not empty | Board: "This text can't be shown: ‹reason›". Preview: "Preview unavailable: ‹reason›" in a `role="status"` paragraph that the region's `aria-describedby` points at. The reason is the first error's `fieldMessage`. Nothing is rendered and the chunk is not loaded (T24-014) |
| 2 | `empty` | `content.trim() === ''` | `EmptyState` "This text panel is empty", or "Write Markdown" in Edit mode and in the preview. No chunk load |
| 3 | `loading` | the lazy entry is pending | "Loading", `aria-busy` |
| 4 | `error` | the entry failed to load (`ChunkBoundary`) | "This text couldn't be shown. Reload the page." There is no retry: React keeps the rejected lazy component |
| 5 | `content` | otherwise | `TextContent`: the Markdown (or the code) |

`widgetVisErrors(panel)` (`src/boards/spec.ts`) runs `checkBoardSpec` on a one-panel probe board
holding the panel at grid {0, 0, 6, 6} and keeps the errors under `/vis`, with pointers relative
to the panel (`/vis/options/content`). These are the same rules a save runs, in the same order, so
a draft the save would refuse (a 65 537-byte content, a language in Markdown mode, a mode the
board list uses) is never rendered.

The `loading`, `error` and `content` states are reported by a small `Phase` component inside the
Suspense fallback, the boundary's fallback and the content, from a layout effect, so the region's
attribute is right before paint.

### Overflow and the tab stop (T24-009, T24-017)

The region scrolls its own content. It is a tab stop (`tabIndex=0`) exactly while
`region.scrollHeight > region.clientHeight`: any vertical overflow, a single pixel included.
`measure()` computes this and sets state only on a change. It runs from one `ResizeObserver`
watching both the region and `[data-text-measure]`, and from a layout effect after every commit
whose state, deferred options or deferred variables changed. A content change therefore updates the
tab stop even when the region's own size does not change.

### The lazy entry and the module rules

`loadTextMarkdown()` imports `src/widgets/text/TextMarkdown.tsx`, the only module that imports the
renderer (`security/sanitise/markdown.tsx`). Behind it sit commonmark, parse5, `parse5-sax-parser`,
`entities` and `mdurl`. `TextBody` imports no sanitiser module except types. The editor's removal
list (`TextRemovals`) is loaded through the same entry.

| Export | Does |
|---|---|
| `TextContent({panelId, options, vars})` | Markdown: `renderMarkdown(content, {vars, entity: null}, {policy: 'board', appOrigin: location.origin})`, then `logRemovals(panelId, removals)` in an effect. Code: `renderCode(content, language)` |
| `TextRemovals({options, vars})` | The same call (a memo hit), as the `removalMessage` lines under "Not shown in the panel"; `null` in code mode or without removals |

`ci:dep-audit` fails the build if any Markdown module reaches the board route's static closure
([the module rules](supply-chain.md#markdown)). `ci:bundle-size` requires the entry as a dynamic
entry and keeps its chunk under the 120 KB lazy-chunk budget.

### Variables (T24-008) and M0

A Markdown-mode Text's `$name` and `${name}` references join the board's variables after the data
panels' ones (`boardVariables`, [the panel runtime](boards.md#text-widgets-and-the-widget-registry-198-part-3a)),
so the filter bar offers them. Code mode references none, and neither do the other widgets.

`textVars(all, options)` passes the renderer only the set variables that the content references,
in name order (`panelVars`). Equal entries give the same map (a 64-entry memo), so a change to an
unrelated variable neither changes the renderer's memo key nor renders `TextContent` (it is
`memo`ised). An unset reference renders as written and records an `unresolved` removal.

M0: the options and the variables reach `TextContent` through `useDeferredValue`. An input in the
editor commits first and the Markdown renders in a transition, while the previous output stays.
The render's cost is measured by `bench:text-widget-render`, with the M1 and M2 rungs
([below](#render-measures-and-the-bench)).

### Look (T24-015)

Inter at `--font-size-md`, a `--space-5` line height and `--space-4` padding; code in `--font-mono`.
These are the Compact metrics until VL-013. Headings start at `<h4>` under the frame's `<h3>`
(T24-009). There is no motion.

### The widget editor

Edit panel on a widget whose kind has a def opens `WidgetEditor` (`src/pages/board/WidgetEditor.tsx`):
the panel editor's window (kit `ModalDialog`, size `editor`) titled by the def (`widget.text.editTitle`,
"Edit text panel"). It holds Title, the def's editor body, then Remove panel, the mirrored save
status and Done. Every change goes to the draft at once (`updateWidget`). When the dialog closes,
focus goes to the panel's menu (`focusAfterEditor`); after Remove panel it goes to Add panel.

The Text body (`TextEditorBody`):

| Field | Behaviour |
|---|---|
| Preview | `TextBody` with the draft, `context: 'preview'`, `editing: true` |
| Format | `SegmentedControl` Markdown / Code. Markdown drops `language`; Code starts at Plain text |
| Language | `Select` of the eight languages, in code mode only. Its error is the live `widgetVisErrors` one at `/vis/options/language`, else the last save's |
| Content | kit `TextArea`, mono, 12 rows. Its error is the live one at `/vis/options/content` (for example "Use at most 65 536 bytes."), else the last save's; the same text is the preview's reason |
| Not shown in the panel | the lazy `TextRemovals`, only while the preview can render content. Each line names a kind and a line, never content (T24-007) |

Each change writes the vis through `textVis(options, original)` (`src/widgets/text/textVis.ts`),
where `original` is the head's vis of the panel. It keeps the head's stored representation: a key
that `original.options` lacks and whose value is its default (mode `markdown`, content `''`,
language `plaintext`) is left out, and `options` is left out when the head had none. Typing an edit
back therefore leaves the draft clean, so Save is disabled again (the app has no Undo, SRF-020).

### The registry and its context

`src/widgets/registry.tsx` lists the kinds the board can add and edit:

```ts
interface WidgetDef {
  kind: WidgetKind; label: MessageId; editTitle: MessageId;
  size: { w: number; h: number }; newVis(): WidgetPanelSpec['vis'];
  Editor: ComponentType<WidgetEditorBodyProps>; // {panel, title, pointer, fields, readOnly, original, onVis}
}
const WIDGETS: WidgetRegistry = { defs: [TEXT_DEF] }; // order = menu order
```

`TEXT_DEF` adds a 6 × 6 panel with `{kind: 'text', options: {mode: 'markdown', content: ''}}`.
The board reads the registry from `WidgetRegistryContext` (default `WIDGETS`):
- "Add widget" lists `defs` by label and dispatches `addWidget(def.newVis(), def.size)`;
- a widget's panel menu has Edit panel iff `useWidgetDef(kind)` finds a def;
- `BoardPage` opens `WidgetEditor` with the def's `Editor` for a selected widget that has one.

To add a kind (the Board list in #216 Part 2): write its editor body against
`WidgetEditorBodyProps`, add a def with its label, title, size and `newVis`, and append it to
`WIDGETS.defs`. No reducer or page change is needed. A test can provide another registry through
the context, as `unit:widget-registry-generic` does with a test-only kind.

## Text: browser tests (Part 3b)

#198 Part 3b runs the Text widget in Chromium, Firefox and WebKit: the T24 §10 rows, the whole XSS
corpus on real boards under the production CSP and Trusted Types, the gallery goldens and the
render bench.

| Module | Role |
|---|---|
| `src/dev/WidgetGalleryPage.tsx`, `widgetGallery.ts` | the widget gallery, `/t/<tenant>/dev/widgets?page=…` (dev and stub builds only) |
| `e2e/widgets.spec.ts` | `e2e:widget-text`, `e2e:widget-text-xss` (a, b, c), `e2e:widget-a11y` (Text) |
| `e2e/widget-gallery.spec.ts` | `golden:widget-gallery` (the Text pages) |
| `e2e/perf-text-render.spec.ts` | `bench:text-widget-render` |
| `e2e/loadWatch.ts` | the request and violation watch of a browser context |
| `e2e/xssCases.ts`, `scripts/gen-xss-e2e-cases.ts`, `e2e/fixtures/xss-e2e-cases.json` | the browser run's case list, its generator and the committed list |
| `e2e/fixtures/board-load-baseline.{chromium,firefox,webkit}.json` | the committed load baselines |

### The widget gallery

`dev/widgets` is routed like the chart gallery: only when `import.meta.env.DEV` or `VITE_API_MODE
!== 'http'`, so http builds have no route and no chunk. The board variable `env` is `prod`. An
unknown or missing `page` shows `widget-text`.

| `page` | Shows |
|---|---|
| `widget-text` | three Text panels through the board's `WidgetBody`: a 2 KiB runbook in Markdown (`RUNBOOK`: headings, lists, a quote, code, local and `mailto:` links), a PromQL code panel and an empty panel |
| `widget-text-removals` | the registry's Text editor body (`TextEditorBody`) on content with one removal of each kind: an HTML block, inline HTML, an iframe, a `javascript:` link, an image under `/api` (counted as external, T24-018), `$missing` and a 31-deep quote, so "Not shown in the panel" lists 7 lines |

`TextContent` wraps its output in `<div data-text-content>`, and the removal list carries
`data-text-removals`; the tests wait for and read these.

The gallery's content has no absolute URL, since the build's origin check
([supply chain](supply-chain.md)) allows none in app code. The page takes `WidgetBody`, `WIDGETS`
and `BoardRunContext` from the board route's chunk, which re-exports them, and loads that chunk
lazily. Importing them statically would make the gallery's chunk one more importer of the board's
modules: the bundler then splits the stub build's shared initial chunks differently, which added
about 2.7 KB brotli to its initial JS and broke the 200 KB budget.

### The load watch (`e2e/loadWatch.ts`)

`openWatched(browser, project)` opens a fresh context on the http-mode BFF with
`serviceWorkers: 'block'`, so the HTTP cache, storage and permissions are new for each case. It
fixes `Date.now()` at the suite's time (so a time-stamped request keeps one key) and adds:

- an init script that reports every `securitypolicyviolation` (`csp`, with the effective directive
  and the blocked URI) and replaces `ServiceWorkerContainer.prototype.register` with an `sw`
  finding and a rejection;
- a console listener: a message about the Content Security Policy or Trusted Types is a `console`
  finding; a page error is a `pageerror` finding;
- a route on every request.

The route runs in one of three modes:

| Mode | Set by | A request |
|---|---|---|
| idle | (start) | continues, unjudged |
| recording | `record()` … `stopRecording()` | continues and counts against its key; `stopRecording()` returns the key → count map |
| judged | `begin(baseline, images)` | an `image` whose path is in `images` is answered once with a 1×1 PNG (`Cache-Control: no-store`), and a second one is a finding, aborted; any other request continues while its key's count is within `baseline[key]`, and past it is a finding, aborted |

A key is `${method} ${resourceType} ${path}`. The path keeps its query, except a document's. A
board uid after `board/`, `boards/` or `recent-boards/` becomes `{uid}`, and a built asset's hash
becomes `{hash}` (`/assets/index-{hash}.js`), so a baseline names chunks, not one build. Preloads
are ordinary requests. Not judged: `/favicon.ico`, and `POST /api/dash/v1/csp-report`, the
browser's own report of a violation that is already a `csp` finding (Firefox sends it as `fetch`,
WebKit as `ping`).

| Call | Does |
|---|---|
| `consumeTrustedTypesCanary(act)` | runs `act`, waits up to 2 s for its violation, then removes exactly one `require-trusted-types-for` `csp` finding and one Trusted Types `console` finding raised during it; returns false, removing nothing, unless there is exactly one of each |
| `settle()` | the observation window: it ends after 1 000 ms without a request once 2 000 ms have passed, and at 10 s at the latest; then each image path never requested is an `imageMissing` finding |
| `closeWatched(w)` | navigates to `about:blank` (the page's `pagehide` and `unload` requests pass the route while it is attached), closes the page with `runBeforeUnload`, then the context; the watch judges until the context's `close` event |
| `add(f)`, `findings()`, `assertClean()` | a test's own `setup` finding (a failed board `POST`, a navigation that does not reach `[data-shell-ready]` and `[data-text-content]`); the list; throws with every finding |

### The case list and the baselines

`npm run gen:xss-e2e-cases` writes `e2e/fixtures/xss-e2e-cases.json` from the committed
`xss-corpus.json`, without the renderer (it never imports `url.ts` or `markdown.tsx`):

- `digest`: SHA-256 of `JSON.stringify([src, vars, entity])`, so an id cannot keep its entry when
  its input changes;
- `skip`: `entity` (a board has no entity), `varNotUrlSafe` (a value `checkParamValue` refuses, so
  no `var-` parameter carries it) or `nul` (a source with U+0000, which the server refuses);
  otherwise `null`. Today 308 of the 335 cases run (24 `entity`, 3 `nul`);
- `images`: the request paths of the case's `<img>` elements, from its parse tree under `board`:
  not in alt text, not in a flat block (the Part 2b costs), `checkImgSrc` true after the case's
  variables are interpolated (`encodeURIComponent`), then `new URL(dest, origin)`'s pathname and
  search, deduplicated in document order.

`-- --check` compares and prints the differences by id (`compareCases`); `unit:xss-e2e-cases` runs
it. After a corpus change, regenerate and review the diff.

The baseline is recorded once per browser from a **twin** board: one Text panel at {0, 0, 12, 8}
holding `x [x](/b)`, opened with `var-env=prod`. The link is there so the new-tab glyph's icon (a
kit `Icon` mask image) is in the baseline, as every rendered link loads it. The recorded map must
equal `e2e/fixtures/board-load-baseline.<project>.json`, key by key and count by count; a change
fails until reviewed. `BASELINE_UPDATE=1` rewrites the three maps from the twin (run the corpus test
in each browser), and the diff is reviewed in the PR.

### The corpus run and the canaries

`e2e:widget-text-xss` (b) checks that the committed list is the generated one and has one entry
per corpus case, that the twin's map is the baseline, then runs every eligible case, three at a
time, each in its own context on its own one-panel board (deleted afterwards):

```text
POST board(c.src) → openWatched → begin(baseline, c.images) → open with c's var- params
→ [data-text-content] → checks → Trusted Types canary → settle → closeWatched → no finding
```

| Check | Rule |
|---|---|
| DOM | `[data-text-content]`'s `innerHTML` through `parse5.parseFragment` passes `checkInvariants(root, 'board')`; the Markdown module's production class names are read from the chunk's stylesheet first, so the flat span and the hidden text are recognised |
| Images | the rendered `<img>` paths equal the case's `images`, as sets |
| Elements | no `iframe`, `script`, `object`, `embed`, `frame`, `base`, `link`, `meta` or `form` in `[data-panel]` |
| Script | `window.__xss` is undefined; `alert`, `confirm` and `prompt` are wrapped to set it |
| Document | the navigation's `Content-Security-Policy` equals `CSP` from `config/headers.ts` exactly |
| Trusted Types | `typeof trustedTypes === 'object'` (all three engines have it), an `innerHTML` write of a string throws a `TypeError`, and `consumeTrustedTypesCanary` returns true |

The canaries (c) each give exactly their findings, and `assertClean()` throws:

| # | Board, armed with | Action | Findings |
|---|---|---|---|
| c1 | `![a](/l.svg)`, `[]` | — | `request GET image /l.svg` |
| c2 | `![a](/a.svg) ![b](/l.svg)`, `['/a.svg']` | — | `request GET image /l.svg` |
| c3 | `![a](/a.svg)`, `['/a.svg']` | a second `new Image().src = '/a.svg'` | `request GET image /a.svg` |
| c4 | `![a](/a.svg)`, `['/a.svg', '/z.svg']` | — | `imageMissing /z.svg` |
| c5 | `x`, baseline | `fetch` of the board's own API path | `request GET fetch /api/dash/v1/boards/{uid}` |
| c6 | same | `fetch('/api/dash/v1/boards')` | that key |
| c7 | same | a stylesheet link and a `FontFace` load | the stylesheet and font keys |
| c8 | same (Firefox) | `sendBeacon('/__beacon')` on `pagehide`, then `closeWatched` | `request POST beacon /__beacon` |
| c9 | same | `fetch('/__late')` 800 ms after ready | `request GET fetch /__late` |
| c10 | same | `navigator.serviceWorker.register('/sw.js')` | `sw /sw.js` |
| c11 | same | an external `.test` image | `csp img-src` and its `console` line |
| c12 | same | two sink writes in one `consumeTrustedTypesCanary` | it returns false; both `csp` and both `console` findings stay |

c13 (a baseline with one count changed) and c14 (a changed source under the same id) are in
`unit:xss-e2e-cases`.

**Limit.** Chromium and WebKit send an unload-time beacon outside the page's network stack, so no
route sees it; c8 runs in Firefox only. A beacon sent while the page lives is seen in all three
(as `ping` in Chromium, `beacon` in Firefox and WebKit).

### Render measures and the bench

In stub and dev builds `TextMarkdown` leaves a `markdown:render:<bucket>` measure for each render
that misses the renderer's memo: `le4k`, `le16k` or `le64k` by the content's UTF-8 bytes. The
condition is `import.meta.env.VITE_API_MODE !== 'http'`, so http builds compile it away.

`bench:text-widget-render` (Chromium, the production stub build) seeds board P into the stub
through `localStorage['pulsus-dash.stub.boards']` ([the stub hooks](../../client/src/api/StubApi.ts)):
4 copies of `RUNBOOK`, a 16 KiB and a 64 KiB `benchInput` (64 bytes short of each, so the typed
characters keep them in their buckets and within the content limit), each with an `Env $env` line.

| Step | Action |
|---|---|
| `open` | a new context, the board, until the 6 panels show content |
| `var` | 5 filter-bar changes of `env`, each to a new value, so every render misses |
| `type16`, `type64` | 10 characters in the 16 KiB panel's editor, 5 in the 64 KiB one's |

Per step it reports the render p50, p95 and max per bucket, the main-thread tasks over 16 ms (wall
and thread) between the step's marks, and the click or keydown `EventLatency` p95, on stdout and in
`test-results/text-render.json`. It is report-only; `LONG_TASK_GATE=enforce` fails when `le4k` or
`le16k` renders have a p95 over 16 ms, when a step without a 64 KiB render has a task over 16 ms,
or when `le64k` renders have a p95 over 16 ms.

Measured on #198 Part 3b (ms; Chromium in the pinned e2e container on a shared 16-core
workstation at a load average of 7 to 11, not the reference lab). The four runbook copies share
one memo entry, so `open` measures one `le4k` render:

| Step | `le4k` p50 / p95 (n) | `le16k` p50 / p95 (n) | `le64k` p50 / p95 (n) | Tasks over 16 ms (worst) | Event latency p95 |
|---|---|---|---|---|---|
| `open` | 6.8 / 6.8 (1) | 11.5 / 11.5 (1) | 19.0 / 19.0 (1) | 9 (104.4 ms) | — |
| `var` | 0.6 / 2.2 (5) | 4.0 / 13.9 (5) | 16.4 / 18.4 (5) | 64 (67.1 ms) | 111.4 ms (click) |
| `type16` | — | 2.8 / 9.5 (10) | — | 43 (78.5 ms) | 81.0 ms (keydown) |
| `type64` | — | — | 10.8 / 35.6 (5) | 41 (117.0 ms) | 70.3 ms (keydown) |

Both triggers fire: the `le64k` render p95 is over 16 ms in every step (M1), and `type16` has
tasks up to 78.5 ms while its `le16k` render p95 is 9.5 ms (M2). The bench is report-only, so
these are follow-up issues, not failures.

If the bench misses, a follow-up issue takes the rung:

| Rung | Trigger | Design |
|---|---|---|
| M0 (Part 3a, shipped) | — | deferred values, the narrowed variables key, one memoised `TextContent` per panel |
| M1 | `le64k` or `le16k` render p95 > 16 ms | content over 8 KiB is parsed and walked in a module worker inside the Markdown chunk; `renderMarkdown` splits into `planMarkdown` (serialisable records and removals) and `planToReact`; the key is unchanged and the previous output stays until the result arrives |
| M2 | a commit task over 16 ms while the render p95 is within 16 ms | the top-level blocks commit in slices of at most 200 elements per frame, in a transition |

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
| `security/no-iframe` (`ci:no-iframe`, T08-009) | `src/**`, `e2e/**` | JSX `iframe`, `frame`, `frameset`, `object`, `embed`; `createElement` of one of those names in any case; JSX `srcDoc`, a `srcdoc` assignment or `setAttribute('srcdoc')`; `new DOMParser`, also member-qualified (`new window.DOMParser`); `.createContextualFragment(`. A static computed key (`document['createElement']('iframe')`) counts as the plain name |
| `security/no-html-sink` (T18-004) | `src/**`, `e2e/**` | `innerHTML` and `outerHTML` assignments; `insertAdjacentHTML`, `setHTMLUnsafe` and `parseHTMLUnsafe` calls (`el.setHTMLUnsafe(`, `Document.parseHTMLUnsafe(`, bare calls); `Reflect.set(x, k, …)` and `Object.assign(x, {k: …})` with a literal `innerHTML`, `outerHTML` or `srcdoc` key; names and static computed keys (`el['innerHTML'] = …`) alike. The plain assignments are also in `bannedSyntax` |
| `security/markdown-boundary` (ADR-0024) | `src/**` | `commonmark` outside `src/security/sanitise/`; `parse5` or `parse5-sax-parser/feedback` outside `findIframes.ts` (and its `feedback.d.ts`) and the sanitise tests; commonmark's `HtmlRenderer` or `XmlRenderer`; `minimist`; the bare `parse5-sax-parser` outside `findIframes.test.ts` |

The rule names are the plugin's own, so no `no-restricted-*` block overrides them. These rules are a
backstop for literal spellings only. Keys or names computed at run time, arbitrary aliasing (a sink
method stored in a variable, or an element reached through another name) and a detached or bound
`createContextualFragment` are out of their scope. The primary defence is the renderer's design: it
builds React elements from the parsed tree and has no HTML string sink (T24-004). The one
exception in the tree is a reasoned disable in `src/test/labelInName.test.ts`, which parses static
markup in jsdom.

## Markdown renderer (Part 2b)

`src/security/sanitise/markdown.tsx` is the one Markdown renderer (T24-004). Text widgets (Part 3),
table cells, feeds, tooltips and AI output use it. No page imports it yet.

```ts
renderMarkdown(src, { vars, entity }, { policy, appOrigin, headingOffset? }): { node, removals }
renderCode(src, language)           // <pre><code data-lang={language}>{src}</code></pre>, verbatim
logRemovals(panelId, removals)      // one console.debug({panelId, removals}) per distinct non-empty result
removalMessage(removal)             // the editor's line for one removal
sourceLines(src, start, end)        // the source lines start..end, terminators kept
MAX_DEPTH = 32
```

It parses `src` with `commonmark`'s `Parser` and walks the tree into React elements. It has no HTML
string, no Trusted Types policy, and makes no network or DOM call. React escapes every text and
attribute. `renderMarkdown` is pure and never throws. It is memoised in an LRU of 32 entries, keyed
on the source, the entity, the policy, the origin, the heading offset and the sorted variables.

### Nodes

| Node | Output |
|---|---|
| paragraph | `<p>`; in a tight list item, its inlines only |
| heading n | `<h{min(n + headingOffset, 6)}>`; `headingOffset` defaults to 3, so `#` is `<h4>` |
| block quote, list item, thematic break | `<blockquote>`, `<li>`, `<hr>` |
| list | `<ul>`; `<ol>`, with `start = min(start, 999999)` only when it is not 1 |
| code block | `<pre><code>`, with `data-lang` = the info string's first word if it matches `^[a-z0-9-]{1,20}$`; the literal is not interpolated |
| inline code | `<code>`, not interpolated |
| text | the interpolated text |
| soft break, hard break | a space, `<br>` |
| emphasis, strong | `<em>`, `<strong>` |
| link | below |
| image | below |
| HTML block, inline HTML | nothing, plus a removal |
| anything else | nothing, plus `html` |

No title or source-position attribute is copied.

### Links, images and policies

Every destination is interpolated first, then classified with `classifyUrl`
([above](#url-classes-urlts-t24-005-t18-011)).

| Destination | `board` | `ai` |
|---|---|---|
| link, `local` | `<a href target="_blank" rel="noopener noreferrer nofollow">`, the link text, the `square-arrow-out-up-right` glyph and a hidden "(opens in a new tab)" | the same |
| link, `external` | the same | the link text and ` (‹host›)`, no anchor, no removal |
| link, `mailto` | the same | the link text and ` (‹address›)` (the href after `mailto:`, up to `?`) |
| link, `rejected` | the link text, plus `linkScheme` | the same |
| image, `local` | `<img src alt loading="lazy">` | the alt text, plus `image` |
| image, `local` whose decoded path is `/api` or `/auth`, or under them | a new-tab link labelled with the alt text (or the host), plus `image` | the alt text, plus `image` |
| image, `external` | the same new-tab link, plus `image`; inside a kept link the alt text instead | the alt text, plus `image` |
| image, anything else | the alt text, plus `image` | the same |

The `ai` policy never creates an `<img>` or any other element that loads on its own (T24-018). No
external image is loaded until the image proxy ships (T18-014 interim). A `/api` or `/auth` image
counts as external because the server routes on the decoded path. The path is percent-decoded at
the byte level (each `%XX` becomes its byte) for up to three rounds, then compared with `/api`,
`/auth`, `/api/…` and `/auth/…` (ASCII letters in any case). A path that still changes after three
rounds, or whose bytes are not valid UTF-8, counts as a server route too, so `/%61%70%69%2F%FF`,
`/%41PI/%C0`, `/%2561pi/x` and `/auth%2F%FE` are links, while `/apix/y`, `/ap%69.svg` and
`/l%C3%A9.svg` stay images. An image's alt is the text of its
children: links, emphasis and code inside it give their text, and a nested image gives its alt and
records `image`.

### Interpolation (T24-008)

The source, every variable value and the entity first pass `toWellFormed`, so a lone surrogate
becomes U+FFFD.

| Where | Reference | Resolved | Unresolved |
|---|---|---|---|
| text | `$name` or `${name}` | the value, as text | kept literally, plus `unresolved` |
| text | `$__name` (a macro) | kept literally, no removal | — |
| text | `{{entity}}` | the entity | kept literally, plus `unresolved` |
| destination | `$name`, `${name}` (commonmark has already encoded the braces as `%7B`, `%7D`), `{{entity}}` | `encodeURIComponent(value)`, then classified | kept literally, plus `unresolved` |

A run of text siblings is interpolated as one string. A substituted value is never scanned again.
Code is never interpolated. `{{entity}}` will be `useContextEntity()`; it is `null` for now.

### Removals (T24-007)

A removal is `{kind, line}`: `line` is the start line of the nearest block. It never holds text, a
URL or a value. Removals come in document order.

| Kind | When | `removalMessage` (en-GB) |
|---|---|---|
| `html` | an HTML block, or a leaf block's inline HTML (one for all of it), with no iframe | "Line ‹n›: HTML isn't shown." |
| `iframe` | the same, when `findIframes` finds an iframe in the block's HTML, or in the leaf's inline HTML joined | "Embedded page not shown (line ‹n›): add a link." |
| `linkScheme` | a rejected link | "Line ‹n›: a link with an unsupported address is shown as text." |
| `image` | an image not shown as `<img>` | "Line ‹n›: an image isn't loaded." |
| `unresolved` | each unresolved reference | "Line ‹n›: a variable has no value." |
| `depth` | a block shown as source lines | "Line ‹n›: deeply nested content is shown as plain text." |

`logRemovals` remembers a 64-bit digest of each panel's last result (16 characters, whatever the
list's length) for at most 512 panels, the oldest evicted first. It logs only when a panel's result
changes and is not empty. A panel that was evicted logs its unchanged result once more.

### The walk and the depth limit

The walk is post-order with an explicit stack, so deep input cannot overflow the call stack. Each
frame holds its output list. A finished frame's output goes to its immediate parent: an element
wraps it, while a rejected link, an `ai` non-local link or a tight-list paragraph splices it in.
The root's output is returned as a fragment.

Each node has a **cost**, the number of elements it creates:

| Node | Cost |
|---|---|
| paragraph, heading, block quote, list, item, emphasis, strong, inline code, hard break, thematic break | 1 |
| code block | 2 |
| tight-list paragraph, rejected or `ai` non-local link, HTML | 0 |
| kept link | 2 |
| image | `<img>`: 1; a new-tab link: 2; alt text: 0 |

A leaf block's inlines are pre-scanned, with an iterative post-order of the same stack kind, for the
deepest chain of costs below it. A block at depth `d` with cost `c` and an inline chain `i` is
**flat** when `d + c + i > MAX_DEPTH − 1`. A flat block is shown as
`<span class="flat">` holding `sourceLines(src, start, end)`: the block's whole source lines,
verbatim, terminators included, in one `white-space: pre-wrap` text node. It records one `depth`
removal, and nothing inside it is visited, interpolated or counted. So elements reach depth 31 at
most and a flat span depth 32: the DOM depth below the root is at most `MAX_DEPTH`. An HTML block
renders nothing, so it is never flat itself.

`sourceLines` clamps `start` and `end` to the lines of `src` (an `end` before `start` becomes
`start`) and returns `''` for an empty source. Inline nodes are visited at most twice (pre-scan and
render) and blocks once.

`findIframes` parses only HTML that contains the letters `iframe` in some case: no iframe start tag
is possible without them, so the result is the same.

### The XSS corpus and the checker

The corpus is generated from the parser, not written by hand:

- `src/security/sanitise/xssCorpus.ts` lists the payload groups and templates. S is schemes, H raw
  HTML, B breakouts, V variable and entity values, L image loading, N nested images and links, D
  depth and U Unicode. Each payload × template is one case, with only reserved `.test` hosts.
- `npm run gen:xss-corpus` (`scripts/gen-xss-corpus.ts`) parses every case with the pinned
  commonmark. It writes `src/security/sanitise/__fixtures__/xss-corpus.json`, with each case's parse
  record and its expected shape and removals under both policies.
- The generator derives each expectation from the tree on its own: node types, destinations,
  context (in an alt, in a kept link, flat by the costs above) and `findIframes` hits. It checks
  URLs with the independent checker, never with `classifyUrl` or the renderer.
- `gen-xss-corpus.ts --check` exits 1 when the committed file is stale; `unit:xss-corpus-current`
  runs the same check.

To add a payload: add it to its group in `xssCorpus.ts` and run `npm run gen:xss-corpus`. Read the
new entries in the JSON (the expected `dom` and `removals`), then commit both files.

`src/security/sanitise/urlCheck.ts` is the independent checker. It is used only by tests and
imports neither `url.ts` nor `URL`.

- **R**: strip ASCII whitespace and C0/C1 controls, turn `\` into `/`, and resolve the `.` and `..`
  segments of a `/`-leading path (`%2e` forms included).
- **D**: R, percent-decoded until stable (at most three rounds), lower-cased.

`checkHref` returns `bad` for any scheme in D other than `http`, `https` or `mailto`, and `local`
for an R that starts with one `/`. It returns `external` for `http(s)://` with a non-empty authority
without `@`, and `mailto` for `mailto:`. `checkImgSrc` requires `local`, and then decodes R's path
at the byte level on its own (its own UTF-8 encoder and validator, up to three rounds): a path
outside `/api` and `/auth` that settles within three rounds and is valid UTF-8.

`src/security/sanitise/testInvariants.ts` holds `checkInvariants(tree, policy)`, which lists the
violations of a rendered tree:

- Tags must be in `p`, `h4`–`h6` (`h1`–`h6` with heading offset 0), `blockquote`, `ul`, `ol`, `li`,
  `hr`, `pre`, `code`, `br`, `em`, `strong`, `a`, `img` and `span`.
- Attributes are allowed per element: `a` `href`, `target`, `rel`; `img` `src`, `alt`, `loading`;
  `ol` `start`; `code` `data-lang`; `span` `class`, `aria-hidden`; no other element has any. So
  there is no `on*`, `style` or `srcdoc` anywhere, and no `href` on an `img` or `src` on an `a`.
- Every `a` has `target=_blank`, the three `rel` values and a `checkHref` other than `bad`; under
  `ai`, only `local`.
- `img` appears only under `board` and passes `checkImgSrc`.
- `span` appears only as the glyph, the hidden text, or a flat span holding one text node.
- The depth is at most 32, and every text is well-formed UTF-16.

`shapeOf(tree)` gives the corpus's shape form.

## Tests

| Gate | File |
|---|---|
| `unit:widget-spec` | `src/widgets/spec.test.ts`: the defaults and `isWidgetPanel` per fixture panel |
| `unit:widget-frame` | `src/pages/board/BoardWidgets.test.tsx`: `v5-widgets.json` on a board; five widget sections with their title, no Explore, Full screen or chart; p-1 to p-3 are Text regions (p-3 empty), the clocks show the unavailable text; the menus (Text: Edit panel, Duplicate, Remove; Clock: Duplicate, Remove); one query (the data panel); the section's Add widget adds into `s-1` and the board saves valid; a selected Text opens the widget editor, not the panel editor; a duplicated widget saves without a query |
| `unit:board-spec-widgets`, `unit:board-spec` (v5 rows) | `src/boards/spec.test.ts`: the v5 fixture and its canonical SHA-256 (the Go suite holds the same), the `w-*` rows of `invalid.json`, the widget limits, `isRfc3339Offset` |
| `unit:board-options` | `src/boards/options.test.ts`: the tables equal `option-keys.json` |
| `unit:board-variables` | `src/boards/variables.test.ts`: a Markdown text's `$region ${env}` joins after the data panels' `env`; code mode and a clock add none |
| `unit:text-widget`, `unit:text-region`, `unit:text-overflow`, `unit:text-invalid`, `unit:text-widget-vars` | `src/widgets/text/TextBody.test.tsx`, each test in a fresh module registry with the entry mocked (counted, pending or rejecting): headings, new-tab links and variables; code verbatim; empty and blank with no chunk load; removals logged once; the load-failed state; every state's region name on the board and in the preview; the tab stop at 50 → 200 → 50 characters, at exactly 101 and 100, on a variable's growth and on a resize; a 65 537-byte or Markdown-language draft never rendered or loaded; `widgetVisErrors` against the `invalid.json` text rows; an unrelated variable renders nothing |
| `unit:text-vis-roundtrip` | `src/widgets/text/textVis.test.ts`; `BoardWidgets.test.tsx`: p-3 (no options) typed and deleted is clean; a later save keeps p-3 canonical |
| `unit:widget-add` | `src/boards/editorState.test.ts`: `addWidget` (top, a collapsed section, a data vis, 200 panels, a full grid) and `updateWidget` (same kind, other kind, no vis, a data panel), both ignored while saving |
| `unit:widget-editor` | `src/pages/board/WidgetEditor.test.tsx`: Content, Code, Markdown again (no `language`), Done to the panel menu and the saved vis; the removal list; a 65 537-byte paste refused under Content and in the preview with no render; Remove panel to Add panel |
| `unit:widget-spec-roundtrip` | `BoardWidgets.test.tsx`: an edit typed back is clean; Discard gives the head; Save sends the fixture with only that change, every other panel byte-equal in canonical JSON; a refetch shows it |
| `unit:widget-registry-generic` | `BoardWidgets.test.tsx`: a context with `TEXT_DEF` and a test-only clock def: the menu, its 4 × 3 `newVis`, its editor's title and checkbox, the saved vis, and Edit panel on the stored clock |
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
| `unit:markdown-links`, `-nodes`, `-depth`, `-root`, `-walk`, `-pathological`, `-flat-lines`, `-inline-depth`, `-iframe`, `-images`, `-interpolate`, `-surrogates`, `unit:removal-redaction` | `src/security/sanitise/markdown.test.tsx`: the T24 §10 inputs and one exact DOM per node row; the depth pairs at the limit and one past it; flat spans holding the whole source lines (CR, CRLF, tabs, astral and lone surrogates); the walk's splicing and removal order; deep, long and unbalanced input in under 2 s with depth ≤ 32; images under both policies; interpolation and surrogates; removals, messages and the log without content |
| `unit:markdown-xss-corpus` | `src/security/sanitise/markdown.corpus.test.tsx`: every corpus case under both policies, rendered with `createRoot` in jsdom: its shape and removals equal the generated ones, it passes `checkInvariants`, and `fetch`, `XMLHttpRequest.prototype.open` and `sendBeacon` are never called; fixtures that `checkInvariants` must fail (`ai` external and mailto anchors among them) |
| `unit:xss-corpus-current` | `scripts/gen-xss-corpus.test.ts`: the committed corpus equals a fresh generation; one changed expectation gives exit 1; the CLI's `--check` exits 0 |
| `fuzz:markdown-nodes` | `src/security/sanitise/markdown.fuzz.test.ts`: 10 000 seeded inputs (mulberry32, seed 20261125) of 1–40 tokens, through `renderToStaticMarkup` and `parse5.parseFragment`, under both policies, then the import inverse, the imported result's invariants and its UTF-8 size against an independent calculation from the T24 §5.4 steps (a `sizeLimit` only above 65 536 bytes; f6 checked on both sides of the limit) |
| `bench:markdown-render` (report-only) | `src/security/sanitise/markdown.bench.test.ts`: 50 distinct 64 KiB inputs, every lookup a memo miss; prints the uncached p95 against the 16 ms budget. Under vitest it measures React's development build, which creates elements several times slower than production |
| `e2e:widget-text` | `e2e/widgets.spec.ts` (three engines, the http-mode BFF): the T24 §10 input through the boards API with `var-env=prod`: `h4` "R", the new-tab link with the three `rel` values, "Env prod", then "Env dev" through the filter bar with no query at the fake; the region named by the title; Add widget → Text → `# Added` → Done → Save → reload shows `h4` "Added" |
| `e2e:widget-text-xss` (a), (b), (c) | same: the T24 row input watched, then its editor removal lines; the corpus run; the canaries ([above](#the-corpus-run-and-the-canaries)) |
| `e2e:widget-a11y` (Text) | same: an overflowing Text with two links and a short one: axe clean (Firefox skips the `label` rule with the editor open, as `e2e:a11y-rooms`), panel menu → region → link 1 → link 2, the short region not tabbable; in the editor the region "Preview: Note" and, for a 65 537-byte content, the "Preview unavailable" status that describes it |
| `golden:widget-gallery` (Text) | `e2e/widget-gallery.spec.ts` (Chromium, 1440 × 1400): `widget-text` and `widget-text-removals` in dark, light and greyscale (CSSOM `grayscale(1)` on dark); a reload gives the same pixels; 6 baselines under `e2e/__screenshots__/widget-gallery.spec.ts/` |
| `unit:xss-e2e-cases` | `scripts/gen-xss-e2e-cases.test.ts`: `--check` in-process and through the CLI, one changed expectation gives 1; c13 and c14; the image extraction rows; one case per skip reason |
| `unit:widget-gallery-route` | `src/app/router.test.tsx`: 3 `[data-text-body]` on `widget-text`, 1 `[data-text-removals]` of 7 lines on `widget-text-removals`, no route in the http build |
| `bench:text-widget-render` (report-only) | `e2e/perf-text-render.spec.ts` ([above](#render-measures-and-the-bench)) |

## Designs

- [T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md): T24-002 (widgets are
  furniture), T24-003 (widget spec), §5.0 and §5.1 (the widgets version), T24-020 to T24-026 and
  T24-028 (list widgets, the board list's sources, rows, ranking, snapshot and meter, keys, table,
  CSV, facts and import), T24-029 (old servers), §4.6 and §5.5 to §5.7 (the board-list version and
  modules), §11 (the parts); Part 2a: T24-005 (URL classification), T24-006 (`findIframes`),
  T24-016 and §5.4 (import), §5.2; Part 2b: T24-004 (one renderer), T24-005 (links), T24-006
  (iframes), T24-007 (removals), T24-008 (interpolation), T24-009 (headings), T24-018 (policies),
  §4.2 (the node table and the walk), §7 (the bench), §10 (the tests); Part 3a: T24-001, T24-002,
  T24-004, T24-007, T24-008 (text variables), T24-009 (the region), T24-014 (validate first, the
  preview), T24-015 (the Compact metrics), T24-017 (the tab stop), §5.2a (the view, the registry
  and the actions); Part 3b: T24-009, T24-014, T24-017 and T24-018 in the browser, §7 (the render
  bench and M0 to M2), §10 (the e2e, golden and unit rows), §11.
- [T05](../../designs/technical/T05-testing-and-performance.md) §7.1: the gate catalogue rows.
- [T18](../../designs/technical/T18-security.md): T18-011 (URL scheme allowlist); Part 2b: T18-005
  (no HTML sink), T18-013, T18-014 (interim: no external image); Part 3b: T18-013 under the
  production CSP and Trusted Types.
- [ADR-0026](../../designs/adr/0026-engine-csp-and-worker-policy.md) (the CSP the
  corpus run checks exactly).
- [T08](../../designs/technical/T08-dom-component-kit.md): T08-009 (`ci:no-iframe`), T08-011 (HTML
  is dropped).
- [ADR-0024](../../designs/adr/0024-markdown-runtime-dependencies.md) (the Markdown dependencies).
- [05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md): VIZ-053
  (the Text row; in the browser from Part 3b), VIZ-057, VIZ-027, VIZ-060, VIZ-065, VIZ-066,
  VIZ-056 (import, unit level; in the browser from Part 3b), VIZ-054 (the renderer; in the browser
  from Part 3b), VIZ-067 and VIZ-069 (the gallery goldens, Part 3b), VIZ-086.
- [T11](../../designs/technical/T11-postgres-schema.md): T11-015, T11-016 (the v4 → v5 and v5 → v6
  identity upcasts).
- [ADR-0014](../../designs/adr/0014-typescript-react-web-client.md),
  [ADR-0015](../../designs/adr/0015-go-bff.md).
