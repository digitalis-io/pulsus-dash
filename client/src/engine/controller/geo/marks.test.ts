/**
 * `unit:geo-radius-project` and `unit:geo-marks-options` (T24 §10.4, T24-090, T24-091; plan #234
 * Part 2 §5): the radii of G and of the min 2 / max 4 sets, the projection block, and a live
 * scene's marks following the size and cluster options at once.
 */
import { describe, expect, it } from 'vitest';
import { inst } from '../../../vis/geo/fixtures/series';
import { frameOf, geoSpec, sceneKit } from '../../../test/geoKit';
import { pointer } from '../../../test/engineHarness';
import { boundsOf, camOf, contain, viewOf } from './camera';
import { radiiOf } from './marks';
import { latOf, normLon, uOf, vOf } from './project';

const RADII: [string, number][] = [
  ['k07', 20],
  ['k03', 16.733],
  ['k04', 15.492],
  ['k18', 14.142],
  ['k01', 12.649],
  ['k02', 11.372],
  ['k08', 10],
  ['k05', 8.944],
  ['k06', 8],
  ['k14', 8],
];

/** Rows at distinct coordinates with these values; `groupBy: env` (absent) makes one group. */
function valued(values: readonly number[], oneGroup: boolean) {
  const series = values.map((v, i) =>
    inst(`v${String(i)}`, { lat: String(i + 1), lon: String(i + 1) }, v),
  );
  return frameOf(series, { opts: oneGroup ? { groupBy: 'env' } : {} });
}

describe('unit:geo-radius-project', () => {
  it('G, the default size (4, 20): the radii block', () => {
    const f = frameOf();
    const r = radiiOf(f, { by: 'value', min: 4, max: 20 });
    for (const [key, want] of RADII) {
      const i = f.rows.findIndex((x) => x.key === key);
      expect(r[i], key).toBeCloseTo(want, 3);
    }
  });

  it('min 2 max 4: patterned → 8 for 0, 75, 300, all-zero and fixed; one group → 2, 2, 4, 2, 4', () => {
    const size = { by: 'value', min: 2, max: 4 } as const;
    const fixed = { by: 'fixed', min: 2, max: 4 } as const;
    const many = valued([0, 75, 300], false);
    expect(many.groups.length).toBeGreaterThan(1);
    expect([...radiiOf(many, size)]).toEqual([8, 8, 8]);
    expect([...radiiOf(valued([0, 0], false), size)]).toEqual([8, 8]);
    expect([...radiiOf(many, fixed)]).toEqual([8, 8, 8]);
    const one = valued([0, 75, 300], true);
    expect(one.groups).toHaveLength(1);
    expect([...radiiOf(one, size)].map((x) => Number(x.toFixed(9)))).toEqual([2, 2, 4]);
    expect([...radiiOf(valued([0, 0], true), size)]).toEqual([2, 2]);
    expect([...radiiOf(one, fixed)]).toEqual([4, 4, 4]);
  });

  it('the projection block (±1e−12)', () => {
    expect(uOf(179.9)).toBeCloseTo(0.9997222222222222, 12);
    expect(uOf(-179.9)).toBeCloseTo(0.000277777777777762, 12);
    expect(normLon(180)).toBe(-180);
    expect(uOf(180)).toBe(0);
    expect(vOf(85.0511)).toBeCloseTo(9.26703349835023e-7, 12);
    expect(latOf(0)).toBeCloseTo(85.0511287798066, 12);
    const c = contain(camOf({ lat: 0, lon: 179.9, zoom: 4 }), 1024, 512);
    expect(viewOf(c).lon).toBeCloseTo(135, 12);
    const b = boundsOf(c, 1024, 512);
    expect(b.west).toBeCloseTo(90, 12);
    expect(b.south).toBeCloseTo(-21.943045533438177, 12);
    expect(b.east).toBeCloseTo(180, 12);
    expect(b.north).toBeCloseTo(21.943045533438177, 12);
  });
});

/** The radii of the circles a draw painted (markers and cluster discs; no rings without a selection). */
const arcRadii = (k: ReturnType<typeof sceneKit>): number[] =>
  k.ctx.calls('arc').map((o) => Number((o.args[2] as number).toFixed(3)));

describe('unit:geo-marks-options', () => {
  it('a size change resizes every marker at once; a cluster change re-clusters and emits geoMarks', () => {
    const k = sceneKit({ spec: { motion: 'cut' } });
    expect(arcRadii(k).sort((a, b) => a - b)).toEqual([8, 8, 8.944, 14, 14]);
    const before = k.marks.length;
    k.scene.setSpec(geoSpec({ motion: 'cut', size: { by: 'fixed', min: 4, max: 12 } }));
    k.draw();
    expect(arcRadii(k).sort((a, b) => a - b)).toEqual([12, 12, 12, 14, 14]);
    // k05 at (976.00, 242.09): picked within r + 4 = 16 px, not at 17.
    pointer(k.canvas, 'pointerdown', 976 - 15.5, 242.09);
    pointer(k.canvas, 'pointerup', 976 - 15.5, 242.09);
    pointer(k.canvas, 'pointerdown', 976 - 16.5, 242.09);
    pointer(k.canvas, 'pointerup', 976 - 16.5, 242.09);
    expect(k.selects.map((s) => (s.item?.kind === 'geo' ? s.item.id : null))).toEqual([
      'k05',
      null,
    ]);
    k.scene.setSpec(
      geoSpec({ motion: 'cut', size: { by: 'fixed', min: 4, max: 12 }, cluster: false }),
    );
    k.draw();
    expect(k.marks.length).toBe(before + 1);
    const m = k.marks.at(-1);
    expect(m?.marks).toHaveLength(9);
    expect(m?.marks.filter((x) => x.kind === 'cluster').map((x) => x.id)).toEqual(['cluster:k07']);
  });
});
