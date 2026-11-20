/**
 * The board page state (plan #61 Part B §4.1): the loaded head (spec and etag) and the draft the
 * user edits. The draft is dirty when its canonical JSON differs from the head's. A later read of
 * the board never replaces a dirty draft, and no edit is taken while a save is in flight.
 */
import type { Board, BoardSpec, FieldError, PanelSpec, TimeRangeSpec } from '../api/types';
import { t } from '../i18n/t';
import { applyOp, firstFree, fits, type LayoutOp, overlaps } from './layout';
import { canonicalJson, MAX_PANELS, nextPanelId } from './spec';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed' | 'invalid';

export interface BoardPageState {
  mode: 'view' | 'edit';
  head: Board;
  draft: BoardSpec;
  /** The panel the editor shows (Edit mode). */
  selected: string | null;
  save: { status: SaveStatus; fields: FieldError[] };
  /** The head a 409 returned; the conflict dialog is open while set. */
  conflict: Board | null;
  /** A newer head read while the draft was dirty or saving. */
  remote: Board | null;
  /** The last message of the polite live region (T08-018). */
  announce: string;
}

/** One grid item as the Edit-mode grid reports it. */
export interface LayoutItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The top-level grid, or section `n`'s. */
export type GridRef = 'top' | number;

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
  | { type: 'layout'; grid: GridRef; items: LayoutItem[] }
  | { type: 'keyOp'; id: string; op: LayoutOp }
  | { type: 'setTime'; time: TimeRangeSpec | null }
  | { type: 'saveStart' }
  | { type: 'saveOk'; board: Board }
  | { type: 'saveFailed' }
  | { type: 'saveInvalid'; fields: FieldError[] }
  | { type: 'conflict'; current: Board }
  /** A message for the live region from outside the reducer (a refused pointer drop). */
  | { type: 'announce'; text: string };

/** The width and height of a new panel. */
export const NEW_PANEL = { w: 6, h: 8 } as const;

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

export function isDirty(s: BoardPageState): boolean {
  return canonicalJson(s.draft) !== canonicalJson(s.head.spec);
}

/** Every panel of the board with its grid and index. */
export function allPanels(spec: BoardSpec): { panel: PanelSpec; grid: GridRef; index: number }[] {
  return [
    ...spec.panels.map((panel, index) => ({ panel, grid: 'top' as const, index })),
    ...spec.sections.flatMap((s, j) => s.panels.map((panel, index) => ({ panel, grid: j, index }))),
  ];
}

/** The JSON pointer prefix of a panel (`/panels/0`, `/sections/1/panels/2`). */
export function panelPointer(grid: GridRef, index: number): string {
  return grid === 'top'
    ? `/panels/${String(index)}`
    : `/sections/${String(grid)}/panels/${String(index)}`;
}

export function panelsOf(spec: BoardSpec, grid: GridRef): readonly PanelSpec[] {
  return grid === 'top' ? spec.panels : (spec.sections[grid]?.panels ?? []);
}

function withPanels(spec: BoardSpec, grid: GridRef, panels: PanelSpec[]): BoardSpec {
  if (grid === 'top') return { ...spec, panels };
  return {
    ...spec,
    sections: spec.sections.map((s, j) => (j === grid ? { ...s, panels } : s)),
  };
}

function gridOf(spec: BoardSpec, id: string): GridRef | null {
  return allPanels(spec).find((x) => x.panel.id === id)?.grid ?? null;
}

/** `{title}: column {x}, row {y}, {w} × {h}` (1-based column and row). */
function position(id: 'panel.moved' | 'panel.blocked', p: PanelSpec): string {
  return t(id, {
    title: p.title === '' ? t('panel.untitled') : p.title,
    x: p.grid.x + 1,
    y: p.grid.y + 1,
    w: p.grid.w,
    h: p.grid.h,
  });
}

/** The live-region text of a refused pointer drop or keyboard step. */
export function blockedText(p: PanelSpec): string {
  return position('panel.blocked', p);
}

const EDITS: ReadonlySet<BoardAction['type']> = new Set([
  'addPanel',
  'updatePanel',
  'removePanel',
  'layout',
  'keyOp',
  'setTime',
]);

/** An edit leaves "Saved" behind; failures and field errors stay until the next save. */
function edited(s: BoardPageState, draft: BoardSpec): BoardPageState {
  return {
    ...s,
    draft,
    save: s.save.status === 'saved' ? { status: 'idle', fields: [] } : s.save,
  };
}

export function boardReducer(s: BoardPageState, a: BoardAction): BoardPageState {
  if (s.save.status === 'saving' && EDITS.has(a.type)) return s;
  switch (a.type) {
    case 'loaded':
      return {
        ...s,
        head: a.board,
        draft: a.board.spec,
        selected: null,
        conflict: null,
        remote: null,
        save: { status: 'idle', fields: [] },
      };
    case 'remoteHead':
      if (a.board.etag === s.head.etag) return s;
      if (!isDirty(s) && s.save.status !== 'saving')
        return boardReducer(s, { type: 'loaded', board: a.board });
      return { ...s, remote: a.board };
    case 'enterEdit':
      return { ...s, mode: 'edit' };
    case 'exitEdit':
      return { ...s, mode: 'view', selected: null };
    case 'addPanel': {
      const total = allPanels(s.draft).length;
      if (total >= MAX_PANELS) return { ...s, announce: t('board.fullPanels') };
      const free = firstFree(s.draft.panels, NEW_PANEL.w, NEW_PANEL.h);
      if (free === null) return { ...s, announce: t('board.full') };
      const panel: PanelSpec = {
        id: nextPanelId(s.draft),
        title: '',
        grid: free,
        query: { lang: 'promql', text: '' },
        vis: { kind: 'auto' },
      };
      return {
        ...edited(s, { ...s.draft, panels: [...s.draft.panels, panel] }),
        selected: panel.id,
        announce: '',
      };
    }
    case 'updatePanel': {
      const grid = gridOf(s.draft, a.id);
      if (grid === null) return s;
      const panels = panelsOf(s.draft, grid).map((p) => (p.id === a.id ? { ...p, ...a.patch } : p));
      return edited(s, withPanels(s.draft, grid, panels));
    }
    case 'removePanel': {
      const grid = gridOf(s.draft, a.id);
      if (grid === null) return s;
      const panels = panelsOf(s.draft, grid).filter((p) => p.id !== a.id);
      return {
        ...edited(s, withPanels(s.draft, grid, panels)),
        selected: s.selected === a.id ? null : s.selected,
      };
    }
    case 'select':
      return { ...s, selected: a.id };
    case 'layout': {
      const byId = new Map(a.items.map((l) => [l.i, l]));
      const current = panelsOf(s.draft, a.grid);
      const panels = current.map((p) => {
        const l = byId.get(p.id);
        return l === undefined ? p : { ...p, grid: { x: l.x, y: l.y, w: l.w, h: l.h } };
      });
      // A layout the server would reject (out of bounds or overlapping) is never taken.
      const valid = panels.every(
        (p, i) => fits(p.grid) && !panels.some((q, j) => j !== i && overlaps(p.grid, q.grid)),
      );
      if (!valid) return s;
      return edited(s, withPanels(s.draft, a.grid, panels));
    }
    case 'keyOp': {
      const grid = gridOf(s.draft, a.id);
      if (grid === null) return s;
      const r = applyOp(panelsOf(s.draft, grid), a.id, a.op);
      const p = r.panels.find((x) => x.id === a.id);
      if (p === undefined) return s;
      if (!r.moved) return { ...s, announce: position('panel.blocked', p) };
      return {
        ...edited(s, withPanels(s.draft, grid, r.panels)),
        announce: position('panel.moved', p),
      };
    }
    case 'setTime': {
      if (a.time === null) {
        const { title, panels, sections } = s.draft;
        return edited(s, { title, panels, sections });
      }
      return edited(s, { ...s.draft, time: a.time });
    }
    case 'saveStart':
      // Saving again from the conflict dialog closes it.
      return { ...s, conflict: null, save: { status: 'saving', fields: [] } };
    case 'saveOk':
      return {
        ...s,
        head: a.board,
        draft: a.board.spec,
        remote: null,
        conflict: null,
        save: { status: 'saved', fields: [] },
      };
    case 'saveFailed':
      return { ...s, save: { status: 'failed', fields: [] } };
    case 'saveInvalid':
      return { ...s, save: { status: 'invalid', fields: a.fields } };
    case 'conflict':
      return { ...s, conflict: a.current, save: { status: 'idle', fields: [] } };
    case 'announce':
      return { ...s, announce: a.text };
  }
}
