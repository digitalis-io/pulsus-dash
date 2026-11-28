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
 *   later write comes first. Listed in stored order, the first `limit` (default `RECENT_LIMIT`).
 *
 * The boards list filters as the BFF (plan #216 Part 1 §4.2): `q` matches when the ASCII-lower title
 * contains the ASCII-lower `q` or the ASCII-lower `q` equals a tag, `tag` when it equals a tag, both
 * must hold; the item tags are `spec.tags` (or `[]`), `applied` is the filter and `tagsStale` 0. Each
 * list's `truncated` is computed before it is cut, as the BFF's: boards over 1 000, starred over 200,
 * recent over the limit.
 *
 * Both lists drop uids that are no longer boards, as the server's join does.
 *
 * Test hooks: if `localStorage['pulsus-dash.stub.failSession']` is a positive integer n,
 * `getSession` rejects with `ApiError('network')` and stores n − 1. `pulsus-dash.stub.failSignOut`
 * does the same for `signOut`, `pulsus-dash.stub.failSave` for `saveBoard`,
 * `pulsus-dash.stub.failStar` for `setStarred` (nothing is changed), and
 * `pulsus-dash.stub.conflictSave` makes `saveBoard` reject with `BoardConflictError` after moving
 * the head on by one version, as if another user had saved the same spec. For `queryRange` and
 * `queryInstant` (#90, plan #64 §3.10): `pulsus-dash.stub.queryDelayMs`, a positive integer n,
 * waits n ms before the call is planned (an abort clears the timer and rejects with `AbortError`;
 * read on every call, never consumed); `pulsus-dash.stub.failQuery` fails the call as `failSave`
 * does, after the delay; and every call leaves a `stub:query` performance mark with
 * `{ kind: 'range' | 'instant', query }` (the raw request text). `pulsus-dash.stub.boards`, a JSON
 * array of `{ uid, title, updatedAt, spec }`, adds those boards to the seed when the stub is made
 * (plan #198 Part 3b: `bench:text-widget-render`'s board); an entry whose spec fails the save's
 * rules, or whose uid is taken, is skipped, and anything but an array adds none. HTTP builds compile
 * this hook out.
 */
import { checkBoardSpec, canonicalJson } from '../boards/spec';
import type { Api } from './Api';
import { RECENT_LIMIT } from '../boards/queries';
import {
  defaultSeed,
  defaultStarred,
  STUB_LOG_LABEL_VALUES,
  STUB_LOG_LABELS,
  STUB_PROM_LABEL_VALUES,
  STUB_PROM_LABELS,
  STUB_PROM_METADATA,
  STUB_PROM_METRIC_NAMES,
  STUB_SCOPE,
} from './stubData';
import type {
  Completeness,
  InstantResult,
  LogqlPlannedQuery,
  LogsResult,
  PlannedQuery,
  PromMetadata,
  PromSeriesSet,
  PromValues,
  RangeResult,
  VolumeResult,
} from '../data/decode';
import type { SeriesFrame } from '../data/frames';
import { LOG_LEVELS, type LogFrame } from '../data/logFrame';
import { logGrid, promGrid, promGridAt } from '../data/step';
import { keyHash } from '../dev/keyHash';
import { synthLineValue } from '../dev/synth';
import type { MetricTypes, PlanInputs, StubPlanError } from './stub/plan';
import type { LogsPlanInputs, LogsStubPlanError } from './stub/logsPlan';
import { anyStructured, loadMirror, mirrorLoaded } from './stub/varsCore';
import {
  ApiError,
  BoardConflictError,
  type Board,
  type AnnotationList,
  type BoardPage,
  type BoardRef,
  type RefPage,
  type BoardSpec,
  type DataSourceStatus,
  type InstantRequest,
  type LogMatchRequest,
  type LogsRequest,
  type PromMatchRequest,
  type RangeRequest,
  type SaveResult,
  type Session,
  type VolumeRequest,
  type VariableValues,
  type VariableValuesRequest,
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
export const STUB_QUERY_DELAY_KEY = 'pulsus-dash.stub.queryDelayMs';
export const STUB_FAIL_QUERY_KEY = 'pulsus-dash.stub.failQuery';
export const STUB_BOARDS_KEY = 'pulsus-dash.stub.boards';

/** The most boards `listBoards` and the most starred boards `listStarred` return (as the BFF). */
const MAX_LISTED_BOARDS = 1000;
const MAX_LISTED_STARRED = 200;

/** ASCII-only lower case (the board search's folding). */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** Consumes one failure from a test-hook counter; true when the call should fail. */
function failOnce(key: string): boolean {
  const n = Number(read(key) ?? '0');
  if (!Number.isInteger(n) || n <= 0) return false;
  write(key, String(n - 1));
  return true;
}

/** The query delay of the test hook, in ms; null for none. */
function queryDelayMs(): number | null {
  const n = Number(read(STUB_QUERY_DELAY_KEY) ?? '');
  return Number.isInteger(n) && n > 0 ? n : null;
}

const aborted = (): DOMException => new DOMException('The operation was aborted.', 'AbortError');

/** Resolves after `ms`; an abort of `signal` clears the timer and rejects with `AbortError`. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(aborted());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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

function isStubBoard(x: unknown): x is StubBoard {
  if (typeof x !== 'object' || x === null) return false;
  const b = x as Record<string, unknown>;
  return (
    typeof b['uid'] === 'string' &&
    typeof b['title'] === 'string' &&
    typeof b['updatedAt'] === 'string' &&
    typeof b['spec'] === 'object' &&
    b['spec'] !== null
  );
}

/** The valid boards of `pulsus-dash.stub.boards` whose uids `seeded` does not hold. */
function extraBoards(seeded: readonly StubBoard[]): StubBoard[] {
  // HTTP builds still make a StubApi (the ApiContext default): the static condition compiles the
  // hook, and its key, out of them, so production startup never reads stub storage.
  if (import.meta.env.VITE_API_MODE === 'http') return [];
  const raw = parseJson(read(STUB_BOARDS_KEY));
  if (!Array.isArray(raw)) return [];
  const uids = new Set(seeded.map((b) => b.uid));
  const out: StubBoard[] = [];
  for (const x of raw as unknown[]) {
    if (!isStubBoard(x) || uids.has(x.uid) || checkBoardSpec(x.spec).length > 0) continue;
    uids.add(x.uid);
    out.push(x);
  }
  return out;
}

/** The levels of the stub log streams `stub-0`, `stub-1` and `stub-2`. */
const STUB_LEVELS = ['info', 'warn', 'error'] as const;

/** Stub frames have no upstream, so nothing is truncated or cached. */
const EMPTY_COMPLETENESS: Completeness = {
  truncated: false,
  warnings: [],
  infos: [],
  queryId: null,
  dataAgeMs: null,
  readCache: null,
  readCacheThroughMs: null,
};

/** Three synthetic series `stub_metric{series="0|1|2"}` at the given timestamps. */
function stubSeries(timestamps: Float64Array): SeriesFrame[] {
  return [0, 1, 2].map((j) => {
    const labels = { __name__: 'stub_metric', series: String(j) };
    return {
      key: keyHash(labels),
      labels,
      timestamps,
      values: timestamps.map((t) => synthLineValue(62, j, t, 100, 40)),
    };
  });
}

/** The `le` bounds of `stubBuckets`. */
const BUCKET_BOUNDS = [
  '0.005',
  '0.01',
  '0.025',
  '0.05',
  '0.1',
  '0.25',
  '0.5',
  '1',
  '2.5',
  '5',
  '10',
  '+Inf',
];

/**
 * Twelve cumulative buckets `stub_bucket{le}` (plan #64 §3.10): bucket `k` at `t` is
 * `(k + 1) × synthLineValue(62, 0, t, 100, 40) / 12`, non-decreasing in `le`.
 */
function stubBuckets(timestamps: Float64Array): SeriesFrame[] {
  return BUCKET_BOUNDS.map((le, k) => {
    const labels = { __name__: 'stub_bucket', le };
    return {
      key: keyHash(labels),
      labels,
      timestamps,
      values: timestamps.map((t) => ((k + 1) * synthLineValue(62, 0, t, 100, 40)) / 12),
    };
  });
}

/** The truncation warning the stub gives a `topk(1000` query (plan #64 A.3). */
const TRUNCATED_WARNING = 'results truncated due to limit';

/** Leaves the `stub:query` mark, waits the hook's delay, then fails the call if the hook says so. */
async function queryHooks(
  kind: 'range' | 'instant',
  query: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    performance.mark('stub:query', { detail: { kind, query } });
  } catch {
    // The User Timing API is optional: the stub does not depend on it.
  }
  const delay = queryDelayMs();
  if (delay !== null) await sleep(delay, signal);
  if (failOnce(STUB_FAIL_QUERY_KEY)) throw new ApiError('network', 'stub: query failed');
}

/** The server's metadata read: the route's maximum (plan #112 §3.2). */
const METADATA_LIMIT = 10_000;
/** How long a plan waits for metric types before it degrades (plan #112 §4.5). */
const TYPES_WAIT_MS = 2_000;

type Planners = typeof import('./stub/planners');
let planners: Planners | null = null;
let loadingPlanners: Promise<Planners> | null = null;

/**
 * The planner mirror, loaded on demand (#289: it is not in the initial chunk); every `StubApi`
 * starts loading it, so a query rarely waits.
 */
function loadPlanners(): Promise<Planners> {
  loadingPlanners ??= import('./stub/planners').then((m) => (planners = m));
  return loadingPlanners;
}

/** The loaded planner mirror (every planning path loads it first). */
function loadedPlanners(): Planners {
  if (planners === null) throw new Error('stub: the planner mirror is not loaded');
  return planners;
}

function completeness(warn: boolean): Completeness {
  return warn
    ? { ...EMPTY_COMPLETENESS, warnings: [loadedPlanners().WARN_TYPES_UNAVAILABLE] }
    : EMPTY_COMPLETENESS;
}

/** `p`, or a rejection after `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error('stub: metric types not ready'));
    }, ms);
  });
  return Promise.race([p, late]).finally(() => {
    clearTimeout(timer);
  });
}

/** The gateway's 400 virtual_unsupported, as HttpApi maps it (A.11). */
function reservedRefusal(name: string, planned?: PlannedQuery | LogqlPlannedQuery): ApiError {
  return new ApiError(
    'queryInvalid',
    `${name} is a reserved Pulsus Dash name and is not supported yet (it may appear only inside a string)`,
    { detail: { hint: { reserved: name }, ...(planned === undefined ? {} : { planned }) } },
  );
}

/** What HttpApi's `queryError` gives for the gateway's body of a planning refusal (A.11). */
function toApiError(e: StubPlanError | LogsStubPlanError): ApiError {
  if (e.status === 413) {
    return new ApiError('queryTooLong', e.message, {
      detail: {
        ...(e.hint === undefined ? {} : { hint: e.hint }),
        ...(e.planned === undefined ? {} : { planned: e.planned }),
      },
    });
  }
  const pointer = e.fields[0]?.pointer ?? '';
  if (pointer === '/query') {
    // Row 9b (plan #121): the position of a top-level '#', as HttpApi reads hint.position.
    const position =
      e.hint !== undefined && 'position' in e.hint ? e.hint.position.offset : undefined;
    return new ApiError('queryInvalid', e.message, {
      detail: position === undefined ? {} : { position },
    });
  }
  return new ApiError('invalid', e.message, { fields: e.fields });
}

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
    void loadPlanners();
    this.seed = structuredClone(seed);
    this.seed.boards.push(...extraBoards(this.seed.boards));
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

  /** The stub has no annotations (plan #64 Part C §3.5). */
  listAnnotations(
    tenant: string,
    _window: { fromMs: number; toMs: number },
    signal?: AbortSignal,
  ): Promise<AnnotationList> {
    return settle(() => {
      this.checkTenant(tenant);
      return { items: [], truncated: false, applied: {}, next: null, orgWideHidden: 0 };
    }, signal);
  }

  /** Most recently updated first, as the BFF lists them, filtered as the BFF (see above). */
  listBoards(
    tenant: string,
    signal?: AbortSignal,
    f?: { readonly q?: string; readonly tag?: string },
  ): Promise<BoardPage> {
    return settle(() => {
      this.checkTenant(tenant);
      const q = f?.q !== undefined && f.q !== '' ? f.q : undefined;
      const tag = f?.tag;
      const folded = q === undefined ? '' : asciiLower(q);
      const matching = [...this.boards]
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
        .map((b) => ({
          uid: b.uid,
          title: b.title,
          version: b.version,
          updatedAt: b.updatedAt,
          updatedBy: b.updatedBy,
          tags: [...(b.spec.tags ?? [])],
        }))
        .filter(
          (b) =>
            (q === undefined || asciiLower(b.title).includes(folded) || b.tags.includes(folded)) &&
            (tag === undefined || b.tags.includes(tag)),
        );
      return {
        items: matching.slice(0, MAX_LISTED_BOARDS),
        truncated: matching.length > MAX_LISTED_BOARDS,
        applied: { ...(q === undefined ? {} : { q }), ...(tag === undefined ? {} : { tag }) },
        tagsStale: 0,
      };
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

  listStarred(tenant: string, signal?: AbortSignal): Promise<RefPage> {
    return settle(() => {
      this.checkTenant(tenant);
      const all = this.refs(this.starred()).sort((a, b) => {
        const x = a.title.toLowerCase();
        const y = b.title.toLowerCase();
        return x < y ? -1 : x > y ? 1 : a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
      });
      return {
        items: all.slice(0, MAX_LISTED_STARRED),
        truncated: all.length > MAX_LISTED_STARRED,
        applied: {},
      };
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

  listRecent(tenant: string, signal?: AbortSignal, limit?: number): Promise<RefPage> {
    return settle(() => {
      this.checkTenant(tenant);
      const n = limit ?? RECENT_LIMIT;
      const all = this.refs(this.recent().map((e) => e.uid));
      return { items: all.slice(0, n), truncated: all.length > n, applied: {} };
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

  /** Plans as the server does (plan #112 §3.9), then serves the synthetic series on the grid. */
  async queryRange(tenant: string, req: RangeRequest, signal?: AbortSignal): Promise<RangeResult> {
    if (anyStructured(req.vars)) await loadMirror();
    await queryHooks('range', req.query, signal);
    const g = await settle(() => {
      this.checkTenant(tenant);
      // A ladder step from the range store is taken as the server takes it (#304 §A.1).
      const grid =
        req.stepMs === undefined
          ? promGrid(req.fromMs, req.toMs, req.widthPx)
          : promGridAt(req.fromMs, req.toMs, req.stepMs);
      if (grid === null) throw new ApiError('queryInvalid', 'the range is too long for the width');
      return grid;
    }, signal);
    const { planned, warn } = await this.plan(
      tenant,
      {
        query: req.query,
        vars: req.vars ?? {},
        kind: 'range',
        stepMs: g.stepMs,
        rate: req.rate ?? true,
        rangeMs: req.rangeMs ?? req.toMs - req.fromMs,
      },
      signal,
    );
    return settle(() => {
      const n = (g.endMs - g.startMs) / g.stepMs + 1;
      const timestamps = Float64Array.from({ length: n }, (_, i) => g.startMs + i * g.stepMs);
      const series = /_bucket\b/.test(planned.query)
        ? stubBuckets(timestamps)
        : stubSeries(timestamps);
      const c = completeness(warn);
      return {
        planned,
        ...g,
        series,
        completeness: req.query.includes('topk(1000')
          ? { ...c, truncated: true, warnings: [...c.warnings, TRUNCATED_WARNING] }
          : c,
        scope: STUB_SCOPE,
      };
    }, signal);
  }

  async queryInstant(
    tenant: string,
    req: InstantRequest,
    signal?: AbortSignal,
  ): Promise<InstantResult> {
    if (anyStructured(req.vars)) await loadMirror();
    await queryHooks('instant', req.query, signal);
    await settle(() => {
      this.checkTenant(tenant);
    }, signal);
    const { planned, warn } = await this.plan(
      tenant,
      {
        query: req.query,
        vars: req.vars ?? {},
        kind: 'instant',
        stepMs: req.stepMs ?? 0,
        rate: true,
      },
      signal,
    );
    return settle((): InstantResult => {
      if (planned.valueType === 'scalar') {
        const value = synthLineValue(62, 0, req.atMs, 100, 40);
        return {
          planned,
          kind: 'scalar',
          scalar: { value, timestampMs: req.atMs },
          atMs: req.atMs,
          completeness: completeness(warn),
        };
      }
      return {
        planned,
        kind: 'series',
        resultType: 'vector',
        series: stubSeries(Float64Array.of(req.atMs)),
        atMs: req.atMs,
        completeness: completeness(warn),
      };
    }, signal);
  }

  /**
   * The server's route order (plan #112 §4.4, A.11), step for step: Prepare; Classify and the byte
   * guard on the substituted text (before any metadata read); the step; the metric types only when
   * the plan needs them (`promMetadata` stands in for the server's own read: 2 s, then degraded);
   * Plan; the guard on the planned text. Every refusal is the `ApiError` HttpApi maps from the
   * gateway's body.
   */
  private async plan(
    tenant: string,
    inputs: PlanInputs,
    signal?: AbortSignal,
  ): Promise<{ planned: PlannedQuery; warn: boolean }> {
    const { floorStep, isPlanError, prepare, reservedIn, typesFromMetadata } =
      planners ?? (await loadPlanners());
    const p = prepare(inputs);
    if (isPlanError(p)) throw toApiError(p);
    const { stubShape } = await import('./stub/promShape');
    const c = p.classify(stubShape(p.substituted));
    const first = c.reserved[0];
    if (c.source !== 'pulsus_db' && first !== undefined) throw reservedRefusal(first);
    const guarded = reservedIn(p.substituted);
    if (guarded !== null) throw reservedRefusal(guarded);
    const step = floorStep(inputs.stepMs, c.floorMs);
    const e = p.expandedAt(step);
    if (isPlanError(e)) throw toApiError(e);
    const shape = stubShape(e);
    let types: MetricTypes = {};
    let warn = false;
    if (p.needsTypes(shape)) {
      try {
        types = typesFromMetadata(
          (
            await within(
              this.promMetadata(tenant, { limit: METADATA_LIMIT }, signal),
              TYPES_WAIT_MS,
            )
          ).metrics,
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err;
        warn = true;
      }
    }
    const r = p.plan(step, shape, types);
    if (isPlanError(r)) throw toApiError(r);
    const sent = reservedIn(r.planned.query);
    if (sent !== null) throw reservedRefusal(sent, r.planned);
    return { planned: r.planned, warn };
  }

  /**
   * The server's LogQL route order (plan #116 §4.4, steps 3–6), step for step and synchronous:
   * Prepare; the Classify refusal and the byte guard on the substituted text; the processing cap
   * at the step (Resolve is the identity); Plan; and the authoritative Classify and byte guard on
   * the planned text. Every refusal is the `ApiError` HttpApi maps from the gateway's body.
   */
  private planLogs(inputs: LogsPlanInputs): LogqlPlannedQuery {
    const { isLogsPlanError, prepareLogs, RESERVED_MATCHER, reservedIn } = loadedPlanners();
    const p = prepareLogs(inputs);
    if (isLogsPlanError(p)) throw toApiError(p);
    if (p.class.source !== 'pulsus_db') throw reservedRefusal(RESERVED_MATCHER);
    const guarded = reservedIn(p.substituted);
    if (guarded !== null) throw reservedRefusal(guarded);
    const cap = p.checkCap(inputs.stepMs);
    if (cap !== null) throw toApiError(cap);
    const r = p.plan(inputs.stepMs);
    if (isLogsPlanError(r)) throw toApiError(r);
    if (r.class.source !== 'pulsus_db') throw reservedRefusal(RESERVED_MATCHER, r.planned);
    const sent = reservedIn(r.planned.query);
    if (sent !== null) throw reservedRefusal(sent, r.planned);
    return r.planned;
  }

  /** Deterministic: always `ok`, checked at 0. */
  checkDataSource(tenant: string, signal?: AbortSignal): Promise<DataSourceStatus> {
    return settle(() => {
      this.checkTenant(tenant);
      return { state: 'ok' as const, checkedAtMs: 0 };
    }, signal);
  }

  promLabels(tenant: string, _req: PromMatchRequest, signal?: AbortSignal): Promise<PromValues> {
    return settle(() => {
      this.checkTenant(tenant);
      return { values: [...STUB_PROM_LABELS], completeness: EMPTY_COMPLETENESS };
    }, signal);
  }

  promLabelValues(
    tenant: string,
    name: string,
    _req: PromMatchRequest,
    signal?: AbortSignal,
  ): Promise<PromValues> {
    return settle(() => {
      this.checkTenant(tenant);
      const values = name === '__name__' ? STUB_PROM_METRIC_NAMES : STUB_PROM_LABEL_VALUES;
      return { values: [...values], completeness: EMPTY_COMPLETENESS };
    }, signal);
  }

  promSeries(tenant: string, _req: PromMatchRequest, signal?: AbortSignal): Promise<PromSeriesSet> {
    return settle(() => {
      this.checkTenant(tenant);
      return { series: [], completeness: EMPTY_COMPLETENESS };
    }, signal);
  }

  /** The labels of `queryLogs`' stub streams (plan #66 Part A §3.2); no scope is planned. */
  logLabels(tenant: string, _req: LogMatchRequest, signal?: AbortSignal): Promise<PromValues> {
    return settle(() => {
      this.checkTenant(tenant);
      return { values: [...STUB_LOG_LABELS], completeness: EMPTY_COMPLETENESS };
    }, signal);
  }

  logLabelValues(
    tenant: string,
    name: string,
    _req: LogMatchRequest,
    signal?: AbortSignal,
  ): Promise<PromValues> {
    return settle(() => {
      this.checkTenant(tenant);
      return { values: [...(STUB_LOG_LABEL_VALUES[name] ?? [])], completeness: EMPTY_COMPLETENESS };
    }, signal);
  }

  /** The stub's label values for a variable query planned by the mirror (plan #289 §3.5). */
  variableValues(
    tenant: string,
    req: VariableValuesRequest,
    signal?: AbortSignal,
  ): Promise<VariableValues> {
    return Promise.all([loadPlanners(), loadMirror()]).then(
      ([{ isLogsPlanError, isPlanError, planVariableQuery, reservedIn }]) =>
        settle(() => {
          const plan = planVariableQuery(req.lang, req.query, req.vars ?? {});
          if (isPlanError(plan) || isLogsPlanError(plan)) throw toApiError(plan);
          if (plan.match !== null) {
            const reserved = reservedIn(plan.match);
            if (reserved !== null) throw reservedRefusal(reserved);
          }
          this.checkTenant(tenant);
          const all =
            req.lang === 'logql'
              ? (STUB_LOG_LABEL_VALUES[plan.label] ?? [])
              : plan.label === '__name__'
                ? STUB_PROM_METRIC_NAMES
                : STUB_PROM_LABEL_VALUES;
          const limit = req.limit ?? 1000;
          return { planned: plan, values: all.slice(0, limit), truncated: all.length > limit };
        }, signal),
    );
  }

  promMetadata(
    tenant: string,
    _req: { readonly metric?: string; readonly limit?: number },
    signal?: AbortSignal,
  ): Promise<PromMetadata> {
    return settle(() => {
      this.checkTenant(tenant);
      return { metrics: structuredClone(STUB_PROM_METADATA), completeness: EMPTY_COMPLETENESS };
    }, signal);
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
    if (fields.length > 0) throw new ApiError('invalid', 'invalid board', { fields });
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

  /**
   * A synthetic page of at most 30 entries, every one within `(fromMs, toMs]` (plan #65 Part B
   * §4.4): 1 s apart from `toMs` down (backward) or from `fromMs` up (forward), over three streams.
   */
  queryLogs(tenant: string, req: LogsRequest, signal?: AbortSignal): Promise<LogsResult> {
    // A structured value needs the rest of the planner mirror (plan #289).
    // The planner mirror, and for a structured value the rest of the variables mirror (#289).
    if (planners === null || (anyStructured(req.vars) && !mirrorLoaded())) {
      return Promise.all([loadPlanners(), anyStructured(req.vars) ? loadMirror() : null]).then(() =>
        this.queryLogs(tenant, req, signal),
      );
    }
    return settle(() => {
      this.checkTenant(tenant);
      const g = logGrid(req.fromMs, req.toMs, req.widthPx);
      if (g === null) throw new ApiError('queryInvalid', 'the range is too long for the width');
      const planned = this.planLogs({
        query: req.query,
        vars: req.vars ?? {},
        kind: 'range',
        stepMs: g.stepMs,
        rangeMs: req.toMs - req.fromMs,
      });
      const direction = req.direction ?? 'backward';
      const fromNs = BigInt(req.fromMs) * 1000000n;
      const toNs = BigInt(req.toMs) * 1000000n;
      const n = Math.min(req.limit ?? 1000, 30);
      const ts: bigint[] = [];
      for (let i = 0; ts.length < n; i++) {
        const t =
          direction === 'backward'
            ? toNs - BigInt(i) * 1000000000n
            : fromNs + BigInt(i + 1) * 1000000000n;
        if (t <= fromNs || t > toNs) break;
        ts.push(t);
      }
      const used = [0, 1, 2].filter((j) => ts.some((_, i) => i % 3 === j));
      const streams = used.map((j) => {
        const labels = {
          service_name: 'stub',
          pod: `stub-${String(j)}`,
          level: STUB_LEVELS[j] ?? 'info',
        };
        return { key: keyHash(labels), labels };
      });
      const frame: LogFrame = {
        direction,
        streams,
        tsNs: BigInt64Array.from(ts),
        streamIndex: Uint32Array.from(ts, (_, i) => used.indexOf(i % 3)),
        lines: ts.map((_, i) => `stub line ${String(i)}`),
        levels: Uint8Array.from(ts, (_, i) => LOG_LEVELS.indexOf(STUB_LEVELS[i % 3] ?? 'info')),
        metadata: ts.map(() => null),
        parsed: ts.map(() => null),
      };
      return {
        kind: 'streams' as const,
        fromMs: req.fromMs,
        toMs: req.toMs,
        stepMs: g.stepMs,
        frame,
        cursor: null,
        completeness: EMPTY_COMPLETENESS,
        planned,
      };
    }, signal);
  }

  /** Three level frames (`error`, `warn`, `info`) of synthetic counts on the grid. */
  queryVolume(tenant: string, req: VolumeRequest, signal?: AbortSignal): Promise<VolumeResult> {
    // A structured value needs the rest of the planner mirror (plan #289).
    // The planner mirror, and for a structured value the rest of the variables mirror (#289).
    if (planners === null || (anyStructured(req.vars) && !mirrorLoaded())) {
      return Promise.all([loadPlanners(), anyStructured(req.vars) ? loadMirror() : null]).then(() =>
        this.queryVolume(tenant, req, signal),
      );
    }
    return settle(() => {
      this.checkTenant(tenant);
      const g = logGrid(req.fromMs, req.toMs, req.widthPx);
      if (g === null) throw new ApiError('queryInvalid', 'the range is too long for the width');
      const planned = this.planLogs({
        query: req.query,
        vars: req.vars ?? {},
        kind: 'volume',
        stepMs: g.stepMs,
        rangeMs: req.toMs - req.fromMs,
      });
      const n = (g.endMs - g.startMs) / g.stepMs + 1;
      const timestamps = Float64Array.from({ length: n }, (_, i) => g.startMs + i * g.stepMs);
      const series = ['error', 'warn', 'info'].map((level, j) => {
        const labels = { level };
        return {
          key: keyHash(labels),
          labels,
          timestamps,
          values: timestamps.map((t) => Math.round(Math.abs(synthLineValue(65, j, t, 20, 10)))),
        };
      });
      return { ...g, series, completeness: EMPTY_COMPLETENESS, planned };
    }, signal);
  }
}
