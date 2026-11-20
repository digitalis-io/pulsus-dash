// Stub for the tests-first commit: the implementation follows. Plain values, because
// vite.config.ts reads them when the test runner starts.
export const CSP = '';

export const productionHeaders: Readonly<Record<string, string>> = {};

export const devHeaders: {
  readonly 'Cross-Origin-Opener-Policy': 'same-origin';
  readonly 'Cross-Origin-Embedder-Policy': 'require-corp';
} = {} as never;
