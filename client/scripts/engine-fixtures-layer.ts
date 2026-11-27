/**
 * `layer.json` (plan #68 C2c1 §5 `layer_parity`, `layout_event_band`; ADR-0022, ADR-0023): the
 * Canvas 2D line layer's threshold and event lines, recorded from `drawLayer`'s own stroke calls on
 * a recording 2D context. Each case is a spec (its wire JSON, as `WasmFrame.setSpec` sends it),
 * series, event times and a window, run at several sizes; each frame records:
 *
 * - the plot, the value domain, the label band width, the event band and `layoutPlot`'s rect with
 *   that band, the auto domain's input (`withThresholds` of the data's min and max) and the value
 *   label texts;
 * - every dashed stroke (a threshold line): its y, `moveTo` and `lineTo` x, dash pattern,
 *   `lineDashOffset`, colour and state, and `runs`, its dashes expanded by the Canvas 2D rule for
 *   offset 0 and butt caps: run k = [x0 + k·(d + g), min(x0 + k·(d + g) + d, x1)] while the start
 *   is < x1;
 * - every event stroke: its x, colour and whether a clip was active (Canvas 2D's `clipped` clips
 *   only under a manual axis, so on an auto axis it strokes an event at the right edge one column
 *   outside the plot; the engine draws it in the plot's last column);
 * - the summary's `thresholdLabels` and `eventLabels` boxes (the label boxes `canvas2d parity`
 *   leaves out).
 *
 * The generator checks its own records: one dashed stroke per finite threshold inside the plot and
 * one event stroke per finite event in view.
 */
import type { Entry, Series, Sources, Unit, Window } from './engine-fixtures.ts';

interface Pt {
  x: number;
  y: number;
}
interface Stroke {
  pts: Pt[];
  dash: number[];
  offset: number;
  colour: string;
  clip: boolean;
}
interface Marker {
  id: string;
  atMs: number;
  endMs: null;
  kind: string;
  title: string;
}
interface Threshold {
  value: number;
  state: 'watch' | 'degraded' | 'failing';
  label: string;
}
interface LayerCase {
  id: string;
  spec: {
    kind: 'line';
    title: string;
    unit: Unit;
    thresholds?: Threshold[];
    valueRange?: Span2;
    area?: boolean;
  };
  series: readonly Series[];
  events: Marker[];
  sizes: readonly (readonly [number, number, number])[];
}
interface Span2 {
  min: number;
  max: number;
}

/** A recording 2D context: label widths by the monospace formula, strokes with their state. */
function recordingCtx(s: Sources, labels: string[], strokes: Stroke[]): Record<string, unknown> {
  const width = (t: string): number => Array.from(t).length * s.font.advance.mono * s.font.size.xs;
  const nop = (): void => undefined;
  let pts: Pt[] = [];
  let dash: number[] = [];
  let clip = false;
  let pendingRect = false;
  const stack: { dash: number[]; clip: boolean }[] = [];
  const ctx: Record<string, unknown> = {
    setTransform: nop,
    fillRect: nop,
    clearRect: nop,
    arc: nop,
    closePath: nop,
    createLinearGradient: () => ({ addColorStop: nop }),
    fill: nop,
    drawImage: nop,
    beginPath: () => {
      pts = [];
      pendingRect = false;
    },
    moveTo: (x: number, y: number) => pts.push({ x, y }),
    lineTo: (x: number, y: number) => pts.push({ x, y }),
    rect: () => {
      pendingRect = true;
    },
    clip: () => {
      if (pendingRect) clip = true;
    },
    save: () => stack.push({ dash: [...dash], clip }),
    restore: () => {
      const top = stack.pop();
      if (top !== undefined) ({ dash, clip } = top);
    },
    setLineDash: (d: number[]) => {
      dash = [...d];
    },
    getLineDash: () => [...dash],
    stroke: () => {
      strokes.push({
        pts: pts.map((p) => ({ ...p })),
        dash: [...dash],
        offset: ctx.lineDashOffset as number,
        colour: ctx.strokeStyle as string,
        clip,
      });
    },
    measureText: (t: string) => ({ width: width(t) }),
    fillText: (text: string) => {
      if (ctx.textAlign === 'right') labels.push(text);
    },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineDashOffset: 0,
    lineJoin: 'miter',
    lineCap: 'butt',
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
  };
  return ctx;
}

/** The Canvas 2D dash runs of a stroke from x0 to x1 (offset 0, butt caps). */
function runsOf(x0: number, x1: number, d: number, g: number): [number, number][] {
  const out: [number, number][] = [];
  for (let start = x0; start < x1; start += d + g) out.push([start, Math.min(start + d, x1)]);
  return out;
}

interface Colours {
  event: string;
  state: Record<string, string>;
}

/** One frame of a case: `drawLayer` at `w`×`h`×`dpr`, its records. */
function frameOf(s: Sources, c: LayerCase, win: Window, w: number, h: number, dpr: number) {
  const labels: string[] = [];
  const strokes: Stroke[] = [];
  const ctx = recordingCtx(s, labels, strokes);
  const colours = s.themeColours('dark') as Colours;
  const valueRange = c.spec.valueRange ?? null;
  const m = s.drawLayer({
    ctx,
    spec: c.spec,
    data: { kind: 'series', series: c.series },
    window: win,
    cssW: w,
    cssH: h,
    timeZone: 'UTC',
    colours,
    valueRange,
    band: null,
    minBand: s.minValueBand(ctx, c.spec.unit),
    events: c.events,
    dpr,
  });
  const summary = m.summary as unknown as {
    plot: { x: number; y: number; width: number; height: number };
    thresholdLabels: { box: unknown }[];
    eventLabels: { box: unknown }[];
  };
  const plot = summary.plot;
  const labelW = m['labelW'] as number;
  const eventBand = s.eventBandOf('line', c.events);
  const stats = s.lineStats(c.series.slice(0, s.MAX_SERIES));
  const axisIn = s.withThresholds(stats.min, stats.max, s.thresholdsOf(c.spec));
  const stateOf = (colour: string): string | null =>
    Object.entries(colours.state).find(([k, v]) => v === colour && k !== 'ok')?.[0] ?? null;
  const thresholds = strokes
    .filter((k) => k.dash.length > 0)
    .map((k) => {
      const [a, b] = k.pts;
      if (a === undefined || b === undefined || a.y !== b.y) throw new Error(`${c.id}: dash path`);
      const [d = 0, g = 0] = k.dash;
      return {
        y: a.y,
        x0: a.x,
        x1: b.x,
        dash: k.dash,
        offset: k.offset,
        colour: k.colour,
        state: stateOf(k.colour),
        runs: runsOf(a.x, b.x, d, g),
      };
    });
  const bottom = plot.y + plot.height;
  const events = strokes
    .filter((k) => {
      const [a, b] = k.pts;
      return (
        k.dash.length === 0 &&
        k.colour === colours.event &&
        k.pts.length === 2 &&
        a !== undefined &&
        b !== undefined &&
        a.x === b.x &&
        a.y === plot.y &&
        b.y === bottom
      );
    })
    .map((k) => ({ x: k.pts[0]?.x ?? NaN, colour: k.colour, clip: k.clip }));
  // Self-checks: the records are the marks, one each.
  const domain = m['valueDomain'] as Span2;
  const y = (v: number): number =>
    plot.y + (1 - (v - domain.min) / (domain.max - domain.min)) * plot.height;
  const wantT = s
    .thresholdsOf(c.spec)
    .filter((t) => Number.isFinite(t.value) && y(t.value) >= plot.y && y(t.value) <= bottom);
  if (plot.width > 0 && plot.height > 0 && thresholds.length !== wantT.length) {
    throw new Error(`${c.id} ${String(w)}×${String(h)}: ${String(thresholds.length)} dashes`);
  }
  const inView = c.events.filter(
    (e) => Number.isFinite(e.atMs) && e.atMs >= win.fromMs && e.atMs <= win.toMs,
  );
  if (plot.width > 0 && plot.height > 0 && events.length !== inView.length) {
    throw new Error(`${c.id} ${String(w)}×${String(h)}: ${String(events.length)} event lines`);
  }
  return {
    w,
    h,
    dpr,
    plot,
    domain,
    labelW,
    eventBand,
    layoutPlot: s.layoutPlot('line', w, h, labelW, eventBand),
    axisIn,
    labels,
    thresholds,
    events,
    thresholdLabels: summary.thresholdLabels.map((b) => b.box),
    eventLabels: summary.eventLabels.map((b) => b.box),
  };
}

const marker = (id: string, atMs: number): Marker => ({
  id,
  atMs,
  endMs: null,
  kind: 'deploy',
  title: id,
});

/** Every `layer.json` row: one per case. */
export function layerRows(
  s: Sources,
  entries: readonly Entry[],
  win: Window,
  seriesOf: (
    key: string,
    labels: Record<string, string>,
    n: number,
    step: number,
    f: (i: number) => number,
  ) => Series,
): unknown[] {
  const gallery = (id: string): Entry => {
    const e = entries.find((x) => x.id === id);
    if (e === undefined) throw new Error(`gallery entry ${id} is missing`);
    return e;
  };
  const none: Unit = { kind: 'none' };
  // C2a2's probe data (`S()`): 61 samples over the window, value 30·i/60.
  const probe = [seriesOf('00000000000000a1', {}, 61, 60_000, (i) => (30 * i) / 60)];
  const sizes = [
    [1118, 240, 1],
    [1118, 240, 2],
    [300, 150, 1],
    [300, 150, 2],
  ] as const;
  const withProbe = [...sizes, [800, 240, 1]] as const;
  const t = (value: number, state: Threshold['state']): Threshold => ({
    value,
    state,
    label: `${state} ${String(value)}`,
  });
  const line = (thresholds?: Threshold[], valueRange?: Span2): LayerCase['spec'] => ({
    kind: 'line',
    title: 'T',
    unit: none,
    ...(thresholds === undefined ? {} : { thresholds }),
    ...(valueRange === undefined ? {} : { valueRange }),
  });
  const { fromMs, toMs } = win;
  const fromGallery = (id: string): LayerCase => {
    const e = gallery(id);
    return {
      id,
      spec: e.spec as LayerCase['spec'],
      series: e.data.series ?? [],
      events: (e.events ?? []) as Marker[],
      sizes,
    };
  };
  const cases: LayerCase[] = [
    fromGallery('line-thresholds'),
    fromGallery('line-events'),
    // #282 Part 2b (ADR-0036): the shaded pages, auto and pinned.
    fromGallery('line-area'),
    fromGallery('line-area-manual'),
    {
      id: 'thresholds-mixed',
      // Above, below and inside the data, a NaN (null on the wire), and 10 lines (8 kept: the 9th
      // and 10th would widen the domain).
      spec: line([
        t(40, 'watch'),
        t(-5, 'degraded'),
        t(12, 'failing'),
        t(NaN, 'watch'),
        t(20, 'watch'),
        t(25, 'degraded'),
        t(35, 'failing'),
        t(-10, 'watch'),
        t(90, 'failing'),
        t(-90, 'degraded'),
      ]),
      series: probe,
      events: [],
      sizes,
    },
    {
      id: 'manual-outside',
      spec: line([t(20, 'failing'), t(5, 'watch')], { min: 0, max: 10 }),
      series: probe,
      events: [],
      sizes,
    },
    {
      id: 'threshold-at-top',
      spec: line([t(30, 'watch'), t(0, 'failing')], { min: 0, max: 30 }),
      series: probe,
      events: [],
      sizes,
    },
    {
      id: 'probe-thresholds',
      spec: line([t(20, 'watch'), t(40, 'failing')]),
      series: probe,
      events: [],
      sizes: withProbe,
    },
    { id: 'events-none', spec: line(), series: probe, events: [], sizes },
    {
      id: 'probe-event',
      spec: line(),
      series: probe,
      events: [marker('in-view', fromMs + 1_800_000)],
      sizes: withProbe,
    },
    {
      id: 'event-out-of-view',
      spec: line(),
      series: probe,
      events: [marker('before', fromMs - 3_600_000)],
      sizes,
    },
    { id: 'event-nan', spec: line(), series: probe, events: [marker('nan', NaN)], sizes },
    {
      id: 'events-ends-auto',
      spec: line(),
      series: probe,
      // 1 s before the end rounds to the right edge at every size: drawn in the last column.
      events: [marker('hi', toMs), marker('lo', fromMs), marker('near-hi', toMs - 1_000)],
      sizes: withProbe,
    },
    {
      id: 'events-ends-pinned',
      spec: line(undefined, { min: 0, max: 10 }),
      series: probe,
      events: [marker('lo', fromMs), marker('hi', toMs)],
      sizes: withProbe,
    },
    {
      id: 'events-30s',
      spec: line(),
      series: probe,
      events: [
        marker('a', fromMs + 1_200_000),
        marker('b', fromMs + 1_230_000),
        marker('c', fromMs + 1_260_000),
      ],
      sizes,
    },
  ];
  return cases.map((c) => ({
    case: c.id,
    spec: JSON.stringify(c.spec),
    series: c.series.map((x) => ({
      key: x.key,
      labels: x.labels,
      t: [...x.timestamps],
      v: [...x.values],
    })),
    events: c.events.map((e) => e.atMs),
    window: win,
    frames: c.sizes.map(([w, h, dpr]) => frameOf(s, c, win, w, h, dpr)),
  }));
}

/** What the `selection.json` rows use of the client (plan #68 C2c2 §5). */
interface SelectionSources {
  matchedKeys: (sel: unknown, own: readonly string[]) => ReadonlySet<string> | null;
  size: Record<string, number>;
}

interface Sel {
  keys: string[];
  fromMs: number | null;
  toMs: number | null;
}

/**
 * A recording context for the selection rows: the `selection`-coloured `fillRect`s (the band) and
 * every stroke with its colour, width, alpha, first point and canvas (`layer` or `scratch`).
 */
function selectionCtx(
  where: string,
  log: { where: string; colour: string; width: number; alpha: number; y0: number }[],
  bands: number[][],
  selectionColour: string,
): Record<string, unknown> {
  const nop = (): void => undefined;
  let first: number | null = null;
  // `save`/`restore` keep the alpha (the dim layer's composite restores it).
  const alphas: number[] = [];
  const ctx: Record<string, unknown> = {
    setTransform: nop,
    clearRect: nop,
    arc: nop,
    closePath: nop,
    createLinearGradient: () => ({ addColorStop: nop }),
    fill: nop,
    drawImage: nop,
    rect: nop,
    clip: nop,
    save: () => alphas.push(ctx.globalAlpha as number),
    restore: () => {
      ctx.globalAlpha = alphas.pop() ?? 1;
    },
    setLineDash: nop,
    getLineDash: () => [],
    fillText: nop,
    measureText: (t: string) => ({ width: 7 * Array.from(t).length }),
    fillRect: (x: number, y: number, w: number, h: number) => {
      if (ctx.fillStyle === selectionColour) bands.push([x, y, w, h]);
    },
    beginPath: () => {
      first = null;
    },
    moveTo: (_x: number, y: number) => {
      first ??= y;
    },
    lineTo: (_x: number, y: number) => {
      first ??= y;
    },
    stroke: () => {
      log.push({
        where,
        colour: ctx.strokeStyle as string,
        width: ctx.lineWidth as number,
        alpha: ctx.globalAlpha as number,
        y0: first ?? NaN,
      });
    },
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    lineDashOffset: 0,
    lineJoin: 'miter',
    lineCap: 'butt',
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
  };
  return ctx;
}

/**
 * Every `selection.json` row (plan #68 C2c2 §5 `selection_parity`, `selection_passes` (e)): TS
 * `matchedKeys` over a frame's shown keys; the `drawSelectionBand` rect of `drawLayer`'s own call
 * (and the plot it was drawn on); and, for the crossing case (`S3`'s keys a1 and a2), the Canvas 2D
 * series strokes in call order as `[key, 'dimmed' | 'underlay' | 'line']`.
 */
export function selectionRows(
  s: Sources,
  win: Window,
  seriesOf: (
    key: string,
    labels: Record<string, string>,
    n: number,
    step: number,
    f: (i: number) => number,
  ) => Series,
): unknown[] {
  const x = s as unknown as Sources & SelectionSources;
  const colours = s.themeColours('dark') as { selection: string; focus: string };
  const key = (i: number): string => i.toString(16).padStart(16, '0');
  const rows: unknown[] = [];
  // Matching (relevance): keys inside the shown set, beyond it, foreign, non-hex, empty, and a key
  // that differs from a shown one by case only.
  const own = (n: number): string[] => Array.from({ length: n }, (_, i) => key(0xa0 + i));
  const matching: [string, number, string[]][] = [
    ['inside', 3, [key(0xa1)]],
    ['inside-two', 3, [key(0xa2), key(0xa0)]],
    ['beyond-shown', 520, [key(0xa0 + 500)]],
    ['beyond-and-inside', 520, [key(0xa0 + 501), key(0xa0 + 499)]],
    ['foreign', 3, [key(0xff)]],
    ['non-hex', 3, ['x', 'a1', `${key(0xa1)} `]],
    ['empty', 3, []],
    ['case-only', 3, ['00000000000000A2']],
  ];
  for (const [id, n, keys] of matching) {
    const all = own(n);
    const shown = all.slice(0, s.MAX_SERIES);
    const hit = x.matchedKeys({ keys, fromMs: null, toMs: null }, shown);
    rows.push({
      case: id,
      kind: 'match',
      series: all,
      keys,
      matched: hit === null ? null : shown.filter((k) => hit.has(k)),
    });
  }
  // Bands: through `drawLayer` on C2a2's probe data, so the plot is the layout's.
  const probe = [seriesOf(key(0xa1), {}, 61, 60_000, (i) => (30 * i) / 60)];
  const { fromMs, toMs } = win;
  const min = 60_000;
  const bands: [string, Sel, number, { min: number; max: number } | null][] = [
    ['inside', { keys: [], fromMs: fromMs + 10 * min, toMs: fromMs + 20 * min }, 1, null],
    ['cut-left', { keys: [], fromMs: fromMs - 10 * min, toMs: fromMs + 5 * min }, 1, null],
    ['cut-right', { keys: [], fromMs: toMs - 5 * min, toMs: toMs + 10 * min }, 1, null],
    ['outside-left', { keys: [], fromMs: fromMs - 20 * min, toMs: fromMs - 10 * min }, 1, null],
    ['outside-right', { keys: [], fromMs: toMs + 10 * min, toMs: toMs + 20 * min }, 1, null],
    ['to-null', { keys: [], fromMs: fromMs + 30 * min, toMs: null }, 1, null],
    ['from-null', { keys: [], fromMs: null, toMs: fromMs + 30 * min }, 1, null],
    ['from-eq-to', { keys: [], fromMs: fromMs + 30 * min, toMs: fromMs + 30 * min }, 1, null],
    ['from-eq-to-dpr2', { keys: [], fromMs: fromMs + 30 * min, toMs: fromMs + 30 * min }, 2, null],
    ['inside-dpr2', { keys: [], fromMs: fromMs + 10 * min, toMs: fromMs + 20 * min }, 2, null],
    ['right-edge', { keys: [], fromMs: toMs, toMs }, 1, null],
    [
      'keys-and-interval',
      { keys: [key(0xa1)], fromMs: fromMs + 10 * min, toMs: fromMs + 20 * min },
      1,
      null,
    ],
    [
      'pinned',
      { keys: [], fromMs: fromMs + 10 * min, toMs: fromMs + 20 * min },
      1,
      { min: 0, max: 10 },
    ],
  ];
  for (const [id, sel, dpr, valueRange] of bands) {
    const rects: number[][] = [];
    const ctx = selectionCtx('layer', [], rects, colours.selection);
    const scratch = selectionCtx('scratch', [], [], colours.selection);
    const spec = {
      kind: 'line',
      title: 'T',
      unit: { kind: 'none' },
      ...(valueRange === null ? {} : { valueRange }),
    };
    const m = s.drawLayer({
      ctx,
      scratch: { canvas: { width: 0, height: 0 }, ctx: scratch },
      spec,
      data: { kind: 'series', series: probe },
      window: win,
      cssW: 800,
      cssH: 240,
      timeZone: 'UTC',
      colours,
      valueRange,
      band: null,
      minBand: 0,
      selection: sel,
      dpr,
    });
    if (rects.length > 1) throw new Error(`selection ${id}: ${String(rects.length)} bands`);
    rows.push({
      case: id,
      kind: 'band',
      spec: JSON.stringify(spec),
      window: win,
      w: 800,
      h: 240,
      dpr,
      selection: sel,
      plot: m.summary.plot,
      rect: rects[0] ?? null,
    });
  }
  // The crossing case: `S3`'s series (a1 0→30, a2 30→0, a3 10), keys a1 and a2.
  const s3 = [
    seriesOf(key(0xa1), {}, 61, 60_000, (i) => (30 * i) / 60),
    seriesOf(key(0xa2), {}, 61, 60_000, (i) => 30 - (30 * i) / 60),
    seriesOf(key(0xa3), {}, 61, 60_000, () => 10),
  ];
  const log: { where: string; colour: string; width: number; alpha: number; y0: number }[] = [];
  const ctx = selectionCtx('layer', log, [], colours.selection);
  const scratch = selectionCtx('scratch', log, [], colours.selection);
  const sel = { keys: [key(0xa1), key(0xa2)], fromMs: null, toMs: null };
  const m = s.drawLayer({
    ctx,
    scratch: { canvas: { width: 0, height: 0 }, ctx: scratch },
    spec: { kind: 'line', title: 'T', unit: { kind: 'none' } },
    data: { kind: 'series', series: s3 },
    window: win,
    cssW: 800,
    cssH: 240,
    timeZone: 'UTC',
    colours,
    valueRange: null,
    band: null,
    minBand: 0,
    selection: sel,
    dpr: 1,
  });
  const pick = m['pick'] as { y: (v: number) => number };
  const starts = s3.map((x) => ({ key: x.key, y: pick.y(x.values[0] ?? NaN) }));
  const keyOf = (y0: number): string =>
    starts.reduce((a, b) => (Math.abs(b.y - y0) < Math.abs(a.y - y0) ? b : a)).key;
  const line = x.size['chart-line'] ?? 0;
  const order = log
    .filter((k) => k.width === line || k.width === line + 4)
    .map((k) => {
      const role =
        k.where === 'scratch' || k.alpha < 1
          ? 'dimmed'
          : k.colour === colours.focus && k.width === line + 4
            ? 'underlay'
            : 'line';
      return [keyOf(k.y0), role];
    });
  rows.push({ case: 'crossing', kind: 'order', keys: sel.keys, order });
  return rows;
}
