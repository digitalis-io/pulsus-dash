/**
 * The time Context as React state: the URL search, read through `contextSearch.ts`, resolved
 * against the clock anchor in the browser zone (IA-002, IA-022, T03-014). Header controls, pages
 * and the window keys all use this one hook, so they always show the same window.
 */
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { createClock, type Clock } from './clock';
import { contextReducer, type ContextAction } from './contextReducer';
import {
  contextSearchString,
  readContextSearch,
  type ContextSearch,
  type SearchParamPair,
} from './contextSearch';
import { resolveTimeString } from './timeExpr';
import { useTimeZone } from './timeZone';

export const ClockContext = createContext<Clock>(createClock());

export function useClock(): Clock {
  return useContext(ClockContext);
}

export interface TimeContext {
  search: ContextSearch;
  rest: readonly SearchParamPair[];
  window: { fromMs: number; toMs: number };
  timeZone: string;
  anchorMs: number;
  dispatch: (a: ContextAction, o?: { replace?: boolean }) => void;
  refreshNow: () => void;
}

export function useTimeContext(): TimeContext {
  const [params] = useSearchParams();
  const clock = useClock();
  const timeZone = useTimeZone();
  const anchorMs = useSyncExternalStore(clock.subscribe, clock.anchor);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const queryClient = useQueryClient();

  const { search, rest } = useMemo(
    () => readContextSearch(params, { nowMs: anchorMs, timeZone }),
    [params, anchorMs, timeZone],
  );

  const window = useMemo(
    () => ({
      fromMs: resolveTimeString(search.from, anchorMs, timeZone),
      toMs: resolveTimeString(search.to, anchorMs, timeZone),
    }),
    [search, anchorMs, timeZone],
  );

  const dispatch = useCallback(
    (a: ContextAction, o?: { replace?: boolean }) => {
      const next = contextReducer(search, a, { nowMs: clock.anchor(), timeZone });
      if (next === search) return;
      if (next.from !== search.from || next.to !== search.to) clock.tick();
      void navigate(
        { pathname, search: contextSearchString(next, rest) },
        { replace: o?.replace ?? false },
      );
    },
    [search, rest, clock, timeZone, navigate, pathname],
  );

  const refreshNow = useCallback(() => {
    clock.tick();
    void queryClient.invalidateQueries({ queryKey: ['data'] });
  }, [clock, queryClient]);

  return { search, rest, window, timeZone, anchorMs, dispatch, refreshNow };
}
