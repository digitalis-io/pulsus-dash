/**
 * The Explore › Logs keys as React state (IA-022, plan #66 Part C §3.1): read from the URL through
 * `logsParams.ts`; `set` navigates to the canonical search with the time Context kept.
 */
import type { LogsParams } from './logsParams';

export function useLogsParams(): {
  readonly params: LogsParams;
  readonly set: (p: Partial<LogsParams>, o: { readonly replace: boolean }) => void;
} {
  throw new Error('not implemented');
}
