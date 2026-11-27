/**
 * The board's health (#282 Part 2a §4.9; VL-004, VL-007): how many mounted board panels are
 * failing, for the status line under the page header. Each board panel (`PanelFrame`) reports
 * whether it is failing when that changes and forgets itself on unmount; the board page keeps the
 * reports in a ref and re-renders only when the count changes. Full screen, the editor preview and
 * collapsed sections (unmounted) do not report, so the line counts the panels in view. A
 * `PanelFrame` outside a board (no provider) reports nothing.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

export interface BoardHealth {
  report(panelId: string, failing: boolean): void;
  forget(panelId: string): void;
}

export const BoardHealthContext = createContext<BoardHealth | null>(null);

/** BoardPage: the store and the number of panels reported failing. */
export function useBoardHealthStore(): { readonly health: BoardHealth; readonly failing: number } {
  const reports = useRef(new Map<string, boolean>());
  const [failing, setFailing] = useState(0);
  const health = useMemo<BoardHealth>(() => {
    const recount = (): void => {
      let n = 0;
      for (const f of reports.current.values()) if (f) n += 1;
      // The same count bails out of the render (React compares state with Object.is).
      setFailing(n);
    };
    return {
      report(panelId, f) {
        if (reports.current.get(panelId) === f) return;
        reports.current.set(panelId, f);
        recount();
      },
      forget(panelId) {
        if (!reports.current.delete(panelId)) return;
        recount();
      },
    };
  }, []);
  return { health, failing };
}

/** PanelFrame: reports on change, forgets on unmount; a no-op without a provider. */
export function useReportHealth(panelId: string, failing: boolean): void {
  const health = useContext(BoardHealthContext);
  useEffect(() => {
    health?.report(panelId, failing);
  }, [health, panelId, failing]);
  useEffect(
    () => () => {
      health?.forget(panelId);
    },
    [health, panelId],
  );
}
