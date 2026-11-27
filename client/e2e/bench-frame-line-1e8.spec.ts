/**
 * `bench:frame-line-1e8` (plan #68 C2d1 §4.2, §4.3; T05 §4.3; PRF-016, PRF-001, PRF-002; report
 * only), in the probe build (`__dashProbe`, project `bench`, lavapipe WebGL2): a 1118×240 probe
 * line frame gets `pulsus-synth`'s F1c (1 000 series × 10⁵ grid points) built in the worker
 * (`synth`, `Frames::set_chunk`), its window the grid's extent, then four cases: `1e8` (`SCRIPT`),
 * `1e8-selected` (series 7 selected, m = 1), `1e8-selected-500` (m = 500, #264) and `1e8-hover`
 * (`HOVER`). If the 10⁸ synthesis fails (memory), each case is recorded `skipped: 'memory'`, the
 * page reloads (a fresh worker) and the cases run at 10⁷ (1 000 × 10⁴) as `1e7-…`.
 *
 * A second, small probe frame redraws on a timer throughout, so the frame-id filter is exercised:
 * a `drive` of the idle bench frame (no steps) must collect no frame while the other one draws.
 * B3 checks `synth`'s acknowledgements: two equal ones, then `ok: false` for an impossible size,
 * after which the frame still shows the earlier chunk.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { FrameSummary, HoverEvent, VisSpec } from '../src/engine/api.ts';
import { summarise, type BenchResult } from '../scripts/lib/benchStats.ts';
import {
  drive,
  HOVER,
  readResults,
  report,
  reportGaps,
  SCRIPT,
  type Step,
} from './bench/frameBench.ts';
import { GALLERY_URL, waitReady } from './helpers.ts';

const GATE = 'bench:frame-line-1e8';
const PROBE_URL = `${GALLERY_URL}&engine=wasm&mode=t2&probe=1`;
const LINE: VisSpec = { kind: 'line', title: 'F1c', unit: { kind: 'none' } };
/** `pulsus_synth::reference::WINDOW`: the grid's extent. */
const EXTENT = { fromMs: 0, toMs: 1_000_000 };
const SIZE: [number, number] = [1118, 240];
const BENCH = '[data-bench="bench"]';
const NOISE = '[data-bench="noise"]';
const MIN_FRAMES = 100;
const MIN_HOVER_SHARE = 0.9;
/** An allocation the worker cannot make (16 GB of values, within `MAX_SAMPLES`). */
const IMPOSSIBLE = { series: 20_000, points: 100_000 };

interface Probe {
  frame(o: unknown): Promise<number>;
  call(n: number, m: string, arg: unknown): void;
  settle(n: number): Promise<void>;
  last(n: number): FrameSummary | null;
  drawn(n: number): unknown[];
  hovers(n: number): (HoverEvent | null)[];
  synth(n: number, o: { series: number; points: number }): Promise<{ ok: boolean; bytes: number }>;
}

const key = (s: number): string => s.toString(16).padStart(16, '0');

async function probePage(page: Page): Promise<string[]> {
  const failures: string[] = [];
  page.on('console', (m) => {
    if (/probe-\d+ failed:/.test(m.text())) failures.push(m.text());
  });
  // No fake clock: it hides the User Timing entries the harness collects.
  await page.goto(PROBE_URL);
  await waitReady(page, PROBE_URL);
  await page.waitForFunction(() => '__dashProbe' in window);
  return failures;
}

/**
 * The bench frame (probe frame 0, canvas `data-bench="bench"`) and the noise frame (1, redrawn
 * every 100 ms), then `synth(0, …)`; the acknowledgement.
 */
async function setup(
  page: Page,
  o: { series: number; points: number },
): Promise<{ ok: boolean; bytes: number }> {
  return page.evaluate(
    async ({ spec, extent, size, o }) => {
      const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
      const seed = [{ key: '00000000000000aa', t: [extent.fromMs, extent.toMs], v: [0, 1] }];
      const n = await p.frame({ spec, series: seed, w: extent, size, dpr: 1 });
      const m = await p.frame({
        spec,
        series: seed,
        w: extent,
        size: [300, 120],
        dpr: 1,
        top: 300,
      });
      const canvases = document.querySelectorAll<HTMLCanvasElement>('body > canvas');
      canvases[0]?.setAttribute('data-bench', 'bench');
      canvases[1]?.setAttribute('data-bench', 'noise');
      let flip = false;
      setInterval(() => {
        flip = !flip;
        p.call(m, 'setTimeWindow', {
          fromMs: extent.fromMs + (flip ? 1000 : 0),
          toMs: extent.toMs,
        });
      }, 100);
      const ack = await p.synth(n, o);
      // The chunk is not a ring record (`settle` does not see it): its summary is.
      const t0 = performance.now();
      while (ack.ok && p.last(n)?.seriesTotal !== o.series && performance.now() - t0 < 300_000)
        await new Promise((r) => setTimeout(r, 50));
      await p.settle(n);
      const plot = p.last(n)?.plot;
      if (plot !== undefined) {
        canvases[0]?.setAttribute('data-plot', [plot.x, plot.y, plot.width, plot.height].join(','));
      }
      return ack;
    },
    { spec: LINE, extent: EXTENT, size: SIZE, o },
  );
}

/** The bench frame back on the extent with `keys` selected, settled; its window and hovers. */
async function prepare(
  page: Page,
  keys: string[] | null,
): Promise<{ w: [number, number]; hovers: number }> {
  return page.evaluate(
    async ({ keys, extent }) => {
      const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
      p.call(0, 'setSelection', keys === null ? null : { keys, fromMs: null, toMs: null });
      p.call(0, 'setTimeWindow', extent);
      await p.settle(0);
      // The selection is a message, not a ring record: wait until the frame stops presenting.
      const t0 = performance.now();
      let seen = p.drawn(0).at(-1);
      let still = performance.now();
      while (performance.now() - still < 500 && performance.now() - t0 < 60_000) {
        await new Promise((r) => setTimeout(r, 50));
        const now = p.drawn(0).at(-1);
        if (now !== seen) {
          seen = now;
          still = performance.now();
        }
      }
      const s = p.last(0);
      return {
        w: [s?.fromMs ?? NaN, s?.toMs ?? NaN] as [number, number],
        hovers: p.hovers(0).length,
      };
    },
    { keys, extent: EXTENT },
  );
}

async function after(
  page: Page,
): Promise<{ w: [number, number]; hovers: number; status: string | null }> {
  return page.evaluate(() => {
    const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
    const s = p.last(0);
    return {
      w: [s?.fromMs ?? NaN, s?.toMs ?? NaN] as [number, number],
      hovers: p.hovers(0).length,
      status: document.documentElement.getAttribute('data-dash-status'),
    };
  });
}

const CASES: readonly { name: string; keys: string[] | null; steps: readonly Step[] }[] = [
  { name: '', keys: null, steps: SCRIPT },
  { name: '-selected', keys: [key(7)], steps: SCRIPT },
  { name: '-selected-500', keys: Array.from({ length: 500 }, (_, i) => key(i)), steps: SCRIPT },
  { name: '-hover', keys: null, steps: HOVER },
];

interface Checked {
  result: BenchResult;
  moved: boolean;
  hovers: number;
  status: string | null;
  failures: string[];
}

/** One scale: setup, the idle filter check, then the four cases. Null: the synthesis failed. */
async function scale(
  page: Page,
  failures: string[],
  tag: '1e8' | '1e7',
  o: { series: number; points: number },
  mustSynth: boolean,
): Promise<Checked[] | null> {
  const ack = await setup(page, o);
  if (!ack.ok) {
    if (!mustSynth) return null;
    expect.soft(ack.ok, `${tag}: synth`).toBe(true);
  }
  // The frame-id filter: the idle bench frame presents nothing while the noise frame draws.
  const idle = await drive(page, BENCH, 'probe-0', []);
  const noise = await drive(page, NOISE, 'probe-1', []);
  expect.soft(noise.presents.length, `${tag}: the noise frame draws`).toBeGreaterThan(0);
  expect.soft(idle.presents.length, `${tag}: the idle bench frame collects no frame`).toBe(0);
  const out: Checked[] = [];
  for (const c of CASES) {
    const before = await prepare(page, c.keys);
    const d = await drive(page, BENCH, 'probe-0', c.steps);
    const a = await after(page);
    out.push({
      result: summarise(
        {
          gate: GATE,
          case: `${tag}${c.name}`,
          leg: 'wasm-webgl2',
          points: o.series * o.points,
          series: o.series,
        },
        d.presents,
        d.draws,
        d.span,
      ),
      moved: before.w[0] !== a.w[0] || before.w[1] !== a.w[1],
      hovers: a.hovers - before.hovers,
      status: a.status,
      failures: [...failures],
    });
  }
  return out;
}

function sanity(c: Checked): void {
  const what = c.result.case;
  expect.soft(c.failures, `${what}: no failed frame`).toEqual([]);
  expect.soft(c.status, `${what}: no fatal`).not.toBe('4');
  expect.soft(c.result.frames, `${what}: frames`).toBeGreaterThanOrEqual(MIN_FRAMES);
  if (what.endsWith('-hover')) {
    expect
      .soft(c.hovers, `${what}: a hover on ≥ 90 % of the steps`)
      .toBeGreaterThanOrEqual(Math.ceil(MIN_HOVER_SHARE * HOVER.length));
  } else {
    expect.soft(c.moved, `${what}: the window moved`).toBe(true);
  }
}

test.describe(GATE, () => {
  test('bench:frame-line-1e8 B3: synth acknowledgements, and an impossible size changes nothing', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const failures = await probePage(page);
    const r = await page.evaluate(
      async ({ spec, extent, impossible }) => {
        const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
        const seed = [{ key: '00000000000000aa', t: [extent.fromMs, extent.toMs], v: [0, 1] }];
        const n = await p.frame({ spec, series: seed, w: extent, size: [400, 200], dpr: 1 });
        const a = await p.synth(n, { series: 10, points: 1000 });
        // The chunk is not a ring record (`settle` does not see it): its summary is.
        const t0 = performance.now();
        while (p.last(n)?.seriesTotal !== 10 && performance.now() - t0 < 30_000)
          await new Promise((r) => setTimeout(r, 50));
        await p.settle(n);
        const b = await p.synth(n, { series: 10, points: 1000 });
        await p.settle(n);
        const total = p.last(n)?.seriesTotal ?? null;
        const c = await p.synth(n, impossible);
        // A redraw after the failure: still the earlier chunk.
        p.call(n, 'setTimeWindow', { fromMs: extent.fromMs + 1000, toMs: extent.toMs });
        const drawn = p.drawn(n).length;
        await p.settle(n);
        return {
          a,
          b,
          c,
          total,
          after: p.last(n)?.seriesTotal ?? null,
          redrawn: p.drawn(n).length > drawn,
        };
      },
      { spec: LINE, extent: EXTENT, impossible: IMPOSSIBLE },
    );
    expect(r.a, 'the first synth').toEqual({ ok: true, bytes: 10 * 1000 * 8 });
    expect(r.b, 'the repeat: an equal acknowledgement').toEqual(r.a);
    expect(r.total, 'the frame shows 10 series').toBe(10);
    expect(r.c, 'an impossible size').toEqual({ ok: false, bytes: 0 });
    expect(r.redrawn, 'the frame still draws').toBe(true);
    expect(r.after, 'the earlier chunk').toBe(10);
    expect(failures).toEqual([]);
  });

  test('bench:frame-line-1e8: 10⁸ points (or 10⁷), plain, selected (1, 500) and hover (report only)', async ({
    page,
  }, info: TestInfo) => {
    test.setTimeout(30 * 60_000);
    const results: BenchResult[] = [];
    let failures = await probePage(page);
    let runs = await scale(page, failures, '1e8', { series: 1000, points: 100_000 }, false);
    const want = CASES.map((c) => ({ case: `1e8${c.name}`, leg: 'wasm-webgl2' }));
    if (runs === null) {
      // The host has not the memory for 10⁸: recorded, then 10⁷ in a fresh worker.
      for (const c of CASES) {
        results.push(
          summarise(
            {
              gate: GATE,
              case: `1e8${c.name}`,
              leg: 'wasm-webgl2',
              points: 1e8,
              series: 1000,
              skipped: 'memory',
            },
            [],
            [],
          ),
        );
      }
      await page.close();
      const fresh = await page.context().newPage();
      failures = await probePage(fresh);
      runs = (await scale(fresh, failures, '1e7', { series: 1000, points: 10_000 }, true)) ?? [];
      want.push(...CASES.map((c) => ({ case: `1e7${c.name}`, leg: 'wasm-webgl2' })));
    }
    results.push(...runs.map((r) => r.result));
    await report(info, results);
    for (const r of runs) sanity(r);
    expect(reportGaps(readResults(GATE), want), 'the report').toEqual([]);
  });
});
