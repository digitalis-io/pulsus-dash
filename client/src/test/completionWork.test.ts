import { describe, expect, it, vi } from 'vitest';
import {
  breaches,
  checkGate,
  KEY_WORK_P95_MS,
  keyWorkOf,
  summary,
  unionMs,
  type Work,
} from './completionWork';

// Plan #107 §5.3: the bench's work arithmetic and enforce gate, on injected samples.

/** An entry for the interval `[start, end]`. */
const w = (start: number, end: number, kind: Work[2]): Work => [end, end - start, kind];

describe('bench:promql-completion-latency arithmetic', () => {
  it('W1: overlapping slot intervals count once', () => {
    // The union arithmetic: where two entries overlap, the shared part counts once.
    const ws = [w(10, 13, 'slot0'), w(11, 14, 'slot1pre')];
    expect(unionMs(ws)).toBe(4);
    expect(keyWorkOf(ws, 0, 20)).toMatchObject({ keyWork: 4, completionMs: 4, slot0s: 1 });
  });

  it('W2: contained, disjoint and touching intervals', () => {
    expect(unionMs([w(0, 10, 'slot0'), w(2, 3, 'slot1pre')])).toBe(10);
    expect(unionMs([w(0, 1, 'doc'), w(5, 7, 'view')])).toBe(3);
    expect(unionMs([w(0, 1, 'slot0'), w(1, 2, 'slot1pre'), w(1.5, 4, 'slot0')])).toBe(4);
    expect(unionMs([])).toBe(0);
  });

  it('W3: keyWork is the key’s document update, its completion work and the popup render', () => {
    const ws = [
      w(98, 99.5, 'view'), // before the keydown
      w(100.1, 101.3, 'doc'),
      w(102, 102.8, 'slot0'),
      w(102.2, 103, 'slot1pre'),
      w(104, 104.3, 'view'),
      w(104.5, 104.6, 'slot1post'), // remote processing: not the key's
      w(240, 241, 'slot1post'),
    ];
    const k = keyWorkOf(ws, 100, 105);
    expect(k.docMs).toBeCloseTo(1.2, 9);
    expect(k.completionMs).toBeCloseTo(1, 9);
    expect(k.keyWork).toBeCloseTo(2.5, 9);
    expect(k.docs).toBe(1);
    expect(k.slot0s).toBe(1);
  });

  /** 30 keys of `doc` ms, then slot 0 and slot 1 overlapping over `[0, slot]`, then a 0.3 ms popup. */
  function keys(doc: number, slot: number) {
    const ws: Work[] = [];
    const spans: [number, number][] = [];
    for (let i = 0; i < 30; i++) {
      const t = i * 100;
      ws.push(
        w(t, t + doc, 'doc'),
        w(t + 10, t + 10 + slot, 'slot0'),
        w(t + 10 + slot / 4, t + 10 + slot, 'slot1pre'),
        w(t + 20, t + 20.3, 'view'),
      );
      spans.push([t, t + 30]);
    }
    const perKey = spans.map(([a, b]) => keyWorkOf(ws, a, b));
    return {
      keyWork: summary(perKey.map((k) => k.keyWork)),
      docMs: summary(perKey.map((k) => k.docMs)),
      completionMs: summary(perKey.map((k) => k.completionMs)),
    };
  }
  const fast = { local: { p95: 12 }, remote: { p95: 130 }, over16: 0 };

  it('G1: each part under 2 ms, their sum over: a breach, red under enforce', () => {
    const r = keys(1.2, 1);
    expect(r.docMs.p95).toBeLessThan(KEY_WORK_P95_MS);
    expect(r.completionMs.p95).toBeLessThan(KEY_WORK_P95_MS);
    expect(r.keyWork.p95).toBeCloseTo(2.5, 9);
    const bs = breaches({ ...fast, keyWork: r.keyWork });
    expect(bs).toEqual(['keyWork p95 2.50 ms > 2 ms (T09 §7)']);
    expect(() => {
      checkGate(bs, true, () => undefined);
    }).toThrow('enforce gate: keyWork p95 2.50 ms > 2 ms (T09 §7)');
    const warn = vi.fn();
    checkGate(bs, false, warn);
    expect(warn.mock.calls).toEqual([['keyWork p95 2.50 ms > 2 ms (T09 §7)']]);
  });

  it('G2: the overlap of the two slots does not inflate keyWork', () => {
    // 0.2 + 1.4 + 0.3 = 1.9 ms of work; the slots' plain sum would add 1.05 ms more (2.95 ms).
    const r = keys(0.2, 1.4);
    expect(r.completionMs.p95).toBeCloseTo(1.4, 9);
    expect(r.keyWork.p95).toBeCloseTo(1.9, 9);
    const bs = breaches({ ...fast, keyWork: r.keyWork });
    expect(bs).toEqual([]);
    expect(() => {
      checkGate(bs, true, () => undefined);
    }).not.toThrow();
  });

  it('G3: every other threshold', () => {
    expect(
      breaches({ local: { p95: 16.5 }, remote: { p95: 137 }, over16: 2, keyWork: { p95: 2 } }),
    ).toEqual([
      'local p95 16.50 ms > 16 ms (T09 §7)',
      'remote p95 137.00 ms > 136 ms (T09-007)',
      '2 main-thread tasks over 16 ms (PRF-005)',
    ]);
  });
});
