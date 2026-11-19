# ADR-0016: Module integrity through a build-time import map

| | |
|---|---|
| **Status** | Proposed (2026-11-19) — awaits product-owner acceptance |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md) §9 (adds one hash source to `script-src`) and the supported-browser floor of [T03](../technical/T03-browser-runtime.md) §9 |
| **Source** | Issue #56: subresource integrity for lazy chunks, required by ADR-0014's consequences ([T18](../technical/T18-security.md) T18-006) |
| **See** | [T18](../technical/T18-security.md) §4.3, [T19](../technical/T19-deployment.md) §4.1, [T05](../technical/T05-testing-and-performance.md) |

## Context

ADR-0014 requires subresource integrity (SRI) for lazy route chunks. A `<script integrity>` covers
only the entry. A `<link rel="modulepreload" integrity>` does not stop a later `import()` of the
same URL after a failed preload. Neither covers the chunks a module imports. The one browser
mechanism that attaches integrity to *every* module fetch by URL is the `integrity` section of an
import map. Import maps cannot be loaded from a URL, so the map is an inline
`<script type="importmap">`, which the ADR-0014 §9 CSP blocks unless its hash is allowed.

## Decision

1. **Import map with integrity.** The client build writes one inline `<script type="importmap">`
   into `index.html` whose `integrity` section lists the `sha384` of **every** emitted JS file under
   `/assets/`. Vite's own preload helper is disabled (`build.modulePreload: false`); the build adds
   `<link rel="modulepreload" integrity>` for the entry's dependencies itself.
2. **CSP.** `script-src` becomes `'self' 'sha256-<hash of the import map>'`. The hash is computed at
   build time, recorded in the signed asset manifest, and added by the BFF. No other inline script is
   allowed; `'unsafe-inline'` stays forbidden (T18-001).
3. **Bootstrap with no imports.** The entry module `boot.<hash>.js` (loaded by
   `<script type="module" integrity>`) imports nothing statically. It first imports a probe module
   whose import-map entry carries a deliberately wrong hash. If that import *succeeds*, the browser
   does not enforce import-map integrity: boot shows "This browser cannot verify Pulsus Dash's code"
   and imports nothing else. Only when the probe is rejected does boot import the application.
4. **Browser floor.** Supported browsers are those that enforce import-map integrity. The probe, not
   a version number, decides at run time; at the time of writing that is Chromium 127+, Firefox 138+
   (ESR 140+) and Safari 18+.
5. **Workers and CSS.** Import maps do not apply inside workers, so every worker script is a
   single-file bundle with no imports, covered by the BFF's per-file check (T18-006). CSS is not code-
   split (`build.cssCodeSplit: false`), so the one stylesheet is loaded with `<link integrity>`.

## Consequences

- Every JS module, including transitive imports, is verified by the browser before it runs, and
  every served file is verified by the BFF against the signed manifest at start-up.
- Browsers below the floor, including Safari 17, get the "cannot verify" page instead of the
  application. If current iOS Safari did not enforce import-map integrity, the mobile PWA (device (e)
  of [09](../product/09-performance-contract.md)) would be blocked; the cross-engine `e2e` tests
  detect this before release.
- One probe request (≈ 100 bytes, cached immutably) on cold load, fetched in parallel with the
  application's modulepreloads.
- All initial and lazy CSS is one file, held to the ADR-0014 §8 initial-CSS budget (≤ 30 KB).

## Alternatives considered

| Alternative | Why not |
|---|---|
| `modulepreload` with `integrity` before each `import()` | Does not bind the import; does not cover transitive imports |
| Verified fetch, then `import()` of a `blob:` URL | Needs `blob:` in `script-src`, breaks relative imports inside the module, and every transitive import would need the same rewrite |
| No browser-side SRI; same-origin code only | Does not meet ADR-0014's lazy-chunk SRI requirement |
| Fallback path for browsers without import-map integrity | Any such path either loads unverified code or needs the `blob:` route above |
