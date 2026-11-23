/** The virtualised log list (plan #66 Part B §3.7). Stub: implemented in a later commit. */
import type { JSX, Ref } from 'react';
import type { LogPager } from './logPager';
import type { ViewLimits } from './slice';

export const PREFETCH_ROWS = 2_000;
export const OVERSCAN = 10;

export interface LogStreamHandle {
  scrollToOrd(ord: number): void;
}

export type ResliceCause = 'edge' | 'extent' | 'hard' | 'wrap' | 'scrollTo';

export interface LogStreamProps {
  readonly pager: LogPager;
  readonly label: string;
  readonly wrap: boolean;
  readonly onWrapChange: (wrap: boolean) => void;
  readonly onDirectionChange: (d: 'backward' | 'forward') => void;
  readonly onRerun: () => void;
  readonly view?: ViewLimits;
  readonly onScrollWrite?: () => void;
  readonly onReslice?: (cause: ResliceCause, isScrolling: boolean) => void;
  readonly wrapEstimate?: 'bound' | 'row';
  readonly ref?: Ref<LogStreamHandle>;
}

export function LogStream(props: LogStreamProps): JSX.Element | null {
  void props;
  throw new Error('not implemented');
}
