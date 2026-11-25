import { describe, expect, it } from 'vitest';
import { CSP, devHeaders, productionHeaders } from './headers.ts';

// ADR-0026 (ADR-0014 §9 amended for the engine), verbatim.
const ADR_0026_CSP = `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self';
manifest-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none';
frame-ancestors 'none'; require-trusted-types-for 'script';
trusted-types pulsus-sanitised pulsus-engine; report-to csp`;

describe('headers', () => {
  it('CSP is ADR-0026 joined with "; "', () => {
    const directives = ADR_0026_CSP.split(/;\s*/).map((d) => d.trim());
    expect(CSP).toBe(directives.join('; '));
    expect(CSP).not.toMatch(/'unsafe-inline'|'unsafe-eval'/);
  });

  it('production headers are the six of §3.9', () => {
    expect(productionHeaders).toEqual({
      'Content-Security-Policy': CSP,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
  });

  it('dev headers are exactly COOP and COEP', () => {
    expect(Object.keys(devHeaders).sort()).toEqual([
      'Cross-Origin-Embedder-Policy',
      'Cross-Origin-Opener-Policy',
    ]);
  });
});
