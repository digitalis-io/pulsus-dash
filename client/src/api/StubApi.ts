/**
 * In-repo stub of the BFF API (ADR-0014 §6): seeded data, no network. Boards are kept in memory for
 * the page's lifetime and behave as the boards API does (plan #61 Part B §3.4): one organisation
 * list for every tenant, etags, conflicts, no-op saves and field errors. Starred boards stand in for
 * the per-user preference and are kept in `localStorage` until Part C.
 *
 * Test hooks: if `localStorage['pulsus-dash.stub.failSession']` is a positive integer n,
 * `getSession` rejects with `ApiError('network')` and stores n − 1. `pulsus-dash.stub.failSignOut`
 * does the same for `signOut`, `pulsus-dash.stub.failSave` for `saveBoard`, and
 * `pulsus-dash.stub.conflictSave` makes `saveBoard` reject with `BoardConflictError` after moving
 * the head on by one version, as if another user had saved the same spec.
 */
import { checkBoardSpec, canonicalJson } from '../boards/spec';
import type { Api } from './Api';
import { defaultSeed, defaultStarred } from './stubData';
import { stubPanelData } from './stubPanels';
import {
  ApiError,
  BoardConflictError,
  type Board,
  type BoardList,
  type BoardRef,
  type BoardSpec,
  type PanelData,
  type PanelSpec,
  type SaveResult,
  type Session,
  type TimeWindow,
} from './types';

/** A seeded board; the stub serves it as version 1, etag `"1"`. */
export interface StubBoard {
  uid: string;
  title: string;
  /** ISO-8601 UTC. */
  updatedAt: string;
  spec: BoardSpec;
}

export interface StubSeed {
  session: Session;
  boards: StubBoard[];
}

export const STUB_STARRED_KEY = (tenant: string): string => `pulsus-dash.stub.starred.${tenant}`;
export const STUB_FAIL_SESSION_KEY = 'pulsus-dash.stub.failSession';
export const STUB_FAIL_SIGN_OUT_KEY = 'pulsus-dash.stub.failSignOut';
export const STUB_FAIL_SAVE_KEY = 'pulsus-dash.stub.failSave';
export const STUB_CONFLICT_SAVE_KEY = 'pulsus-dash.stub.conflictSave';

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
  private readonly boards: Board[];
  private readonly now: () => number;

  constructor(seed: StubSeed = defaultSeed, now: () => number = Date.now) {
    this.seed = structuredClone(seed);
    this.now = now;
    this.boards = this.seed.boards.map((b) => ({
      uid: b.uid,
      title: b.title,
      version: 1,
      updatedAt: b.updatedAt,
      updatedBy: this.seed.session.user.name,
      etag: '1',
      spec: b.spec,
    }));
  }

  getSession(signal?: AbortSignal): Promise<Session> {
    return settle(() => {
      if (failOnce(STUB_FAIL_SESSION_KEY)) {
        throw new ApiError('network', 'stub: session request failed');
      }
      return structuredClone(this.seed.session);
    }, signal);
  }

  /** Most recently updated first, as the BFF lists them. */
  listBoards(tenant: string, signal?: AbortSignal): Promise<BoardList> {
    return settle(() => {
      this.checkTenant(tenant);
      const items = [...this.boards]
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
        .map((b) => ({
          uid: b.uid,
          title: b.title,
          version: b.version,
          updatedAt: b.updatedAt,
          updatedBy: b.updatedBy,
        }));
      return { items, truncated: false };
    }, signal);
  }

  getBoard(tenant: string, uid: string, signal?: AbortSignal): Promise<Board> {
    return settle(() => structuredClone(this.find(tenant, uid)), signal);
  }

  createBoard(tenant: string, spec: BoardSpec): Promise<Board> {
    return settle(() => {
      this.checkTenant(tenant);
      this.check(spec);
      const n = Math.max(
        0,
        ...this.boards
          .map((b) => /^b-(\d+)$/.exec(b.uid))
          .map((m) => (m === null ? 0 : Number(m[1]))),
      );
      const board: Board = {
        uid: `b-${String(n + 1)}`,
        title: spec.title,
        version: 1,
        updatedAt: this.stamp(),
        updatedBy: this.seed.session.user.name,
        etag: '1',
        spec: structuredClone(spec),
      };
      this.boards.push(board);
      return structuredClone(board);
    });
  }

  saveBoard(tenant: string, uid: string, etag: string, spec: BoardSpec): Promise<SaveResult> {
    return settle(() => {
      const b = this.find(tenant, uid);
      if (failOnce(STUB_FAIL_SAVE_KEY)) throw new ApiError('network', 'stub: save failed');
      if (failOnce(STUB_CONFLICT_SAVE_KEY)) {
        this.bump(b, b.spec);
        throw new BoardConflictError(structuredClone(b));
      }
      if (etag !== b.etag) throw new BoardConflictError(structuredClone(b));
      this.check(spec);
      if (canonicalJson(spec) === canonicalJson(b.spec)) {
        return { board: structuredClone(b), changed: false };
      }
      this.bump(b, structuredClone(spec));
      return { board: structuredClone(b), changed: true };
    });
  }

  deleteBoard(tenant: string, uid: string, etag: string): Promise<void> {
    return settle(() => {
      const b = this.find(tenant, uid);
      if (etag !== b.etag) throw new BoardConflictError(structuredClone(b));
      this.boards.splice(this.boards.indexOf(b), 1);
    });
  }

  panelData(
    tenant: string,
    panel: PanelSpec,
    window: TimeWindow,
    signal?: AbortSignal,
  ): Promise<PanelData> {
    return settle(() => {
      this.checkTenant(tenant);
      return stubPanelData(panel, window);
    }, signal);
  }

  listStarred(tenant: string, signal?: AbortSignal): Promise<BoardRef[]> {
    return settle(() => {
      this.checkTenant(tenant);
      return this.starredOf(tenant).flatMap((uid) => {
        const b = this.boards.find((x) => x.uid === uid);
        return b === undefined ? [] : [{ uid, title: b.title }];
      });
    }, signal);
  }

  setStarred(tenant: string, uid: string, starred: boolean): Promise<void> {
    return settle(() => {
      this.checkTenant(tenant);
      const current = this.starredOf(tenant).filter((x) => x !== uid);
      const next = starred ? [...current, uid] : current;
      write(STUB_STARRED_KEY(tenant), JSON.stringify(next));
    });
  }

  listRecent(tenant: string, signal?: AbortSignal): Promise<BoardRef[]> {
    tenant;
    signal;
    return Promise.resolve([]);
  }

  recordView(tenant: string, uid: string, at: number, signal?: AbortSignal): Promise<void> {
    tenant;
    uid;
    at;
    signal;
    return Promise.resolve();
  }

  signOut(): Promise<void> {
    return settle(() => {
      if (failOnce(STUB_FAIL_SIGN_OUT_KEY)) throw new ApiError('network', 'stub: sign-out failed');
    });
  }

  /** Unknown tenant → `notFound`; boards belong to the organisation, so it selects nothing else. */
  private checkTenant(tenant: string): void {
    if (!this.seed.session.tenants.some((t) => t.slug === tenant)) {
      throw new ApiError('notFound', `tenant ${tenant} not found`);
    }
  }

  private find(tenant: string, uid: string): Board {
    this.checkTenant(tenant);
    const b = this.boards.find((x) => x.uid === uid);
    if (b === undefined) throw new ApiError('notFound', `board ${uid} not found`);
    return b;
  }

  private check(spec: BoardSpec): void {
    const fields = checkBoardSpec(spec);
    if (fields.length > 0) throw new ApiError('invalid', 'invalid board', fields);
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  /** A new version: version and etag + 1, `updatedAt` now. */
  private bump(b: Board, spec: BoardSpec): void {
    b.version += 1;
    b.etag = String(Number(b.etag) + 1);
    b.updatedAt = this.stamp();
    b.title = spec.title;
    b.spec = spec;
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
