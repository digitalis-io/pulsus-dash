/**
 * The host's state (T25 §4.6, plan #192 §4.1): the inspected request, its sequence, the page
 * selection and the collapsed flag. Pure; the host holds it in `useReducer`.
 */
import type { InspectRequest, Selection } from './types';

export interface InspectorState {
  readonly req: InspectRequest | null;
  /** +1 per inspect: a new target crossfades the sheet's content. */
  readonly seq: number;
  readonly selection: Selection | null;
  readonly collapsed: boolean;
}

export type InspectorAction =
  | { readonly type: 'inspect'; readonly req: InspectRequest }
  | { readonly type: 'select'; readonly sel: Selection | null }
  | { readonly type: 'close' }
  | { readonly type: 'toggleCollapsed' }
  | { readonly type: 'originChanged'; readonly panelId: string | null };

export const INITIAL_INSPECTOR: InspectorState = Object.freeze({
  req: null,
  seq: 0,
  selection: null,
  collapsed: false,
});

export function inspectorReducer(s: InspectorState, a: InspectorAction): InspectorState {
  void a;
  return s;
}
