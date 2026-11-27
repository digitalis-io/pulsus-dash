/**
 * `unit:geo-state-glyph` (T24 §10.4 S, T24-090, VIZ-067; plan #234 Part 2 §4.7, §5): state is never
 * colour alone. `colour: 'state'` fills with the state colour, the pattern over it and the state
 * glyph; `colour: 'group'` keeps the group fill and adds a 2 px state outline and the glyph; a
 * marker below r 8 carries its glyph at its upper right on a `surface-2` chip.
 */
import { describe, expect, it } from 'vitest';
import { colour } from '../../../styles/tokens';
import { StateEncoding } from '../../../theme/stateEncoding';
import { frameOf, geoSpec } from '../../../test/geoKit';
import { recordingContext, type RecordedOp } from '../../../test/recordingContext';
import { S, S1, TH } from '../../../vis/geo/fixtures/series';
import type { GeoFrame } from '../../../vis/geo/frame';
import type { GeoMapSpec } from '../../api';
import { radiiOf, rankOf, type LaidMark } from '../../controller/geo/marks';
import { themeColours } from '../palette';
import { paintMarks } from './paint';

const C = themeColours('dark');
const FAILING = StateEncoding.failing.colour.dark;
const TEXT = colour.dark.text;
const CHIP = colour.dark['surface-2'];
const THRESHOLDS = [
  { value: 150, state: 'watch', label: '' },
  { value: 200, state: 'degraded', label: '' },
  { value: 250, state: 'failing', label: '' },
] as const;

/** The marker of `key` alone at (100, 100), radius from the frame. */
function paintOne(f: GeoFrame, spec: GeoMapSpec, key: string): RecordedOp[] {
  const i = f.rows.findIndex((r) => r.key === key);
  const row = f.rows[i];
  if (row === undefined) throw new Error(key);
  const r = radiiOf(f, spec.size)[i] ?? 0;
  const m: LaidMark = {
    id: key,
    kind: 'marker',
    keys: [key],
    rows: [i],
    seed: i,
    u: 0.5,
    v: 0.5,
    r,
    rank: rankOf(row.state),
    absV: Math.abs(row.value),
  };
  const ctx = recordingContext();
  paintMarks(ctx, { marks: [m], x: new Float64Array([100]), y: new Float64Array([100]) }, 1, {
    frame: f,
    spec,
    colours: C,
    pattern: () => ({}) as CanvasPattern,
    selected: null,
    focusId: null,
  });
  return ctx.ops;
}

const index = (ops: readonly RecordedOp[], f: (o: RecordedOp) => boolean): number =>
  ops.findIndex(f);

describe('unit:geo-state-glyph', () => {
  it("colour 'state': s2 filled failing, the pattern over it, then the failing glyph at its centre", () => {
    const f = frameOf(S(), { th: TH, opts: { groupBy: 'env', colour: 'state' } });
    const spec = geoSpec({ colour: 'state', labels: 'none', thresholds: THRESHOLDS });
    const ops = paintOne(f, spec, 's2');
    const fill = index(ops, (o) => o.op === 'fill' && o.fillStyle === FAILING);
    const pattern = index(ops, (o) => o.op === 'fill' && o.fillStyle === 'gradient-or-pattern');
    const glyph = index(
      ops,
      (o) => o.op === 'fillText' && o.args[0] === StateEncoding.failing.glyph,
    );
    expect(fill).toBeGreaterThanOrEqual(0);
    expect(pattern).toBeGreaterThan(fill);
    expect(glyph).toBeGreaterThan(pattern);
    const g = ops[glyph];
    expect(g?.fillStyle).toBe(TEXT);
    expect(g?.args[1]).toBeCloseTo(100, 6);
    expect(g?.args[2]).toBeCloseTo(100, 6);
  });

  it('a marker below r 8: the glyph at its upper right, on a surface-2 chip', () => {
    const f = frameOf(S1(), { th: TH, opts: { groupBy: 'env', colour: 'state' } });
    const spec = geoSpec({
      colour: 'state',
      labels: 'none',
      thresholds: THRESHOLDS,
      size: { by: 'value', min: 2, max: 4 },
    });
    expect(f.groups).toHaveLength(1);
    const ops = paintOne(f, spec, 's2');
    const glyph = index(
      ops,
      (o) => o.op === 'fillText' && o.args[0] === StateEncoding.failing.glyph,
    );
    const chip = index(
      ops,
      (o) => (o.op === 'fill' || o.op === 'fillRect') && o.fillStyle === CHIP,
    );
    expect(chip).toBeGreaterThanOrEqual(0);
    expect(glyph).toBeGreaterThan(chip);
    const g = ops[glyph];
    expect(g?.args[1] as number).toBeGreaterThan(100);
    expect(g?.args[2] as number).toBeLessThan(100);
  });

  it("colour 'group': the group fill, the pattern, a 2 px failing outline and the same glyph", () => {
    const f = frameOf(S(), { th: TH, opts: { groupBy: 'env' } });
    const spec = geoSpec({ colour: 'group', labels: 'none', thresholds: THRESHOLDS });
    const ops = paintOne(f, spec, 's2');
    const group = f.groups[f.rows.find((r) => r.key === 's2')?.group ?? -1];
    const fillColour = C.series[group?.colourIndex ?? -1];
    const fill = index(ops, (o) => o.op === 'fill' && o.fillStyle === fillColour);
    const pattern = index(ops, (o) => o.op === 'fill' && o.fillStyle === 'gradient-or-pattern');
    const outline = index(
      ops,
      (o) => o.op === 'stroke' && o.strokeStyle === FAILING && o.lineWidth === 2,
    );
    const glyph = index(
      ops,
      (o) => o.op === 'fillText' && o.args[0] === StateEncoding.failing.glyph,
    );
    expect(fill).toBeGreaterThanOrEqual(0);
    expect(pattern).toBeGreaterThan(fill);
    expect(outline).toBeGreaterThan(fill);
    expect(glyph).toBeGreaterThan(outline);
    expect(ops[glyph]?.fillStyle).toBe(TEXT);
    // No state fill in group colour mode.
    expect(index(ops, (o) => o.op === 'fill' && o.fillStyle === FAILING)).toBe(-1);
  });
});
