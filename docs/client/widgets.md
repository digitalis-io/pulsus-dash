# Widgets

A widget is board furniture: a panel without a query (T24-002). Board spec v5 (#198 Part 1) adds
the first two kinds, **Text** (Markdown or code) and **Clock** (the time in up to 12 zones, with an
optional countdown). This page covers what the client does with them in this version: the panel
union, the option defaults, the widget frame and the validation. The spec itself, with every key
and error, is on [the boards API page](../server/boards-api.md#widgets-text-and-clock-v5); the
user's view is [Boards](../user/boards.md#widgets).

**Coming later.** This version reads, shows, moves, duplicates, removes and saves widgets, but
draws neither kind: both show "This widget isn't available in this version yet." The Markdown
renderer and the import conversion come with #198 Part 2; the Text view, its editor, adding a
widget and the gallery with #198 Part 3; the Clock view with A2; the Board list widget with #216.
Until Part 3 only boards written through the API have widgets.

| Module | Role |
|---|---|
| `src/api/types.ts` | `PanelSpec = DataPanelSpec \| WidgetPanelSpec`, `WidgetKind`, `DataVisKind`, `CodeLanguage`, `ClockZone`, `ClockCountdown` |
| `src/widgets/spec.ts` | `WIDGET_KINDS`, `PENDING_WIDGETS`, `isWidgetKind`, `isWidgetPanel`, `isDataPanel`, `textOptions`, `clockOptions` |
| `src/widgets/WidgetBody.tsx` | the widget's body |
| `src/pages/board/WidgetFrame.tsx` | the widget's panel chrome on a board |
| `src/boards/spec.ts`, `src/boards/options.ts` | the v5 rules of `checkBoardSpec`; the option tables |

## The panel union

The OpenAPI `Panel` has `query` optional and `vis.kind` any of ten kinds. The client's types
describe only valid specs:

```ts
type WidgetKind = 'text' | 'clock'; // #216 adds 'boardList'
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

`textOptions(o)` and `clockOptions(o)` read a panel's `vis.options` with the T24 §5.1 defaults;
the stored spec keeps only the keys that were set.

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

`PENDING_WIDGETS` (`text` until #198 Part 3, `clock` until A2) lists the kinds drawn as "not
available yet"; a kind leaves it when its view ships. The en-GB text is `widget.kindUnavailable`.

## Validation

`checkBoardSpec` runs the server's v5 rules in the same order, with the same pointers and keys,
and en-GB texts for each (`field.board.…`):

| Key | Text |
|---|---|
| `board.panel.query.forbidden` | A widget has no query. |
| `board.panel.query.required` | Add a query. |
| `board.options.mode.invalid` | Choose Markdown or code. |
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
`date`, `countdown`) equal `api/fixtures/board-spec/option-keys.json`, as the Go tables do.

## Tests

| Gate | File |
|---|---|
| `unit:widget-spec` | `src/widgets/spec.test.ts`: the defaults and `isWidgetPanel` per fixture panel |
| `unit:widget-frame` | `src/pages/board/BoardWidgets.test.tsx`: `v5-widgets.json` on a board; five widget sections with their title and the unavailable text, no Explore, Full screen or chart; the menu; one query (the data panel); a selected widget opens no editor; a duplicated widget saves without a query |
| `unit:board-spec-widgets`, `unit:board-spec` (v5 rows) | `src/boards/spec.test.ts`: the v5 fixture and its canonical SHA-256 (the Go suite holds the same), the `w-*` rows of `invalid.json`, the widget limits, `isRfc3339Offset` |
| `unit:board-options` | `src/boards/options.test.ts`: the tables equal `option-keys.json` |
| `unit:board-variables` | `src/boards/variables.test.ts`: a text widget's `$region` is not a variable |

## Designs

- [T24](../../designs/technical/T24-geo-schematic-and-widget-panels.md): T24-002 (widgets are
  furniture), T24-003 (widget spec), §5.0 and §5.1 (the widgets version), §11 (the parts).
- [05 Visualisation catalogue](../../designs/product/05-visualisation-catalogue.md): VIZ-053
  (staged), VIZ-057.
- [T11](../../designs/technical/T11-postgres-schema.md): T11-015, T11-016 (the v4 → v5 identity
  upcast).
- [ADR-0014](../../designs/adr/0014-typescript-react-web-client.md),
  [ADR-0015](../../designs/adr/0015-go-bff.md).
