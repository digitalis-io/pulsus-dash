/**
 * `bench:frame-line-1e8` (plan #68 C2d1 §3.2, §4.2, §4.3; T05 §4.3; PRF-016, PRF-001, PRF-002;
 * report only), in the probe build (`__dashProbe`, project `bench`, lavapipe WebGL2): a 1118×240
 * probe line frame gets `pulsus-synth`'s F1c (1 000 series × 10⁵ grid points) built in the worker
 * (`synth`, `Frames::set_chunk`), its window the grid's extent, then four cases with a 120 s box
 * each: `1e8` (`SCRIPT`), `1e8-selected` (series 7 selected, m = 1), `1e8-selected-500` (m = 500,
 * #264) and `1e8-hover` (`HOVER`).
 *
 * The synthesis outcome decides, first match winning: `ok: false` (the worker's allocation
 * failed) records the cases `skipped: 'memory'`, reloads (a fresh worker) and runs them at 10⁷
 * (1 000 × 10⁴) as `1e7-…`; a `fatal` fails the run; no answer in 120 s or a worker restart records
 * the case `timedOut`, reloads and goes on with the next. After an `ok` it waits, inside the case's
 * box, for the summary of the synthesised series. A timed-out case (m = 500 may be one) is not a
 * failure.
 *
 * B3 checks `synth`'s acknowledgements and that an impossible size leaves the chunk; B4 checks the
 * frame-id filter on its own: a noise frame redraws while a drive of the idle bench frame collects
 * nothing; `synth outcomes` drives the precedence with the probe's `synthFault`.
 */
import { expect, test, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import type { FrameSummary, HoverEvent, VisSpec } from '../src/engine/api.ts';
import { emptyDrive, summarise, type BenchResult } from '../scripts/lib/benchStats.ts';
import {
  drive,
  HOVER,
  LINE_1E8_BOX_MS,
  MIN_PRESENTS,
  open,
  readResults,
  report,
  reportGaps,
  SCRIPT,
  type Step,
} from './bench/frameBench.ts';
import { GALLERY_URL } from './helpers.ts';

const GATE = 'bench:frame-line-1e8' as const;
const PROBE_URL = `${GALLERY_URL}&engine=wasm&mode=t2&probe=1`;
const LINE: VisSpec = { kind: 'line', title: 'F1c', unit: { kind: 'none' } };
/** `pulsus_synth::reference::WINDOW`: the grid's extent. */
const EXTENT = { fromMs: 0, toMs: 1_000_000 };
const SIZE: [number, number] = [1118, 240];
const BENCH = '[data-bench="bench"]';
const NOISE = '[data-bench="noise"]';
const SYNTH_TIMEOUT_MS = 120_000;
/** Boots tried after a reload, and the pause between them. */
const BOOT_TRIES = 6;
const BOOT_PAUSE_MS = 20_000;
/** An allocation the worker cannot make (16 GB of values, within `MAX_SAMPLES`). */
const IMPOSSIBLE = { series: 20_000, points: 100_000 };

type SynthFault = 'alloc' | 'silent' | 'fatal';

interface Ack {
  ok: boolean;
  bytes: number;
  reason?: 'alloc' | 'restart' | 'fatal' | 'timeout';
}

interface Probe {
  frame(o: unknown): Promise<number>;
  call(n: number, m: string, arg: unknown): void;
  settle(n: number): Promise<void>;
  last(n: number): FrameSummary | null;
  drawn(n: number): unknown[];
  hovers(n: number): (HoverEvent | null)[];
  synth(n: number, o: { series: number; points: number }, timeoutMs?: number): Promise<Ack>;
  synthFault(f: SynthFault | null): void;
  chunk(n: number): Promise<{ series: number; points: number; bytes: number } | null>;
}

const key = (s: number): string => s.toString(16).padStart(16, '0');
const SEED = [{ key: '00000000000000aa', t: [EXTENT.fromMs, EXTENT.toMs], v: [0, 1] }];

/** A probe page (no fake clock); the failed-frame warnings it logs. */
async function probePage(page: Page): Promise<string[]> {
  const failures: string[] = [];
  page.on('console', (m) => {
    if (/probe-\d+ failed:/.test(m.text())) failures.push(m.text());
  });
  await open(page, PROBE_URL);
  return failures;
}

interface Scale {
  tag: string;
  series: number;
  points: number;
}

type Outcome = 'ok' | 'alloc' | 'fatal' | 'timedOut';

/**
 * The bench frame (probe frame 0, canvas `data-bench="bench"`), then `synth(0, …)` and, after an
 * `ok`, the wait for its summary within `boxMs`: the outcome (plan #68 C2d1 §3.2).
 */
async function setup(
  page: Page,
  sc: Scale,
  o: { boxMs: number; synthTimeoutMs: number; fault: SynthFault | null },
): Promise<Outcome> {
  return page.evaluate(
    async ({ spec, extent, size, seed, sc, o }) => {
      const t0 = performance.now();
      const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
      const n = await p.frame({ spec, series: seed, w: extent, size, dpr: 1 });
      const canvas = document.querySelectorAll<HTMLCanvasElement>('body > canvas')[0];
      canvas?.setAttribute('data-bench', 'bench');
      if (o.fault !== null) p.synthFault(o.fault);
      const ack = await p.synth(n, sc, o.synthTimeoutMs);
      if (!ack.ok)
        return ack.reason === 'alloc' ? 'alloc' : ack.reason === 'fatal' ? 'fatal' : 'timedOut';
      // The chunk is not a ring record (`settle` does not see it): its summary is.
      while (p.last(n)?.seriesTotal !== sc.series) {
        if (performance.now() - t0 > o.boxMs) return 'timedOut';
        await new Promise((r) => setTimeout(r, 50));
      }
      const settled = await Promise.race([
        p.settle(n).then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((r) =>
          setTimeout(
            () => {
              r(false);
            },
            Math.max(0, o.boxMs - (performance.now() - t0)),
          ),
        ),
      ]);
      if (!settled) return 'timedOut';
      const plot = p.last(n)?.plot;
      if (plot !== undefined)
        canvas?.setAttribute('data-plot', [plot.x, plot.y, plot.width, plot.height].join(','));
      return 'ok';
    },
    { spec: LINE, extent: EXTENT, size: SIZE, seed: SEED, sc, o },
  );
}

interface Before {
  w: [number, number];
  hovers: number;
  timedOut: boolean;
}

/** The bench frame back on the extent with `keys` selected, quiet, within `boxMs`. */
async function prepare(page: Page, keys: string[] | null, boxMs: number): Promise<Before> {
  return page.evaluate(
    async ({ keys, extent, boxMs }) => {
      const t0 = performance.now();
      const left = (): number => Math.max(0, boxMs - (performance.now() - t0));
      const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
      p.call(0, 'setSelection', keys === null ? null : { keys, fromMs: null, toMs: null });
      p.call(0, 'setTimeWindow', extent);
      // `settle` gives up after 60 s; a slow frame (m = 500 at 10⁸) gets the whole box.
      let settled = false;
      while (!settled && left() > 0) {
        settled = await Promise.race([
          p.settle(0).then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((r) =>
            setTimeout(() => {
              r(false);
            }, left()),
          ),
        ]);
      }
      // The selection is a message, not a ring record: wait until the frame stops presenting.
      let seen = p.drawn(0).at(-1);
      let still = performance.now();
      while (settled && performance.now() - still < 500 && left() > 0) {
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
        timedOut: !settled || left() === 0,
      };
    },
    { keys, extent: EXTENT, boxMs },
  );
}

/** After a case: the window, the hovers since `from` (events, distinct times) and the status. */
async function after(page: Page, from: number) {
  return page.evaluate((from) => {
    const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
    const s = p.last(0);
    const all = p.hovers(0);
    const was = all.slice(0, from).at(-1)?.tMs ?? null;
    const hs = all.slice(from).filter((h): h is HoverEvent => h !== null);
    return {
      w: [s?.fromMs ?? NaN, s?.toMs ?? NaN] as [number, number],
      hovers: hs.length,
      // The crosshair moved: a hover at a time other than the one before the case. The engine
      // answers only the latest Overlay (C2b), so a slow frame may report one hover.
      moved: hs.some((h) => h.tMs !== was),
      status: document.documentElement.getAttribute('data-dash-status'),
    };
  }, from);
}

interface Case {
  name: string;
  keys: string[] | null;
  steps: readonly Step[];
}

const CASES: readonly Case[] = [
  { name: '', keys: null, steps: SCRIPT },
  { name: '-selected', keys: [key(7)], steps: SCRIPT },
  { name: '-selected-500', keys: Array.from({ length: 500 }, (_, i) => key(i)), steps: SCRIPT },
  { name: '-hover', keys: null, steps: HOVER },
];

interface Checked {
  result: BenchResult;
  moved: boolean;
  hovers: number;
  /** A hover case moved the crosshair. */
  crosshairMoved: boolean;
  status: string | null;
  failures: string[];
}

/**
 * The gate's cases at `scales[0]`, with the outcome precedence of §3.2 (`scales[1]` is the memory
 * fallback); `fault` applies to the first synthesis only. A `fatal` throws.
 */
async function runGate(
  ctx: BrowserContext,
  o: {
    scales: readonly [Scale, Scale];
    cases: readonly Case[];
    boxMs: number;
    synthTimeoutMs: number;
    fault?: SynthFault;
  },
): Promise<{ results: BenchResult[]; checked: Checked[] }> {
  const results: BenchResult[] = [];
  const checked: Checked[] = [];
  let page = await ctx.newPage();
  let failures = await probePage(page);
  let fault: SynthFault | null = o.fault ?? null;
  let sc = o.scales[0];
  let ready = false;
  /**
   * `setup`, retried on a page whose engine does not boot (a busy GPU process after a slow 10⁸
   * frame on the page before): up to `BOOT_TRIES` reloads, `BOOT_PAUSE_MS` apart, then
   * `timedOut`.
   */
  const bootAndSetup = async (
    s: Scale,
    so: { boxMs: number; synthTimeoutMs: number; fault: SynthFault | null },
  ): Promise<Outcome> => {
    for (let k = 0; ; k++) {
      try {
        return await setup(page, s, so);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/engine status/.test(msg)) throw e;
        if (k + 1 >= BOOT_TRIES) return 'timedOut';
        console.log(`${GATE}: the engine did not boot (${msg.split('\n')[0] ?? ''}); reloading`);
        await page.close();
        await new Promise((r) => setTimeout(r, BOOT_PAUSE_MS));
        page = await ctx.newPage();
        failures = await probePage(page);
      }
    }
  };
  const reload = async (): Promise<void> => {
    await page.close();
    page = await ctx.newPage();
    failures = await probePage(page);
    ready = false;
  };
  const base = (c: Case, s: Scale) => ({
    gate: GATE,
    case: `${s.tag}${c.name}`,
    leg: 'wasm-webgl2' as const,
    points: s.series * s.points,
    series: s.series,
  });
  try {
    for (let i = 0; i < o.cases.length; i++) {
      const c = o.cases[i];
      if (c === undefined) break;
      const t0 = Date.now();
      if (!ready) {
        const out = await bootAndSetup(sc, {
          boxMs: o.boxMs,
          synthTimeoutMs: o.synthTimeoutMs,
          fault,
        });
        fault = null;
        console.log(
          `${GATE}: ${sc.tag} synthesis for ${sc.tag}${c.name}: ${out} (${String(Date.now() - t0)} ms)`,
        );
        if (out === 'fatal')
          throw new Error(`${sc.tag}: the engine failed (fatal) during synthesis`);
        if (out === 'alloc') {
          // The host has not the memory: every case left is recorded, then rerun at the fallback.
          for (const r of o.cases.slice(i))
            results.push(summarise({ ...base(r, sc), skipped: 'memory' }, emptyDrive()));
          if (sc === o.scales[1]) break;
          sc = o.scales[1];
          await reload();
          i -= 1;
          continue;
        }
        if (out === 'timedOut') {
          results.push(summarise(base(c, sc), emptyDrive(true)));
          await reload();
          continue;
        }
        ready = true;
      }
      const left = (): number => Math.max(1, o.boxMs - (Date.now() - t0));
      const before = await prepare(page, c.keys, left());
      const d = before.timedOut
        ? emptyDrive(true)
        : await drive(page, BENCH, 'probe-0', c.steps, left());
      const hover = c.steps === HOVER;
      if (hover && !d.timedOut) {
        // The engine answers the latest Overlay a frame later (C2b): its hover, inside the box.
        await page
          .waitForFunction(
            (from) =>
              (window as unknown as { __dashProbe: Probe }).__dashProbe
                .hovers(0)
                .slice(from)
                .some((h) => h !== null),
            before.hovers,
            { timeout: left(), polling: 50 },
          )
          .catch(() => undefined);
      }
      const a = await after(page, before.hovers);
      const result = summarise({ ...base(c, sc), ...(hover ? { hovers: a.hovers } : {}) }, d);
      results.push(result);
      console.log(
        `${GATE}: ${result.case}: ${String(result.frames)} frames${d.timedOut ? ', timed out' : ''} (${String(Date.now() - t0)} ms)`,
      );
      checked.push({
        result,
        moved: before.w[0] !== a.w[0] || before.w[1] !== a.w[1],
        hovers: a.hovers,
        crosshairMoved: a.moved,
        status: a.status,
        failures: [...failures],
      });
      // A timed-out case leaves the engine busy: the next one starts on a fresh worker.
      if (d.timedOut) await reload();
    }
  } finally {
    await page.close();
  }
  return { results, checked };
}

/** Plan #68 C2d1 §4.3: relative checks; a timed-out case is not a failure. */
function sanity(c: Checked): void {
  const what = c.result.case;
  expect.soft(c.failures, `${what}: no failed frame`).toEqual([]);
  expect.soft(c.status, `${what}: no fatal`).not.toBe('4');
  if (c.result.timedOut === true) return;
  expect.soft(c.result.frames, `${what}: frames`).toBeGreaterThanOrEqual(MIN_PRESENTS);
  if (what.endsWith('-hover')) {
    expect.soft(c.hovers, `${what}: a hover event`).toBeGreaterThan(0);
    expect.soft(c.crosshairMoved, `${what}: the crosshair moved`).toBe(true);
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
      async ({ spec, extent, seed, impossible }) => {
        const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
        const n = await p.frame({ spec, series: seed, w: extent, size: [400, 200], dpr: 1 });
        const a = await p.synth(n, { series: 10, points: 1000 });
        const b = await p.synth(n, { series: 10, points: 1000 });
        const c = await p.synth(n, impossible);
        return { a, b, c, chunk: await p.chunk(n) };
      },
      { spec: LINE, extent: EXTENT, seed: SEED, impossible: IMPOSSIBLE },
    );
    expect(r.a, 'the first synth').toEqual({ ok: true, bytes: 10 * 1000 * 8 });
    expect(r.b, 'the repeat: an equal acknowledgement').toEqual(r.a);
    expect(r.c, 'an impossible size').toEqual({ ok: false, bytes: 0, reason: 'alloc' });
    expect(r.chunk, 'the earlier chunk').toEqual({ series: 10, points: 1000, bytes: 80_000 });
    expect(failures).toEqual([]);
  });

  test('bench:frame-line-1e8 B4 attribution: the bench frame collects nothing while another draws', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await probePage(page);
    await page.evaluate(
      async ({ spec, extent, seed }) => {
        const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
        await p.frame({ spec, series: seed, w: extent, size: [400, 200], dpr: 1 });
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
      },
      { spec: LINE, extent: EXTENT, seed: SEED },
    );
    const noise = await drive(page, NOISE, 'probe-1', [], 10_000);
    const idle = await drive(page, BENCH, 'probe-0', [], 3_000);
    expect(noise.presents.length, 'the noise frame presents').toBeGreaterThan(0);
    expect(idle.presents, 'the idle bench frame collects nothing').toEqual([]);
  });

  test('bench:frame-line-1e8 synth outcomes: memory falls back, no answer times out, fatal fails', async ({
    context,
  }) => {
    test.setTimeout(300_000);
    const scales = [
      { tag: 't1', series: 10, points: 1000 },
      { tag: 't0', series: 10, points: 100 },
    ] as const;
    const plain: Case = { name: '', keys: null, steps: SCRIPT };
    const two: Case[] = [plain, { ...plain, name: '-again' }];
    const box = 30_000;
    const alloc = await runGate(context, {
      scales,
      cases: [plain],
      boxMs: box,
      synthTimeoutMs: 10_000,
      fault: 'alloc',
    });
    expect(alloc.results.map((r) => [r.case, r.skipped ?? null])).toEqual([
      ['t1', 'memory'],
      ['t0', null],
    ]);
    expect(alloc.results[1]?.frames ?? 0).toBeGreaterThanOrEqual(MIN_PRESENTS);
    const silent = await runGate(context, {
      scales,
      cases: two,
      boxMs: box,
      synthTimeoutMs: 3_000,
      fault: 'silent',
    });
    expect(silent.results.map((r) => [r.case, r.timedOut ?? false])).toEqual([
      ['t1', true],
      ['t1-again', false],
    ]);
    expect(silent.results[1]?.frames ?? 0).toBeGreaterThanOrEqual(MIN_PRESENTS);
    await expect(
      runGate(context, {
        scales,
        cases: [plain],
        boxMs: box,
        synthTimeoutMs: 10_000,
        fault: 'fatal',
      }),
    ).rejects.toThrow(/fatal/);
  });

  test('bench:frame-line-1e8: 10⁸ points (or 10⁷), plain, selected (1, 500) and hover (report only)', async ({
    context,
  }, info: TestInfo) => {
    test.setTimeout(60 * 60_000);
    const { results, checked } = await runGate(context, {
      scales: [
        { tag: '1e8', series: 1000, points: 100_000 },
        { tag: '1e7', series: 1000, points: 10_000 },
      ],
      cases: CASES,
      boxMs: LINE_1E8_BOX_MS,
      synthTimeoutMs: SYNTH_TIMEOUT_MS,
    });
    await report(info, results);
    for (const c of checked) sanity(c);
    const want = CASES.map((c) => ({ case: `1e8${c.name}`, leg: 'wasm-webgl2' }));
    if (results.some((r) => r.skipped === 'memory'))
      want.push(...CASES.map((c) => ({ case: `1e7${c.name}`, leg: 'wasm-webgl2' })));
    expect(reportGaps(readResults(GATE), want), 'the report').toEqual([]);
  });
});
