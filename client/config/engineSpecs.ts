/** Stub (#263 tests first): the engine-only specs the main config ignores today. */
export const ENGINE_ONLY_SPECS = [
  'engine-mode-matrix.spec.ts',
  'golden-engine-line.spec.ts',
  'engine-recovery.spec.ts',
] as const;
/** Specs in both suites; their engine legs skip outside the engine projects. */
export const ENGINE_SHARED_SPECS = ['csp-violations.spec.ts'] as const;
/** Stub: matches nothing. */
export const engineOnlyPattern = /(?!)/;
