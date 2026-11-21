/**
 * The Explore keys as React state (IA-022, plan #63 §3.5): read from the URL through
 * `exploreParams.ts`; `set` navigates to the canonical search with the time Context kept.
 */
import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { contextSearchString } from './contextSearch';
import { readExploreParams, writeExploreParams, type ExploreParams } from './exploreParams';
import { useTimeContext } from './useTimeContext';

export function useExploreParams(): {
  readonly params: ExploreParams;
  set(p: Partial<ExploreParams>, o: { readonly replace: boolean }): void;
} {
  const { search, rest } = useTimeContext();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const params = useMemo(() => readExploreParams(rest), [rest]);
  const set = useCallback(
    (p: Partial<ExploreParams>, o: { readonly replace: boolean }) => {
      const next = contextSearchString(search, writeExploreParams(rest, { ...params, ...p }));
      void navigate(pathname + next, { replace: o.replace });
    },
    [search, rest, params, navigate, pathname],
  );
  return useMemo(() => ({ params, set }), [params, set]);
}
