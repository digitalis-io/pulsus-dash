/** The geomap body's unit (#290 §4.1; T22-015): the panel's stored unit, rated after a rewrite. */
import { describe, expect, it } from 'vitest';
import type { DataPanelSpec } from '../../api/types';
import { runOf } from '../../test/geoHostKit';
import { panelGeo } from './PanelFrame';

const panel = (vis: DataPanelSpec['vis']): DataPanelSpec => ({
  id: 'p-1',
  title: 'Map',
  grid: { x: 0, y: 0, w: 6, h: 8 },
  query: { lang: 'promql', text: 'up' },
  vis,
});

describe('panelGeo unit', () => {
  it('percentUnit, and the rate rewrite', () => {
    const run = runOf([]);
    expect(panelGeo(panel({ kind: 'geomap', unit: { id: 'percentUnit' } }), run).unit).toEqual({
      kind: 'percentunit',
    });
    expect(panelGeo(panel({ kind: 'geomap' }), run).unit).toEqual({ kind: 'none' });
    const rated = runOf([]);
    if (rated.outcome === null) throw new Error('no outcome');
    const r = {
      ...rated,
      outcome: { ...rated.outcome, planned: { ...rated.outcome.planned, rateApplied: true } },
    };
    expect(panelGeo(panel({ kind: 'geomap', unit: { id: 'bytes' } }), r).unit).toEqual({
      kind: 'bytes',
      perSecond: true,
    });
  });
});
