/**
 * The resolved theme as React state: `data-theme` on the root element, followed with a
 * MutationObserver, so charts redraw when `useTheme` (or anything else) changes it (VL-001).
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { ResolvedTheme } from './theme';

function read(root: HTMLElement): ResolvedTheme {
  return root.dataset['theme'] === 'light' ? 'light' : 'dark';
}

export function useResolvedTheme(root: HTMLElement = document.documentElement): ResolvedTheme {
  const subscribe = useCallback(
    (cb: () => void) => {
      const o = new MutationObserver(cb);
      o.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
      return () => {
        o.disconnect();
      };
    },
    [root],
  );
  return useSyncExternalStore(subscribe, () => read(root));
}
