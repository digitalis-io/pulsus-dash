/**
 * Auto-refresh (IA-020): every `refresh` interval, unless off, calls `refreshNow()`. Ticks are
 * skipped while the document is hidden. The interval is cleared when the value changes or the shell
 * unmounts.
 */
import { useEffect, useRef } from 'react';
import { refreshMs, type RefreshInterval } from './contextSearch';

export function useAutoRefresh(refresh: RefreshInterval, refreshNow: () => void): void {
  const latest = useRef(refreshNow);
  useEffect(() => {
    latest.current = refreshNow;
  }, [refreshNow]);
  useEffect(() => {
    const ms = refreshMs(refresh);
    if (ms === null) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      latest.current();
    }, ms);
    return () => {
      clearInterval(id);
    };
  }, [refresh]);
}
