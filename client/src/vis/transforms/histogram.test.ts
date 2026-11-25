// unit:dist-bins, unit:summary-facts, unit:selection-draw (plan #208 Part 1 §5; T21-012 to T21-016).
// The (F) rows run the shared fixtures in fixtures/histogram.json (T21 §10, reused by the engine port).
import { afterEach, describe, expect, it } from 'vitest';
import type { Completeness } from '../../data/decode';
import {
  histogramFrameValid,
  type HistogramFrame,
  type Labels,
  type SeriesFrame,
} from '../../data/frames';
import { keyHash } from '../../dev/keyHash';
import { seriesColourIndex } from '../../engine/canvas2d/palette';
import { CATEGORY_PATTERNS, LINE_DASHES, OTHER_DASH } from '../../engine/patterns';
import { formatValue, type Unit } from '../../i18n/format';
import { t } from '../../i18n/t';
import { fakeHistogramKit, settle } from '../../test/fakeHistogramWorker';
import { mulberry32 } from '../../test/random';
import fixturesRaw from './fixtures/histogram.json?raw';
import {
  binAtPx,
  binLabels,
  binLayout,
  binRangeText,
  binSeries,
  brushBins,
  cdf,
  ecdfAt,
  exclusionLines,
  groupKey,
  histogram,
  histogramCoverageText,
  hitTestBin,
  noneShownText,
  selectedCounts,
  summaryFacts,
  type HistogramOptions,
  type HistogramResult,
} from './histogram';
import { disposeHistogram, runHistogram, setHistogramEnv } from './histogramClient';
import type { Slicer } from './slice';

const NONE: Unit = { kind: 'none' };
const NS: Unit = { kind: 'time', base: 'ns' };
const PU: Unit = { kind: 'percentunit' };
const Q: Completeness = {
  truncated: false,
  warnings: [],
  infos: [],
  queryId: null,
  dataAgeMs: null,
  readCache: null,
  readCacheThroughMs: null,
};
const ND = 9.999999999999999e289;
const SL: Slicer = { now: () => 0, signal: new AbortController().signal };

function opt(o: Partial<HistogramOptions> = {}): HistogramOptions {
  return {
    binMode: 'auto',
    binCount: 20,
    binWidth: null,
    scale: 'linear',
    groupBy: null,
    groupMode: 'stack',
    cumulative: 'none',
    unit: NONE,
    ...o,
  };
}
const count = (c: number, o: Partial<HistogramOptions> = {}): HistogramOptions =>
  opt({ binMode: 'count', binCount: c, ...o });

/** A series with timestamps 0, 1000, … unless given. */
function series(labels: Labels, values: readonly number[], ts?: readonly number[]): SeriesFrame {
  return {
    key: keyHash(labels),
    labels,
    timestamps: Float64Array.from(ts ?? values.map((_, i) => i * 1000)),
    values: Float64Array.from(values),
  };
}
/** A series of group `g` = v. */
const g = (v: string, values: readonly number[]): SeriesFrame => series({ g: v }, values);
const rep = (n: number, v: number): number[] => Array.from({ length: n }, () => v);

function frameOf(r: HistogramResult): HistogramFrame {
  expect(r.kind).toBe('frame');
  if (r.kind !== 'frame') throw new Error(r.kind);
  return r.frame;
}
const run = (
  input: readonly SeriesFrame[],
  o: HistogramOptions,
  source: 'instant' | 'range' = 'range',
  q: Completeness = Q,
): HistogramResult => histogram(input, source, o, q);
const frame = (input: readonly SeriesFrame[], o: HistogramOptions): HistogramFrame =>
  frameOf(run(input, o));
/** Counts summed over the drawn groups, per bin. */
function panelCounts(f: HistogramFrame): number[] {
  const k = f.edges.length - 1;
  return Array.from({ length: k }, (_, i) =>
    f.groups.reduce((a, _g, j) => a + (f.counts[j * k + i] ?? 0), 0),
  );
}
const groupCounts = (f: HistogramFrame, j: number): number[] => {
  const k = f.edges.length - 1;
  return Array.from(f.counts.subarray(j * k, (j + 1) * k));
};
const sourceIndex = (f: HistogramFrame, name: string): number =>
  f.sourceGroups.findIndex((s) => s.name === name);
/** |got − want| ≤ |want|·1e-12 (exact for 0). */
const nearRel = (got: number, want: number): void => {
  expect(Math.abs(got - want)).toBeLessThanOrEqual(Math.abs(want) * 1e-12);
};
const near = (a: readonly number[] | Float64Array, b: readonly number[], tol = 1e-4): void => {
  expect(a.length).toBe(b.length);
  Array.from(a).forEach((x, i) => {
    expect(Math.abs(x - (b[i] ?? NaN))).toBeLessThan(tol);
  });
};

interface BinFixture {
  name: string;
  values: string[];
  options: Pick<HistogramOptions, 'binMode' | 'binCount' | 'scale'> & { binWidth: number | null };
  edges: string[];
  counts: number[];
  widenedTo: string | null;
  adjusted: number | null;
  outOfRange: number;
  /** The edges come from the terminal log rule (10^(L ± 0.5)): compared at relative 1e-12. */
  terminalLog: boolean;
}
interface PixelFixture {
  name: string;
  width: number;
  scale: 'linear' | 'log';
  edgePx: string[];
  hits: [string, number][];
  brushes: [string, string, { first: number; last: number; from: string; to: string } | null][];
}
const FIX = JSON.parse(fixturesRaw) as { bins: BinFixture[]; pixels: PixelFixture[] };
const binFixture = (name: string): BinFixture => {
  const b = FIX.bins.find((x) => x.name === name);
  if (b === undefined) throw new Error(name);
  return b;
};
const fixtureFrame = (b: BinFixture): HistogramFrame =>
  frame([series({}, b.values.map(Number))], opt({ ...b.options }));

describe('unit:dist-bins', () => {
  describe('(F) bins from fixtures/histogram.json', () => {
    it.each(FIX.bins.map((b) => [b.name, b] as const))('%s', (_name, b) => {
      const f = fixtureFrame(b);
      const want = b.edges.map(Number);
      const k = want.length - 1;
      expect(f.edges.length).toBe(want.length);
      // Interior edges and terminal-log-rule edges at relative 1e-12; other end edges exact.
      if (!b.terminalLog) {
        expect(f.edges[0]).toBe(want[0]);
        expect(f.edges[k]).toBe(want[k]);
      }
      for (let i = 0; i <= k; i++) nearRel(f.edges[i] ?? NaN, want[i] ?? NaN);
      expect(panelCounts(f)).toEqual(b.counts);
      expect(f.coverage.widenedTo).toBe(b.widenedTo === null ? null : Number(b.widenedTo));
      expect(f.coverage.adjusted).toBe(b.adjusted);
      expect(f.coverage.outOfRange).toBe(b.outOfRange);
      for (let i = 1; i <= k; i++) expect(f.edges[i] ?? NaN).toBeGreaterThan(f.edges[i - 1] ?? NaN);
      expect(panelCounts(f).reduce((a, c) => a + c, 0)).toBe(f.coverage.drawable);
    });

    it.each(FIX.pixels.map((p) => [p.name, p] as const))('%s pixels', (name, p) => {
      const f = fixtureFrame(binFixture(name));
      const l = binLayout(f, p.scale, 'stack', p.width, 100);
      const want = p.edgePx.map(Number);
      near(l.edgePx, want, 1e-6);
      expect(l.edgePx[0]).toBe(0);
      expect(l.edgePx[want.length - 1]).toBe(p.width);
      for (const [x, bin] of p.hits) expect(binAtPx(l.edgePx, Number(x))).toBe(bin);
      for (const [a, b, r] of p.brushes) {
        const got = brushBins(f, l, Number(a), Number(b));
        if (r === null) {
          expect(got).toBeNull();
          continue;
        }
        expect([got?.first, got?.last]).toEqual([r.first, r.last]);
        // Brush endpoints are the frame's own raw edges, and match the fixture at relative 1e-12
        // (log-axis edges are 10^x).
        expect(got?.from).toBe(f.edges[r.first]);
        expect(got?.to).toBe(f.edges[r.last + 1]);
        nearRel(got?.from ?? NaN, Number(r.from));
        nearRel(got?.to ?? NaN, Number(r.to));
      }
    });
  });

  it('H1 count bins and the panel CDF', () => {
    const f = frameOf(run([series({}, [1, 2, 2, 3, 4, 10])], count(3)));
    expect(Array.from(f.edges)).toEqual([1, 4, 6.999999999999999, 10]);
    expect(panelCounts(f)).toEqual([4, 1, 1]);
    near(cdf(f, null), [0.6667, 0.8333, 1]);
  });

  it('H1b edge labels and ranges', () => {
    const f = frame([series({}, [1, 2, 2, 3, 4, 10])], count(3));
    const labels = binLabels(f.edges, NONE);
    expect(labels).toEqual(['1', '4', '7', '10']);
    expect(binRangeText(f, labels, 1)).toBe('4 – 7');
    expect(binLabels(Float64Array.from([1, 1.0000000000000002]), NONE)).toEqual([
      '1',
      '1.0000000000000002',
    ]);
  });

  it('H1c unit labels at the domain bounds', () => {
    const wide = (unit: Unit): string[] =>
      binLabels(frame([series({}, [-1e290, 1e290])], opt({ unit })).edges, unit);
    expect(wide(NS)).toEqual(['-1e+281 s', '-5e+280 s', '0 s', '5e+280 s', '1e+281 s']);
    expect(binLabels(frame([series({}, [1e-290, 1e-289])], opt({ unit: NS })).edges, NS)).toEqual([
      '0 s',
      '2e-299 s',
      '4e-299 s',
      '6e-299 s',
      '8e-299 s',
      '1e-298 s',
    ]);
    expect(binLabels(Float64Array.from([ND, 1e290]), NS)).toEqual([
      '9.999999999999999e+280 s',
      '1e+281 s',
    ]);
    expect(wide(PU)).toEqual(['-1e+292 %', '-5e+291 %', '0 %', '5e+291 %', '1e+292 %']);
    expect(binLabels(Float64Array.from([ND, 1e290]), PU)).toEqual([
      '9.999999999999998e+291 %',
      '1e+292 %',
    ]);
  });

  it('H1d display-collapsed bin', () => {
    let f = frame([series({}, [1.4770205796360079, 1.477020579636008])], opt({ unit: PU }));
    expect(f.coverage.adjusted).toBe(1);
    expect(f.collapsed).toBe(true);
    expect(Array.from(f.edges)).toEqual([1.4770205796360079, 1.477020579636008]);
    expect(binLabels(f.edges, PU)).toEqual(['≈ 148 %']);
    expect(binRangeText(f, binLabels(f.edges, PU), 0)).toBe('≈ 148 %');
    f = frame([series({}, [247.05306063578868, 247.0530606357887])], opt({ unit: NS }));
    expect(f.collapsed).toBe(true);
    expect(binLabels(f.edges, NS)).toEqual(['≈ 247 ns']);
    f = frame([series({}, [247.05306063578868, 247.0530606357887, 300])], opt({ unit: NS }));
    expect(f.collapsed).toBe(false);
    expect(Array.from(f.edges)).toEqual([240, 260, 280, 300]);
    expect(binLabels(f.edges, NS)).toEqual(['240 ns', '260 ns', '280 ns', '300 ns']);
  });

  it('H3 the widened width in the meter', () => {
    const f = frame([series({}, [0, 1000])], opt({ binMode: 'width', binWidth: 1 }));
    expect(f.edges.length - 1).toBe(200);
    expect(histogramCoverageText(f.coverage, NONE)).toBe('bin width widened to 5 (200-bin cap)');
  });

  it('H5 log excludes per group and every CDF ends at 100 %', () => {
    const A = g('A', [0, 1, 10]);
    const B = g('B', [1, 100]);
    const f = frame([A, B], count(2, { scale: 'log', groupBy: 'g', groupMode: 'overlay' }));
    expect(Array.from(f.edges)).toEqual([1, 10, 100]);
    expect(f.groups.map((x) => x.name)).toEqual(['A', 'B']);
    expect(groupCounts(f, 0)).toEqual([1, 1]);
    expect(groupCounts(f, 1)).toEqual([1, 1]);
    const a = f.sourceGroups[0];
    expect([a?.received, a?.drawable, a?.nonPositive]).toEqual([3, 2, 1]);
    near(cdf(f, 0), [0.5, 1]);
    near(cdf(f, 1), [0.5, 1]);
    near(cdf(f, null), [0.5, 1]);
    expect(histogramCoverageText(f.coverage, NONE)).toBe('1 ≤ 0 not shown (log)');
    const l = binLayout(f, 'log', 'overlay', 400, 100);
    expect(binAtPx(l.edgePx, 139.79)).toBe(0);
    expect(brushBins(f, l, 0, 400)).toEqual({ first: 0, last: 1, from: 1, to: 100 });
    return binSeries(f, [0, 1], 1, 100, SL).then((keys) => {
      expect(keys).toEqual([A.key, B.key].sort());
      const labels = binLabels(f.edges, NONE);
      expect([binRangeText(f, labels, 0), binRangeText(f, labels, 1)]).toEqual([
        '1 – 10',
        '10 – 100',
      ]);
    });
  });

  it('H6 a zero-drawable group and a zero-drawable panel', () => {
    const f = frame([g('A', [1, 10]), g('C', [0])], opt({ scale: 'log', groupBy: 'g' }));
    expect(f.sourceGroups[sourceIndex(f, 'C')]?.drawnAs).toBe(-1);
    expect(f.groups.length).toBe(1);
    const r = run([g('A', [0, 0]), g('B', [0, Infinity])], opt({ scale: 'log', groupBy: 'g' }));
    expect(r.kind).toBe('noneShown');
    if (r.kind !== 'noneShown') return;
    expect(r.sourceGroups.map((s) => [s.name, s.nonPositive, s.infinite, s.drawnAs])).toEqual([
      ['A', 2, 0, -1],
      ['B', 1, 1, -1],
    ]);
    expect(noneShownText(r.coverage, NONE)).toBe(
      'No values shown: 3 ≤ 0 not shown (log) · 1 infinite values not shown',
    );
    expect(exclusionLines(r.sourceGroups, [])).toEqual(['A: 2 ≤ 0', 'B: 1 ≤ 0, 1 infinite']);
  });

  it('H6c exclusion precedence', () => {
    const f = frame(
      [g('A', [-1e-300, -1, 0, 1, 10, Infinity, 1e300])],
      opt({ scale: 'log', groupBy: 'g' }),
    );
    const c = f.coverage;
    expect([c.infinite, c.outOfRange, c.nonPositive, c.drawable]).toEqual([1, 2, 2, 2]);
    expect(histogramCoverageText(c, NONE)).toBe(
      '2 ≤ 0 not shown (log) · 1 infinite values not shown · 2 values out of range not shown',
    );
    expect(exclusionLines(f.sourceGroups, f.groups)).toEqual([
      'A: 2 ≤ 0, 1 infinite, 2 out of range',
    ]);
  });

  it('H7 non-finite samples and duplicate series', () => {
    const A = series({ s: 'a' }, [1, NaN, Infinity, 2], [0, 1, 2, 3]);
    const A2 = { ...series({ s: 'a' }, [5], [0]), labels: { s: 'a' } };
    const B = series({ s: 'b' }, [-Infinity, 3]);
    const f = frame([A, A2, B], opt());
    expect(Array.from(f.sorted.values)).toEqual([2, 3, 5]);
    expect(f.coverage.received).toBe(5);
    expect(histogramCoverageText(f.coverage, NONE)).toBe(
      '2 infinite values not shown · 1 duplicate series combined; 1 conflicts (max kept)',
    );
  });

  it('T22-003 conflicts: each conflicting timestamp once; instant only at the latest', () => {
    const at = (v: number, ts: number): SeriesFrame => series({ s: 'a' }, [v], [ts]);
    const cov = (input: SeriesFrame[], source: 'instant' | 'range') => {
      const f = frameOf(run(input, opt(), source));
      return [f.coverage.duplicates, f.coverage.conflicts, Array.from(f.sorted.values)];
    };
    // Three duplicates at one timestamp: one conflict, the max kept.
    expect(cov([at(1, 0), at(3, 0), at(2, 0)], 'instant')).toEqual([2, 1, [3]]);
    // An older tie superseded by a newer sample is no conflict, in any order.
    const older = [at(1, 0), at(2, 0), at(5, 1000)];
    for (const p of [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ])
      expect(
        cov(
          p.map((i) => older[i] as SeriesFrame),
          'instant',
        ),
      ).toEqual([2, 0, [5]]);
    // Range: a triple at ts 0 is one conflict; ts 1000 is not shared.
    const r = [
      series({ s: 'a' }, [1, 7], [0, 1000]),
      series({ s: 'a' }, [4], [0]),
      series({ s: 'a' }, [2], [0]),
    ];
    expect(cov(r, 'range')).toEqual([2, 1, [4, 7]]);
  });

  it('H8a empty, truncated, too many and the interim buckets notice', () => {
    const e = run([], opt());
    expect(e.kind).toBe('empty');
    if (e.kind === 'empty') expect(histogramCoverageText(e.coverage, NONE)).toBe('100 %');
    const tr = run([], opt(), 'range', { ...Q, truncated: true });
    if (tr.kind !== 'empty') throw new Error(tr.kind);
    expect(histogramCoverageText(tr.coverage, NONE)).toBe('truncated');
    const big = series({}, rep(2_000_001, 1));
    const m = run([big], opt());
    expect(m).toEqual({ kind: 'tooMany', samples: 2_000_001, query: Q });
    expect(t('hist.notice.tooMany', { n: formatValue(2_000_001, NONE) })).toBe(
      '2M samples exceed the 2 000 000-sample limit: narrow the query or the window',
    );
    const le1 = series({ le: '0.1' }, [3], [0]);
    const le2 = series({ le: '+Inf' }, [5], [5]);
    expect(run([le1, le2], opt(), 'instant')).toEqual({ kind: 'buckets', leSeries: 2, query: Q });
    expect(run([le1, g('x', [1]), g('y', [2])], opt())).toEqual({
      kind: 'buckets',
      leSeries: 1,
      query: Q,
    });
  });

  it('large counts read through formatValue', () => {
    const z = run([series({}, rep(2_000_000, 0))], opt({ scale: 'log' }));
    expect(z.kind).toBe('noneShown');
    if (z.kind !== 'noneShown') return;
    expect(histogramCoverageText(z.coverage, NONE)).toBe('2M ≤ 0 not shown (log)');
    const f = frame([series({}, rep(2_000_000, 1))], opt());
    expect(summaryFacts('P', f, NONE).current?.text).toMatch(/\(2M of 2M\)$/);
  });

  /** v1…v9 with drawable 10…2 (value i each) and one series without `version` (1). */
  function versions(first = 'v1'): SeriesFrame[] {
    const out: SeriesFrame[] = [];
    for (let i = 1; i <= 9; i++)
      out.push(series({ version: i === 1 ? first : `v${i}` }, rep(11 - i, i)));
    out.push(series({ other: 'x' }, [5]));
    return out;
  }

  it('H9, H10 the 7 largest groups and other (n)', () => {
    const f = frame(versions(), count(1, { groupBy: 'version' }));
    expect(f.groups.length).toBe(8);
    for (let j = 0; j < 7; j++) {
      const gr = f.groups[j];
      expect(gr?.name).toBe(`v${j + 1}`);
      expect(gr?.pattern).toBe(CATEGORY_PATTERNS[j]);
      expect(gr?.dash).toEqual(LINE_DASHES[j]);
      const v = `v${j + 1}`;
      expect(gr?.colourIndex).toBe(
        seriesColourIndex({ key: groupKey('version', v), labels: { version: v } }),
      );
    }
    const o = f.groups[7];
    expect(o?.key).toBe('other');
    expect(o?.name).toBe('other (3)');
    expect(o?.pattern).toBe('grid');
    expect(o?.dash).toEqual(OTHER_DASH);
    expect(o?.colourIndex).toBe(-1);
    expect(o?.drawable).toBe(6);
    expect(o?.members.map((m) => f.sourceGroups[m]?.drawable)).toEqual([3, 2, 1]);
    expect(o?.members.map((m) => f.sourceGroups[m]?.name)).toEqual(['v8', 'v9', 'version absent']);
    for (const m of o?.members ?? []) expect(f.sourceGroups[m]?.drawnAs).toBe(7);
    const q = frame(versions('other'), count(1, { groupBy: 'version' }));
    expect(q.groups[0]?.name).toBe('"other"');
    expect(q.sourceGroups.find((s) => s.labels['version'] === 'other')?.name).toBe('"other"');
  });

  it('H11 ECDF is exact', () => {
    const f = frame(
      [g('A', [1, 2, 2, 3]), g('B', [2, 4])],
      opt({ groupBy: 'g', groupMode: 'overlay' }),
    );
    const a = sourceIndex(f, 'A');
    const b = sourceIndex(f, 'B');
    expect([0.9, 1.5, 2, 3].map((x) => ecdfAt(f, [a], x))).toEqual([0, 0.25, 0.75, 1]);
    expect([2, 3.9, 4].map((x) => ecdfAt(f, [b], x))).toEqual([0.5, 0.5, 1]);
    expect(ecdfAt(f, [a, b], 2)).toBe(4 / 6);
  });

  it('H12 ECDF exact at 10⁶ values', () => {
    const rnd = mulberry32(208);
    const groups = ['a', 'b', 'c'].map((name, j) => ({
      name,
      values: Array.from({ length: 333_333 + j }, () => Math.round(rnd() * 1e6) / 100),
    }));
    const f = frame(
      groups.map((x) => g(x.name, x.values)),
      opt({ groupBy: 'g' }),
    );
    const sizes = groups.map((x) => x.values.length);
    expect(Array.from(f.sorted.offsets)).toEqual([
      0,
      sizes[0] ?? 0,
      (sizes[0] ?? 0) + (sizes[1] ?? 0),
      sizes.reduce((s, n) => s + n, 0),
    ]);
    const all = groups.flatMap((x) => x.values);
    for (let p = 0; p < 50; p++) {
      const x = p * 200 + 0.5 * (p % 3);
      groups.forEach((gr, j) => {
        const want = gr.values.filter((v) => v <= x).length / gr.values.length;
        expect(ecdfAt(f, [j], x)).toBe(want);
      });
      expect(ecdfAt(f, [0, 1, 2], x)).toBe(all.filter((v) => v <= x).length / all.length);
    }
  });

  it('H13 hit regions', () => {
    const f = frame([series({}, [1, 2, 2, 3, 4, 10])], count(3));
    const l = binLayout(f, 'linear', 'stack', 300, 100);
    expect(Array.from(l.top)).toEqual([0, 75, 75]);
    expect(hitTestBin(f, l, 150, 80)).toEqual({ index: 1, group: 0 });
    expect(hitTestBin(f, l, 150, 73)).toEqual({ index: 1, group: 0 });
    expect(hitTestBin(f, l, 150, 70)).toBeNull();
    expect(hitTestBin(f, l, 100, 90)).toEqual({ index: 1, group: 0 });
    expect(hitTestBin(f, l, -1, 90)).toBeNull();
    // A 1 px bar (top y 99) is at least 4 px tall, plus 3 px as the column's top segment.
    const thin = frame([series({}, [...rep(100, 0), 1])], count(2));
    const lt = binLayout(thin, 'linear', 'stack', 300, 100);
    expect(lt.top[1]).toBe(99);
    expect(hitTestBin(thin, lt, 225, 97)).toEqual({ index: 1, group: 0 });
    // Overlay: A top 40, B top 70 in bin 1.
    const ov = frame(
      [g('A', [...rep(100, 0), ...rep(60, 1)]), g('B', rep(30, 1))],
      count(2, { groupBy: 'g', groupMode: 'overlay' }),
    );
    const lo = binLayout(ov, 'linear', 'overlay', 100, 100);
    expect([lo.top[1], lo.top[3]]).toEqual([40, 70]);
    expect(hitTestBin(ov, lo, 75, 38)).toEqual({ index: 1, group: 0 });
    expect(hitTestBin(ov, lo, 75, 68)).toEqual({ index: 1, group: 1 });
    expect(hitTestBin(ov, lo, 75, 55)).toEqual({ index: 1, group: 0 });
    expect(hitTestBin(ov, lo, 75, 80)).toEqual({ index: 1, group: 1 });
    expect(hitTestBin(ov, lo, 75, 30)).toBeNull();
    const eq = frame(
      [g('A', [...rep(100, 0), ...rep(30, 1)]), g('B', rep(30, 1))],
      count(2, { groupBy: 'g', groupMode: 'overlay' }),
    );
    const le = binLayout(eq, 'linear', 'overlay', 100, 100);
    expect(hitTestBin(eq, le, 75, 70)).toEqual({ index: 1, group: 0 });
    expect(hitTestBin(eq, le, 75, 80)).toEqual({ index: 1, group: 0 });
  });

  it('H17b ECDF of other members', () => {
    const vs: SeriesFrame[] = [];
    for (let i = 1; i <= 7; i++) vs.push(g(`v${i}`, rep(11 - i, 3)));
    vs.push(g('v8', [1, 5]), g('v9', [2, 2, 9]));
    const f = frame(vs, count(2, { groupBy: 'g' }));
    expect(Array.from(f.edges)).toEqual([1, 5, 9]);
    const v8 = sourceIndex(f, 'v8');
    const v9 = sourceIndex(f, 'v9');
    expect(f.groups[7]?.members).toEqual([v8, v9]);
    expect([ecdfAt(f, [v8], 5), ecdfAt(f, [v8], 9)]).toEqual([1, 1]);
    expect([ecdfAt(f, [v9], 5), ecdfAt(f, [v9], 9)]).toEqual([2 / 3, 1]);
    expect(ecdfAt(f, [v8, v9], 5)).toBe(0.8);
  });

  it('H18b per-group exclusions, with and without other (n)', () => {
    const tail = [g('A', [0, 0, 1]), g('B', [0, Infinity, 2]), g('v9', [0, 3])];
    const big: SeriesFrame[] = [];
    for (let i = 1; i <= 7; i++) big.push(g(`v${i}`, rep(11 - i, 3)));
    const o = opt({ scale: 'log', groupBy: 'g' });
    const f = frame([...big, ...tail], o);
    expect(histogramCoverageText(f.coverage, NONE)).toBe(
      '4 ≤ 0 not shown (log) · 1 infinite values not shown',
    );
    expect(exclusionLines(f.sourceGroups, f.groups)).toEqual([
      'A (in other (3)): 2 ≤ 0',
      'B (in other (3)): 1 ≤ 0, 1 infinite',
      'v9 (in other (3)): 1 ≤ 0',
    ]);
    const s = frame(tail, o);
    expect(exclusionLines(s.sourceGroups, s.groups)).toEqual([
      'A: 2 ≤ 0',
      'B: 1 ≤ 0, 1 infinite',
      'v9: 1 ≤ 0',
    ]);
  });

  it('H24 the out-of-range meter part', () => {
    const f = fixtureFrame(binFixture('H24k'));
    expect(histogramCoverageText(f.coverage, NONE)).toBe('2 values out of range not shown');
  });

  describe('H21 empty series', () => {
    afterEach(() => {
      disposeHistogram('p');
      setHistogramEnv(null);
    });

    it('(c) an empty series keeps its source group', async () => {
      const kit = fakeHistogramKit();
      setHistogramEnv(kit.env);
      const B = g('B', []);
      const r = await runHistogram(
        'p',
        1,
        [g('A', [1, 2]), B],
        'range',
        opt({ groupBy: 'g' }),
        Q,
        new AbortController().signal,
      );
      const entries = kit.posts.flatMap((p) => p.m.batch);
      const e = entries.find((x) => x.key === B.key);
      expect(e?.values.length).toBe(0);
      expect(e?.cont).toBe(false);
      const f = frameOf(r);
      const b = f.sourceGroups[sourceIndex(f, 'B')];
      expect([b?.received, b?.drawable, b?.drawnAs]).toEqual([0, 0, -1]);
    });

    it('(d) an empty duplicate counts as a duplicate series', () => {
      const A = g('A', [1, 2]);
      const f = frame(
        [A, { ...A, timestamps: new Float64Array(0), values: new Float64Array(0) }],
        opt(),
      );
      expect([f.coverage.duplicates, f.coverage.conflicts, f.coverage.drawable]).toEqual([1, 0, 2]);
    });

    it('(e) 2 000 empty series are posted in timed batches', async () => {
      let clock = 0;
      const kit = fakeHistogramKit({ clock: () => (clock += 0.01) });
      setHistogramEnv(kit.env);
      const input = [...Array.from({ length: 2000 }, (_, i) => g(`e${i}`, [])), g('A', [1])];
      const r = await settle(
        runHistogram(
          'p',
          1,
          input,
          'range',
          opt({ groupBy: 'g' }),
          Q,
          new AbortController().signal,
        ),
      );
      const partial = kit.posts.filter((p) => !p.m.last).length;
      expect(partial).toBeGreaterThanOrEqual(2);
      expect(kit.posts.filter((p) => p.m.last).length).toBe(1);
      expect(kit.log.at(-1)).toBe('post:last');
      for (let i = 0; i < kit.log.length - 1; i++)
        if (kit.log[i] === 'post') expect(kit.log[i + 1]).toBe('yield');
      expect(kit.log.filter((x) => x === 'yield').length).toBe(partial);
      expect(kit.posts.reduce((n, p) => n + p.m.batch.length, 0)).toBe(2001);
      if (!r.ok) throw r.error;
      expect(frameOf(r.value).coverage.drawable).toBe(1);
    });
  });

  it('frame validity', () => {
    const fs = [
      frame([series({}, [1, 2, 2, 3, 4, 10])], count(3)),
      frame([g('A', [0, 1, 10]), g('B', [1, 100])], count(2, { scale: 'log', groupBy: 'g' })),
      frame(versions(), count(1, { groupBy: 'version' })),
    ];
    for (const f of fs) expect(histogramFrameValid(f)).toBe(true);
    const f = fs[1];
    if (f === undefined) return;
    const offsets = Uint32Array.from(f.contrib.offsets);
    offsets[1] = 99;
    expect(histogramFrameValid({ ...f, contrib: { ...f.contrib, offsets } })).toBe(false);
    const counts = Float64Array.from(f.counts);
    counts[0] = -1;
    expect(histogramFrameValid({ ...f, counts })).toBe(false);
  });
});

describe('unit:summary-facts', () => {
  it('H18 summary facts use exact quantiles', () => {
    const f = frame([series({}, [1, 2, 2, 3, 4, 10])], count(3));
    expect(summaryFacts('Latency', f, NONE)).toEqual({
      subject: 'Latency',
      current: { text: 'median 2.5; mode 1 – 4 (4 of 6)', series: 'Latency' },
      change: null,
      extent: { min: 1, max: 10 },
      baselineRatio: null,
    });
    const h = frame([series({}, [1, 3.9, 3.9, 3.9, 4, 10])], count(3));
    expect(panelCounts(h)).toEqual([4, 1, 1]);
    expect(summaryFacts('Latency', h, NONE).current?.text).toMatch(/^median 3\.9;/);
  });
});

describe('unit:selection-draw', () => {
  it('H16 a selection from another panel', async () => {
    const A = series({ s: 'a' }, [1, 2, 2]);
    const B = series({ s: 'b' }, [3, 4, 10]);
    const f = frame([A, B], count(3));
    expect(Array.from((await selectedCounts(f, new Set([A.key]), SL)) ?? [])).toEqual([3, 0, 0]);
    expect(Array.from((await selectedCounts(f, new Set([B.key]), SL)) ?? [])).toEqual([1, 1, 1]);
    expect(await selectedCounts(f, new Set(['ffffffffffffffff']), SL)).toBeNull();
  });
});
