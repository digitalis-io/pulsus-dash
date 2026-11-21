/**
 * In-repo stub of the BFF API (ADR-0014 §6): seeded data, no network. Boards are kept in memory for
 * the page's lifetime and behave as the boards API does (plan #61 Part B §3.4): one organisation
 * list for every tenant, etags, conflicts, no-op saves and field errors. Starred and Recent mirror the
 * BFF's per-user lists (plan #61 Part C §3.3, Appendix C-A §A.13): one list for every tenant, kept in
 * `localStorage`:
 *
 * - `pulsus-dash.stub.starred`: a JSON array of uids in starring order; absent → `["b-1"]`, not a
 *   string array → `[]`. Listed by title (case-folded), then uid.
 * - `pulsus-dash.stub.recent`: a JSON array of `{"uid", "at"}`, newest first, at most 200; any
 *   element of another shape → `[]`. A view keeps the greater `at` (no clamp); on an equal `at` the
 *   later write comes first. Listed in stored order, the first `RECENT_LIMIT`.
 *
 * Both lists drop uids that are no longer boards, as the server's join does.
 *
 * Test hooks: if `localStorage['pulsus-dash.stub.failSession']` is a positive integer n,
 * `getSession` rejects with `ApiError('network')` and stores n − 1. `pulsus-dash.stub.failSignOut`
 * does the same for `signOut`, `pulsus-dash.stub.failSave` for `saveBoard`,
 * `pulsus-dash.stub.failStar` for `setStarred` (nothing is changed), and
 * `pulsus-dash.stub.conflictSave` makes `saveBoard` reject with `BoardConflictError` after moving
 * the head on by one version, as if another user had saved the same spec.
 */
import { checkBoardSpec, canonicalJson } from '../boards/spec';
import type { Api } from './Api';
import { RECENT_LIMIT } from '../boards/queries';
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

export const STUB_STARRED_KEY = 'pulsus-dash.stub.starred';
export const STUB_RECENT_KEY = 'pulsus-dash.stub.recent';
/** The most views the stub keeps, as the server does. */
const RECENT_KEEP = 200;

interface RecentEntry {
  uid: string;
  at: number;
}

function isRecentEntry(x: unknown): x is RecentEntry {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return typeof e['uid'] === 'string' && typeof e['at'] === 'number';
}

function parseJson(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
export const STUB_FAIL_SESSION_KEY = 'pulsus-dash.stub.failSession';
export const STUB_FAIL_SIGN_OUT_KEY = 'pulsus-dash.stub.failSignOut';
export const STUB_FAIL_SAVE_KEY = 'pulsus-dash.stub.failSave';
export const STUB_CONFLICT_SAVE_KEY = 'pulsus-dash.stub.conflictSave';
export const STUB_FAIL_STAR_KEY = 'pulsus-dash.stub.failStar';

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
      return this.refs(this.starred()).sort((a, b) => {
        const x = a.title.toLowerCase();
        const y = b.title.toLowerCase();
        return x < y ? -1 : x > y ? 1 : a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
      });
    }, signal);
  }

  setStarred(tenant: string, uid: string, starred: boolean): Promise<void> {
    return settle(() => {
      this.checkTenant(tenant);
      if (failOnce(STUB_FAIL_STAR_KEY)) throw new ApiError('network', 'stub: star failed');
      const current = this.starred();
      if (!starred) {
        write(STUB_STARRED_KEY, JSON.stringify(current.filter((x) => x !== uid)));
        return;
      }
      if (!this.boards.some((b) => b.uid === uid)) {
        throw new ApiError('notFound', `board ${uid} not found`);
      }
      if (!current.includes(uid)) write(STUB_STARRED_KEY, JSON.stringify([...current, uid]));
    });
  }

  listRecent(tenant: string, signal?: AbortSignal): Promise<BoardRef[]> {
    return settle(() => {
      this.checkTenant(tenant);
      return this.refs(this.recent().map((e) => e.uid)).slice(0, RECENT_LIMIT);
    }, signal);
  }

  recordView(tenant: string, uid: string, at: number, signal?: AbortSignal): Promise<void> {
    return settle(() => {
      this.find(tenant, uid);
      const entries = this.recent();
      const stored = entries.find((e) => e.uid === uid)?.at ?? -Infinity;
      // The later write first on an equal time: it goes before the entries it ties with.
      const entry = { uid, at: Math.max(stored, at) };
      const others = entries.filter((e) => e.uid !== uid);
      const i = others.findIndex((e) => e.at <= entry.at);
      const next =
        i === -1 ? [...others, entry] : [...others.slice(0, i), entry, ...others.slice(i)];
      write(STUB_RECENT_KEY, JSON.stringify(next.slice(0, RECENT_KEEP)));
    }, signal);
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

  /** The stored starred uids: absent → the seed's default, invalid → none. */
  private starred(): string[] {
    const raw = read(STUB_STARRED_KEY);
    if (raw === null) return [...defaultStarred];
    const parsed = parseJson(raw);
    return Array.isArray(parsed) && parsed.every((x): x is string => typeof x === 'string')
      ? parsed
      : [];
  }

  /** The stored recent views, newest first; any invalid element → none. */
  private recent(): RecentEntry[] {
    const parsed = parseJson(read(STUB_RECENT_KEY));
    return Array.isArray(parsed) && parsed.every(isRecentEntry) ? parsed : [];
  }

  /** `{uid, title}` of each uid that is still a board, in the given order. */
  private refs(uids: readonly string[]): BoardRef[] {
    return uids.flatMap((uid) => {
      const b = this.boards.find((x) => x.uid === uid);
      return b === undefined ? [] : [{ uid, title: b.title }];
    });
  }
}
