/**
 * The Explore › Logs keys as React state (IA-022, plan #66 Part C §3.1): read from the URL through
 * `logsParams.ts`; `set` navigates to the canonical search with the time Context kept.
 */
import { useCallback, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { contextSearchString } from './contextSearch';
import { readLogsParams, writeLogsParams, type LogsParams } from './logsParams';
import { useTimeContext } from './useTimeContext';

export function useLogsParams(): {
  readonly params: LogsParams;
  readonly set: (p: Partial<LogsParams>, o: { readonly replace: boolean }) => void;
} {
  const { search, rest } = useTimeContext();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const params = useMemo(() => readLogsParams(rest), [rest]);
  const set = useCallback(
    (p: Partial<LogsParams>, o: { readonly replace: boolean }) => {
      const next = contextSearchString(search, writeLogsParams(rest, { ...params, ...p }));
      void navigate(pathname + next, { replace: o.replace });
    },
    [search, rest, params, navigate, pathname],
  );
  return useMemo(() => ({ params, set }), [params, set]);
}
