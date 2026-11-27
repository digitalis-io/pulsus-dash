/**
 * `e2e:engine-layer` (plan #68 C2c1 §5, L1–L4; T02-009, ADR-0022, ADR-0023, ADR-0030): threshold
 * lines and event lines on engine frames, through `__dashProbe` in the fault build (`?probe=1`).
 * Gated on `lavapipe`; the `swiftshader` leg is report-only while `engine-legs.json` says so. The
 * expected plots and domains are the `engine/fixtures/layer.json` frames of the same inputs (the
 * Canvas 2D layer at 800×240): `probe-thresholds`, `probe-event`, `events-ends-pinned` and
 * `events-ends-auto`.
 *
 * `S()`: C2a2's probe frame (61 samples over 12:00–13:00, value `30·i/60`, 800×240 at DPR 1). The
 * engine draws a spec change or `setEvents` when the worker has the message, so the checks that
 * follow one poll the summary, then the pixels.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { EventMarker, FrameSummary, HoverEvent, VisSpec } from '../src/engine/api.ts';
import { colour } from '../src/styles/tokens.ts';
import { decodePng, leg, tierOf, type Rgba } from './engine.ts';
import { GALLERY_URL, open } from './helpers.ts';

const T0 = Date.UTC(2026, 10, 19, 12);
const T1 = Date.UTC(2026, 10, 19, 13);
const LINE: VisSpec = { kind: 'line', title: 'T', unit: { kind: 'none' } };
const SIZE: [number, number] = [800, 240];
const DPR = 1;
const THRESHOLDS: VisSpec = {
  ...LINE,
  thresholds: [
    { value: 20, state: 'watch', label: 'watch 20' },
    { value: 40, state: 'failing', label: 'failing 40' },
  ],
};

interface ProbeSeries {
  key: string;
  t: number[];
  v: number[];
}

function lineData(): ProbeSeries[] {
  const t = Array.from({ length: 61 }, (_, i) => T0 + i * 60_000);
  return [{ key: '00000000000000a1', t, v: t.map((_, i) => (30 * i) / 60) }];
}

interface Probe {
  frame(o: unknown): Promise<number>;
  call(n: number, m: string, arg: unknown): void;
  settle(n: number): Promise<void>;
  last(n: number): FrameSummary | null;
  pointer(n: number, type: string, x: number, y: number, o?: unknown): void;
  wheel(n: number, x: number, y: number, init: unknown): boolean;
  hovers(n: number): (HoverEvent | null)[];
}

interface Plot {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface LayerFrame {
  w: number;
  h: number;
  plot: Plot;
  domain: { min: number; max: number };
}

/** The `layer.json` frame of `id` at 800×240. */
function fixture(id: string): LayerFrame {
  const rows = JSON.parse(readFileSync('../engine/fixtures/layer.json', 'utf8')) as {
    case: string;
    frames: LayerFrame[];
  }[];
  const f = rows.find((r) => r.case === id)?.frames.find((x) => x.w === 800 && x.h === 240);
  if (f === undefined) throw new Error(`layer.json: no 800×240 frame of ${id}`);
  return f;
}

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

/** A probe frame of `spec`, settled: its number and first summary. */
async function S(page: Page, spec: VisSpec = LINE): Promise<{ n: number; s: FrameSummary }> {
  return page.evaluate(
    async (arg) => {
      const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
      const n = await p.frame(arg);
      await p.settle(n);
      const s = p.last(n);
      if (s === null) throw new Error('no summary');
      return { n, s };
    },
    { spec, series: lineData(), w: { fromMs: T0, toMs: T1 }, size: SIZE, dpr: DPR },
  );
}

/** `call(n, m, arg)`, then settles; the summary. */
async function call(page: Page, n: number, m: string, arg: unknown): Promise<FrameSummary> {
  return page.evaluate(
    async ({ n, m, arg }) => {
      const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
      p.call(n, m, arg);
      await p.settle(n);
      const s = p.last(n);
      if (s === null) throw new Error('no summary');
      return s;
    },
    { n, m, arg },
  );
}

/** Polls the summary until `ok`, then settles; that summary. */
async function until(
  page: Page,
  n: number,
  ok: (s: FrameSummary) => boolean,
  what: string,
): Promise<FrameSummary> {
  const got: { s: FrameSummary | null } = { s: null };
  await expect
    .poll(
      async () => {
        got.s = await page.evaluate(async (n) => {
          const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
          await p.settle(n);
          return p.last(n);
        }, n);
        return got.s !== null && ok(got.s);
      },
      { message: what, timeout: 10_000 },
    )
    .toBe(true);
  if (got.s === null) throw new Error(what);
  return got.s;
}

const marker = (id: string, atMs: number): EventMarker => ({
  id,
  atMs,
  endMs: null,
  kind: 'deploy',
  title: id,
});

async function shot(page: Page): Promise<Rgba> {
  return decodePng(
    await page.screenshot({
      scale: 'device',
      clip: { x: 0, y: 0, width: SIZE[0], height: SIZE[1] },
    }),
  );
}

const rgb = (c: string): number[] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const dark = colour.dark;
const WATCH = rgb(dark.watch);
const FAILING = rgb(dark.failing);
const MUTED = rgb(dark['text-muted']);
const BACKGROUND = rgb(dark['surface-1']);

/** The largest channel difference of pixel (x, y) from `c`. */
function dist(img: Rgba, x: number, y: number, c: number[]): number {
  const i = (y * img.w + x) * 4;
  return Math.max(...[0, 1, 2].map((k) => Math.abs((img.px[i + k] ?? 0) - (c[k] ?? 0))));
}
const ink = (img: Rgba, x: number, y: number, c: number[]): boolean => dist(img, x, y, c) <= 40;

/** The RGB of pixel (x, y). */
function pixel(img: Rgba, x: number, y: number): number[] {
  const i = (y * img.w + x) * 4;
  return [img.px[i] ?? 0, img.px[i + 1] ?? 0, img.px[i + 2] ?? 0];
}

/** The plot's device rows, inside it. */
function rowsOf(p: Plot): number[] {
  const out: number[] = [];
  for (let y = Math.ceil(p.y * DPR); y < Math.floor((p.y + p.height) * DPR); y++) out.push(y);
  return out;
}

/** Whether device column `x` has `c` ink on ≥ 90 % of the plot's rows. */
function column(img: Rgba, p: Plot, x: number, c: number[]): boolean {
  const rows = rowsOf(p);
  return rows.filter((y) => ink(img, x, y, c)).length >= 0.9 * rows.length;
}

const yOf = (s: FrameSummary, v: number): number => {
  const a = s.valueAxis;
  if (a === null) throw new Error('no value axis');
  return s.plot.y + (1 - (v - a.min) / (a.max - a.min)) * s.plot.height;
};

/**
 * The threshold of value `v` at row `round(y(v))·dpr`: `c` ink (±1 row) on every dash run
 * (`plot.x + 9k`, 5 px), and none in the gaps (4 px), away from the series' crossing at `cross`.
 */
function dashed(img: Rgba, s: FrameSummary, v: number, c: number[], cross: number): string[] {
  const r = Math.round(yOf(s, v)) * DPR;
  const right = s.plot.x + s.plot.width;
  const bad: string[] = [];
  const near = (x: number): boolean => Math.abs(x - cross) <= 4;
  for (let start = s.plot.x; start < right; start += 9) {
    for (let x = start; x < Math.min(start + 5, right); x++) {
      if (near(x)) continue;
      if (![r - 1, r, r + 1].some((y) => ink(img, x * DPR, y, c))) bad.push(`run x=${String(x)}`);
    }
    for (let x = start + 5; x < Math.min(start + 9, right); x++) {
      if (near(x)) continue;
      if (ink(img, x * DPR, r, c)) bad.push(`gap x=${String(x)}`);
    }
  }
  return bad;
}

/** Any pixel of `c` ink in the plot. */
function anyInk(img: Rgba, p: Plot, c: number[]): boolean {
  for (const y of rowsOf(p)) {
    for (let x = Math.floor(p.x * DPR); x < Math.ceil((p.x + p.width) * DPR); x++) {
      if (ink(img, x, y, c)) return true;
    }
  }
  return false;
}

test.describe('e2e:engine-layer', () => {
  test('L1 ADR-0022: threshold lines widen the auto domain and are drawn dashed', async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const want = fixture('probe-thresholds');
      const { n, s } = await S(page, THRESHOLDS);
      expect(s.valueAxis).toEqual({ ...want.domain, manual: false });
      expect(s.valueAxis?.max).toBeGreaterThanOrEqual(40);
      expect(s.plot).toEqual(want.plot);
      // The series (30·i/60) crosses 20 at i = 40.
      const cross = s.plot.x + (40 / 60) * s.plot.width;
      await expect
        .poll(async () => [...dashed(await shot(page), s, 20, WATCH, cross)].slice(0, 5), {
          message: 'the watch line at 20',
          timeout: 10_000,
        })
        .toEqual([]);
      // Pinned to 0..30: the 40 line is outside the plot and not drawn; the 20 line moves.
      const pinned = { ...THRESHOLDS, valueRange: { min: 0, max: 30 } };
      await call(page, n, 'setSpec', pinned);
      const sp = await until(page, n, (x) => x.valueAxis?.max === 30, 'the pin');
      await expect
        .poll(
          async () => {
            const img = await shot(page);
            return {
              failing: anyInk(img, sp.plot, FAILING),
              watch: dashed(img, sp, 20, WATCH, cross).slice(0, 5),
            };
          },
          { message: 'under the pin', timeout: 10_000 },
        )
        .toEqual({ failing: false, watch: [] });
    });
  });

  test('L2 ADR-0023: the event band and an event line; a shown hover is cleared at the flip', async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const want = fixture('probe-event');
      const { n, s: s0 } = await S(page);
      const px = Math.round(s0.plot.x + 0.3 * s0.plot.width);
      const py = Math.round(s0.plot.y + 0.5 * s0.plot.height);
      const hovers = await page.evaluate(
        async ({ n, px, py }) => {
          const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
          p.pointer(n, 'pointermove', px, py);
          await p.settle(n);
          return p.hovers(n);
        },
        { n, px, py },
      );
      expect(hovers.at(-1)).toBeTruthy();
      await call(page, n, 'setEvents', [marker('e', T0 + 1_800_000)]);
      const s = await until(page, n, (x) => x.plot.y !== s0.plot.y, 'the band');
      expect(s.plot).toEqual(want.plot);
      expect(s.plot.y).toBe(s0.plot.y + 18);
      expect(s.thresholdLabels).toEqual([]);
      expect(s.eventLabels).toEqual([]);
      const after = await page.evaluate(
        (n) => (window as unknown as { __dashProbe: Probe }).__dashProbe.hovers(n),
        n,
      );
      expect(after.at(-1)).toBeNull();
      const x = Math.round(s.plot.x + 0.5 * s.plot.width) * DPR;
      await expect
        .poll(async () => column(await shot(page), s.plot, x, MUTED), {
          message: `the event column ${String(x)}`,
          timeout: 10_000,
        })
        .toBe(true);
      await call(page, n, 'setEvents', []);
      const back = await until(page, n, (x) => x.plot.y === s0.plot.y, 'no band');
      expect(back.plot).toEqual(s0.plot);
    });
  });

  test('L3 ADR-0030: event lines follow the camera through a wheel zoom', async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n, s: s0 } = await S(page);
      const at = T0 + 1_800_000;
      await call(page, n, 'setEvents', [marker('e', at)]);
      const s1 = await until(page, n, (x) => x.plot.y !== s0.plot.y, 'the band');
      const p = {
        x: Math.round(s1.plot.x + 0.3 * s1.plot.width),
        y: Math.round(s1.plot.y + 0.5 * s1.plot.height),
      };
      let inView = 0;
      for (let i = 0; i < 5; i++) {
        const s = await page.evaluate(
          async ({ n, p }) => {
            const pr = (window as unknown as { __dashProbe: Probe }).__dashProbe;
            pr.wheel(n, p.x, p.y, { deltaY: -200 });
            await pr.settle(n);
            return pr.last(n);
          },
          { n, p },
        );
        if (s === null) throw new Error('no summary');
        const img = await shot(page);
        const f = (at - s.fromMs) / (s.toMs - s.fromMs);
        const cols: number[] = [];
        for (
          let x = Math.floor(s.plot.x * DPR);
          x < Math.ceil((s.plot.x + s.plot.width) * DPR);
          x++
        ) {
          // A wheel's pointer may show the hover crosshair (also `text-muted`) at the anchor.
          if (Math.abs(x - p.x * DPR) > 1 && column(img, s.plot, x, MUTED)) cols.push(x);
        }
        if (f >= 0 && f <= 1) {
          inView += 1;
          const want = Math.round(s.plot.x + f * s.plot.width) * DPR;
          expect(cols.length, `step ${String(i)}: one event column`).toBeGreaterThan(0);
          for (const c of cols) {
            expect(
              Math.abs(c - want),
              `step ${String(i)}: column ${String(c)}`,
            ).toBeLessThanOrEqual(1);
          }
        } else {
          expect(cols, `step ${String(i)}: the event is out of view`).toEqual([]);
        }
      }
      expect(inView).toBeGreaterThanOrEqual(2);
    });
  });

  for (const [name, offsetMs] of [
    ['exactly at the window end', 0],
    ['1 s before the window end (rounds to the edge)', 1_000],
  ] as const) {
    test(`L5 ADR-0023: on an auto axis an event ${name} adds a line in the plot's last column only`, async ({
      page,
    }, info) => {
      test.setTimeout(120_000);
      await leg(info, async () => {
        await probePage(page, info);
        const want = fixture('events-ends-auto');
        const { n, s: s0 } = await S(page);
        // The band first, with an event out of view, so adding the edge event changes no layout.
        const away = marker('away', s0.fromMs - 3_600_000);
        await call(page, n, 'setEvents', [away]);
        const s = await until(page, n, (x) => x.plot.y !== s0.plot.y, 'the band');
        expect(s.plot).toEqual(want.plot);
        const before = await shot(page);
        await call(page, n, 'setEvents', [away, marker('edge', s0.toMs - offsetMs)]);
        const last = Math.ceil((s.plot.x + s.plot.width) * DPR) - 1;
        const rows = rowsOf(s.plot);
        const [y0, y1] = [Math.floor(s.plot.y * DPR), Math.ceil((s.plot.y + s.plot.height) * DPR)];
        await expect
          .poll(
            async () => {
              const after = await shot(page);
              const changed = new Set<number>();
              const stray: string[] = [];
              for (let y = 0; y < after.h; y++) {
                for (let x = 0; x < after.w; x++) {
                  if (dist(after, x, y, pixel(before, x, y)) === 0) continue;
                  if (x === last && y >= y0 && y < y1) changed.add(y);
                  else stray.push(`${String(x)},${String(y)}`);
                }
              }
              return {
                last: changed.size >= 0.9 * rows.length,
                stray: stray.slice(0, 5),
              };
            },
            { message: `the event ${name}`, timeout: 10_000 },
          )
          .toEqual({ last: true, stray: [] });
        // Report what lies right of the plot at its top row (no event ink: the series' cap).
        const p = pixel(before, last + 1, y0);
        console.log(
          `L5 ${name}: pixel (${String(last + 1)}, ${String(y0)}) = rgb(${p.join(', ')}); muted ${String(ink(before, last + 1, y0, MUTED))}`,
        );
      });
    });
  }

  test('L4 ADR-0023: window-end events under a pinned axis are cut to the plot', async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const want = fixture('events-ends-pinned');
      const { n, s: s0 } = await S(page, { ...LINE, valueRange: { min: 0, max: 10 } });
      await call(page, n, 'setEvents', [marker('lo', s0.fromMs), marker('hi', s0.toMs)]);
      const s = await until(page, n, (x) => x.plot.y !== s0.plot.y, 'the band');
      expect(s.plot).toEqual(want.plot);
      const left = Math.round(s.plot.x) * DPR;
      const right = Math.ceil((s.plot.x + s.plot.width) * DPR);
      await expect
        .poll(
          async () => {
            const img = await shot(page);
            const outside: string[] = [];
            for (let x = right; x < img.w; x++) {
              for (const y of rowsOf(s.plot)) {
                if (dist(img, x, y, BACKGROUND) > 2) outside.push(`${String(x)},${String(y)}`);
              }
            }
            return { left: column(img, s.plot, left, MUTED), outside: outside.slice(0, 5) };
          },
          { message: 'the window-end events', timeout: 10_000 },
        )
        .toEqual({ left: true, outside: [] });
    });
  });
});
