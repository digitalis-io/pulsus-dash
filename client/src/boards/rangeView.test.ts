import { describe, expect, it } from 'vitest';
import { identityKey } from '../data/rangeStore';
import { chunkable, coarseStep, ladderOf, planRangeView, usesRangeMacro } from './rangeView';

const H = 3_600_000;
const B = 3_840_000;

const plan = (fromMs: number, toMs: number, o: { line?: boolean; anchorMs?: number; text?: string } = {}) =>
  planRangeView({
    tenant: 'demo',
    scope: 'A',
    text: o.text ?? 'up',
    vars: '[]',
    rate: true,
    line: o.line ?? true,
    window: { fromMs, toMs },
    widthPx: 1200,
    epoch: 0,
    anchorMs: o.anchorMs ?? 1_000 * B,
  });

describe('rangeView (#304 §4.1, §A.7)', () => {
  it('chunkable and usesRangeMacro', () => {
    expect(chunkable('up')).toBe(true);
    expect(chunkable('rate(x[5m] @ start())')).toBe(false);
    expect(chunkable('x @ end( )')).toBe(false);
    expect(chunkable('x @ 1700000000')).toBe(true);
    expect(usesRangeMacro('increase(x[$__range])')).toBe(true);
    expect(usesRangeMacro('x / ${__range_s}')).toBe(true);
    expect(usesRangeMacro('x * $__range_ms')).toBe(true);
    expect(usesRangeMacro('rate(x[$__rate_interval])')).toBe(false);
  });

  it('plans the grid, buckets and flanks', () => {
    const v = plan(10 * B, 10 * B + H);
    expect(v?.grid).toEqual({ startMs: 10 * B, endMs: 10 * B + H, stepMs: 15_000 });
    expect(v?.visible).toEqual({ k0: 10, k1: 11 });
    expect(v?.flanks).toEqual([
      { k0: 9, k1: 10 },
      { k0: 11, k1: 12 },
    ]);
    expect(v?.windowMs).toBe(H);
    expect(v?.id.rangeMs).toBeNull();
    expect(v?.idKey).toBe(identityKey(v?.id ?? (null as never)));
    expect(plan(10 * B, 10 * B + H, { line: false })?.flanks).toEqual([]);
    // Left clamped at bucket 0; right dropped past the anchor's bucket.
    expect(plan(0, H)?.flanks).toEqual([{ k0: 1, k1: 2 }]);
    expect(plan(10 * B, 10 * B + H, { anchorMs: 10 * B + H })?.flanks).toEqual([
      { k0: 9, k1: 10 },
    ]);
    expect(plan(10 * B, 10 * B + H, { text: 'increase(x[$__range])' })?.id.rangeMs).toBe(H);
  });

  it('ladder levels', () => {
    const at = (span: number) => plan(100 * B, 100 * B + span);
    const steps = (span: number) => {
      const v = at(span);
      return v === null ? null : ladderOf(v, 1200).map((l) => [l.factor, l.stepMs]);
    };
    expect(at(H)?.id.stepMs).toBe(15_000);
    expect(steps(H)).toEqual([[9, 30_000]]);
    expect(at(6 * H)?.id.stepMs).toBe(15_000);
    expect(steps(6 * H)).toEqual([
      [3, 60_000],
      [9, 120_000],
    ]);
    expect(at(24 * H)?.id.stepMs).toBe(60_000);
    expect(steps(24 * H)).toEqual([
      [3, 300_000],
      [9, 600_000],
    ]);
    const v = at(6 * H);
    const three = v === null ? undefined : ladderOf(v, 1200)[0];
    // 18 h about the centre at 60 s: buckets of 256 min.
    const c = 100 * B + 3 * H;
    const k = 256 * 60_000;
    expect(three?.run).toEqual({ k0: Math.floor((c - 9 * H) / k), k1: Math.floor((c + 9 * H) / k) + 1 });
  });

  it('coarse step', () => {
    const one = plan(100 * B, 100 * B + H);
    const six = plan(100 * B, 100 * B + 6 * H);
    expect(one === null ? undefined : coarseStep(one, 1200)).toBeNull();
    expect(six === null ? undefined : coarseStep(six, 1200)).toBe(60_000);
  });
});
