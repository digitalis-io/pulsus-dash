// unit:inspector-nav (the reducer) and unit:inspector-viewkey (the key) (T25-007, T25 §4.8; plan
// #234 Part 4 §4.1).
import { describe, expect, it } from 'vitest';
import { P_TARGET, pRequest } from '../test/inspectorKit';
import { INITIAL_INSPECTOR, inspectorReducer, topOf, viewKey, type InspectorState } from './store';
import type { InspectorTarget, NavView, Selection } from './types';

const sel = (...keys: string[]): Selection => ({ keys, fromMs: null, toMs: null });

const view = (name: string, keys: string[]): NavView => ({
  target: { ...P_TARGET, name, key: keys[0] ?? name },
  selection: sel(...keys),
  title: name,
});

const A = view('A', ['a1', 'a2']);
const B = view('B', ['b1']);

function opened(): InspectorState {
  return inspectorReducer(INITIAL_INSPECTOR, { type: 'inspect', req: pRequest() });
}

describe('unit:inspector-nav (reducer)', () => {
  it('push A, then B: the stack and its selection; pop back to the root', () => {
    const s0 = opened();
    expect(s0.nav).toEqual([]);
    const s1 = inspectorReducer(s0, { type: 'push', seq: s0.seq, depth: 0, view: A });
    expect(s1.nav).toEqual([A]);
    expect(s1.selection).toBe(A.selection);
    const s2 = inspectorReducer(s1, { type: 'push', seq: s0.seq, depth: 1, view: B });
    expect(s2.nav).toEqual([A, B]);
    expect(s2.selection).toBe(B.selection);
    expect(topOf(s2)).toBe(B.target);
    const back = inspectorReducer(s2, { type: 'pop', to: 1 });
    expect(back.nav).toEqual([A]);
    expect(back.selection).toBe(A.selection);
    const root = inspectorReducer(s2, { type: 'pop', to: 0 });
    expect(root.nav).toEqual([]);
    expect(root.selection).toBe(s0.req?.selection);
    expect(topOf(root)).toBe(s0.req?.target);
    // A push or a pop shows its view: a collapsed sheet expands (review r1).
    const folded = inspectorReducer(s2, { type: 'toggleCollapsed' });
    expect(folded.collapsed).toBe(true);
    expect(inspectorReducer(folded, { type: 'pop', to: 1 }).collapsed).toBe(false);
    const foldedA = inspectorReducer(s1, { type: 'toggleCollapsed' });
    expect(
      inspectorReducer(foldedA, { type: 'push', seq: s0.seq, depth: 1, view: B }).collapsed,
    ).toBe(false);
    // Out of range: unchanged.
    expect(inspectorReducer(s2, { type: 'pop', to: 2 })).toBe(s2);
    expect(inspectorReducer(s2, { type: 'pop', to: -1 })).toBe(s2);
  });

  it('an old seq, a wrong depth or a closed request is a no-op; a reopened request takes the new seq', () => {
    const s0 = opened();
    const s1 = inspectorReducer(s0, { type: 'push', seq: s0.seq, depth: 0, view: A });
    expect(inspectorReducer(s1, { type: 'push', seq: s0.seq, depth: 0, view: B })).toBe(s1);
    expect(inspectorReducer(s1, { type: 'push', seq: s0.seq - 1, depth: 1, view: B })).toBe(s1);
    const closed = inspectorReducer(s1, { type: 'close' });
    expect(closed.nav).toEqual([]);
    expect(inspectorReducer(closed, { type: 'push', seq: closed.seq, depth: 0, view: B })).toBe(
      closed,
    );
    const re = inspectorReducer(closed, { type: 'inspect', req: pRequest() });
    expect(inspectorReducer(re, { type: 'push', seq: s0.seq, depth: 0, view: B })).toBe(re);
    const pushed = inspectorReducer(re, { type: 'push', seq: re.seq, depth: 0, view: B });
    expect(pushed.nav).toEqual([B]);
  });

  it('close, a matching originChanged and reset empty the stack; select keeps it', () => {
    const s0 = opened();
    const s1 = inspectorReducer(s0, { type: 'push', seq: s0.seq, depth: 0, view: A });
    expect(inspectorReducer(s1, { type: 'close' }).nav).toEqual([]);
    expect(inspectorReducer(s1, { type: 'originChanged', panelId: 'p1' }).nav).toEqual([]);
    expect(inspectorReducer(s1, { type: 'originChanged', panelId: 'other' }).nav).toEqual([A]);
    expect(inspectorReducer(s1, { type: 'reset' }).nav).toEqual([]);
    const picked = inspectorReducer(s1, { type: 'select', sel: sel('z') });
    expect(picked.nav).toEqual([A]);
    expect(inspectorReducer(s1, { type: 'inspect', req: pRequest() }).nav).toEqual([]);
  });
});

describe('unit:inspector-viewkey (key)', () => {
  it('`${seq}:${depth}:${topKey}`: root for every kind but geo', () => {
    const s0 = opened();
    expect(viewKey(s0)).toBe(`${String(s0.seq)}:0:root`);
    const geo = (id: string): InspectorTarget =>
      ({ type: 'geo', target: { id } }) as unknown as InspectorTarget;
    const g: NavView = { target: geo('group:x'), selection: sel('x'), title: 'x' };
    const s1 = inspectorReducer(s0, { type: 'push', seq: s0.seq, depth: 0, view: g });
    expect(viewKey(s1)).toBe(`${String(s0.seq)}:1:group:x`);
    const s2 = inspectorReducer(s1, { type: 'push', seq: s0.seq, depth: 1, view: A });
    expect(viewKey(s2)).toBe(`${String(s0.seq)}:2:root`);
  });
});
