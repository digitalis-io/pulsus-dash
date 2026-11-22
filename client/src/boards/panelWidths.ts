/**
 * The body widths of a board's panels (plan #64 §3.4, A.14): a panel writes its body width and the
 * panel editor's preview reads it, so both send the same `widthPx` and share one query key (#90 AC2).
 */
import { useCallback, useContext, useSyncExternalStore } from 'react';
import { BoardRunContext } from './boardRunContext';

export interface WidthStore {
  get(id: string): number | null;
  set(id: string, w: number | null): void;
  subscribe(cb: () => void): () => void;
}

export function createWidthStore(): WidthStore {
  const widths = new Map<string, number>();
  const listeners = new Set<() => void>();
  return {
    get: (id) => widths.get(id) ?? null,
    set(id, w) {
      if ((widths.get(id) ?? null) === w) return;
      if (w === null) widths.delete(id);
      else widths.set(id, w);
      for (const cb of [...listeners]) cb();
    },
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
  };
}

/** The panel body's width from the board's store; null when unknown. */
export function usePanelWidth(id: string): number | null {
  const { widths } = useContext(BoardRunContext);
  const get = useCallback(() => widths.get(id), [widths, id]);
  const subscribe = useCallback((cb: () => void) => widths.subscribe(cb), [widths]);
  return useSyncExternalStore(subscribe, get, get);
}
