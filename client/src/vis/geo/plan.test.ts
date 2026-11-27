/**
 * `unit:geo-plan` (T24-088, T24 §5.14; plan #234 Part 3 §3.1): `planGeo`'s order, first match:
 * loading, error, invalid, mapDataUnavailable, tooSmall, empty, noneShown, ok; a placeholder run is
 * loading and a kept refetch failure plans the kept rows as stale.
 */
import { describe, expect, it, vi } from 'vitest';
import { hostProps, GEO_DATA } from '../../test/geoHostKit';
import { G } from './fixtures/series';
import type { GeoRowSet } from './frame';
import { planGeo } from './plan';

/** A hook on `geoRowSet`: `(c)` marks k12 `ok`, a set `validateGeoRows` refuses (`value`). */
const hook = vi.hoisted(() => ({ k12ok: false }));
vi.mock('./frame', async (importOriginal) => {
  const m = await importOriginal<typeof import('./frame')>();
  return {
    ...m,
    geoRowSet: (...a: Parameters<typeof m.geoRowSet>): GeoRowSet => {
      const s = m.geoRowSet(...a);
      if (!hook.k12ok) return s;
      return {
        ...s,
        rows: s.rows.map((r) => (r.key === 'k12' ? { ...r, valueStatus: 'ok' as const } : r)),
      };
    },
  };
});

const SIZE = { width: 1024, height: 512 };
const O = { seq: 1, motion: 'ease' as const };
const NO_BASEMAP = { basemap: null, gazetteer: GEO_DATA.gazetteer };
const only = (keys: readonly string[]) => G().filter((s) => keys.includes(s.key));

describe('unit:geo-plan', () => {
  it('(a) loading assets, no basemap → loading', () => {
    expect(planGeo(hostProps(G(), { geoData: 'loading' }), SIZE, null, O).state).toBe('loading');
    expect(planGeo(hostProps(null), SIZE, null, O).state).toBe('loading');
  });

  it('(b) a failed run with no rows → error', () => {
    const p = planGeo(hostProps(null, { run: { error: new Error('500') } }), SIZE, null, O);
    expect(p).toEqual({ state: 'error', rows: null });
  });

  it('(c) G with k12 ok, no basemap → invalid (value)', () => {
    hook.k12ok = true;
    try {
      const p = planGeo(hostProps(G(), { geoData: NO_BASEMAP }), SIZE, null, O);
      expect(p).toEqual({ state: 'invalid', issue: { code: 'geo', detail: 'value' } });
    } finally {
      hook.k12ok = false;
    }
  });

  it('(d) G, no basemap → mapDataUnavailable with its 18 rows', () => {
    const p = planGeo(hostProps(G(), { geoData: NO_BASEMAP }), SIZE, null, O);
    expect(p.state).toBe('mapDataUnavailable');
    if (p.state !== 'mapDataUnavailable') return;
    expect(p.rows.rows).toHaveLength(18);
  });

  it('(e) G at 100 × 100 → tooSmall', () => {
    const p = planGeo(hostProps(), { width: 100, height: 100 }, null, O);
    expect(p.state).toBe('tooSmall');
    expect(planGeo(hostProps(), { width: 159, height: 512 }, null, O).state).toBe('tooSmall');
    expect(planGeo(hostProps(), { width: 1024, height: 119 }, null, O).state).toBe('tooSmall');
  });

  it('(f) 0 rows → empty; (g) k09–k11, k15 → noneShown', () => {
    expect(planGeo(hostProps([]), SIZE, null, O).state).toBe('empty');
    const g = planGeo(hostProps(only(['k09', 'k10', 'k11', 'k15'])), SIZE, null, O);
    expect(g.state).toBe('noneShown');
  });

  it('(h) G → ok, with the frame and the spec', () => {
    const p = planGeo(hostProps(), SIZE, { lat: 10, lon: 10, zoom: 4 }, { seq: 7, motion: 'cut' });
    expect(p.state).toBe('ok');
    if (p.state !== 'ok') return;
    expect(p.data.geo.seq).toBe(7);
    expect(p.data.geo.shown).toHaveLength(10);
    expect(p.spec).toMatchObject({
      kind: 'geomap',
      title: 'Latency map',
      view: { lat: 10, lon: 10, zoom: 4 },
      motion: 'cut',
      size: { by: 'value', min: 4, max: 20 },
      cluster: true,
    });
    expect(p.spec.thresholds?.map((l) => l.value)).toEqual([150, 200, 250]);
    const plain = planGeo(hostProps(G(), { thresholds: null }), SIZE, null, O);
    expect(plain.state === 'ok' && plain.spec.thresholds).toBeUndefined();
  });

  it('(i) a placeholder run while fetching → loading', () => {
    const p = planGeo(
      hostProps(G(), { run: { placeholder: true, fetching: true } }),
      SIZE,
      null,
      O,
    );
    expect(p.state).toBe('loading');
  });

  it('(j) a kept refetch failure → ok with staleAtMs', () => {
    const at = Date.UTC(2026, 10, 19, 12, 31, 5);
    const p = planGeo(hostProps(G(), { run: { error: new Error('500') } }), SIZE, null, {
      ...O,
      staleAtMs: at,
    });
    expect(p.state).toBe('ok');
    if (p.state !== 'ok') return;
    expect(p.rows.coverage.staleAtMs).toBe(at);
    // A placeholder that failed has no rows of its own: error.
    const e = planGeo(
      hostProps(G(), { run: { error: new Error('500'), placeholder: true } }),
      SIZE,
      null,
      O,
    );
    expect(e.state).toBe('error');
  });
});
