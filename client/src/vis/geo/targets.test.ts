/**
 * `unit:geo-targets` (builder rows; T24 §10.5, T24-092, T24 §4.13, §5.16; plan #234 Part 1 §5): the
 * marker, cluster, aggregate and group targets of `geoTarget`, and `geoPlace`.
 */
import { describe, expect, it } from 'vitest';
import { COMPLETE, G, gazT, O2, opts, TH } from './fixtures/series';
import { geoRowSet, type GeoRow } from './frame';
import { geoPlace, geoTarget } from './targets';

const gaz = gazT();
const g = geoRowSet(G(), 'instant', opts(), TH, gaz, COMPLETE);
const o2 = geoRowSet(O2(), 'instant', opts({ groupBy: 'env' }), null, gaz, COMPLETE);
const row = (k: string): GeoRow => {
  const r = g.rows.find((x) => x.key === k);
  expect(r, `row ${k}`).toBeDefined();
  return r as GeoRow;
};

describe('unit:geo-targets (builder rows)', () => {
  it('a marker: its row, no members', () => {
    const t = geoTarget(g, 4, { kind: 'marker', id: 'k05', keys: ['k05'] });
    expect(t).toEqual({
      kind: 'marker',
      id: 'k05',
      frameSeq: 4,
      title: '{geo_country_iso_code="jp"}',
      rows: [row('k05')],
      members: null,
      set: g,
    });
  });

  it('a cluster: the keys’ rows in key order, one member per row', () => {
    const keys = ['k01', 'k02', 'k03', 'k04', 'k08'];
    const t = geoTarget(g, 1, {
      kind: 'cluster',
      id: 'cluster:k03',
      keys: ['k08', ...keys.slice(0, 4)],
    });
    expect(t.kind).toBe('cluster');
    expect(t.id).toBe('cluster:k03');
    expect(t.title).toBe('Cluster of 5');
    expect(t.rows.map((r) => r.key)).toEqual(keys);
    expect(t.members).toEqual(
      keys.map((k) => ({ text: row(k).name, labels: row(k).labels, keys: [k] })),
    );
    expect(t.set).toBe(g);
  });

  it('the O2 aggregate, its e8 group and the group’s members', () => {
    const agg = geoTarget(o2, 2, { kind: 'aggregate' });
    expect(agg.kind).toBe('aggregate');
    expect(agg.id).toBe('other:geo');
    expect(agg.title).toBe('other (3)');
    expect(agg.rows.map((r) => r.key)).toEqual(['q07', 'q08', 'q09', 'q10']);
    expect(agg.members).toEqual([
      { text: '"other (2)"', labels: { env: 'other (2)' }, keys: ['q07'] },
      { text: 'e8', labels: { env: 'e8' }, keys: ['q08', 'q10'] },
      { text: 'e9', labels: { env: 'e9' }, keys: ['q09'] },
    ]);
    const e8 = geoTarget(o2, 2, { kind: 'group', from: agg, entry: 1 });
    expect(e8.kind).toBe('group');
    expect(e8.id).toBe('group:{"present":true,"value":"e8"}');
    expect(e8.title).toBe('e8');
    expect(e8.rows.map((r) => r.key)).toEqual(['q08', 'q10']);
    expect(e8.members?.map((m) => [m.text, m.keys])).toEqual([
      ['{env="e8", lat="9", lon="9"}', ['q08']],
      ['{env="e8", lat="11", lon="11", pod="b"}', ['q10']],
    ]);
    // Built from the snapshot only: a later row set does not change it.
    const later = geoRowSet(
      O2().filter((s) => s.key !== 'q10'),
      'instant',
      opts({ groupBy: 'env' }),
      null,
      gaz,
      COMPLETE,
    );
    expect(
      geoTarget(later, 3, { kind: 'group', from: agg, entry: 1 }).rows.map((r) => r.key),
    ).toEqual(['q08', 'q10']);
  });

  it('geoPlace: the gazetteer name, else the coordinates, else empty', () => {
    expect(['k05', 'k08', 'k09', 'k13'].map((k) => geoPlace(row(k)))).toEqual([
      'Japan',
      '57.6491, 10.4074',
      '',
      '-89.9000, 0.0000',
    ]);
  });
});
