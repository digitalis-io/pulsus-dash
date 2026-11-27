/**
 * `unit:geo-marks` (T24 §10.4, §4.11, T24-091, VIZ-044; plan #234 Part 2 §3.3, §4.6, §5): G's
 * marks at fit and at Z3–6, `cluster: false`, order independence, the draw and keyboard orders,
 * the picks, the tie, the crossfade and the UTF-16 order line.
 */
import { describe, expect, it } from 'vitest';
import { G, shuffled } from '../../../vis/geo/fixtures/series';
import { frameOf, pxOf, sceneKit, shownOf } from '../../../test/geoKit';
import { pointer, wheel } from '../../../test/engineHarness';
import { camOf, fitView, viewOf, zoomAbout } from './camera';
import { drawOrder, keyboardOrder, levelMarks, radiiOf, type LaidMark } from './marks';
import { marksInBox, pickMark, placeMarks } from './pick';

const W = 1024;
const H = 512;
const f = frameOf();
const radii = radiiOf(f, { by: 'value', min: 4, max: 20 });
const fit = fitView(shownOf(f), W, H);

const DRAW: [string, string[], number, number, number][] = [
  ['cluster:k03', ['k01', 'k02', 'k03', 'k04', 'k08'], 389.19, 154.65, 14],
  ['cluster:k07', ['k07', 'k18'], 48.0, 215.77, 14],
  ['k05', ['k05'], 976.0, 242.09, 8.944],
  ['k14', ['k14'], 371.94, 411.2, 8],
  ['k06', ['k06'], 827.13, 405.29, 8],
];

function placedAt(z: number, cluster = true, frame = f) {
  const r = radiiOf(frame, { by: 'value', min: 4, max: 20 });
  return placeMarks(drawOrder(levelMarks(frame, r, z, cluster)), fit, W, H);
}

const clusters = (ms: readonly LaidMark[]): [string, number][] =>
  ms.filter((m) => m.kind === 'cluster').map((m) => [m.id, m.keys.length]);

/** A synthetic marker at world (u, v). */
function marker(id: string, r: number, absV: number, rank = 0): LaidMark {
  return { id, kind: 'marker', keys: [id], rows: [0], seed: 0, u: 0.5, v: 0.5, r, rank, absV };
}

describe('unit:geo-marks', () => {
  it('at fit (Z 2): the draw order, members, centres (±0.01 px), radii (±0.001)', () => {
    expect(Math.floor(fit.z)).toBe(2);
    const p = placedAt(2);
    expect(p.marks.map((m) => m.id)).toEqual(DRAW.map((d) => d[0]));
    DRAW.forEach(([id, keys, x, y, r], i) => {
      const m = p.marks[i];
      expect(m?.keys, id).toEqual(keys);
      expect(m?.kind, id).toBe(keys.length > 1 ? 'cluster' : 'marker');
      expect(p.x[i], `${id} x`).toBeCloseTo(x, 2);
      expect(p.y[i], `${id} y`).toBeCloseTo(y, 2);
      expect(m?.r, `${id} r`).toBeCloseTo(r, 3);
    });
  });

  it('the keyboard order', () => {
    expect(keyboardOrder(placedAt(2)).map((m) => m.id)).toEqual([
      'cluster:k03',
      'cluster:k07',
      'k05',
      'k06',
      'k14',
    ]);
  });

  it('the §10.4 picks; (700,60) picks nothing', () => {
    const p = placedAt(2);
    const at = (x: number, y: number) => pickMark(p, x, y)?.id ?? null;
    expect(at(389.19, 154.65)).toBe('cluster:k03');
    expect(at(979.0, 242.09)).toBe('k05');
    expect(at(374.94, 411.2)).toBe('k14');
    expect(at(830.13, 405.29)).toBe('k06');
    expect(at(700, 60)).toBeNull();
  });

  it('the brush (300,80)–(500,200) holds cluster:k03: its keys, sorted', () => {
    expect(marksInBox(placedAt(2), { x: 300, y: 80, width: 200, height: 120 })).toEqual([
      'k01',
      'k02',
      'k03',
      'k04',
      'k08',
    ]);
  });

  it('Z3–6: the cluster ids and member counts; cluster:false joins only identical positions', () => {
    const at = (z: number) => clusters(levelMarks(f, radii, z, true));
    expect(at(3)).toEqual([
      ['cluster:k07', 2],
      ['cluster:k03', 3],
    ]);
    expect(at(4).sort()).toEqual([
      ['cluster:k03', 2],
      ['cluster:k07', 2],
    ]);
    expect(at(5)).toEqual([['cluster:k07', 2]]);
    expect(at(6)).toEqual([['cluster:k07', 2]]);
    const off = levelMarks(f, radii, 2, false);
    expect(off).toHaveLength(9);
    expect(clusters(off)).toEqual([['cluster:k07', 2]]);
  });

  it('shuffled input gives the same marks', () => {
    const s = frameOf(shuffled(G(), 7));
    const ids = (fr: typeof f) => placedAt(2, true, fr).marks.map((m) => [m.id, m.keys]);
    expect(ids(s)).toEqual(ids(f));
  });

  it('the tie: k20, k21 (r 10, rank 0, |v| 5) at (100,100) → k21, drawn last', () => {
    const ms = drawOrder([marker('k21', 10, 5), marker('k20', 10, 5)]);
    expect(ms.map((m) => m.id)).toEqual(['k20', 'k21']);
    const p = { marks: ms, x: new Float64Array([100, 100]), y: new Float64Array([100, 100]) };
    expect(pickMark(p, 100, 100)?.id).toBe('k21');
  });

  it('the draw order: larger r first, then rank, |v| and id', () => {
    const ms = drawOrder([
      marker('a', 8, 5, 4),
      marker('b', 8, 5, 0),
      marker('c', 12, 1, 0),
      marker('d', 8, 1, 0),
    ]);
    expect(ms.map((m) => m.id)).toEqual(['c', 'd', 'b', 'a']);
  });

  it('the order line: kA < k_b < ka < k+U+00E9 < k+U+1F600 < k+U+FFFD (UTF-16 code units)', () => {
    const line = ['kA', 'k_b', 'ka', 'ké', 'k\u{1F600}', 'k�'];
    const ms = drawOrder(shuffled(line, 3).map((id) => marker(id, 8, 1)));
    expect(ms.map((m) => m.id)).toEqual(line);
    const p = placeMarks(ms, fit, W, H);
    expect(keyboardOrder(p).map((m) => m.id)).toEqual(line);
  });

  it('a crossfade: a point under an old-only mark picks nothing', () => {
    // From Z3, where k01 is its own marker, a wheel out to Z2 joins it into cluster:k03.
    const start = { lat: viewOf(fit).lat, lon: viewOf(fit).lon, zoom: 3.2 };
    const k = sceneKit({ spec: { motion: 'ease', view: start } });
    expect(k.marks.at(-1)?.level).toBe(3);
    wheel(k.canvas, 512, 256, { deltaY: 104 });
    const next = zoomAbout(camOf(start), -0.208 / Math.LN2, 512, 256, W, H);
    expect(Math.floor(next.z)).toBe(2);
    k.clock.advance(16);
    k.draw();
    expect(k.marks.at(-1)?.level).toBe(2);
    // 50 ms into the 150 ms crossfade.
    k.clock.advance(50);
    k.draw();
    const p = pxOf(f, 'k01', viewOf(next));
    // The old k01 marker is still painted, fading out.
    const old = k.ctx
      .calls('arc')
      .find(
        (o) =>
          Math.abs((o.args[0] as number) - p.x) < 0.01 &&
          Math.abs((o.args[1] as number) - p.y) < 0.01,
      );
    expect(old?.globalAlpha).toBeGreaterThan(0);
    expect(old?.globalAlpha).toBeLessThan(1);
    pointer(k.canvas, 'pointermove', p.x, p.y);
    pointer(k.canvas, 'pointerdown', p.x, p.y);
    pointer(k.canvas, 'pointerup', p.x, p.y);
    expect(k.selects.map((s) => s.item)).toEqual([null]);
    expect(k.hovers.filter((h) => h !== null)).toEqual([]);
  });
});
