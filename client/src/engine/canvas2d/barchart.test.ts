/**
 * The Canvas 2D bar chart (plan #173 Part 2 §5, ADR-0028; Part 3a §5, ADR-0029): colour, layout,
 * labels, events, keys, the brush, selection and the baseline ghost, through a recording context
 * (7 px per character).
 */
import { describe, expect, it } from 'vitest';
import type { BarchartSpec, CategoryRow, FrameData, FrameSummary } from '../api';
import { EMPTY_COVERAGE } from '../../data/frames';
import { colour, opacity, seriesPalette } from '../../styles/tokens';
import { byVersion, fkey, many, row } from '../../test/categoryFixtures';
import { harness, key, pointer, wheel, type Harness } from '../../test/engineHarness';
import { barCap, capMarks, categoryCoverage, categoryRows } from '../../vis/reduce';
import type { Thresholds } from '../../vis/thresholds';
import { Canvas2DEngine } from './Canvas2DEngine';
import { BOTTOM, categoryExtent, EVENT_BAND } from './layout';
import { seriesColourIndex, themeColours } from './palette';
import { distinctLabels } from './text';

const W = { fromMs: 0, toMs: 60_000 };
const colours = themeColours('dark');

function spec(o: Partial<BarchartSpec> = {}): BarchartSpec {
  return {
    kind: 'barchart',
    title: 'Versions',
    unit: { kind: 'none' },
    orientation: 'horizontal',
    valueLabels: true,
    ghost: false,
    anomaly: false,
    ...o,
  };
}

const WATCH_FAILING: Thresholds = {
  direction: 'above',
  steps: [
    { value: 30, state: 'watch', label: '' },
    { value: 100, state: 'failing', label: '' },
  ],
};

/** `byVersion` reduced and sorted: 2.31 120, 2.29 40, 2.33 15, 2.30 7, 2.32 3. */
function versions(thresholds: Thresholds | null = null): CategoryRow[] {
  return categoryRows(byVersion(), null, {
    reducer: 'last',
    categoryBy: '',
    sort: 'valueDesc',
    thresholds,
  }).rows;
}

function cats(rows: readonly CategoryRow[], all: readonly CategoryRow[] = rows): FrameData {
  const capped = capMarks(all, rows.length);
  const coverage = categoryCoverage({
    all,
    capped: { drawn: [...rows], kept: capped.kept },
    query: EMPTY_COVERAGE.query,
    baseline: null,
    outside: 0,
    duplicates: 0,
    conflicts: 0,
  });
  return { kind: 'categories', categories: rows, coverage };
}

function show(h: Harness, s: BarchartSpec, d: FrameData, w = 600, hgt = 240): FrameSummary {
  h.frame.setSpec(s);
  h.frame.setData(d);
  h.frame.setTimeWindow(W);
  h.frame.resize(w, hgt, 1);
  h.flush();
  const a = h.a11y.at(-1);
  if (a === undefined) throw new Error('no a11y summary');
  return a;
}

const palette = new Set<string>(seriesPalette.dark);
const stateColours = new Set<string>(Object.values(colours.state));

/** The bar fills, in draw order: series or state colours, thinner than the plot. */
function bars(h: Harness, plotH: number) {
  return h
    .layer()
    .calls('fillRect')
    .filter(
      (o) =>
        (palette.has(o.fillStyle) || stateColours.has(o.fillStyle)) && Number(o.args[3]) < plotH,
    );
}

/** The x of value v on the summary's horizontal value axis. */
function vx(s: FrameSummary, v: number): number {
  const a = s.valueAxis;
  if (a === null) throw new Error('no value axis');
  return s.plot.x + ((v - a.min) / (a.max - a.min)) * s.plot.width;
}

const texts = (h: Harness, align?: string) =>
  h
    .layer()
    .calls('fillText')
    .filter((o) => align === undefined || o.textAlign === align);

describe('unit:category-colour', () => {
  it('series colours without thresholds, no pattern, gradient or shadow', () => {
    const h = harness(Canvas2DEngine);
    const rows = versions();
    const s = show(h, spec(), cats(rows), 600, 300 + 8 + BOTTOM);
    const fills = bars(h, s.plot.height);
    expect(fills.map((o) => o.fillStyle)).toEqual(
      rows.map((r) => seriesPalette.dark[seriesColourIndex(r)]),
    );
    expect(h.layer().ops.every((o) => o.fillStyle !== 'gradient-or-pattern')).toBe(true);
    expect(h.layer().ops.every((o) => o.strokeStyle !== 'gradient-or-pattern')).toBe(true);
    expect((h.layer() as unknown as Record<string, unknown>)['shadowBlur']).toBeUndefined();
  });

  it('a 300 px plot holds 21 bars, every one named', () => {
    const h = harness(Canvas2DEngine);
    const all = many();
    const drawn = capMarks(all, barCap(300)).drawn;
    expect(drawn).toHaveLength(21);
    const s = show(h, spec(), cats(drawn, all), 600, 300 + 8 + BOTTOM);
    expect(bars(h, s.plot.height)).toHaveLength(21);
    const names = new Set(texts(h, 'right').map((o) => String(o.args[0])));
    for (const r of drawn) expect(names.has(r.name), r.name).toBe(true);
    expect(s.namesHidden).toBeUndefined();
  });

  it('thresholds: state colours, the glyph before the name, two dashed lines', () => {
    const h = harness(Canvas2DEngine);
    const rows = versions(WATCH_FAILING);
    const lines = [
      { value: 30, state: 'watch' as const, label: '≥ 30' },
      { value: 100, state: 'failing' as const, label: '≥ 100' },
    ];
    const s = show(h, spec({ thresholds: lines }), cats(rows), 600, 300 + 8 + EVENT_BAND + BOTTOM);
    const fills = bars(h, s.plot.height);
    expect(rows[0]?.name).toBe('2.31');
    expect(fills[0]?.fillStyle).toBe(colours.state.failing);
    const name = texts(h).find((o) => o.args[0] === '2.31');
    const glyph = texts(h).find((o) => o.args[0] === '■' && o.args[2] === name?.args[2]);
    expect(glyph).toBeDefined();
    expect(Number(glyph?.args[1])).toBeLessThan(Number(name?.args[1]));
    const dashed = h
      .layer()
      .calls('setLineDash')
      .filter((o) => (o.args[0] as number[]).length > 0);
    expect(dashed).toHaveLength(2);
    expect(s.thresholdLabels.map((b) => b.text)).toEqual(['◐ ≥ 30', '■ ≥ 100']);
    expect(s.thresholdLabels.every((b) => b.clipped)).toBe(true);
  });
});

describe('unit:barchart-layout', () => {
  it('category extent', () => {
    const lines = [{ value: 30, state: 'watch' as const, label: 'w' }];
    expect(categoryExtent(spec(), 600, 240)).toBe(240 - 8 - BOTTOM);
    expect(categoryExtent(spec({ thresholds: lines }), 600, 240)).toBe(
      240 - 8 - BOTTOM - EVENT_BAND,
    );
    // Plan §3.3: 600 − (48 + 8 + 4) − 8.
    expect(categoryExtent(spec({ orientation: 'vertical' }), 600, 240)).toBe(532);
  });

  it('data order, value labels outside the bars, none when off', () => {
    const h = harness(Canvas2DEngine);
    const s = show(h, spec(), cats(versions()));
    expect(texts(h, 'left').map((o) => o.args[0])).toEqual(['120', '40', '15', '7', '3']);
    const fills = bars(h, s.plot.height);
    const top = fills[0];
    const label = texts(h, 'left')[0];
    if (top === undefined || label === undefined) throw new Error('no bar');
    const end = Number(top.args[0]) + Number(top.args[2]);
    expect(Number(label.args[1])).toBeGreaterThanOrEqual(end);
    expect(Number(label.args[1]) + 3 * 7).toBeLessThanOrEqual(600);

    const off = harness(Canvas2DEngine);
    show(off, spec({ valueLabels: false }), cats(versions()));
    expect(texts(off, 'left')).toEqual([]);
    expect(off.a11y.at(-1)?.valuesHidden).toBe(true);
  });

  it('a fixed range clips the bar at the plot edge; its label stays whole', () => {
    const h = harness(Canvas2DEngine);
    const s = show(h, spec({ valueRange: { min: 0, max: 50 } }), cats(versions()));
    expect(s.valueAxis).toEqual({ min: 0, max: 50, manual: true });
    const top = bars(h, s.plot.height)[0];
    const label = texts(h, 'left')[0];
    if (top === undefined || label === undefined) throw new Error('no bar');
    expect(Number(top.args[0]) + Number(top.args[2])).toBeCloseTo(s.plot.x + s.plot.width, 6);
    expect(label.args[0]).toBe('120');
    expect(Number(label.args[1])).toBeGreaterThanOrEqual(s.plot.x + s.plot.width);
    expect(Number(label.args[1]) + 3 * 7).toBeLessThanOrEqual(600);
  });

  it('negative values: the bar runs from x(−20) to x(0) and its label sits left of it', () => {
    const h = harness(Canvas2DEngine);
    const rows = [row(fkey(1), 'a', 30), row(fkey(2), 'b', -20)];
    const s = show(h, spec(), cats(rows));
    const [pos, neg] = bars(h, s.plot.height);
    if (pos === undefined || neg === undefined) throw new Error('no bars');
    expect(Number(neg.args[0])).toBeCloseTo(vx(s, -20), 6);
    expect(Number(neg.args[0]) + Number(neg.args[2])).toBeCloseTo(vx(s, 0), 6);
    const negLabel = texts(h, 'right').find((o) => o.args[0] === '-20');
    if (negLabel === undefined) throw new Error('no -20 label');
    expect(Number(negLabel.args[1])).toBeLessThanOrEqual(vx(s, -20));
    expect(Number(negLabel.args[1]) - 3 * 7).toBeGreaterThanOrEqual(0);
    const posLabel = texts(h, 'left').find((o) => o.args[0] === '30');
    expect(Number(posLabel?.args[1])).toBeGreaterThanOrEqual(vx(s, 30));
  });

  it('vertical: names rotated by −π/2', () => {
    const h = harness(Canvas2DEngine);
    show(h, spec({ orientation: 'vertical' }), cats(versions()), 600, 300);
    const turns = h
      .layer()
      .calls('rotate')
      .filter((o) => o.args[0] === -Math.PI / 2);
    expect(turns.length).toBeGreaterThanOrEqual(5);
  });
});

describe('unit:barchart-labels', () => {
  // Plan §5 names, lengthened by a shared `-service` so that their middle fits collide at 120 px.
  const A = 'svc-alpha-checkout-service-eu-west';
  const B = 'svc-alpha-payments-service-eu-west';
  const m6 = (t: string): number => 6 * Array.from(t).length;

  it('colliding names get (k) suffixes that fit the room', () => {
    const got = distinctLabels(m6, [A, B], 120);
    if (got === null) throw new Error('hidden');
    expect(got[0]?.endsWith(' (1)')).toBe(true);
    expect(got[1]?.endsWith(' (2)')).toBe(true);
    for (const l of got) expect(m6(l)).toBeLessThanOrEqual(120);
    expect(new Set(got).size).toBe(2);
  });

  it('a name equal to a suffixed label is told apart by its draw index', () => {
    const c = distinctLabels(m6, [A, B], 120)?.[0] ?? '';
    const got = distinctLabels(m6, [A, B, c], 120);
    if (got === null) throw new Error('hidden');
    expect(new Set(got).size).toBe(3);
    for (const l of got) expect(m6(l)).toBeLessThanOrEqual(120);
  });

  it('20 px hides every name; 40 px keeps a head and the suffix', () => {
    expect(distinctLabels(m6, [A, B], 20)).toBeNull();
    expect(distinctLabels(m6, [A, B], 40)).toEqual(['s… (1)', 's… (2)']);
  });

  it('hidden names: no name text, `namesHidden`, full names in `mark`', () => {
    const h = harness(Canvas2DEngine);
    const rows = [row(fkey(1), A, 2), row(fkey(2), B, 1)];
    const s = show(h, spec(), cats(rows), 70, 240);
    expect(s.namesHidden).toBe(true);
    const names = texts(h).filter((o) => String(o.args[0]).startsWith('s'));
    expect(names).toEqual([]);
    const y = s.plot.y + s.plot.height / 4;
    pointer(h.canvas, 'pointermove', s.plot.x + 1, y);
    h.flush();
    expect(h.mark.at(-1)?.rows[0]?.name).toBe(A);
  });
});

describe('unit:barchart-events', () => {
  it('mark on a key change, null once on leaving; click and empty click pick', () => {
    const h = harness(Canvas2DEngine);
    const rows = versions();
    const s = show(h, spec(), cats(rows));
    const band = s.plot.height / rows.length;
    const yAt = (k: number): number => s.plot.y + (k + 0.5) * band;
    const x = s.plot.x + 10;
    pointer(h.canvas, 'pointermove', x, yAt(2));
    pointer(h.canvas, 'pointermove', x + 5, yAt(2) + 1);
    h.flush();
    expect(h.mark).toHaveLength(1);
    expect(h.mark[0]).toMatchObject({ source: 'pointer', key: rows[2]?.key, index: 2 });
    expect(h.mark[0]?.rows[0]?.name).toBe('2.33');
    pointer(h.canvas, 'pointermove', x, yAt(3));
    pointer(h.canvas, 'pointermove', x, s.plot.y + s.plot.height + 5);
    pointer(h.canvas, 'pointermove', x, s.plot.y + s.plot.height + 8);
    h.flush();
    expect(h.mark.map((m) => m?.key ?? null)).toEqual([rows[2]?.key, rows[3]?.key, null]);

    pointer(h.canvas, 'pointerdown', x, yAt(3));
    pointer(h.canvas, 'pointerup', x, yAt(3));
    pointer(h.canvas, 'pointerdown', x, s.plot.y + s.plot.height + 8);
    pointer(h.canvas, 'pointerup', x, s.plot.y + s.plot.height + 8);
    expect(h.pick).toEqual([
      { keys: [rows[3]?.key], gesture: 'click', source: 'pointer' },
      { keys: [], gesture: 'click', source: 'pointer' },
    ]);
  });

  it('a 5 px drag brushes one band (ADR-0029); a right click and the wheel emit nothing', () => {
    const h = harness(Canvas2DEngine);
    const rows = versions();
    const s = show(h, spec(), cats(rows));
    const y = s.plot.y + s.plot.height / 10;
    const x = s.plot.x + 10;
    pointer(h.canvas, 'pointerdown', x, y);
    pointer(h.canvas, 'pointermove', x + 5, y);
    pointer(h.canvas, 'pointerup', x + 5, y);
    pointer(h.canvas, 'pointerdown', x, y, { button: 2 });
    pointer(h.canvas, 'pointerup', x, y, { button: 2 });
    const cm = pointer(h.canvas, 'contextmenu', x, y, { button: 2 });
    const wh = wheel(h.canvas, x, y, { deltaY: 100 });
    pointer(h.canvas, 'dblclick', x, y);
    h.advance(1_000);
    h.flush();
    expect(h.pick).toEqual([{ keys: [rows[0]?.key], gesture: 'brush', source: 'pointer' }]);
    expect(h.commit).toEqual([]);
    expect(h.brush).toEqual([]);
    expect(h.hover.filter((x) => x !== null)).toEqual([]);
    expect(h.select).toEqual([]);
    expect(cm.defaultPrevented).toBe(false);
    expect(wh.defaultPrevented).toBe(false);
  });
});

describe('unit:barchart-selection', () => {
  it('dims the others and rings the selected bar; a foreign or null selection draws as none', () => {
    const rows = versions();
    const k2 = rows[2]?.key ?? '';
    const run = (sel: { keys: string[] } | null) => {
      const h = harness(Canvas2DEngine);
      h.frame.setSelection(sel === null ? null : { keys: sel.keys, fromMs: null, toMs: null });
      const s = show(h, spec(), cats(rows));
      return { h, s };
    };
    const { h, s } = run({ keys: [k2] });
    const fills = bars(h, s.plot.height);
    expect(fills.map((o) => o.globalAlpha)).toEqual([
      opacity.dimmed,
      opacity.dimmed,
      1,
      opacity.dimmed,
      opacity.dimmed,
    ]);
    const ring = h
      .layer()
      .calls('strokeRect')
      .filter((o) => o.strokeStyle === colours.focus);
    expect(ring).toHaveLength(1);
    const dimmedNames = texts(h, 'right').filter((o) => o.globalAlpha === opacity.dimmed);
    expect(dimmedNames.map((o) => o.args[0])).toEqual(['2.31', '2.29', '2.30', '2.32']);

    const none = run(null).h.layer().ops;
    const foreign = run({ keys: [fkey(99)] }).h.layer().ops;
    expect(foreign).toEqual(none);
    expect(none.every((o) => o.globalAlpha === 1)).toBe(true);
  });
});

describe('unit:barchart-ghost', () => {
  it('a dashed outline from x(0) to x(baseline), as thick as the bar', () => {
    const rows = versions().map((r) => (r.name === '2.31' ? { ...r, baseline: 60 } : r));
    const h = harness(Canvas2DEngine);
    const s = show(h, spec({ ghost: true }), cats(rows));
    const ghosts = h
      .layer()
      .calls('strokeRect')
      .filter((o) => o.strokeStyle === colours.ghost);
    expect(ghosts).toHaveLength(1);
    const g = ghosts[0];
    const bar = bars(h, s.plot.height)[0];
    if (g === undefined || bar === undefined) throw new Error('no ghost');
    expect(Number(g.args[0])).toBeCloseTo(vx(s, 0), 6);
    expect(Number(g.args[0]) + Number(g.args[2])).toBeCloseTo(vx(s, 60), 6);
    expect(g.args[1]).toBe(bar.args[1]);
    expect(g.args[3]).toBe(bar.args[3]);
    expect(colours.ghost).toBe(colour.dark['text-muted']);
    const dashIndex = h.layer().ops.indexOf(g);
    const dash = h
      .layer()
      .ops.slice(0, dashIndex)
      .filter((o) => o.op === 'setLineDash')
      .at(-1);
    expect((dash?.args[0] as number[]).length).toBeGreaterThan(0);

    for (const o of [
      { ghost: false, rows },
      { ghost: true, rows: versions() },
    ]) {
      const off = harness(Canvas2DEngine);
      show(off, spec({ ghost: o.ghost }), cats(o.rows));
      expect(off.layer().calls('strokeRect')).toEqual([]);
    }
  });
});

describe('unit:barchart-events (window)', () => {
  it('a new time window is stored without a redraw', () => {
    const h = harness(Canvas2DEngine);
    show(h, spec(), cats(versions()));
    const draws = h.layer().calls('setTransform').length;
    h.frame.setTimeWindow({ fromMs: 1, toMs: 2 });
    h.flush();
    expect(h.layer().calls('setTransform')).toHaveLength(draws);
    expect(h.queued()).toBe(0);
  });
});

/** Draw order 2.31, 2.29, 2.33, 2.30, 2.32 on a horizontal 300 px extent, keys on `div`. */
function keyed() {
  const div = document.createElement('div');
  const h = harness(Canvas2DEngine, { keyTarget: div });
  const rows = versions();
  const s = show(h, spec(), cats(rows), 600, 300 + 8 + BOTTOM);
  const band = s.plot.height / rows.length;
  const k = (name: string, o: { shiftKey?: boolean; ctrlKey?: boolean } = {}): KeyboardEvent => {
    const e = key(div, name, o);
    h.flush();
    return e;
  };
  const focus = (): void => {
    div.dispatchEvent(new FocusEvent('focus'));
    h.flush();
  };
  const keyOf = (i: number): string => rows[i]?.key ?? '';
  return { div, h, rows, s, band, k, focus, keyOf };
}

/** The 2 px focus strokes of the visible canvas's last overlay. */
function focusStrokes(h: Harness) {
  return h
    .visible()
    .calls('strokeRect')
    .filter((o) => o.strokeStyle === colours.focus && o.lineWidth === 2);
}

describe('unit:barchart-keys', () => {
  it('focus, arrows, Home/End, Shift brush, Enter, Escape, modifiers, focusout, new data', () => {
    const { div, h, rows, s, band, k, focus, keyOf } = keyed();
    focus();
    expect(h.mark.at(-1)).toMatchObject({ source: 'keyboard', index: 0, key: keyOf(0) });
    expect(h.mark.at(-1)?.rows[0]?.name).toBe('2.31');
    k('ArrowRight');
    k('ArrowRight');
    expect(h.mark.at(-1)).toMatchObject({ source: 'keyboard', index: 2, key: keyOf(2) });
    expect(h.mark.at(-1)?.rows[0]?.name).toBe('2.33');
    // The focus mark: from the name band's left edge to the plot's right edge, around band 2.
    const ring = focusStrokes(h).at(-1);
    expect(ring).toBeDefined();
    expect(Number(ring?.args[0])).toBe(0);
    expect(Number(ring?.args[0]) + Number(ring?.args[2])).toBeCloseTo(s.plot.x + s.plot.width, 6);
    expect(Number(ring?.args[1])).toBeCloseTo(s.plot.y + 2 * band, 6);
    expect(Number(ring?.args[3])).toBeCloseTo(band, 6);
    k('Home');
    expect(h.mark.at(-1)?.index).toBe(0);
    k('End');
    expect(h.mark.at(-1)).toMatchObject({ index: 4, key: keyOf(4) });
    expect(h.mark.at(-1)?.rows[0]?.name).toBe('2.32');
    k('Home');
    expect(h.pick).toEqual([]);
    const shifted = k('ArrowRight', { shiftKey: true });
    expect(shifted.defaultPrevented).toBe(true);
    k('ArrowRight', { shiftKey: true });
    expect(h.pick).toEqual([
      { keys: [keyOf(0), keyOf(1)], gesture: 'brush', source: 'keyboard' },
      { keys: [keyOf(0), keyOf(1), keyOf(2)], gesture: 'brush', source: 'keyboard' },
    ]);
    expect(h.mark.at(-1)?.index).toBe(2);
    k('Enter');
    expect(h.pick.at(-1)).toEqual({ keys: [keyOf(2)], gesture: 'click', source: 'keyboard' });
    const marks = h.mark.length;
    const picks = h.pick.length;
    const esc = k('Escape');
    expect(esc.defaultPrevented).toBe(false);
    const ctrl = k('ArrowRight', { ctrlKey: true });
    expect(ctrl.defaultPrevented).toBe(false);
    expect(h.mark).toHaveLength(marks);
    expect(h.pick).toHaveLength(picks);
    h.visible().clearOps();
    div.dispatchEvent(new FocusEvent('focusout'));
    h.flush();
    expect(h.mark.at(-1)).toBeNull();
    expect(h.visible().calls('drawImage')).toHaveLength(1);
    expect(focusStrokes(h)).toHaveLength(0);

    // New data with 2 rows while the focus is on band 4: the focus moves to band 1.
    focus();
    k('End');
    h.frame.setData(cats(rows.slice(0, 2)));
    h.flush();
    k('Enter');
    expect(h.pick.at(-1)).toEqual({ keys: [keyOf(1)], gesture: 'click', source: 'keyboard' });
  });

  it('after an Escape a Shift move anchors afresh; with no bars nothing is emitted', () => {
    const { h, k, focus, keyOf } = keyed();
    focus();
    k('ArrowDown', { shiftKey: true });
    k('Escape');
    k('ArrowDown', { shiftKey: true });
    expect(h.pick.map((p) => p.keys)).toEqual([
      [keyOf(0), keyOf(1)],
      [keyOf(1), keyOf(2)],
    ]);
    k('ArrowUp');
    k('ArrowUp', { shiftKey: true });
    expect(h.pick.at(-1)?.keys).toEqual([keyOf(0), keyOf(1)]);

    const empty = keyed();
    empty.h.frame.setData(cats([]));
    empty.h.flush();
    const before = empty.h.mark.length;
    empty.focus();
    empty.k('ArrowRight');
    empty.k('Enter');
    expect(empty.h.mark).toHaveLength(before);
    expect(empty.h.pick).toEqual([]);
  });
});

describe('unit:barchart-brush', () => {
  it('a drag fills the bands under it and picks their keys in draw order; cancel picks none', () => {
    const { h, s, band, keyOf } = keyed();
    const x = s.plot.x + 10;
    const yAt = (i: number): number => s.plot.y + (i + 0.5) * band;
    const fills = () =>
      h
        .visible()
        .calls('fillRect')
        .filter((o) => o.fillStyle === colours.selection);
    pointer(h.canvas, 'pointerdown', x, yAt(0));
    pointer(h.canvas, 'pointermove', x, yAt(2));
    h.flush();
    const f = fills().at(-1);
    expect(f).toBeDefined();
    expect(Number(f?.args[0])).toBeCloseTo(s.plot.x, 6);
    expect(Number(f?.args[2])).toBeCloseTo(s.plot.width, 6);
    expect(Number(f?.args[1])).toBeCloseTo(s.plot.y, 6);
    expect(Number(f?.args[3])).toBeCloseTo(3 * band, 6);
    pointer(h.canvas, 'pointerup', x, yAt(2));
    expect(h.pick).toEqual([
      { keys: [keyOf(0), keyOf(1), keyOf(2)], gesture: 'brush', source: 'pointer' },
    ]);
    h.flush();
    h.visible().clearOps();
    h.frame.setSelection({ keys: [fkey(77)], fromMs: null, toMs: null });
    h.flush();
    expect(fills()).toEqual([]);

    pointer(h.canvas, 'pointerdown', x, yAt(2));
    pointer(h.canvas, 'pointermove', x, yAt(0));
    pointer(h.canvas, 'pointerup', x, yAt(0));
    expect(h.pick.at(-1)?.keys).toEqual([keyOf(0), keyOf(1), keyOf(2)]);

    pointer(h.canvas, 'pointerdown', x, yAt(2));
    pointer(h.canvas, 'pointermove', x, s.plot.y + s.plot.height + 20);
    pointer(h.canvas, 'pointerup', x, s.plot.y + s.plot.height + 20);
    expect(h.pick.at(-1)?.keys).toEqual([keyOf(2), keyOf(3), keyOf(4)]);

    const n = h.pick.length;
    pointer(h.canvas, 'pointerdown', x, yAt(0));
    pointer(h.canvas, 'pointermove', x, yAt(2));
    pointer(h.canvas, 'pointercancel', x, yAt(2));
    pointer(h.canvas, 'pointerup', x, yAt(2));
    h.flush();
    h.visible().clearOps();
    h.frame.setSelection(null);
    h.flush();
    expect(h.pick).toHaveLength(n);
    expect(fills()).toEqual([]);
  });
});
