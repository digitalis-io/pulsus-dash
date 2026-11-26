# T08 — DOM rooms & component kit

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.13-rc · 2026-11-26 |
| **Milestone** | M-UI1 (React application: store, router, tokens, keymap, kit core, application layout) → M-UI2 (tree, viewport a11y mirror, dock host) → M-UI3 (Explorer, Atlas mirror) → M-UI5 (remapping room, presets, Board editor forms) → M-UI6 (WCAG 2.2 AA audit) |
| **Related ADRs** | [ADR-0014](../adr/0014-typescript-react-web-client.md) (supersedes ADR-0001, ADR-0002, ADR-0004), [ADR-0003](../adr/0003-wgpu-rendering.md) |
| **Source draft** | plans/tech/T08-dom-component-kit.md (not tracked) |

## 0. Applicability under ADR-0014 (2026-11-19)

The DOM layer is now TypeScript + React ([ADR-0014](../adr/0014-typescript-react-web-client.md)).
Where this document names a Rust crate or Leptos construct, read the TS module below. Component
designs, ARIA patterns, budgets and rules that are language-neutral stand.

| Was (Rust/Leptos) | Now (TS, under `client/src/`) | Notes |
|---|---|---|
| `dash-state` (store, reducer, undo) | `state/` (Context store, reducer, undo) | Pure reducer, unit-tested in Vitest; T08-004 stands |
| `dash-route` | `app/router.tsx` on React Router (data mode), typed search module `state/contextSearch.ts` ([ADR-0017](../adr/0017-react-router.md)) | T08-005 stands; T08-006 applies when cameras arrive |
| `dash-keymap` | `keys/` | T03-011, T03-012 stand |
| `dash-tokens` | `design/tokens.toml` → `styles/tokens.css`, `styles/tokens.ts` | T08-022 stands (DOM font vs MSDF check applies from the engine) |
| `dash-i18n` (Fluent, ICU4X) | `i18n/` (typed message catalogue; `Intl` formatters) | T08-027 revised |
| `dash-kit` (Leptos components) | `kit/` on React Aria Components | T08-007 to T08-010 stand; T08-012 hands over to the engine grid when it exists |
| `dash-a11y` | `a11y/` | T08-016 to T08-019 stand for engine canvases |
| `dash-shell` + bridge to core rings | the React application + the `ChartEngine` API | T08-001, T08-002 revised |
| Leptos build risk check (§4.10) | Withdrawn | — |
| Shell chrome (§4.3: 32 px top bar, Time Ribbon frame, logo menu, no sidebar) | Application layout ([ADR-0014](../adr/0014-typescript-react-web-client.md) §10; [02](../product/02-information-architecture.md) §3.1), rewritten in §4.3 | Satisfies rows for IA-016, IA-020, IA-021, SRF-001 and VL-017 follow the revised product text |

## 1. Context & problem

The product is "a space plus a few rooms" ([02 §3](../product/02-information-architecture.md)).
Charts and, later, the Space are drawn by the shared engine in a worker, one canvas per chart frame
([T01](T01-frontend-architecture.md)). The rooms are conventional, accessible DOM UIs (IA-015), and
DOM chrome surrounds or floats over the content: the sidebar and page header (§4.3), the Inspector,
the AI dock, tooltips, ⌘K and query editors. The DOM is a TypeScript + React application on React
Aria Components ([ADR-0014](../adr/0014-typescript-react-web-client.md), which supersedes the
Leptos decision of ADR-0004 and the framework ban of ADR-0002).

This document fixes:
- how the React application is structured (§0, §4.1);
- **who owns application state**: the TS Context store on the main thread, which the engine reads
  through the `ChartFrame` API and updates only through events (§4.2);
- the component kit;
- the cross-cutting DOM concerns: the a11y mirror for canvas views, IME, clipboard, tokens, keymap
  and i18n.

## 2. Goals / non-goals

**Goals**
- One authoritative state store in the TS application, read by components through selectors and
  passed to the engine as `ChartFrame` calls. No application state lives in the engine or its
  adapter.
- A component kit covering every DOM need in [02](../product/02-information-architecture.md)–[15](../product/15-estate-navigation.md),
  at enterprise quality: keyboard-complete, WCAG 2.2 AA, IME-correct and themeable from the shared
  tokens.
- Tables up to 10k rows with every cell type of [05](../product/05-visualisation-catalogue.md), at
  60 fps scroll.
- Hover tooltips attached to GPU marks within the input-to-photon budget (PRF-003, PRF-004).
- An accessible equivalent for every canvas view.
- The keyboard model of [03 §4](../product/03-interaction-model.md) exactly, with user remapping and
  presets.
- i18n infrastructure from day one, even if v1 ships English only.

**Non-goals**
- Server-side rendering or hydration. Dash is a CSR app; the first paint is the shell (PRF-008).
- Tables above 10k rows: that is the GPU text grid ([T02](T02-vis-engine.md)), which shares the
  `TableModel` defined here.
- The query editor internals ([T09](T09-query-editors.md)); this document hosts the editor as a
  component.
- The shim, worker topology and SharedArrayBuffer layout ([T03](T03-browser-runtime.md)).
- RTL layout of the canvas in v1. The DOM uses logical CSS properties so RTL rooms stay possible.

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [IA-015](../product/02-information-architecture.md#ia-015--rooms-are-conventional-accessible-dom) | §4.3, §4.4, §4.5, T08-007 | `a11y:axe-rooms` (Playwright + axe-core: 0 serious/critical in every room) and `e2e:keyboard-only-rooms` (every control reachable and operable by keyboard) |
| [IA-016](../product/02-information-architecture.md#ia-016--application-layout) | §4.3 (application layout) | `e2e:app-layout`: at 1440×900 the sidebar, the page header with the title left and the time range picker, refresh control and user menu right, and no other persistent chrome |
| [IA-020](../product/02-information-architecture.md#ia-020--time-range-in-the-page-header) | §4.3 (time range picker and refresh control) | `e2e:time-range-header` |
| [VL-017](../product/08-visual-language.md#vl-017--application-layout-dimensions) | §4.3, §4.7 (layout tokens) | `e2e:app-layout` (sidebar 240/56 px, header 56 px, padding 24 px, panel gap 16 px); `e2e:chrome-layout` (Ribbon 40 px and translucent in Space scenes, from M-UI3) |
| [SRF-001](../product/04-surfaces.md#srf-001--every-surface-uses-the-application-layout) | §4.3 (layout always mounted; Wall exception) | `e2e:chrome-every-surface`: each surface of Table 4-1 available at the build shows the sidebar and page header (time range picker on time-dependent surfaces; Ribbon on Atlas and Lens); Wall mode shows none |
| [IA-021](../product/02-information-architecture.md#ia-021--left-navigation-sidebar) | §4.3 (sidebar), §4.8 (`g` chords), §4.4.3 | `e2e:rooms-reachable`: the sidebar lists the build's destinations for the role and marks the current page; collapse persists; each destination opens from the sidebar, ⌘K and its `g` chord; `e2e:board-prefs`: Starred and Recent of one user appear in a fresh browser context, another tab hears a change at once and another context on its next visibility |
| [IA-002](../product/02-information-architecture.md#ia-002--context-is-the-one-state-every-view-reads) | §4.2 (`AppState.context`) | `unit:reducer-context`: every Context member change emits `ContextChanged` to all subscribed slices |
| [PRN-006](../product/01-vision-and-principles.md#prn-006--context-is-sticky) | §4.2, §4.3 (Context in `Route` and pivots) | `e2e:pivot-keeps-context` (T07/[T12](T12-entity-catalogue.md) co-own the translation) |
| [IA-022](../product/02-information-architecture.md#ia-022--deep-links-reproduce-the-view) | §4.3 (`Route` codec), T08-005 | `prop:route-roundtrip` (`parse(print(r)) == r`, fuzzed) and `e2e:deep-link-fresh-session` for each URL pattern |
| [IA-023](../product/02-information-architecture.md#ia-023--shared-links-pin-absolute-time) | §4.4 (date-time picker "copy link"), T08-015 | `e2e:copy-link-absolute`: "last 1 h" at 13:03 yields absolute 12:03–13:03; "keep relative" yields `now-1h` |
| [IA-024](../product/02-information-architecture.md#ia-024--compact-camera-encoding) | §4.3 (`CamCode`), T08-006 | `prop:camcode`: every camera mode encodes to ≤ 64 chars and decodes to a pose within 1 px |
| [IA-025](../product/02-information-architecture.md#ia-025--browser-history-is-camera-history) | §4.2 (URL from mirror), §4.8 | `e2e:history-camera`: three committed moves, back ×3 returns through each pose; `Alt+←` in the canvas does the same |
| [IA-026](../product/02-information-architecture.md#ia-026--context-propagation) | §4.2 (reducer, undoable actions) | `unit:context-propagation-table`: one scripted case per row of the 02 §5 table; brush then `⌘Z` restores the window |
| [INT-041](../product/03-interaction-model.md#int-041--undo-stack) | §4.2, T08-004 | `unit:undo-roundtrip` (undo ∘ do = id over generated action sequences) and `e2e:undo-context` (brush, filter, narrow, `⌘Z` ×3, `⌘⇧Z` ×3) |
| [INT-009](../product/03-interaction-model.md#int-009--keyboard-bindings) | §4.8 (binding table = 03 §4.2) | `e2e:keymap-table`: one automated input test per row of the 03 §4.2 table at its milestone build |
| [INT-010](../product/03-interaction-model.md#int-010--no-key-bound-to-two-actions-in-one-context) | §4.8, T08-024 | `ci:keymap-conflicts`: fails on a duplicate key in one context or an unmarked override, for the default table and every preset; `unit:remap-conflict-refused` |
| [INT-011](../product/03-interaction-model.md#int-011--tap-and-hold) | §4.8, T08-025 | `unit:tap-hold-250` and `e2e:floors-tap-hold` (`V` 100 ms flips, 400 ms shows both) |
| [INT-012](../product/03-interaction-model.md#int-012--chords) | §4.8, T08-025 | `unit:chord-timeout`: `g a` within 1 s opens Alerts; `g`, 1.2 s, `a` does nothing; `g` alone is unbound |
| [INT-014](../product/03-interaction-model.md#int-014--shortcut-overlay) | §4.8 (`?` overlay generated from active contexts) | `e2e:shortcut-overlay`: in the Atlas lists S, Est and 3D bindings and no Board binding; after a remap shows the new key |
| [INT-015](../product/03-interaction-model.md#int-015--keyboard-focus-is-never-trapped) | §4.5, T08-017 | `e2e:focus-regions`: `F6`/`Shift+F6` cycle sidebar → page header → page content → open panels (→ Time Ribbon in Space scenes); no region retains focus |
| [INT-017](../product/03-interaction-model.md#int-017--time-scrub) | §4.8 (holds: `Space` scrub) | `e2e:space-scrub` (render loop co-owned by T02/T03) |
| [INT-032](../product/03-interaction-model.md#int-032--window-step-and-zoom-keys) | §4.8 | `e2e:keymap-table` rows `[`, `]`, `-`, `=` (data served by T07 P4 flank) |
| [INT-033](../product/03-interaction-model.md#int-033--hover-tooltip) | §4.4.2, T08-013 | `bench:tooltip-latency`: median ≤ 1 frame and p99 ≤ 2 frames from hover input to tooltip paint, measured with frame ids, on (a) and (b) |
| [INT-037](../product/03-interaction-model.md#int-037--palette-covers-everything) | §4.4.3 (providers) | `e2e:palette-categories`: each category available at the build appears in one result list |
| [INT-038](../product/03-interaction-model.md#int-038--query-detection) | §4.4.3 (query provider via T09 detector) | `e2e:palette-query-detect`: `rate(`, `{app=`, `{ span.`, `process_cpu:` open the Metrics, Logs, Traces, Profiles workbench with the query |
| [INT-040](../product/03-interaction-model.md#int-040--palette-ranking) | §4.4.3 (ranking) | `unit:palette-ranking`: failing `checkout` outranks healthy `cart` on "c"; with Context on `cart`, `cart` ranks first |
| [VIZ-042](../product/05-visualisation-catalogue.md#viz-042--rows-are-selection-sources) | §4.4.1 (row click → `Action::Select`) | `e2e:table-row-selects`: clicking a pod row highlights its tile and opens the Inspector |
| [VIZ-054](../product/05-visualisation-catalogue.md#viz-054--markdown-and-html-are-always-sanitised) | §4.4.1 (Markdown), T08-011 | `unit:markdown-no-html`: `<script>` and `onerror=` input produce no element or attribute and a removal log entry; `fuzz:markdown-cell` |
| [VIZ-056](../product/05-visualisation-catalogue.md#viz-056--no-arbitrary-iframes) | §4.4, T08-009 | `ci:no-iframe`: the `security/no-iframe` rule over `client/src` and `client/e2e` finds no `iframe` element construction; `e2e:link-new-tab` |
| [VIZ-066](../product/05-visualisation-catalogue.md#viz-066--table-view-and-csv-for-every-vis) | §4.5 (`Shift+T`), §4.4.1 (CSV) | `e2e:table-view-csv`: `Shift+T` swaps every vis for a table of the same data; "Export CSV" downloads it |
| [VIZ-067](../product/05-visualisation-catalogue.md#viz-067--colour-is-never-the-only-channel) | §4.4 (state glyph cells and pills), §4.7 | `golden:greyscale-states`: every state distinguishable in greyscale DOM screenshots |
| [VL-001](../product/08-visual-language.md#vl-001--dark-first-themes-both-designed) | §4.7 (themes) | `golden:theme-tokens`: fresh session renders `canvas` `#0B0D10` and surfaces `#12151A`/`#191D24`; light theme (M-UI5) values come from the light token set |
| [VL-002](../product/08-visual-language.md#vl-002--neutral-series-palette-with-stable-identity-colours) | §4.7 (`series_colour` in `dash-tokens`) | `unit:series-colour-stable`: same identity → same palette index on DOM legend and GPU, across reloads |
| [VL-003](../product/08-visual-language.md#vl-003--state-colours-are-reserved-for-health) | §4.7 (state colours reserved) | `ci:token-usage`: state tokens used only by state components and marks |
| [VL-008](../product/08-visual-language.md#vl-008--cvd-safe-palettes-and-wall-high-contrast) | §4.7 (palette validator in the token build) | `ci:palette-validator`: CVD simulations pass for state and series palettes in both themes |
| [VL-010](../product/08-visual-language.md#vl-010--fonts) | §4.7 (fonts) | `e2e:fonts-self-hosted`: no third-party font request; `golden:tabular-numerals` |
| [VL-011](../product/08-visual-language.md#vl-011--canvas-text-matches-dom-text) | §4.7 (font hash check) | `ci:font-hash` (build fails if DOM and MSDF fonts differ) and `golden:canvas-dom-text` (≤ 1 px advance/baseline, T02 co-owns) |
| [VL-012](../product/08-visual-language.md#vl-012--numbers-for-humans) | §4.9 (ICU4X formatting layer) | `unit:format-humans`: 2 843 ms → `2.84 s`; 1 204 req/s → `1.2k rps`; 38 000 €/h → `€38k/h`; relative time with absolute on hover |
| [VL-013](../product/08-visual-language.md#vl-013--density-modes) | §4.7 (density) | `golden:density`: Compact and Comfortable change type and spacing on DOM and canvas; Engineer Perspective starts Compact |
| [VL-015](../product/08-visual-language.md#vl-015--no-spinners-on-data) | §4.4 (skeleton, shimmer; no data spinner) | `e2e:no-spinner`: with a 1 s server delay no spinner is present; the shimmer appears after 300 ms and clears on refine |
| [VL-016](../product/08-visual-language.md#vl-016--reduced-motion) | §4.5 (reduced motion) | `e2e:reduced-motion`: with `prefers-reduced-motion: reduce` DOM transitions are instant and the render worker receives the reduced-motion pref |
| [VL-019](../product/08-visual-language.md#vl-019--layout-grid) | §4.7 (spacing tokens on a 4 px grid) | `ci:layout-grid`: kit CSS uses only spacing tokens (multiples of 4 px), 8 px gutters, 6 px radius, 1 px hairline |
| [VL-020](../product/08-visual-language.md#vl-020--fixed-glyph-language) | §4.4 (glyph and icon set from tokens) | `ci:single-icon-set`: every icon reference resolves to the one line set; glyph meanings come from the token table |
| [VL-021](../product/08-visual-language.md#vl-021--one-token-source-for-canvas-and-dom) | §4.7, T08-022 | `ci:hardcoded-colour`: fails on any colour literal outside generated outputs; `golden:accent-change` |
| [VL-022](../product/08-visual-language.md#vl-022--component-and-mark-libraries-share-the-tokens) | §4.4, §4.7, T08-007 | `ci:token-usage`: kit components reference only generated token outputs |
| [PRF-005](../product/09-performance-contract.md#prf-005--no-main-thread-long-tasks-during-interaction) | §4.2, §4.4.1, §7 | `bench:rooms-long-tasks`: 0 main-thread tasks > 16 ms during scripted room interactions |
| [PRF-008](../product/09-performance-contract.md#prf-008--cold-load-to-interactive-shell) | §4.3 (shell first), §7 | `e2e:cold-load-shell` p75 < 1.0 s to `⌘K` accepted (T03 co-owns) |
| [PRF-009](../product/09-performance-contract.md#prf-009--core-bundle-size-and-lazy-loading) | §4.1, §4.3 (lazy route chunks) | `ci:bundle-size` per chunk class ([ADR-0014](../adr/0014-typescript-react-web-client.md) §8); `e2e:lazy-load` (cold load fetches no room or workbench chunk) |
| [PRF-033](../product/09-performance-contract.md#prf-033--bundle-size-and-dom-room-gates) | §7 | `ci:bundle-size` and `bench:inp-rooms` (a room above 200 ms fails the reference-lab gate; on shared CI runners the check reports a warning until the reference lab exists (#68); target 100 ms) |
| [ENT-003](../product/11-enterprise.md#ent-003--built-in-roles) | §4.4 (permission-aware controls), §8 | `e2e:viewer-ack-disabled`: Viewer sees Ack disabled with "request access" |
| [SRF-063](../product/04-surfaces.md#srf-063--admin-rooms) | §4.3 (Admin room satellite), §4.4 (forms) | `e2e:admin-oidc-bind-datasource`: at M-UI6 (D12) an Admin signs in via OIDC and binds a PulsusDB instance through the Admin room |
| [ENT-010](../product/11-enterprise.md#ent-010--no-dead-access-denied-pages) | §4.4 (restricted placeholder), T08-028 | `e2e:restricted-board-link`: a link to an unreadable board shows the placeholder with "Request access" and no title |
| [INT-013](../product/03-interaction-model.md#int-013--remappable-bindings-and-presets) | §4.8 (presets, physical keys, layout labels), T08-026 | `e2e:remap-persist` (remap `F`→`Z` persists across devices) and `e2e:layout-de` (German layout `Shift+1` saves waypoint 1) |
| [INT-016](../product/03-interaction-model.md#int-016--esc-and-enter-ladder) | §4.8 (`Esc`/`Enter` commands) | `e2e:esc-ladder` |
| [INT-034](../product/03-interaction-model.md#int-034--click-selects-and-opens-the-inspector) | §4.4 (Inspector) | `e2e:inspector-sections` |
| [VL-018](../product/08-visual-language.md#vl-018--floating-dockable-panels) | §4.4 (dock host) | `e2e:dock-persist`: docking the Inspector left and floating the query editor persists after reload |
| [VIZ-040](../product/05-visualisation-catalogue.md#viz-040--table-cell-types) | §4.4.1 (`CellKind`) | `golden:table-cells`: one fixture per cell type of Table 5-7 |
| [VIZ-041](../product/05-visualisation-catalogue.md#viz-041--table-interactions) | §4.4.1 (sort, filter, group, footer, copy, export) | `e2e:table-interactions-5k` |
| [EST-032](../product/15-estate-navigation.md#est-032--explorer-is-the-accessible-equivalent) | §4.5 (Explorer is the mirror target) | `e2e:explorer-keyboard-actions` ([T12](T12-entity-catalogue.md) co-owns Explorer content) |
| [VIZ-068](../product/05-visualisation-catalogue.md#viz-068--screen-reader-summary-per-viewport) | §4.5 (`A11ySummary`) | `a11y:sr-summary`: the checkout p99 viewport exposes the metric, entity, change, onset, current value and baseline ratio |
| [VL-009](../product/08-visual-language.md#vl-009--accessible-contrast-in-both-themes) | §4.7, §10 | `a11y:contrast-both-themes` and the M-UI6 external audit |

## 4. Design

### 4.1 Crates and modules

*Superseded (ADR-0014): the modules are the TS modules of §0 under `client/src/`, all on the main
thread; heavy rooms are lazy route chunks. The Rust crate tree below is kept for the record of what
each module does; `dash-kit`, `dash-a11y` and `dash-shell` (Leptos) are withdrawn.*

```
crates/ui/
├─ dash-state      AppState, Action, reducer, undo stack, selectors       → linked by dash-core (render worker)
├─ dash-route      Route enum ⇄ URL codec (02 §4), camera codec           → core (derive URL) + shell (popstate)
├─ dash-keymap     key normalisation, contexts, chords, holds, presets,   → core (authoritative) + shell (editable subset)
│                  conflict detector, generated 03 §4.2 table
├─ dash-tokens     generated from design/tokens.toml: Rust consts + CSS   → core (GPU) + shell (CSS)
├─ dash-i18n       Fluent bundles, ICU4X formatters, locale negotiation    → core (GPU text) + shell
├─ dash-kit        Leptos components (§4.4)                               → dash-shell.wasm (main)
├─ dash-a11y       mirror DOM, live-region scheduler                       → dash-shell.wasm
└─ dash-shell      main-thread entry: mounts Leptos, bridge to the T03 core⇄ui rings, history, clipboard
```

Under ADR-0014, `state/`, `routes/` and `keys/` have no DOM dependencies and carry most of the
Vitest unit tests. Heavy rooms (Admin, alert authoring, the Boards editor) are lazy route chunks,
absent from the initial download (PRF-009).

### 4.2 State ownership: one store in the TS application

*(Rewritten 2026-11-19, ADR-0014 §2; previously the store lived in the render worker and a Leptos
shell held a mirror.)* The hard question is who owns what when the same selection is visible in a
DOM table, as a chart highlight and in the URL. **The authoritative store is the TS application's
Context store on the main thread.** The engine draws from what the store gives each `ChartFrame` and
reports gestures back as events:
- **Semantic state** (route, Context, selection, committed camera, undo, prefs) lives in the store.
- **Hot state** (live camera during a gesture, hover, scrub cursor) is the engine's render-local
  state, and is not "stored" until a `commit` event.
- **Component-local UI state** (open dialogs, palette text, form drafts, dock geometry while
  dragging) stays in its React component.
- **Bulk data never enters the store.**

```
   main thread: React application (TS)                       engine worker (from the engine issue)
 ┌──────────────────────────────────────────────┐          ┌───────────────────────────────────────────┐
 │ kit components ── intents ──► store.dispatch │          │ render-local: gesture camera, hover,      │
 │    ▲          reduce(action) → delta, undo    │ChartFrame│   scrub cursor · scene, LOD, picking,     │
 │    │ selectors ◄── store ── setSpec/setData/ ─┼─────────►│   frame loop · one canvas per ChartFrame  │
 │    │                      setTimeWindow       │          │                                           │
 │    │ events ◄── adapter ◄─────────────────────┼◄─events──│ commit · brush · select · hover · a11y    │
 │ history.push/replaceState ◄── on commit       │          └───────────────▲───────────────────────────┘
 └──────────────────────────────────────────────┘   input ring (adapter) ───┘   data workers → SAB
```

Until the engine lands, the `Canvas2DEngine` implements the same `ChartFrame` API on the main thread
(ADR-0014 §4), so the store and its rules do not change when the engine arrives.

| State | Owner | Projections | Update rate |
|---|---|---|---|
| Context (entity set, window, filters, baseline, A/B) | TS store | components, `ChartFrame.setTimeWindow`/spec, URL, BFF session ([T07](T07-scene-query-planner.md)) | on change; URL on commit |
| Route / room / focused viewport | TS store (router) | components, URL | on navigation |
| Camera | engine during a gesture; the store holds the committed camera and history | URL (`cam=`), minimap | committed at gesture end (`commit` event); minimap ≤ 10 Hz while flying |
| Selection (entities, series, spans, rows) | TS store | tables, Inspector, frame highlight via spec | `select` event or DOM intent |
| Hover | engine (it does the picking) | tooltip only; never in history | `hover` event, at most one per frame |
| Time cursor during `Space` scrub | engine | Time Ribbon readout | ≤ 60 Hz, committed on release |
| Viewport data (columns) | engine data workers (SAB); JSON frames for the interim renderer | nothing in components except `A11ySummary` and table pages | — |
| Layout positions | layout worker (T14 (draft)) | render worker (shared memory) | — |
| Prefs, keymap, theme | TS store | components, engine (`setTheme`), Postgres via BFF (`/api/dash/v1/prefs`) | on change |
| Dialogs, palette input, form drafts, toasts | **component-local** | IndexedDB (drafts) | — |
| Remote collaborator actions | TS store (`Remote` action) | — | T17 (draft) |

- **Reducer.** `reduce(state, action) → { state, delta, inverse }` is pure and synchronous, and runs
  on the main thread. Actions are the set sketched in §0's `state/` row: window set, brush, step and
  zoom; filter add/remove; narrow; baseline; select; navigate; camera committed, back and forward;
  Board edit; undo/redo; prefs; remote.
- **DOM → store.** A DOM intent (remove a filter chip, pick a date range, click a table row) is a
  dispatched action.
- **Engine → store.** Engine events (`commit`, `brush`, `select`) are dispatched as actions; the
  engine never changes the Context itself (T08-001).
- **Store → engine.** Each `ChartFrame` receives its slice of the new state (`setTimeWindow`,
  `setSpec`, `setTheme`) after a delta that touches it.
- **URL.** The store derives the URL: `history.replaceState` for camera commits (debounced 250 ms),
  and `pushState` for semantic moves (dive, `Esc`, ⌘K jump) and committed camera moves that enter
  camera history. `popstate` dispatches `Navigate(route)`, and the engine flies the camera to the
  restored committed camera ([02 §4](../product/02-information-architecture.md)).

#### T08-001 — One store
**MUST** — *(Revised 2026-11-19, ADR-0014 §2.)* Semantic state MUST have exactly one owner, the TS
Context store. Components MUST read it through selectors, and the chart engine MUST receive it as
commands and report changes as events, never holding its own copy of the Context.

#### T08-002 — No state in the engine adapter
**MUST** — *(Revised 2026-11-19, ADR-0014.)* The engine adapter MUST hold no application state; it
forwards bytes, events and commands only (T01-001).

#### T08-003 — No bulk data on the main thread
**MUST** — Viewport data MUST NOT be copied to the main thread except as `A11ySummary` records and
the visible page of a kit table (≤ 10k rows).

#### T08-004 — Undo has one owner and covers Context and Board edits
**MUST** — Undoable actions (every Context change: brush, window step and zoom, filter add/remove,
entity narrow, baseline; and every Board edit) MUST push an inverse onto one bounded stack of 256
entries in the TS store. `⌘Z`/`⌘⇧Z` MUST undo and redo them in order (INT-041). Text inputs keep their own
typing history (INT-010 override).

### 4.3 App structure, rooms, chrome and routing

`dash-route` defines `Route` as a typed projection of the [02 §4](../product/02-information-architecture.md)
URL model. It does not use `leptos_router`, because our URL is mostly *state* (Context and camera)
rather than pages. The router is about 600 lines: parse, serialise, and the `popstate` binding.

```rust
pub enum Route {
    Space   { tenant: TenantId, scene: SceneRef, ctx: ContextQuery, cam: Option<CamCode>, persp: Option<PerspectiveId>, view: Option<EstateView>, layer: Option<Layer> },
    Explore { tenant: TenantId, signal: Signal, queries: QueryList, ctx: ContextQuery },   // /t/{tenant}/explore/{signal} (02 §4)
    Boards  { tenant: TenantId },                                               // /t/{tenant}/boards
    Board   { tenant: TenantId, uid: BoardUid, vars: VarMap, ctx: ContextQuery, vp: Option<ViewportId> },
    Investigation { tenant: TenantId, id: InvId, evidence: Option<EvidenceIdx> },
    Incident { tenant: TenantId, incident: IncidentId },                       // /t/{tenant}/incident/{id}: the Alert Lens
    Alerts  { tenant: TenantId, view: AlertsView, q: AlertsQuery },            // map | topology | city | infra | segments | list | timeline
    Room    { tenant: TenantId, room: RoomKind, path: RoomPath },               // boards library, admin, prefs…
}
```

- The **application layout** is always mounted (SRF-001; [02](../product/02-information-architecture.md)
  §3.1, [ADR-0014](../adr/0014-typescript-react-web-client.md) §10): the left navigation sidebar
  (240 px, collapsible to a 56 px icon rail; IA-021), the page header (56 px: page title or
  breadcrumb on the left; ⌘K entry, alert count and AI dock toggle once they exist, the time range
  picker, the refresh control and the user menu on the right; IA-016, IA-020), the page content
  (24 px padding), the dock host and the overlay host (tooltips, palette, dialogs, toasts). Sidebar
  and header are opaque `surface-1` with a `hairline` edge (VL-017). Wall mode hides them.
- The **sidebar** lists the destinations that exist at the build and that the user's role may open
  (Boards; Explore → Metrics, Logs; Alerts and Investigations when they exist; Admin for
  administrators) and marks the current route. Its collapsed state is a user preference (`Prefs`).
  Starred and Recent come from `/api/dash/v1/me/starred-boards` and `/me/recent-boards` (five), per
  user; each view is sent with the client's navigation time. Recent follows navigation order within
  one app instance (stamps are monotonic per app); across browsers or app instances the order is
  best effort and subject to clock skew; ties on an equal timestamp are broken by the later write;
  clamped views use the server transaction start time (`now()`), best effort. A timed-out or
  ambiguous view triggers one reconciling refetch 15 s after the send.
- The **user menu** holds preferences (theme, density, time zone), the Perspective switcher once
  Perspectives exist, and sign-out.
- **Space routes** (Atlas, Lens) render the scene in the page content, with the minimap and the
  40 px Time Ribbon translucent over the canvas (IA-028).
- **Navigation** is client-side; the view left stays cached (TanStack Query cache and, for Space
  scenes, the engine), so "back" is instant (IA-014).
- **Admin rooms** (SRF-063) are kit forms in the admin satellite. They arrive with authentication
  at M-UI6 (D12), covering the PulsusDB datasource binding (with the T06 connectivity check as an
  async validator) and the OIDC IdP settings; later rooms land with their features. Until then
  there is no sign-in: every request runs as the fixed local principal and the binding is the one
  seeded by `migrate` (T06 §4.11). Login itself will be the IdP's page; Dash adds no login form of
  its own.
- **Code splitting.** Each heavy room is its own lazily loaded wasm module where T03's split
  mechanism allows. Otherwise it is feature-gated out of the mobile build (T20 (draft)).
- **Read-only banner.** When the BFF reports Postgres unavailable (`503` on writes,
  [T06](T06-bff-architecture.md) §4.5), the shell shows a persistent, non-modal banner "Read-only:
  configuration store unavailable", forms disable submit with that reason, and drafts are kept.

#### T08-005 — The URL reproduces the view
**MUST** — Every `Route` MUST round-trip through the URL (`parse(print(r)) == r`), and the URL MUST
carry everything needed to reproduce the Context, scene, focused viewport and camera for another
user with the same access (IA-022).

#### T08-006 — Compact camera code
**MUST** — `CamCode` MUST be base64url of a versioned packed struct of at most 48 bytes, so the `cam`
value is ≤ 64 characters for every camera mode, and decoding it MUST restore the pose within one
pixel at the same viewport size.

### 4.4 The component kit (`dash-kit`)

| Component | Design | ARIA pattern |
|---|---|---|
| **Table** (≤ 10k rows) | §4.4.1 | `grid` (interactive) or `table` (read-only) |
| **Tree** (virtualised) | Flattened visible-node index over a lazy `TreeModel`. Expand or collapse is O(k) for k revealed rows; children load asynchronously from the catalogue ([T12](T12-entity-catalogue.md)) with a skeleton row. Re-rootable by ownership dimension ([15](../product/15-estate-navigation.md)). Target: 100k nodes, 1M via lazy load | `treegrid` |
| **Forms & validation** | `FormModel<T>` with `FieldSpec { id, label_key, kind, validators, async_validator }`. Sync validators run on input; async ones (uniqueness, query validity via T09, datasource connectivity via T06) are debounced 250 ms and cancellable. Server errors map to fields by JSON pointer from the T06 error envelope. An error summary appears on submit | native form controls |
| **Date-time / range picker** | Absolute, relative (`now-1h`, `-7d`, `now/d`) and "before deploy ◆" anchors. The expression grammar is in `state/` so the header time range picker, the Time Ribbon (Space scenes) and the URL share it. A tz-aware calendar grid uses `chrono-tz` (lazy, shared with [T02](T02-vis-engine.md)). Quick ranges, keyboard date entry, and "Copy link" with "keep relative" (§4.4.4) | `dialog` + `grid` |
| **Select / combobox** | ARIA 1.2 combobox with async options, a virtualised listbox (10k options), multi-select pills and creatable values. Fuzzy matching uses `nucleo-matcher`, shared with ⌘K (MPL-2.0: cargo-deny allow-list, see [T18](T18-security.md)) | `combobox` + `listbox` |
| **Dialogs & sheets** | Native `<dialog>` with `showModal()` gives the focus trap, `inert` background and `Esc` for free. Sheets are non-modal side panels (the Inspector and AI dock use the dock host) | `dialog` / `complementary` |
| **Toasts** | Queue of at most 3 visible, 6 s default, paused on hover or focus, and never the only carrier of an error that needs action (those stay inline). Announced through the live-region scheduler (§4.5) | `status` / `alert` |
| **Command palette ⌘K** | §4.4.3 | `combobox` in a `dialog` |
| **Inspector** | Floating, dockable, collapsible panel ([03](../product/03-interaction-model.md) INT-034), driven by `Selection`: labels/attributes, raw values, the underlying query (T09 highlighter, editable ✎), pivot chips, and actions (Pin to investigation, Create alert, Ask AI). Pinned and multiple inspectors in Correlate. The host, payload, selection, Esc ladder, pivots and look are [T25](T25-inspector-and-pivots.md); the dock host (VL-018) is not part of T25 | `complementary` region |
| **Tooltips anchored to GPU marks** | §4.4.2 | `tooltip` (hover) or non-modal `dialog` (pinned) |
| **Dock host** | IDE-style docking for the Inspector, AI dock and query editor (VL-018): split tree of `DockNode`s, drag handles, persisted per user per Perspective in `Prefs` | `region`s with headings |
| **Restricted placeholder** | Replaces any object the principal cannot read: neutral shape, no title, "Request access" button that calls the T06 action API to notify the owning team (ENT-010). Disabled controls for missing permissions carry the same link (ENT-003) | `region` + `button` |
| **Progress shimmer** | Thin edge shimmer on a viewport or list, shown only after a load has taken > 300 ms; there is no spinner component for data (VL-015) | `aria-busy` on the region |
| **Basics** | Button, icon button (24×24 minimum target, WCAG 2.5.8), tabs, menu, switch, slider, splitter, badge, entity chip, state glyph (shape + colour + text, VIZ-067), pill, skeleton, empty-state, kbd hint, banner | standard patterns |

**M-UI1 board editor (#61 Part B, #90).** The panel editor is a modal dialog (`dialog` "Edit
panel"), centred and of fixed size (800 × 720 px, capped to the viewport), over the dimmed board: a
live preview of the panel at the top, drawn through the same `ChartFrame` path and query as the
board panel, then Title, Query language, Query and Visualisation, every change applied to the draft
at once, field errors from a save under their controls (T08-008); a title change shows in the
preview within one frame; a visualisation, query or language change updates it at once, with the
result if already loaded, otherwise Loading until the result arrives, and the panel's error state
if the load fails; it contains focus while open, `Esc`, Done or a click outside closes it, and
focus returns to the panel's Panel menu button (T08-017). The keyboard path for grid moves is a
per-panel **Move or resize** button: arrows move the panel one cell, `Shift`+arrows resize it; the
result, or "blocked", is announced through a polite live region (T08-018). Pointer drag and resize
follow the same rule: no panel pushes another and no gap closes. The board keys are `Shift+E` (Edit
mode on; in Edit, Done; not in text fields, dialogs or menus) and `Mod+S` (save, in Edit mode, from
any target); neither collides with the window keys (T08-024).

#### T08-007 — Kit components are tokenised, keyboard-complete and labelled
**MUST** — Every `dash-kit` component MUST take colours, sizes, radii and durations only from
`dash-tokens` outputs, MUST implement its ARIA pattern from the table above, MUST be fully operable
from the keyboard, and MUST have a native golden test and an axe scan (§10). Rooms MUST be built only
from kit components (VL-022).

#### T08-008 — Native form controls
**MUST** — Text, password, number and date entry MUST use native `<input>`/`<textarea>` elements
with correct `autocomplete`/`inputmode`, so autofill and password managers work. Errors MUST be
exposed with `aria-invalid` + `aria-describedby`, and forms MUST NOT ask for the same data twice
(WCAG 3.3.7).

#### T08-009 — No iframes
**MUST** — No kit component MAY embed an `<iframe>` of an arbitrary site. External content is shown
as a link that opens in a new tab with `rel="noopener noreferrer"` (VIZ-056).

#### T08-010 — Target size
**MUST** — Every interactive target MUST be at least 24×24 CSS px (WCAG 2.5.8).

#### 4.4.1 Table

```rust
pub struct TableModel {
    pub columns: Vec<ColumnSpec>,            // id, header key, CellKind, width, frozen, sort, filter, footer calc
    pub source: RowSource,                   // Local(Arc<RecordBatch>) | Paged(PageFetcher) | Engine(T13 handle)
    pub view: RowView,                       // sorted+filtered permutation: Vec<u32>, grouping tree
    pub selection: RowSelection,             // linked to AppStore Selection
}
pub enum CellKind {
    Auto, ColouredText, ColouredBackground { gradient: bool, whole_row: bool },
    Gauge { mode: GaugeMode /* Basic | Gradient | Lcd */ }, Sparkline, Json, Pills,
    Markdown, Image, DataLink(LinkTemplate), ActionButton(ActionRef),
    // Pulsus additions (05 Table 5-7)
    EntityChip, StateGlyph, MiniHeatmap, DeltaVsBaseline, PivotChips,
}
```

- **Virtualisation.** Fixed-height rows are the fast path: offset = i × h. With text wrap on, a
  Fenwick tree over measured row heights gives O(log n) offset ↔ index lookups. The window is the
  visible rows plus 10 overscan rows (about 60 rows mounted), and row DOM nodes are recycled by key.
  Frozen columns use `position: sticky`. *v1 note (#66 Part B):* the M-UI1 log stream is not this
  table: it virtualises its DOM list with `@tanstack/react-virtual` over a slice of at most
  200 000 rows of its buffer (fixed 20 px rows; rows measured with wrap), re-sliced at rest by an
  explicit anchor ([docs: Log stream](../../docs/client/logs.md)).
- **Cell rendering.** Each kind is a small React component:
  - **Sparkline and mini-heatmap:** inline SVG built in TS from points pre-decimated to the cell
    width (≤ 120 points), so 60 visible rows × 2 columns is about 15k SVG path bytes. No canvas per
    cell.
  - **Gauge:** CSS width percentage plus a token colour. LCD mode uses `repeating-linear-gradient`.
  - **JSON:** lazily parsed JSON with an expandable tree.
  - **Markdown:** a Markdown parser's events rendered straight into React nodes, never through HTML (T08-011).
  - **Image:** `<img>` constrained by CSP `img-src` ([T18](T18-security.md)).
  - **Data link:** template expansion with URL-component escaping, `rel="noopener noreferrer"`,
    `target="_blank"`.
  - **Action button:** dispatches an audited action through the BFF action API
    (`/api/dash/v1/actions`). It never calls raw HTTP.
- **Sort, filter and group** on ≤ 10k rows run locally on the permutation vector: multi-key sort
  about 2 ms for 10k rows in wasm, filters (contains, regex via `regex`, comparison, expression via
  T13's expression evaluator). Footer calculations (sum, mean, p95) run on all or filtered rows.
  Larger `Engine` sources push sort and filter into the local engine (T13 (draft)).
- **Row click** emits `Action::Select` with the row's entity or span key, so the scene highlights it
  exactly as a mark click does (VIZ-042).
- **Copy** as TSV or Markdown goes through the clipboard (§4.6). CSV export is local (the current
  filtered view); Parquet export goes through the BFF (`/api/dash/v1/export`), so the wasm stays free
  of the `parquet` crate.

#### T08-011 — Markdown cannot produce HTML
**MUST** — The Markdown renderer MUST drop every `Html` and `InlineHtml` event, never pass it through,
and MUST record each removal in the viewport's diagnostics log (VIZ-054). Link destinations MUST be
`http`, `https` or `mailto`; image sources MUST pass the CSP allow-list. There is no separate
sanitiser to get wrong.

#### T08-012 — Large tables hand over to the GPU grid
**MUST** — When a table source exceeds 10k rows, the same `TableModel` (columns, sort, filters,
selection) MUST be handed to the GPU text grid ([T02](T02-vis-engine.md)) with a notice, and column
state MUST survive the switch.

#### 4.4.2 Tooltips anchored to GPU marks

The render worker picks the mark (O(1) ID-buffer read, [T02](T02-vis-engine.md)) and sends the T03
`TooltipAnchor` record. This document fixes its payload:

```rust
pub struct TooltipAnchor {
    pub viewport: ViewportId, pub mark: MarkId, pub frame: u64,
    pub anchor_css_px: [f32; 2], pub mark_rect: [f32; 4],    // canvas-relative CSS px
    pub payload: TooltipPayload,  // small: formatted values (already unit-formatted), labels, delta vs baseline
}
```

- **Latency path.** The worker posts the anchor immediately after picking, *before* encoding its
  frame. The shell applies the newest anchor in its own `requestAnimationFrame` callback: one reused
  tooltip element updated with `transform: translate3d`, with Floating-UI-style placement (flip,
  shift, arrow) implemented in Rust in about 150 lines. There is no layout read beyond one cached
  `getBoundingClientRect` of the tooltip, refreshed only when its content changes. When the anchor
  arrives before the shell's rAF for the same display frame, the tooltip composites with the GPU
  crosshair in that frame; otherwise it lands one frame later.
- **Pinned tooltips** become non-modal dialogs. Their text is selectable, they are focusable, and
  they track the mark through `Command::TrackMark`, so the worker keeps reporting their anchor at
  ≤ 30 Hz while the camera moves.
- **Inspector anchors** use the same mechanism, drawing a leader line on the GPU from the mark to
  the panel edge.
- Where an interaction has no meaning for the hovered vis, the payload says why (VIZ-003), and the
  tooltip shows it.

#### T08-013 — Tooltip latency
**MUST** — The hover tooltip (value, labels, Δ vs baseline; INT-033) MUST paint with median ≤ 1 frame
and p99 ≤ 2 frames from the hover input, matching PRF-003 and PRF-004. If the risk check (§4.10)
shows the DOM path cannot meet the median, the hover tooltip MUST be drawn by the render worker as
GPU text, with the DOM element kept for pinned tooltips and the accessibility mirror.

#### 4.4.3 Command palette

There are six providers behind one `PaletteProvider` trait
(`fn query(&self, q: &str, cx: &Context) -> ProviderResults`), each enabled from the milestone at
which its objects exist (INT-037):
- entities: the local catalogue index, then BFF search (M-UI2);
- boards, investigations, alerts and waypoints: local recent items, then BFF
  `/api/dash/v1/search` (from their milestones);
- rooms and navigation: every room and `g` destination (M-UI1);
- actions: the keymap's command registry, so every command is discoverable and shows its binding
  (M-UI1);
- queries: [T09](T09-query-editors.md) language detection on the first tokens (`rate(`, `{app=`,
  `{ span.`, `process_cpu:`), which opens the matching workbench with the query (INT-038);
- natural language: the `?` prefix or a fallback, sent to the AI (T15 (draft), M-UI4).

Ranking is `fuzzy_score × (1 + w_r·recency + w_a·anomaly_score + w_c·context_affinity)`, where
`context_affinity` is 1 for items in or adjacent to the current Context's entity set (INT-040).
Local providers answer within the same frame (≤ 4 ms). Remote results merge as they arrive (≤ 150 ms
p50). Pasting a Dash URL resolves it to its view.

#### T08-014 — Remote results never move the cursor
**MUST** — Palette results that arrive after the first paint MUST NOT reorder items at or above the
keyboard cursor; they append below, or replace only below the highlighted row.

#### 4.4.4 Shared links

"Copy link" (page header, Inspector, date picker) serialises the current `Route`. By default it converts
a relative window (`now-1h`) to absolute `from`/`to`; a "keep relative" checkbox keeps it relative
(IA-023).

#### T08-015 — Copy link pins absolute time by default
**MUST** — "Copy link" MUST convert relative time to absolute timestamps unless the user selects
"keep relative".

### 4.5 Accessibility mirror for canvas views (WCAG 2.2 AA)

A canvas is opaque to assistive technology, so every GPU viewport gets a **mirror**: a Rust-managed
DOM subtree, visually hidden (clip pattern), positioned over the viewport.

```
<section role="region" aria-label="p99 latency · checkout" aria-describedby="vp7-sum">
  <p id="vp7-sum">p99 latency, checkout, rose from 0.4 s to 2.8 s at 12:22, currently 2.1 s, 7× baseline.</p>
  <div role="listbox" aria-label="Marks, worst first" aria-activedescendant="vp7-m3" tabindex="0">
     <div role="option" id="vp7-m1">checkout-2xq: 2.84 s, Failing</div> …   (top-N, virtualised)
  </div>
  <button>Show as table (Shift+T)</button>
</section>
```

- **Summaries.** The vis spec ([T02](T02-vis-engine.md)) implements `Describe`, which produces an
  `A11ySummary` (headline, trend, extremes, state counts, top-N items) *in the worker that holds the
  data*. Only that small struct is posted to the main thread. It is re-sent at most once per second,
  and only when the headline changes (VIZ-068 from M-UI6; the infrastructure ships at M-UI2).
- **Keyboard focus on marks.** `Tab`/`Shift+Tab` inside a focused canvas cycle selection through
  entities or series in view by care score, worst first ([03 §4.2](../product/03-interaction-model.md),
  M-UI2). The mirror listbox drives `aria-activedescendant`, and `Command::FocusMark` draws a GPU
  focus ring that meets 2.4.11 (Focus Not Obscured) and 1.4.11 (non-text contrast ≥ 3:1).
- **Table view.** `Shift+T` swaps the focused viewport for a kit Table over the same data, at full
  parity, with "Export CSV" (VIZ-066). VIZ-066 is M-UI1, so `Shift+T` ships at M-UI1 although the
  03 key table lists it at M-UI2 (§13 Q2).
- **Atlas and estate views.** The mirror lists the worst-N entities and links to **Explorer**, which
  is the full accessible equivalent of all six estate views (EST-032).
- **Dragging alternatives (2.5.7).** Brush, lasso and box-zoom have keyboard and single-pointer
  equivalents that add no keys to the 03 table: the window is set by typing a range in the picker or
  by `[`/`]`/`-`/`=`; a "Brush" ⌘K action enters a click-start/click-end mode; lasso is "select all in
  view matching filter" in ⌘K. (The draft's `Alt+←/→` brush is dropped: 03 binds `Alt+←/→` to camera
  history.)
- **Live regions.** One `polite` and one `assertive` region are fed by a scheduler that rate-limits
  announcements (at most 1 every 2 s for polite, coalesced) and dedupes. Alert transitions on the
  current Context use `assertive` for Failing, and `polite` otherwise.
- **Reduced motion and forced colours.** `prefers-reduced-motion` makes DOM transitions instant and
  is forwarded to the render worker for instant camera cuts (VL-016, PRF-007).
  `forced-colors: active` switches the DOM to system colours and tells the render worker to use the
  high-contrast token set.
- **Other WCAG 2.2 additions:** 2.4.11 sticky chrome never covers the focused element (the dock host
  scrolls focus into view); 3.2.6 help is in a consistent place (avatar menu); 3.3.8 login relies on
  the IdP and Dash adds no cognitive test ([T06](T06-bff-architecture.md) §4.11).

#### T08-016 — Every GPU viewport has a mirror
**MUST** — Every GPU viewport MUST have a mirror region with an accessible name, a summary and a
focusable list of its top marks. The mirror MUST be visually hidden by clipping, never by
`display: none` or `visibility: hidden`.

#### T08-017 — Focus is never trapped
**MUST** — `F6`/`Shift+F6` MUST move keyboard focus to the next/previous region (sidebar, page
header, page content, open panels, and the Time Ribbon in Space scenes) from every context, including the canvas, where `Tab` cycles selection
(INT-015). After the last mark, `Tab` MUST leave the canvas. Only modal dialogs MAY contain focus,
and `Esc` MUST close them.

#### T08-018 — Announcements are rate-limited
**MUST** — Live-region announcements MUST go through the scheduler: polite at most one per 2 s,
coalesced and deduplicated; assertive only for Failing transitions on the current Context.

#### T08-019 — Reduced motion and forced colours
**MUST** — `prefers-reduced-motion: reduce` MUST make every DOM transition instant and MUST be
forwarded to the render worker; `forced-colors: active` MUST switch the DOM to system colours and the
render worker to the high-contrast token set.

### 4.6 IME and clipboard

- **All text entry is real DOM** (`<input>`, `<textarea>`, or the T09 editor's textarea). The
  browser runs IME composition. Canvas features that need typing (Atlas find `/`, draw-to-ask prompt)
  open a DOM input overlay. Nothing types into the canvas.
- **The keymap respects composition.** The T03 shim does not forward key events whose target is
  editable ([T03](T03-browser-runtime.md)). Inside editable elements (the 03 **Text input**
  context), the TS keymap applies a small *editable subset*: `⌘K`, `⌘⏎`, `Esc` (leaves the field),
  `⌘Z`/`⌘⇧Z` (undo typing) and `⌘⇧F` (format, once T09 ships formatting). It reads the same keymap table and skips any
  `keydown` with `isComposing == true` or `keyCode == 229`.
- **Event plumbing.** React handles DOM-room events (including `compositionstart/update/end`,
  `beforeinput`, `paste`) directly. The engine adapter's input ring carries only canvas pointer,
  wheel and gamepad input bound for the engine.
- **Clipboard.** DOM copies use `navigator.clipboard.write` with a `ClipboardItem` carrying
  `text/plain` plus `text/html` for tables, called from the click or keydown handler so user
  activation holds. Canvas copies use T03's synchronous copy buffer.

#### T08-020 — Text entry is DOM and composition-safe
**MUST** — All text entry MUST happen in native editable DOM elements. Key bindings MUST NOT fire
for a `keydown` with `isComposing == true` or `keyCode == 229`, and only the editable subset above
MAY act inside the Text input context.

#### T08-021 — Clipboard on gesture only
**MUST** — Clipboard writes MUST happen only inside a user-gesture handler. The kit MUST NOT call
`navigator.clipboard.read()`; pasted data is read only from native `paste` events into editable
elements.

### 4.7 Theming tokens shared with the GPU

```
design/tokens.toml ──► client/scripts/gen-tokens.ts ──┬──► tokens.css  (CSS custom properties per theme × density)
                                                      ├──► tokens.ts   (typed constants for the TS application)
                                                      └──► tokens.rs   (engine/crates/dash-tokens: pub const SURFACE_1: Rgba8 = Rgba8([0x12, 0x15, 0x1A, 0xFF]), …)
```

- **One source** ([08 §9](../product/08-visual-language.md)). *(Revised 2026-11-21, #68.)* Colours
  are authored as sRGB hex and emitted to `tokens.rs` as sRGB-encoded `Rgba8([u8; 4])`, the same
  bytes as the CSS; the engine blends in sRGB-encoded space ([T02](T02-vis-engine.md) §4.2), so token
  alphas composite as in CSS and Canvas 2D. `tokens.rs` is committed, and `checkGenerated`
  (`ci:token-lint`) fails when it is stale. Spacing (4 px grid), radius (6 px), hairline (1 px at 8 % contrast), type scale
  and motion durations are emitted to both (VL-019).
- **Themes:** `dark` (default, M-UI1), `light` (M-UI5, its own token values, never an inversion) and
  `wall-high-contrast` (M-UI6), × density `compact | comfortable | wall (×1.6, M-UI6)`. Compact is
  the Engineer Perspective default (VL-013). A switch sets `data-theme`/`data-density` on `<html>`
  and calls `ChartFrame.setTheme` on every frame. Every theme is compiled into the render worker, so a
  switch only swaps a uniform buffer and takes one frame.
- **Semantic state colours** (OK / Watch / Degraded / Failing / Unknown) and glyph shapes come from
  the same table, and are reserved for health (VL-003). `series_colour(key: u64) -> PaletteIdx` lives
  in `dash-tokens`, so DOM legends and GPU series agree (VL-002).
- **Palette validator.** The token build runs the CVD simulations (deuteranopia, protanopia,
  tritanopia) and the ±3 L* lightness check for the series and state palettes in every theme, and
  fails on a violation (VL-008).
- **Icons and glyphs:** one single-weight line icon set and the fixed glyph table are part of the
  token build (VL-020).
- **Fonts:** Inter (tabular numerals where numbers align) and JetBrains Mono WOFF2 subsets,
  self-hosted (VL-010). The same font files feed the MSDF atlas build, and the build fails if their
  hashes diverge, so canvas and DOM text match (VL-011).
- `prefers-color-scheme`, `prefers-contrast` and `prefers-reduced-motion` arrive as media-query
  events in the shell (via `web-sys` `matchMedia`), become `Prefs` defaults, and can be overridden per
  user.

#### T08-022 — One token source
**MUST** — Colour, space, type and motion values MUST be defined only in `design/tokens.toml`; CSS
and Rust constants MUST be generated from it. CI MUST fail on a colour literal outside the generated
outputs, and the build MUST fail if the DOM font files and the MSDF atlas fonts differ.

#### T08-023 — Styles through CSSOM
**MUST** — The kit MUST set dynamic styles through CSSOM (`el.style().set_property`), never with
`setAttribute("style")`, so CSP can forbid `unsafe-inline` styles ([T18](T18-security.md)).

### 4.8 Keyboard map and remapping

The binding table is [03 §4.2](../product/03-interaction-model.md), generated into `dash-keymap` from
one source so the runtime, the `?` overlay and the conflict check agree. Contexts and precedence are
03 §4.3's:

```rust
pub struct Binding { pub chord: Vec<KeyStroke>, pub gesture: Gesture /* Tap | Hold | TapOrHold */, pub context: KeyContext,
                     pub command: CommandId, pub overrides_outer: bool /* † in 03 */, pub since: Milestone }
pub struct KeyStroke { pub code: KeyCode /* physical KeyboardEvent.code */, pub mods: Mods /* Mod = ⌘ on macOS, Ctrl elsewhere */ }
pub enum KeyContext { TextInput(WidgetKind), Fly, ThreeD, Est, Board, Space, Room(RoomKind), Global }
```

- **Precedence**, innermost first: Text input → Fly → 3D → Est / Board → S / Room → G. The first
  match wins. An inner context rebinds an outer key only where the table marks the override (†), for
  example `W A S D` in Fly overriding `Shift+A` (acknowledge) and `D` (draw-to-ask).
- **Where it runs.** *(Revised, ADR-0014.)* The authoritative keymap lives in the TS application
  ([T03](T03-browser-runtime.md) T03-013), which decides `preventDefault()` synchronously in the DOM
  handler and knows the current `KeyContext` (focused room or widget) itself.
- **Notable bindings** (all from 03 §4.2): `⌘K` palette; `?` overlay; `g` + letter chords; `⌘Z`/`⌘⇧Z`;
  `Alt+←/→` camera history; `F6`/`Shift+F6` regions; `Esc` ladder; `/` find; `F`/`Shift+F` frame;
  arrows pan; `Space` (hold) scrub; `[` `]` `-` `=` window; `L` LIVE; `Shift+C` baseline ghost; `C`
  A/B Everything (M-UI6); `Shift+T` table view; `Shift+A` acknowledge (M-UI4); `Shift+E` Board edit
  mode (Board context, M-UI5). For Board edit, 03 binds `Shift+E` and [04](../product/04-surfaces.md)
  SRF-020 agrees (04 resolution R6), so `E` stays rotate in 3D, including 3D viewports inside a Board;
  T08 follows 03.
- **Physical keys.** Every binding is stored by `KeyboardEvent.code`, so letters, digits and
  punctuation keep their position on AZERTY, QWERTZ or Dvorak, and `Shift+1`–`Shift+9` and `?` work
  on non-US layouts (INT-013). The `?` overlay and kbd hints show the user's layout label for each
  code, from `Keyboard.getLayoutMap()` where available and otherwise from the keys observed in this
  session.
- **Chords** (`g` then a letter) complete within 1 s; any other key or the timeout cancels with no
  side effect, and `g` alone is unbound (INT-012). A which-key hint appears after 400 ms.
- **Tap and hold** (`.`, `V`; hold-only `Space`, `D`): released within 250 ms is a tap, held ≥ 250 ms
  a hold, and a hold ends on release (INT-011). On window blur holds cancel, so a key is never stuck.
- **Remapping** (M-UI5). A keymap room edits `Prefs.keymap = { preset, overrides }`, stored in user
  preferences through the BFF so it follows the user across devices. Presets are Default, Vim-ish and
  Classic dashboard. The conflict detector rejects a remap that collides, naming the existing action, and
  warns on browser-reserved chords (`Mod+W`, `Mod+T`, `Mod+N`, `Mod+L`; `Mod+K` where the browser may
  reserve it, §13 Q3).
- **`?` overlay.** It is generated from the active contexts and the user's remaps, so it is always
  correct (INT-014).

#### T08-024 — Keymap conflicts are impossible
**MUST** — No key (with its modifiers and tap/hold distinction) MAY be bound to two commands in one
context. An inner context MAY rebind an outer key only where the binding is marked as an override.
`⌘K`, `?`, `Esc`, `⌘Z` and `⌘⇧Z` are reserved and MAY be overridden only by the Text input context.
These rules MUST be checked in CI for the default table and every preset, and enforced when the user
remaps.

#### T08-025 — Tap, hold and chord timing
**MUST** — A key released within 250 ms MUST be treated as a tap and one held ≥ 250 ms as a hold;
hold actions MUST end on release and on window blur. A `g` chord MUST complete within 1 s or cancel
with no side effect.

#### T08-026 — Physical-position bindings
**MUST** — Bindings MUST be stored and matched by physical key code, and the overlay and hints MUST
display the user's layout label for that code.

### 4.9 i18n

- **Messages.** Project Fluent (`fluent-bundle`) `.ftl` files, one bundle per locale, lazily fetched
  as static assets. They are bundled into wasm only for `en-GB`. Message IDs are checked at compile
  time by a build step that generates `msg::` constants, so a missing ID is a compile error.
- **Formatting.** Numbers, units, dates and plurals use **ICU4X** (`icu`) with baked data limited to
  shipped locales, so the browser and the native headless renderer (notification images, golden
  tests) produce identical strings. Numbers are formatted for humans with SI prefixes and units
  (`2.84 s`, `1.2k rps`, `€38k/h`) and times as relative with absolute on hover (VL-012). Browser
  `Intl` via `js-sys` is the fallback if ICU4X data size fails the risk-check budget (§7). The 05 unit
  catalogue formats through this layer.
- **Locale vs time zone vs units** are three independent preferences.
- **DOM uses logical CSS properties** (`margin-inline-start`). The GPU text layer gets the locale for
  shaping (T14 (draft)).
- **v1:** the infrastructure plus `en-GB`/`en-US`. Translations (de, fr, ja, es) come in M-UI5.
  Japanese is the first non-Latin target because it exercises IME and CJK font fallback.

#### T08-027 — Messages and formats are checked and shared
**MUST** — *(Revised 2026-11-19, ADR-0014.)* Every user-visible string MUST come from a typed message
id (a missing id is a type error), and every number, unit and date MUST be formatted through one
`i18n/format.ts` module. When the engine lands, its formatter MUST match it on a shared fixture set
(`unit:number-format`).

### 4.10 Leptos build risk check (M-UI1, 3 weeks)

*Withdrawn 2026-11-19: ADR-0004 is superseded by [ADR-0014](../adr/0014-typescript-react-web-client.md).
The criteria below are kept for the record; criteria 1–6 become acceptance criteria of the TS kit
issues that build the table, tree, forms and tooltips.*

*(Historical.)* ADR-0004 was Accepted. The M-UI1 slice was to be built once, on Leptos, as a **risk check**: it proves the
kit can meet the contract before the rooms are built on it. The slice is:
- the 10k-row table with 8 cell kinds;
- the 100k-node tree;
- a 40-field alert-rule form with async validation;
- the combobox;
- `<dialog>`;
- a tooltip fed by a fake render worker at 60 Hz;
- the store bridge from §4.2.

| # | Criterion | Pass threshold | Class |
|---|---|---|---|
| 1 | Table scroll, 10k × 20 columns | 60 fps p99 on reference laptop (b), 0 long tasks > 16 ms | blocker |
| 2 | Sort 10k rows → repaint | ≤ 50 ms; INP ≤ 100 ms | blocker |
| 3 | Tree expand of 5k children | ≤ 16 ms main-thread | blocker |
| 4 | Tooltip from worker anchor | median ≤ 1 frame, p99 ≤ 2 frames, measured with frame ids (T08-013) | blocker for the DOM path; failure switches hover tooltips to GPU text |
| 5 | IME correctness | ja, zh-Pinyin and ko on Chrome, Firefox and Safari: no lost or duplicated characters, no stray bindings | blocker |
| 6 | Accessibility | axe-core 0 serious/critical (Playwright dev tooling, not shipped); NVDA + VoiceOver walkthrough of form, table and tree passes | blocker |
| 7 | No hand-written JS added | Leptos's web renderer adds no JS beyond `wasm-bindgen` glue ([ADR-0001](../adr/0001-rust-wasm-everywhere.md)) | blocker |
| 8 | wasm size (framework + kit slice) | ≤ 400 KB brotli | watch |
| 9 | External-store integration | Signals can be driven from `AppStore` deltas without cloning state | watch |
| 10 | DX | Incremental rebuild ≤ 10 s; usable hot-reload | watch |
| 11 | Project health | Release cadence, maintainer count, licence (MIT) | watch |

**Outcome rule.** A blocker failure that cannot be fixed in the kit within the 3 weeks **reopens
ADR-0004** (the ADR's own consequence). Failures of criteria 5 or 6 are presumed to be ours (the
kit), not Leptos's, and are fixed before any reopening is considered. "Watch" failures are recorded
with an owner and a fix milestone and do not block.

## 5. Interfaces

### 5.1 Defined here

| Interface | Consumers | Shape |
|---|---|---|
| `AppState` / `Action` / `reduce` (`client/src/state/`, main thread) | every component, T09, T15 (AI dock actions), T17 (remote actions) | §4.2 |
| Store selectors and `dispatch` | every React component | §4.2 |
| `ChartFrame` calls added by the kit | the engine ([ADR-0014](../adr/0014-typescript-react-web-client.md) §3) | `FocusMark`, `TrackMark`, `SetViewportTable(bool)` as spec fields; selection highlight in the spec |
| Engine event payloads | the TS store and kit | `TooltipAnchor` (§4.4.2), `A11ySummary` (§4.5), `select` → `Selection`, `InspectorModel` (§4.4) |
| `Route` ⇄ URL codec | T17 (shared links), T16 (notification deep links), T20 | §4.3. `CamCode` = base64url of a versioned packed struct ≤ 48 bytes |
| `TableModel` | GPU table-grid spec (T02), T13 | §4.4.1 |
| `Prefs` JSON schema (theme, density, locale, tz, keymap, panel layout) | T11 (`user_preferences.prefs jsonb`), T06 (`/api/dash/v1/prefs`) | versioned `prefs_v` |
| `tokens.toml` | T02 (GPU), T09 (syntax tokens), T20 (manifest theme colour) | §4.7 |
| Keymap table (generated from 03 §4.2) | T03 (captured chords), T09 (`TextInput(QueryEditor)`), T05 (`e2e:keymap-table`) | §4.8 |

### 5.2 Cross-doc interfaces (assumed)

| From | Assumption |
|---|---|
| [T03](T03-browser-runtime.md) | *(Revised, ADR-0014.)* The engine runtime behind `ChartFrame`: render-local state only, events for commits, hover and selection, and the input ring for canvas input. The store, keymap and URL are in the TS application |
| [T02](T02-vis-engine.md) | Vis specs implement `Describe → A11ySummary`. The render worker honours `FocusMark`/`TrackMark` and reports anchors in CSS px; it can draw hover tooltips as GPU text if T08-013's fallback is triggered |
| [T06](T06-bff-architecture.md) | `/api/dash/v1/prefs` (GET/PUT, ETag), `/api/dash/v1/search` for ⌘K, the action API, the export endpoint, the error envelope with JSON-pointer field errors and `request_access` hints, and the read-only signal when Postgres is down |
| [T09](T09-query-editors.md) | Editor component `QueryEditor { lang, value: RwSignal<String>, on_run }`, a read-only highlighter, and a language detector for ⌘K |
| T10 (draft) | The UI receives the effective permission set to *render* restricted states. Enforcement is server-side |
| T13 (draft) | `Engine` row source and expression evaluator for table filters |
| T17 (draft) | Remote Context/camera arrive as `Action::Remote`, and follow-mode suppresses local camera commits |

## 6. Data & storage

| Data | Where |
|---|---|
| Prefs, keymap overrides, dock layouts, per-board table column state | Postgres via BFF ([T11](T11-postgres-schema.md)), cached in memory |
| Starred and recent boards | Postgres via BFF ([T11](T11-postgres-schema.md) `stars`, `recent_views`) |
| Recent palette items, last-open room, unsent form drafts | IndexedDB (per device, convenience only, wiped on logout) |
| Fluent bundles, ICU4X locale data, fonts | Static immutable assets, HTTP-cached, self-hosted |
| Undo stack, ephemeral UI state | Memory only |

## 7. Performance budget

| Metric | Target | Source |
|---|---|---|
| Main-thread long tasks during interaction | 0 > 16 ms (`bench:rooms-long-tasks`, scripted room interactions in Chromium from a trace; until the reference lab exists, #68, CI's `e2e` gates thread > 16 ms and wall > 50 ms as T05 §4.3's interim trace check; the board editor (#90) and chart gestures (#93) are its scenarios) | PRF-005 |
| Hover tooltip | median ≤ 1 frame, p99 ≤ 2 frames (crosshair ≤ 1, GPU) | PRF-003, PRF-004, INT-033 |
| INP in rooms | ≤ 100 ms p75 (a room above 200 ms fails the reference-lab gate; on shared CI runners a warning until the reference lab exists, #68) | PRF-033 |
| Table: mount the visible window | ≤ 8 ms; scroll at 60 fps with ≤ 4 ms main per frame | §4.10 |
| `reduce` + selector re-render, per action | ≤ 1 ms each; DOM intent → visible ≤ 1 frame | — |
| ⌘K local results | same frame (≤ 4 ms); remote merged ≤ 150 ms p50 | — |
| Shell interactive (sidebar, page header, ⌘K) from navigation start, cold | contributes to < 1.0 s p75 | PRF-008 |
| Application JS (initial) | ADR-0014 §8 budgets (≤ 200 KB initial JS, ≤ 30 KB CSS) | PRF-009 |
| ICU4X + Fluent, `en` only | ≤ 150 KB brotli; extra locales lazy | §4.10 |
| Main-thread heap | ≤ 64 MB (no bulk data on main) | PRF-023 |

These are measured by Playwright traces (frame IDs from the render worker correlated with rAF on
main), INP on rooms from Event Timing (`bench:inp-rooms`), and a per-crate bundle-size gate ([T05](T05-testing-and-performance.md)).

## 8. Security, tenancy & RBAC

- **Markdown cannot produce HTML** (T08-011). Data links and images go through a URL scheme
  allow-list.
- **Styles** through CSSOM only (T08-023).
- **RBAC.** The UI renders restricted states ("+38 you can't view", restricted placeholders, disabled
  controls with "request access") but never relies on hiding for security. Every action button calls
  the audited action API.

#### T08-028 — The UI never enforces security by hiding
**MUST** — The kit MUST treat permission and scope data from the BFF as display hints only. Every
mutating control MUST call a BFF endpoint that enforces the permission; an unreadable object MUST be
shown as the restricted placeholder or omitted, never as a dead "Access denied" page.

- **Clipboard** writes happen only on user gestures (T08-021).
- **Tenant** comes from the route. Switching tenant resets the TS store (except prefs), disposes
  every `ChartFrame`, and clears tenant-keyed IndexedDB caches.

## 9. Failure modes & degradation

| Failure | What the user sees |
|---|---|
| Engine worker crashed or restarting | The store is on the main thread, so DOM chrome, Context and undo are unaffected. The viewport shows "Renderer restarting" with the last `A11ySummary`; on restart the store resends each frame's spec, data and time window |
| BFF unreachable | Rooms show cached lists marked stale. Forms keep drafts (IndexedDB) and disable submit with a reason |
| Postgres unavailable (BFF read-only) | Read-only banner; forms disable submit with the reason; drafts kept |
| Async validator timeout | The field shows "couldn't check, will validate on save"; submit is not blocked |
| Locale bundle fails to load | Fallback to `en-GB` with a toast |
| Table source > 10k rows | Automatic switch to the GPU grid with a notice. Column state is kept |
| Tooltip latency gate fails in the risk check | Hover tooltips drawn as GPU text (T08-013); pinned tooltips stay DOM |

## 10. Testing

- **Native unit and property tests:** reducer invariants (undo ∘ do = id, `unit:undo-roundtrip`);
  route round-trip (`prop:route-roundtrip`, fuzzed); `CamCode` length and pose (`prop:camcode`);
  keymap conflict detector over every preset (`ci:keymap-conflicts`); tap/hold and chord timing;
  time-expression grammar; palette ranking.
- **`wasm-bindgen-test`** in headless Chrome and Firefox for kit components.
- **Playwright:** DOM screenshot diffs per theme × density (`golden:*`), axe-core scans of every room
  and component state (`a11y:axe-rooms`; dev-only tooling, never shipped), keyboard-only scripts per
  room (`e2e:keyboard-only-rooms`), the 03 key table (`e2e:keymap-table`), and an IME script using
  CDP `Input.imeSetComposition`.
- **Manual AT matrix** per milestone: NVDA + Firefox, JAWS + Chrome, VoiceOver + Safari (macOS and
  iOS), TalkBack + Chrome. An external WCAG 2.2 AA audit happens in M-UI6.
- **Perf gates** from §7 run in CI ([T05](T05-testing-and-performance.md)).

## 11. Rollout

| Milestone | Ships |
|---|---|
| M-UI1 | *(2026-11-19: delivered by the TS application in the order of [12 §2.1](../product/12-roadmap.md#21-delivery-order-2026-11-19); the Leptos risk check is withdrawn.)* Store, router, tokens, keymap (03 §4.2 M-UI1 rows, conflict check, overlay, F6), i18n infrastructure. Shell chrome. Kit core: table (core cell kinds, row selection, CSV), forms, select, date range with copy-link, dialog, toast, restricted placeholder, ⌘K (rooms, actions, queries), Inspector shell, tooltips. `Shift+T` table view. Metrics workbench chrome. Board panel editor (query, language picker, vis) and a minimal board list room (#48); the board editor of #61: the panel editor as a centred, fixed-size modal window with a live preview (#90), the per-panel Move or resize button as the keyboard path for grid moves (§4.4), and the board keys `Shift+E` and `Mod+S` |
| M-UI2 | JSON, Markdown, image, link and pill cells. Tree. Logs/traces inspector content. Viewport a11y mirror for time-series. Dock host. ⌘K entities |
| M-UI3 | Explorer (tree + table). Atlas mirror. Pivot-chip and entity-chip cells |
| M-UI4 | Alert, Investigation and contact-point rooms. Action buttons. ⌘K alerts and investigations |
| M-UI5 | Full Boards editor forms, field-config UI. Light theme. Translations. Keymap room with presets |
| M-UI6 | Admin rooms for datasource binding and OIDC, with authentication (D12; until then the fixed local principal). Wall density and high-contrast theme. External AA audit and fixes. Forced-colours polish. Screen-reader summaries everywhere (VIZ-068) |

## 12. Alternatives considered

| Option | Why not |
|---|---|
| **Leptos** (ADR-0004) | Superseded by [ADR-0014](../adr/0014-typescript-react-web-client.md): a conventional web application first, on React and React Aria Components |
| **Other Rust DOM frameworks (Dioxus, Yew, Sycamore)** | Same reason as Leptos (ADR-0014) |
| **All-canvas (egui)** | Rejected in [T01](T01-frontend-architecture.md): we would have to reinvent IME, a11y, autofill and selection |
| **ARIA directly on a single `<canvas>`** (fallback content only) | Too coarse for focusable marks and table views. The mirror gives real elements |
| **Browser `Intl` only** | Small, but the native renderer has no `Intl`, so notification images and golden tests would format differently. It stays as the fallback |
| **A separate `sanitize-html` step for Markdown** | Dropping HTML events at the source is simpler and safer |
| **Logical-key (`KeyboardEvent.key`) bindings for mnemonics** (draft) | INT-013 requires physical positions for letters, digits and punctuation; labels come from the layout map instead |

## 13. Open questions

| # | Question | Leaning |
|---|---|---|
| Q1 | *(Closed 2026-11-19 by ADR-0014: the store is on the main thread in the TS application in T01, T03 and this document.)* | — |
| Q2 | VIZ-066 (`Shift+T` table view) is M-UI1, but the 03 §4.2 key table lists `Shift+T` at M-UI2 | Ship at M-UI1; ask the product owner to align the 03 milestone |
| Q3 | `Ctrl+K` may be reserved by some browsers on Windows/Linux (focusing the search bar); behaviour under `preventDefault` needs verifying per browser | Verify in the risk check; fallback is the top-bar ⌘K entry point (no extra binding, to keep 03 intact) |
| Q4 | ICU4X baked data size for 6 locales | Measure in the risk check; `Intl` fallback for the browser only |
| Q5 | Per-user vs per-board persistence of table column state | Board-level default + per-user override |
| Q6 | `Keyboard.getLayoutMap()` is Chromium-only | Learned labels from observed key events elsewhere; verify on Firefox/Safari |

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft. Restructured to the template; rules T08-001…T08-028. ADR-0004 Accepted: the Leptos vs Dioxus spike became a Leptos build **risk check** (§4.10) whose blocker failure reopens the ADR. Keyboard model aligned with formal 03: contexts and precedence, chords 1 s (draft 1.2 s), tap/hold 250 ms, physical-key bindings (INT-013), reserved keys, `Shift+C`/`C`/`Shift+A`/`Shift+E` (03 and 04 agree on `Shift+E`), `Tab` by care score; draft Q1 and Q3 closed by 03 and 02 (`/incident/` and `/alerts/` routes added to `Route`). Dropped the `Alt+←/→` brush alternative (conflicts with camera history). Tooltip budget tightened to median ≤ 1 frame (INT-033) with a GPU-text fallback. Markdown removals are logged (VIZ-054). Added the shell chrome contents, logo menu, read-only banner, restricted placeholder, shimmer, copy-link, `CamCode` ≤ 64 chars, palette rooms provider and context-affinity ranking, palette validator and Admin M-UI1 rooms |
| 1.0-rc | 2026-11-19 | Roadmap D5 ([12](../product/12-roadmap.md#21-delivery-order-2026-11-19) §2.1): §11 M-UI1 adds the board panel editor (query, language picker, vis) and a minimal board list room; full Boards editor forms stay M-UI5 |
| 1.1-rc | 2026-11-19 | [ADR-0014](../adr/0014-typescript-react-web-client.md): new §0 maps the Rust/Leptos modules to the TS application; T08-001, T08-002 and T08-027 revised; §4.10 Leptos risk check withdrawn; chrome rows suspended pending roadmap Q13; §11 M-UI1 and §12 updated |
| 1.2-rc | 2026-11-19 | Product text revised to D9 (roadmap Q13 closed): §4.3 describes the application layout (sidebar, page header, user menu, layout sizes); T08-017 regions; `Route` adds `Explore` and `Boards` (02 §4); Satisfies rows for IA-016, IA-021, SRF-001, VL-017 and INT-015 restored against `e2e:app-layout`, `e2e:rooms-reachable`, `e2e:chrome-every-surface`, `e2e:chrome-layout` and `e2e:focus-regions`; IA-020 row added (`e2e:time-range-header`); PRF-009 row uses chunk-class budgets |
| 1.3-rc | 2026-11-19 | ADR-0014 state ownership: §1 and §2 rewritten for the React application; §4.1 Rust crate tree marked superseded; §4.2 rewritten (the TS store on the main thread owns semantic state; the engine holds render-local state and reports events through `ChartFrame`); T08-004, §4.6, §4.8 "Where it runs", §5.1, §5.2 T03 row, §7, §8 tenant switch, §9 engine restart and Q1 aligned; Leptos and the ui↔core rings removed; §4.6 `⌘⇧F` waits for T09 formatting |
| 1.4-rc | 2026-11-20 | [ADR-0017](../adr/0017-react-router.md): `dash-route` row is `app/router.tsx` on React Router (data mode) with the typed search module `state/contextSearch.ts` |
| 1.5-rc | 2026-11-20 | Decision D12 (authentication deferred): the SRF-063 gate `e2e:admin-oidc-bind-datasource` runs from M-UI6 with SRF-063; §4 Admin rooms and §11 rollout move the datasource-binding and OIDC rooms from M-UI1 to M-UI6, with the fixed local principal until then |
| 1.6-rc | 2026-11-20 | #61 Part B: §4.4 and §11 M-UI1 add the board editor: the non-modal right-hand panel editor, the per-panel Move or resize button (arrows, `Shift`+arrows) as the keyboard path for grid moves, and the board keys `Shift+E` and `Mod+S` (`Shift+E` moves from M-UI5 to M-UI1) |
| 1.7-rc | 2026-11-21 | #61 Part C: §4.3 sidebar: Starred and Recent from the BFF, per user, with the ordering guarantee of D-RECENT-window and one reconciling refetch after an ambiguous view; §6 row for starred and recent boards in Postgres; IA-021 Satisfies adds `e2e:board-prefs`; PRF-033 Satisfies and the §7 INP row name `bench:inp-rooms`, failing the reference-lab gate above 200 ms and reporting a warning on shared CI runners until the lab exists (#68, D-INP-interim) |
| 1.8-rc | 2026-11-21 | #90: §4.4 and §11 M-UI1: the panel editor is a centred, fixed-size modal dialog with a live preview (owner decision 2026-11-21); it replaces the non-modal right-hand sheet. §7: `bench:rooms-long-tasks` and its interim CI check |
| 1.9-rc | 2026-11-21 | #68: §4.7 token contract: the generator is `client/scripts/gen-tokens.ts` → `tokens.css`, `tokens.ts`, `tokens.rs`; colours authored as sRGB hex and emitted to `tokens.rs` as sRGB-encoded `Rgba8([u8; 4])`, the same bytes as CSS; the engine blends in sRGB-encoded space (T02 §4.2). Replaces linear-space `[f32; 4]` and `Lin([..])` |
| 1.10-rc | 2026-11-21 | #93: §7 `bench:rooms-long-tasks` scenarios include chart gestures |
| 1.11-rc | 2026-11-23 | #66 Part B: §4.4 v1 note: the M-UI1 log stream virtualises with `@tanstack/react-virtual` over a slice of ≤ 200 000 rows (fixed 20 px rows, measured with wrap), not the Fenwick table virtualiser |
| 1.12-rc | 2026-11-25 | #164: §4.4 Inspector row links [T25](T25-inspector-and-pivots.md) (host, payload, selection, Esc ladder, pivots, look); the dock host (VL-018) is not part of T25 |
| 1.13-rc | 2026-11-26 | #198 Part 2a: §3 VIZ-056 `ci:no-iframe` is the `security/no-iframe` ESLint rule over `client/src` and `client/e2e` (was a lint over `dash-kit`) |
