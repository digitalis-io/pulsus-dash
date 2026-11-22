import { describe, expect, it } from 'vitest';
import { promql } from '../editor/lang/promql/promql';
import { planRun } from './plan';
import { exploreRunKey, planFor, plannable, refusalOf, type PlanInputs } from './useExploreRun';

const W = { fromMs: 0, toMs: 3_600_000 };
const ALL: PlanInputs = { lang: promql, meta: {}, stepMs: 5000, rate: true };

describe('useExploreRun key', () => {
  it('keys of a rewritten and a typed rate differ', () => {
    const bare = planFor('http_requests_total', ALL);
    const typed = planFor('rate(http_requests_total[1m])', ALL);
    expect(bare?.query).toBe('rate(http_requests_total[1m])');
    expect(typed?.query).toBe('rate(http_requests_total[1m])');
    if (bare === null || typed === null) throw new Error('no plan');
    const a = exploreRunKey('demo', 'http_requests_total', bare, W, 5000);
    const b = exploreRunKey('demo', 'rate(http_requests_total[1m])', typed, W, 5000);
    expect(a).not.toEqual(b);
    expect(a.slice(0, 3)).toEqual(['data', 'explore', 'demo']);
    expect(a).toEqual([
      'data',
      'explore',
      'demo',
      'http_requests_total',
      'rate(http_requests_total[1m])',
      'range',
      false,
      0,
      3_600_000,
      5000,
    ]);
  });

  it('an instant key has no step', () => {
    const p = planFor('scalar(vector(1)) / 0', ALL);
    if (p === null) throw new Error('no plan');
    expect(exploreRunKey('demo', 'scalar(vector(1)) / 0', p, W, 5000).at(-1)).toBeNull();
  });

  it('refusalOf', () => {
    expect(refusalOf('a'.repeat(131_073), null)).toBe('queryTooLarge');
    const long = planRun('a'.repeat(70_000), promql.shape('up'), {}, { rate: false, stepMs: 5000 });
    expect(long.tooLong).toBe(true);
    expect(refusalOf('up', long)).toBe('tooLong');
    expect(refusalOf('up', planFor('up', ALL))).toBeNull();
    expect(refusalOf('up', null)).toBeNull();
  });

  it('planFor needs every input', () => {
    expect(planFor('x_total', { ...ALL, meta: null })).toBeNull();
    expect(planFor('x_total', { ...ALL, stepMs: null })).toBeNull();
    expect(planFor('x_total', { ...ALL, lang: null })).toBeNull();
    expect(planFor('x_total', ALL)?.query).toBe('rate(x_total[1m])');
    expect(planFor('  ', ALL)).toBeNull();
    expect(plannable(ALL)).toBe(true);
    expect(plannable({ ...ALL, meta: null })).toBe(false);
  });
});
