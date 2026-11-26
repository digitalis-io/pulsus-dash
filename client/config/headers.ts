/**
 * HTTP response headers for the client (T18-001, ADR-0014 §9 as amended by ADR-0026, ADR-0016).
 *
 * `productionHeaders` are what the BFF sends on every document; `vite preview` sends them too, so
 * the end-to-end suite runs against the production CSP. The dev server sends only `devHeaders`
 * (COOP and COEP): hot reload needs inline script, which the CSP forbids.
 */

/**
 * ADR-0026, verbatim: ADR-0014 §9 with `'wasm-unsafe-eval'` (the engine's `WebAssembly.compile`)
 * and the `pulsus-engine` Trusted Types policy (the engine's worker URLs).
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  'trusted-types pulsus-sanitised pulsus-engine',
  'report-to csp',
].join('; ');

export const productionHeaders: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': CSP,
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
});

export const devHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;
