// unit:log-buffer (plan #66 Part B §5.1).
import { describe, expect, it } from 'vitest';
import { logFrame, pageRows, type FrameRow } from '../test/logFrames';
import { LogBuffer, pageFingerprint, wrapLines, type PageResult } from './logBuffer';

const page = (
  rows: readonly FrameRow[],
  cursor: string | null,
  streams?: Record<string, string>[],
): PageResult => ({
  frame: logFrame(rows, streams === undefined ? {} : { streams }),
  cursor,
});
const n1000 = (k: number): FrameRow[] => pageRows(k, 1000);

/** B3: caps {entries: 2500}; k 0, 1, 2 of 1 000 rows, cursors c1, c2, c3. */
function b3(protect: { from: number; to: number } | null = null): LogBuffer {
  const b = new LogBuffer({ entries: 2500 });
  expect(b.accept(0, page(n1000(0), 'c1'), null)).toBe('first');
  expect(b.accept(1, page(n1000(1), 'c2'), null)).toBe('appended');
  expect(b.accept(2, page(n1000(2), 'c3'), protect)).toBe('appended');
  return b;
}

function snapshot(b: LogBuffer) {
  return {
    firstOrd: b.firstOrd,
    endOrd: b.endOrd,
    length: b.length,
    headPage: b.headPage,
    tailPage: b.tailPage,
    knownPages: b.knownPages,
    textUnits: b.textUnits,
  };
}

describe('unit:log-buffer', () => {
  it('B1 first page', () => {
    const b = new LogBuffer();
    const rows: FrameRow[] = [
      { ts: 300n, level: 'error', line: 'a' },
      { ts: 200n, level: 'info', line: 'b' },
      { ts: 100n, level: 'unknown', line: 'c' },
    ];
    expect(b.accept(0, page(rows, 'c1'), null)).toBe('first');
    expect(b.firstOrd).toBe(0);
    expect(b.endOrd).toBe(3);
    const r = b.rowAt(1);
    expect(r).toMatchObject({ ord: 1, tsNs: 200n, level: 3, line: 'b' });
    expect(r?.stream.labels).toEqual({ app: 'x' });
    expect(b.rowAt(3)).toBeNull();
    expect(b.cursorOf(0)).toBeNull();
    expect(b.cursorOf(1)).toBe('c1');
    expect(b.cursorOf(2)).toBeUndefined();
    expect(b.exhausted).toBe(false);
  });

  it('B2 append, end', () => {
    const b = new LogBuffer();
    b.accept(0, page(pageRows(0, 3), 'c1'), null);
    expect(b.accept(1, page(pageRows(1, 2), null), null)).toBe('appended');
    expect(b.endOrd).toBe(5);
    expect(b.rowAt(3)?.line).toBe('p1r0');
    expect(b.exhausted).toBe(true);
    expect(b.total).toBe(5);
  });

  it('B3 entry cap', () => {
    const b = b3();
    expect(b.headPage).toBe(1);
    expect(b.tailPage).toBe(3);
    expect(b.firstOrd).toBe(1000);
    expect(b.endOrd).toBe(3000);
    expect(b.rowAt(999)).toBeNull();
    expect(b.rowAt(1000)?.line).toBe('p1r0');
    expect(b.cursorOf(1)).toBe('c1');
  });

  it('B4 text cap', () => {
    const b = new LogBuffer({ textUnits: 5000 });
    const rows = (k: number) => pageRows(k, 10, () => 'y'.repeat(200));
    b.accept(0, page(rows(0), 'c1'), null);
    b.accept(1, page(rows(1), 'c2'), null);
    b.accept(2, page(rows(2), 'c3'), null);
    expect(b.headPage).toBe(1);
    expect(b.textUnits).toBe(4000);
  });

  it('B5 protect', () => {
    const b = b3({ from: 500, to: 600 });
    expect(b.headPage).toBe(0);
    expect(b.length).toBe(3000);
  });

  it('B6 head re-fetch', () => {
    const b = b3();
    expect(b.accept(0, page(n1000(0), 'c1'), null)).toBe('prepended');
    expect(b.headPage).toBe(0);
    expect(b.tailPage).toBe(2);
    expect(b.endOrd).toBe(2000);
    expect(b.rowAt(0)?.line).toBe('p0r0');
  });

  it('B7 drift by count', () => {
    const b = b3();
    expect(b.accept(0, page(pageRows(0, 999), 'c1'), null)).toBe('drift');
    expect(b.headPage).toBe(1);
    expect(b.length).toBe(2000);
  });

  it('B8 drift by cursor', () => {
    const b = b3();
    expect(b.accept(0, page(n1000(0), 'cX'), null)).toBe('drift');
  });

  it('B9 stale', () => {
    const b = b3();
    const before = snapshot(b);
    expect(b.accept(5, page(n1000(5), 'c6'), null)).toBe('stale');
    expect(b.accept(1, page(n1000(1), 'c2'), null)).toBe('stale');
    expect(snapshot(b)).toEqual(before);
  });

  it('B10 tail re-fetch', () => {
    const b = b3();
    b.accept(0, page(n1000(0), 'c1'), null);
    const other = b3();
    other.accept(0, page(n1000(0), 'c1'), null);
    expect(b.accept(2, page(n1000(2), 'c3'), null)).toBe('appended');
    expect(b.tailPage).toBe(3);
    expect(other.accept(2, page(n1000(2), 'cY'), null)).toBe('drift');
  });

  it('B11 empty page', () => {
    const b = new LogBuffer();
    expect(b.accept(0, page([], 'c1'), null)).toBe('first');
    expect(b.length).toBe(0);
    expect(b.endOrd).toBe(0);
    expect(b.cursorOf(1)).toBe('c1');
    expect(b.accept(1, page(pageRows(1, 2), 'c2'), null)).toBe('appended');
    expect(b.rowAt(0)?.line).toBe('p1r0');
  });

  it('B12 oversized page', () => {
    const b = new LogBuffer({ textUnits: 100 });
    expect(
      b.accept(
        0,
        page(
          pageRows(0, 3, () => 'z'.repeat(100)),
          'c1',
        ),
        null,
      ),
    ).toBe('first');
    expect(b.length).toBe(3);
    expect(b.textUnits).toBe(300);
  });

  it('B13 streams per page', () => {
    const b = new LogBuffer();
    b.accept(0, page(pageRows(0, 1), 'c1', [{ app: 'A' }]), null);
    b.accept(1, page(pageRows(1, 1), null, [{ app: 'B' }]), null);
    expect(b.rowAt(1)?.stream.labels).toEqual({ app: 'B' });
    expect(b.rowAt(0)?.stream.labels).toEqual({ app: 'A' });
  });

  it('B14 drift by content', () => {
    const b = b3();
    const before = snapshot(b);
    const rows = pageRows(0, 1000, (i) => (i === 500 ? 'p0r500x' : `p0r${String(i)}`));
    expect(b.accept(0, page(rows, 'c1'), null)).toBe('drift');
    expect(snapshot(b)).toEqual(before);
  });

  it('B15 drift by stream', () => {
    const b = b3();
    const rows = n1000(0).map((r, i) => (i === 10 ? { ...r, stream: 1 } : r));
    expect(b.accept(0, page(rows, 'c1', [{ app: 'x' }, { app: 'y' }]), null)).toBe('drift');
  });

  it('B16 drift by order', () => {
    // Page 0's rows 3 and 4 share one timestamp; the re-fetch has them swapped.
    const tied = (): FrameRow[] =>
      n1000(0).map((r, i) => (i === 4 ? { ...r, ts: 1767229200000000000n - 3n } : r));
    const b = new LogBuffer({ entries: 2500 });
    b.accept(0, page(tied(), 'c1'), null);
    b.accept(1, page(n1000(1), 'c2'), null);
    b.accept(2, page(n1000(2), 'c3'), null);
    const swapped = tied();
    const [r3, r4] = [swapped[3], swapped[4]];
    if (r3 === undefined || r4 === undefined) throw new Error('rows');
    swapped[3] = r4;
    swapped[4] = r3;
    expect(b.accept(0, page(swapped, 'c1'), null)).toBe('drift');
    expect(b.length).toBe(2000);
  });

  it('B17 fingerprint', () => {
    const a = pageFingerprint(logFrame([{ ts: 1n, level: 'info', line: 'a' }]));
    const a2 = pageFingerprint(logFrame([{ ts: 1n, level: 'info', line: 'a' }]));
    const b = pageFingerprint(logFrame([{ ts: 1n, level: 'info', line: 'b' }]));
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a2).toBe(a);
    expect(b).not.toBe(a);
  });

  it('B18 wrap units', () => {
    const b = new LogBuffer();
    b.accept(
      0,
      page(
        [
          { ts: 2n, level: 'info', line: 'a\tb\n漢' },
          { ts: 1n, level: 'info', line: 'x'.repeat(100_000) },
        ],
        null,
      ),
      null,
    );
    const r = b.rowAt(0);
    if (r === null) throw new Error('row');
    expect(r.wrapUnits).toBe(12);
    expect(r.breaks).toBe(1);
    expect(wrapLines(r, 10)).toBe(5);
    const long = b.rowAt(1);
    if (long === null) throw new Error('row');
    expect(wrapLines(long, 80)).toBe(100);
  });
});
