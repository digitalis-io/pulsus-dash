import { describe, expect, it } from 'vitest';
import { aggregateInp, gateFailures, type InpEntry, type InpStep } from './inp.ts';

const entry = (
  doc: number,
  interactionId: number,
  startTime: number,
  duration: number,
): InpEntry => ({
  doc,
  interactionId,
  startTime,
  duration,
});
const step = (doc: number, label: string, count: number, t: number): InpStep => ({
  doc,
  label,
  count,
  t,
});

describe('aggregate inp', () => {
  it('aggregate inp', () => {
    const steps = [step(1, 'a', 1, 0), step(1, 'b', 1, 200), step(2, 'c', 2, 0)];
    const r = aggregateInp(
      [entry(1, 1, 100, 120), entry(1, 1, 110, 130), entry(2, 1, 50, 80), entry(2, 2, 60, 40)],
      steps,
    );
    expect(r.documents.map((d) => d.doc)).toEqual([1, 2]);
    const [d1, d2] = r.documents;
    // Interaction 1 of document 1: two entries, counted once at their maximum, labelled by the
    // last step of document 1 at or before its start.
    expect(d1).toEqual({
      doc: 1,
      inp: 130,
      n: 2,
      reported: 1,
      slowest: { label: 'a', duration: 130 },
    });
    // Interaction 1 of document 2 is a different interaction.
    expect(d2).toEqual({
      doc: 2,
      inp: 80,
      n: 2,
      reported: 2,
      slowest: { label: 'c', duration: 80 },
    });
    expect(r.worst).toBe(130);

    // 70 performed, 3 reported: padded with zeros to 70; one outlier ignored per 50.
    const padded = aggregateInp(
      [entry(1, 1, 10, 300), entry(1, 2, 20, 250), entry(1, 3, 30, 90)],
      [step(1, 'x', 40, 0), step(1, 'y', 30, 5)],
    );
    expect(padded.documents[0]?.inp).toBe(250);
    expect(padded.documents[0]?.n).toBe(70);

    const many = Array.from({ length: 71 }, (_, i) => entry(1, i + 1, i, 20));
    expect(() => aggregateInp(many, [step(1, 'x', 70, 0)])).toThrow(
      'more interactions reported than performed',
    );
    expect(() => aggregateInp([entry(3, 1, 0, 20)], [step(1, 'x', 1, 0)])).toThrow(
      'entries for an unscripted document',
    );
    const unlabelled = aggregateInp([entry(1, 1, 5, 20)], [step(1, 'late', 1, 10)]);
    expect(unlabelled.documents[0]?.slowest).toEqual({ label: 'unlabelled', duration: 20 });
  });

  it('inp is per document', () => {
    const entries = [
      entry(1, 1, 1, 300),
      ...Array.from({ length: 19 }, (_, i) => entry(1, i + 2, i + 2, 50)),
      ...Array.from({ length: 40 }, (_, i) => entry(2, i + 1, i + 1, 50)),
      ...Array.from({ length: 12 }, (_, i) => entry(3, i + 1, i + 1, 50)),
    ];
    const steps = [step(1, 'one', 20, 0), step(2, 'two', 40, 0), step(3, 'three', 12, 0)];
    const r = aggregateInp(entries, steps);
    expect(r.documents.map((d) => [d.doc, d.inp, d.n])).toEqual([
      [1, 300, 20],
      [2, 50, 40],
      [3, 50, 12],
    ]);
    expect(r.worst).toBe(300);
    expect(gateFailures(r, 200)).toEqual([r.documents[0]]);
    expect(gateFailures(r, 300)).toEqual([]);
  });
});
