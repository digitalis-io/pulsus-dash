# JavaScript supply chain

How the client keeps its npm dependencies in check: [ADR-0014](../../designs/adr/0014-typescript-react-web-client.md)
§7 in practice (T01-002). The gates are `ci:lockfile`, `ci:dep-audit` and `ci:npm-audit`; see
[Build, test and CI](../development/build-and-ci.md) for when they run.

## Install settings

`client/.npmrc`:

| Setting | Effect |
|---|---|
| `save-exact=true` | `npm install <pkg>` records an exact version |
| `engine-strict=true` | installing with a Node version outside `engines` (`>=24.22.3 <25`) fails |
| `ignore-scripts=true` | no package install script runs. A package that needs one must be named in `installScripts` of `dependency-policy.json` and rebuilt explicitly; there are none |
| `registry=https://registry.npmjs.org/` | the only registry |

CI installs with `npm ci` only. `package-lock.json` (lockfile v3) is committed.

## Exact versions and the 7-day rule

Every `dependencies` and `devDependencies` entry is an exact `x.y.z` version. Versions published
less than 7 days before adoption are not taken unless they fix a security advisory. To resolve the
transitive tree under the same rule, install with a cut-off date:

```sh
npm install --ignore-scripts --before=<date 7 days ago> <pkg>@<exact version>
```

For example, `react-router` is 8.5.1 (published 2026-10-27), not 8.5.2 (2026-11-18, under 7 days at
adoption), and `postcss` is 8.5.32 for the same reason. Dependency updates arrive in one reviewed
batch PR.

`ci:lockfile` (`npm run check:lockfile`) fails on a version that is not exact
(`non-exact-version`), a lockfile that is not v3 (`lockfile-version`), a locked package not resolved
from `https://registry.npmjs.org/` (`non-registry-resolved`) or without an `sha512` integrity hash
(`missing-integrity`).

## Dependency policy (`client/dependency-policy.json`)

| Field | Meaning |
|---|---|
| `forbiddenCategories` | `charting`, `mapping`, `3d`, `graph-diagram`, `css-in-js` (ADR-0014 §7; charts are drawn by our own renderer, ADR-0007) |
| `runtimeAllowlist` | the only names allowed in `dependencies`: `react`, `react-dom`, `react-router`, `@tanstack/react-query`, `react-aria-components`, `@internationalized/date`, `openapi-fetch` (the BFF client, ADR-0014 §1), `react-grid-layout` (the board grid, [below](#react-grid-layout)), and the ten query-editor packages ([below](#query-editor)) |
| `runtimeClosure` | every package of the runtime closure (50 today), by category: `ui-framework`, `routing`, `server-state`, `accessible-components`, `i18n`, `api-client` (`openapi-fetch` 0.17.0 and its only dependency `openapi-typescript-helpers` 0.1.0, both MIT), `runtime-helper`, `board-layout` (`react-grid-layout` and the 9 packages it adds), `query-editor` (the 17 packages of the PromQL editor) |
| `licenceAllowlist` | MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, MPL-2.0 (ADR-0014 §7, unchanged) |
| `licenceExceptionAllowlist` | exact `"<licence> WITH <exception>"` pairs; empty. Adding one needs an ADR |
| `buildUrlAllowlist` | the exact URL strings the production bundle may contain as plain text, each with a reason (namespace URIs, the URL-parsing base, error-help links) |
| `installScripts` | packages allowed an install script; empty |

`ci:dep-audit` (`npm run audit`, first step `scripts/check-deps.ts`) reads `package.json`, the
lockfile and the policy:

| Finding | When |
|---|---|
| `not-allowlisted` | a `dependencies` name is not on `runtimeAllowlist` |
| `not-in-closure` | a runtime package of the lockfile (an entry under `node_modules/` without `dev` or `devOptional`) is in no `runtimeClosure` list |
| `stale-closure` | a listed package is no longer in the runtime closure |
| `forbidden-category` | a `runtimeClosure` category is a forbidden one |
| `licence` | a runtime package has no licence, or its SPDX expression does not satisfy the allowlist |

**SPDX rules** (`scripts/lib/spdx.ts`): `OR` holds if either side does, `AND` if both do;
operators must be upper case; `X+` counts as `X`; `X WITH E` holds only if the exact pair is in
`licenceExceptionAllowlist` (the base licence alone never suffices); `LicenseRef-…`,
`DocumentRef-…`, `SEE LICENSE IN …`, an empty value or a parse error never hold.

**Adding a runtime dependency** is a reviewed change to `runtimeAllowlist` and to `runtimeClosure`,
where every new transitive package gets a category; a forbidden category cannot be listed. Dev
dependencies are not on the runtime allowlist; check their licences when adding them.

## react-grid-layout

The board grid places the panels, and in Edit mode drags and resizes them, with `react-grid-layout` **2.3.0** (MIT, published
2026-10-05; plan #61 Part B §0). Category `board-layout`, not a forbidden one. It was resolved with
the 7-day cut-off:

```sh
npm install --ignore-scripts --before=2026-11-13 react-grid-layout@2.3.0
```

and adds these runtime packages to the closure (23 → 33), all MIT, none with an install script:

| Package | Version | Published | Note |
|---|---|---|---|
| `react-grid-layout` | 2.3.0 | 2026-10-05 | the grid; renders with `nodeRef` (no `findDOMNode`), peer `react >= 16.3` |
| `react-draggable` | 4.7.2 | 2026-09-16 | drag |
| `react-resizable` | 3.2.0 | 2026-05-11 | resize handles |
| `fast-equals` | 4.0.3 | 2022-08-25 | layout comparison |
| `prop-types` | 15.8.1 | 2022-01-05 | of react-draggable and react-resizable; a shim in production |
| `object-assign` | 4.1.1 | 2017-01-16 | of prop-types |
| `loose-envify` | 1.4.0 | 2018-07-10 | of prop-types |
| `js-tokens` | 4.0.0 | 2018-01-28 | of loose-envify; already locked as a dev package, now also runtime |
| `react-is` | 16.13.1 | 2020-03-19 | of prop-types (nested under `prop-types/node_modules`) |
| `resize-observer-polyfill` | 1.5.1 | 2018-12-09 | of react-grid-layout |

`clsx`, which it also uses, was already in the closure (`accessible-components`). React 19
compatibility is checked by the component test `mounts under React 19 without errors`
(`BoardGrid.test.tsx`: no `console.error` while it mounts, drags and unmounts).

**Bundle.** Only the grid chunk loads the library: `src/pages/board/BoardGrid.tsx` (until #111
`BoardGridEditor.tsx`) is a lazy module of its own (`required.lazyModules` in
`bundle-budgets.json`), so no page but a board carries any of it. Until #111 the chunk served Edit
mode only and was preloaded when the pointer or the focus reached Edit board; since #111 one grid
serves View and Edit mode, so that the panels stay mounted across the modes, and the board route
requests the chunk when it mounts. Measured by `npm run size` (brotli, stub build) at the time of
adoption:

| Chunk | Brotli bytes | Budget |
|---|---|---|
| `BoardGridEditor` (with react-grid-layout, react-draggable, react-resizable) | 17 991 | 120 000 (`lazyChunk`) |
| `BoardPage` (the board route) | 9 978 | 120 000 (`lazyChunk`) |
| Initial JS (163 369 before the board pages) | 169 819 | 200 000 (`initialJs`) |

After #61 Part C (the filter bar, sections, and Starred and Recent from the BFF; no new
dependency), measured the same way:

| Chunk | Brotli bytes | Budget |
|---|---|---|
| `BoardGridEditor` | 18 029 | 120 000 (`lazyChunk`) |
| `BoardPage` (with the filter bar and sections) | 11 765 | 120 000 (`lazyChunk`) |
| Initial JS (with `BoardPrefs` and the sidebar lists) | 171 050 | 200 000 (`initialJs`) |

After #111 (one grid for both modes; no new dependency), measured the same way:

| Chunk | Brotli bytes | Budget |
|---|---|---|
| `BoardGrid` | 18 112 | 120 000 (`lazyChunk`) |
| `BoardPage` | 16 788 | 120 000 (`lazyChunk`) |
| Initial JS | 186 045 | 200 000 (`initialJs`) |

**Build text.** The production chunk contains two help URLs as plain text, both on
`buildUrlAllowlist`: react-draggable's `https://github.com/react-grid-layout/react-draggable#noderef`
(a warning) and the prop-types shim's `http://fb.me/use-check-prop-types` (an error message).
Neither is fetched.

**Trusted Types.** react-draggable writes a `<style>` element through `innerHTML` at the first drag,
which the CSP's Trusted Types requirement blocks; the client creates an inert marker element with
the same id first, so the library skips it ([Client application](README.md#boards)).

## Query editor

The PromQL editor chunk ([Explore](explore.md#editor-chunk), issue #63 Part B; ADR-0014 §1) adds ten
runtime dependencies, category `query-editor`, resolved with the 7-day cut-off:

```sh
npm install --ignore-scripts --before=2026-11-14 @codemirror/autocomplete@6.20.4 \
  @codemirror/commands@6.11.1 @codemirror/language@6.13.1 @codemirror/lint@6.9.8 \
  @codemirror/state@6.7.6 @codemirror/view@6.43.15 @lezer/common@1.5.5 @lezer/highlight@1.2.5 \
  @prometheus-io/codemirror-promql@0.316.0 @prometheus-io/lezer-promql@0.316.0
```

They and their transitive packages grow the runtime closure from 33 to 50. None has an install
script.

| Package | Version | Licence | Note |
|---|---|---|---|
| `@codemirror/state`, `@codemirror/view` | 6.7.6, 6.43.15 | MIT | the editor |
| `@codemirror/language`, `@codemirror/commands`, `@codemirror/autocomplete`, `@codemirror/lint` | 6.13.1, 6.11.1, 6.20.4, 6.9.8 | MIT | language support, history and keymaps, completion, the run-error underline |
| `@lezer/common`, `@lezer/highlight` | 1.5.5, 1.2.5 | MIT | syntax trees and highlight tags |
| `@prometheus-io/codemirror-promql`, `@prometheus-io/lezer-promql` | 0.316.0 | Apache-2.0 | the PromQL grammar and its completion; the package's linter and HTTP clients are never used |
| `@codemirror/streamparser`, `@lezer/lr`, `@marijn/find-cluster-break`, `crelt`, `style-mod`, `w3c-keyname` | 6.0.0, 1.4.12, 1.0.4, 1.0.7, 4.1.4, 2.2.8 | MIT | transitive |
| `lru-cache` | 11.2.2 | ISC | transitive, of `codemirror-promql` only; overridden (below) |

**The `lru-cache` override.** `codemirror-promql` 0.316.0 asks for `lru-cache ^11.5.3`, and
`lru-cache` is licensed BlueOak-1.0.0 from 11.2.3 on, which is not on the licence allowlist
(ADR-0014 §7). `package.json` therefore pins it for that package alone:

```json
"overrides": { "@prometheus-io/codemirror-promql": { "lru-cache": "11.2.2" } }
```

11.2.2 is ISC; `npm ls lru-cache` prints `lru-cache@11.2.2 overridden` under `codemirror-promql`.
The override is scoped because a global one would also replace the development-only copies other
packages need (`jsdom`'s `^11.5.3`, `@babel`'s `^5`). It is safe because the package only calls
`new LRUCache({ttl, ttlAutopurge})`, which 11.2.2 accepts, and only in its `CachedPrometheusClient`,
which the editor never builds: completion runs over our own `PrometheusClient`
(`promClient.ts`). **On every `codemirror-promql` update**, repeat the check: search its `dist` for
`lru-cache` uses, confirm they are still only in the cached HTTP client, and confirm the pinned
version still satisfies the calls. Without the override, `ci:dep-audit` fails with a `licence`
finding for `lru-cache` (`"BlueOak-1.0.0"`).

**Tests.** The package has no `exports` map, so the test runner would load its CommonJS build,
which brings a second copy of `@codemirror/state`; `vite.config.ts` points the tests at its ES
module build, as the browser build uses.

**Bundle.** No page imports the editor yet, so the build emits no editor chunk; its budget
(175 000 bytes brotli, `ci:bundle-size`, PRF-009) is checked when Part C first loads it. A trial
bundle of these packages was 121 620 bytes brotli, with no URL string other than the SVG namespace
and no HTML sink.

## Advisories and signatures

`npm run audit` then runs `npm audit --omit=dev --audit-level=high` (runtime packages, high or
critical fails), `npm audit --audit-level=critical` (all packages, critical fails) and
`npm audit signatures` (registry signatures and attestations must verify). A new advisory can fail
any PR; fix it with an exact-version bump of the affected package or of the package that pulls it
in (the 7-day rule is waived for security fixes).

## The build loads nothing from another origin

`scripts/check-build-origins.ts` (`npm run origins`, after `npm run build`) parses every JS, CSS and
HTML file of `dist/` (`acorn`, `postcss`, `parse5`) and classifies URLs by position:

- **Resource positions** fail for any absolute or protocol-relative URL (`third-party-resource`),
  whatever the origin: `import()` and static imports; `fetch`, `importScripts`,
  `navigator.sendBeacon`, `serviceWorker.register`; `new URL`, `Worker`, `SharedWorker`,
  `EventSource`, `WebSocket`, `Request`, `Image`, `Audio`, `FontFace`; assignments to `src`, `href`,
  `srcset`, `poster`, `action`, `data`, `background` and `setAttribute` with those names; CSS
  `url()`, `image-set()`, `src()` and `@import`; HTML resource attributes. The argument is resolved
  through string literals, templates, `+` and `const` bindings (`eslint-scope`), so a URL kept in a
  constant still fails. `new URL(input, base)` resolves to its input when that is absolute, else to
  its base, so a URL object built on any absolute base that reaches a sink (directly, through a
  `const`, or as `.href`) fails. The construction `new URL('http://localhost')` on its own is
  accepted: react-router uses it as a URL-parsing base and never passes it to a sink.
- **Text:** every URL in a JS string must equal a `buildUrlAllowlist` entry (`third-party-host`);
  one that runs into a `${…}` fails as `computed-url`. CSS and HTML have no allowlist. Allowlist
  entries that no longer occur are reported as `unused-url-allowlist` warnings, so the list shrinks
  with the bundle.

At run time the CSP (`'self'`-only `*-src`) blocks other origins, and `e2e:asset-origin` and
`e2e:font-origin` check that every request of every page and overlay stays on the app origin.

## SBOM

ADR-0014 §7 requires a CycloneDX SBOM on every release, made with `npm sbom --sbom-format cyclonedx`
in `client/`. There is no release workflow yet; it will attach the SBOM when it exists.

## Fonts and icons (provenance)

They are copied in, not npm dependencies:

| Asset | Source | Licence | Record |
|---|---|---|---|
| `src/assets/fonts/inter-latin-wght-normal.woff2` | `@fontsource-variable/inter` 5.3.0 | OFL-1.1 (`OFL-Inter.txt`) | `src/assets/fonts/SOURCES.md` (full SHA-256) |
| `src/assets/fonts/jetbrains-mono-latin-wght-normal.woff2` | `@fontsource-variable/jetbrains-mono` 5.3.0 | OFL-1.1 (`OFL-JetBrainsMono.txt`) | same |
| `src/icons/*.svg` (26 line icons) | `lucide-static` 1.72.0 | ISC (`LICENSE-lucide.txt`) | the `@license` comment in each file |

Fonts are self-hosted and hashed by the build (VL-010); icons are drawn as CSS masks, so no SVG
markup is injected at run time.
