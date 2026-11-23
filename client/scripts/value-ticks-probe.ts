/**
 * The bounded value-ticks probe (#97 plan §3.3): runs the interim `valueTicks` in a child process
 * so `valueTicks.bounded.test.ts` can kill a search that never finishes instead of hanging the run.
 * Prints one JSON line on stdout and exits 0; non-finite numbers are written as "NaN", "Infinity"
 * and "-Infinity". Bad arguments exit with 2.
 *
 *   node scripts/value-ticks-probe.ts ticks <min> <max> <height> <label> <base>
 *   node scripts/value-ticks-probe.ts prop <seed> <n>
 *   node scripts/value-ticks-probe.ts draw
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLIENT_ROOT, GALLERY_WINDOW, registerClientHooks } from './engine-fixtures.ts';

interface Ticks {
  readonly min: number;
  readonly max: number;
  readonly ticks: readonly number[];
}

interface TicksModule {
  valueTicks: (min: number, max: number, h: number, label: number, base: 1000 | 1024) => Ticks;
  niceValueTicks: (
    min: number,
    max: number,
    h: number,
    label: number,
    base: 1000 | 1024,
  ) => Ticks | null;
  tickY: (v: number, min: number, max: number, top: number, height: number) => number;
}

interface Op {
  readonly op: string;
  readonly args: readonly unknown[];
  readonly fillStyle: string;
  readonly strokeStyle: string;
  readonly textAlign: string;
}

interface Plot {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const USAGE =
  'usage: node scripts/value-ticks-probe.ts ticks <min> <max> <height> <label> <base> | prop <seed> <n> | draw';

const mod = async (p: string): Promise<Record<string, unknown>> =>
  (await import(pathToFileURL(join(CLIENT_ROOT, 'src', p)).href)) as Record<string, unknown>;

function print(v: unknown): void {
  const replacer = (_k: string, x: unknown): unknown => {
    if (typeof x !== 'number' || Number.isFinite(x)) return x;
    return Number.isNaN(x) ? 'NaN' : x > 0 ? 'Infinity' : '-Infinity';
  };
  console.log(JSON.stringify(v, replacer));
}

async function ticksMode(args: readonly string[]): Promise<number> {
  if (args.length !== 5) return 2;
  const [min, max, height, label, base] = args.map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (base !== 1000 && base !== 1024) return 2;
  const t = (await mod('engine/canvas2d/valueTicks.ts')) as unknown as TicksModule;
  const vt = t.valueTicks(min, max, height, label, base);
  const y = vt.ticks.map((v) => t.tickY(v, vt.min, vt.max, 0, height));
  print({ min: vt.min, max: vt.max, ticks: vt.ticks, y });
  return 0;
}

/** §4.5: the §3.5 generator on mulberry32(seed), checked against P1 to P7. */
async function propMode(args: readonly string[]): Promise<number> {
  if (args.length !== 2) return 2;
  const [seed, n] = args.map(Number) as [number, number];
  if (!Number.isInteger(seed) || !Number.isInteger(n) || n < 0) return 2;
  const t = (await mod('engine/canvas2d/valueTicks.ts')) as unknown as TicksModule;
  const { mulberry32 } = (await mod('test/random.ts')) as {
    mulberry32: (s: number) => () => number;
  };
  const r = mulberry32(seed);
  const GAP = 16;
  const violations: string[] = [];
  let cases = 0;
  let fallbacks = 0;
  while (cases < n) {
    const mag = 10 ** (-330 + 640 * r());
    const a = (r() - 0.3) * mag;
    const equal = r() < 0.1;
    const scale = equal ? 0 : r();
    const narrow = equal ? false : r() >= 0.5;
    const b = equal ? a : a + scale * mag * (narrow ? 1e-6 : 1);
    const h = Math.floor(r() * 8001);
    const base = r() < 0.3 ? 1024 : 1000;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;
    cases += 1;
    const fb = t.niceValueTicks(lo, hi, h, 14, base) === null;
    if (fb) fallbacks += 1;
    const v = t.valueTicks(lo, hi, h, 14, base);
    const rel = hi / 2 - lo / 2 >= 5e-10 * Math.max(Math.abs(lo), Math.abs(hi));
    const bad: string[] = [];
    const k = v.ticks.length;
    if (!(k >= 1 && k <= 10_001) || (h >= GAP && k < 2)) bad.push('P1');
    if (![v.min, v.max, ...v.ticks].every(Number.isFinite)) bad.push('P2');
    if (v.ticks.some((x, i) => i > 0 && !(x > (v.ticks[i - 1] ?? NaN)))) bad.push('P3');
    if ((rel || fb) && !(v.min <= lo && v.max >= hi)) bad.push('P4');
    if (fb && k >= 2 && v.ticks[0] !== v.min) bad.push('P5');
    for (const top of [0, 8]) {
      for (let i = 1; i < k; i++) {
        const y0 = t.tickY(v.ticks[i - 1] ?? NaN, v.min, v.max, top, h);
        const y1 = t.tickY(v.ticks[i] ?? NaN, v.min, v.max, top, h);
        const d = y0 - y1;
        const ok =
          Number.isFinite(y0) && Number.isFinite(y1) && Number.isFinite(d) && d >= GAP * (1 - 1e-9);
        if (!ok && !bad.includes('P6')) bad.push('P6');
      }
    }
    if (k - 1 > Math.floor(h / GAP)) bad.push('P7');
    if (bad.length > 0 && violations.length < 10) {
      violations.push(
        `${bad.join(',')}: ${String(lo)}..${String(hi)} h ${String(h)} b ${String(base)} -> ${JSON.stringify(v)}`,
      );
    }
  }
  print({ cases, fallbacks, violations });
  return 0;
}

/** §3.3: the `line-extreme` gallery entry drawn on a recording context. */
async function drawMode(args: readonly string[]): Promise<number> {
  if (args.length !== 0) return 2;
  const { drawLayer } = (await mod('engine/canvas2d/draw.ts')) as {
    drawLayer: (i: Record<string, unknown>) => {
      summary: { valueAxis: unknown; plot: Plot };
    };
  };
  const { themeColours, seriesColourIndex } = (await mod('engine/canvas2d/palette.ts')) as {
    themeColours: (t: string) => { series: readonly string[] };
    seriesColourIndex: (s: unknown) => number;
  };
  const { recordingContext } = (await mod('test/recordingContext.ts')) as {
    recordingContext: () => { ops: Op[] };
  };
  const { galleryEntries } = (await mod('dev/gallery.ts')) as {
    galleryEntries: (w: typeof GALLERY_WINDOW) => {
      id: string;
      spec: unknown;
      data: { series: readonly unknown[] };
    }[];
  };
  const entry = galleryEntries(GALLERY_WINDOW).find((e) => e.id === 'line-extreme');
  if (entry === undefined) throw new Error('gallery entry line-extreme is missing');
  const ctx = recordingContext();
  const { summary } = drawLayer({
    ctx,
    spec: entry.spec,
    data: entry.data,
    window: GALLERY_WINDOW,
    cssW: 1118,
    cssH: 240,
    timeZone: 'UTC',
    colours: themeColours('dark'),
    valueRange: null,
    band: null,
    minBand: 0,
  });
  const colour = themeColours('dark').series[seriesColourIndex(entry.data.series[0])];
  const plot = summary.plot;
  const labels = ctx.ops
    .filter((o) => o.op === 'fillText' && o.textAlign === 'right')
    .map((o) => o.args[0]);
  const path = { moveTo: 0, lineTo: 0, runs: 0, nonFinite: 0, outside: 0 };
  const seriesOps: Op[] = [];
  let inPath = false;
  for (const o of ctx.ops) {
    if (o.op === 'beginPath') inPath = o.strokeStyle === colour;
    else if (o.op === 'stroke') inPath = false;
    else if ((o.op === 'moveTo' || o.op === 'lineTo') && inPath && o.strokeStyle === colour) {
      path[o.op] += 1;
      seriesOps.push(o);
    } else if (o.op === 'fillRect' && o.fillStyle === colour) {
      path.runs += 1;
      seriesOps.push(o);
    }
  }
  for (const o of seriesOps) {
    path.nonFinite += o.args.filter((a) => !Number.isFinite(a)).length;
    const y = o.args[1];
    if (typeof y === 'number' && Number.isFinite(y)) {
      if (y < plot.y - 1 || y > plot.y + plot.height + 1) path.outside += 1;
    }
  }
  const named = new Set(['moveTo', 'lineTo', 'arc', 'rect', 'fillRect', 'fillText']);
  const nonFinite = ctx.ops
    .filter((o) => named.has(o.op))
    .flatMap((o) => o.args)
    .filter((a) => typeof a === 'number' && !Number.isFinite(a)).length;
  print({ valueAxis: summary.valueAxis, plot, labels, path, nonFinite });
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  registerClientHooks();
  const [mode, ...rest] = argv;
  const run =
    mode === 'ticks' ? ticksMode : mode === 'prop' ? propMode : mode === 'draw' ? drawMode : null;
  const code = run === null ? 2 : await run(rest);
  if (code === 2) console.error(USAGE);
  return code;
}

process.exitCode = await main(process.argv.slice(2));
