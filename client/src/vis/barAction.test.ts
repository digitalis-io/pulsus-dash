/** `unit:bar-action` (plan #173 Part 3a §3.4, §5; T22-007, T22-005, VIZ-037). */
import { describe, expect, it } from 'vitest';
import type { VisOptions } from '../api/types';
import type { PickEvent } from '../engine/api';
import { byVersion, fkey, instant, threeKeys } from '../test/categoryFixtures';
import type { ExploreResult } from './autovis';
import { barAction, barHint, type BarContext } from './barAction';
import { barchartModel, type BarchartModel } from './barchart';

const W = { fromMs: Date.UTC(2026, 10, 19, 12), toMs: Date.UTC(2026, 10, 19, 13) };

function model(r: ExploreResult, options?: VisOptions): BarchartModel {
  if (r.kind === 'string') throw new Error('series only');
  return barchartModel(r, { title: 'Versions', rateApplied: false, options, thresholds: null });
}

function ctx(m: BarchartModel, o: Partial<Omit<BarContext, 'model'>> = {}): BarContext {
  return {
    model: m,
    surface: 'board',
    filters: [],
    origin: {
      surface: o.surface ?? 'board',
      panelId: 'p1',
      title: 'Versions',
      query: { lang: 'promql', text: 'up' },
      unit: { kind: 'none' },
    },
    window: W,
    ...o,
  };
}

const click = (keys: string[]): PickEvent => ({ keys, gesture: 'click', source: 'pointer' });

/** `byVersion`: 2.31 is the third series. */
const K231 = fkey(3);

describe('unit:bar-action', () => {
  it('a click on a board: the mark, its selection and the filter toggle', () => {
    const m = model(byVersion());
    const a = barAction(click([K231]), ctx(m));
    if (a.kind !== 'click') throw new Error(a.kind);
    expect(a.filter).toEqual({ key: 'version', value: '2.31' });
    expect(a.selection).toEqual({ keys: [K231], fromMs: null, toMs: null });
    expect(a.target.type).toBe('mark');
    expect(a.target.target.mark.value).toBe(120);
    expect(a.target.target).toMatchObject({
      panelId: 'p1',
      kind: 'barchart',
      title: 'Versions',
      window: W,
      query: { lang: 'promql', text: 'up' },
      members: null,
    });
    const on = barAction(click([K231]), ctx(m, { filters: [{ key: 'version', value: '2.31' }] }));
    expect(on.kind === 'click' ? on.filter : 'none').toEqual({ key: 'version', value: null });
    const other = barAction(
      click([K231]),
      ctx(m, { filters: [{ key: 'version', value: '2.30' }] }),
    );
    expect(other.kind === 'click' ? other.filter : 'none').toEqual({
      key: 'version',
      value: '2.31',
    });
    const row = m.all.find((r) => r.key === K231);
    if (row === undefined) throw new Error('no row');
    expect(barHint(row, { model: m, surface: 'board' })).toBeNull();
  });

  it('no pair: no filter and the reason; Explore: no filter', () => {
    const three = model(threeKeys());
    const r3 = three.all[0];
    if (r3 === undefined) throw new Error('no row');
    const a3 = barAction(click([r3.key]), ctx(three));
    expect(a3.kind === 'click' ? a3.filter : 'none').toBeNull();
    expect(barHint(r3, { model: three, surface: 'board' })).toBe("Can't filter: no category label");

    const region = model(byVersion(), { categoryBy: 'region' });
    const rr = region.all[0];
    if (rr === undefined) throw new Error('no row');
    const ar = barAction(click([rr.key]), ctx(region));
    expect(ar.kind === 'click' ? ar.filter : 'none').toBeNull();
    expect(barHint(rr, { model: region, surface: 'board' })).toBe(
      "Can't filter: region missing on this series",
    );

    const m = model(byVersion());
    const ex = barAction(click([K231]), ctx(m, { surface: 'explore' }));
    expect(ex.kind).toBe('click');
    expect(ex.kind === 'click' ? ex.filter : 'none').toBeNull();
    const row = m.all[0];
    if (row === undefined) throw new Error('no row');
    expect(barHint(row, { model: m, surface: 'explore' })).toBe('Filters apply on boards');
  });

  it('an empty click clears, a brush selects, an unknown key does nothing', () => {
    const m = model(byVersion());
    expect(barAction(click([]), ctx(m))).toEqual({ kind: 'clear' });
    const k1 = fkey(1);
    const k2 = fkey(2);
    expect(barAction({ keys: [k1, k2], gesture: 'brush', source: 'keyboard' }, ctx(m))).toEqual({
      kind: 'brush',
      selection: { keys: [k1, k2], fromMs: null, toMs: null },
    });
    expect(barAction(click([fkey(99)]), ctx(m))).toEqual({ kind: 'none' });
  });

  it('a merged row (duplicates of one key) selects that key', () => {
    const K = fkey(7);
    const m = model(
      instant([
        { key: K, labels: { version: '2.31' }, value: 50 },
        { key: K, labels: { version: '2.31' }, value: 70 },
        { key: fkey(2), labels: { version: '2.30' }, value: 20 },
      ]),
    );
    expect(m.all).toHaveLength(2);
    const a = barAction(click([K]), ctx(m));
    expect(a.kind === 'click' ? a.selection : null).toEqual({
      keys: [K],
      fromMs: null,
      toMs: null,
    });
    expect(a.kind === 'click' ? a.target.target.mark.value : null).toBe(70);
  });
});
