// Stub for the tests-first commit: the implementation follows.
import { type Clock } from './clock';

import { type ContextAction } from './contextReducer';

import { type ContextSearch, type SearchParamPair } from './contextSearch';

/** Stub (tests-first commit): any use throws. */
function notImplemented<T>(): T {
  const fail = (): never => {
    throw new Error('not implemented');
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail, ownKeys: fail }) as T;
}

export const ClockContext: import('react').Context<Clock> = notImplemented();

export function useClock(): Clock {
  throw new Error('not implemented');
}

export interface TimeContext {
  search: ContextSearch;
  rest: readonly SearchParamPair[];
  window: {
    fromMs: number;
    toMs: number;
  };
  timeZone: string;
  anchorMs: number;
  dispatch: (
    a: ContextAction,
    o?: {
      replace?: boolean;
    },
  ) => void;
  refreshNow: () => void;
}

export function useTimeContext(): TimeContext {
  throw new Error('not implemented');
}
