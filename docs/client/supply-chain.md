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
| `runtimeAllowlist` | the only names allowed in `dependencies`: `react`, `react-dom`, `react-router`, `@tanstack/react-query`, `react-aria-components`, `@internationalized/date`, `openapi-fetch` (the BFF client, ADR-0014 §1), `react-grid-layout` (the board Edit grid, [below](#react-grid-layout)) |
| `runtimeClosure` | every package of the runtime closure (33 today), by category: `ui-framework`, `routing`, `server-state`, `accessible-components`, `i18n`, `api-client` (`openapi-fetch` 0.17.0 and its only dependency `openapi-typescript-helpers` 0.1.0, both MIT), `runtime-helper`, `board-layout` (`react-grid-layout` and the 9 packages it adds) |
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

The board's Edit mode drags and resizes panels with `react-grid-layout` **2.3.0** (MIT, published
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
(`BoardGridEditor.test.tsx`: no `console.error` while it mounts, drags and unmounts).

**Bundle.** Only the Edit-mode chunk loads the library: `src/pages/board/BoardGridEditor.tsx` is a
lazy module of its own (`required.lazyModules` in `bundle-budgets.json`), so View mode and every
other page carry none of it until the pointer or the focus reaches Edit board (the chunk is
preloaded then). Measured by `npm run size` (brotli, stub build) at the time of adoption:

| Chunk | Brotli bytes | Budget |
|---|---|---|
| `BoardGridEditor` (with react-grid-layout, react-draggable, react-resizable) | 18 050 | 120 000 (`lazyChunk`) |
| `BoardPage` (the board route) | 9 862 | 120 000 (`lazyChunk`) |
| Initial JS (163 369 before the board pages) | 169 705 | 200 000 (`initialJs`) |

**Build text.** The production chunk contains two help URLs as plain text, both on
`buildUrlAllowlist`: react-draggable's `https://github.com/react-grid-layout/react-draggable#noderef`
(a warning) and the prop-types shim's `http://fb.me/use-check-prop-types` (an error message).
Neither is fetched.

**Trusted Types.** react-draggable writes a `<style>` element through `innerHTML` at the first drag,
which the CSP's Trusted Types requirement blocks; the client creates an inert marker element with
the same id first, so the library skips it ([Client application](README.md#boards)).

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
| `src/icons/*.svg` (25 line icons) | `lucide-static` 1.72.0 | ISC (`LICENSE-lucide.txt`) | the `@license` comment in each file |

Fonts are self-hosted and hashed by the build (VL-010); icons are drawn as CSS masks, so no SVG
markup is injected at run time.
