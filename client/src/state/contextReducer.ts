/**
 * Pure transitions of the time Context (INT-032, T08-008). Window actions output absolute
 * expressions. A no-op or invalid action returns the same object (`===`), so callers can skip the
 * navigation.
 */
import type { ContextSearch, RefreshInterval } from './contextSearch';
import { agoExpr, clampToNow } from './clampToNow';
import { parseTimeExpr, printTimeExpr, resolveTimeExpr } from './timeExpr';

export type ContextAction =
  | { type: 'step'; dir: -1 | 1 }
  | { type: 'zoom'; dir: 'out' | 'in' }
  | { type: 'setRange'; from: string; to: string }
  /** A window a chart committed (brush, wheel, drag): held to the live edge as the keys are. */
  | { type: 'chartWindow'; fromMs: number; toMs: number }
  | { type: 'setRefresh'; refresh: RefreshInterval };

export const MIN_WINDOW_MS = 1_000;
export const MAX_WINDOW_MS = 3_650 * 86_400_000;

interface Env {
  nowMs: number;
  timeZone: string;
}

function resolve(s: string, env: Env): number | null {
  const r = parseTimeExpr(s);
  return r.ok ? resolveTimeExpr(r.expr, env.nowMs, env.timeZone) : null;
}

/** An absolute expression for `ms`, or `null` if it would not parse back (out of range). */
function absolute(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  const text = printTimeExpr({ kind: 'absolute', ms });
  const r = parseTimeExpr(text);
  return r.ok ? text : null;
}

function withWindow(
  s: ContextSearch,
  fromMs: number,
  toMs: number,
  relative = false,
): ContextSearch {
  const width = toMs - fromMs;
  if (width < MIN_WINDOW_MS || width > MAX_WINDOW_MS) return s;
  const ago = relative ? agoExpr(width) : null;
  const from = ago ?? absolute(fromMs);
  const to = ago !== null ? 'now' : absolute(toMs);
  if (from === null || to === null) return s;
  if (from === s.from && to === s.to) return s;
  return { ...s, from, to };
}

/**
 * A move that may push the end past now: clamped to the live edge (`clampToNow`). A range that
 * ended at `now` and is clamped stays relative (`now-<width>` to `now`) when a whole unit expresses
 * its width.
 */
function moveWindow(
  s: ContextSearch,
  prevToMs: number,
  fromMs: number,
  toMs: number,
  env: Env,
): ContextSearch {
  const next = { fromMs, toMs };
  const c = clampToNow(next, prevToMs, env.nowMs);
  return withWindow(s, c.fromMs, c.toMs, c !== next && s.to === 'now');
}

export function contextReducer(s: ContextSearch, a: ContextAction, env: Env): ContextSearch {
  switch (a.type) {
    case 'step':
    case 'zoom': {
      const fromMs = resolve(s.from, env);
      const toMs = resolve(s.to, env);
      if (fromMs === null || toMs === null || fromMs >= toMs) return s;
      const w = toMs - fromMs;
      if (a.type === 'step') return moveWindow(s, toMs, fromMs + a.dir * w, toMs + a.dir * w, env);
      if (a.dir === 'out') {
        const from = fromMs - Math.floor(w / 2);
        return moveWindow(s, toMs, from, from + 2 * w, env);
      }
      const from = fromMs + Math.floor(w / 4);
      return withWindow(s, from, from + Math.floor(w / 2));
    }
    case 'setRange': {
      const f = parseTimeExpr(a.from);
      const t = parseTimeExpr(a.to);
      if (!f.ok || !t.ok) return s;
      const from = printTimeExpr(f.expr);
      const to = printTimeExpr(t.expr);
      const fromMs = resolveTimeExpr(f.expr, env.nowMs, env.timeZone);
      const toMs = resolveTimeExpr(t.expr, env.nowMs, env.timeZone);
      if (fromMs >= toMs) return s;
      if (from === s.from && to === s.to) return s;
      return { ...s, from, to };
    }
    case 'chartWindow': {
      const toMs = resolve(s.to, env);
      if (toMs === null || !(a.fromMs < a.toMs)) return s;
      return moveWindow(s, toMs, a.fromMs, a.toMs, env);
    }
    case 'setRefresh':
      return a.refresh === s.refresh ? s : { ...s, refresh: a.refresh };
  }
}
