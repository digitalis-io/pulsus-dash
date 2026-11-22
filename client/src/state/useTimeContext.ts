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

  // Refresh now and each auto-refresh tick (plan #64 §3.9, #101). Rule: every `['data', …]` key
  // includes the resolved window. When the tick moves the window (a relative range), every key is
  // new and the observers fetch them: no cancel, so no old key restarts. When it does not (an
  // absolute range, or `now/d`), the keys are the same: the requests in flight, first fetches
  // included, are cancelled (`invalidateQueries` alone would reuse a first fetch), then the active
  // queries rerun and the rest are marked to refetch when they are next observed. `cancelQueries`
  // aborts synchronously, so no `await` is needed before the new fetch.
  const refreshNow = useCallback(() => {
    clock.tick();
    const a = clock.anchor();
    const moved =
      resolveTimeString(search.from, a, timeZone) !== window.fromMs ||
      resolveTimeString(search.to, a, timeZone) !== window.toMs;
    if (moved) return;
    void queryClient.cancelQueries({ queryKey: ['data'] });
    void queryClient.invalidateQueries({ queryKey: ['data'] });
  }, [clock, queryClient, search, timeZone, window]);

  return { search, rest, window, timeZone, anchorMs, dispatch, refreshNow };
}
