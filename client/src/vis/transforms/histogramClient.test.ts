// unit:hist-worker (plan #208 Part 1 §5; T21-016, PRF-005): the main-thread protocol of
// runHistogram against a fake worker, and the time-sliced CSR scans.
import { afterEach, describe, expect, it } from 'vitest';
import type { Completeness } from '../../data/decode';
import type { HistogramFrame, SeriesFrame } from '../../data/frames';
import { keyHash } from '../../dev/keyHash';
import type { Unit } from '../../i18n/format';
import { fakeHistogramKit, settle } from '../../test/fakeHistogramWorker';
import { histogram, selectedCounts, type HistogramOptions } from './histogram';
import { resultTransfer } from './histogram.worker';
import { disposeHistogram, runHistogram, setHistogramEnv } from './histogramClient';

const NONE: Unit = { kind: 'none' };
const Q: Completeness = {
  truncated: false,
  warnings: [],
  infos: [],
  queryId: null,
  dataAgeMs: null,
  readCache: null,
  readCacheThroughMs: null,
};
const O: HistogramOptions = {
  binMode: 'auto',
  binCount: 20,
  binWidth: null,
  scale: 'linear',
  groupBy: null,
  groupMode: 'stack',
  cumulative: 'none',
  unit: NONE,
};

function series(name: string, n: number, f: (i: number) => number = (i) => i % 97): SeriesFrame {
  const labels = { s: name };
  return {
    key: keyHash(labels),
    labels,
    timestamps: Float64Array.from({ length: n }, (_, i) => i * 1000),
    values: Float64Array.from({ length: n }, (_, i) => f(i)),
  };
}
const SMALL = [series('a', 3), series('b', 2)];
const signal = (): AbortSignal => new AbortController().signal;
const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

afterEach(() => {
  disposeHistogram('p');
  setHistogramEnv(null);
});

describe('unit:hist-worker', () => {
  it('H21 stale runs are dropped', async () => {
    const kit = fakeHistogramKit();
    setHistogramEnv(kit.env);
    const r1 = settle(runHistogram('p', 1, SMALL, 'range', O, Q, signal()));
    const r2 = settle(runHistogram('p', 2, SMALL, 'range', O, Q, signal()));
    const [a, b] = await Promise.all([r1, r2]);
    expect(!a.ok && isAbort(a.error)).toBe(true);
    expect(kit.workers[0]?.terminated).toBe(true);
    expect(b.ok && b.value.kind).toBe('frame');
    // A late R1 reply, on either worker, changes nothing.
    const late = { runId: 1, result: { kind: 'empty' as const, coverage: null as never } };
    expect(() => kit.workers[0]?.deliver(late)).not.toThrow();
    expect(() => kit.workers[1]?.deliver(late)).not.toThrow();
    // The idle worker is reused by the next run.
    const r3 = await runHistogram('p', 3, SMALL, 'range', O, Q, signal());
    expect(r3.kind).toBe('frame');
    expect(kit.workers.length).toBe(2);
  });

  it('H21 early notices supersede a pending run without a worker', async () => {
    const early: [string, SeriesFrame[], string][] = [
      ['le', [{ ...series('x', 1), labels: { le: '0.1' } }], 'buckets'],
      ['tooMany', [series('big', 2_000_001, () => 1)], 'tooMany'],
      ['empty', [], 'empty'],
    ];
    for (const [, input, kind] of early) {
      const kit = fakeHistogramKit();
      setHistogramEnv(kit.env);
      const r1 = settle(runHistogram('p', 1, SMALL, 'range', O, Q, signal()));
      const r2 = await runHistogram('p', 2, input, 'range', O, Q, signal());
      const a = await r1;
      expect(!a.ok && isAbort(a.error)).toBe(true);
      expect(kit.workers.length).toBe(1);
      expect(kit.workers[0]?.terminated).toBe(true);
      expect(r2.kind).toBe(kind);
      // R1's reply arrives after: R2 stays as it was.
      await Promise.resolve();
      expect(r2.kind).toBe(kind);
      disposeHistogram('p');
    }
  });

  describe('H21 batches', () => {
    const cases: [string, SeriesFrame[], number][] = [
      [
        '(a) 2 000 series × 1 000',
        Array.from({ length: 2000 }, (_, i) => series(`s${i}`, 1000)),
        2000,
      ],
      ['(b) 1 series × 2 000 000', [series('one', 2_000_000)], 80],
    ];
    it.each(cases)('%s', async (_name, input, entries) => {
      const kit = fakeHistogramKit({ clock: (k) => k.copiedTotal / 25_000 });
      setHistogramEnv(kit.env);
      const r = await runHistogram('p', 1, input, 'range', O, Q, signal());
      expect(kit.posts.length).toBe(10);
      for (const [i, p] of kit.posts.entries()) {
        expect(p.m.batch.reduce((n, e) => n + e.values.length, 0)).toBe(200_000);
        expect(p.m.last).toBe(i === 9);
      }
      expect(kit.log).toEqual([
        ...Array.from({ length: 9 }, () => ['post', 'yield']).flat(),
        'post:last',
      ]);
      const all = kit.posts.flatMap((p) => p.m.batch);
      expect(all.length).toBe(entries);
      if (entries === 80) expect(all.map((e) => e.cont)).toEqual(all.map((_, i) => i > 0));
      expect(r).toEqual(histogram(input, 'range', O, Q));
      if (r.kind !== 'frame') throw new Error(r.kind);
      const f = r.frame;
      const buffers = resultTransfer(r);
      for (const a of [
        f.edges,
        f.counts,
        f.contrib.offsets,
        f.contrib.bins,
        f.contrib.counts,
        f.sorted.values,
        f.sorted.offsets,
      ])
        expect(buffers).toContain(a.buffer);
    });
  });

  it('H21 abort while copying', async () => {
    const ac = new AbortController();
    const kit = fakeHistogramKit({
      clock: (k) => k.copiedTotal / 25_000,
      onYield: (k) => {
        if (k.posts.length === 2) ac.abort();
      },
    });
    setHistogramEnv(kit.env);
    const input = Array.from({ length: 2000 }, (_, i) => series(`s${i}`, 1000));
    const r = await settle(runHistogram('p', 1, input, 'range', O, Q, ac.signal));
    expect(!r.ok && isAbort(r.error)).toBe(true);
    expect(kit.workers[0]?.terminated).toBe(true);
    await Promise.resolve();
    expect(kit.posts.length).toBe(2);
  });

  it('H21 dispose and errors', async () => {
    const kit = fakeHistogramKit();
    setHistogramEnv(kit.env);
    const r1 = settle(runHistogram('p', 1, SMALL, 'range', O, Q, signal()));
    disposeHistogram('p');
    const a = await r1;
    expect(!a.ok && isAbort(a.error)).toBe(true);
    expect(kit.workers[0]?.terminated).toBe(true);
    for (const mode of ['errorEvent', 'errorReply'] as const) {
      kit.mode = mode;
      const before = kit.workers.length;
      const r = await settle(runHistogram('p', 2, SMALL, 'range', O, Q, signal()));
      expect(!r.ok && r.error instanceof Error && !isAbort(r.error)).toBe(true);
      expect(kit.workers.length).toBe(before + 1);
      expect(kit.workers.at(-1)?.terminated).toBe(true);
    }
    kit.mode = 'reply';
    const ok = await runHistogram('p', 3, SMALL, 'range', O, Q, signal());
    expect(ok.kind).toBe('frame');
    expect(kit.workers.length).toBe(4);
  });

  it('H21 sliced scans over 2·10⁶ CSR entries', async () => {
    const f = csrFrame(10_000, 200);
    const keys = new Set(f.series.filter((_, i) => i % 2 === 0).map((s) => s.key));
    const want = new Float64Array(200);
    f.series.forEach((s, i) => {
      if (!keys.has(s.key)) return;
      for (let e = f.contrib.offsets[i] ?? 0; e < (f.contrib.offsets[i + 1] ?? 0); e++)
        want[f.contrib.bins[e] ?? 0] =
          (want[f.contrib.bins[e] ?? 0] ?? 0) + (f.contrib.counts[e] ?? 0);
    });
    let t = 0;
    let yields = 0;
    const s = {
      now: () => (t += 0.1),
      signal: signal(),
      yieldNow: () => {
        yields += 1;
        return Promise.resolve();
      },
    };
    expect(await selectedCounts(f, keys, s)).toEqual(want);
    expect(yields).toBeGreaterThanOrEqual(2);
    // A newer selection aborts the running scan.
    const old = new AbortController();
    let newer: Promise<Float64Array | null> | null = null;
    const first = settle(
      selectedCounts(f, keys, {
        now: () => (t += 0.1),
        signal: old.signal,
        yieldNow: () => {
          if (newer === null) {
            old.abort();
            newer = selectedCounts(f, keys, {
              now: () => (t += 0.1),
              signal: signal(),
              yieldNow: () => Promise.resolve(),
            });
          }
          return Promise.resolve();
        },
      }),
    );
    const r = await first;
    expect(!r.ok && isAbort(r.error)).toBe(true);
    expect(newer).not.toBeNull();
    expect(await (newer as unknown as Promise<Float64Array | null>)).toEqual(want);
  });
});

/** A one-group frame with `n` series, each with one count in each of `k` bins. */
function csrFrame(n: number, k: number): HistogramFrame {
  const offsets = Uint32Array.from({ length: n + 1 }, (_, i) => i * k);
  const bins = Uint16Array.from({ length: n * k }, (_, e) => e % k);
  const counts = new Float64Array(n * k).fill(1);
  const edges = Float64Array.from({ length: k + 1 }, (_, i) => i);
  return {
    edges,
    sourceGroups: [
      {
        key: 'all',
        name: 'all values',
        labels: {},
        received: n * k,
        drawable: n * k,
        nonPositive: 0,
        infinite: 0,
        outOfRange: 0,
        drawnAs: 0,
      },
    ],
    groups: [
      {
        key: 'all',
        name: 'all values',
        colourIndex: 0,
        pattern: 'solid',
        dash: [],
        members: [0],
        drawable: n * k,
      },
    ],
    counts: new Float64Array(k).fill(n),
    series: Array.from({ length: n }, (_, i) => ({
      key: i.toString(16).padStart(16, '0'),
      name: `{i="${i}"}`,
      labels: { i: String(i) },
      sourceGroup: 0,
    })),
    contrib: { offsets, bins, counts },
    sorted: { values: new Float64Array(0), offsets: Uint32Array.from([0, 0]) },
    quantiles: null,
    countBasis: 'samples',
    collapsed: false,
    coverage: {
      query: Q,
      received: n * k,
      drawable: n * k,
      nonPositive: 0,
      infinite: 0,
      outOfRange: 0,
      duplicates: 0,
      conflicts: 0,
      widenedTo: null,
      adjusted: null,
    },
  };
}
