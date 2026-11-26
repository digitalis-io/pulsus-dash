/**
 * `e2e:shim-fuzz` (plan #68 C2a1 §3.5, §5; T03 §10, T05 §7.1) in the `probe` project: the probe
 * build (fault build with the `probe` engine feature) on lavapipe. Two probe frames with the
 * gallery's `line-50` data take 10⁴ seeded ops (resize, time window, spec), the first batch before
 * the worker reports them created; the worker's decoded log (`engine_probe_input`) must equal the
 * adapter's produced log, record for record. Then the counters across 2³² (`ringStart`) and the
 * wake-up of an idle worker by one record.
 */
import { expect, test, type Page } from '@playwright/test';
import { galleryEntries } from '../src/dev/gallery.ts';
import { GALLERY_FROM, GALLERY_TO, GALLERY_URL, open } from './helpers.ts';

/** The gallery loads the chart engine module (and so the probe); its own frames stay idle. */
const PROBE_URL = `${GALLERY_URL}&engine=wasm&mode=t2&probe=1`;
const HOUR = 3_600_000;

interface Probe {
  frame(o: unknown): Promise<number>;
  call(n: number, m: string, arg: unknown): void;
  settle(n: number): Promise<void>;
  last(n: number): { fromMs: number; toMs: number } | null;
  drawn(n: number): { cssWidth: number; cssHeight: number; dpr: number }[];
  idle(): boolean;
  inputLog(): Promise<unknown[]>;
  producedLog(): unknown[];
  stats(): { coalesced: number; overflow: number; publishedBytes: number };
  counters(): { head: number; tail: number };
}

/** The gallery's `line-50` series as plain arrays. */
function line50(): { key: string; t: number[]; v: number[] }[] {
  const e = galleryEntries({ fromMs: GALLERY_FROM, toMs: GALLERY_TO }).find(
    (x) => x.id === 'line-50',
  );
  if (e?.data.kind !== 'series') throw new Error('no line-50');
  return e.data.series.map((s) => ({ key: s.key, t: [...s.timestamps], v: [...s.values] }));
}

const SPEC = { kind: 'line', title: '50 series', unit: { kind: 'time', base: 'ms' } };

type Op =
  | { n: number; m: 'resize'; arg: [number, number, number] }
  | { n: number; m: 'setTimeWindow'; arg: { fromMs: number; toMs: number } }
  | { n: number; m: 'setSpec'; arg: unknown };

/** mulberry32. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** `count` seeded ops in batches of 1–2 000; half the batches end with an animation frame wait. */
function ops(seed: number, count: number): { batch: Op[]; wait: boolean }[] {
  const r = rng(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
  const noon = GALLERY_FROM;
  const out: { batch: Op[]; wait: boolean }[] = [];
  let made = 0;
  while (made < count) {
    const size = Math.min(count - made, int(1, 2000));
    const batch: Op[] = [];
    for (let i = 0; i < size; i++) {
      const n = int(0, 1);
      const k = r();
      if (k < 0.4) {
        const dpr = [1, 1.25, 2][int(0, 2)] ?? 1;
        batch.push({ n, m: 'resize', arg: [int(50, 2000), int(50, 2000), dpr] });
      } else if (k < 0.9) {
        const width = 1000 + r() * (24 * HOUR - 1000);
        const from = noon + (r() * 2 - 1) * 6 * HOUR;
        batch.push({ n, m: 'setTimeWindow', arg: { fromMs: from, toMs: from + width } });
      } else {
        const pin = r() < 0.5;
        batch.push({
          n,
          m: 'setSpec',
          arg: pin ? { ...SPEC, valueRange: { min: 0, max: int(100, 900) } } : SPEC,
        });
      }
    }
    made += size;
    out.push({ batch, wait: r() < 0.5 });
  }
  return out;
}

async function probeReady(page: Page, query = ''): Promise<void> {
  await open(page, `${PROBE_URL}${query}`);
  await page.waitForFunction(() => '__dashProbe' in window);
}

/**
 * Runs the batches in the page: frames 0 and 1 are made first and the first batch goes at once,
 * before the worker reports them created; the rest follow their first summary.
 */
async function run(
  page: Page,
  batches: { batch: Op[]; wait: boolean }[],
  final: Op[],
): Promise<void> {
  const series = line50();
  await page.evaluate(
    async ({ batches, final, series, spec, from, to }) => {
      const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
      const raf = (): Promise<void> =>
        new Promise((r) => {
          requestAnimationFrame(() => {
            r();
          });
        });
      const made = [0, 1].map(() =>
        p.frame({ spec, series, w: { fromMs: from, toMs: to }, size: [600, 300], dpr: 1 }),
      );
      // The first batch before the worker has created the frames (held), the rest after.
      const [first, ...rest] = batches;
      for (const o of first?.batch ?? []) p.call(o.n, o.m, o.arg);
      await Promise.all(made);
      for (const { batch, wait } of rest) {
        for (const o of batch) p.call(o.n, o.m, o.arg);
        if (wait) await raf();
      }
      for (const o of final) p.call(o.n, o.m, o.arg);
      await Promise.all([p.settle(0), p.settle(1)]);
    },
    { batches, final, series, spec: SPEC, from: GALLERY_FROM, to: GALLERY_TO },
  );
}

/** Both logs, and the probe's stats. */
async function logs(page: Page) {
  return page.evaluate(async () => {
    const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
    return {
      decoded: await p.inputLog(),
      produced: p.producedLog(),
      stats: p.stats(),
      counters: p.counters(),
      last: [p.last(0), p.last(1)],
      drawn: [p.drawn(0).at(-1), p.drawn(1).at(-1)],
    };
  });
}

/** The last op of each kind per frame, as the frame should show it. */
function finalOps(): Op[] {
  return [0, 1].flatMap((n): Op[] => [
    { n, m: 'resize', arg: [640 + n, 320, 1] },
    { n, m: 'setTimeWindow', arg: { fromMs: GALLERY_FROM + n * 1000, toMs: GALLERY_TO } },
  ]);
}

test.describe('e2e:shim-fuzz', () => {
  test('10⁴ ops: the worker decodes exactly the records the adapter wrote', async ({ page }) => {
    test.setTimeout(300_000);
    await probeReady(page);
    const final = finalOps();
    await run(page, ops(68, 10_000), final);
    const r = await logs(page);
    expect(r.decoded.length).toBe(r.produced.length);
    expect(r.decoded).toEqual(r.produced);
    expect(r.stats.coalesced).toBeGreaterThan(0);
    expect(r.stats.overflow).toBe(0);
    // More than one ring's worth went through it.
    expect(r.stats.publishedBytes).toBeGreaterThan(0x10000);
    for (const n of [0, 1]) {
      expect(r.last[n]).toMatchObject({ fromMs: GALLERY_FROM + n * 1000, toMs: GALLERY_TO });
      expect(r.drawn[n]).toEqual({ cssWidth: 640 + n, cssHeight: 320, dpr: 1 });
    }
  });

  test('rollover: the counters cross 2³² and the logs still match', async ({ page }) => {
    test.setTimeout(180_000);
    const start = 0xffff_f000;
    await probeReady(page, `&ringStart=${String(start)}`);
    await run(page, ops(69, 2000), finalOps());
    const r = await logs(page);
    const b = r.stats.publishedBytes;
    expect(b).toBeGreaterThan(0x1000);
    expect((r.counters.head - start) >>> 0).toBe(b);
    expect(r.counters.head).toBeLessThan(start);
    expect(r.decoded).toEqual(r.produced);
  });

  test('wake: one record wakes an idle worker', async ({ page }) => {
    test.setTimeout(120_000);
    await probeReady(page);
    await run(page, [], finalOps());
    await page.waitForFunction(() =>
      (window as unknown as { __dashProbe: Probe }).__dashProbe.idle(),
    );
    const r = await page.evaluate(async (from) => {
      const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
      const before = p.producedLog().length;
      const t0 = performance.now();
      const w = { fromMs: from + 5000, toMs: from + 65_000 };
      p.call(0, 'setTimeWindow', w);
      await p.settle(0);
      return {
        ms: performance.now() - t0,
        published: p.producedLog().length - before,
        last: p.last(0),
        decoded: (await p.inputLog()).length,
        produced: p.producedLog().length,
      };
    }, GALLERY_FROM);
    expect(r.ms).toBeLessThan(1000);
    expect(r.published).toBe(1);
    expect(r.last).toMatchObject({ fromMs: GALLERY_FROM + 5000, toMs: GALLERY_FROM + 65_000 });
    expect(r.decoded).toBe(r.produced);
  });
});
