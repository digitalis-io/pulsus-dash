/**
 * The board page state (plan #61 Part B §4.1): the loaded head (spec and etag) and the draft the
 * user edits. The draft is dirty when its canonical JSON differs from the head's. A later read of
 * the board never replaces a dirty draft, and no edit is taken while a save is in flight. Part C
 * (§4.1) adds sections: add, rename, remove and, in Edit mode, collapse (saved with the board); a
 * View-mode collapse is a URL override (`isCollapsed`), not state here. #198 Part 3a (§3.3) adds a
 * widget (`addWidget`, with the vis and size its registry def gives) and edits one (`updateWidget`).
 */
import type {
  Board,
  BoardSpec,
  DataPanelSpec,
  FieldError,
  GridPos,
  PanelSpec,
  SectionSpec,
  TimeRangeSpec,
  WidgetPanelSpec,
} from '../api/types';
import type { SectionOverrides } from '../state/boardParams';
import { isDataPanel, isWidgetKind, isWidgetPanel } from '../widgets/spec';
import { t } from '../i18n/t';
import { applyOp, firstFree, fits, type LayoutOp, overlaps } from './layout';
import { canonicalJson, MAX_PANELS, MAX_SECTIONS, nextPanelId, nextSectionId } from './spec';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed' | 'invalid' | 'discardFailed';

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
  | { type: 'addPanel'; grid?: GridRef }
  | { type: 'addSection' }
  | { type: 'updateSection'; id: string; title: string }
  | { type: 'removeSection'; id: string }
  | { type: 'toggleSection'; id: string }
  | { type: 'discardFailed' }
  | {
      type: 'updatePanel';
      id: string;
      /** A data panel's edit (plan #198 Part 1 §4.2); on a widget only `title` applies. */
      patch: PanelPatch;
    }
  | {
      type: 'addWidget';
      vis: WidgetPanelSpec['vis'];
      size: { w: number; h: number };
      grid?: GridRef;
    }
  | { type: 'updateWidget'; id: string; patch: WidgetPatch }
  | { type: 'removePanel'; id: string }
  | { type: 'duplicatePanel'; id: string }
  | { type: 'select'; id: string | null }
  | { type: 'layout'; grid: GridRef; items: LayoutItem[] }
  | { type: 'keyOp'; id: string; op: LayoutOp }
  | { type: 'setTime'; time: TimeRangeSpec | null }
  | { type: 'setTags'; tags: readonly string[] }
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

/** The fields the panel editor changes (a data panel's). */
export type PanelPatch = Partial<Pick<DataPanelSpec, 'title' | 'query' | 'vis'>>;

/** The fields the widget editor changes (plan #198 Part 3a §3.3). */
export type WidgetPatch = { title?: string; vis?: WidgetPanelSpec['vis'] };

/** `p` with `patch`: a data panel takes all of it, a widget only its title (plan #198 Part 1 §4.2). */
function patched(p: PanelSpec, patch: PanelPatch): PanelSpec {
  if (isDataPanel(p)) return { ...p, ...patch };
  return patch.title === undefined ? p : { ...p, title: patch.title };
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

/** A copy's title (plan #64 A.9): `{title} (copy)`, cut to the 200 code points a title may have. */
function copyTitle(title: string): string {
  if (title === '') return '';
  return Array.from(t('panel.copyTitle', { title })).slice(0, 200).join('');
}

/** The live-region text of a refused pointer drop or keyboard step. */
export function blockedText(p: PanelSpec): string {
  return position('panel.blocked', p);
}

const EDITS: ReadonlySet<BoardAction['type']> = new Set([
  'addPanel',
  'addWidget',
  'updatePanel',
  'updateWidget',
  'removePanel',
  'duplicatePanel',
  'layout',
  'keyOp',
  'setTime',
  'addSection',
  'updateSection',
  'removeSection',
  'toggleSection',
]);

/** The draft with section `id` replaced by `f(section)`. */
function withSection(spec: BoardSpec, id: string, f: (s: SectionSpec) => SectionSpec): BoardSpec {
  return { ...spec, sections: spec.sections.map((x) => (x.id === id ? f(x) : x)) };
}

/**
 * Whether a section shows collapsed. View: a URL override (`collapse` / `expand`), else the saved
 * state. Edit: the draft's state, which is saved.
 */
export function isCollapsed(
  mode: 'view' | 'edit',
  section: SectionSpec,
  o: SectionOverrides,
): boolean {
  if (mode === 'edit') return section.collapsed;
  if (o.collapse.has(section.id)) return true;
  if (o.expand.has(section.id)) return false;
  return section.collapsed;
}

/**
 * Adds the panel `make` builds at the first free `size` cell of `grid`, opens the grid's section if
 * collapsed, and selects it (`addPanel`, `addWidget`; plan #198 Part 3a §3.3). At `MAX_PANELS`, or
 * with no free cell, it announces why and adds nothing.
 */
function addAt(
  s: BoardPageState,
  grid: GridRef,
  size: { w: number; h: number },
  make: (id: string, at: GridPos) => PanelSpec,
): BoardPageState {
  if (allPanels(s.draft).length >= MAX_PANELS) return { ...s, announce: t('board.fullPanels') };
  if (grid !== 'top' && s.draft.sections[grid] === undefined) return s;
  const free = firstFree(panelsOf(s.draft, grid), size.w, size.h);
  if (free === null) return { ...s, announce: t('board.full') };
  const panel = make(nextPanelId(s.draft), free);
  let draft = withPanels(s.draft, grid, [...panelsOf(s.draft, grid), panel]);
  // A panel added to a collapsed section opens it, so the new panel shows.
  if (grid !== 'top') {
    draft = {
      ...draft,
      sections: draft.sections.map((x, j) => (j === grid ? { ...x, collapsed: false } : x)),
    };
  }
  return { ...edited(s, draft), selected: panel.id, announce: '' };
}

/**
 * An edit leaves "Saved" behind; failures (a save's or Discard's) and field errors stay until the
 * next save.
 */
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
    case 'addPanel':
      return addAt(s, a.grid ?? 'top', NEW_PANEL, (id, grid) => ({
        id,
        title: '',
        grid,
        query: { lang: 'promql', text: '' },
        vis: { kind: 'auto' },
      }));
    case 'addWidget': {
      const vis = a.vis;
      // A data kind needs a query: only `addPanel` adds one.
      if (!isWidgetKind(vis.kind)) return s;
      return addAt(s, a.grid ?? 'top', a.size, (id, grid) => ({ id, title: '', grid, vis }));
    }
    case 'addSection': {
      if (s.draft.sections.length >= MAX_SECTIONS)
        return { ...s, announce: t('board.sectionsFull') };
      const section: SectionSpec = {
        id: nextSectionId(s.draft),
        title: '',
        collapsed: false,
        panels: [],
      };
      return {
        ...edited(s, { ...s.draft, sections: [...s.draft.sections, section] }),
        announce: '',
      };
    }
    case 'updateSection':
      if (!s.draft.sections.some((x) => x.id === a.id)) return s;
      return edited(
        s,
        withSection(s.draft, a.id, (x) => ({ ...x, title: a.title })),
      );
    case 'removeSection': {
      const gone = s.draft.sections.find((x) => x.id === a.id);
      if (gone === undefined) return s;
      const selectedGone = gone.panels.some((p) => p.id === s.selected);
      return {
        ...edited(s, { ...s.draft, sections: s.draft.sections.filter((x) => x.id !== a.id) }),
        selected: selectedGone ? null : s.selected,
      };
    }
    case 'toggleSection':
      // View-mode toggles are URL state (`useBoardParams`), not the draft.
      if (s.mode === 'view' || !s.draft.sections.some((x) => x.id === a.id)) return s;
      return edited(
        s,
        withSection(s.draft, a.id, (x) => ({ ...x, collapsed: !x.collapsed })),
      );
    case 'discardFailed':
      return { ...s, save: { status: 'discardFailed', fields: [] } };
    case 'updatePanel': {
      const grid = gridOf(s.draft, a.id);
      if (grid === null) return s;
      const panels = panelsOf(s.draft, grid).map((p) => (p.id === a.id ? patched(p, a.patch) : p));
      return edited(s, withPanels(s.draft, grid, panels));
    }
    case 'updateWidget': {
      const grid = gridOf(s.draft, a.id);
      const p = allPanels(s.draft).find((x) => x.panel.id === a.id)?.panel;
      if (grid === null || p === undefined || !isWidgetPanel(p)) return s;
      if (a.patch.vis !== undefined && a.patch.vis.kind !== p.vis.kind) return s;
      const next: WidgetPanelSpec = { ...p, ...a.patch };
      const panels = panelsOf(s.draft, grid).map((x) => (x.id === a.id ? next : x));
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
    case 'duplicatePanel': {
      const grid = gridOf(s.draft, a.id);
      const p = allPanels(s.draft).find((x) => x.panel.id === a.id)?.panel;
      if (grid === null || p === undefined) return s;
      if (allPanels(s.draft).length >= MAX_PANELS) return { ...s, announce: t('board.fullPanels') };
      const free = firstFree(panelsOf(s.draft, grid), p.grid.w, p.grid.h);
      if (free === null) return { ...s, announce: t('board.full') };
      const copy: PanelSpec = {
        ...p,
        id: nextPanelId(s.draft),
        title: copyTitle(p.title),
        grid: free,
      };
      return {
        ...edited(s, withPanels(s.draft, grid, [...panelsOf(s.draft, grid), copy])),
        announce: t('panel.duplicated', {
          title: copy.title === '' ? t('panel.untitled') : copy.title,
        }),
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
        // Every other key is kept (tags among them, T24-029).
        const rest = { ...s.draft };
        delete rest.time;
        return edited(s, rest);
      }
      return edited(s, { ...s.draft, time: a.time });
    }
    case 'setTags':
      return s;
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
