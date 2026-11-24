import { describe, expect, it } from 'vitest';
import { promql } from '../editor/lang/promql/promql';
import { exploreRunKey, refusalOf, runKind, runnable } from './useExploreRun';

const W = { fromMs: 0, toMs: 3_600_000 };
/** `docOf(n)` is `n` UTF-8 bytes (Part B). */
const docOf = (n: number): string => '#' + 'a'.repeat(n - 10) + '\nup{job="';

describe('useExploreRun key', () => {
  it('U1: the key holds the raw text, the kind and the rate', () => {
    const on = exploreRunKey('demo', 'http_requests_total', 'range', true, W, 5000);
    expect(on).toEqual([
      'data',
      'explore',
      'demo',
      'http_requests_total',
      'range',
      true,
      0,
      3_600_000,
      5000,
    ]);
    const off = exploreRunKey('demo', 'http_requests_total', 'range', false, W, 5000);
    expect(off.map((v, i) => (v === on[i] ? null : i)).filter((i) => i !== null)).toEqual([5]);
  });

  it('U2: runKind', () => {
    expect(runKind('scalar(vector(1)) / 0', promql)).toBe('instant');
    expect(runKind('up', promql)).toBe('range');
    expect(runKind('  ', promql)).toBeNull();
    expect(runKind('up', null)).toBeNull();
    // Degraded (#147): without a language every non-blank text is a range query.
    expect(runKind('up', null, true)).toBe('range');
    expect(runKind('1 + 1', null, true)).toBe('range');
    expect(runKind('  ', null, true)).toBeNull();
    expect(runKind('1 + 1', promql, true)).toBe('instant');
  });

  it('U3: refusalOf', () => {
    expect(refusalOf(docOf(131_073))).toBe('queryTooLarge');
    expect(refusalOf('a'.repeat(70_000))).toBeNull();
  });

  it('U4: runnable needs the language and the step', () => {
    expect(runnable({ lang: promql, degraded: false, stepMs: 5000, rate: true })).toBe(true);
    expect(runnable({ lang: promql, degraded: false, stepMs: null, rate: true })).toBe(false);
    expect(runnable({ lang: null, degraded: false, stepMs: 5000, rate: true })).toBe(false);
    // Degraded (#147): the step is still needed, the language is not.
    expect(runnable({ lang: null, degraded: true, stepMs: 5000, rate: true })).toBe(true);
    expect(runnable({ lang: null, degraded: true, stepMs: null, rate: true })).toBe(false);
  });
});
