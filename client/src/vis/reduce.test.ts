/**
 * The categorical transforms (T22 §5.2, §10.3; plan #173 Part 1 §5): reduce, cap, coverage text,
 * labels and names, duplicates, bounds, summary facts and the table rows.
 */
import { describe, expect, it } from 'vitest';
import type { Completeness } from '../data/decode';
import { seriesName, type CategoryRow, type Coverage, type SeriesFrame } from '../data/frames';
import type { Unit } from '../i18n/format';
import {
  byVersion,
  COMPLETE,
  dupes,
  fkey,
  instant,
  many,
  range,
  row,
  T,
  threeKeys,
} from '../test/categoryFixtures';
import {
  barCap,
  capMarks,
  categoryCoverage,
  categoryRows,
  coverageText,
  csvFileName,
  deltaText,
  effectiveLabel,
  filterBlockText,
  filterPair,
  markNames,
  mergeDuplicates,
  outsideCount,
  panelCsv,
  panelRows,
  reduceSeries,
  resolveBounds,
  summaryFacts,
  tooSmallText,
} from './reduce';
import type { Thresholds } from './thresholds';

const NONE: Unit = { kind: 'none' };
const K = fkey(0xabc);
const OPTS = { reducer: 'last', categoryBy: '', sort: 'valueDesc', thresholds: null } as const;
const FAILING_100: Thresholds = {
  direction: 'above',
  steps: [{ value: 100, state: 'failing', label: '' }],
};

function series(values: readonly number[]): SeriesFrame {
  return {
    key: fkey(1),
    labels: {},
    timestamps: new Float64Array(values.map((_, i) => i * 1000)),
    values: new Float64Array(values),
  };
}

function coverage(c: Partial<Coverage> = {}): Coverage {
  return {
    total: 5,
    drawn: 5,
    keptMin: false,
    keptMax: false,
    keptWorst: 0,
    omittedWorst: 0,
    worstState: null,
    outside: 0,
    duplicates: 0,
    conflicts: 0,
    query: COMPLETE,
    baseline: null,
    ...c,
  };
}

const withWarnings = (n: number): Completeness => ({
  ...COMPLETE,
  warnings: Array.from({ length: n }, (_, i) => `warning ${String(i)}`),
});
const TRUNCATED: Completeness = { ...COMPLETE, truncated: true };

function covered(all: readonly CategoryRow[], cap: number, query: Completeness = COMPLETE) {
  return categoryCoverage({
    all,
    capped: capMarks(all, cap),
    query,
    baseline: null,
    outside: 0,
    duplicates: 0,
    conflicts: 0,
  });
}

describe('unit:category-reduce', () => {
  it('reduces over finite samples', () => {
    const s = series([1, NaN, 3]);
    expect(reduceSeries(s, 'last')).toBe(3);
    expect(reduceSeries(s, 'first')).toBe(1);
    expect(reduceSeries(s, 'mean')).toBe(2);
    expect(reduceSeries(s, 'min')).toBe(1);
    expect(reduceSeries(s, 'max')).toBe(3);
    expect(reduceSeries(s, 'sum')).toBe(4);
    expect(reduceSeries(s, 'count')).toBe(2);
    const gaps = series([NaN, NaN]);
    for (const r of ['last', 'first', 'mean', 'min', 'max', 'sum'] as const)
      expect(reduceSeries(gaps, r), r).toBeNaN();
    expect(reduceSeries(gaps, 'count')).toBe(0);
  });
});

describe('unit:category-cap', () => {
  it('keeps min, max and the worst state', () => {
    const all = many();
    const capped = capMarks(all, 200);
    expect(capped.drawn).toHaveLength(200);
    const values = capped.drawn.map((m) => m.value);
    expect(values).toContain(10);
    expect(values).toContain(1);
    expect(values).toContain(250);
    // Kept rows draw in sort order.
    expect(values).toEqual([...values].sort((a, b) => b - a));
    const c = covered(all, 200);
    expect(c).toMatchObject({
      total: 250,
      drawn: 200,
      keptMin: true,
      keptMax: true,
      keptWorst: 1,
      omittedWorst: 0,
      worstState: 'failing',
      outside: 0,
    });
    expect(coverageText(c)).toBe('showing 200 of 250; kept min, max, 1 failing');
  });
});

describe('unit:category-tiny', () => {
  it('caps 3 and 2, the too-small text, the rows and the label fit', () => {
    const all = many();
    expect(capMarks(all, 3).drawn.map((m) => m.value)).toEqual([250, 10, 1]);
    expect(coverageText(covered(all, 3))).toBe('showing 3 of 250; kept min, max, 1 failing');
    expect(capMarks(all, 2).drawn.map((m) => m.value)).toEqual([250, 1]);
    const two = covered(all, 2);
    expect(two).toMatchObject({
      drawn: 2,
      keptMin: true,
      keptMax: true,
      keptWorst: 0,
      omittedWorst: 1,
    });
    expect(coverageText(two)).toBe('showing 2 of 250; kept min, max; 1 failing not shown');
    expect(tooSmallText(all, NONE)).toBe('too small: 250 bars (min 1 1, max 250 250, 1 failing)');
    const rows = panelRows('barchart', all, capMarks(all, 0).drawn, NONE);
    expect(rows.rows).toHaveLength(250);
    expect(rows.rows.every((r) => !r.drawn && r.cells[4] === 'no')).toBe(true);
    expect([20, 10, 2800, 300].map(barCap)).toEqual([1, 0, 200, 21]);
  });
});

describe('unit:coverage-text', () => {
  it('the meter parts', () => {
    expect(coverageText(coverage())).toBe('100 %');
    expect(
      coverageText(coverage({ query: { ...COMPLETE, warnings: ['series limit reached'] } })),
    ).toBe('limited (1 warning)');
    expect(coverageText(coverage({ query: TRUNCATED }))).toBe('truncated');
    expect(coverageText(coverage({ baseline: TRUNCATED }))).toBe('baseline truncated');
    expect(coverageText(coverage({ baseline: withWarnings(2) }))).toBe(
      'baseline limited (2 warnings)',
    );
    expect(coverageText(covered(many(), 200, TRUNCATED))).toBe(
      'truncated · showing 200 of 250; kept min, max, 1 failing',
    );
  });

  it('list members', () => {
    expect(coverageText(coverage({ total: 12, drawn: 10 }))).toBe('showing 10 of 12');
    expect(coverageText(coverage({ total: 1000, drawn: 10, query: TRUNCATED }))).toBe(
      'truncated · showing 10 of 1,000',
    );
    expect(coverageText(coverage({ unknown: { reason: 'oldServer' } }))).toBe('coverage unknown');
    expect(coverageText(coverage({ unknown: { reason: 'tagsStale', count: 1 } }))).toBe(
      'tags not yet known for 1 board',
    );
    expect(coverageText(coverage({ unknown: { reason: 'tagsStale', count: 3 } }))).toBe(
      'tags not yet known for 3 boards',
    );
    expect(coverageText(coverage({ unknown: { reason: 'paged', pages: 2 } }))).toBe(
      'all 2 pages loaded · may have changed while loading',
    );
    expect(coverageText(coverage({ staleAtMs: 0 }), 'UTC')).toBe('stale (00:00:00)');
    expect(coverageText(coverage({ outside: 5 }))).toBe('5 values outside the fixed range');
  });
});

describe('unit:category-label', () => {
  it('the effective label, filter pairs and names', () => {
    const v = byVersion();
    if (v.kind !== 'series') throw new Error('series');
    expect(effectiveLabel(v.series, '')).toBe('version');
    const bars = categoryRows(v, null, OPTS);
    expect(bars.label).toBe('version');
    const top = bars.rows[0];
    if (top === undefined) throw new Error('no rows');
    expect(filterPair(top, bars.label)).toEqual({ key: 'version', value: '2.31' });

    const three = threeKeys();
    if (three.kind !== 'series') throw new Error('series');
    expect(effectiveLabel(three.series, '')).toBeNull();
    const t = categoryRows(three, null, OPTS);
    expect(t.label).toBeNull();
    expect(t.rows.map((r) => r.name)).toEqual(three.series.map((s) => seriesName(s.labels)));
    const first = t.rows[0];
    if (first === undefined) throw new Error('no rows');
    const none = filterPair(first, null);
    expect(none).toEqual({ reason: 'noLabel' });
    if ('key' in none) throw new Error('pair');
    expect(filterBlockText(none)).toBe("Can't filter: no category label");

    const missing = filterPair(row(fkey(9), '{}', 1), 'version');
    expect(missing).toEqual({ reason: 'missing', label: 'version' });
    if ('key' in missing) throw new Error('pair');
    expect(filterBlockText(missing)).toBe("Can't filter: version missing on this series");

    const d = categoryRows(dupes(), null, { ...OPTS, categoryBy: 'version' });
    expect(d.rows.map((r) => r.name)).toEqual(['2.31 · region="us"', '2.31 · region="eu"', '2.30']);
  });
});

describe('unit:category-duplicates', () => {
  it('instant duplicates: max kept, one conflict', () => {
    const r = instant([
      { key: K, labels: { version: '2.31' }, value: 50 },
      { key: K, labels: { version: '2.31' }, value: 70 },
      { key: fkey(2), labels: { version: '2.30' }, value: 20 },
    ]);
    const base = instant([
      { key: K, labels: { version: '2.31' }, value: 30 },
      { key: K, labels: { version: '2.31' }, value: 35 },
    ]);
    const c = categoryRows(r, base, OPTS);
    expect(c.rows).toHaveLength(2);
    expect(c.rows[0]).toMatchObject({ key: K, name: '2.31', value: 70, baseline: 35 });
    expect(c.duplicates).toBe(1);
    expect(c.conflicts).toBe(1);
    expect(c.baseline).toEqual({ duplicates: 1, conflicts: 1 });
    const cov = categoryCoverage({
      all: c.rows,
      capped: capMarks(c.rows, 200),
      query: COMPLETE,
      baseline: COMPLETE,
      outside: 0,
      duplicates: c.duplicates,
      conflicts: c.conflicts,
    });
    expect(coverageText(cov)).toBe('1 duplicate series combined; 1 conflicts (max kept)');
    expect(deltaText(70, c.rows[0]?.baseline ?? null)).toBe('▲ 100 %');
  });

  it('range duplicates: one sample per timestamp', () => {
    const at = (values: number[], ts: number[]): SeriesFrame => ({
      key: K,
      labels: { version: '2.31' },
      timestamps: new Float64Array(ts),
      values: new Float64Array(values),
    });
    const apart = mergeDuplicates([at([1, 3], [T[0], T[2]]), at([2], [T[1]])], 'range');
    expect(Array.from(apart.series[0]?.values ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(apart.series[0]?.timestamps ?? [])).toEqual([T[0], T[1], T[2]]);
    expect(apart.duplicates).toBe(1);
    expect(apart.conflicts).toBe(0);
    const overlap = [at([1, 5], [T[0], T[1]]), at([4, 2], [T[1], T[2]])];
    const m = mergeDuplicates(overlap, 'range');
    expect(Array.from(m.series[0]?.values ?? [])).toEqual([1, 5, 2]);
    expect(m.conflicts).toBe(1);
    const r = { ...range([]), series: overlap };
    const rows = categoryRows(r, null, OPTS).rows;
    const facts = summaryFacts('barchart', 'P', r, rows, NONE, null);
    expect(facts.change).toEqual({ series: '{version="2.31"}', from: '1', to: '5', atMs: T[1] });
  });
});

describe('unit:category-subset-names', () => {
  it('the shortest distinguishing set; absent is never a value', () => {
    const k = (n: number) => fkey(n);
    expect(
      markNames(
        [
          { key: k(1), labels: { version: '2.31' } },
          { key: k(2), labels: { version: '2.31', region: 'eu' } },
        ],
        'version',
      ),
    ).toEqual(['2.31 · region absent', '2.31 · region="eu"']);
    expect(
      markNames(
        [
          { key: k(1), labels: { version: '2.31' } },
          { key: k(2), labels: { version: '2.31', region: '∅' } },
        ],
        'version',
      ),
    ).toEqual(['2.31 · region absent', '2.31 · region="∅"']);
    const x = { version: '2.31', a: '1', b: '1', c: '1', d: '1', e: '1' };
    const names = markNames(
      [
        { key: k(1), labels: x },
        { key: k(2), labels: { ...x, a: '2', e: '2' } },
        { key: k(3), labels: { ...x, b: '2' } },
        { key: k(4), labels: { ...x, c: '2' } },
        { key: k(5), labels: { ...x, d: '2' } },
      ],
      'version',
    );
    expect(names[0]).toBe('2.31 · a="1" · b="1" · c="1" · d="1"');
    expect(new Set(names).size).toBe(5);
  });
});

describe('unit:category-unique-names', () => {
  it('the final uniqueness pass', () => {
    const names = markNames(
      [
        { key: fkey(1), labels: { version: '2.31', region: 'eu' } },
        { key: fkey(3), labels: { version: '2.31', region: 'us' } },
        { key: fkey(2), labels: { version: '2.31 · region="eu"' } },
      ],
      'version',
    );
    expect(names).toEqual([
      '2.31 · region="eu" (1)',
      '2.31 · region="us"',
      '2.31 · region="eu" (2)',
    ]);
    expect(new Set(names).size).toBe(3);
    expect(
      markNames([{ key: fkey(1), labels: { version: 'other' } }], 'version', ['other (4)']),
    ).toEqual(['"other"']);
    expect(markNames([{ key: fkey(1), labels: { version: '2.31 (1)' } }], 'version')).toEqual([
      '"2.31 (1)"',
    ]);
  });
});

describe('unit:category-bounds', () => {
  it('resolveBounds and outsideCount', () => {
    const auto = { min: 0, max: 120 };
    expect(resolveBounds(undefined, undefined, auto)).toEqual({ min: 0, max: 120 });
    expect(resolveBounds(0, 500, auto)).toEqual({ min: 0, max: 500 });
    expect(resolveBounds(500, undefined, auto)).toEqual({ min: 500, max: 620 });
    expect(resolveBounds(undefined, -10, auto)).toEqual({ min: -130, max: -10 });
    expect(resolveBounds(10, undefined, { min: 5, max: 5 })).toEqual({ min: 10, max: 11 });
    const marks = categoryRows(byVersion(), null, OPTS).rows;
    expect(outsideCount(marks, { min: 500, max: 620 })).toBe(5);
    expect(outsideCount(marks, null)).toBe(0);
  });
});

describe('unit:category-summary-facts', () => {
  const specs = [
    { labels: { version: '2.31' }, values: [100, 100, 400, 120] },
    { labels: { version: '2.30' }, values: [5, 7] },
    { labels: { version: '2.29' }, values: [40, 40] },
  ];
  const base = range([{ labels: { version: '2.31' }, values: [60] }]);
  const opts = { ...OPTS, thresholds: FAILING_100 };

  it('range: focus, change, extent and ratio', () => {
    const r = range(specs);
    const rows = categoryRows(r, base, opts).rows;
    expect(rows.map((m) => m.value)).toEqual([120, 40, 7]);
    expect(summaryFacts('barchart', 'Requests', r, rows, NONE, COMPLETE)).toEqual({
      subject: 'Requests',
      current: { text: '120', series: '2.31' },
      change: { series: '2.31', from: '100', to: '400', atMs: T[2] },
      extent: { min: 7, max: 120 },
      baselineRatio: 2,
    });
    expect(
      summaryFacts('barchart', 'Requests', r, rows, NONE, withWarnings(1)).baselineRatio,
    ).toBeNull();
  });

  it('instant, empty and no finite mark', () => {
    const r = instant([
      { labels: { version: '2.31' }, value: 120 },
      { labels: { version: '2.30' }, value: 7 },
      { labels: { version: '2.29' }, value: 40 },
    ]);
    const rows = categoryRows(r, null, opts).rows;
    const f = summaryFacts('barchart', 'Requests', r, rows, NONE, null);
    expect(f.change).toBeNull();
    expect(f.extent).toEqual({ min: 7, max: 120 });
    expect(f.current).toEqual({ text: '120', series: '2.31' });
    const nulls = { current: null, change: null, extent: null, baselineRatio: null };
    expect(summaryFacts('barchart', 'E', range([]), [], NONE, COMPLETE)).toEqual({
      subject: 'E',
      ...nulls,
    });
    const gaps = range([{ labels: { version: '2.31' }, values: [NaN, NaN] }]);
    const gapRows = categoryRows(gaps, null, opts).rows;
    expect(summaryFacts('barchart', 'G', gaps, gapRows, NONE, COMPLETE)).toEqual({
      subject: 'G',
      ...nulls,
    });
  });
});

describe('unit:category-table', () => {
  it('rows of every pre-cap mark, aggregates and CSV', () => {
    const all = many();
    const t42 = panelRows('barchart', all, capMarks(all, 42).drawn, NONE);
    expect(t42.columns).toEqual(['name', 'value', 'baseline', 'state', 'drawn', 'shown as']);
    expect(t42.rows.filter((r) => r.cells[4] === 'no')).toHaveLength(208);

    const a = row(fkey(1), 'a', 5);
    const m1 = row(fkey(2), 'm1', 2);
    const m2 = row(fkey(3), 'm2', 1);
    const z = row(fkey(4), 'z', 0);
    const other: CategoryRow = {
      ...row('other:pie', 'other (2)', 3),
      members: [m1, m2].map(({ key, labels, name, value }) => ({ key, labels, name, value })),
    };
    const t = panelRows('barchart', [a, m1, m2, z], [a, other], NONE);
    expect(t.rows.map((r) => [r.mark.key, r.cells[4], r.shownAs])).toEqual([
      [a.key, 'yes', 'a'],
      [m1.key, 'yes', 'other (2)'],
      [m2.key, 'yes', 'other (2)'],
      [z.key, 'no', ''],
    ]);
    expect(t.rows.map((r) => r.drawn)).toEqual([true, true, true, false]);

    const odd = panelRows('barchart', [row(fkey(5), 'a,"b"', NaN)], [], NONE);
    const csv = panelCsv(odd);
    expect(csv.split('\r\n')).toEqual([
      'name,value,baseline,state,drawn,shown as',
      '"a,""b""",,,,no,',
      '',
    ]);
    expect(csvFileName('CPU % host')).toBe('CPU___host.csv');
    expect(csvFileName('')).toBe('panel.csv');
  });
});
