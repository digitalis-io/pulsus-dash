/**
 * `e2e:engine-camera` (plan #68 C2a2 §5, E1–E8; INT-002, INT-007, INT-008, T02-011, T02-021;
 * Part A §4.9 C3, C4): #93's camera controller on engine frames, through `__dashProbe` in the
 * fault build (`?probe=1`). A probe frame takes synthetic wheel and pointer events on its canvas
 * (the controller runs on the main thread, ADR-0030); every step waits until the worker has
 * presented the camera (`settle`) and reads the frame's summary (`last`). Gated on `lavapipe`;
 * the `swiftshader` leg is report-only while `engine-legs.json` says so.
 *
 * `S(o)`: a line of 61 samples over 12:00–13:00 (value `lo + (hi − lo)·i/60`), 800×240 at DPR 1.
 * Every settle inside a gesture takes < 250 ms (asserted), so no wheel-idle commit comes early.
 * "Idle" waits 350 ms, then settles. `ref(…)` is a fresh frame's plot x: the engine's own layout.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type {
  BrushEvent,
  CommitEvent,
  FrameSummary,
  TimeWindow,
  ValueRange,
  VisSpec,
} from '../src/engine/api.ts';
import { fy, valueLimits, zoomAbout, type Span } from '../src/engine/canvas2d/camera.ts';
import { mulberry32 } from '../src/test/random.ts';
import { decodePng, leg, liveCanvas, tierOf } from './engine.ts';
import { frame, GALLERY_URL, galleryReady, open, plotOf } from './helpers.ts';

const T0 = Date.UTC(2026, 10, 19, 12);
const T1 = Date.UTC(2026, 10, 19, 13);
const HOUR = 3_600_000;
const W0: TimeWindow = { fromMs: T0, toMs: T1 };
const LINE: VisSpec = { kind: 'line', title: 'T', unit: { kind: 'none' } };
const KEY = '00000000000000a1';
/** A step inside a gesture must settle well before the 300 ms wheel-idle commit. */
const STEP_MS = 250;

interface ProbeSeries {
  key: string;
  t: number[];
  v: number[];
}

/** 61 samples over 12:00–13:00, value `lo + (hi − lo) · i / 60`. */
function lineData(lo = 0, hi = 30): ProbeSeries[] {
  const t = Array.from({ length: 61 }, (_, i) => T0 + i * 60_000);
  return [{ key: KEY, t, v: t.map((_, i) => lo + ((hi - lo) * i) / 60) }];
}

interface Probe {
  frame(o: unknown): Promise<number>;
  call(n: number, m: string, arg: unknown): void;
  settle(n: number): Promise<void>;
  last(n: number): FrameSummary | null;
  wheel(n: number, x: number, y: number, init: unknown): boolean;
  pointer(n: number, type: string, x: number, y: number, o?: unknown): void;
  commits(n: number): CommitEvent[];
  brushes(n: number): BrushEvent[];
  fresh(o: unknown): Promise<FrameSummary>;
  holdTimers(on: boolean): void;
}

type Act =
  | { k: 'wheel'; x: number; y: number; init: Record<string, number | boolean> }
  | { k: 'pointer'; type: string; x: number; y: number; o?: Record<string, number | boolean> }
  | { k: 'call'; m: string; arg: unknown }
  | { k: 'wait'; ms: number };

interface Setup {
  spec?: VisSpec;
  data?: ProbeSeries[];
  w?: TimeWindow;
  size?: [number, number];
}

const frameArg = (o: Setup) => ({
  spec: o.spec ?? LINE,
  series: o.data ?? lineData(),
  w: o.w ?? W0,
  size: o.size ?? [800, 240],
  dpr: 1,
});

async function probePage(page: Page, info: TestInfo): Promise<void> {
  await open(page, `${GALLERY_URL}${tierOf(info).query}&probe=1`);
  await page.waitForFunction(() => '__dashProbe' in window);
  // Plan #68 C2d2: the project's engine mode (MT, or ST in `lavapipe-st`).
  if (info.project.name !== 'probe') {
    await expect(page.locator('html')).toHaveAttribute('data-dash-mode', tierOf(info).mode, {
      timeout: 30_000,
    });
  }
}

/** A probe frame, settled: its number and first summary. */
async function S(page: Page, o: Setup = {}): Promise<{ n: number; s: FrameSummary }> {
  return page.evaluate(async (arg) => {
    const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
    const n = await p.frame(arg);
    await p.settle(n);
    const s = p.last(n);
    if (s === null) throw new Error('no summary');
    return { n, s };
  }, frameArg(o));
}

/** Runs the acts on frame `n`, settles; the summary, the settle time and each wheel's prevention. */
async function step(
  page: Page,
  n: number,
  acts: Act[],
): Promise<{ s: FrameSummary; ms: number; prevented: boolean[] }> {
  return page.evaluate(
    async ({ n, acts }) => {
      const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
      const prevented: boolean[] = [];
      for (const a of acts) {
        if (a.k === 'wheel') prevented.push(p.wheel(n, a.x, a.y, a.init));
        else if (a.k === 'pointer') p.pointer(n, a.type, a.x, a.y, a.o);
        else if (a.k === 'call') p.call(n, a.m, a.arg);
        else
          await new Promise((r) => {
            setTimeout(r, a.ms);
          });
      }
      const t0 = performance.now();
      await p.settle(n);
      const ms = performance.now() - t0;
      const s = p.last(n);
      if (s === null) throw new Error('no summary');
      return { s, ms, prevented };
    },
    { n, acts },
  );
}

/** A step inside a gesture: it must settle before the wheel-idle timer. */
async function gstep(page: Page, n: number, acts: Act[]): Promise<FrameSummary> {
  const r = await step(page, n, acts);
  expect(r.ms, 'settle inside a gesture').toBeLessThan(STEP_MS);
  for (const p of r.prevented) expect(p, 'the wheel is consumed').toBe(true);
  return r.s;
}

const idle = async (page: Page, n: number): Promise<FrameSummary> =>
  (await step(page, n, [{ k: 'wait', ms: 350 }])).s;

const events = (page: Page, n: number) =>
  page.evaluate((n) => {
    const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
    return { commits: p.commits(n), brushes: p.brushes(n) };
  }, n);

/** The plot x of a fresh frame of these inputs (the engine's measured band). */
const ref = (page: Page, o: Setup): Promise<number> =>
  page.evaluate(async (arg) => {
    const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
    return (await p.fresh(arg)).plot.x;
  }, frameArg(o));

const xOf = (s: FrameSummary, t: number): number =>
  s.plot.x + ((t - s.fromMs) / (s.toMs - s.fromMs)) * s.plot.width;
const tAt = (s: FrameSummary, x: number): number =>
  s.fromMs + ((x - s.plot.x) / s.plot.width) * (s.toMs - s.fromMs);
const axisOf = (s: FrameSummary): { min: number; max: number } => {
  if (s.valueAxis === null) throw new Error('no value axis');
  return s.valueAxis;
};
const yOf = (s: FrameSummary, v: number): number => {
  const a = axisOf(s);
  return s.plot.y + (1 - (v - a.min) / (a.max - a.min)) * s.plot.height;
};
const vAt = (s: FrameSummary, y: number): number => {
  const a = axisOf(s);
  return a.min + (1 - (y - s.plot.y) / s.plot.height) * (a.max - a.min);
};
const winOf = (s: FrameSummary): TimeWindow => ({ fromMs: s.fromMs, toMs: s.toMs });
/**
 * The point at fractions of the plot, in whole CSS px inside it: Chromium's `WheelEvent` and
 * `MouseEvent` carry whole-px client coordinates, so the anchor is where the event lands.
 */
const at = (s: FrameSummary, f: number, g = 0.5) => {
  const { x, y, width, height } = s.plot;
  const clamp = (v: number, lo: number, hi: number): number =>
    Math.min(Math.floor(hi), Math.max(Math.ceil(lo), Math.round(v)));
  return {
    x: clamp(x + f * width, x, x + width),
    y: clamp(y + g * height, y, y + height),
  };
};
const wheelAt = (p: { x: number; y: number }, init: Record<string, number | boolean>): Act => ({
  k: 'wheel',
  x: p.x,
  y: p.y,
  init,
});

/**
 * The leftmost column with ink (`plotInk`'s rule: a channel sum differing > 24 from the row's
 * background, its first pixel) in the plot's rows of the probe canvas, device px.
 */
async function leftInk(page: Page, s: FrameSummary, size: [number, number] = [800, 240]) {
  const shot = decodePng(
    await page.screenshot({
      scale: 'device',
      clip: { x: 0, y: 0, width: size[0], height: size[1] },
    }),
  );
  const dpr = await page.evaluate(() => devicePixelRatio);
  let left = Infinity;
  const y0 = Math.ceil(s.plot.y * dpr);
  const y1 = Math.min(shot.h, Math.floor((s.plot.y + s.plot.height) * dpr));
  for (let y = y0; y < y1; y++) {
    const bg = y * shot.w * 4;
    for (let x = 0; x < Math.min(left, shot.w); x++) {
      const i = (y * shot.w + x) * 4;
      const d =
        Math.abs((shot.px[i] ?? 0) - (shot.px[bg] ?? 0)) +
        Math.abs((shot.px[i + 1] ?? 0) - (shot.px[bg + 1] ?? 0)) +
        Math.abs((shot.px[i + 2] ?? 0) - (shot.px[bg + 2] ?? 0));
      if (d > 24) {
        left = x;
        break;
      }
    }
  }
  return { left, want: Math.round(s.plot.x * dpr) };
}

/** The probe frames' wheel-idle timer is held through the screenshot (it must not end a gesture). */
const holdTimers = (page: Page, on: boolean): Promise<void> =>
  page.evaluate((on) => {
    (window as unknown as { __dashProbe: Probe }).__dashProbe.holdTimers(on);
  }, on);

async function expectInkAt(page: Page, s: FrameSummary, what: string): Promise<void> {
  await holdTimers(page, true);
  let r: { left: number; want: number };
  try {
    r = await leftInk(page, s);
  } finally {
    await holdTimers(page, false);
  }
  const { left, want } = r;
  expect(
    Math.abs(left - want),
    `${what}: leftmost ink ${String(left)} vs plot ${String(want)}`,
  ).toBeLessThanOrEqual(1);
}

/** The frame's plot is s0's, and the anchor stays under the pointer (< 1 px). */
function expectHeld(
  s: FrameSummary,
  s0: FrameSummary,
  p: { x: number; y: number },
  ta: number,
  va: number | null,
): void {
  expect(s.plot.x).toBe(s0.plot.x);
  expect(s.plot.width).toBe(s0.plot.width);
  expect(Math.abs(xOf(s, ta) - p.x)).toBeLessThan(1);
  if (va !== null) expect(Math.abs(yOf(s, va) - p.y)).toBeLessThan(1);
}

test.describe('e2e:engine-camera', () => {
  test('E1 INT-002: 100 random wheel steps keep the plot and the anchor', async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n, s: s0 } = await S(page);
      const plot0 = s0.plot;
      const rnd = mulberry32(93);
      let s = s0;
      let ta = 0;
      let va = 0;
      let p = { x: 0, y: 0 };
      for (let k = 0; k < 100; k++) {
        const prev = s;
        p = at(prev, rnd(), rnd());
        ta = tAt(prev, p.x);
        va = vAt(prev, p.y);
        const d = (rnd() * 2 - 1) * 300;
        const mode = Math.floor(rnd() * 4);
        const init =
          mode === 0
            ? { deltaY: d }
            : mode === 1
              ? { deltaY: d, shiftKey: true }
              : mode === 2
                ? { deltaY: Math.round(d), ctrlKey: true }
                : { deltaY: d + 0.25, ctrlKey: true };
        s = await gstep(page, n, [wheelAt(p, init)]);
        expect(s.plot.x, `step ${String(k)}`).toBe(plot0.x);
        expect(s.plot.width).toBe(plot0.width);
        expect(Math.abs(xOf(s, ta) - p.x), `step ${String(k)} x`).toBeLessThan(0.01);
        expect(Math.abs(yOf(s, va) - p.y), `step ${String(k)} y`).toBeLessThan(0.01);
      }
      s = await idle(page, n);
      expect(s.plot).toEqual(plot0);
      expect(Math.abs(xOf(s, ta) - p.x)).toBeLessThan(1);
      expect(Math.abs(yOf(s, va) - p.y)).toBeLessThan(1);
    });
  });

  test('E2 C3: a sub-minimum preview survives a wider external window', async ({ page }, info) => {
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n, s: s0 } = await S(page, {
        size: [4_000, 240],
        w: { fromMs: T0, toMs: T0 + 2_000 },
      });
      expect(2_000).toBeLessThan(Math.ceil(s0.plot.width));
      const p = at(s0, 0.3, 0.5);
      const ints = (w: TimeWindow): boolean =>
        Number.isInteger(w.fromMs) && Number.isInteger(w.toMs);
      const v1 = winOf(await gstep(page, n, [wheelAt(p, { deltaX: 37 })]));
      expect(ints(v1)).toBe(true);
      expect(v1.toMs - v1.fromMs).toBe(2_000);
      await gstep(page, n, [
        { k: 'call', m: 'setTimeWindow', arg: { fromMs: T0, toMs: T0 + HOUR } },
      ]);
      const s2 = await gstep(page, n, [wheelAt(p, { deltaX: 13 })]);
      const v2 = winOf(s2);
      const ta = tAt(s2, p.x);
      expect(ints(v2)).toBe(true);
      expect(v2.toMs - v2.fromMs).toBe(2_000);
      for (let i = 0; i < 2; i++) {
        expect(winOf(await gstep(page, n, [wheelAt(p, { deltaY: -400 })]))).toEqual(v2);
      }
      const s = await idle(page, n);
      const { commits } = await events(page, n);
      expect(commits).toHaveLength(1);
      expect(commits[0]?.window).toEqual(v2);
      expect(Math.abs(xOf(s, ta) - p.x)).toBeLessThan(1e-6);
      const echo = await step(page, n, [{ k: 'call', m: 'setTimeWindow', arg: v2 }]);
      expect(winOf(echo.s)).toEqual(v2);
    });
  });

  test('E3 C4: a non-fitting label during a Y zoom keeps the plot', async ({ page }, info) => {
    test.setTimeout(180_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n, s: s0 } = await S(page);
      const p = at(s0, 0.3, 0.9);
      const ta = tAt(s0, p.x);
      const va = vAt(s0, p.y);
      // The value ranges the gesture shows (the controller's arithmetic: Shift+wheel −300, then
      // +1 000 clamped to 400 px), up to the first wider than 1e22 whose measured band is wider
      // than the held one (a fresh frame's plot x): a label that does not fit the held band.
      const f = fy(s0.plot, p.y);
      const zoom = (r: Span, k: number): Span =>
        zoomAbout(r, f, k, valueLimits(r.lo + f * (r.hi - r.lo)));
      let r = zoom({ lo: axisOf(s0).min, hi: axisOf(s0).max }, Math.exp(-0.6));
      let steps = 0;
      for (let i = 1; i <= 200 && steps === 0; i++) {
        r = zoom(r, Math.exp(0.8));
        const wide =
          r.hi - r.lo > 1e22 &&
          (await ref(page, { spec: { ...LINE, valueRange: { min: r.lo, max: r.hi } } })) >
            s0.plot.x;
        if (wide) steps = i;
      }
      expect(steps, 'a range past 1e22 with a non-fitting label').toBeGreaterThan(0);
      const first = await gstep(page, n, [wheelAt(p, { deltaY: -300, shiftKey: true })]);
      await expectInkAt(page, first, 'first preview');
      const frames = [first];
      let s = first;
      for (let i = 0; i < steps; i++) {
        s = await gstep(page, n, [wheelAt(p, { deltaY: 1_000, shiftKey: true })]);
        frames.push(s);
      }
      // The precomputed range, to rounding (the page's and Node's Math.exp may differ in the ulp).
      const span = r.hi - r.lo;
      expect(Math.abs(axisOf(s).min - r.lo) / span).toBeLessThan(1e-9);
      expect(Math.abs(axisOf(s).max - r.hi) / span).toBeLessThan(1e-9);
      expect(axisOf(s).max - axisOf(s).min).toBeGreaterThan(1e22);
      await expectInkAt(page, s, 'last preview');
      for (const f of frames) expectHeld(f, s0, p, ta, va);
      await idle(page, n);
      const after = (await step(page, n, [{ k: 'pointer', type: 'pointerleave', x: 0, y: 0 }])).s;
      const range: ValueRange = { min: axisOf(after).min, max: axisOf(after).max };
      await expectInkAt(page, after, 'released');
      const x = await ref(page, { spec: { ...LINE, valueRange: range }, w: winOf(after) });
      expect(after.plot.x).toBe(x);
      expect(after.plot.x).toBeGreaterThan(s0.plot.x);
    });
  });

  test('E4 C4: a non-fitting label after the refetch keeps the plot', async ({ page }, info) => {
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n, s: s0 } = await S(page);
      const p = at(s0, 0.3, 0.5);
      const ta = tAt(s0, p.x);
      for (let i = 0; i < 4; i++) {
        const s = await gstep(page, n, [wheelAt(p, { deltaY: -300 })]);
        if (i === 0) await expectInkAt(page, s, 'first preview');
        if (i === 3) await expectInkAt(page, s, 'last preview');
      }
      await idle(page, n);
      const c = (await events(page, n)).commits.at(-1)?.window;
      if (c === undefined || c === null) throw new Error('no committed window');
      await step(page, n, [{ k: 'call', m: 'setTimeWindow', arg: c }]);
      const data = lineData(0, 2e-13);
      const r = (await step(page, n, [{ k: 'call', m: 'setData', arg: data }])).s;
      expect(r.plot.x).toBe(s0.plot.x);
      expect(r.plot.width).toBe(s0.plot.width);
      expect(winOf(r)).toEqual(c);
      expect(Math.abs(xOf(r, ta) - p.x)).toBeLessThan(1);
      await expectInkAt(page, r, 'refetch');
      const later = { fromMs: T1, toMs: T1 + HOUR };
      const s = (await step(page, n, [{ k: 'call', m: 'setTimeWindow', arg: later }])).s;
      await expectInkAt(page, s, 'released');
      expect(s.plot.x).toBe(await ref(page, { data, w: later }));
      expect(s.plot.x).toBeGreaterThan(s0.plot.x);
    });
  });

  for (const [name, lo, hi, g] of [
    ['positive', 0, 30, 1],
    ['negative', -30, 0, 0],
  ] as const) {
    test(`E5 C4: wider labels during a Y-only zoom, ${name}`, async ({ page }, info) => {
      test.setTimeout(120_000);
      await leg(info, async () => {
        await probePage(page, info);
        const data = lineData(lo, hi);
        const { n, s: s0 } = await S(page, { data });
        const p = at(s0, 0.3, g);
        const ta = tAt(s0, p.x);
        const va = vAt(s0, p.y);
        expect(Math.abs(va)).toBeLessThan(1e-12);
        const frames: FrameSummary[] = [];
        for (let i = 0; i < 18; i++) {
          const s = await gstep(page, n, [wheelAt(p, { deltaY: -1_000, shiftKey: true })]);
          if (i === 0) await expectInkAt(page, s, 'first preview');
          if (i === 17) await expectInkAt(page, s, 'last preview');
          frames.push(s);
        }
        frames.push(await idle(page, n));
        const { commits } = await events(page, n);
        expect(commits).toHaveLength(1);
        expect(commits[0]).toMatchObject({ window: null, gesture: 'wheel' });
        const value = commits[0]?.value;
        if (value === undefined || value === null || value === 'auto') throw new Error('no value');
        const pinned: VisSpec = { ...LINE, valueRange: value };
        frames.push((await step(page, n, [{ k: 'call', m: 'setSpec', arg: pinned }])).s);
        for (const s of frames) expectHeld(s, s0, p, ta, va);
        const after = (await step(page, n, [{ k: 'pointer', type: 'pointerleave', x: 0, y: 0 }])).s;
        await expectInkAt(page, after, 'released');
        expect(after.plot.x).toBe(await ref(page, { spec: pinned, data, w: winOf(after) }));
        expect(after.plot.x).toBeGreaterThan(s0.plot.x);
      });
    });
  }

  for (const [name, lo, hi] of [
    ['positive', 0, 2e-5],
    ['negative', -2e-5, 0],
  ] as const) {
    test(`E6 C4: wider labels after the refetch, ${name}`, async ({ page }, info) => {
      test.setTimeout(120_000);
      await leg(info, async () => {
        await probePage(page, info);
        const { n, s: s0 } = await S(page);
        const p = at(s0, 0.3, 0.5);
        const ta = tAt(s0, p.x);
        for (let i = 0; i < 4; i++) {
          const s = await gstep(page, n, [wheelAt(p, { deltaY: -300 })]);
          if (i === 0) await expectInkAt(page, s, 'first preview');
          if (i === 3) await expectInkAt(page, s, 'last preview');
        }
        await idle(page, n);
        const c = (await events(page, n)).commits.at(-1)?.window;
        if (c === undefined || c === null) throw new Error('no committed window');
        const data = lineData(lo, hi);
        expect((await ref(page, { data, w: c })) - s0.plot.x).toBeGreaterThanOrEqual(2);
        await step(page, n, [{ k: 'call', m: 'setTimeWindow', arg: c }]);
        const r = (await step(page, n, [{ k: 'call', m: 'setData', arg: data }])).s;
        expect(r.plot.x).toBe(s0.plot.x);
        expect(r.plot.width).toBe(s0.plot.width);
        expect(winOf(r)).toEqual(c);
        expect(Math.abs(xOf(r, ta) - p.x)).toBeLessThan(1);
        await expectInkAt(page, r, 'refetch');
        const later = { fromMs: T1, toMs: T1 + HOUR };
        const s = (await step(page, n, [{ k: 'call', m: 'setTimeWindow', arg: later }])).s;
        await expectInkAt(page, s, 'released');
        expect(s.plot.x).toBe(await ref(page, { data, w: later }));
      });
    });
  }

  test('E7 INT-008: axis drags and double clicks', async ({ page }, info) => {
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n, s: s0 } = await S(page);
      const { plot } = s0;
      const down = { buttons: 1 };
      const x0 = plot.x + 300;
      const y0 = plot.y + plot.height + 10;
      await step(page, n, [
        { k: 'pointer', type: 'pointerdown', x: x0, y: y0, o: down },
        { k: 'pointer', type: 'pointermove', x: x0 + 100, y: y0, o: down },
        { k: 'pointer', type: 'pointerup', x: x0 + 100, y: y0 },
      ]);
      const c1 = (await events(page, n)).commits;
      expect(c1).toHaveLength(1);
      expect(c1[0]).toMatchObject({ value: null, gesture: 'axis' });
      expect(c1[0]?.window?.fromMs ?? Infinity).toBeLessThan(T0);
      const s1 = (await step(page, n, [])).s;
      const d0 = axisOf(s1);
      const ya = plot.y + 100;
      const s2 = (
        await step(page, n, [
          { k: 'pointer', type: 'pointerdown', x: plot.x - 10, y: ya, o: down },
          { k: 'pointer', type: 'pointermove', x: plot.x - 10, y: ya - 50, o: down },
          { k: 'pointer', type: 'pointerup', x: plot.x - 10, y: ya - 50 },
        ])
      ).s;
      const c2 = (await events(page, n)).commits;
      expect(c2).toHaveLength(2);
      const v = c2[1]?.value;
      expect(c2[1]).toMatchObject({ window: null, gesture: 'axis' });
      if (v === undefined || v === null || v === 'auto') throw new Error('no value');
      const shift = (50 / plot.height) * (d0.max - d0.min);
      expect(v.min.toPrecision(9)).toBe((d0.min - shift).toPrecision(9));
      expect(v.max.toPrecision(9)).toBe((d0.max - shift).toPrecision(9));
      expect(winOf(s2)).toEqual(winOf(s1));

      const pin = await S(page, { spec: { ...LINE, valueRange: { min: 10, max: 20 } } });
      const pp = pin.s.plot;
      await step(page, pin.n, [{ k: 'pointer', type: 'dblclick', x: pp.x - 10, y: pp.y + 50 }]);
      expect((await events(page, pin.n)).commits).toEqual([
        { window: null, value: 'auto', gesture: 'fit' },
      ]);
      await step(page, pin.n, [{ k: 'pointer', type: 'dblclick', x: pp.x + 100, y: pp.y + 50 }]);
      const b = (await events(page, pin.n)).brushes;
      expect(b).toHaveLength(1);
      expect(b[0]?.gesture).toBe('zoomOut');
    });
  });

  test('E8 INT-007: the gallery URL follows a wheel and a drag on an engine chart', async ({
    page,
  }, info) => {
    test.setTimeout(60_000);
    await leg(info, async () => {
      await open(page, `${GALLERY_URL}${tierOf(info).query}`);
      await galleryReady(page);
      const f = frame(page, 'line-50');
      await expect(liveCanvas(page, 'line-50')).toHaveAttribute('data-engine', tierOf(info).engine);
      await f.scrollIntoViewIfNeeded();
      const plot = await plotOf(f);
      const box = await f.boundingBox();
      if (box === null) throw new Error('the frame has no box');
      const cx = box.x + plot.x + plot.width / 2;
      const cy = box.y + plot.y + plot.height / 2;
      const url0 = page.url();
      await page.mouse.move(cx, cy);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -300);
      await page.keyboard.up('Control');
      await expect.poll(() => page.url(), { timeout: 2_000 }).not.toBe(url0);
      const url1 = page.url();
      await galleryReady(page);
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx - 100, cy, { steps: 5 });
      await page.mouse.up();
      await expect.poll(() => page.url(), { timeout: 2_000 }).not.toBe(url1);
    });
  });
});
