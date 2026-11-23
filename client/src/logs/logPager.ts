/**
 * The client pager over `Api.queryLogs` (plan #66 Part B §3.3, §4.2, §4.4, §4.6, §4.7): every page
 * of a run sends the same raw text, `vars`, window, width, direction and `limit` (ADR-0021 §2:
 * nothing is planned in the browser), and the cursor of the buffer's chain. At most one request
 * is in flight per end (tail: the next page; head: an evicted page); `dispose()` aborts both and
 * later answers change nothing. The buffer is mutated only in the answer handler, then `version`
 * is bumped and the listeners are called.
 */
import type { Api } from '../api/Api';
import { ApiError, type LogsRequest } from '../api/types';
import type { Completeness, LogqlPlannedQuery, LogsResult } from '../data/decode';
import { LogBuffer, type AcceptOutcome, type BufferCaps, type OrdRange } from './logBuffer';

export const PAGE_LIMIT = 1000;

/** Fixed for the life of a pager; another value is another run (another pager). */
export interface LogPagerInput {
  readonly tenant: string;
  /** The raw text (ADR-0021 §2): never substituted or planned here. */
  readonly query: string;
  readonly vars?: Readonly<Record<string, string>>;
  readonly fromMs: number;
  readonly toMs: number;
  readonly widthPx: number;
  readonly direction: 'backward' | 'forward';
  /** 1..5 000; default PAGE_LIMIT. */
  readonly limit?: number;
  readonly timeoutMs?: number;
}

export type EndStatus = 'idle' | 'loading' | 'error' | 'drift';
/** `error` is the rejection while status is 'error', else null. */
export interface EndState {
  readonly status: EndStatus;
  readonly error: unknown;
}

export interface LogPagerState {
  /** +1 on every change; the `useSyncExternalStore` snapshot is replaced with it. */
  readonly version: number;
  readonly phase: 'pending' | 'streams' | 'series' | 'failed';
  readonly series: Extract<LogsResult, { kind: 'series' }> | null;
  /** From page 0. */
  readonly planned: LogqlPlannedQuery | null;
  /** §4.6. */
  readonly completeness: Completeness | null;
  readonly head: EndState;
  readonly tail: EndState;
  readonly firstOrd: number;
  readonly endOrd: number;
  /** headPage === 0. */
  readonly atStart: boolean;
  /** tailPage === knownPages && exhausted. */
  readonly atEnd: boolean;
  readonly total: number | null;
}

type End = 'head' | 'tail';

const IDLE: EndState = { status: 'idle', error: null };
const LOADING: EndState = { status: 'loading', error: null };
const DRIFT: EndState = { status: 'drift', error: null };

const isAbort = (e: unknown): boolean =>
  (e instanceof DOMException || e instanceof Error) && e.name === 'AbortError';

/** A stable string of every input member (vars sorted by name). */
export function logPagerKey(input: LogPagerInput): string {
  const vars = Object.entries(input.vars ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([
    input.tenant,
    input.query,
    vars,
    input.fromMs,
    input.toMs,
    input.widthPx,
    input.direction,
    input.limit ?? PAGE_LIMIT,
    input.timeoutMs ?? null,
  ]);
}

function merge(into: Completeness, page: Completeness): Completeness {
  const union = (a: readonly string[], b: readonly string[]) => [
    ...a,
    ...b.filter((x) => !a.includes(x)),
  ];
  return {
    ...into,
    truncated: into.truncated || page.truncated,
    warnings: union(into.warnings, page.warnings),
    infos: union(into.infos, page.infos),
  };
}

interface Flight {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

export class LogPager {
  readonly input: LogPagerInput;
  /** Read only outside the pager: `rowAt` while rendering. */
  readonly buffer: LogBuffer;
  private readonly api: Pick<Api, 'queryLogs'>;
  private readonly limit: number;
  private readonly listeners = new Set<() => void>();
  private readonly flights: Record<End, Flight | null> = { head: null, tail: null };
  private ends: Record<End, EndState> = { head: IDLE, tail: IDLE };
  private phase: LogPagerState['phase'] = 'pending';
  private series: LogPagerState['series'] = null;
  private planned: LogqlPlannedQuery | null = null;
  private completeness: Completeness | null = null;
  private protected: OrdRange | null = null;
  private started = false;
  private disposed = false;
  private version = 0;
  private snapshot: LogPagerState;

  constructor(api: Pick<Api, 'queryLogs'>, input: LogPagerInput, caps?: BufferCaps) {
    const limit = input.limit ?? PAGE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
      throw new RangeError(`log page limit ${String(limit)} is not in 1..5000`);
    }
    this.api = api;
    this.input = input;
    this.limit = limit;
    this.buffer = new LogBuffer(caps);
    this.snapshot = this.build();
  }

  getState = (): LogPagerState => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Page 0. A no-op unless phase is 'pending' and no request was made. */
  start(): Promise<void> {
    if (this.started || this.phase !== 'pending' || this.disposed) return Promise.resolve();
    this.started = true;
    return this.request('tail', 0, null);
  }

  /** The next page (§4.2). Resolves when its request settles, or at once when it is a no-op. */
  loadTail(): Promise<void> {
    const flight = this.flights.tail;
    if (flight !== null) return flight.promise;
    if (this.disposed || this.phase !== 'streams' || this.ends.tail.status !== 'idle') {
      return Promise.resolve();
    }
    const k = this.buffer.tailPage;
    const cursor = this.buffer.cursorOf(k);
    if (cursor === undefined) return Promise.resolve();
    return this.request('tail', k, cursor);
  }

  /** The page before headPage (§4.2). */
  loadHead(): Promise<void> {
    const flight = this.flights.head;
    if (flight !== null) return flight.promise;
    if (this.disposed || this.phase !== 'streams' || this.ends.head.status !== 'idle') {
      return Promise.resolve();
    }
    const k = this.buffer.headPage - 1;
    if (k < 0) return Promise.resolve();
    const cursor = this.buffer.cursorOf(k);
    if (cursor === undefined) return Promise.resolve();
    return this.request('head', k, cursor);
  }

  /** 'error' → 'idle', then load that end; in phase 'failed', requests page 0 again. */
  retry(end: End): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.phase === 'failed') {
      if (end !== 'tail' || this.flights.tail !== null) return Promise.resolve();
      this.phase = 'pending';
      this.ends = { ...this.ends, tail: IDLE };
      return this.request('tail', 0, null);
    }
    if (this.ends[end].status !== 'error') return Promise.resolve();
    this.ends = { ...this.ends, [end]: IDLE };
    return end === 'tail' ? this.loadTail() : this.loadHead();
  }

  /** What the view shows; used by every later accept. */
  protect(range: OrdRange | null): void {
    this.protected = range;
  }

  /** Aborts both ends; later answers are ignored; listeners are dropped. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    for (const end of ['head', 'tail'] as const) {
      this.flights[end]?.controller.abort();
      this.flights[end] = null;
    }
  }

  private request(end: End, k: number, cursor: string | null): Promise<void> {
    const controller = new AbortController();
    const req = this.requestOf(cursor);
    this.ends = { ...this.ends, [end]: LOADING };
    this.changed();
    const promise = this.api.queryLogs(this.input.tenant, req, controller.signal).then(
      (r) => {
        this.settled(end, controller, () => {
          this.answered(end, k, r);
        });
      },
      (e: unknown) => {
        this.settled(end, controller, () => {
          this.failed(end, k, e);
        });
      },
    );
    this.flights[end] = { controller, promise };
    return promise;
  }

  private requestOf(cursor: string | null): LogsRequest {
    const i = this.input;
    return {
      query: i.query,
      fromMs: i.fromMs,
      toMs: i.toMs,
      widthPx: i.widthPx,
      limit: this.limit,
      direction: i.direction,
      ...(cursor === null ? {} : { cursor }),
      ...(i.timeoutMs === undefined ? {} : { timeoutMs: i.timeoutMs }),
      ...(i.vars === undefined ? {} : { vars: i.vars }),
    };
  }

  private settled(end: End, controller: AbortController, handle: () => void): void {
    if (this.disposed || this.flights[end]?.controller !== controller) return;
    this.flights[end] = null;
    handle();
    this.changed();
  }

  private answered(end: End, k: number, r: LogsResult): void {
    if (k === 0 && this.phase === 'pending') {
      this.ends = { ...this.ends, [end]: IDLE };
      if (r.kind === 'series') {
        this.phase = 'series';
        this.series = r;
        return;
      }
      this.phase = 'streams';
      this.planned = r.planned;
      this.completeness = r.completeness;
      this.buffer.accept(0, { frame: r.frame, cursor: r.cursor }, this.protected);
      return;
    }
    if (r.kind === 'series') {
      const error = new ApiError('badResponse', 'a log page answered a metric result');
      this.ends = { ...this.ends, [end]: { status: 'error', error } };
      return;
    }
    const fresh = k === this.buffer.knownPages;
    const outcome: AcceptOutcome = this.buffer.accept(
      k,
      { frame: r.frame, cursor: r.cursor },
      this.protected,
    );
    if (outcome === 'drift') {
      this.ends = { ...this.ends, [end]: DRIFT };
      return;
    }
    if (fresh && outcome === 'appended' && this.completeness !== null) {
      this.completeness = merge(this.completeness, r.completeness);
    }
    this.ends = { ...this.ends, [end]: IDLE };
  }

  private failed(end: End, k: number, e: unknown): void {
    if (isAbort(e)) {
      this.ends = { ...this.ends, [end]: IDLE };
      if (k === 0 && this.phase === 'pending') this.started = false;
      return;
    }
    this.ends = { ...this.ends, [end]: { status: 'error', error: e } };
    if (k === 0 && this.phase === 'pending') this.phase = 'failed';
  }

  private changed(): void {
    if (this.disposed) return;
    this.version += 1;
    this.snapshot = this.build();
    for (const l of [...this.listeners]) l();
  }

  private build(): LogPagerState {
    const b = this.buffer;
    return {
      version: this.version,
      phase: this.phase,
      series: this.series,
      planned: this.planned,
      completeness: this.completeness,
      head: this.ends.head,
      tail: this.ends.tail,
      firstOrd: b.firstOrd,
      endOrd: b.endOrd,
      atStart: b.headPage === 0,
      atEnd: b.tailPage === b.knownPages && b.exhausted,
      total: b.total,
    };
  }
}
