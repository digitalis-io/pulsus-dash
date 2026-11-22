/**
 * The board run provider (plan #64 §3.4, §4.1, A.14): the variables, the width store, the viewport
 * tracker and the time gate every panel of one board reads, and the window epoch. Panel results are
 * fresh (`staleTime: Infinity`) only within the epoch they were fetched in: on the first ready
 * render (a board open) and on every change of the resolved window, every panel query of the tenant
 * is marked invalid without a refetch, so a visible panel queries its new key once, cached or not,
 * and a hidden one when it scrolls in.
 */
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTimeContext } from '../state/useTimeContext';
import { BoardRunContext, type BoardRun } from './boardRunContext';
import { createWidthStore } from './panelWidths';
import { createVisibilityTracker } from './visibility';

export { BoardRunContext, type BoardRun };

/** The window epoch (§4.1): called by the provider, exported for its unit test. */
export function invalidatePanelEpoch(qc: QueryClient, tenant: string): void {
  void qc.invalidateQueries({ queryKey: ['data', 'panel', tenant], refetchType: 'none' });
}

export function BoardRunProvider({
  tenant,
  vars,
  timeReady,
  children,
}: {
  tenant: string;
  vars: ReadonlyMap<string, string>;
  timeReady: boolean;
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const { window } = useTimeContext();
  const [widths] = useState(createWidthStore);
  const [visibility] = useState(createVisibilityTracker);
  useEffect(
    () => () => {
      visibility.disconnect();
    },
    [visibility],
  );

  // `${fromMs}:${toMs}` of the last epoch. A layout effect runs before the panels' passive effects
  // of the same commit, where `useQuery` moves each observer to its new key, so the mark lands first.
  const seen = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!timeReady) return;
    const w = `${String(window.fromMs)}:${String(window.toMs)}`;
    if (seen.current === w) return;
    seen.current = w;
    invalidatePanelEpoch(queryClient, tenant);
  }, [timeReady, window.fromMs, window.toMs, queryClient, tenant]);

  const value = useMemo<BoardRun>(
    () => ({ vars, widths, visibility, timeReady }),
    [vars, widths, visibility, timeReady],
  );
  return <BoardRunContext.Provider value={value}>{children}</BoardRunContext.Provider>;
}
