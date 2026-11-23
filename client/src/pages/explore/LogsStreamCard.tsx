/** The Log lines card of Explore › Logs (plan #66 Part C §3.9). */
import type { JSX } from 'react';
import type { LogPager, LogPagerState } from '../../logs/logPager';

export interface LogsStreamCardProps {
  readonly pager: LogPager | null;
  readonly state: LogPagerState | null;
  readonly wrap: boolean;
  readonly onWrapChange: (wrap: boolean) => void;
  readonly onDirectionChange: (d: 'backward' | 'forward') => void;
  readonly onRerun: () => void;
  readonly onNarrow: () => void;
}

export function LogsStreamCard(_p: LogsStreamCardProps): JSX.Element {
  throw new Error('not implemented');
}
