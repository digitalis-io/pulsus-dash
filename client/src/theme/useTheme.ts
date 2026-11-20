import { useCallback, useEffect, useState } from 'react';
import {
  PREFERS_LIGHT,
  applyTheme,
  prefersLightNow,
  readThemePref,
  resolveTheme,
  safeStorage,
  writeThemePref,
  type ResolvedTheme,
  type ThemePref,
} from './theme';

/** The theme preference; `system` follows `prefers-color-scheme` changes while it is selected. */
export function useTheme(): {
  pref: ThemePref;
  resolved: ResolvedTheme;
  setPref: (p: ThemePref) => void;
} {
  const [pref, setPrefState] = useState<ThemePref>(() => readThemePref(safeStorage()));
  const [prefersLight, setPrefersLight] = useState<boolean>(prefersLightNow);
  const resolved = resolveTheme(pref, prefersLight);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  useEffect(() => {
    if (pref !== 'system') return;
    let mql: MediaQueryList;
    try {
      mql = globalThis.matchMedia(PREFERS_LIGHT);
    } catch {
      return;
    }
    const onChange = (): void => {
      setPrefersLight(mql.matches);
    };
    onChange();
    mql.addEventListener('change', onChange);
    return () => {
      mql.removeEventListener('change', onChange);
    };
  }, [pref]);

  const setPref = useCallback((p: ThemePref) => {
    writeThemePref(safeStorage(), p);
    setPrefState(p);
  }, []);

  return { pref, resolved, setPref };
}
