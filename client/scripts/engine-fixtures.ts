/**
 * Writes the engine parity fixtures `engine/fixtures/*.json` (plan #68 §3.14, A.7) from the TS
 * sources of truth: `formatValue`, `valueTicks`, `layoutPlot` with draw.ts's value axis,
 * `lineColumns`, `seriesColourIndex`, `synthLines` and `frameSummary`. The Rust ports must
 * reproduce them (`unit:*-parity`). `input-ring.json` is the input ring the adapter's `InputRing`
 * writes (plan #68 C2a1 §5 `ring_fixture`): its bytes and its log, which the render worker's
 * decoder must read back. `hover.json` is the hover and click picking of `canvas2d/pick.ts`
 * `hoverAt`, `select.ts` `pickItem` and `data/frames.ts` `seriesName` on line layer models (plan
 * #68 C2b §5 `hover_parity`). `layer.json` is the line layer's threshold and event strokes
 * (`engine-fixtures-layer.ts`, plan #68 C2c1 §5 `layer_parity`); `selection.json` the selection's
 * matching, band and crossing order (plan #68 C2c2 §5 `selection_parity`). `--write` writes the files; without it the committed files are
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
import { layerRows, selectionRows } from './engine-fixtures-layer.ts';

export const CLIENT_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FIXTURE_DIR = join(CLIENT_ROOT, '..', 'engine', 'fixtures');

/**
 * The gallery entries of the Rust parity fixtures (`layout.json`, `synth.json`, `summary.json`), in
 * today's order (`synthRows` hashes by position). Later gallery entries (`line-thresholds`, #64
 * Part B) are not parity fixtures, so the committed fixtures stay byte-identical.
 */
export const PARITY_LINE_IDS = ['line-1', 'line-50', 'line-gaps', 'line-600'] as const;

/**
 * The `FrameSummary` fields of the parity contract: the projection omits `thresholdLabels` and
 * `eventLabels`, which are TS-only (ADR-0022, ADR-0023).
 */
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

export type Unit =
  | { kind: 'none' }
  | { kind: 'plain' }
  | { kind: 'time'; base: 'ns' | 'us' | 'ms' | 's' }
  | { kind: 'bytes'; prefix?: 'iec' | 'si'; perSecond?: true }
  | { kind: 'bits'; prefix: 'iec' | 'si'; perSecond?: true }
  | { kind: 'percent' }
  | { kind: 'percentunit' }
  | { kind: 'suffix'; suffix: string };
interface Plot {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Window {
  fromMs: number;
  toMs: number;
}
interface Span {
  lo: number;
  hi: number;
}
interface Point {
  x: number;
  y: number;
}
export interface Series {
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
export interface Entry {
  id: string;
  spec: { kind: string; unit: Unit };
  data: { kind: string; series?: readonly Series[] };
  events?: readonly unknown[];
}

/** The client modules the fixtures come from. */
export interface Sources {
  formatValue: (v: number, u: Unit) => string;
  tickBase: (u: Unit) => 1000 | 1024;
  valueTicks: (
    min: number,
    max: number,
    h: number,
    label: number,
    base: 1000 | 1024,
  ) => { min: number; max: number; ticks: readonly number[] };
  niceValueTicks: (
    min: number,
    max: number,
    h: number,
    label: number,
    base: 1000 | 1024,
  ) => { min: number; max: number; ticks: readonly number[] } | null;
  extremeTicks: (
    min: number,
    max: number,
    h: number,
    label: number,
  ) => { min: number; max: number; ticks: readonly number[] };
  layoutPlot: (kind: string, w: number, h: number, labelW: number, eventBand?: number) => Plot;
  eventBandOf: (kind: string, events: readonly unknown[]) => number;
  thresholdsOf: (spec: unknown) => readonly { value: number; state: string }[];
  withThresholds: (
    min: number | null,
    max: number | null,
    t: readonly { value: number }[],
  ) => { min: number; max: number };
  LABEL_HEIGHT: number;
  drawLayer: (i: Record<string, unknown>) => { summary: Summary } & Record<string, unknown>;
  hoverAt: (m: unknown, v: Span, keyIndex: number | null, p: Point | null) => unknown;
  pickItem: (m: unknown, v: Span, p: Point) => unknown;
  seriesName: (labels: Record<string, string>) => string;
  mulberry32: (seed: number) => () => number;
  minValueBand: (ctx: Record<string, unknown>, unit: Unit) => number;
  MAX_SERIES: number;
  lineStats: (s: readonly Series[]) => { min: number | null; max: number | null };
  lineColumns: (ts: Float64Array, vs: Float64Array, w: Window, plot: Plot) => (Column | null)[];
  seriesColourIndex: (s: { key: string; labels: Record<string, string> }) => number;
  themeColours: (t: string) => unknown;
  hash01: (...ints: number[]) => number;
  galleryEntries: (w: Window, seed?: number) => Entry[];
  font: { size: { xs: number }; advance: { mono: number } };
  InputRing: new (
    memory: { buffer: SharedArrayBuffer },
    cb: number,
    wake: () => void,
    o: { log: boolean; now: () => number },
  ) => FixtureRing;
}

/** What the fixture uses of `engine/wasm/ring.ts`. */
interface FixtureRing {
  produced: unknown[] | null;
  camera(
    frame: number,
    c: {
      view: { lo: number; hi: number };
      value: { min: number; max: number } | null;
      band: number | null;
    },
  ): void;
  resize(frame: number, w: number, h: number, dpr: number): void;
  unpublished(frame: number): number;
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
      'engine/canvas2d/thresholdMark.ts',
      'engine/canvas2d/eventMark.ts',
      'engine/canvas2d/summary.ts',
      'engine/canvas2d/columns.ts',
      'engine/canvas2d/palette.ts',
      'dev/synth.ts',
      'dev/gallery.ts',
      'styles/tokens.ts',
      'engine/wasm/ring.ts',
      'engine/canvas2d/pick.ts',
      'engine/canvas2d/select.ts',
      'engine/canvas2d/selection.ts',
      'data/frames.ts',
      'test/random.ts',
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

/**
 * The units of #290 (§4.5), each a `format.json` block over the same values after the nine above
 * (whose block stays byte-identical) and one `layout.json` row (`case` `unit-<i>`; not a gallery
 * `id`, so the parity allowlist holds).
 */
const NEW_UNITS: readonly Unit[] = [
  { kind: 'plain' },
  { kind: 'bytes', prefix: 'si' },
  { kind: 'bytes', prefix: 'iec', perSecond: true },
  { kind: 'bytes', prefix: 'si', perSecond: true },
  { kind: 'bits', prefix: 'si' },
  { kind: 'bits', prefix: 'iec' },
  { kind: 'bits', prefix: 'si', perSecond: true },
  { kind: 'bits', prefix: 'iec', perSecond: true },
  { kind: 'suffix', suffix: 'req/s' },
  { kind: 'suffix', suffix: '/s' },
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
  const block = (units: readonly Unit[]): unknown[] =>
    values.flatMap((v) => units.map((unit) => ({ v, unit, out: s.formatValue(v, unit) })));
  return [...block(UNITS), ...block(NEW_UNITS)];
}

/** `base ** p` as the JS engine computes it (`valueTicks` uses 10 ** k, 1000 ** p, 1024 ** p). */
function powRows(): unknown[] {
  const rows: unknown[] = [];
  for (let k = -340; k <= 308; k++) rows.push({ base: 10, p: k, v: 10 ** k });
  for (const base of [1000, 1024])
    for (let p = 0; p <= 102; p++) rows.push({ base, p, v: base ** p });
  return rows;
}

/** One `area-pieces.json` piece (#282 Part 2b §3.4): class, x span and the top edge's y at its ends. */
interface RefPiece {
  cls: 'A' | 'I' | 'B';
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * The f64 reference of the area's piecewise edge rule over the plot rows 100 (top) to 300 (bottom):
 * ends classed in value space against [min, max], the crossings of max and min on the original
 * line (the cut parameter halved when the difference overflows), y projected fraction first.
 */
function refPieces(x0: number, x1: number, va: number, vb: number, min: number, max: number) {
  const top = 100;
  const bottom = 300;
  if (!(x1 > x0)) return [];
  const frac = (v: number): number => {
    const span = max - min;
    return Number.isFinite(span) ? (v - min) / span : (v / 2 - min / 2) / (max / 2 - min / 2);
  };
  const yOf = (v: number): number => top + (1 - frac(v)) * (bottom - top);
  const cls = (v: number): RefPiece['cls'] => (v > max ? 'A' : v < min ? 'B' : 'I');
  const tOf = (c: number): number => {
    const d = vb - va;
    return Number.isFinite(d) ? (c - va) / d : (c / 2 - va / 2) / (vb / 2 - va / 2);
  };
  const edge = (k: RefPiece['cls']): number => (k === 'A' ? top : bottom);
  const ca = cls(va);
  const cb = cls(vb);
  const cuts: { x: number; y: number; next: RefPiece['cls'] }[] = [];
  const at = (c: number, y: number, next: RefPiece['cls']): void => {
    cuts.push({ x: x0 + tOf(c) * (x1 - x0), y, next });
  };
  if (vb > va) {
    if (ca === 'B' && cb !== 'B') at(min, bottom, 'I');
    if (cb === 'A' && ca !== 'A') at(max, top, 'A');
  } else {
    if (ca === 'A' && cb !== 'A') at(max, top, 'I');
    if (cb === 'B' && ca !== 'B') at(min, bottom, 'B');
  }
  const pieces: RefPiece[] = [];
  let k = ca;
  let x = x0;
  let y = ca === 'I' ? yOf(va) : edge(ca);
  for (const c of cuts) {
    pieces.push({ cls: k, x0: x, x1: c.x, y0: k === 'I' ? y : edge(k), y1: k === 'I' ? c.y : edge(k) });
    k = c.next;
    x = c.x;
    y = c.y;
  }
  pieces.push({ cls: k, x0: x, x1, y0: k === 'I' ? y : edge(k), y1: k === 'I' ? yOf(vb) : edge(k) });
  return pieces;
}

/**
 * `area-pieces.json` (#282 Part 2b §5): the joins of the plan's cases (a)–(f) over x 0–100 and
 * the plot rows 300 (bottom) → 100 (top). Pixel cases are values on [0, 200] (v = 300 − y); (e6)
 * is two joins through 5e-309 at x 50.
 */
export function areaPiecesRows(): unknown[] {
  const px = (id: string, x0: number, y0: number, x1: number, y1: number) => ({
    id,
    x0,
    x1,
    va: 300 - y0,
    vb: 300 - y1,
    min: 0,
    max: 200,
  });
  const val = (id: string, va: number, vb: number, min = 0, max = 100, x0 = 0, x1 = 100) => ({
    id,
    x0,
    x1,
    va,
    vb,
    min,
    max,
  });
  const cases = [
    px('a', 0, 50, 100, 200),
    px('b', 0, 150, 100, 250),
    px('c', 0, 20, 100, 60),
    px('d', 0, 320, 100, 400),
    val('e1', -5e9, 2e10),
    val('e2', -8e9, 3e9),
    val('e3', 50, 9e12),
    val('e4', -5e19, 2e20),
    val('e5', -1e308, 1.05e308, 1e308, 1.1e308),
    val('e6a', 0, 5e-309, 0, 1e-308, 0, 50),
    val('e6b', 5e-309, 1e-308, 0, 1e-308, 50, 100),
    px('f', 50, 120, 50, 200),
  ];
  return cases.map(({ id, ...c }) => ({
    case: id,
    ...c,
    top: 100,
    bottom: 300,
    pieces: refPieces(c.x0, c.x1, c.va, c.vb, c.min, c.max),
  }));
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
    rows.push({
      min,
      max,
      height,
      label,
      base,
      path: ticksPath(s, min, max, height, label, base),
      out: s.valueTicks(min, max, height, label, base),
    });
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
    path: ticksPath(s, min, max, height, label, base),
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
      path: 'fallback',
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

/** `'fallback'` when the nice search gives up (collision rejection included), else `'nice'` (#97). */
function ticksPath(
  s: Sources,
  min: number,
  max: number,
  h: number,
  label: number,
  base: 1000 | 1024,
): 'nice' | 'fallback' {
  return s.niceValueTicks(min, max, h, label, base) === null ? 'fallback' : 'nice';
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
    rect: nop,
    clip: nop,
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
  const ctx = fakeCtx(s, labels);
  const { summary } = s.drawLayer({
    ctx,
    spec: { kind: 'line', title: '', unit },
    data: { kind: 'series', series },
    window: GALLERY_WINDOW,
    cssW: w,
    cssH: h,
    timeZone: 'UTC',
    colours: s.themeColours('dark'),
    // Auto axis, no camera hold, and T02-011's minimum compact band (#93), as the page draws it:
    // the engine's plot must equal Canvas 2D's (plan #68 C1, `golden:engine-line`).
    valueRange: null,
    band: null,
    minBand: s.minValueBand(ctx, unit),
  });
  const stats = s.lineStats(series.slice(0, s.MAX_SERIES));
  const [min, max] = [stats.min ?? 0, stats.max ?? 0];
  const height = s.layoutPlot('line', w, h, 0).height;
  const vt = s.valueTicks(Math.min(0, min), max, height, s.LABEL_HEIGHT, s.tickBase(unit));
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
  const row = (l: Layout, w: number, h: number, unit: Unit, id?: string, c?: string): unknown => ({
    ...(id === undefined ? {} : { id }),
    ...(c === undefined ? {} : { case: c }),
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
  // #290 §4.5: one row per new unit at the D1 size over [0, 3 MiB].
  NEW_UNITS.forEach((unit, i) => {
    const l = lineLayout(s, 1118, 240, twoPoint(0, 3_145_728), unit);
    rows.push(row(l, 1118, 240, unit, undefined, `unit-${String(i)}`));
  });
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

/**
 * `input-ring.json`: 40 records from `InputRing` with its counters at 0xFFFF_FF80, so the third
 * record leaves a wrap marker in the last 24 bytes and the counters roll over 2³²: the counters,
 * the published bytes in counter order (hex) and the produced log.
 */
function inputRingRows(s: Sources): unknown[] {
  const RING = 0x10000;
  const DATA = 0x10000;
  const start = 0xffff_ff80;
  const buffer = new SharedArrayBuffer(0x40000);
  const i32 = new Int32Array(buffer);
  Atomics.store(i32, 0x80 / 4, start | 0);
  Atomics.store(i32, 0xc0 / 4, start | 0);
  let t = 1000;
  const ring = new s.InputRing({ buffer }, 0, () => undefined, {
    log: true,
    now: () => (t += 0.25),
  });
  const w0 = GALLERY_WINDOW.fromMs;
  ring.resize(1, 1118.5, 240.25, 1.25);
  ring.camera(2, { view: { lo: w0, hi: w0 + 3_600_000 }, value: null, band: null });
  ring.camera(1, {
    view: { lo: w0 + 0.25, hi: w0 + 1000.75 },
    value: { min: 0, max: 10 },
    band: 60,
  });
  for (let i = 3; i < 40; i++) {
    const frame = 1 + (i % 4);
    if (i % 3 === 0) {
      ring.resize(frame, 100 + i * 7.3, 50 + i, [1, 1.25, 2][i % 3] ?? 1);
    } else {
      ring.camera(frame, {
        view: { lo: w0 + i * 1000.5, hi: w0 + i * 1000.5 + 60_000 * i },
        value: i % 5 === 0 ? { min: -i, max: i * 2.5 } : null,
        band: i % 7 === 0 ? 48 : null,
      });
    }
  }
  const head = Atomics.load(i32, 0x80 / 4) >>> 0;
  const bytes = new Uint8Array(buffer, DATA, RING);
  let hex = '';
  for (let c = start; c !== head; c = (c + 1) >>> 0) {
    hex += (bytes[c & (RING - 1)] ?? 0).toString(16).padStart(2, '0');
  }
  return [{ start, head, data: hex, records: ring.produced }];
}

/** A line layer model of `series` at 1118×240 (auto axis, or `valueRange`), as the page draws it. */
function lineModel(
  s: Sources,
  series: readonly Series[],
  unit: Unit,
  valueRange: { min: number; max: number } | null,
) {
  const ctx = fakeCtx(s, []);
  return s.drawLayer({
    ctx,
    spec: { kind: 'line', title: '', unit },
    data: { kind: 'series', series },
    window: GALLERY_WINDOW,
    cssW: 1118,
    cssH: 240,
    timeZone: 'UTC',
    colours: s.themeColours('dark'),
    valueRange,
    band: null,
    minBand: s.minValueBand(ctx, unit),
  });
}

const plain = (x: Series) => ({
  key: x.key,
  labels: x.labels,
  t: [...x.timestamps],
  v: [...x.values],
});

/** Every `k`th sample of `x`. */
function thin(x: Series, k: number): Series {
  const keep = (a: Float64Array): Float64Array => a.filter((_, i) => i % k === 0);
  return { ...x, timestamps: keep(x.timestamps), values: keep(x.values) };
}

/** A series of `n` samples `step` ms apart from the window start, values from `f(i)`. */
function seriesOf(
  key: string,
  labels: Record<string, string>,
  n: number,
  step: number,
  f: (i: number) => number,
): Series {
  const t = Array.from({ length: n }, (_, i) => GALLERY_WINDOW.fromMs + i * step);
  return {
    key,
    labels,
    timestamps: new Float64Array(t),
    values: new Float64Array(t.map((_, i) => f(i))),
  };
}

/**
 * `hover.json` (plan #68 C2b §5 `hover_parity`): per line case its model's plot, domain, view and
 * series (line-50's 50 series at every 6th sample, to keep the file small), then `hoverAt` at key indices 0, n − 1 and n, at no hover, and at 200 seeded pointers
 * (mulberry32 33, shared round-robin by the cases, ±10 px around the plot's width), and `pickItem`
 * at the same pointers; then `seriesName` of labels with quotes, backslashes, newlines, no
 * `__name__` and keys that sort differently by UTF-16 code unit than by code point.
 */
function hoverRows(s: Sources, entries: readonly Entry[]): unknown[] {
  const gallery = (id: string): Series[] =>
    (entries.find((e) => e.id === id)?.data.series ?? []).slice();
  const none: Unit = { kind: 'none' };
  const r = stream(s, 11);
  const two = [
    seriesOf(
      '00000000000000a1',
      { __name__: 'rps', job: 'api "v2"' },
      241,
      15_000,
      (i) => Math.round(100 * Math.sin(i / 9) * 1e3) / 1e3,
    ),
    seriesOf(
      '00000000000000b2',
      { job: 'db\\main', level: 'warn' },
      61,
      60_000,
      () => Math.round(r() * 2e4) / 100,
    ),
  ];
  const nan = [
    seriesOf('00000000000000a1', {}, 61, 60_000, (i) => (i % 7 === 4 || i === 18 ? NaN : i / 2)),
    seriesOf('00000000000000c3', { pod: 'x\ny' }, 61, 60_000, (i) => (i % 5 === 0 ? NaN : 30 - i)),
  ];
  const line = [seriesOf('00000000000000a1', {}, 61, 60_000, (i) => (30 * i) / 60)];
  const cases: [string, Series[], { min: number; max: number } | null][] = [
    ['line-50', gallery('line-50').map((x) => thin(x, 6)), null],
    ['line-gaps', gallery('line-gaps'), null],
    ['line-1', gallery('line-1'), null],
    ['two-steps', two, null],
    ['nan', nan, null],
    ['manual', line, { min: 5, max: 20 }],
  ];
  const view: Span = { lo: GALLERY_WINDOW.fromMs, hi: GALLERY_WINDOW.toMs };
  const models = cases.map(([, series, vr]) => {
    const m = lineModel(s, series, none, vr);
    const pick = m['pick'] as { ref: Float64Array; series: readonly Series[] };
    return { m, pick, plot: m.summary.plot };
  });
  const rnd = s.mulberry32(33);
  const pointers: Point[][] = cases.map(() => []);
  for (let i = 0; i < 200; i++) {
    const k = i % cases.length;
    const plot = models[k]?.plot ?? { x: 0, y: 0, width: 0, height: 0 };
    pointers[k]?.push({
      x: plot.x - 10 + rnd() * (plot.width + 20),
      y: plot.y + rnd() * plot.height,
    });
  }
  const rows: unknown[] = cases.map(([id, series], k) => {
    const model = models[k];
    if (model === undefined) throw new Error(`no model for ${id}`);
    const { m, pick, plot } = model;
    const n = pick.ref.length;
    const ps = pointers[k] ?? [];
    return {
      case: id,
      shown: pick.series.length,
      plot,
      domain: m['valueDomain'],
      view,
      series: series.map(plain),
      hovers: [
        ...[0, n - 1, n].map((key) => ({ key, p: null, out: s.hoverAt(m, view, key, null) })),
        { key: null, p: null, out: s.hoverAt(m, view, null, null) },
        ...ps.map((p) => ({ key: null, p, out: s.hoverAt(m, view, null, p) })),
      ],
      picks: ps.map((p) => ({ p, out: s.pickItem(m, view, p) })),
    };
  });
  const labels: Record<string, string>[] = [
    {},
    { __name__: 'up' },
    { __name__: 'http_requests_total', job: 'api', code: '200' },
    { a: 'say "hi"', b: 'back\\slash', c: 'line\nbreak' },
    { é: '1', '\u{1F600}': '2', '\uFF51': '3', z: '4' },
    { level: 'error', pod: 'p1', __name__: '' },
  ];
  rows.push({ case: 'names', names: labels.map((l) => ({ labels: l, name: s.seriesName(l) })) });
  return rows;
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
    'input-ring.json': json(inputRingRows(s)),
    'hover.json': json(hoverRows(s, entries)),
    'layer.json': json(layerRows(s, entries, GALLERY_WINDOW, seriesOf)),
    'selection.json': json(selectionRows(s, GALLERY_WINDOW, seriesOf)),
    'area-pieces.json': json(areaPiecesRows()),
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
