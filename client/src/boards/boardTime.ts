/** The board's time on first open (plan #64 §3.12, A.8; IA-002). */
import type { TimeRangeSpec } from '../api/types';
import type { ContextSearch } from '../state/contextSearch';

export interface TimeInit {
  /** The full search to navigate to (formatted as `normalisedSearch` does). */
  readonly search: string;
  /** The Context strings it carries. */
  readonly from: string;
  readonly to: string;
  /** `from` or `to` differ from the URL's parsed values. */
  readonly tick: boolean;
}

export type TimeTarget = TimeInit | 'url';

/** Pure. The one navigation the first-open effect makes, or null when the URL's time stands. */
export function boardTimeInit(_a: {
  readonly search: string;
  readonly linkState: boolean;
  readonly saved: TimeRangeSpec | undefined;
  readonly nowMs: number;
  readonly timeZone: string;
}): TimeInit | null {
  throw new Error('not implemented');
}

/** The URL holds `from` and `to`, and they are the target's (always true for 'url'). */
export function isTimeReady(
  _t: TimeTarget | undefined,
  _params: URLSearchParams,
  _search: ContextSearch,
): boolean {
  throw new Error('not implemented');
}
