/**
 * Pivot Context (T25-010, plan #192 §3): the IA-027 interim translation seed, the logs selector
 * and the pivot window.
 */
import type { TimeWindow } from '../engine/api';
import type { BoardFilter } from '../state/boardParams';
import type { InspectorTarget } from './types';

const MINUTE = 60_000;

/** `job` → `service_name` = the part after the last `/` (null if empty); `instance` → null. */
export function translateFilter(f: BoardFilter): BoardFilter | null {
  if (f.key === 'instance') return null;
  if (f.key === 'job') {
    const v = f.value.slice(f.value.lastIndexOf('/') + 1);
    return v === '' ? null : { key: 'service_name', value: v };
  }
  return { key: f.key, value: f.value };
}

/** LogQL string escape: `\`, `"` and LF. */
export function escapeLogql(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** UTF-16 order, as `<` compares. */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The target's identity matchers: every stream label of a log line, else `service_name` or `job`. */
function identity(t: InspectorTarget): BoardFilter[] {
  if (t.type === 'logLine') {
    return Object.entries(t.labels).map(([key, value]) => ({ key, value }));
  }
  if (t.type === 'bucket' || t.type === 'geo') return [];
  const labels = t.type === 'mark' ? t.target.mark.labels : t.labels;
  const service = labels['service_name'];
  if (service !== undefined) return [{ key: 'service_name', value: service }];
  const job = labels['job'];
  if (job === undefined) return [];
  const m = translateFilter({ key: 'job', value: job });
  return m === null ? [] : [m];
}

/**
 * The Logs pivot's selector (T25-010): the identity AND the translated filters, every constraint
 * kept, identical matchers once, sorted by key then value. `q` is null when there is no matcher;
 * `notCarried` names the filters the seed drops (unique, URL order); `conflicts` the original
 * filters whose translated key the identity sets to another value.
 */
export function logsSelector(
  t: InspectorTarget,
  f: readonly BoardFilter[],
): { q: string | null; notCarried: string[]; conflicts: string[] } {
  const ident = identity(t);
  const matchers: BoardFilter[] = [...ident];
  const notCarried: string[] = [];
  const conflicts: string[] = [];
  for (const filter of f) {
    const m = translateFilter(filter);
    if (m === null) {
      if (!notCarried.includes(filter.key)) notCarried.push(filter.key);
      continue;
    }
    matchers.push(m);
    if (ident.some((x) => x.key === m.key && x.value !== m.value)) {
      conflicts.push(`${filter.key}=${filter.value}`);
    }
  }
  const unique = new Map<string, BoardFilter>();
  for (const m of matchers) unique.set(`${m.key}\u0000${m.value}`, m);
  const sorted = [...unique.values()].sort((a, b) => cmp(a.key, b.key) || cmp(a.value, b.value));
  const q =
    sorted.length === 0
      ? null
      : `{${sorted.map((m) => `${m.key}="${escapeLogql(m.value)}"`).join(',')}}`;
  return { q, notCarried, conflicts };
}

/** The pivot instant (T25 §4.3); null for a target without one. */
export function pivotInstant(t: InspectorTarget): number | null {
  switch (t.type) {
    case 'point':
      return t.tMs;
    case 'logLine':
      return Number(t.tsNs / 1_000_000n);
    case 'value':
      return t.tMs;
    case 'bucket':
      return t.tMs;
    case 'mark':
    case 'geo':
      // A bar is reduced over the window, a map shows one: the pivot keeps the origin window.
      return null;
  }
}

/** The pivot window (T25 §4.3): ±1 min about the pivot instant; the origin window without one. */
export function pivotWindow(t: InspectorTarget, w: TimeWindow): TimeWindow {
  if (t.type === 'bucket') return { fromMs: t.tMs - MINUTE, toMs: t.toMs + MINUTE };
  const at = pivotInstant(t);
  return at === null ? w : { fromMs: at - MINUTE, toMs: at + MINUTE };
}
