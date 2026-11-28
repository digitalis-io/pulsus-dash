/**
 * Range view planning (#304 §4.1, §A.7; Part B §3.2): a panel's PromQL range run as the range
 * store sees it. The grid is today's `promGrid` of the window at the panel's width, sent as
 * `step_ms`; its visible buckets, and for a line one window either side (PRF-028), are what the
 * store holds. Part B adds the zoom-out ladder (3× and 9× the window about its centre, each at its
 * own `promGrid` step) and the coarse first pass at a quarter of the width (PRF-027).
 */
import { bucketOf, type Run } from '../data/buckets';
import { identityKey, type RangeIdentity, type RangeView } from '../data/rangeStore';
import { promGrid } from '../data/step';
import type { TimeWindow } from '../engine/api';

/** `@ start()` / `@ end()` make a value depend on the request window: not stitchable. */
export const chunkable = (text: string): boolean => !/@\s*(start|end)\s*\(\s*\)/.test(text);
/** `$__range`, `$__range_s`, `$__range_ms` (and `${…}`): the window enters the identity. */
export const usesRangeMacro = (text: string): boolean => /\$\{?__range(_s|_ms)?\b/.test(text);

export interface ViewInput {
  readonly tenant: string;
  /** `store.scopeOf(tenant)`: the tenant's scope epoch (§4.5). */
  readonly scope: string;
  readonly text: string;
  /** JSON of the panel's `[name, value]` pairs. */
  readonly vars: string;
  readonly rate: boolean;
  /** A line panel: flanks (§4.1) and, Part B, the ladder. */
  readonly line: boolean;
  readonly window: TimeWindow;
  readonly widthPx: number;
  /** The refresh epoch (Refresh now). */
  readonly epoch: number;
  /** The clock anchor the window was resolved at. */
  readonly anchorMs: number;
}

const runOf = (startMs: number, endMs: number, stepMs: number): Run => ({
  k0: bucketOf(startMs, stepMs),
  k1: bucketOf(endMs, stepMs) + 1,
});

/** The view, or null when the window has no grid at this width (more than 11 000 steps of 1 d). */
export function planRangeView(a: ViewInput): RangeView | null {
  const grid = promGrid(a.window.fromMs, a.window.toMs, a.widthPx);
  if (grid === null) return null;
  const windowMs = a.window.toMs - a.window.fromMs;
  const id: RangeIdentity = {
    tenant: a.tenant,
    scope: a.scope,
    text: a.text,
    vars: a.vars,
    rate: a.rate,
    rangeMs: usesRangeMacro(a.text) ? windowMs : null,
    stepMs: grid.stepMs,
  };
  const visible = runOf(grid.startMs, grid.endMs, grid.stepMs);
  const flanks: Run[] = [];
  if (a.line) {
    const step = grid.stepMs;
    const n = (grid.endMs - grid.startMs) / step;
    const left = { k0: Math.max(0, bucketOf(grid.startMs - n * step, step)), k1: visible.k0 };
    const lastAllowed = bucketOf(a.anchorMs, step);
    const right = {
      k0: visible.k1,
      k1: Math.min(bucketOf(grid.endMs + n * step, step) + 1, lastAllowed + 1),
    };
    if (left.k1 > left.k0) flanks.push(left);
    if (right.k1 > right.k0) flanks.push(right);
  }
  return {
    id,
    idKey: identityKey(id),
    grid,
    visible,
    flanks,
    windowMs,
    epoch: a.epoch,
    anchorMs: a.anchorMs,
    widthPx: a.widthPx,
    line: a.line,
  };
}

/** A zoom-out ladder level (Part B §3.2). */
export interface LadderLevel {
  readonly factor: 3 | 9;
  readonly stepMs: number;
  readonly run: Run;
}

/**
 * The 3× and 9× levels: spans of k·W centred on the window's centre at `promGrid(span, widthPx)`'s
 * step; a level whose step is the view's or the previous level's is skipped.
 */
export function ladderOf(v: RangeView, widthPx: number): readonly LadderLevel[] {
  const c = (v.grid.startMs + v.grid.endMs) / 2;
  const out: LadderLevel[] = [];
  let prev = v.id.stepMs;
  for (const factor of [3, 9] as const) {
    const half = (factor * v.windowMs) / 2;
    const g = promGrid(c - half, c + half, widthPx);
    if (g === null || g.stepMs === v.id.stepMs || g.stepMs === prev) continue;
    prev = g.stepMs;
    out.push({ factor, stepMs: g.stepMs, run: runOf(g.startMs, g.endMs, g.stepMs) });
  }
  return out;
}

/** `promGrid(window, max(1, ⌊widthPx / 4⌋))`'s step, or null when it is the view's (PRF-027). */
export function coarseStep(v: RangeView, widthPx: number): number | null {
  const g = promGrid(v.grid.startMs, v.grid.endMs, Math.max(1, Math.floor(widthPx / 4)));
  return g === null || g.stepMs === v.id.stepMs ? null : g.stepMs;
}

/** The identity of `v` at another step (a ladder level or the coarse pass). */
export function atStep(v: RangeView, stepMs: number, rangeMs: number | null): RangeIdentity {
  return { ...v.id, stepMs, rangeMs: v.id.rangeMs === null ? null : rangeMs };
}
