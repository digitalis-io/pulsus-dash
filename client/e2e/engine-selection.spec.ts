/**
 * `e2e:engine-selection` (plan #68 C2c2 §5, S1–S11, S1b, S1c; T02-025, T25-006, ADR-0025,
 * ADR-0030, ADR-0032): the shared selection on engine frames, through `__dashProbe` in the fault
 * build (`?probe=1`). Gated on `lavapipe`; the `swiftshader` leg is report-only while
 * `engine-legs.json` says so. S11 (the renderer made again, as after a device loss) runs in the
 * `probe` project, on the probe build.
 *
 * `S3()`: C2a2's probe frame with three series of 61 samples over 12:00–13:00 (a1 `30·i/60`, a2
 * `30 − 30·i/60`, a3 10), 800×240 at DPR 1. A selection is a worker message, not an input record,
 * so each check after one polls the pixels. Pixels "beside" a series are the rows whose centres lie
 * 1.5–2.5 px from its centre line: inside the 5.5 px `focus` underlay, outside the 1.5 px line.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { FrameSummary, HoverEvent, VisSpec } from '../src/engine/api.ts';
import { synthLines } from '../src/dev/synth.ts';
import { mulberry32 } from '../src/test/random.ts';
import { colour, opacity, seriesPalette } from '../src/styles/tokens.ts';
import { compareImages, decodePng, leg, nativeRender, tierOf, type Rgba } from './engine.ts';
import { GALLERY_URL, open } from './helpers.ts';

const T0 = Date.UTC(2026, 10, 19, 12);
const T1 = Date.UTC(2026, 10, 19, 13);
const MIN = 60_000;
const W = { fromMs: T0, toMs: T1 };
const LINE: VisSpec = { kind: 'line', title: 'T', unit: { kind: 'none' } };
const A1 = '00000000000000a1';
const A2 = '00000000000000a2';
const A3 = '00000000000000a3';
const DIM = opacity.dimmed;

interface ProbeSeries {
  key: string;
  t: number[];
  v: number[];
}

interface Probe {
  frame(o: unknown): Promise<number>;
  frame2d(o: unknown): Promise<number>;
  call(n: number, m: string, arg: unknown): void;
  settle(n: number): Promise<void>;
  last(n: number): FrameSummary | null;
  pointer(n: number, type: string, x: number, y: number, o?: unknown): void;
  wheel(n: number, x: number, y: number, init: unknown): boolean;
  hovers(n: number): (HoverEvent | null)[];
  renew?(): void;
}

const line = (key: string, f: (i: number) => number): ProbeSeries => {
  const t = Array.from({ length: 61 }, (_, i) => T0 + i * MIN);
  return { key, t, v: t.map((_, i) => f(i)) };
};
const S3_DATA = [
  line(A1, (i) => (30 * i) / 60),
  line(A2, (i) => 30 - (30 * i) / 60),
  line(A3, () => 10),
];

interface Setup {
  series?: ProbeSeries[];
  spec?: VisSpec;
  size?: [number, number];
  dpr?: number;
  top?: number;
  kind?: 'engine' | '2d';
}

async function probePage(page: Page, info: TestInfo): Promise<void> {
  await open(page, `${GALLERY_URL}${tierOf(info).query}&probe=1`);
  await page.waitForFunction(() => '__dashProbe' in window);
}

/** A probe frame (engine, or Canvas 2D with `kind: '2d'`), settled: its number and summary. */
async function S(page: Page, o: Setup = {}): Promise<{ n: number; s: FrameSummary }> {
  return page.evaluate(
    async ({ arg, kind }) => {
      const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
      const n = kind === '2d' ? await p.frame2d(arg) : await p.frame(arg);
      await p.settle(n);
      const s = p.last(n);
      if (s === null) throw new Error('no summary');
      return { n, s };
    },
    {
      arg: {
        spec: o.spec ?? LINE,
        series: o.series ?? S3_DATA,
        w: W,
        size: o.size ?? [800, 240],
        dpr: o.dpr ?? 1,
        top: o.top ?? 0,
      },
      kind: o.kind ?? 'engine',
    },
  );
}

/** `call(n, m, arg)`, then settles. */
async function call(page: Page, n: number, m: string, arg: unknown): Promise<void> {
  await page.evaluate(
    async ({ n, m, arg }) => {
      const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
      p.call(n, m, arg);
      await p.settle(n);
    },
    { n, m, arg },
  );
}

const select = (
  page: Page,
  n: number,
  keys: string[],
  fromMs: number | null = null,
  toMs: number | null = null,
) => call(page, n, 'setSelection', { keys, fromMs, toMs });

async function shot(page: Page, s: { w: number; h: number; top?: number }): Promise<Rgba> {
  return decodePng(
    await page.screenshot({
      scale: 'device',
      clip: { x: 0, y: s.top ?? 0, width: s.w, height: s.h },
    }),
  );
}

type C3 = [number, number, number];
const rgb = (c: string): C3 => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as C3;
const dark = colour.dark;
const BG = rgb(dark['surface-1']);
const FOCUS = rgb(dark.focus);
const MUTED = rgb(dark['text-muted']);
const seriesRgb = (key: string): C3 =>
  // `seriesColourIndex` without level labels: the low three bits of the key's last hex digit.
  rgb(seriesPalette.dark[parseInt(key.at(-1) ?? '0', 16) & 7] ?? '#000000');

function px(img: Rgba, x: number, y: number): C3 {
  const i = (y * img.w + x) * 4;
  return [img.px[i] ?? 0, img.px[i + 1] ?? 0, img.px[i + 2] ?? 0];
}
const dist = (a: C3, b: C3): number =>
  Math.max(...[0, 1, 2].map((k) => Math.abs((a[k] ?? 0) - (b[k] ?? 0))));
/** `bg + (c − bg)·a`. */
const blend = (bg: C3, c: C3, a: number): C3 =>
  [0, 1, 2].map((k) => (bg[k] ?? 0) + ((c[k] ?? 0) - (bg[k] ?? 0)) * a) as C3;
const same = (a: Rgba, b: Rgba): boolean =>
  a.px.length === b.px.length && a.px.every((v, i) => v === b.px[i]);

const xs = (s: FrameSummary, f: number): number => s.plot.x + f * s.plot.width;
function yOf(s: FrameSummary, v: number): number {
  const a = s.valueAxis;
  if (a === null) throw new Error('no value axis');
  return s.plot.y + (1 - (v - a.min) / (a.max - a.min)) * s.plot.height;
}

/** The plot rows whose pixel just inside the plot's left edge is not the background (guides). */
function guideRows(img: Rgba, s: FrameSummary, dpr: number): Set<number> {
  const x = Math.floor((s.plot.x + 2) * dpr);
  const out = new Set<number>();
  for (let y = Math.ceil(s.plot.y * dpr); y < Math.floor((s.plot.y + s.plot.height) * dpr); y++) {
    if (dist(px(img, x, y), BG) > 2) for (const r of [y - 1, y, y + 1]) out.add(r);
  }
  return out;
}

/** The pixel nearest `c` around CSS (x, y), off `skip` rows; null unless within ±8 (full ink). */
function full(img: Rgba, x: number, y: number, c: C3, dpr: number, skip: Set<number>) {
  let best: { x: number; y: number; d: number } | null = null;
  const [cx, cy] = [Math.floor(x * dpr), Math.round(y * dpr)];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      const [xx, yy] = [cx + dx, cy + dy];
      if (skip.has(yy)) continue;
      const d = dist(px(img, xx, yy), c);
      if (best === null || d < best.d) best = { x: xx, y: yy, d };
    }
  }
  return best !== null && best.d <= 8 ? best : null;
}

/** The S1 checks on `img` against the base `b`: a list of failures (empty: pass). */
function s1(img: Rgba, b: Rgba, s: FrameSummary): string[] {
  const bad: string[] = [];
  const skip = guideRows(b, s, 1);
  const [a1, a2] = [seriesRgb(A1), seriesRgb(A2)];
  for (const f of [15.5 / 60, 15 / 60]) {
    const p = full(b, xs(s, f), yOf(s, 30 * f), a1, 1, skip);
    if (p === null) {
      bad.push(`no full a1 pixel at ${String(f)}`);
      continue;
    }
    const want = blend(BG, a1, DIM);
    if (dist(px(img, p.x, p.y), want) > 8)
      bad.push(
        `a1 (${String(p.x)}, ${String(p.y)}) = ${String(px(img, p.x, p.y))}, want ${String(want)}`,
      );
  }
  const f = 15.5 / 60;
  const ya2 = yOf(s, 30 - 30 * f);
  const p2 = full(b, xs(s, f), ya2, a2, 1, skip);
  if (p2 === null) return [...bad, 'no full a2 pixel'];
  if (dist(px(img, p2.x, p2.y), a2) > 8) bad.push(`a2 = ${String(px(img, p2.x, p2.y))}`);
  // Within five columns of that pixel, a pure `focus` pixel 1.5–2.5 px from a2's centre line.
  const beside: string[] = [];
  let found = false;
  for (let x = p2.x - 2; x <= p2.x + 2; x++) {
    const ya = yOf(s, 30 - (30 * (x + 0.5 - s.plot.x)) / s.plot.width);
    for (let r = Math.floor(ya) - 3; r <= Math.ceil(ya) + 3; r++) {
      const d = Math.abs(r + 0.5 - ya);
      if (d < 1.5 || d > 2.5) continue;
      beside.push(`${String(x)},${String(r)}=${String(px(img, x, r))}`);
      if (dist(px(img, x, r), FOCUS) <= 8) found = true;
    }
  }
  if (!found) bad.push(`no focus beside a2: ${beside.join(' ')}`);
  return bad;
}

/** Polls `check` on a fresh screenshot until it returns no failure. */
async function pollShot(
  page: Page,
  size: { w: number; h: number; top?: number },
  check: (img: Rgba) => string[],
  what: string,
): Promise<Rgba> {
  const got: { img: Rgba | null } = { img: null };
  await expect
    .poll(
      async () => {
        got.img = await shot(page, size);
        return check(got.img).slice(0, 5);
      },
      { message: what, timeout: 10_000 },
    )
    .toEqual([]);
  if (got.img === null) throw new Error(what);
  return got.img;
}

const SIZE = { w: 800, h: 240 };

function pick<T>(a: readonly T[], i: number): T {
  const v = a[i];
  if (v === undefined) throw new Error(`no item ${String(i)}`);
  return v;
}

/**
 * line-50's series and spec: `dev/gallery.ts`'s entry 1 (seed `GALLERY_SEED + 1`, 50 series of
 * 1 440 points, base 180, amplitude 40), as probe series. The gallery module itself loads CSS
 * modules, which Node cannot, so its arguments are repeated here.
 */
function line50(): ProbeSeries[] {
  return synthLines({
    seed: 20_261_121,
    series: 50,
    points: 1_440,
    ...W,
    name: 'http_request_duration_ms',
    base: 180,
    amp: 40,
  }).map((x) => ({ key: x.key, t: [...x.timestamps], v: [...x.values] }));
}
const LINE50_SPEC = (): VisSpec => ({
  kind: 'line',
  title: 'T',
  unit: { kind: 'time', base: 'ms' },
});

/** Per device column, the [min, max] device row of `s`'s polyline (CSS → device at `dpr`). */
function rowsOfSeries(s: ProbeSeries, f: FrameSummary, dpr: number): Map<number, [number, number]> {
  const out = new Map<number, [number, number]>();
  const x = (t: number): number =>
    (f.plot.x + ((t - W.fromMs) / (W.toMs - W.fromMs)) * f.plot.width) * dpr;
  for (let k = 0; k + 1 < s.t.length; k++) {
    const [ta, tb, va, vb] = [s.t[k] ?? 0, s.t[k + 1] ?? 0, s.v[k] ?? 0, s.v[k + 1] ?? 0];
    if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
    const [xa, xb] = [x(ta), x(tb)];
    for (let c = Math.floor(Math.min(xa, xb)); c <= Math.ceil(Math.max(xa, xb)); c++) {
      const u = xb === xa ? 0 : Math.min(1, Math.max(0, (c + 0.5 - xa) / (xb - xa)));
      const y = yOf(f, va + (vb - va) * u) * dpr;
      const r = out.get(c);
      out.set(c, r === undefined ? [y, y] : [Math.min(r[0], y), Math.max(r[1], y)]);
    }
  }
  return out;
}

/** Whether device pixel (c, r) lies within `pad` px of the footprint. */
function nearRows(m: Map<number, [number, number]>, c: number, r: number, pad: number): boolean {
  for (let dc = -pad; dc <= pad; dc++) {
    const v = m.get(c + dc);
    if (v !== undefined && r + 0.5 >= v[0] - pad && r + 0.5 <= v[1] + pad) return true;
  }
  return false;
}

/** The line-50 frames of S1b and S10 on a pinned axis: `k` selected (R) and the others alone (L). */
async function denseFrames(
  page: Page,
  o: {
    kind: 'engine' | '2d';
    dpr: number;
    top: number;
    key: string;
    pin: { min: number; max: number };
  },
) {
  const all = line50();
  const spec = { ...LINE50_SPEC(), valueRange: o.pin } as VisSpec;
  const size: [number, number] = [1118, 240];
  const r = await S(page, { kind: o.kind, series: all, spec, size, dpr: o.dpr, top: o.top });
  const l = await S(page, {
    kind: o.kind,
    series: all.filter((x) => x.key !== o.key),
    spec,
    size,
    dpr: o.dpr,
    top: o.top + 250,
  });
  await select(page, r.n, [o.key]);
  return { r, l, all, size };
}

/** `|R − (bg + (L − bg)·0.35)|` at each pixel: the failures over `tol`, and the mean alpha. */
function dimRule(R: Rgba, L: Rgba, pts: [number, number][], tol: number) {
  const bad: string[] = [];
  let sum = 0;
  for (const [x, y] of pts) {
    const [l, r] = [px(L, x, y), px(R, x, y)];
    const want = blend(BG, l, DIM);
    if (dist(r, want) > tol)
      bad.push(`(${String(x)}, ${String(y)}): ${String(r)} want ${want.map(Math.round).join(',')}`);
    const ink = [0, 1, 2].reduce((a, k) => a + Math.abs((l[k] ?? 0) - (BG[k] ?? 0)), 0);
    const got = [0, 1, 2].reduce((a, k) => a + Math.abs((r[k] ?? 0) - (BG[k] ?? 0)), 0);
    sum += got / ink;
  }
  return { bad, mean: sum / Math.max(1, pts.length) };
}

test.describe('e2e:engine-selection', () => {
  test.beforeEach(({ browserName }, info) => {
    test.skip(browserName !== 'chromium', 'the engine projects are Chromium');
    test.skip(info.project.name === 'probe' && !info.title.startsWith('S11'), 'S11 only in probe');
    test.skip(info.project.name !== 'probe' && info.title.startsWith('S11'), 'S11 runs in probe');
  });

  test('S1 T02-025, T25-006: the unmatched series dimmed, the matched one over its focus underlay', async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n, s } = await S(page);
      const base = await shot(page, SIZE);
      await select(page, n, [A2]);
      await pollShot(page, SIZE, (img) => s1(img, base, s), 'S1 pixels');
      const after = await page.evaluate(
        (n) => (window as unknown as { __dashProbe: Probe }).__dashProbe.last(n),
        n,
      );
      expect(after).toEqual(s);
    });
  });

  test('S1b ADR-0032: dense unmatched series dim together: one composite of their image', async ({
    page,
  }, info) => {
    test.setTimeout(180_000);
    await leg(info, async () => {
      await probePage(page, info);
      const probe = await S(page, { series: line50(), spec: LINE50_SPEC(), size: [1118, 240] });
      const pin = { min: probe.s.valueAxis?.min ?? 0, max: probe.s.valueAxis?.max ?? 1 };
      const key = line50()[1]?.key ?? '';
      const { r, l, all } = await denseFrames(page, { kind: 'engine', dpr: 1, top: 300, key, pin });
      const L = await shot(page, { w: 1118, h: 240, top: 550 });
      const skip = guideRows(L, l.s, 1);
      const m = rowsOfSeries(pick(all, 1), r.s, 1);
      const rnd = mulberry32(0xc2c2);
      const pts: [number, number][] = [];
      for (let guard = 0; pts.length < 400 && guard < 200_000; guard++) {
        const x = Math.floor(r.s.plot.x + rnd() * r.s.plot.width);
        const y = Math.floor(r.s.plot.y + rnd() * r.s.plot.height);
        if (skip.has(y) || nearRows(m, x, y, 5)) continue;
        if (dist(px(L, x, y), BG) < 20) continue;
        pts.push([x, y]);
      }
      expect(pts.length).toBe(400);
      await pollShot(
        page,
        { w: 1118, h: 240, top: 300 },
        (R) => {
          const d = dimRule(R, L, pts, 6);
          return Math.abs(d.mean - DIM) <= 0.02
            ? d.bad
            : [...d.bad, `mean alpha ${String(d.mean)}`];
        },
        'S1b: the dim rule',
      );
    });
  });

  for (const dpr of [1, 2]) {
    test(`S10 ADR-0032: where dimmed series cross, the engine and Canvas 2D both composite once (DPR ${String(dpr)})`, async ({
      browser,
    }, info) => {
      test.setTimeout(240_000);
      // The page at the frame's DPR, four 240 px frames one above the other.
      const context = await browser.newContext({
        deviceScaleFactor: dpr,
        viewport: { width: 1440, height: 1000 },
      });
      const page = await context.newPage();
      try {
        await leg(info, async () => {
          await probePage(page, info);
          const probe = await S(page, { series: line50(), spec: LINE50_SPEC(), size: [1118, 240] });
          const pin = { min: probe.s.valueAxis?.min ?? 0, max: probe.s.valueAxis?.max ?? 1 };
          const key = line50()[1]?.key ?? '';
          const e = await denseFrames(page, { kind: 'engine', dpr, top: 0, key, pin });
          const c = await denseFrames(page, { kind: '2d', dpr, top: 500, key, pin });
          const box = (top: number) => ({ w: 1118, h: 240, top });
          // Crossings: rows within 0.5 px of two unmatched series' lines, off the matched one.
          const others = e.all.filter((x) => x.key !== key).map((x) => rowsOfSeries(x, e.r.s, dpr));
          const m = rowsOfSeries(pick(e.all, 1), e.r.s, dpr);
          const rnd = mulberry32(0x5100 + dpr);
          const pts: [number, number][] = [];
          const LE = await shot(page, box(250));
          const skip = guideRows(LE, e.l.s, dpr);
          for (let guard = 0; pts.length < 20 && guard < 400_000; guard++) {
            const x = Math.floor((e.r.s.plot.x + rnd() * e.r.s.plot.width) * dpr);
            const y = Math.floor((e.r.s.plot.y + rnd() * e.r.s.plot.height) * dpr);
            if (skip.has(y) || nearRows(m, x, y, 6 * dpr)) continue;
            const hits = others.filter((o) => {
              const v = o.get(x);
              return v !== undefined && y + 0.5 >= v[0] - 0.5 && y + 0.5 <= v[1] + 0.5;
            });
            if (hits.length >= 2) pts.push([x, y]);
          }
          expect(pts.length).toBe(20);
          const LC = await shot(page, box(750));
          for (const [what, top, L] of [
            ['engine', 0, LE],
            ['canvas2d', 500, LC],
          ] as const) {
            await pollShot(page, box(top), (R) => dimRule(R, L, pts, 10).bad, `S10 ${what}`);
          }
          if (dpr === 2) {
            // The Canvas 2D marks at the engine's device positions: the matched series and the crosshair.
            const [RE, RC] = [await shot(page, box(0)), await shot(page, box(500))];
            const colour = seriesRgb(key);
            const bad: string[] = [];
            for (let k = 1; k <= 10; k++) {
              const x = Math.floor((e.r.s.plot.x + (k / 11) * e.r.s.plot.width) * dpr);
              // The mean row of the matched colour's full pixels (a dense column is a span).
              const rowOf = (img: Rgba): number => {
                const rows: number[] = [];
                for (let y = 0; y < img.h; y++) if (dist(px(img, x, y), colour) <= 8) rows.push(y);
                return rows.length === 0 ? -99 : rows.reduce((a, b) => a + b, 0) / rows.length;
              };
              if (Math.abs(rowOf(RE) - rowOf(RC)) > 1)
                bad.push(`matched x ${String(x)}: ${String(rowOf(RE))} vs ${String(rowOf(RC))}`);
            }
            expect(bad).toEqual([]);
            const hx = Math.round(e.r.s.plot.x + 0.37 * e.r.s.plot.width);
            const hy = Math.round(e.r.s.plot.y + 0.5 * e.r.s.plot.height);
            for (const n of [e.r.n, c.r.n]) {
              await page.evaluate(
                async ({ n, hx, hy }) => {
                  const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
                  p.pointer(n, 'pointermove', hx, hy);
                  await p.settle(n);
                },
                { n, hx, hy },
              );
            }
            const cross = (img: Rgba, s: FrameSummary): number[] => {
              const out: number[] = [];
              for (
                let x = Math.floor(s.plot.x * dpr);
                x < Math.ceil((s.plot.x + s.plot.width) * dpr);
                x++
              ) {
                // The plot's top rows hold no series here (the hover dots and the lines cover
                // the column lower down): the crosshair is muted over all but 2 of 24 rows.
                let k = 0;
                const y0 = Math.ceil(s.plot.y * dpr) + 1;
                for (let y = y0; y < y0 + 24; y++) {
                  if (dist(px(img, x, y), MUTED) <= 40) k++;
                }
                if (k >= 22) out.push(x);
              }
              return out;
            };
            await expect
              .poll(
                async () => {
                  const a = cross(await shot(page, box(0)), e.r.s);
                  const b = cross(await shot(page, box(500)), c.r.s);
                  return a.length > 0 && b.length > 0 && Math.abs((a[0] ?? 0) - (b[0] ?? 0)) <= 1
                    ? 'ok'
                    : `engine ${a.join(',')} canvas2d ${b.join(',')}`;
                },
                { message: 'S10 crosshair columns', timeout: 10_000 },
              )
              .toBe('ok');
          }
        });
      } finally {
        await context.close();
      }
    });
  }

  test('S1c ADR-0032: dots and dense spans of an unmatched series are dimmed too, in both renderers', async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const u: ProbeSeries = {
        key: A1,
        t: [0, 5, 10, 10.02, 10.04, 10.06, 20, 29, 30, 31, 40, 60].map((m) => T0 + m * MIN),
        v: [5, 6, 2, 25, 3, 24, 8, NaN, 15, NaN, 9, 10],
      };
      const series = [u, line(A2, () => 28)];
      const spec = { ...LINE, valueRange: { min: 0, max: 30 } } as VisSpec;
      for (const [kind, top] of [
        ['engine', 0],
        ['2d', 300],
      ] as const) {
        const { n, s } = await S(page, { kind, series, spec, top });
        const box = { ...SIZE, top };
        const L = await shot(page, box);
        const pts: [number, number][] = [
          [Math.floor(xs(s, 30 / 60)), Math.floor(yOf(s, 15))],
          [Math.floor(xs(s, 10 / 60)), Math.floor(yOf(s, 13.5))],
        ];
        for (const [x, y] of pts)
          expect(
            dist(px(L, x, y), seriesRgb(A1)),
            `${kind} ink at ${String(x)},${String(y)}`,
          ).toBeLessThanOrEqual(8);
        await select(page, n, [A2]);
        await pollShot(page, box, (R) => dimRule(R, L, pts, 8).bad, `S1c ${kind}`);
      }
    });
  });

  test('S2 ADR-0025 decision 3: keys of another frame dim nothing', async ({ page }, info) => {
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n } = await S(page);
      const base = await shot(page, SIZE);
      await select(page, n, ['00000000000000ff']);
      // A band after the foreign keys: once it is drawn, the keys were applied.
      await select(page, n, ['00000000000000ff'], T0 + 70 * MIN, T0 + 80 * MIN);
      await page.waitForTimeout(500);
      expect(same(await shot(page, SIZE), base)).toBe(true);
    });
  });

  test('S3 T25-006: an interval draws the selection band over the plot', async ({ page }, info) => {
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n, s } = await S(page);
      const base = await shot(page, SIZE);
      await select(page, n, [], T0 + 10 * MIN, T0 + 20 * MIN);
      const [x0, x1] = [Math.floor(xs(s, 1 / 6)) - 1, Math.ceil(xs(s, 1 / 3)) + 1];
      const [y0, y1] = [Math.ceil(s.plot.y), Math.floor(s.plot.y + s.plot.height)];
      await pollShot(
        page,
        SIZE,
        (img) => {
          const bad: string[] = [];
          for (let y = 0; y < img.h; y++) {
            for (let x = 0; x < img.w; x++) {
              if (dist(px(img, x, y), px(base, x, y)) === 0) continue;
              if (x < x0 || x > x1 || y < y0 || y >= y1)
                bad.push(`outside ${String(x)},${String(y)}`);
            }
          }
          const mid = Math.round(xs(s, 0.25));
          let k = 0;
          for (let y = y0; y < y1; y++) if (dist(px(img, mid, y), px(base, mid, y)) > 0) k++;
          if (k < 0.9 * (y1 - y0)) bad.push(`band rows ${String(k)}/${String(y1 - y0)}`);
          return bad;
        },
        'S3 band',
      );
    });
  });

  test('S4 ADR-0030: the band follows the camera through a wheel zoom', async ({ page }, info) => {
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n, s: s0 } = await S(page);
      const [from, to] = [T0 + 10 * MIN, T0 + 20 * MIN];
      await select(page, n, [], from, to);
      const band = blend(BG, rgb(dark.accent), 0x29 / 255);
      const p = { x: Math.round(xs(s0, 0.3)), y: Math.round(s0.plot.y + 0.5 * s0.plot.height) };
      for (let i = 0; i < 3; i++) {
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
        const x = (t: number): number =>
          s.plot.x + ((t - s.fromMs) / (s.toMs - s.fromMs)) * s.plot.width;
        const left = Math.max(x(from), s.plot.x);
        const right = Math.min(x(from) + Math.max(x(to) - x(from), 1), s.plot.x + s.plot.width);
        await pollShot(
          page,
          SIZE,
          (img) => {
            const cols: number[] = [];
            for (let c = Math.floor(s.plot.x); c < Math.ceil(s.plot.x + s.plot.width); c++) {
              if (Math.abs(c - p.x) <= 1) continue;
              let k = 0;
              let all = 0;
              for (
                let y = Math.ceil(s.plot.y);
                y < Math.floor(s.plot.y + s.plot.height);
                y++, all++
              ) {
                if (dist(px(img, c, y), band) <= 6) k++;
              }
              if (k >= 0.6 * all) cols.push(c);
            }
            const [a, b] = [cols[0] ?? -99, cols.at(-1) ?? -99];
            const want = [Math.floor(left), Math.ceil(right) - 1];
            return Math.abs(a - (want[0] ?? 0)) <= 1 && Math.abs(b - (want[1] ?? 0)) <= 1
              ? []
              : [`step ${String(i)}: band ${String(a)}..${String(b)}, want ${want.join('..')}`];
          },
          `S4 step ${String(i)}`,
        );
      }
    });
  });

  test('S5 INT-033: a hover over a selection keeps its rows and full-colour dots', async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n, s } = await S(page);
      const at = { x: Math.round(xs(s, 0.25)), y: Math.round(s.plot.y + 0.5 * s.plot.height) };
      const hover = async (x: number): Promise<HoverEvent | null> =>
        page.evaluate(
          async ({ n, x, y }) => {
            const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
            p.pointer(n, 'pointermove', x, y);
            await p.settle(n);
            return p.hovers(n).at(-1) ?? null;
          },
          { n, x, y: at.y },
        );
      const h0 = await hover(at.x);
      await select(page, n, [A2]);
      await hover(at.x + 40);
      const h1 = await hover(at.x);
      expect(h1?.rows).toEqual(h0?.rows);
      const row = h1?.rows.find((r) => r.key === A1);
      if (h1 === null || row === undefined) throw new Error('no a1 row');
      const y = Math.round(yOf(s, row.value));
      await pollShot(
        page,
        SIZE,
        (img) =>
          dist(px(img, Math.round(h1.xCss), y), seriesRgb(A1)) <= 8
            ? []
            : [`dot ${String(px(img, Math.round(h1.xCss), y))}`],
        'S5 dot',
      );
    });
  });

  test('S6 ADR-0025: clearing the selection restores the frame', async ({ page }, info) => {
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n, s } = await S(page);
      const base = await shot(page, SIZE);
      await select(page, n, [A2]);
      await pollShot(page, SIZE, (img) => s1(img, base, s), 'S6: S1 first');
      await call(page, n, 'setSelection', null);
      await pollShot(page, SIZE, (img) => (same(img, base) ? [] : ['not the base']), 'S6 clear');
    });
  });

  test('S9 ADR-0025 decision 4: a2’s underlay over a1’s line where they cross', async ({
    page,
  }, info) => {
    test.setTimeout(120_000);
    await leg(info, async () => {
      await probePage(page, info);
      const { n, s } = await S(page);
      await select(page, n, [A1, A2]);
      await pollShot(
        page,
        SIZE,
        (img) => {
          const bad: string[] = [];
          let k = 0;
          for (let c = 0; c < 800; c++) {
            const f = (c + 0.5 - s.plot.x) / s.plot.width;
            if (f < 0.4 || f > 0.6) continue;
            const [ya, yb] = [yOf(s, 30 * f), yOf(s, 30 - 30 * f)];
            for (let r = 0; r < 240; r++) {
              const rc = r + 0.5;
              const d = Math.abs(rc - yb);
              if (Math.abs(rc - ya) <= 0.75 && d >= 1.4 && d <= 2.2) {
                k++;
                if (dist(px(img, c, r), FOCUS) > 8)
                  bad.push(`(${String(c)}, ${String(r)}) = ${String(px(img, c, r))}`);
              }
            }
          }
          return k >= 2 ? bad : [...bad, `${String(k)} pixels`];
        },
        'S9 crossing',
      );
    });
  });

  test('S7 T05-005: the selection against the native renderer', async ({ page }, info) => {
    test.setTimeout(180_000);
    await leg(info, async () => {
      await probePage(page, info);
      const series = line50();
      const key = series[3]?.key ?? '';
      const { n } = await S(page, { series, spec: LINE50_SPEC(), size: [1118, 240] });
      await select(page, n, [key], T0 + 10 * MIN, T0 + 20 * MIN);
      const base = await shot(page, { w: 1118, h: 240 });
      const want = info.outputPath('s7-native.png');
      const tier = tierOf(info);
      nativeRender({
        page: 'line-50',
        theme: 'dark',
        css: [1118, 240],
        dpr: 1,
        tier: tier.engine === 'wasm-webgl2' ? 't2' : 't1',
        out: want,
        select: { keys: [key], interval: [T0 + 10 * MIN, T0 + 20 * MIN] },
      });
      const got = info.outputPath('s7-browser.png');
      let r = { code: -1, out: '' };
      await expect
        .poll(
          async () => {
            const { writeFileSync } = await import('node:fs');
            writeFileSync(
              got,
              await page.screenshot({
                scale: 'device',
                clip: { x: 0, y: 0, width: 1118, height: 240 },
              }),
            );
            r = compareImages(want, got, { max: 0.001, tileMax: 0.05 });
            return r.code;
          },
          { message: 'S7 vs native', timeout: 10_000 },
        )
        .toBe(0);
      expect(r.out).not.toBe('');
      expect(base.w).toBe(1118);
    });
  });

  test('S11 §3.3: after the renderer is made again (as after a device loss), S1 holds', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await open(page, `${GALLERY_URL}&engine=wasm&mode=t2&probe=1`);
    await page.waitForFunction(() => '__dashProbe' in window);
    const { n, s } = await S(page);
    const base = await shot(page, SIZE);
    await select(page, n, [A2]);
    await pollShot(page, SIZE, (img) => s1(img, base, s), 'S11 before');
    await page.evaluate(() => {
      const p = (window as unknown as { __dashProbe: Probe }).__dashProbe;
      if (p.renew === undefined) throw new Error('no renew');
      p.renew();
    });
    await page.waitForTimeout(300);
    await pollShot(page, SIZE, (img) => s1(img, base, s), 'S11 after');
  });
});
