/**
 * Pivot Context (T25-010, plan #192 §3): the IA-027 interim translation seed, the logs selector
 * and the pivot window.
 */
import type { TimeWindow } from '../engine/api';
import type { BoardFilter } from '../state/boardParams';
import type { InspectorTarget } from './types';

/** `job` → `service_name` = the part after the last `/` (null if empty); `instance` → null. */
export function translateFilter(f: BoardFilter): BoardFilter | null {
  void f;
  throw new Error('todo');
}

/** LogQL string escape: `\`, `"` and LF. */
export function escapeLogql(v: string): string {
  void v;
  throw new Error('todo');
}

export function logsSelector(
  t: InspectorTarget,
  f: readonly BoardFilter[],
): { q: string | null; notCarried: string[]; conflicts: string[] } {
  void t;
  void f;
  throw new Error('todo');
}

/** The pivot window (T25 §4.3): ±1 min about the pivot instant; the origin window without one. */
export function pivotWindow(t: InspectorTarget, w: TimeWindow): TimeWindow {
  void t;
  void w;
  throw new Error('todo');
}
