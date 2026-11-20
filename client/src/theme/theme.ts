/**
 * Theme preference and the resolved theme (VL-001). The preference is kept in `localStorage`; every
 * storage access is guarded, so a blocked storage falls back to the dark default in memory.
 */
export type ThemePref = 'dark' | 'light' | 'system';
export type ResolvedTheme = 'dark' | 'light';

export const THEME_KEY = 'pulsus-dash.theme';
export const THEME_PREFS: readonly ThemePref[] = ['dark', 'light', 'system'];
export const PREFERS_LIGHT = '(prefers-color-scheme: light)';

export function isThemePref(v: unknown): v is ThemePref {
  return v === 'dark' || v === 'light' || v === 'system';
}

export function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readThemePref(storage: Storage | null): ThemePref {
  try {
    const v = storage?.getItem(THEME_KEY);
    return isThemePref(v) ? v : 'dark';
  } catch {
    return 'dark';
  }
}

export function writeThemePref(storage: Storage | null, p: ThemePref): void {
  try {
    storage?.setItem(THEME_KEY, p);
  } catch {
    // Storage unavailable: the preference lives for this page only.
  }
}

export function resolveTheme(p: ThemePref, prefersLight: boolean): ResolvedTheme {
  if (p === 'system') return prefersLight ? 'light' : 'dark';
  return p;
}

export function prefersLightNow(): boolean {
  try {
    return globalThis.matchMedia(PREFERS_LIGHT).matches;
  } catch {
    return false;
  }
}

export function applyTheme(r: ResolvedTheme, root: HTMLElement = document.documentElement): void {
  root.dataset['theme'] = r;
}
