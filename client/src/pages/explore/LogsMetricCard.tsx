/** The Result card of Explore › Logs (plan #66 Part C §3.9). */
import type { JSX } from 'react';
import type { LogsResult } from '../../data/decode';

export interface LogsMetricCardProps {
  /** `last.series` (§4.2): this tenant's last series answer; null before the first one. */
  readonly series: Extract<LogsResult, { kind: 'series' }> | null;
  /** state null or phase `pending`. */
  readonly fetching: boolean;
  readonly onNarrow: () => void;
}

export function LogsMetricCard(_p: LogsMetricCardProps): JSX.Element {
  throw new Error('not implemented');
}
