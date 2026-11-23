/** The Volume card of Explore › Logs (plan #66 Part C §3.9). */
import type { JSX } from 'react';
import type { LogsVolume } from '../../explore/useLogsVolume';

export interface LogsVolumeCardProps {
  readonly volume: LogsVolume;
  /** True only while the pager's phase is `streams` (§4.3). */
  readonly showError: boolean;
  readonly onNarrow: () => void;
}

export function LogsVolumeCard(_p: LogsVolumeCardProps): JSX.Element {
  throw new Error('not implemented');
}
