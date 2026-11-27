// unit:inspector-members (T25-011, T25 §10, plan #192 §5).
import { describe, expect, it } from 'vitest';
import {
  expandMembers,
  membersView,
  NO_MEMBERS_STATE,
  pressFewer,
  pressMore,
  type MemberFacts,
  type MemberList,
  type MemberSection,
} from './members';
import { frameOf } from '../test/geoKit';
import { P_ORIGIN, pEnv, pRequest } from '../test/inspectorKit';
import { M12, N } from '../vis/geo/fixtures/series';
import { geoTarget, resolveGeoMembers, type GeoInspectorTarget } from '../vis/geo/targets';
import { inspectorModel } from './model';
import type { InspectorTarget, InspectRequest, NavView } from './types';

const text = (i: number): string => `text ${String(i)}`;
const run = (i: number): MemberFacts => ({
  fromMs: i * 1_000,
  toMs: (i + 1) * 1_000,
  text: `run ${String(i)}`,
  state: null,
});
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const pad = (i: number): string => String(i).padStart(2, '0');

const SECTION: MemberSection = {
  texts: { shown: range(8).map(text), count: 10 },
  runs: { shown: range(8).map(run), count: 12 },
  resolve: { panelId: 'P2', runId: 'P2:K:r0' },
  next: null,
};

const FULL: MemberList = { texts: range(10).map(text), members: range(12).map(run) };

describe('unit:inspector-members', () => {
  it('(a) each list has its own "+k more" and resolves once', () => {
    const v0 = membersView(SECTION, NO_MEMBERS_STATE);
    expect(v0.texts.items).toHaveLength(8);
    expect(v0.texts.more).toBe(2);
    expect(v0.runs?.more).toBe(4);
    expect(v0.stale).toBe(false);
    let calls = 0;
    const resolve = (panelId: string, runId: string): MemberList | null => {
      calls += 1;
      expect([panelId, runId]).toEqual(['P2', 'P2:K:r0']);
      return FULL;
    };
    const s1 = pressMore(SECTION, NO_MEMBERS_STATE, 'runs', resolve);
    const v1 = membersView(SECTION, s1);
    expect(v1.runs?.items).toHaveLength(12);
    expect(v1.runs?.fewer).toBe(true);
    expect(v1.runs?.more).toBeNull();
    expect(v1.texts.items).toHaveLength(8);
    expect(v1.texts.more).toBe(2);
    const s2 = pressMore(SECTION, s1, 'texts', resolve);
    expect(membersView(SECTION, s2).texts.items).toHaveLength(10);
    expect(calls).toBe(1);
    const s3 = pressFewer(s2, 'runs');
    expect(membersView(SECTION, s3).runs?.items).toHaveLength(8);
    expect(membersView(SECTION, s3).runs?.more).toBe(4);
    expect(membersView(SECTION, s3).texts.items).toHaveLength(10);
  });

  it('(b) a null result is stale: both keep 8, no buttons', () => {
    const s = pressMore(SECTION, NO_MEMBERS_STATE, 'texts', () => null);
    expect(s.result).toBe('stale');
    const v = membersView(SECTION, s);
    expect(v.stale).toBe(true);
    expect(v.texts.items).toHaveLength(8);
    expect(v.runs?.items).toHaveLength(8);
    expect(v.texts.more).toBeNull();
    expect(v.runs?.more).toBeNull();
  });

  it('(c) a mismatched result is stale', () => {
    const short: MemberList = { texts: range(10).map(text), members: range(11).map(run) };
    const s = pressMore(SECTION, NO_MEMBERS_STATE, 'runs', () => short);
    expect(s.result).toBe('stale');
    const v = membersView(SECTION, s);
    expect(v.stale).toBe(true);
    expect(v.texts.items).toHaveLength(8);
    expect(v.runs?.items).toHaveLength(8);
    expect(v.runs?.more).toBeNull();
  });

  it('a new target resets the state; runs of 0 are omitted', () => {
    const s = pressMore(SECTION, NO_MEMBERS_STATE, 'runs', () => FULL);
    expect(membersView(SECTION, s).runs?.items).toHaveLength(12);
    expect(membersView(SECTION, NO_MEMBERS_STATE).runs?.items).toHaveLength(8);
    const noRuns: MemberSection = { ...SECTION, runs: { shown: [], count: 0 } };
    expect(membersView(noRuns, NO_MEMBERS_STATE).runs).toBeNull();
  });

  it('complete lists (no resolve) open without a resolver call', () => {
    const complete: MemberSection = {
      texts: { shown: range(10).map(text), count: 10 },
      runs: null,
      resolve: null,
      next: null,
    };
    const v0 = membersView(complete, NO_MEMBERS_STATE);
    expect(v0.texts.items).toHaveLength(8);
    expect(v0.texts.more).toBe(2);
    const s = pressMore(complete, NO_MEMBERS_STATE, 'texts', () => {
      throw new Error('no resolve for complete lists');
    });
    expect(membersView(complete, s).texts.items).toHaveLength(10);
  });
});

describe('unit:inspector-members labels (#154)', () => {
  const lab = (i: number) => ({ le: String(i) });
  const BIN: MemberSection = {
    texts: { shown: range(8).map(text), count: 10, labels: range(8).map(lab) },
    runs: null,
    resolve: { panelId: 'P3', runId: 'b1' },
    next: null,
  };

  it('the labels stay parallel to the texts, shown and resolved', () => {
    expect(membersView(BIN, NO_MEMBERS_STATE).labels).toEqual(range(8).map(lab));
    const full: MemberList = {
      texts: range(10).map(text),
      members: [],
      labels: range(10).map(lab),
    };
    expect(expandMembers(BIN, full)).toEqual({
      texts: range(10).map(text),
      runs: [],
      labels: range(10).map(lab),
    });
    const s = pressMore(BIN, NO_MEMBERS_STATE, 'texts', () => full);
    expect(membersView(BIN, s).labels).toEqual(range(10).map(lab));
  });

  it('labels of another length are stale; no labels give null', () => {
    const short: MemberList = {
      texts: range(10).map(text),
      members: [],
      labels: range(9).map(lab),
    };
    expect(expandMembers(BIN, short)).toBe('stale');
    const plain: MemberList = { texts: range(10).map(text), members: [] };
    expect(expandMembers(BIN, plain)).toEqual({
      texts: range(10).map(text),
      runs: [],
      labels: null,
    });
    expect(membersView(SECTION, NO_MEMBERS_STATE).labels).toBeNull();
  });
});

describe('unit:geo-members (the model)', () => {
  const env = pEnv();
  const geoReq = (t: GeoInspectorTarget, panelId: string | null = 'p1'): InspectRequest => {
    const target: InspectorTarget = { type: 'geo', target: t };
    return pRequest({
      origin: { ...P_ORIGIN, panelId, title: 'Latency map', unit: { kind: 'time', base: 'ms' } },
      target,
      selection: { keys: t.rows.map((r) => r.key), fromMs: null, toMs: null },
    });
  };
  const sectionOf = (t: GeoInspectorTarget): MemberSection => {
    const m = inspectorModel(geoReq(t), env).members;
    if (m === null) throw new Error('no members');
    return m;
  };
  const geoOf = (v: NavView | null | undefined): GeoInspectorTarget => {
    expect(v?.target.type, 'a geo view').toBe('geo');
    if (v?.target.type !== 'geo') throw new Error('not a geo view');
    return v.target.target;
  };
  /** The full list behind "+k more", as the host answers it. */
  const expanded = (t: GeoInspectorTarget) => {
    const m = sectionOf(t);
    const s = pressMore(m, NO_MEMBERS_STATE, 'texts', (_, runId) => resolveGeoMembers(t, runId));
    return membersView(m, s);
  };
  const pods = (from: number, to: number, env: string): string[] =>
    range(to - from + 1).map(
      (i) => `{env="${env}", lat="10", lon="10", pod="p${String(from + i)}"}`,
    );

  it('M12: cluster:m12 shows m01–m08 with "+4 more" and resolves 12; entry 10 opens m11', () => {
    const m12 = frameOf(M12());
    const c = geoTarget(m12, m12.seq, {
      kind: 'cluster',
      id: 'cluster:m12',
      keys: m12.rows.map((r) => r.key),
    });
    const text = (i: number): string => `{lat="10", lon="10", pod="p${pad(i)}"}`;
    const lab = (i: number) => ({ lat: '10', lon: '10', pod: `p${pad(i)}` });
    const m = sectionOf(c);
    const v0 = membersView(m, NO_MEMBERS_STATE);
    expect(v0.texts.items).toEqual(range(8).map((i) => text(i + 1)));
    expect(v0.labels).toEqual(range(8).map((i) => lab(i + 1)));
    expect(v0.texts.more).toBe(4);
    const v1 = expanded(c);
    expect(v1.texts.items).toEqual(range(12).map((i) => text(i + 1)));
    expect(v1.labels).toEqual(range(12).map((i) => lab(i + 1)));
    const view = m.next?.(10) ?? null;
    expect(geoOf(view)).toMatchObject({ kind: 'marker', id: 'm11' });
    expect(view?.selection).toEqual({ keys: ['m11'], fromMs: null, toMs: null });
    expect(view?.title).toBe(text(11));
    expect(m.next?.(12)).toBeNull();
    // A refresh removing m11 leaves the open cluster's entries as they were.
    const later = frameOf(
      M12().filter((s) => s.key !== 'm11'),
      { seq: 2 },
    );
    expect(later.rows).toHaveLength(11);
    expect(geoOf(sectionOf(c).next?.(10))).toMatchObject({ kind: 'marker', id: 'm11' });
  });

  it('N: other (12) → e18 → n27; the levels resolve 12 each; a refresh keeps the snapshot', () => {
    const n = frameOf(N(), { opts: { groupBy: 'env' } });
    const agg = geoTarget(n, n.seq, { kind: 'aggregate' });
    const m = sectionOf(agg);
    const v0 = membersView(m, NO_MEMBERS_STATE);
    expect(v0.texts.items).toEqual(range(8).map((i) => `e${String(i + 7)}`));
    expect(v0.labels).toEqual(range(8).map((i) => ({ env: `e${String(i + 7)}` })));
    expect(v0.texts.more).toBe(4);
    const v1 = expanded(agg);
    expect(v1.texts.items).toEqual(range(12).map((i) => `e${String(i + 7)}`));
    expect(v1.labels).toEqual(range(12).map((i) => ({ env: `e${String(i + 7)}` })));
    const g = m.next?.(11) ?? null;
    const e18 = geoOf(g);
    expect(e18).toMatchObject({ kind: 'group', id: 'group:{"present":true,"value":"e18"}' });
    expect(g?.title).toBe('e18');
    expect(g?.selection.keys).toEqual(range(12).map((i) => `n${String(18 + i)}`));
    const gm = sectionOf(e18);
    const g0 = membersView(gm, NO_MEMBERS_STATE);
    // A row's name is its series name: every label, lat and lon included.
    expect(g0.texts.items).toEqual(['{env="e18", lat="10", lon="10"}', ...pods(19, 25, 'e18')]);
    expect(g0.labels?.[0]).toEqual({ env: 'e18', lat: '10', lon: '10' });
    expect(g0.labels?.[1]).toEqual({ env: 'e18', lat: '10', lon: '10', pod: 'p19' });
    expect(g0.texts.more).toBe(4);
    const g1 = expanded(e18);
    expect(g1.texts.items).toEqual(['{env="e18", lat="10", lon="10"}', ...pods(19, 29, 'e18')]);
    expect(g1.labels).toHaveLength(12);
    expect(g1.labels?.[11]).toEqual({ env: 'e18', lat: '10', lon: '10', pod: 'p29' });
    const leaf = gm.next?.(9) ?? null;
    expect(geoOf(leaf)).toMatchObject({ kind: 'marker', id: 'n27' });
    expect(leaf?.selection.keys).toEqual(['n27']);
    expect(leaf?.title).toBe('{env="e18", lat="10", lon="10", pod="p27"}');
    // A marker has no members, so nothing deeper.
    expect(inspectorModel(geoReq(geoOf(leaf)), env).members).toBeNull();
    // The refresh: the open views keep their own snapshot.
    const later = frameOf(
      N().filter((s) => s.key !== 'n27'),
      { opts: { groupBy: 'env' }, seq: 2 },
    );
    expect(later.rows.some((r) => r.key === 'n27')).toBe(false);
    expect(geoOf(sectionOf(agg).next?.(11)).rows).toHaveLength(12);
    expect(geoOf(sectionOf(e18).next?.(9))).toMatchObject({ kind: 'marker', id: 'n27' });
  });

  it('a bin and a stateRun section: next null, plain entries, as unit:inspector-members', () => {
    expect(SECTION.next).toBeNull();
    const BIN: MemberSection = {
      texts: {
        shown: range(8).map(text),
        count: 10,
        labels: range(8).map((i) => ({ le: String(i) })),
      },
      runs: null,
      resolve: { panelId: 'P3', runId: 'b1' },
      next: null,
    };
    const s = pressMore(BIN, NO_MEMBERS_STATE, 'texts', () => ({
      texts: range(10).map(text),
      members: [],
      labels: range(10).map((i) => ({ le: String(i) })),
    }));
    expect(membersView(BIN, s).texts.items).toHaveLength(10);
    expect(BIN.next).toBeNull();
  });
});
