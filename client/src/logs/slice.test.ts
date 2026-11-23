// unit:log-slice (plan #66 Part B, B.9).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEW,
  anchorOf,
  growSlice,
  indexOf,
  layoutOf,
  marginOf,
  ordAt,
  restoreOffset,
  sliceAround,
  startOf,
  wantsRecentre,
  type Layout,
} from './slice';

const h20 = () => 20;
const h2000 = () => 2000;
const s = (start: number, end: number) => ({ start, end });
const item = (index: number, start: number, end: number) => ({ index, start, end });
/** The layout of {1000, 3000} over a buffer [1000, 3000) not at its start: both sentinels. */
const HEAD: Layout = { head: true, tail: true, count: 2002 };

describe('unit:log-slice', () => {
  it('V1 the slice around the first row', () => {
    expect(sliceAround(0, 0, 500_000, DEFAULT_VIEW, h20)).toEqual(s(0, 200_000));
  });

  it('V2 growth while scrolling', () => {
    expect(growSlice(s(0, 150_000), 180_000, DEFAULT_VIEW, 3e6, h20)).toEqual(s(0, 180_000));
    expect(growSlice(s(0, 200_000), 250_000, DEFAULT_VIEW, 4e6, h20)).toEqual(s(0, 220_000));
  });

  it('V3 the px bound', () => {
    expect(growSlice(s(0, 1_000), 10_000, DEFAULT_VIEW, 7_990_000, h2000)).toEqual(s(0, 1_005));
  });

  it('V4 centring, below first', () => {
    expect(sliceAround(185_000, 0, 1_000_000, DEFAULT_VIEW, h20)).toEqual(s(85_001, 285_001));
  });

  it('V5 a side at the edge gives its share', () => {
    expect(sliceAround(999_990, 0, 1_000_000, DEFAULT_VIEW, h20)).toEqual(s(800_000, 1_000_000));
  });

  it('V6 wrapped extent bounded', () => {
    expect(sliceAround(50, 0, 10_000, DEFAULT_VIEW, h2000)).toEqual(s(0, 4_000));
  });

  it('V7 re-slice triggers', () => {
    const w = (sl: ReturnType<typeof s>, a: number, b: number, first: number, end: number) =>
      wantsRecentre(sl, a, b, first, end, 4e6, DEFAULT_VIEW);
    expect(w(s(1_000, 201_000), 150_000, 150_040, 2_000, 1_001_000)).toBe(true);
    expect(w(s(0, 200_000), 185_000, 185_040, 0, 1e6)).toBe(true);
    expect(w(s(0, 200_000), 195_000, 195_040, 0, 200_000)).toBe(false);
    expect(w(s(300_000, 500_000), 310_000, 310_040, 0, 1e6)).toBe(true);
    expect(w(s(0, 220_000), 100_000, 100_040, 0, 220_000)).toBe(true);
  });

  it('V8 the anchor procedure', () => {
    const a = anchorOf(
      [item(0, 0, 40), item(1, 40, 60), item(2, 60, 80)],
      65,
      s(1000, 3000),
      HEAD,
      1000,
      3000,
    );
    expect(a).toEqual({ ord: 1001, offsetPx: 5 });
    const noHead: Layout = { head: false, tail: false, count: 2000 };
    expect(restoreOffset(a, (i) => i * 20, s(500, 2500), noHead, 20_000)).toBe(10_025);
    expect(restoreOffset(a, (i) => i * 20, s(500, 2500), noHead, 9_000)).toBe(9_000);
  });

  it('V9 index mapping', () => {
    const l = layoutOf(s(1000, 3000), 1000, 3000, false);
    expect(l).toEqual({ head: true, tail: true, count: 2002 });
    expect(ordAt(0, s(1000, 3000), l)).toBe('head');
    expect(ordAt(1, s(1000, 3000), l)).toBe(1000);
    expect(ordAt(2001, s(1000, 3000), l)).toBe('tail');
    expect(indexOf(1000, s(1000, 3000), l)).toBe(1);
    expect(indexOf(999, s(1000, 3000), l)).toBeNull();
  });

  it('V10 head sentinel at the top (rule 1)', () => {
    expect(
      anchorOf([item(0, 0, 40), item(1, 40, 60)], 10, s(1000, 3000), HEAD, 1000, 3000),
    ).toEqual({ ord: 1000, offsetPx: -30 });
  });

  it('V11 tail sentinel at the top (rule 2)', () => {
    const tail: Layout = { head: false, tail: true, count: 3 };
    expect(
      anchorOf(
        [item(0, 0, 20), item(1, 20, 40), item(2, 40, 80)],
        50,
        s(1000, 1002),
        tail,
        0,
        1002,
      ),
    ).toEqual({ ord: 1001, offsetPx: 30 });
  });

  it('V12 rule 3, clamping', () => {
    const tail: Layout = { head: false, tail: true, count: 1 };
    expect(anchorOf([item(0, 0, 40)], 0, s(0, 0), tail, 0, 0)).toEqual({ ord: 0, offsetPx: 0 });
    expect(
      anchorOf(
        [item(0, 0, 20)],
        5,
        s(1500, 1501),
        { head: false, tail: false, count: 1 },
        2000,
        3000,
      ),
    ).toEqual({ ord: 2000, offsetPx: 0 });
  });

  it('V13 stationary: no repeated re-slice', () => {
    const next = sliceAround(500_000, 0, 1e6, DEFAULT_VIEW, h2000);
    expect(next).toEqual(s(498_001, 502_001));
    expect(marginOf(next, DEFAULT_VIEW)).toBe(1_000);
    expect(wantsRecentre(next, 500_000, 500_000, 0, 1e6, 8e6, DEFAULT_VIEW)).toBe(false);
    expect(sliceAround(500_000, 0, 1e6, DEFAULT_VIEW, h2000)).toEqual(next);
  });

  it('V14 maxPx after measuring', () => {
    expect(wantsRecentre(s(0, 4000), 2000, 2010, 0, 4000, 8_000_001, DEFAULT_VIEW)).toBe(true);
  });

  it('V15 measurements unavailable', () => {
    const head: Layout = { head: true, tail: false, count: 4 };
    expect(
      startOf(
        3,
        () => undefined,
        s(100, 103),
        head,
        () => 30,
        40,
      ),
    ).toBe(100);
    expect(
      startOf(
        3,
        (i) => i * 7,
        s(100, 103),
        head,
        () => 30,
        40,
      ),
    ).toBe(21);
  });

  it('V16 restore fallback', () => {
    const head: Layout = { head: true, tail: false, count: 4 };
    expect(restoreOffset({ ord: 9999, offsetPx: 5 }, (i) => i * 20, s(100, 103), head, 1e6)).toBe(
      20,
    );
  });
});
