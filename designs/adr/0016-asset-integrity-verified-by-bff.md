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

1. **Same origin, with one hash-checked exception.** Every JS module (entry, lazy route chunks and
   everything they import, the wasm-bindgen glue), CSS file and worker is served by the BFF over TLS
   in every asset mode. The one executable asset that may come from the CDN is the engine WASM, which
   is fetched with `integrity` and compiled only from that verified response, with a same-origin
   retry (point 4). The CSP stays as in ADR-0014 §9 (`script-src 'self'`, `style-src 'self'`,
   `worker-src 'self'`).
2. **The BFF verifies bytes before serving.** The verification metadata is outside the set it
   lists: `asset-manifest.json` (`{path, sha384, size}` for every asset file, not itself) and a
   detached `asset-manifest.sig`, an Ed25519 signature over the manifest's exact bytes made with the
   release key in KMS. The BFF verifies the signature with the release public key compiled into its
   binary, then, before it opens a listener, hashes **every** asset file against the manifest. Any
   mismatch, missing file, or unlisted file other than the manifest and its signature stops start-up
   (fail closed). It serves only from that verified, read-only set.
3. **No per-module integrity in the browser.** JS and CSS carry no `integrity` attributes and there
   is no import map. Vite's defaults for module preload and CSS code splitting stay.
4. **The CDN serves no code that runs unchecked.** In CDN mode the CDN serves only the engine WASM,
   fonts and tiles. The engine WASM is fetched with `fetch(url, {integrity})` and instantiated only
   from that response, with one retry from the same-origin path.

## Consequences

- Every JS module, CSS file and worker is same-origin over TLS; the one executable asset that may
  come from the CDN is the engine WASM, which is fetched with `integrity` and compiled only from that
  verified response, with a same-origin retry. Whoever can alter a same-origin asset can also
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

## Review responses

| Round | # | Finding | Response | Change made |
|---|---|---|---|---|
| r6 | 16 | The ADR lets the engine WASM come from the CDN while saying every executable asset is same-origin | The CDN allowance is the owner's decision. The option the owner approved on 2026-11-19 reads: "The CDN still serves only the chart engine (hash-checked), fonts and map tiles." The contradiction was in the wording, not the design | "Every executable asset is same-origin" replaced, here and in T18 and T19, by "every JS module, CSS file and worker is same-origin; the one executable asset that may come from the CDN is the engine WASM, fetched with `integrity` and compiled only from that verified response, with a same-origin retry" |
| r6 | 17 | The manifest could not list its own hash | Verification metadata is now outside the listed set | Detached Ed25519 `asset-manifest.sig`, public key compiled into the BFF, only the manifest and its signature exempt from listing (decision point 2) |
