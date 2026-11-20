/**
 * Pure transitions of the time Context (INT-032, T08-008). Window actions output absolute
 * expressions. A no-op or invalid action returns the same object (`===`), so callers can skip the
 * navigation.
 */
import type { ContextSearch, RefreshInterval } from './contextSearch';
import { parseTimeExpr, printTimeExpr, resolveTimeExpr } from './timeExpr';

export type ContextAction =
  | { type: 'step'; dir: -1 | 1 }
  | { type: 'zoom'; dir: 'out' | 'in' }
  | { type: 'setRange'; from: string; to: string }
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

function withWindow(s: ContextSearch, fromMs: number, toMs: number): ContextSearch {
  const width = toMs - fromMs;
  if (width < MIN_WINDOW_MS || width > MAX_WINDOW_MS) return s;
  const from = absolute(fromMs);
  const to = absolute(toMs);
  if (from === null || to === null) return s;
  if (from === s.from && to === s.to) return s;
  return { ...s, from, to };
}

export function contextReducer(s: ContextSearch, a: ContextAction, env: Env): ContextSearch {
  switch (a.type) {
    case 'step':
    case 'zoom': {
      const fromMs = resolve(s.from, env);
      const toMs = resolve(s.to, env);
      if (fromMs === null || toMs === null || fromMs >= toMs) return s;
      const w = toMs - fromMs;
      if (a.type === 'step') return withWindow(s, fromMs + a.dir * w, toMs + a.dir * w);
      if (a.dir === 'out') {
        const from = fromMs - Math.floor(w / 2);
        return withWindow(s, from, from + 2 * w);
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
    case 'setRefresh':
      return a.refresh === s.refresh ? s : { ...s, refresh: a.refresh };
  }
}
