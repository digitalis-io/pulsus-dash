import { describe, expect, it } from 'vitest';
import { KEY_PATTERN, type FrameData } from '../data/frames';
import { GALLERY_SEED, galleryEntries } from './gallery';
import { keyHash } from './keyHash';

const W = { fromMs: Date.UTC(2026, 10, 19, 12), toMs: Date.UTC(2026, 10, 19, 13) };

function shape(d: FrameData): [number, number] {
  if (d.kind === 'series') return [d.series.length, d.series[0]?.timestamps.length ?? 0];
  if (d.kind === 'heatmap') return [d.heatmap.timestamps.length, d.heatmap.bounds.length];
  return [1, 1];
}

describe('unit:synth', () => {
  it('is deterministic for a seed and differs for another seed', () => {
    const a = galleryEntries(W);
    const b = galleryEntries(W);
    expect(a.map((e) => e.id)).toEqual([
      'line-1',
      'line-50',
      'line-gaps',
      'line-600',
      'heatmap',
      'bars',
      'stat',
    ]);
    expect(b).toEqual(a);
    for (const [i, e] of a.entries()) {
      const f = b[i]?.data;
      if (e.data.kind === 'series' && f?.kind === 'series') {
        e.data.series.forEach((s, j) => {
          expect([...s.values]).toEqual([...(f.series[j]?.values ?? [])]);
          expect([...s.timestamps]).toEqual([...(f.series[j]?.timestamps ?? [])]);
        });
      }
    }
    const c = galleryEntries(W, GALLERY_SEED + 100);
    const v0 = a[0]?.data.kind === 'series' ? [...(a[0].data.series[0]?.values ?? [])] : [];
    const v1 = c[0]?.data.kind === 'series' ? [...(c[0].data.series[0]?.values ?? [])] : [];
    expect(v1).not.toEqual(v0);
  });

  it('has the shapes, gaps and keys of the gallery', () => {
    const e = galleryEntries(W);
    expect(e.slice(0, 6).map((x) => shape(x.data))).toEqual([
      [1, 1440],
      [50, 1440],
      [3, 1440],
      [600, 60],
      [60, 12],
      [5, 60],
    ]);
    const gaps = e[2]?.data;
    if (gaps?.kind !== 'series') throw new Error('line-gaps is not series');
    const nanAt = (j: number): number[] =>
      [...(gaps.series[j]?.values ?? [])].flatMap((v, k) => (Number.isNaN(v) ? [k] : []));
    expect(nanAt(0)).toEqual(Array.from({ length: 60 }, (_, i) => 300 + i));
    expect(nanAt(1)).toEqual(
      Array.from({ length: 1440 }, (_, k) => k).filter((k) => k % 97 === 13),
    );
    expect(nanAt(2)).toEqual(
      Array.from({ length: 20 }, (_, i) => 500 + i).filter((k) => k !== 510),
    );
    const keys: string[] = [];
    for (const x of e) {
      if (x.data.kind !== 'series') continue;
      for (const s of x.data.series) {
        expect(s.key).toMatch(KEY_PATTERN);
        keys.push(s.key);
      }
    }
    expect(new Set(keys).size).toBe(keys.length);
    const stat = e[6]?.data;
    expect(stat).toEqual({ kind: 'scalar', scalar: { value: 2843, timestampMs: W.toMs } });
  });

  it('keyHash is stable for reordered label objects', () => {
    expect(keyHash({ a: '1', b: '2' })).toBe(keyHash({ b: '2', a: '1' }));
    expect(keyHash({ a: '1', b: '2' })).toMatch(KEY_PATTERN);
    expect(keyHash({ a: '1' })).not.toBe(keyHash({ a: '2' }));
  });
});
