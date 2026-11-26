/**
 * bench:markdown-render (report-only; plan #198 Part 2b §5; T24 §7): 50 distinct seeded 64 KiB
 * inputs (`benchInputs.ts`), each prefixed with its index so that every LRU lookup misses. Prints the uncached p95
 * against the 16 ms budget and asserts that no lookup hit the memo. The time is not asserted.
 */
import { describe, expect, it } from 'vitest';
import { benchInput } from './benchInputs';
import { memoStats, renderMarkdown } from './markdown';

const RUNS = 50;
const BUDGET_MS = 16;

describe('bench:markdown-render', () => {
  it('reports the uncached p95 of a 64 KiB render', () => {
    const inputs = Array.from({ length: RUNS }, (_, i) => benchInput(i));
    const env = { vars: new Map([['env', 'prod']]), entity: null };
    const opts = { policy: 'board' as const, appOrigin: 'https://dash.test' };
    const before = memoStats();
    const times: number[] = [];
    for (const src of inputs) {
      const t0 = performance.now();
      renderMarkdown(src, env, opts);
      times.push(performance.now() - t0);
    }
    const after = memoStats();
    expect(after.hits - before.hits).toBe(0);
    expect(after.misses - before.misses).toBe(RUNS);
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(0.95 * times.length) - 1] ?? 0;
    console.info(
      `bench:markdown-render: ${String(RUNS)} uncached 64 KiB renders, p95 ${p95.toFixed(2)} ms (budget ${String(BUDGET_MS)} ms, report-only)`,
    );
  }, 120_000);
});
