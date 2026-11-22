import { describe, expect, it, vi } from 'vitest';
import type { SeriesFrame, VisSpec } from '../api';
import { keyHash } from '../../dev/keyHash';
import { harness, LINE_NONE, seriesData, seriesFrame } from '../../test/engineHarness';
import { colour, seriesPalette } from '../../styles/tokens';
import { StateEncoding } from '../../theme/stateEncoding';
import { Canvas2DEngine } from './Canvas2DEngine';
import { seriesColourIndex, themeColours } from './palette';

const TS = [0, 1_000, 2_000];
const W = { fromMs: 0, toMs: 2_000 };

function other(i: number, extra: Record<string, string> = {}): SeriesFrame {
  // Keys ending in 1, 2, 3 …: key_hash mod 8 = i mod 8, never 5 for i in 1..4 and 9..12.
  const labels = { __name__: 'other', i: String(i), ...extra };
  return seriesFrame(`000000000000000${(i % 16).toString(16)}`, TS, [i, i + 1, i + 2], labels);
}

function strokes(Engine: typeof Canvas2DEngine, spec: VisSpec, series: SeriesFrame[]): string[] {
  const h = harness(Engine);
  h.frame.setSpec(spec);
  h.frame.setData(seriesData(...series));
  h.frame.setTimeWindow(W);
  h.frame.resize(400, 200, 1);
  h.flush();
  return h
    .layer()
    .calls('stroke')
    .map((o) => o.strokeStyle);
}

function fills(spec: VisSpec, series: SeriesFrame[]): string[] {
  const h = harness(Canvas2DEngine);
  h.frame.setSpec(spec);
  h.frame.setData(seriesData(...series));
  h.frame.setTimeWindow({ fromMs: 0, toMs: 3_000 });
  h.frame.resize(400, 200, 1);
  h.flush();
  return h
    .layer()
    .calls('fillRect')
    .map((o) => o.fillStyle);
}

const bars = (order: readonly string[]): VisSpec => ({
  kind: 'bars',
  title: 'T',
  unit: { kind: 'none' },
  stacking: 'normal',
  categoryLabel: 'level',
  categoryOrder: order,
});

describe('unit:colour-hash', () => {
  it('series A has the same colour in every chart and after a reload', async () => {
    const labels = { __name__: 'up', pod: 'pod-007' };
    const a = seriesFrame(keyHash(labels), TS, [5, 6, 7], labels);
    const want = seriesPalette.dark[seriesColourIndex(a)];
    const s1 = strokes(Canvas2DEngine, LINE_NONE, [a, other(1), other(2)]);
    const s2 = strokes(
      Canvas2DEngine,
      LINE_NONE,
      [1, 2, 3, 4, 9, 10, 11, 12, 3].map((i) => other(i)).concat(a),
    );
    vi.resetModules();
    const reloaded = (await import('./Canvas2DEngine')).Canvas2DEngine;
    expect(reloaded).not.toBe(Canvas2DEngine);
    const s3 = strokes(reloaded, LINE_NONE, [other(1), a, other(2)]);
    expect([s1[0], s2[9], s3[1]]).toEqual([want, want, want]);
  });

  it('uses key_hash mod 8 without a level label', () => {
    expect(seriesColourIndex({ key: 'ffffffffffffffa5', labels: {} })).toBe(5);
    expect(seriesColourIndex({ key: 'ffffffffffffff0f', labels: { pod: 'x' } })).toBe(7);
  });

  it('gives log levels their table colour in every chart', () => {
    const levels = ['error', 'warn', 'info', 'debug', 'trace'];
    const mk = (level: string): SeriesFrame => {
      const labels = { level, service_name: 'checkout' };
      return seriesFrame(keyHash(labels), [0, 1_000, 2_000], [3, 4, 5], labels);
    };
    const e = mk('error');
    const red = seriesPalette.dark[5];
    const count = (xs: string[]): number => xs.filter((x) => x === red).length;
    expect(count(fills(bars(levels), levels.map(mk)))).toBe(3);
    expect(count(fills(bars([...levels].reverse()), [...levels].reverse().map(mk)))).toBe(3);
    expect(count(fills(bars(['error', 'info']), [mk('error'), mk('info')]))).toBe(3);
    const line = strokes(Canvas2DEngine, LINE_NONE, [other(1), other(2), e, other(3)]);
    expect(line[2]).toBe(red);
    expect(seriesColourIndex(e)).toBe(5);
    expect(
      seriesColourIndex({ key: 'ffffffffffffffa5', labels: { detected_level: 'WARNING' } }),
    ).toBe(1);
    expect(seriesColourIndex({ key: 'ffffffffffffffa5', labels: { level: 'notice' } })).toBe(0);
    expect(seriesColourIndex({ key: 'ffffffffffffffac', labels: { level: 'verbose' } })).toBe(4);
    expect(seriesColourIndex({ key: 'ffffffffffffffac', labels: { severity: 'error' } })).toBe(4);
  });
});

describe('unit:state-colours (T02-004)', () => {
  it('marks take state colours from StateEncoding', () => {
    const c = themeColours('light');
    expect(c.state.failing).toBe(StateEncoding.failing.colour.light);
    expect(c.state.failing).toBe(colour.light.failing);
    expect(themeColours('dark').state.degraded).toBe(colour.dark.degraded);
  });
});
