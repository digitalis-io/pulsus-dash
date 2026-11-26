/**
 * The engine spec split (plan #263 §4.3, T05-002): one list for both Playwright configs.
 * `playwright.config.ts` ignores `engineOnlyPattern`; `playwright.engine.config.ts` selects
 * `ENGINE_ONLY_SPECS` and `ENGINE_SHARED_SPECS`. A spec that calls `tierOf` or `leg`
 * (`e2e/engine.ts`) must be listed here (`unit:engine-spec-split`).
 */

/** Specs that need an engine tier (`e2e/engine.ts` tierOf/leg): playwright.engine.config.ts only. */
export const ENGINE_ONLY_SPECS = [
  'engine-mode-matrix.spec.ts',
  'golden-engine-line.spec.ts',
  'engine-recovery.spec.ts',
  'engine-shim-fuzz.spec.ts',
  'engine-camera.spec.ts',
  'engine-hover.spec.ts',
  'engine-layer.spec.ts',
  'engine-selection.spec.ts',
] as const;

/** Specs in both suites; their engine legs skip outside the engine projects. */
export const ENGINE_SHARED_SPECS = ['csp-violations.spec.ts', 'inspector.spec.ts'] as const;

const escaped = ENGINE_ONLY_SPECS.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

/** Matches a path whose file name is exactly one of ENGINE_ONLY_SPECS. */
export const engineOnlyPattern = new RegExp(`(^|[\\\\/])(${escaped.join('|')})$`);
