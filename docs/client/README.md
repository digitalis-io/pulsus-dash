# Client application

The web client in `client/`: TypeScript, React and Vite
([ADR-0014](../../designs/adr/0014-typescript-react-web-client.md)), routing on React Router in
data mode ([ADR-0017](../../designs/adr/0017-react-router.md)), accessible components from React Aria
Components, server state in TanStack Query. This page covers the application shell of milestone
M-UI1 (roadmap step 1, issue #57): layout, routes, the time Context, themes and tokens, and the
checks that guard them. Build and CI are in [Build, test and CI](../development/build-and-ci.md);
dependencies in [JavaScript supply chain](supply-chain.md).

## Run

```sh
cd client
npm ci
npm run dev          # http://localhost:5173, stub API, no backend needed
npm run build && npm run preview   # the production build on http://localhost:4173, production headers
```

| Variable | Read by | Values | Default |
|---|---|---|---|
| `VITE_API_MODE` | the client at build and dev time (`createApi()`) | `stub` (in-repo seeded data) or `http` (the BFF client) | `stub` |
| `PULSUS_DASH_DEV_BFF` | `vite.config.ts` (dev server only) | base URL the dev server proxies `/api` and `/auth` to | `http://localhost:8080` |
| `VITE_GIT_SHA` | the About dialog | commit SHA (CI sets it); shown as 12 characters | `dev` |

Until the BFF exists (#59), `http` mode rejects every call with `ApiError('notImplemented')`, so the
app shows the session error page. The proxy target is never logged.

## Layout (D9, IA-016, IA-021, VL-017)

The shell follows the owner-approved layout of [mockup 35](../../designs/mockups/35-application-shell.svg).
Sizes come from the tokens, at a 1440 × 900 reference:

| Element | Behaviour |
|---|---|
| Skip link | First tab stop, "Skip to main content"; moves focus to `<main id="main">` |
| Sidebar, 240 px (56 px collapsed) | Full height. Top block 56 px, its bottom hairline continuing the header's: product mark (link to Boards) and the org and tenant block. With two or more tenant bindings the tenant name is a menu button (`Switch tenant, current: <name>`) listing the bindings; choosing one opens that tenant's Boards with the current time range (push). With one binding the block is static text. Collapsed: the mark, and a 32 px org-initial menu button when there are two or more bindings |
| Sidebar navigation (`nav` "Main") | Boards; Explore with Metrics and Logs; Starred (the user's starred boards that exist, in board-list order, empty text "No starred boards"); Recent (the last five boards opened, newest first, kept locally, empty text "No recent boards"). Collapsed: icon links with tooltips; Starred and Recent hidden. The current page is marked with `aria-current="page"` (Boards also on a board page). Links carry the current `from`, `to` and `refresh`, and preload their page on hover and focus |
| Sidebar footer | Admin (administrators only) and "Collapse sidebar" / "Expand sidebar" (`aria-expanded`). There is no keyboard shortcut for the toggle: `[` is the window-step key (INT-032). The state persists in `localStorage` |
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
role, then the theme section (Dark, Light, System), "About Pulsus Dash" (version, build, licence)
and "Sign out" (clears the query cache and opens `/signed-out`).

**Pages.** Boards lists the tenant's boards (title link, "Updated `<date>, <time>`"; empty: "No
boards yet"). A board shows its title, the Context summary and an empty "Panels" region, and records
itself in Recent; an unknown board shows "Board not found" and "Back to boards". Explore › Metrics
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
| `/t/:tenant/*` | Not found inside the shell |
| `*` | Standalone Not found |

- **`replace()`, not `redirect()`:** loader redirects use `REPLACE`, so normalising a URL adds no
  history entry. In-app writers emit canonical URLs, so they never redirect after a push.
- **Session:** `sessionQuery` has `retry: false`, so a failed session shows the error page at once
  ("Pulsus Dash could not load your session" with **Retry**, the first focusable control). Retry drops
  the cached session and revalidates; on success the shell renders and focus moves to `main`.
  Other queries use the query client defaults (`retry: 1`, `staleTime` 30 s, no refetch on focus).
- **Preloading:** `src/app/routeModules.ts` holds the page importers; `preloadRoute(id)` starts one
  (sidebar and board links call it on pointer enter and focus), and the route's `lazy` reports a
  failed load.
- **Query keys:** `['session']`, `['boards', tenant]`, `['board', tenant, uid]`,
  `['starred', tenant]`; `refreshNow()` invalidates `['data']` (the chart queries of later issues).

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
`size`, `radius`, `border`, `font`, `motion`). Both are committed; CI regenerates and compares.
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

`e2e/keyboard.spec.ts` drives the app by keyboard only (loops L1–L20) through
`e2e/keyboardCoverage.ts`; ESLint bans `.press(`, `.click(`, `.fill(`, `.type(` and `page.mouse` in
that file. After every keystroke the harness collects each interactive control (links, buttons,
fields, menu items, options; a grid counts as one control) from the accessibility snapshot, keyed by
state: the route pattern plus the open overlay (with an overlay open, only the overlay is read).
Before Enter, Space, the arrow keys, Home, End, PageUp, PageDown, a typed text, and Escape in an
overlay, it records the focused control as operated; Tab never counts. The test fails if any
collected control was never operated, or if a required state (every route, Not found, Signed out,
the session error) was never visited, and prints the missing keys. Two names are normalised: the
time range trigger is one control whatever range it shows, and the calendar grid one control
whatever month. React Aria's screen-reader-only buttons (visually hidden, `tabindex="-1"`: the
popover "Dismiss" buttons and the calendar's second "Next") are not counted; Escape and the visible
buttons are their keyboard equivalents.

**Adding a control:** run the keyboard script; if it lists the new control as uncovered, add the
key presses that operate it to the loop for its page (or to `chrome()` in L20 if it is in the
sidebar or header), with an assertion of what it does. `e2e/coverage.spec.ts` checks the harness
itself.

## Stub API

`src/api/` defines `Api` (session, boards, board, starred boards, sign-out) and `ApiError` kinds
`notFound`, `unauthorised`, `network`, `notImplemented`, `unknown`. `StubApi` resolves on the next
microtask, rejects with `AbortError` when the signal is aborted, returns copies, and serves the
seed in `stubData.ts`: user Ada Admin (administrator), org Demo Org, tenants Demo and Sandbox,
three Demo boards (the third has a long title) and none in Sandbox. Starred boards are kept in
`localStorage['pulsus-dash.stub.starred.<tenant>']` (Demo starts with `b-1`); unknown uids are kept
there and dropped by the sidebar. Test hook: a positive integer in
`localStorage['pulsus-dash.stub.failSession']` makes that many session calls fail with
`ApiError('network')`.

## Text and formatting (T08-027)

Every string is in `src/i18n/messages.en-GB.ts`; `t(id, values)` fills `{name}` placeholders and an
unknown id is a type error. `src/i18n/format.ts` is the only place `Intl` formatters are created
(locale en-GB, 24-hour time): `formatDate` (19 Nov 2026), `formatTime` (12:03:00), `formatRange`,
`formatRangeShort` (12:03 – 13:03 GMT), `formatZone` (Europe/London (GMT)) and `describeRange`.

## Adding a page or a search key

- **Page:** add the importer to `routeModules`, a route with `lazy` under `t/:tenant` in
  `createRoutes`, a sidebar item if it is a destination (with its route ids for `aria-current`),
  messages, and the page's checks: it must call `usePageTitle`, pass axe, and be operated by the
  keyboard script.
- **Search key:** never read it with `useSearchParams`. Add a typed reader and writer in
  `src/state/` beside `contextSearch.ts` (validate, default, canonicalise), call it from the tenant
  loader's normalisation, and add round-trip tests.

## Headers and CSP (T18-001, T18-004, ADR-0014 §9, ADR-0016)

`config/headers.ts` holds the production headers that `vite preview` sends and the BFF will send:
the ADR-0014 §9 CSP (`script-src 'self'`, `style-src 'self'`, Trusted Types required), COOP
`same-origin`, COEP `require-corp`, CORP `same-origin`, `nosniff` and the referrer policy. Asset
integrity is verified by the BFF before serving (ADR-0016); the browser loads no import map and no
per-module SRI. The build emits no inline script or style: React sets styles through CSSOM, and the
one rule React Aria would inject as an inline `<style>` (`touch-action` for pressable elements) is in
`styles/global.css` instead, with `main.tsx` marking it as installed. The dev server sends COOP and
COEP only. `e2e:csp-violations` checks every page and overlay for CSP and Trusted Types violations
and that the page is cross-origin isolated; `e2e:asset-origin` and `e2e:font-origin` check that
every request, fonts included, stays on the app origin.

## Limits

- No sign-in, BFF, real boards, charts, command palette, alert count or AI dock yet; starred boards
  are kept by the stub in the browser until the BFF stores them (#61).
- Recent boards are per browser, not per user.
- Day and week units are fixed 24 h and 7 × 24 h durations; only `now/d` and the calendar follow DST.
- Layouts are designed for desktop widths (1440 px reference); narrow layouts are later work.

## Design references

D9 ([designs README](../../designs/README.md)), [ADR-0014](../../designs/adr/0014-typescript-react-web-client.md),
[ADR-0016](../../designs/adr/0016-asset-integrity-verified-by-bff.md),
[ADR-0017](../../designs/adr/0017-react-router.md);
[02 Information architecture](../../designs/product/02-information-architecture.md) (IA-002, IA-015,
IA-016, IA-020, IA-021, IA-022, IA-023),
[03 Interaction model](../../designs/product/03-interaction-model.md) (INT-032),
[08 Visual language](../../designs/product/08-visual-language.md) (VL-001, VL-010, VL-017, VL-021),
[09 Performance contract](../../designs/product/09-performance-contract.md) (PRF-008, PRF-033);
[T01](../../designs/technical/T01-frontend-architecture.md) (T01-007, T01-008, T01-010),
[T02](../../designs/technical/T02-vis-engine.md) (T02-004),
[T03](../../designs/technical/T03-browser-runtime.md) (T03-013, T03-014, T03-017),
[T08](../../designs/technical/T08-dom-component-kit.md) (T08-005, T08-007, T08-008, T08-010, T08-022,
T08-023, T08-027), [T18](../../designs/technical/T18-security.md) (T18-001, T18-004).
