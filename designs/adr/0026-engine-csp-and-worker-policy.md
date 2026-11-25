# ADR-0026: The chart engine's CSP: `'wasm-unsafe-eval'` and the `pulsus-engine` Trusted Types policy; amends 0014 §9

| | |
|---|---|
| **Status** | Accepted (2026-11-25, on merge of #68 Part C1, under the owner's standing authorisation for pipeline design changes) |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md) §9, the document CSP: one source keyword and one Trusted Types policy name. The rest of ADR-0014, and every other directive, are unchanged |
| **Source** | Issue #68 Part C1 (the engine in the browser) |
| **See** | [T03](../technical/T03-browser-runtime.md) §5.7 (T03-022), §9.2; [T18](../technical/T18-security.md) T18-005, T18-006; [ADR-0016](0016-asset-integrity-verified-by-bff.md) |

## Context

ADR-0014 §9 fixed the document CSP and said that `'wasm-unsafe-eval'` would be added to
`script-src` by the engine issue, not before. The chart engine is one WebAssembly module, compiled
on the main thread (`WebAssembly.compileStreaming`) and instantiated in its render and pool
workers. Without `'wasm-unsafe-eval'` the browser refuses to compile it.

The CSP also has `require-trusted-types-for 'script'` with one policy, `pulsus-sanitised` (rich
text, T18-005). `new Worker(url)` is a Trusted Types sink: with the CSP as it stood, the engine's
render and pool workers cannot be started, and a default policy would admit any script URL (T18-005
forbids one). The engine's workers are same-origin ES modules (`worker-src 'self'` already admits
them); only the sink needs a trusted value.

The engine's workers run cross-origin isolated only if their scripts carry
`Cross-Origin-Embedder-Policy`. The BFF sent COEP on documents only.

## Decision

1. **`script-src 'self' 'wasm-unsafe-eval'`.** WebAssembly compilation is allowed; `'unsafe-eval'`
   stays forbidden (no `eval`, no `Function`, T03-001).
2. **`trusted-types pulsus-sanitised pulsus-engine`.** One more named policy, `pulsus-engine`,
   created once per page, only in `client/src/engine/wasm/workers.ts` (an ESLint rule forbids
   `createPolicy` elsewhere). Its `createScriptURL(u)` returns `u` only when `u`, resolved against
   the page, is one of the two engine worker scripts of this build (the render and pool workers'
   `?worker&url` imports), and throws for anything else (another path, another origin or port, a
   `blob:` URL). It has no `createHTML` or `createScript`.
3. **COEP on assets.** Every non-document file the BFF serves also carries
   `Cross-Origin-Embedder-Policy: require-corp`, with CORP and `nosniff` (T03-022).

The full document CSP is now:

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:;
font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none';
form-action 'self'; object-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script';
trusted-types pulsus-sanitised pulsus-engine; report-to csp
```

`client/config/headers.ts` (`CSP`) and `server/internal/gateway/assets.go` (`documentCSP`) are
byte-identical to it.

## Consequences

- The engine boots under the production policy with no violation (`e2e:csp-violations`, engine
  leg: gallery, a board and a recovery after a frame failure).
- The engine wasm is still integrity-checked against the BFF-verified manifest before it is
  compiled (T18-006, ADR-0016); `'wasm-unsafe-eval'` admits compilation, not unverified bytes.
- wasm-bindgen's fallback for a browser without `Atomics.waitAsync` starts a worker from a `blob:`
  URL, which the policy refuses; such a browser uses Canvas 2D (engine selection, plan #68 C1).
- A future worker (a data worker, Part D) is added to the policy's list by name, in the same file.
