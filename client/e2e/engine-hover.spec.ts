/**
 * `e2e:engine-hover` (plan #68 C2b §5, H1–H6; INT-033, INT-034, INT-025, T02-024, T25-005): hover,
 * click select and the box band on engine frames, through `__dashProbe` in the fault build
 * (`?probe=1`). A probe frame takes synthetic pointer and key events on its canvas (the controller
 * runs on the main thread, ADR-0030); the worker picks on the presentation's f64 originals and draws
 * the overlay; `settle` waits until the worker has presented every record. Gated on `lavapipe`; the
 * `swiftshader` leg is report-only while `engine-legs.json` says so. H1b runs in the `probe`
 * project (the probe build): it holds the frame at the presentation of one Overlay (`freeze`), so
 * each screenshot is that presentation, never a later one.
 *
 * `S()`: C2a2's probe frame (61 samples over 12:00–13:00, value `30·i/60`, 800×240 at DPR 1).
 * `xs(f)` = `plot.x + f·plot.width`.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { FrameSummary, HoverEvent, SelectEvent, VisSpec } from '../src/engine/api.ts';
import { seriesPalette } from '../src/styles/tokens.ts';
import { decodePng, leg, liveCanvas, tierOf, type Rgba } from './engine.ts';
import { frame, GALLERY_URL, galleryReady, open, plotOf } from './helpers.ts';

const T0 = Date.UTC(2026, 10, 19, 12);
const T1 = Date.UTC(2026, 10, 19, 13);
const LINE: VisSpec = { kind: 'line', title: 'T', unit: { kind: 'none' } };
const KEY = '00000000000000a1';
/** `key_hash mod 8` of KEY (no level label): series-2. */
const KEY_COLOUR = 1;
const SIZE: [number, number] = [800, 240];
/** The probe build's page (the `probe` project, as `e2e:shim-fuzz`). */
const PROBE_URL = `${GALLERY_URL}&engine=wasm&mode=t2&probe=1`;

interface ProbeSeries {
  key: string;
  t: number[];
  v: number[];
}

/** 61 samples over 12:00–13:00, value `30·i/60`; `nan` samples are NaN. */
function lineData(nan: number[] = []): ProbeSeries[] {
  const t = Array.from({ length: 61 }, (_, i) => T0 + i * 60_000);
  return [{ key: KEY, t, v: t.map((_, i) => (nan.includes(i) ? NaN : (30 * i) / 60)) }];
}

interface Probe {
  frame(o: unknown): Promise<number>;
  call(n: number, m: string, arg: unknown): void;
  settle(n: number): Promise<void>;
  last(n: number): FrameSummary | null;
  pointer(n: number, type: string, x: number, y: number, o?: unknown): void;
  key(n: number, key: string): boolean;
  flush(n: number): void;
  hovers(n: number): (HoverEvent | null)[];
  selects(n: number): SelectEvent[];
  brushes(n: number): unknown[];
  id(n: number): number;
  producedLog(): { seq: number; frame: number }[];
  freeze(n: number, seq: number): void;
  frozen(n: number): Promise<{ seq: number }>;
  unfreeze(n: number): void;
}

async function probePage(page: Page, info: TestInfo): Promise<void> {
  const url =
    info.project.name === 'probe' ? PROBE_URL : `${GALLERY_URL}${tierOf(info).query}&probe=1`;
  await open(page, url);
  await page.waitForFunction(() => '__dashProbe' in window);
  // Plan #68 C2d2: the project's engine mode (MT, or ST in `lavapipe-st`).
  if (info.project.name !== 'probe') {
    await expect(page.locator('html')).toHaveAttribute('data-dash-mode', tierOf(info).mode, {
      timeout: 30_000,
    });
  }
}

/** A probe frame of `data`, settled: its number and first summary. */
async function S(page: Page, data = lineData()): Promise<{ n: number; s: FrameSummary }> {
  return page.evaluate(
    async (arg) => {
      const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
      const n = await p.frame(arg);
      await p.settle(n);
      const s = p.last(n);
      if (s === null) throw new Error('no summary');
      return { n, s };
    },
    { spec: LINE, series: data, w: { fromMs: T0, toMs: T1 }, size: SIZE, dpr: 1 },
  );
}

type Act =
  | { k: 'pointer'; type: string; x: number; y: number; o?: Record<string, number> }
  | { k: 'key'; key: string };

/** Runs the acts on frame `n` and settles; the frame's hovers and selects. */
async function step(page: Page, n: number, acts: Act[]) {
  return page.evaluate(
    async ({ n, acts }) => {
      const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
      for (const a of acts) {
        if (a.k === 'pointer') p.pointer(n, a.type, a.x, a.y, a.o);
        else p.key(n, a.key);
      }
      await p.settle(n);
      return { hovers: p.hovers(n), selects: p.selects(n), brushes: p.brushes(n).length };
    },
    { n, acts },
  );
}

const xs = (s: FrameSummary, f: number): number => s.plot.x + f * s.plot.width;
const yOf = (s: FrameSummary, v: number): number => {
  const a = s.valueAxis;
  if (a === null) throw new Error('no value axis');
  return s.plot.y + (1 - (v - a.min) / (a.max - a.min)) * s.plot.height;
};
/** The point at fractions of the plot, in whole CSS px inside it (as `e2e:engine-camera`). */
const at = (s: FrameSummary, f: number, g = 0.5) => {
  const { x, y, width, height } = s.plot;
  const clamp = (v: number, lo: number, hi: number): number =>
    Math.min(Math.floor(hi), Math.max(Math.ceil(lo), Math.round(v)));
  return { x: clamp(x + f * width, x, x + width), y: clamp(y + g * height, y, y + height) };
};

/** The probe canvas, device px (at DPR 1, CSS px). */
async function shot(page: Page): Promise<Rgba> {
  return decodePng(
    await page.screenshot({
      scale: 'device',
      clip: { x: 0, y: 0, width: SIZE[0], height: SIZE[1] },
    }),
  );
}

/** The pixels where `a` and `b` differ. */
function diff(a: Rgba, b: Rgba): { x: number; y: number }[] {
  expect([a.w, a.h]).toEqual([b.w, b.h]);
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      const i = (y * a.w + x) * 4;
      if (
        a.px[i] !== b.px[i] ||
        a.px[i + 1] !== b.px[i + 1] ||
        a.px[i + 2] !== b.px[i + 2] ||
        a.px[i + 3] !== b.px[i + 3]
      ) {
        out.push({ x, y });
      }
    }
  }
  return out;
}

/** The plot's device rows. */
const rows = (s: FrameSummary): [number, number] => [
  Math.floor(s.plot.y),
  Math.ceil(s.plot.y + s.plot.height),
];

/**
 * The crosshair of a hover at `xCss` against the unhovered image: every change within ±4 px of
 * `round(xCss)` and inside the plot's rows, and that column changed on ≥ 90 % of the plot's rows.
 */
function expectCrosshair(a: Rgba, b: Rgba, s: FrameSummary, xCss: number, what: string): void {
  const d = diff(a, b);
  const cx = Math.round(xCss);
  const [y0, y1] = rows(s);
  expect(d.length, `${what}: something changed`).toBeGreaterThan(0);
  const stray = d.filter((p) => Math.abs(p.x - cx) > 4 || p.y < y0 || p.y > y1);
  expect(stray.slice(0, 5), `${what}: changes outside the crosshair`).toEqual([]);
  const col = new Set(d.filter((p) => p.x === cx).map((p) => p.y));
  expect(col.size, `${what}: the crosshair column`).toBeGreaterThanOrEqual(
    Math.floor(0.9 * (Math.floor(s.plot.y + s.plot.height) - Math.ceil(s.plot.y))),
  );
}

const hex = (c: string): number[] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));

/** H1–H6 run on the engine tiers; H1b alone in the probe build. */
const tiersOnly = (info: TestInfo): void => {
  test.skip(info.project.name === 'probe', 'H1b only in the probe build');
};

test.describe('e2e:engine-hover', () => {
  test('H1 INT-033: a pointer hover draws the crosshair and the dot, and leaves nothing', async ({
    page,
  }, info) => {
    tiersOnly(info);
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n, s } = await S(page);
      const b = await shot(page);
      const p = at(s, 0.3, 0.5);
      const r = await step(page, n, [{ k: 'pointer', type: 'pointermove', x: p.x, y: p.y }]);
      const a = await shot(page);
      const h = r.hovers.at(-1);
      expect(h).toBeTruthy();
      if (h === null || h === undefined) return;
      expect(h).toMatchObject({ source: 'pointer', tMs: T0 + 1_080_000, yCss: p.y });
      expect(Math.abs(h.xCss - xs(s, 0.3))).toBeLessThanOrEqual(1e-9);
      expect(h.rows).toEqual([
        {
          key: KEY,
          name: '{}',
          colourIndex: KEY_COLOUR,
          value: 9,
        },
      ]);
      expectCrosshair(a, b, s, h.xCss, 'H1');
      // The dot's centre is the series colour.
      const want = hex(seriesPalette.dark[KEY_COLOUR]);
      const i = (Math.floor(yOf(s, 9)) * a.w + Math.floor(h.xCss)) * 4;
      const got = [a.px[i] ?? 0, a.px[i + 1] ?? 0, a.px[i + 2] ?? 0];
      for (let k = 0; k < 3; k++) {
        expect(Math.abs((got[k] ?? 0) - (want[k] ?? 0)), `dot ${String(got)}`).toBeLessThanOrEqual(
          8,
        );
      }
      const r2 = await step(page, n, [{ k: 'pointer', type: 'pointerleave', x: 0, y: 0 }]);
      expect(r2.hovers.at(-1)).toBeNull();
      const c = await shot(page);
      expect(diff(c, b).length, 'after the hover: as before').toBe(0);
    });
  });

  test('H2: the keyboard crosshair steps the samples and Escape clears it', async ({
    page,
  }, info) => {
    tiersOnly(info);
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n, s } = await S(page);
      const r1 = await step(page, n, [{ k: 'key', key: 'ArrowRight' }]);
      expect(r1.hovers.at(-1)).toMatchObject({ source: 'keyboard', tMs: T0, yCss: s.plot.y });
      expect(r1.hovers.at(-1)?.xCss).toBeCloseTo(s.plot.x, 9);
      const r2 = await step(page, n, [{ k: 'key', key: 'End' }]);
      expect(r2.hovers.at(-1)).toMatchObject({ source: 'keyboard', tMs: T1, yCss: s.plot.y });
      expect(r2.hovers.at(-1)?.rows[0]?.value).toBe(30);
      const r3 = await step(page, n, [{ k: 'key', key: 'Escape' }]);
      expect(r3.hovers.at(-1)).toBeNull();
    });
  });

  test('H3 INT-034: a click selects the point under it; a gap selects nothing', async ({
    page,
  }, info) => {
    tiersOnly(info);
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const click = (p: { x: number; y: number }): Act[] => [
        { k: 'pointer', type: 'pointerdown', x: p.x, y: p.y, o: { button: 0, buttons: 1 } },
        { k: 'pointer', type: 'pointerup', x: p.x, y: p.y, o: { button: 0 } },
      ];
      const { n, s } = await S(page);
      const g = (yOf(s, 9) - s.plot.y) / s.plot.height;
      const r = await step(page, n, click(at(s, 0.3, g)));
      expect(r.selects).toEqual([
        { source: 'pointer', item: { kind: 'point', key: KEY, tMs: T0 + 1_080_000, value: 9 } },
      ]);
      const gap = await S(page, lineData([18]));
      const r2 = await step(page, gap.n, click(at(gap.s, 0.3, 0.5)));
      expect(r2.selects).toEqual([{ source: 'pointer', item: null }]);
    });
  });

  test('H4 INT-025: a right drag draws the box band, and only it', async ({ page }, info) => {
    tiersOnly(info);
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n, s } = await S(page);
      const b = await shot(page);
      const p0 = at(s, 0.2);
      const p1 = at(s, 0.4);
      const down = { button: 2, buttons: 2 };
      await step(page, n, [
        { k: 'pointer', type: 'pointerdown', x: p0.x, y: p0.y, o: down },
        { k: 'pointer', type: 'pointermove', x: p1.x, y: p1.y, o: down },
      ]);
      const a = await shot(page);
      const d = diff(a, b);
      const [y0, y1] = rows(s);
      expect(d.length).toBeGreaterThan(0);
      const stray = d.filter((q) => q.x < p0.x - 1 || q.x > p1.x + 1 || q.y < y0 || q.y > y1);
      expect(stray.slice(0, 5)).toEqual([]);
      const r = await step(page, n, [
        { k: 'pointer', type: 'pointerup', x: p1.x, y: p1.y, o: { button: 2 } },
      ]);
      expect(r.brushes).toBe(1);
      expect(diff(await shot(page), b).length, 'after the release: as before').toBe(0);
    });
  });

  test('H5: a hover of an Overlay older than a layout change never shows', async ({
    page,
  }, info) => {
    tiersOnly(info);
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n, s } = await S(page);
      const p = at(s, 0.5);
      const shown = await step(page, n, [{ k: 'pointer', type: 'pointermove', x: p.x, y: p.y }]);
      expect(shown.hovers.at(-1)).toBeTruthy();
      const r = await page.evaluate(
        async ({ n, plot, data }) => {
          const pr = (window as unknown as { __dashProbe: Probe }).__dashProbe;
          // 20 moves, each published at once while the worker keeps ticking; then new data, all
          // in this task: the frame's hover goes to null at once.
          for (let i = 0; i < 20; i++) {
            pr.pointer(n, 'pointermove', Math.round(plot.x + 20 + i * 30), Math.round(plot.y + 50));
            pr.flush(n);
            const t = performance.now();
            while (performance.now() - t < 5) {
              // The worker drains and answers in the meantime.
            }
          }
          pr.call(n, 'setData', data);
          const k = pr.hovers(n).length;
          await pr.settle(n);
          await new Promise((res) => {
            setTimeout(res, 200);
          });
          return { k, hovers: pr.hovers(n) };
        },
        { n, plot: s.plot, data: lineData() },
      );
      expect(r.hovers[r.k - 1], 'the layout change clears the hover').toBeNull();
      expect(r.hovers.slice(r.k).filter((h) => h !== null)).toEqual([]);
    });
  });

  test('H6 INT-033: the gallery tooltip of an engine chart equals Canvas 2D’s', async ({
    page,
  }, info) => {
    tiersOnly(info);
    test.setTimeout(120_000);
    await leg(info, async () => {
      const tip = async (query: string): Promise<string[]> => {
        await open(page, `${GALLERY_URL}${query}`);
        await galleryReady(page);
        const f = frame(page, 'line-50');
        await f.scrollIntoViewIfNeeded();
        const plot = await plotOf(f);
        const box = await f.boundingBox();
        if (box === null) throw new Error('no box');
        await page.mouse.move(
          Math.round(box.x + plot.x + plot.width / 2),
          Math.round(box.y + plot.y + plot.height / 2),
        );
        const t = f.locator('[data-chart-tooltip]');
        await expect(t).toBeVisible();
        return t.evaluate((el) => [
          el.querySelector('[data-time]')?.textContent ?? '',
          ...[...el.querySelectorAll('[data-row]')].map(
            (r) =>
              `${r.querySelector('[data-name]')?.textContent ?? ''}=${r.querySelector('[data-value]')?.textContent ?? ''}`,
          ),
        ]);
      };
      const wasm = await tip(tierOf(info).query);
      await expect(liveCanvas(page, 'line-50')).toHaveAttribute('data-engine', tierOf(info).engine);
      const c2d = await tip('&engine=canvas2d');
      await expect(liveCanvas(page, 'line-50')).toHaveAttribute('data-engine', 'canvas2d');
      expect(wasm.length).toBeGreaterThan(1);
      expect(wasm).toEqual(c2d);
    });
  });
});

test.describe('e2e:engine-hover (probe build)', () => {
  test('H1b T02-024: each hover presentation carries its own overlay', async ({ page }, info) => {
    test.skip(info.project.name !== 'probe', 'the probe build only');
    test.setTimeout(120_000);
    await probePage(page, info);
    const { n, s } = await S(page);
    const b = await shot(page);
    /** Freezes the frame at the next record's presentation, runs `act`, screenshots, releases. */
    const frozen = async (act: Act) => {
      const r = await page.evaluate(
        async ({ n, act }) => {
          const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
          const id = p.id(n);
          const last = p
            .producedLog()
            .filter((x) => x.frame === id)
            .at(-1);
          const seq = (last?.seq ?? 0) + 1;
          p.freeze(n, seq);
          if (act.k === 'pointer') p.pointer(n, act.type, act.x, act.y, act.o);
          p.flush(n);
          const d = await p.frozen(n);
          return { seq, drawn: d.seq, hover: p.hovers(n).at(-1) ?? null };
        },
        { n, act },
      );
      const img = await shot(page);
      await page.evaluate((n) => {
        (window as unknown as { __dashProbe: Probe }).__dashProbe.unfreeze(n);
      }, n);
      expect(r.drawn, 'the frozen presentation is the Overlay’s').toBe(r.seq);
      return { img, hover: r.hover };
    };
    const p3 = at(s, 0.3);
    const a1 = await frozen({ k: 'pointer', type: 'pointermove', x: p3.x, y: p3.y });
    expect(a1.hover?.tMs).toBe(T0 + 1_080_000);
    expectCrosshair(a1.img, b, s, xs(s, 0.3), 'A1');
    const p6 = at(s, 0.6);
    const a2 = await frozen({ k: 'pointer', type: 'pointermove', x: p6.x, y: p6.y });
    expect(a2.hover?.tMs).toBe(T0 + 2_160_000);
    expectCrosshair(a2.img, b, s, xs(s, 0.6), 'A2');
    const near3 = diff(a2.img, b).filter((q) => Math.abs(q.x - Math.round(xs(s, 0.3))) <= 4);
    expect(near3, 'A2 has nothing of A1').toEqual([]);
    const c = await frozen({ k: 'pointer', type: 'pointerleave', x: 0, y: 0 });
    expect(c.hover).toBeNull();
    expect(diff(c.img, b).length, 'C = B').toBe(0);
  });
});
