import { describe, expect, it } from 'vitest';
import type { Board, BoardSpec } from '../api/types';
import {
  boardReducer,
  initialState,
  isCollapsed,
  isDirty,
  type BoardAction,
  type BoardPageState,
} from './editorState';

const MINIMAL: BoardSpec = { title: 'New board', panels: [], sections: [] };

function board(etag: string, spec: BoardSpec = MINIMAL): Board {
  return {
    uid: 'b-9',
    title: spec.title,
    version: Number(etag),
    updatedAt: '2026-11-19T12:00:00.000Z',
    updatedBy: 'Ada Admin',
    etag,
    spec,
  };
}

function run(s: BoardPageState, ...actions: BoardAction[]): BoardPageState {
  return actions.reduce(boardReducer, s);
}

describe('reducer', () => {
  it('reducer', () => {
    let s = run(initialState(board('1')), { type: 'loaded', board: board('1') });
    expect(isDirty(s)).toBe(false);

    s = run(s, { type: 'enterEdit' }, { type: 'addPanel' });
    expect(isDirty(s)).toBe(true);
    expect(s.selected).toBe('p-1');
    expect(s.draft.panels[0]?.grid).toEqual({ x: 0, y: 0, w: 6, h: 8 });

    s = run(s, { type: 'updatePanel', id: 'p-1', patch: { title: 'A' } });
    expect(s.draft.panels[0]?.title).toBe('A');

    s = run(s, { type: 'keyOp', id: 'p-1', op: 'right' });
    expect(s.announce).toBe('A: column 2, row 1, 6 × 8');

    s = run(s, { type: 'removePanel', id: 'p-1' });
    expect(isDirty(s)).toBe(false);

    const b2 = board('2', { ...MINIMAL, title: 'Two' });
    s = run(s, { type: 'saveOk', board: b2 });
    expect(isDirty(s)).toBe(false);
    expect(s.head).toEqual(b2);

    const c = board('3');
    s = run(s, { type: 'conflict', current: c });
    expect(s.conflict).toEqual(c);

    s = run(s, { type: 'setTime', time: { from: 'now-6h', to: 'now' } });
    expect(s.draft.time).toEqual({ from: 'now-6h', to: 'now' });
    s = run(s, { type: 'setTime', time: null });
    expect('time' in s.draft).toBe(false);
  });

  it('remote heads', () => {
    const three = { ...MINIMAL, title: 'Remote' };
    const clean = run(initialState(board('1')), { type: 'loaded', board: board('1') });
    const replaced = run(clean, { type: 'remoteHead', board: board('2', three) });
    expect(replaced.head.etag).toBe('2');
    expect(replaced.draft).toEqual(three);

    const dirty = run(clean, { type: 'enterEdit' }, { type: 'addPanel' });
    const kept = run(dirty, { type: 'remoteHead', board: board('2', three) });
    expect(kept.draft).toEqual(dirty.draft);
    expect(kept.head.etag).toBe('1');
    expect(kept.remote?.etag).toBe('2');

    const saving = run(dirty, { type: 'saveStart' });
    expect(run(saving, { type: 'addPanel' }).draft).toEqual(saving.draft);
    const ok = run(kept, { type: 'saveStart' }, { type: 'saveOk', board: board('3') });
    expect(ok.remote).toBeNull();
  });
});

const SECTIONED: BoardSpec = {
  title: 'Sectioned',
  panels: [
    {
      id: 'p-1',
      title: 'Top',
      grid: { x: 0, y: 0, w: 6, h: 8 },
      query: { lang: 'promql', text: 'up' },
      vis: { kind: 'auto' },
    },
  ],
  sections: [
    {
      id: 's-1',
      title: 'Latency',
      collapsed: false,
      panels: [
        {
          id: 'p-4',
          title: 'Wide',
          grid: { x: 0, y: 0, w: 12, h: 8 },
          query: { lang: 'promql', text: 'up' },
          vis: { kind: 'auto' },
        },
      ],
    },
  ],
};

const none = { collapse: new Set<string>(), expand: new Set<string>() };

describe('sections', () => {
  it('sections reducer', () => {
    const loaded = run(initialState(board('1', SECTIONED)), {
      type: 'loaded',
      board: board('1', SECTIONED),
    });
    expect(run(loaded, { type: 'toggleSection', id: 's-1' })).toBe(loaded);

    const sec = SECTIONED.sections[0];
    if (sec === undefined) throw new Error('no section');
    const collapsedSec = { ...sec, collapsed: true };
    expect(isCollapsed('view', sec, { collapse: new Set(['s-1']), expand: new Set() })).toBe(true);
    expect(
      isCollapsed('view', collapsedSec, { collapse: new Set(), expand: new Set(['s-1']) }),
    ).toBe(false);
    expect(isCollapsed('view', collapsedSec, none)).toBe(true);
    expect(isCollapsed('edit', sec, { collapse: new Set(['s-1']), expand: new Set() })).toBe(false);
    expect(
      isCollapsed('edit', collapsedSec, { collapse: new Set(), expand: new Set(['s-1']) }),
    ).toBe(true);

    let s = run(loaded, { type: 'enterEdit' }, { type: 'toggleSection', id: 's-1' });
    expect(s.draft.sections[0]?.collapsed).toBe(true);
    expect(isDirty(s)).toBe(true);

    s = run(s, { type: 'addPanel', grid: 0 });
    expect(s.draft.sections[0]?.collapsed).toBe(false);
    expect(s.draft.sections[0]?.panels.at(-1)?.id).toBe('p-5');
    expect(s.draft.sections[0]?.panels.at(-1)?.grid).toEqual({ x: 0, y: 8, w: 6, h: 8 });
    expect(s.draft.panels).toHaveLength(1);
    expect(s.selected).toBe('p-5');

    s = run(s, { type: 'addSection' });
    expect(s.draft.sections[1]).toEqual({ id: 's-2', title: '', collapsed: false, panels: [] });
    s = run(s, { type: 'updateSection', id: 's-2', title: 'More' });
    expect(s.draft.sections[1]?.title).toBe('More');
    s = run(s, { type: 'removeSection', id: 's-1' });
    expect(s.draft.sections.map((x) => x.id)).toEqual(['s-2']);
    expect(s.selected).toBeNull();

    const saving = run(s, { type: 'saveStart' });
    expect(run(saving, { type: 'addSection' }).draft).toEqual(saving.draft);
    expect(run(saving, { type: 'toggleSection', id: 's-2' }).draft).toEqual(saving.draft);
  });

  it('sections full', () => {
    const fifty: BoardSpec = {
      title: 'Full',
      panels: [],
      sections: Array.from({ length: 50 }, (_, i) => ({
        id: `s-${String(i + 1)}`,
        title: '',
        collapsed: false,
        panels: [],
      })),
    };
    const s = run(initialState(board('1', fifty)), { type: 'enterEdit' }, { type: 'addSection' });
    expect(s.draft.sections).toHaveLength(50);
    expect(s.announce).toBe('A board can have at most 50 sections');
  });

  it('discard failure', () => {
    let s = run(initialState(board('1')), { type: 'enterEdit' }, { type: 'addPanel' });
    expect(isDirty(s)).toBe(true);
    s = run(s, { type: 'discardFailed' });
    expect(s.save.status).toBe('discardFailed');
    s = run(s, { type: 'updatePanel', id: 'p-1', patch: { title: 'A' } });
    expect(s.draft.panels[0]?.title).toBe('A');
    expect(s.save.status).toBe('discardFailed');
  });
});

describe('duplicatePanel', () => {
  const p = (id: string, title: string, g = { x: 0, y: 0, w: 6, h: 8 }) => ({
    id,
    title,
    grid: g,
    query: { lang: 'promql' as const, text: 'up' },
    vis: { kind: 'line' as const },
  });
  const edit = (spec: BoardSpec) => run(initialState(board('1', spec)), { type: 'enterEdit' });

  it('duplicatePanel', () => {
    // No such panel: unchanged.
    const one = edit({ ...MINIMAL, panels: [p('p-1', 'Requests')] });
    expect(run(one, { type: 'duplicatePanel', id: 'p-9' })).toBe(one);

    // The copy: a new id, the copied title, the first free cell of the same grid.
    const sel = run(one, { type: 'select', id: 'p-1' });
    const s = run(sel, { type: 'duplicatePanel', id: 'p-1' });
    expect(s.draft.panels).toHaveLength(2);
    expect(s.draft.panels[1]).toEqual({
      ...p('p-2', 'Requests (copy)'),
      grid: { x: 6, y: 0, w: 6, h: 8 },
    });
    expect(s.selected).toBe('p-1');
    expect(s.announce).toBe('Panel duplicated: Requests (copy)');
    expect(isDirty(s)).toBe(true);

    // In a section, into the same section.
    const sec = edit({
      ...MINIMAL,
      sections: [{ id: 's-1', title: '', collapsed: false, panels: [p('p-1', '')] }],
    });
    const d = run(sec, { type: 'duplicatePanel', id: 'p-1' });
    expect(d.draft.sections[0]?.panels.map((x) => x.id)).toEqual(['p-1', 'p-2']);
    expect(d.draft.sections[0]?.panels[1]?.title).toBe('');
    expect(d.announce).toBe('Panel duplicated: Untitled panel');
  });

  it('duplicate copies thresholds', () => {
    const vis = {
      kind: 'line' as const,
      thresholds: {
        direction: 'above' as const,
        steps: [{ value: 2, state: 'degraded' as const, label: 'SLO' }],
      },
      legend: { mode: 'hidden' as const },
    };
    const one = edit({ ...MINIMAL, panels: [{ ...p('p-1', 'Requests'), vis }] });
    const s = run(one, { type: 'duplicatePanel', id: 'p-1' });
    expect(s.draft.panels[1]?.vis).toEqual(vis);
  });

  it('full boards and the title cut', () => {
    const many = edit({
      ...MINIMAL,
      panels: Array.from({ length: 200 }, (_, i) =>
        p(`p-${String(i + 1)}`, 'A', { x: 0, y: i, w: 1, h: 1 }),
      ),
    });
    const full = run(many, { type: 'duplicatePanel', id: 'p-1' });
    expect(full.draft).toBe(many.draft);
    expect(full.announce).toBe('Board is full: at most 200 panels');

    const tall = edit({ ...MINIMAL, panels: [p('p-1', 'A', { x: 0, y: 0, w: 12, h: 10_000 })] });
    const noRoom = run(tall, { type: 'duplicatePanel', id: 'p-1' });
    expect(noRoom.draft).toBe(tall.draft);
    expect(noRoom.announce).toBe('Board is full: no space for a 6 × 8 panel');

    const long = edit({ ...MINIMAL, panels: [p('p-1', '😀'.repeat(195))] });
    const cut = run(long, { type: 'duplicatePanel', id: 'p-1' });
    const title = cut.draft.panels[1]?.title ?? '';
    expect(Array.from(title)).toHaveLength(200);
    expect(title).toBe(`${'😀'.repeat(195)} (cop`);
  });
});

describe('board tags (T24-029)', () => {
  it('clear time keeps tags', () => {
    const spec: BoardSpec = {
      title: 'T',
      time: { from: 'now-6h', to: 'now' },
      tags: ['a'],
      panels: [],
      sections: [],
    };
    let s = run(initialState(board('1', spec)), { type: 'loaded', board: board('1', spec) });
    s = run(s, { type: 'enterEdit' }, { type: 'setTime', time: null });
    expect(s.draft.tags).toEqual(['a']);
    expect(s.draft).not.toHaveProperty('time');
  });
});
