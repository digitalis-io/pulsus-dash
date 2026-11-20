// Stub for the tests-first commit: the implementation follows.
/**
 * Pure transitions of the time Context (INT-032, T08-008). Window actions output absolute
 * expressions. A no-op or invalid action returns the same object (`===`), so callers can skip the
 * navigation.
 */
import type { ContextSearch, RefreshInterval } from './contextSearch';

/** Stub (tests-first commit): any use throws. */
function notImplemented<T>(): T {
  const fail = (): never => {
    throw new Error('not implemented');
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail, ownKeys: fail }) as T;
}

export type ContextAction =
  | {
      type: 'step';
      dir: -1 | 1;
    }
  | {
      type: 'zoom';
      dir: 'out' | 'in';
    }
  | {
      type: 'setRange';
      from: string;
      to: string;
    }
  | {
      type: 'setRefresh';
      refresh: RefreshInterval;
    };

export const MIN_WINDOW_MS = 1000;

export const MAX_WINDOW_MS: number = notImplemented();

interface Env {
  nowMs: number;
  timeZone: string;
}

export function contextReducer(s: ContextSearch, a: ContextAction, env: Env): ContextSearch {
  throw new Error('not implemented');
}

export {};
