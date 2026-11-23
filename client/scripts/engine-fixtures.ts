/**
 * Writes the engine parity fixtures `engine/fixtures/*.json` (plan #68 §3.14, A.7) from the TS
 * sources of truth: `formatValue`, `valueTicks`, `layoutPlot` with draw.ts's value axis,
 * `lineColumns`, `seriesColourIndex`, `synthLines` and `frameSummary`. The Rust ports must
 * reproduce them (`unit:*-parity`). `--write` writes the files; without it the committed files are
 * compared and the exit code is 1 when one is stale (`unit:engine-fixtures` runs the same check).
 *
 * The client modules are loaded at run time (their imports are extensionless, which Node resolves
 * through the hook below and Vitest resolves itself), so this script's types describe only the
 * parts it calls. Numbers are JSON numbers; non-finite values are the strings "NaN", "Infinity" and
 * "-Infinity". Every input is seeded, so a fresh run is byte-identical.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CLIENT_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FIXTURE_DIR = join(CLIENT_ROOT, '..', 'engine', 'fixtures');

/**
 * The gallery entries of the Rust parity fixtures (`layout.json`, `synth.json`, `summary.json`), in
 * today's order (`synthRows` hashes by position). Later gallery entries (`line-thresholds`, #64
 * Part B) are not parity fixtures, so the committed fixtures stay byte-identical.
 */
export const PARITY_LINE_IDS = ['line-1', 'line-50', 'line-gaps', 'line-600'] as const;

/** The `FrameSummary` fields of the parity contract (`thresholdLabels` is TS-only, ADR-0022). */
const SUMMARY_FIELDS = [
  'kind',
  'seriesTotal',
  'seriesShown',
  'fromMs',
  'toMs',
  'min',
  'max',
  'last',
  'plot',
  'valueAxis',
] as const;

type Unit =
  | { kind: 'none' }
  | { kind: 'time'; base: 'ns' | 'us' | 'ms' | 's' }
  | { kind: 'bytes' }
  | { kind: 'percent' }
  | { kind: 'percentunit' }
  | { kind: 'suffix'; suffix: string };
interface Plot {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Window {
  fromMs: number;
  toMs: number;
}
interface Series {
  key: string;
  labels: Record<string, string>;
  timestamps: Float64Array;
  values: Float64Array;
}
interface Run {
  min: number;
  max: number;
  count: number;
}
interface Column {
  x: number;
  min: number;
  max: number;
  last: number;
  count: number;
  runs: readonly Run[];
  breakBefore: boolean;
}
interface Summary {
  kind: string;
  seriesTotal: number;
  seriesShown: number;
  fromMs: number;
  toMs: number;
  min: number | null;
  max: number | null;
  last: number | null;
  plot: Plot;
  valueAxis?: { min: number; max: number; manual: boolean } | null;
}
interface Entry {
  id: string;
  spec: { kind: string; unit: Unit };
  data: { kind: string; series?: readonly Series[] };
}

/** The client modules the fixtures come from. */
interface Sources {
  formatValue: (v: number, u: Unit) => string;
  valueTicks: (
    min: number,
    max: number,
    h: number,
    label: number,
    base: 1000 | 1024,
  ) => { min: number; max: number; ticks: readonly number[] };
  extremeTicks: (
    min: number,
    max: number,
    h: number,
    label: number,
  ) => { min: number; max: number; ticks: readonly number[] };
  layoutPlot: (kind: string, w: number, h: number, labelW: number) => Plot;
  LABEL_HEIGHT: number;
  drawLayer: (i: Record<string, unknown>) => { summary: Summary };
  MAX_SERIES: number;
  lineStats: (s: readonly Series[]) => { min: number | null; max: number | null };
  lineColumns: (ts: Float64Array, vs: Float64Array, w: Window, plot: Plot) => (Column | null)[];
  seriesColourIndex: (s: { key: string; labels: Record<string, string> }) => number;
  themeColours: (t: string) => unknown;
  hash01: (...ints: number[]) => number;
  galleryEntries: (w: Window, seed?: number) => Entry[];
  font: { size: { xs: number }; advance: { mono: number } };
}

/**
 * Node: resolve the client's extensionless relative imports to their `.ts` files, and load a CSS
 * module (`*.module.css`, e.g. `theme/stateEncoding.module.css`) as a proxy whose every class name
 * is its key, so `StateEncoding` loads outside Vite. Also used by `threshold-draw-probe.ts`.
 */
export function registerClientHooks(): void {
  registerHooks({
    load(url, context, next) {
      if (url.endsWith('.module.css')) {
        return {
          format: 'module',
          shortCircuit: true,
          source: 'export default new Proxy({}, { get: (_, k) => String(k) });',
        };
      }
      return next(url, context);
    },
    resolve(specifier, context, next) {
      if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        try {
          return next(`${specifier}.ts`, context);
        } catch {
          return next(specifier, context);
        }
      }
      return next(specifier, context);
    },
  });
}

async function load(): Promise<Sources> {
  const mod = async (p: string): Promise<Record<string, unknown>> =>
    (await import(pathToFileURL(join(CLIENT_ROOT, 'src', p)).href)) as Record<string, unknown>;
  const parts = await Promise.all(
    [
      'i18n/format.ts',
      'engine/canvas2d/valueTicks.ts',
      'engine/canvas2d/layout.ts',
      'engine/canvas2d/draw.ts',
      'engine/canvas2d/summary.ts',
      'engine/canvas2d/columns.ts',
      'engine/canvas2d/palette.ts',
      'dev/synth.ts',
      'dev/gallery.ts',
      'styles/tokens.ts',
    ].map(mod),
  );
  return Object.assign({}, ...parts) as Sources;
}

/** 2026-11-19 12:00–13:00 UTC, the gallery's e2e window. */
export const GALLERY_WINDOW: Window = { fromMs: 1_795_089_600_000, toMs: 1_795_093_200_000 };

function num(v: number): number | string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return 'Infinity';
  if (v === -Infinity) return '-Infinity';
  return v;
}

/** Non-finite numbers become strings; one row per line so diffs stay readable. */
function json(rows: readonly unknown[]): string {
  const replacer = (_k: string, v: unknown): unknown => (typeof v === 'number' ? num(v) : v);
  return `[\n${rows.map((r) => JSON.stringify(r, replacer)).join(',\n')}\n]\n`;
}

/** A seeded stream in [0, 1). */
function stream(s: Sources, seed: number): () => number {
  let i = 0;
  return () => s.hash01(seed, i++);
}

const UNITS: readonly Unit[] = [
  { kind: 'none' },
  { kind: 'suffix', suffix: 'rps' },
  { kind: 'bytes' },
  { kind: 'percent' },
  { kind: 'percentunit' },
  { kind: 'time', base: 'ns' },
  { kind: 'time', base: 'us' },
  { kind: 'time', base: 'ms' },
  { kind: 'time', base: 's' },
];

function formatRows(s: Sources): unknown[] {
  const r = stream(s, 1);
  const special = [0, NaN, Infinity, -Infinity, 1.125, 0.0125, 99.95, 999.5, 1e21, 1e-7, 1];
  const ties = [0.125, 2.675, 1.005, 999.95, 9.995, 0.9995, 1023.5, 59.95, 3599.5, 86399.5];
  const values: number[] = [...special, ...ties, ...ties.map((t) => -t)];
  while (values.length < 2000) {
    const mag = 10 ** (-12 + 36 * r());
    const sign = r() < 0.2 ? -1 : 1;
    const digits = 1 + Math.floor(r() * 4);
    values.push(r() < 0.3 ? Number((mag * sign).toPrecision(digits)) : mag * sign);
  }
  return values.flatMap((v) => UNITS.map((unit) => ({ v, unit, out: s.formatValue(v, unit) })));
}

/** `base ** p` as the JS engine computes it (`valueTicks` uses 10 ** k, 1000 ** p, 1024 ** p). */
function powRows(): unknown[] {
  const rows: unknown[] = [];
  for (let k = -340; k <= 308; k++) rows.push({ base: 10, p: k, v: 10 ** k });
  for (const base of [1000, 1024])
    for (let p = 0; p <= 102; p++) rows.push({ base, p, v: base ** p });
  return rows;
}

function ticksRows(s: Sources): unknown[] {
  const r = stream(s, 2);
  const rows: unknown[] = [];
  while (rows.length < 500) {
    const mag = 10 ** (-12 + 312 * r() ** 2);
    const a = (r() - 0.3) * mag;
    const b = r() < 0.1 ? a : a + r() * mag * (r() < 0.5 ? 1 : 1e-6);
    const [min, max] = a <= b ? [a, b] : [b, a];
    // These skips predate #97, when valueTicks did not terminate on such domains (plan #68 §8
    // R10); they stay so the rows stay stable. The near-limit domains are in ticks-extreme.json.
    if (Math.max(Math.abs(min), Math.abs(max)) > 1e300) continue;
    if (min === max && min + 1 === min) continue;
    // Heights start at 40 px, so no row thins below 2 · (label + 2) px (ticks-extreme.json has those).
    const height = Math.floor(40 + r() * 1200);
    const label = 14;
    const base = r() < 0.3 ? 1024 : 1000;
    rows.push({ min, max, height, label, base, out: s.valueTicks(min, max, height, label, base) });
  }
  return rows;
}

const M = Number.MAX_VALUE;
const H = M / 2;

/** #97 plan §5 A1 to A30, A33 and A34: [min, max, height, base]. */
const TICKS_EXTREME_FIXED: readonly (readonly [number, number, number, 1000 | 1024])[] = [
  [-M, M, 200, 1000],
  [H, M, 200, 1000],
  [-M, -H, 200, 1000],
  [-M, 1, 200, 1000],
  [-1e308, 1e308, 200, 1000],
  [1e17, 1e17, 200, 1000],
  [-1e17, -1e17, 200, 1000],
  [M, M, 200, 1000],
  [-M, -M, 200, 1000],
  [0, 5e-324, 200, 1000],
  [5e-324, 1e-323, 200, 1000],
  [-5e-324, 5e-324, 200, 1000],
  [-1.7e-6, 4e-6, 21, 1024],
  [-1, 1, 0, 1000],
  [0, M, 200, 1024],
  [0, 1e301, 200, 1000],
  [0, 0, 200, 1000],
  [-1e300, 1e300, 200, 1000],
  [1e-310, 3e-310, 200, 1000],
  [5e-324, 5e-324, 200, 1000],
  [-M, M, 32, 1000],
  [-M, M, 31.5, 1000],
  [-M, M, 16, 1000],
  [-M, M, 15.5, 1000],
  [1, M, 15.5, 1000],
  [-M, -1, 15.5, 1000],
  [0, 1, 16, 1000],
  [0, 1, 15.5, 1000],
  [-3, 1, 10, 1000],
  [0, 1, 40, 1000],
  [1, 1 + 1e-11, 200, 1000],
  [2615306150439.0483, 2615306150439.0483, 1026, 1000],
];

/** #97 plan §3.5 X1 to X8: `extremeTicks` rows, [min, max, height]. */
const TICKS_EXTREME_FIT: readonly (readonly [number, number, number])[] = [
  [0, 3 * Number.MIN_VALUE, 32],
  [0, 3 * Number.MIN_VALUE, 48],
  [0, 3 * Number.MIN_VALUE, 47.5],
  [-2, 6, 32],
  [-2, 6, 31.9],
  [-2, 6, 15.9],
  [-M, M, 32],
  [-M, M, 31.5],
];

/** A positive double stepped by `d` ulps, through its bits. */
function adj(x: number, d: number): number {
  const f = new Float64Array([x]);
  const u = new BigUint64Array(f.buffer);
  u[0] = (u[0] ?? 0n) + BigInt(d);
  return f[0] ?? NaN;
}

/**
 * `ticks-extreme.json` (#97 plan §3.5): the fixed rows, the fallback-fit rows, the `log`/`**` edge
 * rows and 300 seeded rows over the whole finite range, short plots included.
 */
function ticksExtremeRows(s: Sources): unknown[] {
  const label = 14;
  const vt = (min: number, max: number, height: number, base: 1000 | 1024): unknown => ({
    fn: 'valueTicks',
    min,
    max,
    height,
    label,
    base,
    out: s.valueTicks(min, max, height, label, base),
  });
  const rows: unknown[] = TICKS_EXTREME_FIXED.map(([min, max, h, base]) => vt(min, max, h, base));
  for (const [min, max, height] of TICKS_EXTREME_FIT) {
    rows.push({
      fn: 'extremeTicks',
      min,
      max,
      height,
      label,
      base: null,
      out: s.extremeTicks(min, max, height, label),
    });
  }
  for (const base of [1000, 1024] as const) {
    for (const p of [1, 2, 5, 10, 50, 100]) {
      const x = base ** p;
      for (const hi of [adj(x, -1), x, adj(x, 1)]) rows.push(vt(0, hi, 200, base));
    }
  }
  for (const k of [-300, -12, -1, 0, 1, 12, 299]) {
    const x = 5 * 10 ** k;
    for (const hi of [adj(x, -1), x, adj(x, 1)]) rows.push(vt(0, hi, 200, 1000));
  }
  const r = stream(s, 9);
  let seeded = 0;
  while (seeded < 300) {
    const mag = 10 ** (-330 + 640 * r());
    const a = (r() - 0.3) * mag;
    const equal = r() < 0.1;
    const scale = equal ? 0 : r();
    const narrow = equal ? false : r() >= 0.5;
    const b = equal ? a : a + scale * mag * (narrow ? 1e-6 : 1);
    const height = Math.floor(r() * 1240);
    const base = r() < 0.3 ? 1024 : 1000;
    const [min, max] = a <= b ? [a, b] : [b, a];
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    rows.push(vt(min, max, height, base));
    seeded += 1;
  }
  return rows;
}

/** A recording 2D context: label widths from the §3.5 formula (monospace advance). */
function fakeCtx(s: Sources, labels: string[]): Record<string, unknown> {
  // Unicode scalar values, as the Rust label_width counts them.
  const width = (t: string): number => Array.from(t).length * s.font.advance.mono * s.font.size.xs;
  const nop = (): void => undefined;
  const ctx: Record<string, unknown> = {
    setTransform: nop,
    fillRect: nop,
    clearRect: nop,
    beginPath: nop,
    moveTo: nop,
    lineTo: nop,
    arc: nop,
    fill: nop,
    stroke: nop,
    drawImage: nop,
    save: nop,
    restore: nop,
    measureText: (t: string) => ({ width: width(t) }),
    fillText: (text: string) => {
      if (ctx.textAlign === 'right') labels.push(text);
    },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineJoin: 'miter',
    lineCap: 'butt',
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
  };
  return ctx;
}

interface Layout {
  plot: Plot;
  ticks: readonly number[];
  labels: string[];
  summary: Summary;
  min: number;
  max: number;
}

/** draw.ts's line layer at a size: the plot, the tick list and the label texts. */
function lineLayout(
  s: Sources,
  w: number,
  h: number,
  series: readonly Series[],
  unit: Unit,
): Layout {
  const labels: string[] = [];
  const { summary } = s.drawLayer({
    ctx: fakeCtx(s, labels),
    spec: { kind: 'line', title: '', unit },
    data: { kind: 'series', series },
    window: GALLERY_WINDOW,
    cssW: w,
    cssH: h,
    timeZone: 'UTC',
    colours: s.themeColours('dark'),
    // Auto axis, no camera hold, and no minimum value band: the Rust layout (`dash-axes`) draws no
    // text until #69, and T02-011's minimum compact band (#93) applies to it when #69 adds labels.
    valueRange: null,
    band: null,
    minBand: 0,
  });
  const stats = s.lineStats(series.slice(0, s.MAX_SERIES));
  const [min, max] = [stats.min ?? 0, stats.max ?? 0];
  const height = s.layoutPlot('line', w, h, 0).height;
  const base = unit.kind === 'bytes' ? 1024 : 1000;
  const vt = s.valueTicks(Math.min(0, min), max, height, s.LABEL_HEIGHT, base);
  return { plot: summary.plot, ticks: vt.ticks, labels, summary, min, max };
}

function twoPoint(min: number, max: number): Series[] {
  const { fromMs, toMs } = GALLERY_WINDOW;
  return [
    {
      key: '0000000000000000',
      labels: {},
      timestamps: new Float64Array([fromMs, toMs]),
      values: new Float64Array([min, max]),
    },
  ];
}

function layoutRows(s: Sources, entries: readonly Entry[]): unknown[] {
  const rows: unknown[] = [];
  const row = (l: Layout, w: number, h: number, unit: Unit, id?: string): unknown => ({
    ...(id === undefined ? {} : { id }),
    kind: 'line',
    w,
    h,
    min: l.min,
    max: l.max,
    unit,
    plot: l.plot,
    ticks: l.ticks,
    labels: l.labels,
  });
  for (const e of parityEntries(entries)) {
    rows.push(
      row(lineLayout(s, 1118, 240, e.data.series ?? [], e.spec.unit), 1118, 240, e.spec.unit, e.id),
    );
  }
  const r = stream(s, 3);
  for (let i = 0; i < 300; i++) {
    const w = Math.floor(120 + r() * 3720);
    const h = Math.floor(80 + r() * 1120);
    const mag = 10 ** (-9 + 30 * r());
    const lo = r() < 0.5 ? 0 : (r() - 0.6) * mag;
    const hi = lo + r() * mag;
    const unit = UNITS[Math.floor(r() * UNITS.length)] ?? { kind: 'none' };
    rows.push(row(lineLayout(s, w, h, twoPoint(lo, hi), unit), w, h, unit));
  }
  return rows;
}

function columnRows(s: Sources): unknown[] {
  const r = stream(s, 4);
  const rows: unknown[] = [];
  for (let i = 0; i < 300; i++) {
    const width = i % 7 === 0 ? 1 + Math.floor(r() * 4) + 0.5 : 1 + Math.floor(r() * 120);
    const n = Math.floor(width);
    const fromMs = 1_700_000_000_000 + Math.floor(r() * 1e6);
    const span = i % 50 === 49 ? 0 : n * (1 + Math.floor(r() * 20)) * 100;
    const w = { fromMs, toMs: fromMs + span };
    const count = i % 11 === 0 ? 1 : 1 + Math.floor(r() * Math.min(300, 4 * n + 20));
    const nanP = r() * 0.6;
    const ts: number[] = [];
    const vs: number[] = [];
    let t = fromMs - Math.floor(r() * 3) * 100;
    for (let k = 0; k < count; k++) {
      // Ties at column edges: some samples sit exactly on a column boundary.
      if (span > 0 && r() < 0.1) {
        const edge = fromMs + (Math.ceil(((t - fromMs) / span) * n + 1e-9) * span) / n;
        t = Math.max(t + 1, Math.round(edge));
      } else {
        t += 1 + Math.floor(r() * 60);
      }
      ts.push(t);
      vs.push(r() < nanP ? NaN : Math.round((r() - 0.5) * 2e4) / 100);
    }
    const cols = s.lineColumns(new Float64Array(ts), new Float64Array(vs), w, {
      x: 0,
      y: 0,
      width,
      height: 100,
    });
    // `first`: the column's first finite in-window sample (derived; lineColumns keeps no first).
    const first = new Map<number, number>();
    for (let k = 0; k < ts.length; k++) {
      const tk = ts[k] ?? NaN;
      const v = vs[k] ?? NaN;
      if (!(tk >= w.fromMs && tk <= w.toMs) || !Number.isFinite(v) || n === 0) continue;
      const f = Math.floor(((tk - w.fromMs) / (w.toMs - w.fromMs)) * n);
      const x = Math.min(n - 1, Math.max(0, f));
      if (!first.has(x)) first.set(x, v);
    }
    const out = cols.map((c) =>
      c === null
        ? null
        : {
            x: c.x,
            count: c.count,
            min: c.min,
            max: c.max,
            last: c.last,
            first: first.get(c.x) ?? NaN,
            breakBefore: c.breakBefore,
            runs: c.runs.map((run) => ({ min: run.min, max: run.max, count: run.count })),
          },
    );
    rows.push({ ts, vs, w, width, columns: out });
  }
  return rows;
}

function paletteRows(s: Sources): unknown[] {
  const r = stream(s, 5);
  const values = [
    'error',
    'ERR',
    'Warning',
    'warn',
    'info',
    'notice',
    'debug',
    'trace',
    'fatal',
    'unknown',
    'Critical',
    '',
  ];
  const rows: unknown[] = [];
  for (let i = 0; i < 200; i++) {
    const key = Array.from({ length: 16 }, () => Math.floor(r() * 16).toString(16)).join('');
    const labels: Record<string, string> = { pod: `p${String(i)}` };
    const pick = (): string => values[Math.floor(r() * values.length)] ?? '';
    const mode = i % 4;
    if (mode === 1) labels.level = pick();
    if (mode === 2) labels.detected_level = pick();
    if (mode === 3) {
      labels.level = pick();
      labels.detected_level = pick();
    }
    rows.push({ key, labels, index: s.seriesColourIndex({ key, labels }) });
  }
  return rows;
}

/** The parity entries, in `PARITY_LINE_IDS` order. */
function parityEntries(entries: readonly Entry[]): Entry[] {
  return PARITY_LINE_IDS.map((id) => {
    const e = entries.find((x) => x.id === id);
    if (e === undefined) throw new Error(`gallery entry ${id} is missing`);
    return e;
  });
}

function synthRows(s: Sources, entries: readonly Entry[]): unknown[] {
  return parityEntries(entries).map((e, i) => {
    const series = e.data.series ?? [];
    const samples = Array.from({ length: 64 }, (_, m) => {
      const j = Math.floor(s.hash01(6, i, m) * series.length);
      const sr = series[j];
      const k = Math.floor(s.hash01(6, i, m, 1) * (sr?.values.length ?? 1));
      return { j, k, t: sr?.timestamps[k] ?? NaN, v: sr?.values[k] ?? NaN };
    });
    return { id: e.id, keys: series.map((x) => x.key), samples };
  });
}

function summaryRows(s: Sources, entries: readonly Entry[]): unknown[] {
  return parityEntries(entries).map((e) => {
    const l = lineLayout(s, 1118, 240, e.data.series ?? [], e.spec.unit);
    const height = s.layoutPlot('line', 1118, 240, 0).height;
    const base = e.spec.unit.kind === 'bytes' ? 1024 : 1000;
    const vt = s.valueTicks(Math.min(0, l.min), l.max, height, s.LABEL_HEIGHT, base);
    // Until #93 adds `FrameSummary.valueAxis` in TS, the same valueTicks call derives it.
    const valueAxis = l.summary.valueAxis ?? { min: vt.min, max: vt.max, manual: false };
    const summary = Object.fromEntries(
      SUMMARY_FIELDS.map((k) => [k, k === 'valueAxis' ? valueAxis : l.summary[k]]),
    );
    return { id: e.id, summary };
  });
}

/** Every fixture file name → its JSON text. */
export async function fixtures(): Promise<Record<string, string>> {
  const s = await load();
  const entries = s.galleryEntries(GALLERY_WINDOW);
  return {
    'format.json': json(formatRows(s)),
    'ticks.json': json(ticksRows(s)),
    'ticks-extreme.json': json(ticksExtremeRows(s)),
    'pow.json': json(powRows()),
    'layout.json': json(layoutRows(s, entries)),
    'columns.json': json(columnRows(s)),
    'palette.json': json(paletteRows(s)),
    'synth.json': json(synthRows(s, entries)),
    'summary.json': json(summaryRows(s, entries)),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  registerClientHooks();
  const files = await fixtures();
  let stale = 0;
  for (const [name, text] of Object.entries(files)) {
    const path = join(FIXTURE_DIR, name);
    if (argv.includes('--write')) {
      writeFileSync(path, text);
      continue;
    }
    let committed = '';
    try {
      committed = readFileSync(path, 'utf8');
    } catch {
      committed = '';
    }
    if (committed !== text) {
      console.error(
        `error[engine-fixtures] engine/fixtures/${name} is stale: run \`npm run engine-fixtures -- --write\``,
      );
      stale += 1;
    }
  }
  return stale === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
