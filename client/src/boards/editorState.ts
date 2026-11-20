/** The board page reducer (plan #61 Part B §4.1). Stub. */
import type { Board, BoardSpec, FieldError, PanelSpec, TimeRangeSpec } from '../api/types';
import type { LayoutOp } from './layout';

export interface BoardPageState {
  mode: 'view' | 'edit';
  head: Board;
  draft: BoardSpec;
  selected: string | null;
  save: { status: 'idle' | 'saving' | 'saved' | 'failed' | 'invalid'; fields: FieldError[] };
  conflict: Board | null;
  remote: Board | null;
  announce: string;
}

export interface LayoutItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type BoardAction =
  | { type: 'loaded'; board: Board }
  | { type: 'remoteHead'; board: Board }
  | { type: 'enterEdit' }
  | { type: 'exitEdit' }
  | { type: 'addPanel' }
  | {
      type: 'updatePanel';
      id: string;
      patch: Partial<Pick<PanelSpec, 'title' | 'query' | 'vis'>>;
    }
  | { type: 'removePanel'; id: string }
  | { type: 'select'; id: string | null }
  | { type: 'layout'; grid: 'top' | number; items: LayoutItem[] }
  | { type: 'keyOp'; id: string; op: LayoutOp }
  | { type: 'setTime'; time: TimeRangeSpec | null }
  | { type: 'saveStart' }
  | { type: 'saveOk'; board: Board }
  | { type: 'saveFailed' }
  | { type: 'saveInvalid'; fields: FieldError[] }
  | { type: 'conflict'; current: Board };

export function initialState(board: Board): BoardPageState {
  return {
    mode: 'view',
    head: board,
    draft: board.spec,
    selected: null,
    save: { status: 'idle', fields: [] },
    conflict: null,
    remote: null,
    announce: '',
  };
}

export function isDirty(_s: BoardPageState): boolean {
  return false;
}

export function boardReducer(s: BoardPageState, _a: BoardAction): BoardPageState {
  return s;
}
