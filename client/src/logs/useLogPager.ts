/** The pager hooks (plan #66 Part B §3.4). Stub: implemented in the next commit. */
import type { Api } from '../api/Api';
import type { LogPager, LogPagerInput, LogPagerState } from './logPager';

export function useLogPager(
  input: LogPagerInput | null,
  api?: Pick<Api, 'queryLogs'>,
): LogPager | null {
  void input;
  void api;
  throw new Error('not implemented');
}

export function useLogPagerState(pager: LogPager | null): LogPagerState | null {
  void pager;
  throw new Error('not implemented');
}
