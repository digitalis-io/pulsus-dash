/**
 * Test-only: the seeded Markdown inputs of `bench:markdown-render` (plan #198 Part 2b §5), also used
 * by `bench:text-widget-render` (plan #198 Part 3b §4.3) for its 16 KiB and 64 KiB panels. Input `i`
 * starts with its index, so distinct indices never share a memo entry. Pure ASCII, so the length is
 * the UTF-8 size.
 *
 * This module has no imports: the e2e bench loads it in Node.
 */

const PIECES = [
  '# Service $env overview\n\n',
  'Requests are **steady** and *latency* is fine; see [the board](/boards/b1?x=1) or ',
  '[runbook](https://x.test/runbook). ',
  'Use `rate(http_requests_total[5m])` for the rate.\n\n',
  '- item one with [a link](/b)\n- item two\n- item three ![chart](/l.svg)\n\n',
  '> A quote with <b>html</b> and a [bad](javascript:x) link.\n\n',
  '```promql\nsum by (job) (up)\n```\n\n',
  '1. first\n2. second\n\n',
  'Plain text line that goes on for a while to make up a paragraph of ordinary prose.\n',
];

/** The seeded input `i` of exactly `size` characters (64 KiB by default). */
export function benchInput(i: number, size: number = 64 * 1024): string {
  let s = `Run ${String(i)}\n\n`;
  let k = i;
  while (s.length < size) {
    s += PIECES[k % PIECES.length] ?? '';
    k += 7;
  }
  return s.slice(0, size);
}
