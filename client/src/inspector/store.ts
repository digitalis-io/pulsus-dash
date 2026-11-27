/**
 * The host's state (T25 §4.6, §4.8; plan #192 §4.1, plan #234 Part 4 §4.1): the inspected request,
 * its sequence, the page selection, the collapsed flag and the request's navigation stack. Pure;
 * the host holds it in `useReducer`.
 */
import type { InspectorTarget, InspectRequest, NavView, Selection } from './types';

export interface InspectorState {
  readonly req: InspectRequest | null;
  /** +1 per inspect: a new target crossfades the sheet's content. */
  readonly seq: number;
  readonly selection: Selection | null;
  readonly collapsed: boolean;
  /** The deeper views of the open request, in push order (T25 §4.8); [] at rest. */
  readonly nav: readonly NavView[];
}

export type InspectorAction =
  | { readonly type: 'inspect'; readonly req: InspectRequest }
  | { readonly type: 'select'; readonly sel: Selection | null }
  | { readonly type: 'close' }
  | { readonly type: 'toggleCollapsed' }
  | { readonly type: 'originChanged'; readonly panelId: string | null }
  /** Another tenant: nothing of the last one survives (T25 §8). */
  | { readonly type: 'reset' }
  /** Applies iff a request is open, `seq` is its `seq` and `depth` is `nav.length`. */
  | { readonly type: 'push'; readonly seq: number; readonly depth: number; readonly view: NavView }
  /** Keeps `nav.slice(0, to)`, for 0 ≤ `to` < `nav.length`. */
  | { readonly type: 'pop'; readonly to: number };

export const INITIAL_INSPECTOR: InspectorState = Object.freeze({
  req: null,
  seq: 0,
  selection: null,
  collapsed: false,
  nav: [],
});

export function inspectorReducer(s: InspectorState, a: InspectorAction): InspectorState {
  switch (a.type) {
    case 'inspect':
      // A new target always opens expanded (T25-013, plan #192 §4.1).
      return { req: a.req, seq: s.seq + 1, selection: a.req.selection, collapsed: false, nav: [] };
    case 'select':
      return s.selection === a.sel ? s : { ...s, selection: a.sel };
    case 'close':
      return s.req === null ? s : { ...s, req: null, nav: [] };
    case 'toggleCollapsed':
      return s.req === null ? s : { ...s, collapsed: !s.collapsed };
    case 'originChanged':
      // The selection stays: only the snapshot goes (T25-012).
      return s.req === null || s.req.origin.panelId !== a.panelId
        ? s
        : { ...s, req: null, nav: [] };
    case 'reset':
      return INITIAL_INSPECTOR;
    case 'push':
      // A stale entry (an older request, a second press in one tick, a closed sheet) does nothing.
      if (s.req === null || a.seq !== s.seq || a.depth !== s.nav.length) return s;
      return { ...s, nav: [...s.nav, a.view], selection: a.view.selection };
    case 'pop': {
      if (s.req === null || !(a.to >= 0 && a.to < s.nav.length)) return s;
      const nav = s.nav.slice(0, a.to);
      return { ...s, nav, selection: nav.at(-1)?.selection ?? s.req.selection };
    }
  }
}

/** The view on top: the last pushed one, else the request's own target. */
export function topOf(s: InspectorState): InspectorTarget | null {
  return s.nav.at(-1)?.target ?? s.req?.target ?? null;
}

/**
 * The identity of the shown view (T25 §4.8): `${seq}:${depth}:${topKey}`, `topKey` the top's id
 * for a `geo` target and `root` for every other kind (so for them it changes iff `seq` does). It
 * keys the content, the layers, the heading focus and the live region.
 */
export function viewKey(s: InspectorState): string {
  const top = topOf(s);
  const topKey = top?.type === 'geo' ? top.target.id : 'root';
  return `${String(s.seq)}:${String(s.nav.length)}:${topKey}`;
}
