# ADR-0016: Asset integrity is verified by the BFF, not per module in the browser

| | |
|---|---|
| **Status** | Accepted (2026-11-19, product owner) |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md): the subresource-integrity (SRI) requirement for lazy chunks in its consequences. ADR-0014 §9 (CSP, `script-src 'self'`) is unchanged |
| **Source** | Owner decision of 2026-11-19 on issue #56 |
| **See** | [T18](../technical/T18-security.md) T18-006, T18-007; [T19](../technical/T19-deployment.md) T19-005 |

## Context

ADR-0014 listed "SRI for lazy chunks" among the T18 revisions. Browser SRI does not reach every
module: a `modulepreload` with `integrity` does not bind a later `import()`, and neither covers the
modules a chunk imports. The only browser mechanism that does, the `integrity` section of an import
map, needs an inline import map (a CSP hash source in `script-src`), a runtime probe for browsers
that ignore it, and a narrower browser matrix. The threat SRI addresses is a third party altering
code in transit or at rest; for Dash the only third party in the asset path is the optional CDN.

## Decision

1. **Executable code and styles are same-origin only.** Every JS module (entry, lazy route chunks
   and everything they import), the wasm-bindgen glue, workers and CSS are served by the BFF over
   TLS in every asset mode. The CSP stays as in ADR-0014 §9 (`script-src 'self'`, `style-src 'self'`,
   `worker-src 'self'`).
2. **The BFF verifies bytes before serving.** At start-up, before it opens a listener, the BFF
   verifies the signed asset manifest and hashes **every** file of the asset set against it. Any
   mismatch, missing file or unlisted file stops start-up (fail closed). It serves only from that
   verified, read-only set.
3. **No per-module integrity in the browser.** JS and CSS carry no `integrity` attributes and there
   is no import map. Vite's defaults for module preload and CSS code splitting stay.
4. **The CDN serves no code that runs unchecked.** In CDN mode the CDN serves only the engine WASM,
   fonts and tiles. The engine WASM is fetched with `fetch(url, {integrity})` and instantiated only
   from that response, with one retry from the same-origin path.

## Consequences

- Every executable asset is same-origin over TLS. Whoever can alter a same-origin asset can also
  alter `index.html` and the CSP, so browser SRI would add nothing there; the BFF's start-up check is
  what proves the served bytes match the signed release.
- The supported-browser matrix of [T03](../technical/T03-browser-runtime.md) §9 is unchanged.
- Lazy chunks load with no extra round trip or probe.
- A compromise of the BFF host itself is out of scope for this control; it is covered by signed
  images and the supply-chain gates of T18 §4.11.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Import map with an `integrity` section, a probe, and refusal of browsers that ignore it | Needs a CSP hash source and a narrower browser matrix, and protects only against an attacker who could equally rewrite `index.html` |
| `modulepreload` with `integrity` before each `import()` | Does not bind the import; does not cover transitive imports |
| Verified fetch, then `import()` of a `blob:` URL | Needs `blob:` in `script-src` and breaks relative imports |
