/** `unit:mark-tooltip` (plan #173 Part 3a §3.5; T22-011, T22-006): the bar tooltip's lines. */
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CategoryRow, MarkEvent } from '../engine/api';
import { byVersion, COMPLETE } from '../test/categoryFixtures';
import type { ExploreResult } from '../vis/autovis';
import { barchartModel, type BarchartModel } from '../vis/barchart';
import { markLines } from './CategoryChart';
import { MarkTooltip } from './MarkTooltip';

const W = { fromMs: Date.UTC(2026, 10, 19, 12), toMs: Date.UTC(2026, 10, 19, 13) };
const RATE = { kind: 'suffix', suffix: '/s' } as const;

function model(base: ExploreResult | null, o: { categoryBy?: string } = {}): BarchartModel {
  const r = byVersion();
  if (r.kind === 'string' || base?.kind === 'string') throw new Error('series only');
  return barchartModel(r, {
    title: 'Versions',
    rateApplied: true,
    options: o.categoryBy === undefined ? undefined : { categoryBy: o.categoryBy },
    thresholds: null,
    base,
  });
}

/** `byVersion` with every value halved: 2.31's baseline is 60. */
function half(q = COMPLETE): ExploreResult {
  const r = byVersion();
  if (r.kind !== 'series') throw new Error('series only');
  return {
    ...r,
    completeness: q,
    series: r.series.map((s) => ({ ...s, values: s.values.map((v) => v / 2) })),
  };
}

function tip(m: BarchartModel, lines: readonly string[]): string[] {
  const row: CategoryRow | undefined = m.all.find((r) => r.name === '2.31');
  if (row === undefined) throw new Error('no 2.31');
  const mark: MarkEvent = {
    source: 'pointer',
    key: row.key,
    index: 0,
    xCss: 0,
    yCss: 0,
    rows: [{ key: row.key, name: row.name, colourIndex: null, value: row.value }],
  };
  const { container, unmount } = render(
    <MarkTooltip mark={mark} row={row} unit={RATE} ghost lines={lines} />,
  );
  const out = [...container.querySelectorAll('[data-line]')].map((d) => d.textContent);
  unmount();
  return out;
}

const rowOf = (m: BarchartModel): CategoryRow => {
  const r = m.all.find((x) => x.name === '2.31');
  if (r === undefined) throw new Error('no 2.31');
  return r;
};

const base = { ghost: true, anomaly: false, window: W, timeZone: 'UTC' } as const;

describe('unit:mark-tooltip', () => {
  it('ghost on: the baseline, or what the incomplete baseline run lacks', () => {
    const complete = model(half());
    expect(tip(complete, markLines(rowOf(complete), { ...base, model: complete }))).toEqual([
      'baseline 60/s',
      'Values are reduced over 12:00 – 13:00',
    ]);
    const truncated = model(half({ ...COMPLETE, truncated: true }));
    expect(tip(truncated, markLines(rowOf(truncated), { ...base, model: truncated }))).toEqual([
      'baseline truncated',
      'Values are reduced over 12:00 – 13:00',
    ]);
    const limited = model(half({ ...COMPLETE, warnings: ['a', 'b'] }));
    expect(markLines(rowOf(limited), { ...base, model: limited })[0]).toBe(
      'baseline limited (2 warnings)',
    );
    const off = markLines(rowOf(complete), { ...base, ghost: false, model: complete });
    expect(off).toEqual(['Values are reduced over 12:00 – 13:00']);
  });

  it('anomaly on without scores; a board click that cannot filter', () => {
    const m = model(null);
    expect(markLines(rowOf(m), { ...base, ghost: false, anomaly: true, model: m })).toEqual([
      'Values are reduced over 12:00 – 13:00',
      'No anomaly scores for this query',
    ]);
    const region = model(null, { categoryBy: 'region' });
    const context = {
      surface: 'board' as const,
      filters: [],
      origin: {
        surface: 'board' as const,
        panelId: 'p1',
        title: 'Versions',
        query: null,
        unit: RATE,
      },
      window: W,
    };
    expect(markLines(rowOf(region), { ...base, ghost: false, model: region, context })).toEqual([
      "Can't filter: region missing on this series",
      'Values are reduced over 12:00 – 13:00',
    ]);
  });
});
