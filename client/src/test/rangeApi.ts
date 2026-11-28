/**
 * A scripted `queryRange` for the range store and panel run tests (#304): every call is recorded
 * and answered on the request's grid by the test, from series that are functions of time only.
 */
import type { RangeRequest } from '../api/types';
import type { Completeness, PlannedQuery, RangeResult, ScopeStamp } from '../data/decode';
import type { SeriesFrame } from '../data/frames';
import { promGrid, promGridAt, type Grid } from '../data/step';
import { keyHash } from '../dev/keyHash';

export const C0: Completeness = {
  truncated: false,
  warnings: [],
  infos: [],
  queryId: null,
  dataAgeMs: null,
  readCache: null,
  readCacheThroughMs: null,
};

export const planned = (query: string, stepMs: number): PlannedQuery => ({
  query,
  expanded: query,
  bytes: query.length,
  valueType: 'matrix',
  rateCandidate: false,
  rateApplied: false,
  histogram: false,
  stepMs,
});

/** A series as a function of time: a number, NaN (present), or null (absent). */
export interface FnSeries {
  readonly labels: Readonly<Record<string, string>>;
  readonly at: (tMs: number) => number | null;
}

export const fn = (
  labels: Record<string, string>,
  at: (tMs: number) => number | null,
): FnSeries => ({
  labels,
  at,
});

export interface Answer {
  readonly series?: readonly FnSeries[];
  readonly scope?: ScopeStamp | null;
  readonly completeness?: Partial<Completeness>;
  /** Answer on this step instead of the request's. */
  readonly stepMs?: number;
}

/** The result of `series` on `g`: one shared `timestamps`; `absent` from the nulls. */
export function gridResult(g: Grid, query: string, a: Answer = {}): RangeResult {
  const n = Math.round((g.endMs - g.startMs) / g.stepMs) + 1;
  const ts = Float64Array.from({ length: n }, (_, i) => g.startMs + i * g.stepMs);
  const absent: (Uint8Array | null)[] = [];
  const series: SeriesFrame[] = (a.series ?? []).map((s) => {
    const values = new Float64Array(n);
    let mask: Uint8Array | null = null;
    for (let i = 0; i < n; i++) {
      const v = s.at(ts[i] ?? 0);
      if (v === null) {
        mask ??= new Uint8Array(n);
        mask[i] = 1;
        values[i] = NaN;
      } else values[i] = v;
    }
    absent.push(mask);
    return { key: keyHash(s.labels), labels: s.labels, timestamps: ts, values };
  });
  return {
    planned: planned(query, g.stepMs),
    startMs: g.startMs,
    endMs: g.endMs,
    stepMs: g.stepMs,
    series,
    completeness: { ...C0, ...a.completeness },
    ...(absent.some((m) => m !== null) ? { absent } : {}),
    scope: a.scope === undefined ? null : a.scope,
  };
}

export interface RangeCall {
  readonly tenant: string;
  readonly req: RangeRequest;
  readonly signal: AbortSignal | undefined;
  settled: boolean;
  /** Answers on the request's grid; returns the result it resolved with. */
  respond(a?: Answer): RangeResult;
  reject(e: Error): void;
}

export interface ScriptedRange {
  readonly calls: RangeCall[];
  /** The calls not settled and not aborted. */
  open(): RangeCall[];
  queryRange(tenant: string, req: RangeRequest, signal?: AbortSignal): Promise<RangeResult>;
  /** Answer every call at once with this (null: leave them open; a null answer leaves that one open). */
  auto: ((c: RangeCall) => Answer | null) | null;
  /** Resolve even after an abort (a late response). */
  ignoreAbort: boolean;
}

export function scriptedRange(): ScriptedRange {
  let autoFn: ((c: RangeCall) => Answer | null) | null = null;
  const answerLater = (call: RangeCall): void => {
    const f = autoFn;
    if (f === null) return;
    queueMicrotask(() => {
      if (call.settled || call.signal?.aborted === true) return;
      const ans = f(call);
      if (ans !== null) call.respond(ans);
    });
  };
  const s: ScriptedRange = {
    calls: [],
    get auto() {
      return autoFn;
    },
    /** Setting it answers the calls already open too. */
    set auto(f) {
      autoFn = f;
      for (const c of s.open()) answerLater(c);
    },
    ignoreAbort: false,
    open: () => s.calls.filter((c) => !c.settled && c.signal?.aborted !== true),
    queryRange(tenant, req, signal) {
      return new Promise<RangeResult>((resolve, reject) => {
        const g =
          req.stepMs === undefined
            ? promGrid(req.fromMs, req.toMs, req.widthPx)
            : promGridAt(req.fromMs, req.toMs, req.stepMs);
        const call: RangeCall = {
          tenant,
          req,
          signal,
          settled: false,
          respond(a = {}) {
            const grid =
              a.stepMs === undefined || g === null ? g : promGridAt(g.startMs, g.endMs, a.stepMs);
            if (grid === null) throw new Error('scriptedRange: no grid');
            const r = gridResult(grid, req.query, a);
            call.settled = true;
            resolve(r);
            return r;
          },
          reject(e) {
            call.settled = true;
            reject(e);
          },
        };
        signal?.addEventListener('abort', () => {
          if (s.ignoreAbort || call.settled) return;
          call.settled = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
        s.calls.push(call);
        answerLater(call);
      });
    },
  };
  return s;
}

/** Microtasks and a macrotask: enough for a store job to start, settle and store. */
export async function drain(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });
  }
}
