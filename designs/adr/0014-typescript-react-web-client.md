# ADR-0014: TypeScript, React and Vite web client; a WASM chart engine later behind a typed API

| | |
|---|---|
| **Status** | Accepted (2026-11-19, product owner); amended by [ADR-0016](0016-asset-integrity-verified-by-bff.md) (2026-11-19, lazy-chunk SRI) and, for §1 Routing, by [ADR-0017](0017-react-router.md) (2026-11-19) |
| **Supersedes** | [ADR-0004](0004-leptos-dom-rooms.md) (Leptos DOM rooms), [ADR-0002](0002-no-js-ui-framework.md) (no JS UI framework), and the browser half of [ADR-0001](0001-rust-wasm-everywhere.md) (the server half is superseded by [ADR-0015](0015-go-bff.md)) |
| **Source** | Owner decision of 2026-11-19: all code removed from `main` to start again (commit "Remove the existing code to start again") |
| **See** | [T01](../technical/T01-frontend-architecture.md), [T03](../technical/T03-browser-runtime.md), [T08](../technical/T08-dom-component-kit.md), [12 §2.1](../product/12-roadmap.md#21-delivery-order-2026-11-19), [ADR-0015](0015-go-bff.md) |

## Context

The Rust/WASM-everywhere client (ADR-0001, ADR-0002, ADR-0004) put the shell, every room and every
form in Leptos, with JavaScript limited to a ≤ 300-line shim. After the first two issues the owner
decided that the product needs a usable, conventional web application first, so that people can
click through boards and query PulsusDB early. The GPU and 3D work is still the differentiator, but
it is not the first thing a user needs. A standard web stack also gives mature accessible
components, date and time pickers, a code editor and a large hiring pool.

## Decision

### 1. Stack

| Concern | Choice |
|---|---|
| Language | TypeScript, `strict` with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` |
| UI framework | React (current major), client-side rendering only; no server-side rendering |
| Build and dev server | Vite (current major); Node.js active LTS (24), npm with `package-lock.json` |
| Routing | React Router in data mode (code-based, client-only) with a typed search-parameter module that validates and canonicalises the URL (the URL reproduces the view, T08-005). *Amended 2026-11-19 by [ADR-0017](0017-react-router.md); was TanStack Router.* |
| Server state | TanStack Query: caching, refetch, and `AbortSignal` cancellation of superseded requests |
| Accessible components | React Aria Components (menus, dialogs, combobox, date and time range, table, toasts) |
| Styling | CSS Modules over generated token CSS custom properties; no CSS-in-JS runtime |
| Code editor | CodeMirror 6 (lazy-loaded with the Explore and panel-editor routes) |
| API types | Generated from the OpenAPI document of [ADR-0015](0015-go-bff.md) (`openapi-typescript` + `openapi-fetch`) |
| Icons, fonts | One line icon set copied in as SVG files (no icon package); Inter and JetBrains Mono self-hosted as WOFF2 |

The source lives in `client/` at the repository root. Charting, mapping, 3D, graph-diagram and
CSS-in-JS libraries are not allowed (§5).

### 2. What lives where

| Layer | Language | Owns |
|---|---|---|
| Web application (main thread) | TypeScript | Shell, layout and navigation, routing and the URL codec, Context (time range, refresh, filters), rooms and forms, boards grid and panel editor, query editors, keyboard shortcuts, i18n via `Intl`, API client, interim charts (§4), log list |
| Chart engine (later, one worker) | Rust → WASM | Arrow decode, decimation, scales, axes, marks, picking, wgpu rendering into one `OffscreenCanvas` per panel, accessibility summaries back to TS; later the 3D Space scenes ([T02](../technical/T02-vis-engine.md), [T03](../technical/T03-browser-runtime.md) §4.2–§4.3) |
| Query parsing in the browser (later) | Rust → WASM | PulsusDB's PromQL and LogQL parser crates compiled to WASM for editor diagnostics; until then the BFF validates by asking PulsusDB ([ADR-0015](0015-go-bff.md)) |
| BFF | Go | [ADR-0015](0015-go-bff.md) |

Semantic application state (route, Context, selection, board model, preferences) has one owner,
the TS application. The engine owns only render-local state (gesture camera, hover, decoded
columns) and reports commits, hovers, brushes and selections as events.

### 3. The engine seam

Every chart is a `<ChartFrame>` React component that owns one `<canvas>` and talks to an engine
through one typed interface. Exactly one implementation is active per page load.

```ts
// client/src/engine/api.ts
export interface ChartEngine {
  createFrame(canvas: HTMLCanvasElement, init: FrameInit): ChartFrame;
}
export interface ChartFrame {
  setSpec(spec: VisSpec): void;          // vis kind + field config; validated data, never code
  setData(data: FrameData): void;        // interim: decoded SeriesFrame[]; engine: an Arrow stream handle
  setTimeWindow(w: TimeWindow): void;
  setTheme(t: ThemeName): void;
  resize(cssWidth: number, cssHeight: number, dpr: number): void;
  on<E extends keyof FrameEvents>(e: E, cb: (ev: FrameEvents[E]) => void): () => void; // hover | brush | select | a11y
  dispose(): void;
}
```

| Implementation | When | Where it draws |
|---|---|---|
| `Canvas2DEngine` (TS, in-house) | Interim, from the first chart issue | 2D context of the panel canvas, main thread |
| `WasmEngine` (TS adapter + Rust engine) | When the engine issue lands | `transferControlToOffscreen()` per panel canvas; one shared worker, one GPU device |

The adapter for `WasmEngine` lives in `client/src/engine/wasm/` and is the successor of the T03 shim:
it may not parse payload bytes destined for the engine, and it may not use `eval`, `Function` or
`innerHTML`.

### 4. Interim charts

Interim charts are drawn by an **in-house Canvas 2D renderer** behind the seam, not by a JS charting
library, and not left as placeholders. It covers time-series line, stacked bars (log volume by
level), heatmap and stat, with time and value axes, a crosshair tooltip and brush to zoom.

> **Rationale:** placeholders would hide whether PromQL and LogQL dashboards are useful, which is
> the point of the first milestone. A charting library would breach the library clause of
> [VIZ-001](../product/05-visualisation-catalogue.md#viz-001--gpu-rendering-by-one-shared-engine),
> add a dependency to remove later, and impose a different DOM structure. The in-house renderer uses
> the same canvas-per-panel structure the engine will take over, so the swap changes no component.

Limits of the interim renderer: at most 500 series per panel (the rest are dropped with a visible
"showing 500 of N" notice) and at most one point per CSS pixel per series, which the query step
already guarantees. VIZ-001's "drawn by the wgpu scene" clause is unmet until the engine lands; its
M-UI0 milestone stays incomplete until then (D6).

### 5. Wire format to the browser

Query results reach the browser as **JSON frames** (`application/json`, schema in the OpenAPI
document) until the engine lands. From then on, results for engine-rendered frames are Arrow IPC
([ADR-0005](0005-arrow-wire-format.md)) streamed to the engine worker without main-thread parsing,
and JSON stays for config and CRUD. The TS side has one decoder seam, `client/src/data/decode.ts`,
so panels do not change when the format does.

### 6. Build, test and serve

| Step | Command (in `client/`) | Gate |
|---|---|---|
| Install | `npm ci` (CI only ever uses `ci`) | `ci:lockfile` |
| Lint and format | `npm run lint` (ESLint with typescript-eslint strict type-checked, react-hooks, jsx-a11y; Prettier check) | `ci:lint-ts` |
| Type check | `npm run typecheck` (`tsc --noEmit`) | `ci:typecheck` |
| Tokens | `npm run tokens` (generate `tokens.css` and `tokens.ts` from `design/tokens.toml`; CI regenerates and compares) and `npm run token-lint` (no colour literal outside generated files) | `ci:token-lint` |
| Unit and component tests | `npm test` (Vitest, jsdom, Testing Library) | `unit:*` |
| End-to-end | `npm run e2e` (Playwright: Chromium, Firefox, WebKit; axe-core scans) against the production build | `e2e:*`, `e2e:a11y-rooms`, `e2e:csp-violations` |
| Build | `npm run build` → `client/dist/` (hashed names, `assetsInlineLimit: 0`, Vite manifest) | — |
| Bundle budget | `npm run size` (brotli per chunk class against `client/bundle-budgets.json`) | `ci:bundle-size` |
| Supply chain | `npm run audit` (§7) | `ci:dep-audit`, `ci:npm-audit` |

**Serving.** In production the Go BFF serves `client/dist/` (embedded in the binary, [T19](../technical/T19-deployment.md))
with the headers of §9: hashed `/assets/*` as `public, max-age=31536000, immutable`, `index.html`
as `no-cache`, and `index.html` for any other `GET` that accepts `text/html` outside `/api/`,
`/auth/`, `/assets/` and the health routes. In development `npm run dev` starts the Vite dev server
on `localhost:5173`, which proxies `/api/` and `/auth/` to the BFF (`PULSUS_DASH_DEV_BFF`, default
`http://localhost:8080`). Before the BFF exists, and whenever `VITE_API_MODE=stub`, the client uses
an in-repo stub API with seeded data, so the app runs with `npm run dev` alone. The dev server sends
COOP and COEP but not the CSP (HMR needs inline script); the CSP is tested against the production
build (`vite preview` with the production headers until the BFF serves it, then the BFF).

### 7. JavaScript supply chain

- `package-lock.json` committed; CI installs with `npm ci` only. `.npmrc`: `save-exact=true`,
  `engine-strict=true`, `ignore-scripts=true`. A package that needs an install script is named in
  `client/dependency-policy.json` and rebuilt explicitly in the build script.
- Exact versions only (no `^` or `~`), checked by `ci:lockfile` together with: every `resolved` URL
  is on `https://registry.npmjs.org/` and every entry has an `integrity` hash.
- Runtime dependencies are an **allowlist** in `client/dependency-policy.json`. A `dependencies`
  entry not on the list fails `ci:dep-audit`; adding one is a reviewed change to that file. The
  forbidden categories (charting, mapping, 3D, graph-diagram, CSS-in-JS) are listed there too.
- `npm audit --omit=dev --audit-level=high` and `npm audit --audit-level=critical` fail CI;
  `npm audit signatures` must pass. Licences of runtime dependencies must be on the AGPL-3.0
  compatible allowlist (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, MPL-2.0).
- `npm sbom --sbom-format cyclonedx` is attached to every release.
- Dependency updates arrive in one reviewed batch PR; versions published less than 7 days earlier
  are not adopted unless they fix a security advisory.

### 8. Bundle budgets (brotli)

| Artefact | Budget | Class |
|---|---|---|
| Initial JS (entry + chunks needed to render `/t/{tenant}/boards`) | ≤ 200 KB | required |
| Initial CSS | ≤ 30 KB | required |
| Each lazy route chunk | ≤ 120 KB | required |
| Editor chunk (CodeMirror + language support) | ≤ 175 KB | required |
| Fonts (Latin subsets) | ≤ 150 KB | required |
| All client assets except the engine | ≤ 1 MB | required |
| Engine (`dash-engine.wasm` + adapter), lazy on the first chart frame | ≤ 1.9 MB ([T03](../technical/T03-browser-runtime.md) §7.3 core row) | required once it exists |

The client core (initial JS + CSS + engine) stays under the 3 MB of
[PRF-009](../product/09-performance-contract.md#prf-009--core-bundle-size-and-lazy-loading).

### 9. Headers and CSP

The BFF sends, on every document, the [T18](../technical/T18-security.md) T18-002 header set with
this CSP:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:;
font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self';
base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'none';
require-trusted-types-for 'script'; trusted-types pulsus-sanitised; report-to csp
```

`'wasm-unsafe-eval'` is added to `script-src` by the engine issue, not before. React sets styles
through CSSOM, which the CSP allows (T18-004); `dangerouslySetInnerHTML` is banned by lint. COOP
`same-origin` and COEP `require-corp` are sent from the first issue, so the engine's shared memory
needs no header change later.

### 10. Application layout

The client uses a conventional application layout: a left navigation sidebar (Boards, Explore →
Metrics and Logs, Admin), a page header with the title on the left and the time range picker,
refresh control and user menu on the right, and roomy board pages. This replaces the 32 px top bar,
the bottom Time Ribbon and "no left sidebar" of [02](../product/02-information-architecture.md) and
[08](../product/08-visual-language.md); those product requirements are revised separately (roadmap
[12 §5](../product/12-roadmap.md#5-open-questions) Q13).

## Consequences

- ADR-0004 and ADR-0002 are superseded. ADR-0001 is superseded by this ADR (browser) and
  ADR-0015 (server). [ADR-0007](0007-in-house-vis-engine.md) (in-house vis engine) and
  [ADR-0003](0003-wgpu-rendering.md) (wgpu) still govern the engine.
- Superseded or reinterpreted design rules: T01-001, T01-002, T01-007, T01-008; T03-001, T03-009;
  T08-001, T08-002 and the Leptos risk check (T08 §4.10). The rewritten rules are in those documents.
- One shared GPU *device* drives many panel canvases, rather than one shared scene per board. The
  Space (Atlas, Lens) stays one scene (T01-006). VIZ-001 and SRF-014 wording is revised with Q13.
- Documents still to revise: product [02](../product/02-information-architecture.md) (IA-016,
  IA-020, IA-021), [05](../product/05-visualisation-catalogue.md) (VIZ-001),
  [08](../product/08-visual-language.md) (VL-017), [09](../product/09-performance-contract.md)
  (PRF-008, PRF-009 wording); technical [T05](../technical/T05-testing-and-performance.md) (gates
  `ci:shim-lint`, `ci:dep-audit`, `e2e:chrome-layout`), [T09](../technical/T09-query-editors.md)
  (editor in TS on CodeMirror), [T18](../technical/T18-security.md) (T18-005 policy location, npm
  supply chain, SRI for lazy chunks — *amended by [ADR-0016](0016-asset-integrity-verified-by-bff.md)
  (2026-11-19): no per-module SRI in the browser; asset integrity is verified by the BFF before
  serving, [T18](../technical/T18-security.md) T18-006*).
- The JS supply chain becomes a real attack surface; §7 is the control. The hiring and ecosystem
  benefits are the reason for accepting it.
