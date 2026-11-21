/**
 * In-repo stub of the BFF API (ADR-0014 §6): seeded data, no network. Starred boards stand in for
 * the per-user preference the BFF stores from #61 and are kept in `localStorage`.
 *
 * Test hook: if `localStorage['pulsus-dash.stub.failSession']` is a positive integer n,
 * `getSession` rejects with `ApiError('network')` and stores n − 1. `pulsus-dash.stub.failSignOut`
 * does the same for `signOut`.
 */
import type { Api } from './Api';
import {
  defaultSeed,
  defaultStarred,
  STUB_PROM_LABEL_VALUES,
  STUB_PROM_LABELS,
  STUB_PROM_METADATA,
  STUB_PROM_METRIC_NAMES,
} from './stubData';
import type {
  Completeness,
  InstantResult,
  PromMetadata,
  PromSeriesSet,
  PromValues,
  RangeResult,
} from '../data/decode';
import type { SeriesFrame } from '../data/frames';
import { promGrid } from '../data/step';
import { keyHash } from '../dev/keyHash';
import { synthLineValue } from '../dev/synth';
import {
  ApiError,
  type BoardSummary,
  type DataSourceStatus,
  type InstantRequest,
  type PromMatchRequest,
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

  queryRange(tenant: string, req: RangeRequest, signal?: AbortSignal): Promise<RangeResult> {
    return settle(() => {
      this.boardsOf(tenant);
      const g = promGrid(req.fromMs, req.toMs, req.widthPx);
      if (g === null) throw new ApiError('queryInvalid', 'the range is too long for the width');
      const n = (g.endMs - g.startMs) / g.stepMs + 1;
      const timestamps = Float64Array.from({ length: n }, (_, i) => g.startMs + i * g.stepMs);
      return { ...g, series: stubSeries(timestamps), completeness: EMPTY_COMPLETENESS };
    }, signal);
  }

  queryInstant(tenant: string, req: InstantRequest, signal?: AbortSignal): Promise<InstantResult> {
    return settle(() => {
      this.boardsOf(tenant);
      return {
        kind: 'series' as const,
        resultType: 'vector' as const,
        series: stubSeries(Float64Array.of(req.atMs)),
        atMs: req.atMs,
        completeness: EMPTY_COMPLETENESS,
      };
    }, signal);
  }

  /** Deterministic: always `ok`, checked at 0. */
  checkDataSource(tenant: string, signal?: AbortSignal): Promise<DataSourceStatus> {
    return settle(() => {
      this.boardsOf(tenant);
      return { state: 'ok' as const, checkedAtMs: 0 };
    }, signal);
  }

  promLabels(tenant: string, _req: PromMatchRequest, signal?: AbortSignal): Promise<PromValues> {
    return settle(() => {
      this.boardsOf(tenant);
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
      this.boardsOf(tenant);
      const values = name === '__name__' ? STUB_PROM_METRIC_NAMES : STUB_PROM_LABEL_VALUES;
      return { values: [...values], completeness: EMPTY_COMPLETENESS };
    }, signal);
  }

  promSeries(tenant: string, _req: PromMatchRequest, signal?: AbortSignal): Promise<PromSeriesSet> {
    return settle(() => {
      this.boardsOf(tenant);
      return { series: [], completeness: EMPTY_COMPLETENESS };
    }, signal);
  }

  promMetadata(
    tenant: string,
    _req: { readonly metric?: string; readonly limit?: number },
    signal?: AbortSignal,
  ): Promise<PromMetadata> {
    return settle(() => {
      this.boardsOf(tenant);
      return { metrics: structuredClone(STUB_PROM_METADATA), completeness: EMPTY_COMPLETENESS };
    }, signal);
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
