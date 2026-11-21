/**
 * The board's URL parameters as React state (plan #61 Part C §3.6), over the time Context's `rest`
 * pairs. Variables and filters are a navigation each (Back undoes them); section overrides replace
 * the entry (a toggle is view state). A write that would take the board link over the budget is
 * refused with `'url.tooLong'` and does not navigate; a removal is never refused.
 */
import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  COLLAPSE_PARAM,
  EXPAND_PARAM,
  fitsUrlBudget,
  MAX_REQUEST_TARGET,
  readBoardParams,
  requestTargetBytes,
  SHARE_RESERVE,
  withFilter,
  withoutSectionOverrides,
  withSectionOverride,
  withVar,
  type BoardParams,
  type ParamError,
} from './boardParams';
import { contextSearchString, type SearchParamPair } from './contextSearch';
import { useTimeContext } from './useTimeContext';

export interface BoardParamsState {
  params: BoardParams;
  /** Push; `'url.tooLong'` → no navigation. */
  setVar: (name: string, value: string | null) => ParamError | null;
  /** Push; `'url.tooLong'` → no navigation. */
  setFilter: (key: string, value: string | null) => ParamError | null;
  /** Replace; re-checked against the current URL. */
  setSectionOverride: (id: string, collapsed: boolean | null) => ParamError | null;
  /** Replace; a no-op when there are none. */
  clearSectionOverrides: () => void;
}

export function useBoardParams(sectionIds: readonly string[]): BoardParamsState {
  const { search, rest } = useTimeContext();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const params = useMemo(() => readBoardParams(rest), [rest]);

  const go = useCallback(
    (next: readonly SearchParamPair[], replace: boolean): void => {
      void navigate({ pathname, search: contextSearchString(search, next) }, { replace });
    },
    [navigate, pathname, search],
  );

  const budgeted = useCallback(
    (next: SearchParamPair[], removal: boolean): ParamError | null => {
      if (!removal && !fitsUrlBudget(pathname, search, next, sectionIds)) return 'url.tooLong';
      go(next, false);
      return null;
    },
    [go, pathname, search, sectionIds],
  );

  const setVar = useCallback(
    (name: string, value: string | null) => budgeted(withVar(rest, name, value), value === null),
    [budgeted, rest],
  );

  const setFilter = useCallback(
    (key: string, value: string | null) => budgeted(withFilter(rest, key, value), value === null),
    [budgeted, rest],
  );

  const setSectionOverride = useCallback(
    (id: string, collapsed: boolean | null): ParamError | null => {
      const next = withSectionOverride(rest, id, collapsed, sectionIds);
      const bytes = requestTargetBytes(pathname, contextSearchString(search, next));
      if (collapsed !== null && bytes + SHARE_RESERVE > MAX_REQUEST_TARGET) return 'url.tooLong';
      go(next, true);
      return null;
    },
    [go, pathname, rest, search, sectionIds],
  );

  const clearSectionOverrides = useCallback((): void => {
    if (!rest.some(([k]) => k === COLLAPSE_PARAM || k === EXPAND_PARAM)) return;
    go(withoutSectionOverrides(rest), true);
  }, [go, rest]);

  return { params, setVar, setFilter, setSectionOverride, clearSectionOverrides };
}
