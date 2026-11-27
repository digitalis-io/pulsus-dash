/**
 * `unit:geo-rows` and `unit:geo-identity` (T24 §10.4, T24-089, T24-090; plan #234 Part 1 §5): the
 * statuses of fixture G, the validator's invalid sets, order independence, and the groups, labels,
 * patterns and colours of G, H, H′, A, O, Q, D, U, one row and S.
 */
import { describe, expect, it } from 'vitest';
import type { FrameDataIssue, SeriesFrame } from '../../data/frames';
import type { Thresholds } from '../thresholds';
import {
  A,
  Cap,
  COMPLETE,
  D,
  G,
  gazT,
  H,
  Hprime,
  inst,
  O,
  opts,
  Q,
  S,
  shuffled,
  TH,
} from './fixtures/series';
import {
  finalLabels,
  geoFrame,
  geoRowSet,
  validateGeoRows,
  valueStatusOf,
  type GeoGroup,
  type GeoRow,
  type GeoRowSet,
  type GeomapOptions,
} from './frame';

const gaz = gazT();
const NO_GEO = {
  notPlaced: 0,
  ambiguous: 0,
  locationsUnavailable: 0,
  outsideMap: 0,
  noValue: 0,
  infinite: 0,
  outOfRange: 0,
};

function rows(
  series: readonly SeriesFrame[],
  th: Thresholds | null = null,
  o: Partial<GeomapOptions> = {},
): GeoRowSet {
  return geoRowSet(series, 'instant', opts(o), th, gaz, COMPLETE);
}

const byKey = (s: GeoRowSet): Map<string, GeoRow> => new Map(s.rows.map((r) => [r.key, r]));
const keysWhere = (s: GeoRowSet, f: (r: GeoRow) => boolean): string[] =>
  s.rows.filter(f).map((r) => r.key);
const keysOf = (s: GeoRowSet, j: number): string[] => keysWhere(s, (r) => r.group === j);
const range = (from: number, to: number): string[] => {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`k${String(i).padStart(2, '0')}`);
  return out;
};

describe('unit:geo-rows', () => {
  it('valueStatusOf (T21-012)', () => {
    expect([NaN, Infinity, -Infinity, 5e-300, -1e291, 0, 1, -30, 1e290].map(valueStatusOf)).toEqual(
      ['noValue', 'infinite', 'infinite', 'outOfRange', 'outOfRange', 'ok', 'ok', 'ok', 'ok'],
    );
  });

  it('G: the statuses block, without thresholds', () => {
    const s = rows(G());
    expect(s.rows.map((r) => r.key)).toEqual(range(1, 18));
    expect(keysWhere(s, (r) => r.valueStatus === 'noValue')).toEqual(['k10', 'k12']);
    expect(keysWhere(s, (r) => r.valueStatus === 'infinite')).toEqual(['k16']);
    expect(keysWhere(s, (r) => r.valueStatus === 'outOfRange')).toEqual(['k17']);
    expect(keysWhere(s, (r) => r.valueStatus !== 'ok')).toEqual(['k10', 'k12', 'k16', 'k17']);
    const status = (k: string): string => byKey(s).get(k)?.location.status ?? '';
    expect(['k09', 'k10', 'k11', 'k15'].map(status)).toEqual([
      'unknownCode',
      'invalid',
      'ambiguous',
      'noLocation',
    ]);
    expect(keysWhere(s, (r) => r.location.status !== 'placed')).toEqual([
      'k09',
      'k10',
      'k11',
      'k15',
    ]);
    expect(keysWhere(s, (r) => r.draw === 'notPlaced')).toEqual(['k09', 'k10', 'k11', 'k15']);
    expect(keysWhere(s, (r) => r.draw === 'outsideMap')).toEqual(['k13']);
    expect(keysWhere(s, (r) => r.draw === 'excluded')).toEqual(['k12', 'k16', 'k17']);
    expect(keysWhere(s, (r) => r.draw === 'shown')).toEqual([...range(1, 8), 'k14', 'k18']);
    expect(byKey(s).get('k02')?.value).toBe(97);
    expect(s.coverage.duplicates).toBe(1);
    expect(s.coverage.conflicts).toBe(1);
    expect(s.rows.every((r) => r.state === null)).toBe(true);
    expect(byKey(s).get('k07')?.name).toBe('{lat="40.7128", lon="-74.0060"}');
    expect(s.groupBy).toBeNull();
    expect(validateGeoRows(s, null)).toBeNull();
  });

  it('G: the statuses block, with thresholds', () => {
    const s = rows(G(), TH);
    const state = (k: string): string | null => byKey(s).get(k)?.state ?? null;
    for (const k of ['k01', 'k02', 'k05', 'k06', 'k08', 'k09', 'k11', 'k13', 'k14', 'k15'])
      expect(state(k), k).toBe('ok');
    expect(state('k03')).toBe('degraded');
    expect(['k04', 'k18'].map(state)).toEqual(['watch', 'watch']);
    expect(state('k07')).toBe('failing');
    expect(['k10', 'k12', 'k16', 'k17'].map(state)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
    expect(validateGeoRows(s, TH)).toBeNull();
  });

  it('each invalid set → its detail', () => {
    const base = rows(G(), TH);
    const plain = rows(G());
    const at = (s: GeoRowSet, k: string): number => s.rows.findIndex((r) => r.key === k);
    const withRow = (s: GeoRowSet, k: string, patch: Partial<GeoRow>): GeoRowSet => ({
      ...s,
      rows: s.rows.map((r) => (r.key === k ? { ...r, ...patch } : r)),
    });
    const detail = (i: FrameDataIssue | null): string | null =>
      i !== null && i.code === 'geo' ? i.detail : i === null ? null : i.code;
    const swapped = [...base.rows];
    const [r0, r1] = [swapped[0], swapped[1]];
    expect(r0 !== undefined && r1 !== undefined, 'G has rows').toBe(true);
    swapped[0] = r1 as GeoRow;
    swapped[1] = r0 as GeoRow;
    expect(detail(validateGeoRows({ ...base, rows: swapped }, TH))).toBe('order');
    expect(detail(validateGeoRows(withRow(base, 'k12', { valueStatus: 'ok' }), TH))).toBe('value');
    expect(detail(validateGeoRows(withRow(base, 'k05', { state: 'failing' }), TH))).toBe('state');
    expect(detail(validateGeoRows(withRow(plain, 'k12', { state: 'unknown' }), null))).toBe(
      'state',
    );
    // k01 is 120, which is `ok` under the thresholds: `watch` is not its state (r1 #2).
    expect(detail(validateGeoRows(withRow(base, 'k01', { state: 'watch' }), TH))).toBe('state');
    expect(detail(validateGeoRows(withRow(base, 'k13', { draw: 'shown' }), TH))).toBe('draw');
    expect(detail(validateGeoRows(withRow(base, 'k12', { draw: 'shown' }), TH))).toBe('draw');
    expect(detail(validateGeoRows(withRow(base, 'k01', { group: 9 }), TH))).toBe('group');
    const groups = (f: (g: GeoGroup, j: number) => GeoGroup): GeoRowSet => ({
      ...base,
      groups: base.groups.map(f),
    });
    expect(
      detail(
        validateGeoRows(
          groups((g, j) => (j === 0 ? { ...g, pattern: 'dots' } : g)),
          TH,
        ),
      ),
    ).toBe('group');
    const noK08 = groups((g) =>
      g.members === null
        ? g
        : {
            ...g,
            members: g.members.filter((m) => !('series' in m && m.series === 'k08')),
          },
    );
    expect(detail(validateGeoRows(noK08, TH))).toBe('group');
    const geo = base.coverage.geo;
    expect(geo, 'geo coverage').toBeDefined();
    expect(
      detail(
        validateGeoRows(
          { ...base, coverage: { ...base.coverage, geo: { ...(geo ?? NO_GEO), notPlaced: 2 } } },
          TH,
        ),
      ),
    ).toBe('coverage');
    expect(at(base, 'k01')).toBe(0);
  });

  it('G reversed and shuffled: the same rows, groups and cap as sorted input', () => {
    const sorted = rows(G(), TH);
    for (const input of [[...G()].reverse(), shuffled(G(), 7), shuffled(G(), 234)]) {
      const s = rows(input, TH);
      expect(s.rows).toEqual(sorted.rows);
      expect(s.groups).toEqual(sorted.groups);
      expect(s.coverage).toEqual(sorted.coverage);
      expect(validateGeoRows(s, TH)).toBeNull();
    }
    const cap = rows(Cap());
    const capShuffled = rows(shuffled(Cap(), 11));
    expect(capShuffled.rows.map((r) => r.draw)).toEqual(cap.rows.map((r) => r.draw));
    expect(keysWhere(cap, (r) => r.draw === 'capped')).toEqual(['c4999', 'c5000', 'c5001']);
    expect(validateGeoRows(cap, null)).toBeNull();
  });

  it('geoFrame: the shown indices', () => {
    const s = rows(G());
    const f = geoFrame(s, { countries: [], coast: [], border: [] }, 3);
    expect(f.seq).toBe(3);
    expect([...f.shown]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 13, 17]);
    expect(f.rows).toBe(s.rows);
  });
});

describe('unit:geo-identity', () => {
  const NAMES_K08_K18 = [
    '{geohash="u4pruydqqvj"}',
    '{cloud_region="mars-north-1"}',
    '{lat="91", lon="0"}',
    '{cloud_region="xx-dup-1"}',
    '{lat="10", lon="10"}',
    '{lat="-89.9", lon="0"}',
    '{lat="0", lon="0"}',
    '{service="web"}',
    '{lat="20", lon="20"}',
    '{lat="25", lon="25"}',
    '{lat="40.7128", lon="-74.0060", site="b"}',
  ];

  it('G: the groups block (k08–k18 → other (11))', () => {
    const s = rows(G(), TH);
    expect(s.groups.map((g) => [g.pattern, g.colourIndex])).toEqual([
      ['backDiagonal', 1],
      ['horizontal', 2],
      ['vertical', 3],
      ['dots', 4],
      ['crossHatch', 5],
      ['checker', 6],
      ['dashes', 7],
      ['grid', null],
    ]);
    expect(s.groups.slice(0, 7).map((g) => g.id)).toEqual(
      range(1, 7).map((series) => ({ series })),
    );
    expect(s.groups.slice(0, 7).map((g) => g.label)).toEqual(s.rows.slice(0, 7).map((r) => r.name));
    const other = s.groups[7];
    expect(other?.id).toEqual({ other: true });
    expect(other?.label).toBe('other (11)');
    expect(other?.members).toEqual(range(8, 18).map((series) => ({ series })));
    expect(other?.memberLabels).toEqual(NAMES_K08_K18);
    // The legend's source data: the first 8 member labels, then `+3 more`.
    expect(other?.memberLabels?.slice(0, 2)).toEqual([
      '{geohash="u4pruydqqvj"}',
      '{cloud_region="mars-north-1"}',
    ]);
    expect((other?.memberLabels?.length ?? 0) - 8).toBe(3);
    for (let j = 0; j < 7; j++) expect(keysOf(s, j)).toEqual(range(j + 1, j + 1));
    expect(keysOf(s, 7)).toEqual(range(8, 18));
    // An aggregated row keeps its own id (T24-089 `group`).
    expect(byKey(s).get('k10')?.groupId).toEqual({ series: 'k10' });
  });

  it('H, with h9: the patterns, colours 0–6 and other', () => {
    const s = rows(H(), null, { groupBy: 'env' });
    expect(s.groupBy).toBe('env');
    expect(s.groups.map((g) => [g.label, g.pattern, g.colourIndex])).toEqual([
      ['e0', 'backDiagonal', 0],
      ['e1', 'horizontal', 1],
      ['e2', 'vertical', 2],
      ['e3', 'dots', 3],
      ['e4', 'crossHatch', 4],
      ['e5', 'checker', 5],
      ['e6', 'dashes', 6],
      ['other (2)', 'grid', null],
    ]);
    expect(s.groups[0]?.id).toEqual({ present: true, value: 'e0' });
    expect(s.groups[7]?.members).toEqual([
      { present: true, value: 'e7' },
      { present: true, value: 'e8' },
    ]);
    expect(s.groups[7]?.memberLabels).toEqual(['e7', 'e8']);
    expect(validateGeoRows(s, null)).toBeNull();
    const h9 = rows(H(true), null, { groupBy: 'env' });
    expect(h9.groups[7]?.label).toBe('other (3)');
    expect(h9.groups[7]?.members).toEqual([
      { present: true, value: 'e7' },
      { present: true, value: 'e8' },
      { present: false },
    ]);
    expect(h9.groups[7]?.memberLabels).toEqual(['e7', 'e8', 'env absent']);
    expect(byKey(h9).get('h9')?.groupId).toEqual({ present: false });
    expect(validateGeoRows(h9, null)).toBeNull();
  });

  it('H′: excluded rows keep their groups; e3 has no shown row', () => {
    const s = rows(Hprime(), null, { groupBy: 'env' });
    expect(keysWhere(s, (r) => r.draw === 'excluded')).toEqual(['h3', 'h8']);
    expect(keysWhere(s, (r) => r.draw === 'shown')).toEqual([
      'h0',
      'h1',
      'h2',
      'h4',
      'h5',
      'h6',
      'h7',
    ]);
    expect(s.groups.map((g) => g.label)).toEqual(
      rows(H(), null, { groupBy: 'env' }).groups.map((g) => g.label),
    );
    expect(s.rows.some((r) => r.group === 3 && r.draw === 'shown')).toBe(false);
    expect(s.groups[7]?.memberLabels).toEqual(['e7', 'e8']);
  });

  it('A: absent and the reserved present value', () => {
    const s = rows(A(), null, { groupBy: 'env' });
    expect(s.groups.map((g, j) => [g.id, g.label, g.pattern, g.colourIndex, keysOf(s, j)])).toEqual(
      [
        [{ present: false }, 'env absent', 'backDiagonal', 0, ['a1']],
        [{ present: true, value: 'env absent' }, '"env absent"', 'horizontal', 1, ['a2']],
        [{ present: true, value: 'prod' }, 'prod', 'vertical', 2, ['a3']],
      ],
    );
  });

  it('O: a present `other (2)` among the aggregate members', () => {
    const s = rows(O(), null, { groupBy: 'env' });
    const other = s.groups[7];
    expect(other?.id).toEqual({ other: true });
    expect(other?.label).toBe('other (3)');
    expect(keysOf(s, 7)).toEqual(['q07', 'q08', 'q09']);
    expect(other?.members).toEqual([
      { present: true, value: 'other (2)' },
      { present: true, value: 'e8' },
      { present: true, value: 'e9' },
    ]);
    expect(other?.memberLabels).toEqual(['"other (2)"', 'e8', 'e9']);
  });

  it('Q: quoted labels never collide', () => {
    const s = rows(Q(), null, { groupBy: 'env' });
    expect(s.groups.map((g, j) => [g.label, keysOf(s, j)])).toEqual([
      ['"env absent"', ['p1']],
      ['"\\"env absent\\""', ['p2']],
      ['env absent', ['p3']],
    ]);
  });

  it('D: the T22-004 disambiguator', () => {
    const s = rows(D());
    expect(s.groups.map((g, j) => [g.label, keysOf(s, j)])).toEqual([
      ['{lat="1", lon="2"} · __name__ absent', ['d1']],
      ['{lat="1", lon="2"} · __name__=""', ['d2']],
    ]);
  });

  it('U: the final pass (` (n)`, skipping labels in use; the aggregate never suffixed)', () => {
    expect(
      finalLabels(
        [
          { key: 'u1', labels: { x: '1' }, base: 'A' },
          { key: 'u2', labels: { x: '1' }, base: 'A' },
          { key: 'u3', labels: { x: '1' }, base: 'A (1)' },
          { key: 'u4', labels: {}, base: 'other (2)' },
          { key: 'u5', labels: {}, base: 'other (2)' },
        ],
        3,
      ),
    ).toEqual(['A (2)', 'A (3)', 'A (1)', 'other (2)', 'other (2) (1)']);
  });

  it('one row: solid; S: grouped marks keep their states', () => {
    const one = rows([inst('o1', { lat: '1', lon: '1' }, 1)]);
    expect(one.groups).toEqual([
      {
        id: { series: 'o1' },
        label: '{lat="1", lon="1"}',
        pattern: 'solid',
        colourIndex: 1,
        members: null,
        memberLabels: null,
      },
    ]);
    const s = rows(S(), TH, { groupBy: 'env', labels: 'none' });
    expect(s.groups.map((g, j) => [g.label, g.pattern, g.colourIndex, keysOf(s, j)])).toEqual([
      ['prod', 'backDiagonal', 0, ['s1', 's2']],
      ['dev', 'horizontal', 1, ['s3']],
    ]);
    expect(s.rows.map((r) => r.state)).toEqual(['ok', 'failing', 'ok']);
    const g = rows(G(), TH, { colour: 'state' });
    expect(['k03', 'k04', 'k01'].map((k) => byKey(g).get(k)?.state)).toEqual([
      'degraded',
      'watch',
      'ok',
    ]);
  });

  it('labels are pairwise distinct in every fixture', () => {
    const sets = [
      rows(G(), TH),
      rows(H(), null, { groupBy: 'env' }),
      rows(H(true), null, { groupBy: 'env' }),
      rows(Hprime(), null, { groupBy: 'env' }),
      rows(A(), null, { groupBy: 'env' }),
      rows(O(), null, { groupBy: 'env' }),
      rows(Q(), null, { groupBy: 'env' }),
      rows(D()),
      rows(S(), null, { groupBy: 'env' }),
    ];
    for (const s of sets) {
      const labels = s.groups.flatMap((g) => [g.label, ...(g.memberLabels ?? [])]);
      expect(new Set(labels).size, labels.join(' | ')).toBe(labels.length);
    }
  });
});
