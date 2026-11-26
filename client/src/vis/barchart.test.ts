/**
 * The bar chart's plan (plan #173 Part 2 §3.4, §5): `barchartModel` once per result and options,
 * `fitBarchart` per cell size with a 6 px-per-character measure.
 */
import { describe, expect, it } from 'vitest';
import { BOTTOM, categoryExtent, LABEL_HEIGHT } from '../engine/canvas2d/layout';
import { barLayout, minPlotPx } from '../engine/canvas2d/barLayout';
import { BY_VERSION, byVersion, instant } from '../test/categoryFixtures';
import { barchartModel, fitBarchart, type BarchartFit, type BarchartModel } from './barchart';
import { coverageText, panelRows, summaryFacts } from './reduce';
import type { Thresholds } from './thresholds';

const m6 = (t: string): number => 6 * Array.from(t).length;
const L = LABEL_HEIGHT;

function model(o: { options?: Parameters<typeof barchartModel>[1]['options'] } = {}) {
  return barchartModel(byVersion() as Exclude<ReturnType<typeof byVersion>, { kind: 'string' }>, {
    title: 'Versions',
    rateApplied: false,
    options: o.options,
    thresholds: null,
  });
}

const stage = (f: BarchartFit): string => (f.notice === 'tooSmall' ? 'tooSmall' : f.hidden);

/** The plot dimension along the value axis of a mounted fit. */
function valueDim(m: BarchartModel, f: BarchartFit, w: number, h: number): number {
  if (f.notice !== null) throw new Error('not mounted');
  const p = barLayout(f.spec, f.data.categories, w, h, m6).plot;
  return m.spec.orientation === 'horizontal' ? p.width : p.height;
}

describe('unit:barchart-fit-stages', () => {
  it('horizontal: names, then values, then tooSmall as the width shrinks', () => {
    expect(minPlotPx(m6)).toBe(48);
    const on = model();
    const off = model({ options: { valueLabels: false } });
    const at = (m: BarchartModel, w: number) => fitBarchart(m, { width: w, height: 240 }, m6);
    expect([130, 100, 80, 60].map((w) => stage(at(on, w)))).toEqual([
      'none',
      'names',
      'namesValues',
      'tooSmall',
    ]);
    expect([130, 80, 60].map((w) => stage(at(off, w)))).toEqual(['none', 'names', 'tooSmall']);
    for (const [m, w] of [
      [on, 130],
      [on, 100],
      [on, 80],
      [off, 130],
      [off, 80],
    ] as const) {
      expect(valueDim(m, at(m, w), w, 240)).toBeGreaterThanOrEqual(48);
    }
    const small = at(on, 60);
    if (small.notice !== 'tooSmall') throw new Error('mounted');
    expect(small.coverage).toMatchObject({ total: 5, drawn: 0 });
    expect(coverageText(small.coverage)).toBe('showing 0 of 5');
    expect(small.rows.rows.map((r) => r.cells[4])).toEqual(['no', 'no', 'no', 'no', 'no']);
  });

  it('vertical: the same stages as the height shrinks', () => {
    const on = model({ options: { orientation: 'vertical' } });
    const off = model({ options: { orientation: 'vertical', valueLabels: false } });
    const at = (m: BarchartModel, h: number) => fitBarchart(m, { width: 600, height: h }, m6);
    expect([88 + L, 87 + L, 55 + L, 55].map((h) => stage(at(on, h)))).toEqual([
      'none',
      'names',
      'namesValues',
      'tooSmall',
    ]);
    expect([88, 87, 55].map((h) => stage(at(off, h)))).toEqual(['none', 'names', 'tooSmall']);
    for (const [m, h] of [
      [on, 88 + L],
      [on, 87 + L],
      [on, 55 + L],
      [off, 88],
      [off, 87],
    ] as const) {
      expect(valueDim(m, at(m, h), 600, h)).toBeGreaterThanOrEqual(48);
    }
    const small = at(on, 55);
    if (small.notice !== 'tooSmall') throw new Error('mounted');
    expect(small.coverage).toMatchObject({ total: 5, drawn: 0 });
    expect(small.rows.rows.every((r) => r.cells[4] === 'no')).toBe(true);
  });

  it('a hidden stage sets the spec: names hidden, then value labels off', () => {
    const on = model();
    const names = fitBarchart(on, { width: 100, height: 240 }, m6);
    const both = fitBarchart(on, { width: 80, height: 240 }, m6);
    if (names.notice !== null || both.notice !== null) throw new Error('not mounted');
    expect(names.spec).toMatchObject({ names: 'hidden', valueLabels: true });
    expect(both.spec).toMatchObject({ names: 'hidden', valueLabels: false });
  });
});

describe('unit:barchart-plan', () => {
  const extent = (e: number) => ({ width: 600, height: e + 8 + BOTTOM });

  it('rows once, sorted; all drawn at a tall cell', () => {
    const m = model();
    expect(m.all.map((r) => r.name)).toEqual(['2.31', '2.29', '2.33', '2.30', '2.32']);
    expect(m.result).toBe(m.result);
    const f = fitBarchart(m, { width: 600, height: 240 }, m6);
    if (f.notice !== null) throw new Error('not mounted');
    expect(categoryExtent(f.spec, 600, 240)).toBe(240 - 8 - BOTTOM);
    expect(f.data.categories.map((r) => r.name)).toEqual(['2.31', '2.29', '2.33', '2.30', '2.32']);
    expect(f.coverage.drawn).toBe(5);
    expect(coverageText(f.coverage)).toBe('100 %');
    expect(f.data.coverage).toEqual(f.coverage);
    expect(f.spec.valueRange).toBeUndefined();
    expect(f.rows).toEqual(panelRows('barchart', m.all, f.data.categories, m.spec.unit));
    expect(f.facts).toEqual(
      summaryFacts('barchart', 'Versions', m.result, m.all, m.spec.unit, null),
    );
  });

  it('the model keeps its input', () => {
    const r = byVersion() as Exclude<ReturnType<typeof byVersion>, { kind: 'string' }>;
    const m = barchartModel(r, {
      title: 'V',
      rateApplied: true,
      options: undefined,
      thresholds: null,
    });
    expect(m.result).toBe(r);
    expect(m.spec.unit).toEqual({ kind: 'suffix', suffix: '/s' });
    expect(m.spec).toMatchObject({ ghost: false, anomaly: false, orientation: 'horizontal' });
    expect(m.baseline).toBeNull();
  });

  it('too small below a cap of 2; one bar draws at a cap of 1', () => {
    const m = model();
    for (const e of [20, 10]) {
      const f = fitBarchart(m, extent(e), m6);
      if (f.notice !== 'tooSmall') throw new Error(`mounted at ${String(e)}`);
      expect(f.cap).toBe(e === 20 ? 1 : 0);
      expect(f.text).toBe('too small: 5 bars (min 2.32 3, max 2.31 120)');
      expect(f.coverage.drawn).toBe(0);
      expect(coverageText(f.coverage)).toBe('showing 0 of 5');
      expect(f.rows.rows).toHaveLength(5);
      expect(f.rows.rows.every((r) => r.cells[4] === 'no')).toBe(true);
    }
    const one = barchartModel(
      instant([BY_VERSION[2] ?? { labels: {}, value: 0 }]) as Exclude<
        ReturnType<typeof byVersion>,
        { kind: 'string' }
      >,
      { title: 'One', rateApplied: false, options: undefined, thresholds: null },
    );
    const f = fitBarchart(one, extent(20), m6);
    expect(f.notice).toBeNull();
    expect(f.coverage.drawn).toBe(1);
  });

  it('min and max bound the value axis; values outside are counted', () => {
    const both = fitBarchart(model({ options: { min: 0, max: 500 } }), extent(200), m6);
    if (both.notice !== null) throw new Error('not mounted');
    expect(both.spec.valueRange).toEqual({ min: 0, max: 500 });
    const min = fitBarchart(model({ options: { min: 500 } }), extent(200), m6);
    if (min.notice !== null) throw new Error('not mounted');
    expect(min.spec.valueRange).toEqual({ min: 500, max: 620 });
    expect(coverageText(min.coverage)).toBe('5 values outside the fixed range');
  });

  it('thresholds set the states and the lines', () => {
    const t: Thresholds = {
      direction: 'above',
      steps: [{ value: 100, state: 'failing', label: '' }],
    };
    const r = byVersion() as Exclude<ReturnType<typeof byVersion>, { kind: 'string' }>;
    const m = barchartModel(r, {
      title: 'V',
      rateApplied: false,
      options: undefined,
      thresholds: t,
    });
    expect(m.all.map((x) => x.state)).toEqual(['failing', 'ok', 'ok', 'ok', 'ok']);
    expect(m.spec.thresholds).toEqual([{ value: 100, state: 'failing', label: '≥ 100' }]);
  });
});
