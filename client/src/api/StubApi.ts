// Stub for the tests-first commit: the implementation follows.
/**
 * In-repo stub of the BFF API (ADR-0014 §6): seeded data, no network. Starred boards stand in for
 * the per-user preference the BFF stores from #61 and are kept in `localStorage`.
 *
 * Test hook: if `localStorage['pulsus-dash.stub.failSession']` is a positive integer n,
 * `getSession` rejects with `ApiError('network')` and stores n − 1.
 */
import type { Api } from './Api';

import { type BoardSummary, type Session } from './types';

/** Stub (tests-first commit): any use throws. */
function notImplemented<T>(): T {
  const fail = (): never => {
    throw new Error('not implemented');
  };
  return new Proxy(fail, { get: fail, apply: fail, construct: fail, ownKeys: fail }) as T;
}

export interface StubSeed {
  session: Session;
  boards: Record<string, BoardSummary[]>;
}

export const STUB_STARRED_KEY: (tenant: string) => string = notImplemented();

export const STUB_FAIL_SESSION_KEY = 'pulsus-dash.stub.failSession';

export class StubApi implements Api {
  constructor(seed?: StubSeed) {
    throw new Error('not implemented');
  }

  getSession(signal?: AbortSignal): Promise<Session> {
    throw new Error('not implemented');
  }

  listBoards(tenant: string, signal?: AbortSignal): Promise<BoardSummary[]> {
    throw new Error('not implemented');
  }

  getBoard(tenant: string, uid: string, signal?: AbortSignal): Promise<BoardSummary> {
    throw new Error('not implemented');
  }

  listStarred(tenant: string, signal?: AbortSignal): Promise<string[]> {
    throw new Error('not implemented');
  }

  setStarred(tenant: string, uid: string, starred: boolean): Promise<string[]> {
    throw new Error('not implemented');
  }

  signOut(): Promise<void> {
    throw new Error('not implemented');
  }
}
