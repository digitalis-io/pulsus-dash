/**
 * The host's state (T25 §4.6, plan #192 §4.1): the inspected request, its sequence, the page
 * selection and the collapsed flag. Pure; the host holds it in `useReducer`.
 */
import type { InspectorTarget, InspectRequest, NavView, Selection } from './types';

export interface InspectorState {
  readonly req: InspectRequest | null;
  /** +1 per inspect: a new target crossfades the sheet's content. */
  readonly seq: number;
  readonly selection: Selection | null;
  readonly collapsed: boolean;
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
  | { readonly type: 'push'; readonly seq: number; readonly depth: number; readonly view: NavView }
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
      return s.req === null ? s : { ...s, req: null };
    case 'toggleCollapsed':
      return s.req === null ? s : { ...s, collapsed: !s.collapsed };
    case 'originChanged':
      // The selection stays: only the snapshot goes (T25-012).
      return s.req === null || s.req.origin.panelId !== a.panelId ? s : { ...s, req: null };
    case 'reset':
      return INITIAL_INSPECTOR;
    case 'push':
    case 'pop':
      return s;
  }
}

export function topOf(s: InspectorState): InspectorTarget | null {
  return s.req?.target ?? null;
}

export function viewKey(s: InspectorState): string {
  return `${String(s.seq)}:0:root`;
}
