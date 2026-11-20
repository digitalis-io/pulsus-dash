import { describe, expect, it } from 'vitest';
import type { Board, BoardSpec } from '../api/types';
import {
  boardReducer,
  initialState,
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
