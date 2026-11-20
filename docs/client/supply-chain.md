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
| `runtimeAllowlist` | the only names allowed in `dependencies`: `react`, `react-dom`, `react-router`, `@tanstack/react-query`, `react-aria-components`, `@internationalized/date`, `openapi-fetch` (the BFF client, ADR-0014 §1) |
| `runtimeClosure` | every package of the runtime closure (23 today), by category: `ui-framework`, `routing`, `server-state`, `accessible-components`, `i18n`, `api-client` (`openapi-fetch` 0.17.0 and its only dependency `openapi-typescript-helpers` 0.1.0, both MIT), `runtime-helper` |
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
| `src/icons/*.svg` (18 line icons) | `lucide-static` 1.72.0 | ISC (`LICENSE-lucide.txt`) | the `@license` comment in each file |

Fonts are self-hosted and hashed by the build (VL-010); icons are drawn as CSS masks, so no SVG
markup is injected at run time.
