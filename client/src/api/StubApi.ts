/**
 * In-repo stub of the BFF API (ADR-0014 §6): seeded data, no network. Starred boards stand in for
 * the per-user preference the BFF stores from #61 and are kept in `localStorage`.
 *
 * Test hook: if `localStorage['pulsus-dash.stub.failSession']` is a positive integer n,
 * `getSession` rejects with `ApiError('network')` and stores n − 1. `pulsus-dash.stub.failSignOut`
 * does the same for `signOut`.
 */
import type { Api } from './Api';
import { defaultSeed, defaultStarred } from './stubData';
import type { InstantResult, RangeResult } from '../data/decode';
import {
  ApiError,
  type BoardSummary,
  type DataSourceStatus,
  type InstantRequest,
  type RangeRequest,
  type Session,
} from './types';

export interface StubSeed {
  session: Session;
  boards: Record<string, BoardSummary[]>;
}

export const STUB_STARRED_KEY = (tenant: string): string => `pulsus-dash.stub.starred.${tenant}`;
export const STUB_FAIL_SESSION_KEY = 'pulsus-dash.stub.failSession';
export const STUB_FAIL_SIGN_OUT_KEY = 'pulsus-dash.stub.failSignOut';

/** Consumes one failure from a test-hook counter; true when the call should fail. */
function failOnce(key: string): boolean {
  const n = Number(read(key) ?? '0');
  if (!Number.isInteger(n) || n <= 0) return false;
  write(key, String(n - 1));
  return true;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    storage()?.setItem(key, value);
  } catch {
    // Storage unavailable: the stub keeps working without persistence.
  }
}

/** Resolves on the next microtask; rejects with `AbortError` if `signal` is aborted by then. */
function settle<T>(value: () => T, signal?: AbortSignal): Promise<T> {
  return Promise.resolve().then(() => {
    if (signal?.aborted === true)
      throw new DOMException('The operation was aborted.', 'AbortError');
    return value();
  });
}

export class StubApi implements Api {
  private readonly seed: StubSeed;

  constructor(seed: StubSeed = defaultSeed) {
    this.seed = structuredClone(seed);
  }

  getSession(signal?: AbortSignal): Promise<Session> {
    return settle(() => {
      if (failOnce(STUB_FAIL_SESSION_KEY)) {
        throw new ApiError('network', 'stub: session request failed');
      }
      return structuredClone(this.seed.session);
    }, signal);
  }

  listBoards(tenant: string, signal?: AbortSignal): Promise<BoardSummary[]> {
    return settle(() => structuredClone(this.boardsOf(tenant)), signal);
  }

  getBoard(tenant: string, uid: string, signal?: AbortSignal): Promise<BoardSummary> {
    return settle(() => {
      const b = this.boardsOf(tenant).find((x) => x.uid === uid);
      if (b === undefined) throw new ApiError('notFound', `board ${uid} not found`);
      return structuredClone(b);
    }, signal);
  }

  listStarred(tenant: string, signal?: AbortSignal): Promise<string[]> {
    return settle(() => {
      this.boardsOf(tenant);
      return this.starredOf(tenant);
    }, signal);
  }

  setStarred(tenant: string, uid: string, starred: boolean): Promise<string[]> {
    return settle(() => {
      this.boardsOf(tenant);
      const current = this.starredOf(tenant).filter((x) => x !== uid);
      const next = starred ? [...current, uid] : current;
      write(STUB_STARRED_KEY(tenant), JSON.stringify(next));
      return [...next];
    });
  }

  signOut(): Promise<void> {
    return settle(() => {
      if (failOnce(STUB_FAIL_SIGN_OUT_KEY)) throw new ApiError('network', 'stub: sign-out failed');
    });
  }

  queryRange(_tenant: string, _req: RangeRequest, _signal?: AbortSignal): Promise<RangeResult> {
    return Promise.reject(new ApiError('notImplemented', 'query routes arrive with #62'));
  }

  queryInstant(
    _tenant: string,
    _req: InstantRequest,
    _signal?: AbortSignal,
  ): Promise<InstantResult> {
    return Promise.reject(new ApiError('notImplemented', 'query routes arrive with #62'));
  }

  checkDataSource(_tenant: string, _signal?: AbortSignal): Promise<DataSourceStatus> {
    return Promise.reject(new ApiError('notImplemented', 'the data-source check arrives with #62'));
  }

  private boardsOf(tenant: string): BoardSummary[] {
    const boards = this.seed.boards[tenant];
    if (boards === undefined) throw new ApiError('notFound', `tenant ${tenant} not found`);
    return boards;
  }

  private starredOf(tenant: string): string[] {
    const raw = read(STUB_STARRED_KEY(tenant));
    if (raw === null) return [...(defaultStarred[tenant] ?? [])];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((x): x is string => typeof x === 'string')) {
        return parsed;
      }
    } catch {
      // Invalid stored value: fall through to empty.
    }
    return [];
  }
}
