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
import { useOptionalRangeStore } from '../app/providers';
import { useTimeContext } from '../state/useTimeContext';
import { BoardRunContext, type BoardRun } from './boardRunContext';
import { createWidthStore } from './panelWidths';
import { createVisibilityTracker } from './visibility';

export { BoardRunContext, type BoardRun };

/** The window epoch (§4.1): called by the provider, exported for its unit test. */
export function invalidatePanelEpoch(qc: QueryClient, tenant: string): void {
  void qc.invalidateQueries({ queryKey: ['data', 'panel', tenant], refetchType: 'none' });
}

const NO_STATES: BoardRun['states'] = new Map();
const NO_TEXT: ReadonlyMap<string, string> = new Map();

export function BoardRunProvider({
  tenant,
  vars,
  states = NO_STATES,
  displayVars,
  labels = NO_TEXT,
  timeReady,
  livePanels,
  children,
}: {
  tenant: string;
  vars: BoardRun['vars'];
  states?: BoardRun['states'];
  /** Defaults to the plain-string values of `vars`. */
  displayVars?: ReadonlyMap<string, string>;
  labels?: ReadonlyMap<string, string>;
  timeReady: boolean;
  /** The ids of the board's panels now. */
  livePanels?: readonly string[];
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
  // A panel's width outlives its remounts (the Edit grid) but not the panel: a deleted panel's
  // entry goes, so a new panel that reuses its id starts without it.
  useEffect(() => {
    if (livePanels !== undefined) widths.retain(livePanels);
  }, [widths, livePanels]);

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

  // A tenant switch drops the previous tenant's range data (#304 §4.5).
  const store = useOptionalRangeStore();
  const prevTenant = useRef(tenant);
  useEffect(() => {
    if (prevTenant.current !== tenant) store?.dropTenant(prevTenant.current);
    prevTenant.current = tenant;
  }, [store, tenant]);

  const shown = useMemo(
    () =>
      displayVars ??
      new Map([...vars].flatMap(([k, v]) => (typeof v === 'string' ? [[k, v] as const] : []))),
    [displayVars, vars],
  );
  const value = useMemo<BoardRun>(
    () => ({ vars, states, displayVars: shown, labels, widths, visibility, timeReady }),
    [vars, states, shown, labels, widths, visibility, timeReady],
  );
  return <BoardRunContext.Provider value={value}>{children}</BoardRunContext.Provider>;
}
