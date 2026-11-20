// Stub for the tests-first commit: the implementation follows.
/** Stub (tests-first commit): any use throws. */
function notImplemented<T>(): T {
  const fail = (): never => {
    throw new Error('not implemented');
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail, ownKeys: fail }) as T;
}

/**
 * Theme preference and the resolved theme (VL-001). The preference is kept in `localStorage`; every
 * storage access is guarded, so a blocked storage falls back to the dark default in memory.
 */
export type ThemePref = 'dark' | 'light' | 'system';

export type ResolvedTheme = 'dark' | 'light';

export const THEME_KEY = 'pulsus-dash.theme';

export const THEME_PREFS: readonly ThemePref[] = notImplemented();

export const PREFERS_LIGHT = '(prefers-color-scheme: light)';

export function isThemePref(v: unknown): v is ThemePref {
  throw new Error('not implemented');
}

export function safeStorage(): Storage | null {
  throw new Error('not implemented');
}

export function readThemePref(storage: Storage | null): ThemePref {
  throw new Error('not implemented');
}

export function writeThemePref(storage: Storage | null, p: ThemePref): void {
  throw new Error('not implemented');
}

export function resolveTheme(p: ThemePref, prefersLight: boolean): ResolvedTheme {
  throw new Error('not implemented');
}

export function prefersLightNow(): boolean {
  throw new Error('not implemented');
}

export function applyTheme(r: ResolvedTheme, root?: HTMLElement): void {
  throw new Error('not implemented');
}
