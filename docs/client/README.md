# Client application

The web client in `client/`: TypeScript, React and Vite
([ADR-0014](../../designs/adr/0014-typescript-react-web-client.md)), routing on React Router in
data mode ([ADR-0017](../../designs/adr/0017-react-router.md)), accessible components from React Aria
Components, server state in TanStack Query. This page covers the application shell of milestone
M-UI1 (roadmap step 1, issue #57): layout, routes, the time Context, themes and tokens, and the
checks that guard them, and the board list and board page (roadmap step 5, issue #61; how to use
them is in [Boards](../user/boards.md)). Charts (roadmap step 2, issue #58) are in
[Charts](charts.md). Build and CI
are in [Build, test and CI](../development/build-and-ci.md); dependencies in
[JavaScript supply chain](supply-chain.md).

## Run

```sh
cd client
npm ci
npm run dev          # http://localhost:5173, stub API, no backend needed
npm run build && npm run preview   # the production build on http://localhost:4173, production headers
```

In production the BFF serves the client: `make build` embeds an `http`-mode build in the binary
([Serving the client](../server/README.md#serving-the-client)). To develop against a running BFF,
start it with `serve --api-only` (or a full build) and run `VITE_API_MODE=http npm run dev` with
`PULSUS_DASH_DEV_BFF` pointing at it; About then shows the server version.

| Variable | Read by | Values | Default |
|---|---|---|---|
| `VITE_API_MODE` | the client at build and dev time (`createApi()`) | `stub` (in-repo seeded data) or `http` (the BFF client) | `stub` |
| `PULSUS_DASH_DEV_BFF` | `vite.config.ts` (dev server only) | base URL the dev server proxies `/api` and `/auth` to | `http://localhost:8080` |
| `VITE_GIT_SHA` | the About dialog | commit SHA (CI sets it); shown as 12 characters | `dev` |

The proxy target is never logged. In `http` mode the client is `HttpApi` (below).

## Layout (D9, IA-016, IA-021, VL-017)

The shell follows the owner-approved layout of [mockup 35](../../designs/mockups/35-application-shell.svg).
Sizes come from the tokens, at a 1440 × 900 reference:

| Element | Behaviour |
|---|---|
| Skip link | First tab stop, "Skip to main content"; moves focus to `<main id="main">` |
| Sidebar, 240 px (56 px collapsed) | Full height. Top block 56 px, its bottom hairline continuing the header's: product mark (link to Boards) and the org and tenant block. With two or more tenant bindings the tenant name is a menu button (`Switch tenant, current: <name>`) listing the bindings; choosing one opens that tenant's Boards with the current time range (push). With one binding the block is static text. Collapsed: the mark, and a 32 px org-initial menu button when there are two or more bindings |
| Sidebar navigation (`nav` "Main") | Boards; Explore with Metrics and Logs; Starred (the user's starred boards, from the BFF, in title order, empty text "No starred boards", "Could not load starred boards" on failure); Recent (the last five boards the user opened, from the BFF, newest first, empty text "No recent boards", "Could not load recent boards" on failure). Both are per user, the same in every browser and tenant (IA-021), and refetch on every return to the tab. Collapsed: icon links with tooltips; Starred and Recent hidden. The current page is marked with `aria-current="page"` (Boards also on a board page). Links carry the current `from`, `to` and `refresh`, and preload their page on hover and focus |
| Sidebar footer | Admin (administrators only); the data-source line "Data source: `<tenant slug>` · `<state>`" for the current tenant (expanded sidebar only, IA-021; nothing when the tenant has no data-source state): the result of the data-source check, "Connected", "Unreachable", "Not authorised" or "Error", and "Not checked" while it is pending or when it fails (`useQuery` key `['datasource', tenant]`, reused for 60 s, no retry); and "Collapse sidebar" / "Expand sidebar" (`aria-expanded`). There is no keyboard shortcut for the toggle: `[` is the window-step key (INT-032). The state persists in `localStorage` |
| Page header, 56 px | Left: a breadcrumb (`Boards` link on a board, `Explore` text on Explore pages, none elsewhere), the page title `<h1>` (20 px; truncates with an ellipsis, full title in `title`), and on a board the "Star board" toggle. Right, in this order: time range trigger, refresh split control, user menu. No command palette entry until the palette exists |
| Page body | Scrolls; 24 px padding |

The grid is `var(--size-sidebar) minmax(0, 1fr)`, so the content column shrinks instead of
overflowing; the title is the element that gives way.

**Header controls.** The time range trigger shows the range ("Last 1 hour", an absolute range, or
"`<from>` to `<to>`") and, for a relative range at a viewport of at least 1520 px, the absolute
window in mono ("12:03 – 13:03 GMT"). The refresh control is a group "Refresh" of "Refresh now" and
an interval menu button named "Auto-refresh interval: `<label>`" that shows the interval (`Off`,
`10s`, `30s`, `1m`, `5m`, `15m`) and a live dot when it is not off; choosing an interval replaces
the history entry. The user menu (avatar initials, "User menu: `<name>`") shows name, email and
role, then the theme section (Dark, Light, System), "About Pulsus Dash" (version, build, the line
"Server version `<version>`" when the session has a server, and the licence) and "Sign out". Sign
out is shown only when `session.canSignOut` is true: under the BFF's fixed local principal
(decision D12) it is false, so the item is hidden rather than offered as a no-op. Only a confirmed
sign-out clears the query cache and opens `/signed-out`; if the
API rejects it, the session, the cache and the page stay as they were and an alert ("Could not sign
out. You are still signed in.") offers Retry (focused) and Dismiss (focus returns to the user menu).

**Pages.** Boards lists the organisation's boards in a table with New board, Rename and Delete; a
board shows its panels in View or Edit mode and records itself in Recent; an unknown board shows
"Board not found" and "Back to boards" (both: [Boards](#boards) below). Explore › Metrics
and Logs show the Context summary and an empty state. Admin shows the "Data sources" and "Identity"
cards. Not found and Signed out pages have no shell; after Sign out, focus moves to the Signed out
page's content (the menu item that had focus is gone, and some engines would otherwise start the
next Tab outside the page). The Context summary reads "Showing `<window>`
(`<zone>`)" in mono and uses the same `useTimeContext()` as the header, so both always show the same
window (IA-002).

## Routes (ADR-0017)

`src/app/router.tsx` builds code-based route objects (`createRoutes(deps)`) for
`createBrowserRouter` (tests: `createMemoryRouter`). Dependencies (API, query client, clock, time
zone) are passed by closure.

| Path | Loader / component |
|---|---|
| `/` | Loads the session, then `replace()`s to `/t/<defaultTenant>/boards?from=now-1h&to=now&refresh=off` |
| `/signed-out` | Lazy `SignedOutPage` |
| `/t/:tenant` | `AppShell`. Loader: the session; a tenant the user has no binding for → 404 (standalone Not found); a non-canonical search → `replace()` to the canonical one |
| `/t/:tenant` (index) | `replace()` to `/t/:tenant/boards`, keeping the (canonical) search |
| `/t/:tenant/boards`, `board/:uid`, `explore/metrics`, `explore/logs`, `admin` | Lazy pages; `TimeRangeDialog` is lazy too |
| `/t/:tenant/dev/gallery` | Lazy `GalleryPage`, the chart gallery ([Charts](charts.md#the-chart-gallery)). Development and stub builds only (`import.meta.env.DEV` or `VITE_API_MODE` ≠ `http`); no sidebar entry, no breadcrumb, no `routeModules` entry |
| `/t/:tenant/*` | Not found inside the shell |
| `*` | Standalone Not found |

- **`replace()`, not `redirect()`:** loader redirects use `REPLACE`, so normalising a URL adds no
  history entry. In-app writers emit canonical URLs, so they never redirect after a push.
- **Session:** `sessionQuery` has `retry: false`, so a failed session shows the error page at once
  ("Pulsus Dash could not load your session" with **Retry**, the first focusable control). Retry drops
  the cached session and revalidates; on success the shell renders and focus moves to `main`.
  Other queries use the query client defaults (`retry: 1`, `staleTime` 30 s, no refetch on focus),
  except Starred and Recent (`refetchOnWindowFocus: 'always'`, below).
- **Preloading:** `src/app/routeModules.ts` holds the page importers; `preloadRoute(id)` starts one
  (sidebar and board links call it on pointer enter and focus), and the route's `lazy` reports a
  failed load.
- **Query keys:** `['session']`, `['boards', tenant]`, `['board', tenant, uid]`,
  `['starred', tenant]`, `['recent', tenant]`,
  `['panel', tenant, panelId, canonicalJson(query), visKind, window]`. Starred and Recent are the
  same under every tenant, so they are invalidated by the prefixes `['starred']` and `['recent']`;
  after a create, rename, save or delete, `invalidateBoardLists(queryClient)`
  (`src/boards/queries.ts`) invalidates `['boards']`, `['starred']` and `['recent']`, since all three
  show titles;
  `refreshNow()` invalidates `['data']` (the chart queries of later issues); a refresh moves the
  window, so the panel queries follow it.

## Time Context (IA-020, IA-022, IA-023, INT-032, T03-014, T03-017, T08-005)

**Expressions** (`src/state/timeExpr.ts`), no whitespace anywhere:

| Form | Meaning |
|---|---|
| `now` | the clock anchor |
| `now/d` | the start of the current day in the browser zone (`@internationalized/date`, DST aware) |
| `now-<n><unit>` | `n` = 1…99 999 without a leading zero; units `s`, `m`, `h`, `d`, `w` are fixed durations (a day is always 24 h) |
| `YYYY-MM-DDTHH:mm[:ss[.sss]](Z\|±HH:MM)` | an instant, year 1970…9999; printed back as UTC (`2026-11-19T12:03:00.000Z`) |

Errors are `empty`, `syntax`, `badNumber`, `outOfRange` and `unknownUnit` (the message names the
unit: Unknown unit “x”: use s, m, h, d or w).

**URL search** (`src/state/contextSearch.ts`) is the only reader and writer of `from`, `to` and
`refresh`; ESLint bans `useSearchParams` and `createSearchParams` outside `src/state/`. Reading
applies, in order:

1. the first value of each key counts; missing or duplicated keys are reported;
2. `from` and `to`: spaces are read as `+` (a literal `+` in a query string decodes as a space),
   parsed and re-printed; an invalid value falls back to the default (`now-1h`, `now`);
3. `refresh`: one of `off`, `10s`, `30s`, `1m`, `5m`, `15m`, else `off`;
4. if `from` resolves at or after `to`, both fall back to the default;
5. other keys are kept, sorted by key.

Writing emits `from`, `to`, `refresh`, then the other keys, with `URLSearchParams` encoding (`:`
becomes `%3A`, `+` becomes `%2B`). The canonical form of `/t/demo/boards` is
`?from=now-1h&to=now&refresh=off`.

**Clock and window.** Relative expressions resolve against the clock anchor, which moves only when
`from` or `to` changes, on Refresh now and on each auto-refresh tick. Between ticks the header, the
page summary and Copy link all resolve `now` to the same instant.

**Changing the range** (all pushes, so Back restores the previous range):

| Input | Effect |
|---|---|
| Quick ranges (5 m … 30 d) | `now-<x>` … `now`, closes the dialog |
| From / To fields, Apply | validates both; From at or after To gives "To must be later than From"; the first invalid field gets focus and `aria-invalid` with the error linked by `aria-describedby` |
| Calendar | a whole-day range in the browser zone: From = start of the first day, To = start of the day after the last (so 47 h across the March change, 25 h across October) |
| `[` / `]` | step the window back or forward by its width |
| `-` / `=` | zoom out (twice as wide, around the centre) / in (half as wide) |

The window keys use `KeyboardEvent.code` without modifiers and are ignored inside fields, dialogs,
menus, list boxes and grids. Steps and zooms produce absolute times; a window narrower than 1 s or
wider than 3 650 days is not applied.

**Auto-refresh** calls Refresh now at the chosen interval, skips ticks while the page is hidden, and
stops when the interval is off or the shell unmounts.

**Copy link** puts the view URL on the clipboard with relative times pinned to the clock anchor, or
kept relative with "Keep relative". If the clipboard refuses, "Could not copy the link" is
announced and a read-only "Share link" field with the URL appears, focused and selected.

## Themes and state colours (VL-001, T02-004)

The theme preference (`dark`, `light`, `system`) is kept in `localStorage['pulsus-dash.theme']`
(dark when missing or invalid) and applied as `html[data-theme]`; `system` follows
`prefers-color-scheme`. `src/theme/stateEncoding.ts` is the only TypeScript path to the state
colours: each state has a class, a glyph (ok ●, watch ◐, degraded ◉, failing ■, unknown ○) and a
label, so state is never shown by colour alone. No page uses it yet.

## Tokens and token-lint

`design/tokens.toml` is the one source of colours (dark and light, designed separately), spacing,
sizes, radius, borders, type and motion. `npm run tokens` generates `src/styles/tokens.css` (custom
properties; reduced motion sets durations to `0ms`) and `src/styles/tokens.ts` (`colour`, `space`,
`size`, `radius`, `border`, `font`, `motion`, and the ordered chart arrays `seriesPalette` and
`sequentialRamp`). Both are committed; CI regenerates and compares. The chart tokens (#58) are
`ramp-1`…`ramp-9` (the sequential heatmap ramp, one hue per theme) and `brush` in both themes,
`size.chart` (240), `chart-stat` (120), `chart-tick` (4), `chart-line` (1.5), `chart-brush-min` (4)
and `font.size.display` (32). `series-N` and `ramp-N` must be numbered contiguously from 1; the
generator fails naming the first missing key.
Components use CSS modules with `var(--…)` and, where a React Aria prop needs a number (popover
offset, tooltip delay), the `tokens.ts` values; ESLint bans inline `style` and literal numbers in
those props.

`npm run token-lint` uses parsers, not regular expressions over source text:

- CSS (`postcss`): every declaration value and at-rule parameter is parsed with
  `postcss-value-parser`, and every node is visited, including `var()` fallbacks, nested `var()` and
  `calc()`.
- TypeScript (ESLint with `eslint/tokens-plugin.ts`): every string literal, and every template
  literal with each `${…}` read as `1`.

| Rule | Reported | Allowed |
|---|---|---|
| `colour-literal` | hex colours, colour functions (`rgb()`, `hsl()`, `oklch()`, `color-mix()` …), CSS named colours | `transparent`, `currentcolor`, `inherit`, `initial`, `unset` |
| `size-literal` | non-zero `px`, `rem`, `em`, `pt`, `pc`, `in`, `cm`, `mm`, `q`, `ch`, `ex` (CSS, and TypeScript under `src/{app,shell,kit,pages,theme}/`) | `0`; `%`, `fr`, viewport units; unitless numbers; media-query lengths |
| `duration-literal` | non-zero `ms` and `s` (same scope) | `0s`, `0ms` |
| `state-token` | `--ok`, `--watch`, `--degraded`, `--failing`, `--unknown` as `var()` arguments or values; `colour.<theme>.<state>` and any computed `colour.<theme>[…]` | only in `src/theme/stateEncoding.module.css` and `stateEncoding.ts` |
| `computed-token-name` | a template literal building a custom property name (`` `--${x}` ``) | — |
| `suppressed-token-rule` | a comment that disables a `tokens/` rule | — (there are no inline exceptions) |

The generated token files and tests are not linted.

## Keyboard coverage

`e2e/keyboard.spec.ts` drives the app by keyboard only (loops L1–L28) through
`e2e/keyboardCoverage.ts`; its steps are in `e2e/keyboardScript.ts` (focus by Tab, operate, menus,
text, `drain`, `shellAfter`) and the board loops L23–L28 in `e2e/keyboardBoards.ts`, run inside the
one test. ESLint bans `.press(`, `.click(`, `.fill(`, `.type(` and `page.mouse` in all three files. After every keystroke the harness collects each interactive control (links, buttons,
fields, menu items, options; a grid counts as one control) from the accessibility snapshot, keyed by
state: the route pattern plus the open overlay (with an overlay open, only the overlay is read).
Before Enter, Space, the arrow keys, Home, End, PageUp, PageDown, a typed text, and Escape in an
overlay, it records the focused control as operated; Tab never counts. The test fails if any
collected control was never operated, or if a required state (every route, Not found, Signed out,
the session error, and the chart gallery `/t/:tenant/dev/gallery`) was never visited, and prints
the missing keys. L20 operates the header and sidebar on the gallery too (the time dialog's Keep
relative and Copy link exist only on pages with a view URL pattern, so not there); L22 operates the
six chart crosshair sliders (End, ←, Home, →, ↓, Escape) and checks the crosshair time, the tooltip
and the value text. L23–L28 cover the board list and its dialogs, the board in View and Edit mode,
the panel tools, Share, the layout buttons, the panel editor dialog and its selects, the guard and
the conflict dialog; each loop asserts its behaviours, then `drain(name, enter)` re-enters one state
per round (a `goto` plus a keyboard replay) and operates the first control of that state's region
(`main`, or the open overlay) not yet operated (Enter for links, buttons, menu items and options;
Space for checkboxes; End then Escape for sliders; End for text fields), until none is left; when
an operation opens a dialog, menu or list box, that overlay is drained next (two levels deep). An
action that adds sidebar or table links (create, rename) is followed in the same page session by
`shellAfter`, which operates each new link. Two names are normalised: the time range trigger is one control whatever range
it shows, and the calendar grid one control whatever month. React Aria's screen-reader-only buttons
are not counted: an empty button with `tabindex="-1"` whose parent is React Aria's VisuallyHidden
wrapper (inline `clip-path: inset(50%)`), that is the popover "Dismiss" buttons and the calendar's
second "Next"; Escape and the visible buttons are their keyboard equivalents. Any other control, including a visible empty icon button
with `tabindex="-1"`, is counted (the self-test checks this).

**Adding a control:** run the keyboard script; if it lists the new control as uncovered, add the
key presses that operate it to the loop for its page (or to `chrome()` in L20 if it is in the
sidebar or header), with an assertion of what it does. `e2e/coverage.spec.ts` checks the harness
itself.

## API clients

`src/api/` defines `Api` and one `ApiError(kind, message, {fields?, detail?})`. Its kinds come in
three families:

- common: `notFound`, `unauthorised`, `network`, `notImplemented` and `unknown`;
- boards (#61): `conflict` and `invalid`. An `invalid` error carries `fields`
  (`{pointer, messageKey}`), and a stale etag is a `BoardConflictError` carrying the `current`
  board;
- queries (#62): `queryInvalid`, `tooBroad`, `timeout`, `unavailable`, `busy` and `badResponse`.
  `detail` carries the BFF's `queryId`, the error `position` (a byte offset into the query,
  T09-009) and its `hint`.

`fields` is `[]` and `detail` is `{}` when there is nothing to carry.
`createApi()` returns `HttpApi` when `VITE_API_MODE` is `http`, else `StubApi`.

| Method | Result |
|---|---|
| `getSession()` | `{user, org, tenants, defaultTenant, server, canSignOut}` |
| `listBoards(tenant)` | `{items, truncated}`; an item is `{uid, title, version, updatedAt, updatedBy}` |
| `getBoard(tenant, uid)` | `Board`: the item plus `etag` and `spec` (generated `BoardSpec`) |
| `createBoard(tenant, spec)`, `saveBoard(tenant, uid, etag, spec)`, `deleteBoard(tenant, uid, etag)` | `Board`, `{board, changed}`, nothing |
| `panelData(tenant, panel, window)` | `{kind: 'frame', spec, data}`, `{kind: 'noRoute', lang}` or `{kind: 'noVis'}` |
| `listStarred(tenant)` | `BoardRef[]` (`{uid, title}`), in the server's order (title, then uid) |
| `setStarred(tenant, uid, starred)` | nothing; star of an unknown or deleted board → `notFound`; unstar is idempotent |
| `listRecent(tenant)` | `BoardRef[]`: the `RECENT_LIMIT` (5) most recently opened, newest first |
| `recordView(tenant, uid, at, signal)` | nothing; `at` is the navigation time (integer ms since the epoch), the greater of the stored and the new time wins; unknown → `notFound`; an abort is rethrown |
| `signOut()` | as before |
| `queryRange(tenant, req, signal)`, `queryInstant(tenant, req, signal)` | the PromQL range and instant results of #62 (below) |
| `checkDataSource(tenant, signal)` | `{state, checkedAtMs?}` (T06-025) |

Boards belong to the organisation: `tenant` is checked against the session's tenants (unknown →
`notFound`) and otherwise only selects the data source of `panelData` and the queries. Each tenant
may carry `dataSource: {state: 'notChecked'}` from the bootstrap. `server` is `{version, commit}` from the BFF, or `null` in
stub mode; `canSignOut` is false under the fixed local principal.

### HttpApi

`HttpApi` is `openapi-fetch` 0.17.0 over `paths` from `src/api/gen/schema.d.ts`, which is generated
from `api/openapi.yaml` (ADR-0014 §1, ADR-0015); requests go to the page's origin.

| Method | Request | Mapping |
|---|---|---|
| `getSession` | `GET /api/dash/v1/bootstrap` | `principal` → `user`, `org.name`, tenants with `dataSource.state` `notChecked`, `default_tenant`, `server`, `can_sign_out` → `canSignOut` |
| `listBoards` | `GET /api/dash/v1/boards` | `updated_at` → `updatedAt`, `updated_by.name` → `updatedBy`, `truncated` |
| `getBoard` | `GET /api/dash/v1/boards/{uid}` | 404 → `notFound` |
| `createBoard` | `POST /api/dash/v1/boards` `{spec}` | 201 → `Board`; 400 → `invalid` with the envelope's `fields` |
| `saveBoard` | `PUT /api/dash/v1/boards/{uid}` `{spec}`, `If-Match: "<etag>"` | 200 → `{board, changed}`; 409 → `BoardConflictError(current)`; 400 → `invalid`; 404 → `notFound` |
| `deleteBoard` | `DELETE /api/dash/v1/boards/{uid}`, `If-Match: "<etag>"` | 204; 409 → `BoardConflictError`; 404 → `notFound` |
| `panelData` | none | `{kind: 'noVis'}` for visualisation `logs`, else `{kind: 'noRoute', lang}`: the BFF has no query route yet (#64, #67) |
| `listStarred` | `GET /api/dash/v1/me/starred-boards` | 200 → `items` |
| `setStarred` | `PUT` (star) or `DELETE` (unstar) `/api/dash/v1/me/starred-boards/{uid}` | 204; 404 → `notFound` |
| `listRecent` | `GET /api/dash/v1/me/recent-boards?limit=5` | 200 → `items` |
| `recordView` | `PUT /api/dash/v1/me/recent-boards/{uid}?at=<ms>`, with the signal | 204; 404 → `notFound` |
| `signOut` | none | resolves; never offered, because `canSignOut` is false |
| `queryRange` | `POST /api/dash/v1/query/promql/range?tenant=…` `{query, from, to, width_px}` (`timeout_ms` only when given) | decoded by `data/decode.ts` into `{startMs, endMs, stepMs, series, completeness}`; errors below |
| `queryInstant` | `POST …/query/promql/instant?tenant=…` `{query, at}` | a `series` (vector or matrix), `scalar` or `string` result; errors below |
| `checkDataSource` | `GET /api/dash/v1/datasource/check?tenant=…` | `{state, checkedAtMs?}` (`not_checked` → `notChecked`); errors below |

Errors: an `AbortError` from `fetch` is re-thrown unchanged; any other `fetch` rejection becomes
`ApiError('network')`; any other status without its success body becomes `ApiError('unknown')`
with the error envelope's `message`. A failed session shows the session error page with Retry.
The query and check methods map the BFF's answers
([PulsusDB routes](../server/pulsusdb.md#errors-t06-52)) further:

| Response | `ApiError` |
|---|---|
| 400 `virtual_unsupported` (a reserved selector) | `queryInvalid`, `detail.hint` |
| 400 with `fields[0].pointer` `/query` (PulsusDB rejected the query) | `queryInvalid`, `detail.position` (from `hint.position.offset`) and `detail.queryId` when present |
| other 400, 413 | `unknown` with the envelope's message |
| 422 | `tooBroad`, `detail.hint` (`action: narrow`) |
| 429 | `busy` |
| 502, 503 | `unavailable`, `detail.hint` (`reason`) |
| 504 | `timeout` |
| 200 that the decoder refuses | `badResponse`, the message naming the JSON pointer of the bad element |

A connection reset in the middle of a range body (the BFF's abort after a failure) is a `network`
error, never a partial result.

### Decoding frames (`data/decode.ts`)

`decodeRange` and `decodeInstant` are the single seam between the wire and the charts
(ADR-0014 §5, T04-010; Arrow replaces the wire behind them with #68). They validate every field
of the JSON frames: `key` matches `^[0-9a-f]{16}$`, label values are strings, `timestamps` are
integers and strictly increasing, `values` has the same length and each value is a number,
`"NaN"`, `"+Inf"`, `"-Inf"` or `null` (absent, decoded as NaN: a gap). Optional completeness fields
become `null`. Anything else throws `DecodeError` with the JSON pointer of the first bad element,
for example `/frames/0/values/3`. The output is fresh `Float64Array`s in `SeriesFrame`
(`data/frames.ts`).

### StubApi

`StubApi` serves `queryRange` as three series `stub_metric{series="0|1|2"}` on the grid of
`promGrid` (`data/step.ts`, the mirror of the BFF's step rule, tested against the same
`wire/fixtures/json/promql-step.json`), with values `synthLineValue(62, j, t, 100, 40)` and an empty
completeness; a range too long for the width rejects `queryInvalid`. `queryInstant` returns the same
three series as a vector at `atMs`; `checkDataSource` resolves `{state: 'ok', checkedAtMs: 0}`.

`StubApi` resolves on the next microtask, rejects with `AbortError` when the signal is aborted,
returns copies, and serves the seed in `stubData.ts`: user Ada Admin (administrator), org Demo Org,
tenants Demo and Sandbox (both "not checked"), `server: null`, `canSignOut: true`, and three
organisation boards (`b-1` Service overview with three panels and a section, `b-2` empty, `b-3` with
a long title and three panels), the same in both tenants. Boards are kept in memory for the page's
lifetime and behave as the boards API does: version and etag start at `1` and grow by one per
changed save; a save of the same canonical spec is `changed: false`; a stale etag is a
`BoardConflictError`; an invalid spec is `invalid` with the fields of `checkBoardSpec`; new uids are
`b-<n>`; the list is most recently updated first. `panelData` is seeded synthetic data
(`stubPanels.ts`: a pure function of the panel id, the query text and the window). `b-3`'s queries
reference the variables `region` and `env`.

Starred and Recent mirror the BFF's per-user lists, one for every tenant, in `localStorage`:

| Key | Value | Absent or invalid |
|---|---|---|
| `pulsus-dash.stub.starred` | JSON array of uids, in starring order; listed by title (case-folded), then uid | absent → `["b-1"]`; not a string array → `[]` |
| `pulsus-dash.stub.recent` | JSON array of `{"uid", "at"}`, newest first, at most 200; a view keeps the greater `at` (no clamp), an equal `at` puts the later write first; listed in stored order, five | absent, or any element of another shape → `[]` |

Both lists drop uids that are no longer boards (a deleted board stays stored, as the server's join
drops it). The Part B keys `pulsus-dash.stub.starred.<tenant>` and `pulsus-dash.recent.<tenant>`
are no longer read.

Test hooks, each a positive integer n in `localStorage` that makes the next n calls fail and counts
down:

| Key | Effect |
|---|---|
| `pulsus-dash.stub.failSession` | `getSession` rejects `network` |
| `pulsus-dash.stub.failSignOut` | `signOut` rejects `network` (keyboard L21) |
| `pulsus-dash.stub.failSave` | `saveBoard` rejects `network` |
| `pulsus-dash.stub.conflictSave` | `saveBoard` moves the head on by one version (same spec, as if someone else saved) and rejects `BoardConflictError` (keyboard L28) |
| `pulsus-dash.stub.failStar` | `setStarred` rejects `network` and changes nothing (`e2e:a11y-rooms` state `b-1 star failed`) |
| `pulsus-dash.stub.failPanelData` | `panelData` rejects `network` ("stub: panel data failed") after the delay below (#90, `panel-editor-dialog.spec.ts` E11, E13, E15) |

`pulsus-dash.stub.panelDelayMs` (#90), a positive integer n, makes every `panelData` call resolve
after n ms instead of the next microtask; it is read on every call and never consumed, and an abort
of the call's signal clears the timer and rejects with `AbortError`. Every `panelData` call also
leaves a `stub:panelData` performance mark with `detail` `{ id, lang, text, vis }`, which the
frame-timing e2e specs read to see when a request started.

## Boards

The board list is `src/pages/boards/` (`BoardsPage.tsx`, `BoardDialogs.tsx`); the board page is
`src/pages/board/`; the logic they share is `src/boards/`:

| Module | Contents |
|---|---|
| `spec.ts` | `checkBoardSpec(value)`: the server's validator (`server/internal/spec`) ported to parsed JSON, same message keys, pointers and order, at most 50 errors; `canonicalJson` (keys sorted); `nextId(spec, prefix)`, with `nextPanelId` (`p-<n+1>`) and `nextSectionId` (`s-<n+1>`). The six fixture cases that only exist as raw JSON text (not JSON, trailing data, empty body, duplicate key, `6.5` and `1e2` as integers) are the server's alone |
| `layout.ts` | `COLS` 12, `ROW` 40, `GAP` 16; `GRID_LIMITS` (the server's: x + w ≤ 12, y ≤ 9 999, h ≤ 100); `fits`, `firstFree(panels, w, h)` (first free slot in row-then-column order, or `null`), `applyOp(panels, id, op)` (one cell of move or resize; blocked when it leaves the grid or overlaps), `cellPx(width)` |
| `editorState.ts` | The page reducer: the head (`Board`), the draft spec, the mode, the selected panel, the save status (including `discardFailed`) and field errors, the conflict and remote heads, the live-region text. Dirty = the draft's canonical JSON differs from the head's. No edit is taken while saving; a later read of the board replaces the draft only when it is clean. Section actions: `addSection` (at most 50), `updateSection`, `removeSection`, `toggleSection` (Edit only: saved with the board), and `addPanel {grid}` into a section (which expands it). `isCollapsed(mode, section, overrides)`: View follows the URL overrides, else the saved state; Edit follows the draft |
| `variables.ts` | `boardVariables(spec)`: the `$name` / `${name}` references in the queries, top panels first, then each section's, distinct; `$__…` macros and names over 64 characters are not variables |
| `queries.ts` | `RECENT_LIMIT` (5) and `invalidateBoardLists(queryClient)` |
| `prefs.ts` | `BoardPrefs` (below) |
| `boardKeys.ts` | `Shift+E` (toggle Edit, not while typing or in a dialog or menu) and `⌘S` / `Ctrl+S` (save in Edit mode, from any target) |
| `fieldMessages.ts` | `message_key` → the catalogue text `field.<key>` |

**View and Edit grids.** View mode (`BoardGridView`) places each panel absolutely from custom
properties `--gx --gy --gw --gh` set in CSSOM (T08-023) and sizes the container from `--gbottom`;
the arithmetic is the 12-column, 40 px, 16 px grid, so any layout the server accepts (rows up to
10 099) renders, which a CSS grid's track limit would not allow in every engine. DOM order is
`(y, x)`. Edit mode loads `BoardGridEditor` lazily: `react-grid-layout` 2.3.0 with the same numbers
(`margin` 16, `containerPadding` 0, `rowHeight` 40, `maxRows` 10 099), no compaction and
`preventCollision`, so panels never push each other and gaps stay. A pointer drop is taken only if
the moved panel fits and overlaps nothing; otherwise the grid is reset and the refusal announced.
While it loads, the View grid is the fallback, so nothing moves. react-draggable fills a `<style>`
element through `innerHTML` when a drag starts, which Trusted Types blocks; `BoardGridEditor`
creates an empty marker element with that id first (an inert `<meta>`, since even an empty
`<style>` is an inline style under the CSP), and `Board.module.css` holds the same selection rules.

**Chunks.** The board page is the lazy chunk of `src/pages/board/BoardPage.tsx`; the Edit grid,
with `react-grid-layout` and its stylesheet, is the separate lazy chunk of
`src/pages/board/BoardGridEditor.tsx`, preloaded when the pointer or the focus reaches Edit board. Both are listed in `bundle-budgets.json` and checked against
the 120 KB brotli `lazyChunk` budget (sizes in [JavaScript supply chain](supply-chain.md#react-grid-layout);
after #90 the board chunk is 12 196 bytes, the Edit grid 18 016, the chart frame chunk 10 668, the
initial JS 171 112 and the initial CSS 5 373).

**Panel editor** (`PanelEditor.tsx`, #90; IA-015, T08-017). The editor is the kit's `ModalDialog`
with `size="editor"`: a centred window of `--size-dialog-editor-width` × `--size-dialog-editor-height`
(800 × 720), capped to the viewport less 24 px a side, with no drag handle or resize affordance,
over the kit's `--backdrop`. The page renders it while Edit mode has a selected panel (`key` = the
panel id, so a switch remounts it); Done, Escape and a backdrop click dispatch `select(null)`, and
the draft is never reverted. Its tree is `PanelPreview`, then Title, Query language, Query (both
columns) and Visualisation in a two-column grid that scrolls vertically, then Remove panel, a
mirror of the page's save status (`role="status"`, "Save status": the board behind is `aria-hidden`
while the modal is open) and Done. Focus return: when `selected` goes from an id to null in Edit
mode, `BoardEditor` calls `focusAfterEditor(document, id)` one animation frame later (after the
overlay's own restore), which focuses the panel's `[data-panel-menu]` button, else the toolbar's
`[data-board-add]` Add panel.

`PanelPreview` (`PanelFrame.tsx`) renders the draft through the board panel's own path,
`usePanelData` → `PanelBody` → `ChartFrame`. The two share one TanStack query key (`vis.kind` stays
in it, because `panelData` is shaped per visualisation), so the preview adds no request: every
draft key is fetched once, for both. What a change shows:

| Change | In the change's commit | Then |
|---|---|---|
| Title | the preview title and the chart spec; no request | drawn in the next frame |
| Visualisation, query or language, key already cached | the cached result (or the Logs message); no request | drawn in the next frame, also after an error or Logs message |
| Same, not cached | one `panelData` call, shared with the panel behind; `Loading` | the chart, or `Something went wrong` (no retry) |
| Same, changed again before a result | both observers move to the newest key; the superseded call's signal aborts | only the newest key's result renders |

**Chart readiness** (`ChartFrame.tsx`, #90; [ADR-0019](../../designs/adr/0019-chart-frame-drawn-event-and-frame-id.md)).
`ChartFrame` takes `pending` (shown over the frame) and `sizeMemo`. `pending` stays until the
engine's `drawn` event reports a complete draw at the size last applied; it shows again on every
resize (a zero size included, since setting the canvas size clears it), on a DPR change, on a new
engine frame (a switch to or from Stat), on a kind change of a kept frame (the engine clears its
canvas) and on unmount. Changes from the observer, the DPR callback and the engine's frame callback
are committed with `flushSync`, so they show before that frame's paint. A new `fill` frame is
sized at once from `sizeMemo.current` (the host's last non-empty observed size) and an equal
observed size is then skipped, so a re-created frame draws in its first animation frame. Every
`PanelBody` caller holds its own memo above `ChartFrame`: the board panel (`PanelFrame`), full
screen (`PanelFullScreen`, kept across close and reopen) and the preview. The preview measures an
always-mounted host element (`[data-preview-host]`) with its own observer, so its memo is current
while a message shows, on a fresh dialog too. `PanelChart` passes the panel's `Loading` as
`pending`, so no panel ever paints a blank canvas. Explore and the gallery pass neither prop and
keep their behaviour. Each frame has a diagnostic id (`f1`, `f2`, …): the host's `data-frame-id`,
`FrameInit.id`, and `detail.frame` of the engine's `chart-draw` measures; it is for tests and
traces only.

**Saving.** Save checks the draft with `checkBoardSpec` first (field errors open the editor on the
first panel they point into), then calls `saveBoard` with the head's etag. A 409 opens the conflict
dialog (save again with the other version's etag, or load it); `invalid` shows the field errors;
`notFound` and network failures keep the draft and leave Save enabled. The query cache entry of the
board is set from the response and the board list is invalidated. **Discard** reads the head
again with `staleTime: 0`; until that read settles, Edit is read-only exactly as while saving
(toolbar, layout buttons, grid and editor fields disabled; `⌘S`/`Ctrl+S` and `Shift+E` ignored), so
the response's `loaded` and `exitEdit` cannot replace an edit or race a save.

**Failed reads.** Only a failed first read replaces the page (`Board not found` or the generic
error). A failed later read (an invalidation or refetch with the board already loaded) keeps
`BoardEditor` mounted, so the draft and the unsaved-changes guard stay; a notice says the board was
deleted elsewhere (`notFound`) or could not be reloaded (anything else), and clears on the next
successful read.

**Panel ids.** New panel ids are `p-<n>` above the largest `p-<n>` among panel and section ids
(ids are unique across both), computed with `BigInt`; when that does not fit the 40-character id,
the lowest free `p-<n>` is used.

**Sections** (`BoardSection.tsx`). Each section is a `<section data-section>` labelled by its `h2`,
whose button (`aria-expanded`, `aria-controls` the grid) collapses or expands it, then the panel
count; in Edit mode the heading row adds **Section `n` title**, **Add panel to `<title>`** and
**Remove section `<title>`**. A collapsed section renders no grid, so its panels mount no
`PanelFrame` and create no `['panel', …]` query (T07-012). In View mode a toggle writes a URL
override (below) only when it differs from the saved state, with `replace`; entering Edit mode by
any path clears the overrides, so Edit starts from and saves the saved state. A section title's
field error shows under the field, not under the status line.

**Filter bar** (`BoardFilterBar.tsx`). A group "Board filters" between the Context summary and the
toolbar, in both modes: a chip per `boardVariables(draft)` name, a chip per filter in URL order, and
`+ Filter`. Each opens a popover dialog (Value, Apply and Clear or Remove filter; or Label, Value,
Add and Cancel). Checks run in order and the first error shows under its field with the dialog
open; a budget refusal (`url.tooLong`) shows under Value. Each submit is one history entry.

**Board URL parameters** (`src/state/boardParams.ts`, `src/state/useBoardParams.ts`; IA-022,
ADR-0017). The board's own parameters live in the Context's `rest` pairs, read and written only
here:

| Parameter | Meaning | Rules |
|---|---|---|
| `var-<name>` | a variable's value | name as `VARIABLE_NAME`; value 1–200 code points; the first occurrence wins |
| `f=<label>=<value>` (repeated) | a `+ Filter` filter | label `^[A-Za-z_][A-Za-z0-9_.]{0,99}$`; value 1–200 code points; at most 20 (`MAX_FILTERS`); a repeated label is ignored |
| `collapse=<id>`, `expand=<id>` (repeated) | View-mode overrides of a section's saved collapsed state | id as a spec id; an id in both is ignored; ids the board does not have are ignored and dropped at the next override write |

Invalid pairs are ignored (and kept until the next write of their kind); writers emit canonical
pairs sorted by key, so a written URL reads back unchanged. `useBoardParams(sectionIds)` returns
`params`, `setVar` and `setFilter` (push) and `setSectionOverride` and `clearSectionOverrides`
(replace). Every write is held to `MAX_REQUEST_TARGET` (4 096 bytes of path and search, half the
smallest request-line limit common in proxies): `setVar` and `setFilter` refuse a value with
`'url.tooLong'` and do not navigate when the path and search without overrides, plus the
`overrideReserve` of the board's section ids (`'&collapse='` and the id, for each), plus
`SHARE_RESERVE` (96 bytes: Copy link's absolute `from`/`to` are at most 2 × 27 bytes longer than
`now`) would exceed it. Removing a value is never refused. An override write re-checks the actual
URL plus `SHARE_RESERVE`. Copy link (`ShareLinkControls`) carries the board's `rest`, so it
reproduces variables, filters and overrides, and refuses a hand-made link over 4 096 bytes
("This link is too long to share. …").

**Starred and Recent** (`src/boards/prefs.ts`, `SidebarBoards.tsx`, `StarToggle.tsx`; IA-021).
`Providers` creates one `BoardPrefs` per app (`createBoardPrefs(api, queryClient)`), connects its
channel in an effect whose cleanup closes and disposes it; a later `connect()` reactivates it, so
the StrictMode replay (setup, cleanup, setup) leaves it working. `useBoardPrefs()` reads it.

- **Views.** The board page calls `recordView(tenant, uid)` once per opening. Each view is stamped
  `at = max(floor(now), last + 1)`, strictly increasing within the app even if the clock steps
  back, and sent at once (requests may overlap), with a 10 s timeout (`VIEW_TIMEOUT_MS`) that
  aborts it. The server keeps each board's greatest time, so, while the stamps fall inside the
  server's window (now − 1 day … now + 5 min), Recent follows navigation order within one app
  instance whatever order the requests commit in. A stamp outside the window (a clock off by more
  than that) is clamped to its edge, and such views order by the server's transaction start time,
  best effort: a transaction that starts first can commit last. Across browsers or app instances
  the order is best effort, by each one's clock, subject to skew (D-RECENT-window). Success invalidates `['recent']` and tells other tabs; `notFound` is ignored; an
  ambiguous failure (the timeout, `network`, `unknown`) arms one reconciliation per app at the
  send + 15 s (`VIEW_TIMEOUT_MS` + `RECONCILE_DELAY_MS`), re-armed to the latest due time when
  several are pending, which invalidates `['recent']` and tells other tabs once.
- **Other tabs.** `BroadcastChannel('pulsus-dash.board-prefs')` carries `{kind: 'starred' |
  'recent'}`; a message invalidates that list. Without `BroadcastChannel` nothing is posted.
- **Focus.** `useStarred` and `useRecent` set `refetchOnWindowFocus: 'always'`, so both lists
  refetch whenever the tab becomes visible again, however fresh they are: another browser's
  changes show then.
- **Star toggle.** The press shows the new state at once; further presses are ignored until it
  settles; then `starredChanged()` invalidates `['starred']` and tells other tabs. A failure
  restores the state and shows "Could not update Starred. Try again." in a visible live region
  (`.starStatus`) after the star.

Sidebar links carry the time Context (`from`, `to`, `refresh`) but none of a board's own
parameters.

**Saved time and the guard.** Board links pass `BOARD_LINK_STATE` (`{applySavedTime: true}`,
`SidebarBoards.tsx`); on the first load with that state the board's `spec.time` is applied with a
`replace`, and the history entry's state is cleared, so a reload or a deep link keeps the URL's time
(IA-022). `useBlocker` asks before in-app navigation to another path while the draft is dirty (time
and refresh changes keep the path, so they never ask); `beforeunload` is registered while dirty.

## Text and formatting (T08-027)

Every string is in `src/i18n/messages.en-GB.ts`; `t(id, values)` fills `{name}` placeholders and an
unknown id is a type error. `src/i18n/format.ts` is the only place `Intl` formatters are created
(locale en-GB, 24-hour time): `formatDate` (19 Nov 2026), `formatTime` (12:03:00), `formatRange`,
`formatRangeShort` (12:03 – 13:03 GMT), `formatZone` (Europe/London (GMT)) and `describeRange`; for
charts, `formatValue` (`2.84 s`, `1.2k rps`, `1.5 GiB`; rules in [Charts](charts.md#numbers-vl-012-t08-027)),
`formatHourMinute` and `formatDayMonth`.

## Adding a page or a search key

- **Page:** add the importer to `routeModules`, a route with `lazy` under `t/:tenant` in
  `createRoutes`, a sidebar item if it is a destination (with its route ids for `aria-current`),
  messages, and the page's checks: it must call `usePageTitle`, pass axe, and be operated by the
  keyboard script.
- **Search key:** never read it with `useSearchParams`. Add a typed reader and writer in
  `src/state/` beside `contextSearch.ts` (validate, default, canonicalise), call it from the tenant
  loader's normalisation, and add round-trip tests.

## Headers and CSP (T18-001, T18-004, ADR-0014 §9, ADR-0016)

`config/headers.ts` holds the production headers that `vite preview` sends; the BFF sends the same
values (and `Reporting-Endpoints`, HSTS and `Permissions-Policy`), and `e2e:bff-headers` checks the
served CSP equals `CSP` here: the ADR-0014 §9 CSP (`script-src 'self'`, `style-src 'self'`, Trusted Types required), COOP
`same-origin`, COEP `require-corp`, CORP `same-origin`, `nosniff` and the referrer policy. Asset
integrity is verified by the BFF before serving (ADR-0016); the browser loads no import map and no
per-module SRI. The build emits no inline script or style: React sets styles through CSSOM, and the
one rule React Aria would inject as an inline `<style>` (`touch-action` for pressable elements) is in
`styles/global.css` instead, with `main.tsx` marking it as installed. The dev server sends COOP and
COEP only. `e2e:csp-violations` checks every page and overlay for CSP and Trusted Types violations
and that the page is cross-origin isolated; `e2e:asset-origin` and `e2e:font-origin` check that
every request, fonts included, stays on the app origin.

## Limits

- No sign-in (the BFF serves a fixed local principal, D12), panel queries (`http` mode shows "Runs
  when PromQL support lands"; #64, #67), command palette, alert count or AI dock yet.
- Boards: no undo or history, no reordering of sections or moving panels between them, variables
  and filters do not change queries yet (#64), no permissions (D12).
- No page runs PromQL queries yet: Explore and the panels come with #63 and #64. The data-source
  line shows the check, but nothing retries it before the cached result goes stale (60 s).
- Day and week units are fixed 24 h and 7 × 24 h durations; only `now/d` and the calendar follow DST.
- Layouts are designed for desktop widths (1440 px reference); narrow layouts are later work.

## Design references

D9 ([designs README](../../designs/README.md)), [ADR-0014](../../designs/adr/0014-typescript-react-web-client.md),
[ADR-0016](../../designs/adr/0016-asset-integrity-verified-by-bff.md),
[ADR-0017](../../designs/adr/0017-react-router.md),
[ADR-0019](../../designs/adr/0019-chart-frame-drawn-event-and-frame-id.md);
[ADR-0015](../../designs/adr/0015-go-bff.md);
[02 Information architecture](../../designs/product/02-information-architecture.md) (IA-002, IA-003,
IA-006, IA-015, IA-016, IA-020, IA-021, IA-022, IA-023),
[04 Surfaces](../../designs/product/04-surfaces.md) §4.3 (SRF-014, SRF-016, SRF-017, SRF-020, SRF-026),
[03 Interaction model](../../designs/product/03-interaction-model.md) (INT-015, INT-032),
[08 Visual language](../../designs/product/08-visual-language.md) (VL-001, VL-010, VL-017, VL-021),
[09 Performance contract](../../designs/product/09-performance-contract.md) (PRF-005, PRF-008, PRF-030
client half, PRF-033);
[T01](../../designs/technical/T01-frontend-architecture.md) (T01-007, T01-008, T01-010),
[T07](../../designs/technical/T07-scene-query-planner.md) (T07-012, collapsed sections do not query),
[T02](../../designs/technical/T02-vis-engine.md) (T02-004),
[T03](../../designs/technical/T03-browser-runtime.md) (T03-013, T03-014, T03-017),
[T08](../../designs/technical/T08-dom-component-kit.md) (T08-005, T08-007, T08-008, T08-010, T08-022,
T08-015, T08-017, T08-018, T08-021, T08-023, T08-024, T08-027), [T18](../../designs/technical/T18-security.md)
(T18-001, T18-004),
[T04](../../designs/technical/T04-wire-format-and-data-plane.md) (T04-005, T04-010),
[T06](../../designs/technical/T06-bff-architecture.md) (T06-025),
[T09](../../designs/technical/T09-query-editors.md) (T09-009).
