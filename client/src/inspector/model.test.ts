// unit:inspector-model, unit:inspector-pivots, unit:pivot-context (T25 §10, plan #192 §5).
import { describe, expect, it } from 'vitest';
import { exploreHrefFor } from '../boards/exploreLink';
import { formatValue } from '../i18n/format';
import { DEFAULT_CONTEXT } from '../state/contextSearch';
import { K1, P_LABELS, P_ORIGIN, P_TARGET, P_T, pEnv, pRequest } from '../test/inspectorKit';
import { selectionOf } from '../charts/inspectTarget';
import { fkey } from '../test/categoryFixtures';
import { frameOf } from '../test/geoKit';
import { G, M12, O2, TH } from '../vis/geo/fixtures/series';
import type { GeoFrame } from '../vis/geo/frame';
import { geoTarget, resolveGeoMembers, type GeoInspectorTarget } from '../vis/geo/targets';
import { inspectorModel } from './model';
import { pivotInstant, pivotWindow } from './pivots';
import type { InspectorTarget, Pivot } from './types';

const S = { kind: 'time', base: 's' } as const;

const pivot = (pivots: readonly Pivot[], id: Pivot['id']): Pivot | undefined =>
  pivots.find((p) => p.id === id);

/** The logs pivot's `q`, or null when it has no href. */
function logsQ(pivots: readonly Pivot[]): string | null {
  const href = pivot(pivots, 'logs')?.href ?? null;
  return href === null ? null : new URL(href, 'http://x').searchParams.get('q');
}

const fact = (m: ReturnType<typeof inspectorModel>, label: string): string | undefined =>
  m.facts.find((f) => f.label === label)?.value;

const factLines = (m: ReturnType<typeof inspectorModel>): string[] =>
  m.facts.map((f) => `${f.label} ${f.value}`);

const point = (labels: Readonly<Record<string, string>>): InspectorTarget => ({
  ...P_TARGET,
  labels,
});

const bucket = (index: number, lower: number | null, upper: number): InspectorTarget => ({
  type: 'bucket',
  index,
  tMs: P_T,
  toMs: P_T + 30_000,
  lower,
  upper,
  count: 7,
  countUnit: { kind: 'none' },
});

describe('unit:inspector-model', () => {
  it('fixture P: the fixed sections', () => {
    const m = inspectorModel(pRequest(), pEnv());
    expect(m.heading).toBe('p99 latency');
    expect(m.subheading).toBe('13:41:20.000');
    expect(m.primary).toBe(formatValue(2.84, S));
    expect(m.primaryKind).toBe('value');
    expect(factLines(m)).toContain('Raw 2.84');
    expect(fact(m, 'Time')).toBe('2026-11-19 13:41:20.000 UTC');
    expect(m.labels).toEqual([
      ['job', 'shop/checkout'],
      ['quantile', '0.99'],
    ]);
    expect(pivot(m.pivots, 'explore')?.href).not.toBeNull();
    expect(pivot(m.pivots, 'logs')?.href).not.toBeNull();
    const reasons = {
      traces: 'Traces are not available yet',
      profiles: 'Profiles are not available yet',
      entity: 'The entity catalogue is not available yet',
      labelFilter: 'Filtering Explore by a label arrives with label filters',
    } as const;
    for (const [id, reason] of Object.entries(reasons)) {
      const p = pivot(m.pivots, id as Pivot['id']);
      expect(p?.href, id).toBeNull();
      expect(p?.reason, id).toBe(reason);
    }
    expect(m.actions.map((a) => [a.label, a.reason])).toEqual([
      ['Pin', 'Available with investigations (M-UI4)'],
      ['Create alert', 'Available with alerting (M-UI4)'],
      ['Ask AI ✦', 'Available with the AI assistant (M-UI4)'],
    ]);
    expect(m.announce).toBe(`Inspector: p99 latency, ${formatValue(2.84, S)} at 13:41:20`);
    expect(m.query).toEqual({ lang: 'PromQL', text: 'histogram_quantile(0.99, x)' });
    expect(m.copyValue).toBe('2.84');
  });

  it('edge: NaN, no labels, no query, buckets and a log time', () => {
    const value: InspectorTarget = {
      type: 'value',
      key: null,
      labels: {},
      name: 'T',
      value: NaN,
      tMs: null,
      state: null,
    };
    const v = inspectorModel(
      pRequest({ origin: { ...P_ORIGIN, query: null }, target: value }),
      pEnv(),
    );
    expect(v.primary).toBe('no value');
    expect(v.labels).toEqual([]);
    expect(v.query).toBeNull();
    expect(v.subheading).toBe('');
    const b0 = inspectorModel(pRequest({ target: bucket(0, null, 0.1) }), pEnv());
    expect(factLines(b0)).toContain(`Range ≤ ${formatValue(0.1, S)}`);
    const b3 = inspectorModel(pRequest({ target: bucket(3, 1, Infinity) }), pEnv());
    expect(factLines(b3)).toContain(`Range > ${formatValue(1, S)}`);
    const b1 = inspectorModel(pRequest({ target: bucket(1, 0.1, 1) }), pEnv());
    expect(factLines(b1)).toContain(`Range ${formatValue(0.1, S)} – ${formatValue(1, S)}`);
    expect(factLines(b1)).toContain('Raw count 7');
    const log: InspectorTarget = {
      type: 'logLine',
      streamKey: K1,
      labels: { app: 'x' },
      tsNs: 1763559680123456789n,
      level: 'error',
      line: 'boom',
      metadata: { trace_id: 'abc' },
      parsed: null,
    };
    const l = inspectorModel(pRequest({ target: log }), pEnv());
    expect(factLines(l)).toContain('Time 1763559680123456789 ns');
    expect(l.primary).toBe('boom');
    expect(l.primaryKind).toBe('line');
    expect(l.copyValue).toBe('boom');
    expect(l.extraLabels).toEqual([{ title: 'Metadata', labels: [['trace_id', 'abc']] }]);
  });

  it('a value target with a crossed threshold carries its state', () => {
    const value: InspectorTarget = {
      type: 'value',
      key: K1,
      labels: {},
      name: 'T',
      value: 3,
      tMs: P_T,
      state: 'failing',
    };
    const m = inspectorModel(pRequest({ target: value }), pEnv());
    expect(m.primaryState).toBe('failing');
    expect(factLines(m)).toContain('State Failing');
  });
});

describe('unit:inspector-pivots', () => {
  it('P: the logs pivot at ±1 min', () => {
    const m = inspectorModel(pRequest(), pEnv());
    const href = pivot(m.pivots, 'logs')?.href ?? '';
    const u = new URL(href, 'http://x');
    expect(u.pathname).toBe('/t/acme/explore/logs');
    expect(u.searchParams.get('from')).toBe('2026-11-19T13:40:20.000Z');
    expect(u.searchParams.get('to')).toBe('2026-11-19T13:42:20.000Z');
    expect(u.searchParams.get('refresh')).toBe('off');
    expect(u.searchParams.get('q')).toBe('{service_name="checkout"}');
    expect(pivot(m.pivots, 'explore')?.href).toBe(
      exploreHrefFor('acme', 'promql', 'line', pEnv().ctx.search, 'histogram_quantile(0.99, x)'),
    );
    expect(m.pivots.map((p) => p.id)).toEqual([
      'explore',
      'logs',
      'traces',
      'profiles',
      'entity',
      'labelFilter',
    ]);
  });

  it('the logs selector per identity', () => {
    const q = (t: InspectorTarget) => logsQ(inspectorModel(pRequest({ target: t }), pEnv()).pivots);
    expect(q(point({ service_name: 'pay"ments' }))).toBe('{service_name="pay\\"ments"}');
    expect(q(point({ job: 'checkout' }))).toBe('{service_name="checkout"}');
    const none = inspectorModel(pRequest({ target: point({ job: 'shop/' }) }), pEnv());
    expect(pivot(none.pivots, 'logs')?.href).toBeNull();
    expect(pivot(none.pivots, 'logs')?.reason).toBe(
      'No log stream label on this series (needs service_name or job)',
    );
    const log: InspectorTarget = {
      type: 'logLine',
      streamKey: K1,
      labels: { service_name: 'a', env: 'x' },
      tsNs: BigInt(P_T) * 1_000_000n,
      level: 'info',
      line: 'l',
      metadata: null,
      parsed: null,
    };
    expect(q(log)).toBe('{env="x",service_name="a"}');
  });

  it('a filter alone makes the selector', () => {
    const f = [{ key: 'env', value: 'prod' }];
    const a = inspectorModel(pRequest({ target: point({ job: 'shop/' }) }), pEnv(f));
    expect(logsQ(a.pivots)).toBe('{env="prod"}');
    const b = inspectorModel(pRequest({ target: bucket(2, 1, 2) }), pEnv(f));
    expect(logsQ(b.pivots)).toBe('{env="prod"}');
  });

  it('Explore has no Explore chip', () => {
    const m = inspectorModel(
      pRequest({ origin: { ...P_ORIGIN, surface: 'explore', panelId: null } }),
      pEnv(),
    );
    expect(pivot(m.pivots, 'explore')).toBeUndefined();
    expect(m.pivots[0]?.id).toBe('logs');
  });

  it('a board panel without a run has a disabled Explore chip', () => {
    const m = inspectorModel(pRequest({ origin: { ...P_ORIGIN, query: null } }), pEnv());
    expect(pivot(m.pivots, 'explore')?.href).toBeNull();
    expect(pivot(m.pivots, 'explore')?.reason).toBe('Run the panel to open it in Explore');
  });
});

describe('unit:pivot-context', () => {
  const C1 = [
    { key: 'env', value: 'prod' },
    { key: 'instance', value: '10.0.0.1:9090' },
    { key: 'job', value: 'shop/web' },
  ];
  const C1b = [
    { key: 'env', value: 'prod' },
    { key: 'instance', value: '10.0.0.1:9090' },
    { key: 'job', value: 'shop/checkout' },
  ];

  it('no filters: both lines carry time and filters', () => {
    const m = inspectorModel(pRequest(), pEnv());
    const line = 'Carried: time, filters · Not carried yet: baseline';
    expect(pivot(m.pivots, 'explore')?.context).toEqual([line]);
    expect(pivot(m.pivots, 'logs')?.context).toEqual([line]);
    expect(pivot(m.pivots, 'traces')?.context).toEqual([]);
  });

  it('C1: a conflicting filter keeps both matchers and says so', () => {
    const m = inspectorModel(pRequest(), pEnv(C1));
    const logs = pivot(m.pivots, 'logs');
    expect(logsQ(m.pivots)).toBe('{env="prod",service_name="checkout",service_name="web"}');
    expect(logs?.notCarried).toEqual(['instance']);
    expect(logs?.context).toEqual([
      'Carried: time · Not carried yet: baseline',
      'Not carried to logs: instance',
      'Context filter job=shop/web conflicts with this target: no logs can match',
    ]);
  });

  it("C1': no conflict; Explore names the filters it does not apply", () => {
    const m = inspectorModel(pRequest(), pEnv(C1b));
    expect(logsQ(m.pivots)).toBe('{env="prod",service_name="checkout"}');
    const logs = pivot(m.pivots, 'logs');
    expect(logs?.context.some((l) => l.includes('conflicts'))).toBe(false);
    expect(logs?.context.some((l) => l.includes('Not carried yet: baseline'))).toBe(true);
    const explore = pivot(m.pivots, 'explore');
    const u = new URL(explore?.href ?? '', 'http://x');
    expect(u.searchParams.has('f')).toBe(false);
    expect(explore?.context).toEqual([
      'Carried: time · Not carried yet: baseline',
      'Filters not applied in Explore yet: env, instance, job',
    ]);
  });

  it('C2: every Context member but the time a pivot sets is carried', () => {
    const search = { from: 'now-6h', to: 'now-5m', refresh: '1m' } as const;
    const m = inspectorModel(pRequest(), pEnv([], { ctx: { search, filters: [] } }));
    const explore = new URL(pivot(m.pivots, 'explore')?.href ?? '', 'http://x').searchParams;
    const logs = new URL(pivot(m.pivots, 'logs')?.href ?? '', 'http://x').searchParams;
    expect([explore.get('from'), explore.get('to'), explore.get('refresh')]).toEqual([
      'now-6h',
      'now-5m',
      '1m',
    ]);
    expect(logs.get('refresh')).toBe('off');
    const others = Object.keys(DEFAULT_CONTEXT).filter(
      (k) => k !== 'from' && k !== 'to' && k !== 'refresh',
    );
    for (const k of others) {
      const v = (search as Readonly<Record<string, string>>)[k];
      expect(explore.get(k), k).toBe(v);
      expect(logs.get(k), k).toBe(v);
    }
    expect(P_LABELS.job).toBe('shop/checkout');
  });
});

describe('unit:inspector-model (mark)', () => {
  const K = fkey(3);
  const W = { fromMs: Date.UTC(2026, 10, 19, 12), toMs: Date.UTC(2026, 10, 19, 13) };
  const RATE = { kind: 'suffix', suffix: '/s' } as const;
  const target: Extract<InspectorTarget, { type: 'mark' }> = {
    type: 'mark',
    target: {
      panelId: 'p1',
      kind: 'barchart',
      title: 'Requests by version',
      mark: {
        key: K,
        labels: { version: '2.31' },
        name: '2.31',
        value: 120,
        state: 'failing',
        baseline: 60,
        anomaly: null,
      },
      members: null,
      unit: RATE,
      window: W,
      query: { lang: 'promql', text: 'sum by (version) (rate(x[5m]))' },
    },
  };
  const origin = { ...P_ORIGIN, title: 'Requests by version', window: W, unit: RATE };

  it('a bar: value, baseline, state, key and the reduced window; no instant', () => {
    const m = inspectorModel(pRequest({ origin, target }), pEnv());
    expect(m.subheading).toBe('');
    expect(m.primary).toBe(formatValue(120, RATE));
    expect(m.primaryState).toBe('failing');
    expect(factLines(m)).toEqual([
      'Raw 120',
      `Baseline ${formatValue(60, RATE)}`,
      'State Failing',
      `Series key ${K}`,
      'Reduced over 12:00:00.000 – 13:00:00.000',
    ]);
    expect(m.labels).toEqual([['version', '2.31']]);
    expect(m.members).toBeNull();
    expect(m.announce).toBe(`Inspector: Requests by version, ${formatValue(120, RATE)}`);
    expect(m.copyValue).toBe('120');
    expect(selectionOf(target)).toEqual({ keys: [K], fromMs: null, toMs: null });
    expect(pivot(m.pivots, 'explore')?.href).toContain('vis=barchart');
    expect(pivotInstant(target)).toBeNull();
    expect(pivotWindow(target, W)).toEqual(W);
  });

  it('no baseline fact without a finite baseline; no data for a non-finite value', () => {
    const bare: InspectorTarget = {
      type: 'mark',
      target: {
        ...target.target,
        mark: { ...target.target.mark, value: NaN, baseline: null, state: null },
      },
    };
    const m = inspectorModel(pRequest({ origin, target: bare }), pEnv());
    expect(m.primary).toBe('no data');
    expect(m.primaryState).toBeNull();
    expect(m.facts.map((f) => f.label)).toEqual(['Raw', 'Series key', 'Reduced over']);
  });
});

describe('unit:geo-inspect (T24 §4.13, T25 §4.9; plan #234 Part 3 §4.5)', () => {
  const ORIGIN = { ...P_ORIGIN, title: 'Latency map', unit: { kind: 'time', base: 'ms' } as const };
  const g = frameOf(G(), { th: TH });
  const geo = (t: GeoInspectorTarget): InspectorTarget => ({ type: 'geo', target: t });
  const req = (t: GeoInspectorTarget) =>
    pRequest({ origin: ORIGIN, target: geo(t), selection: selectionOf(geo(t)) });
  const marker = (key: string, f: GeoFrame = g) =>
    geoTarget(f, f.seq, { kind: 'marker', id: key, keys: [key] });

  it('cluster:k03: Cluster of 5 near Mons, worst degraded, the five rows, values 75 ms – 210 ms', () => {
    const t = geoTarget(g, g.seq, {
      kind: 'cluster',
      id: 'cluster:k03',
      keys: ['k01', 'k02', 'k03', 'k04', 'k08'],
    });
    const m = inspectorModel(req(t), pEnv());
    expect(m.heading).toBe('Cluster of 5');
    expect(m.subheading).toBe('near Mons');
    expect(fact(m, 'Worst state')).toBe('Degraded');
    expect(fact(m, 'Values')).toBe('75 ms – 210 ms');
    expect(m.members?.texts.count).toBe(5);
    expect(m.members?.texts.shown).toEqual(t.rows.map((r) => r.name));
    expect(m.members?.texts.labels).toEqual(t.rows.map((r) => r.labels));
    expect(m.members?.runs).toBeNull();
    expect(m.members?.resolve).toBeNull();
    expect(m.pivots).toEqual([]);
    expect(m.announce).toBe('Inspector: Cluster of 5, near Mons, worst degraded');
  });

  it('a marker: k01 with its place, value, facts and the mark pivots (f=env=prod)', () => {
    const m = inspectorModel(req(marker('k01')), pEnv([{ key: 'env', value: 'prod' }]));
    expect(m.heading).toBe('{cloud_region="eu-west-1"}');
    expect(m.subheading).toBe('Dublin');
    expect(m.primary).toBe('120 ms');
    expect(m.primaryState).toBeNull();
    expect(fact(m, 'Value status')).toBe('OK');
    expect(fact(m, 'Location')).toBe('53.3400, -6.2500');
    expect(fact(m, 'Source')).toBe('cloud_region eu-west-1 (aws)');
    expect(fact(m, 'Group')).toBe('{cloud_region="eu-west-1"}');
    expect(fact(m, 'Draw')).toBe('On the map');
    expect(m.members).toBeNull();
    expect(pivot(m.pivots, 'explore')?.href).not.toBeNull();
    expect(pivot(m.pivots, 'explore')?.context).toContain(
      'Filters not applied in Explore yet: env',
    );
    // T25-010: the selector is the identity AND the filters, so f=env=prod alone enables Logs.
    expect(logsQ(m.pivots)).toBe('{env="prod"}');
    // With no filter, k01 has no log stream label: Logs is off.
    const bare = inspectorModel(req(marker('k01')), pEnv());
    expect(pivot(bare.pivots, 'logs')?.href).toBeNull();
    expect(pivot(bare.pivots, 'logs')?.reason).toBe(
      'No log stream label on this series (needs service_name or job)',
    );
    expect(m.announce).toBe('Inspector: {cloud_region="eu-west-1"}, 120 ms, ok');
    expect(m.copyValue).toBe('120');
    expect(pivotWindow(geo(marker('k01')), ORIGIN.window)).toEqual(ORIGIN.window);
  });

  it('the table k10: No value, invalid: coords lat, Not placed; k03 in other; k07 failing', () => {
    const k10 = inspectorModel(req(marker('k10')), pEnv());
    const values = k10.facts.map((f) => f.value);
    expect(values).toEqual(
      expect.arrayContaining(['No value', 'invalid: coords lat', 'Not placed']),
    );
    expect(k10.subheading).toBe('invalid');
    expect(fact(k10, 'Group')).toBe('{lat="91", lon="0"} (in other (11))');
    const k07 = inspectorModel(req(marker('k07')), pEnv());
    expect(k07.primary).toBe('300 ms');
    expect(k07.primaryState).toBe('failing');
    expect(k07.announce).toBe('Inspector: {lat="40.7128", lon="-74.0060"}, 300 ms, failing');
    expect(fact(k07, 'Source')).toBe('lat 40.7128, -74.006');
  });

  it('the aggregate and a group of O2; M12 resolves past 8', () => {
    const o2 = frameOf(O2(), { opts: { groupBy: 'env' } });
    const agg = geoTarget(o2, o2.seq, { kind: 'aggregate' });
    const a = inspectorModel(req(agg), pEnv());
    expect(a.heading).toBe('other (3)');
    expect(a.subheading).toBe('3 groups, 4 series');
    expect(a.facts).toEqual([]);
    expect(a.members?.texts.shown).toEqual(['"other (2)"', 'e8', 'e9']);
    expect(a.members?.texts.labels).toEqual([{ env: 'other (2)' }, { env: 'e8' }, { env: 'e9' }]);
    expect(a.pivots).toEqual([]);
    expect(a.announce).toBe('Inspector: other (3), 3 groups, 4 series');
    const grp = geoTarget(o2, o2.seq, { kind: 'group', from: agg, entry: 1 });
    const gm = inspectorModel(req(grp), pEnv());
    expect(gm.heading).toBe('e8');
    expect(gm.subheading).toBe('2 series');
    expect(fact(gm, 'Values')).toBe('9 ms – 11 ms');
    expect(gm.members?.texts.count).toBe(2);
    expect(gm.announce).toBe('Inspector: e8, 2 series');
    const m12 = frameOf(M12());
    const c = geoTarget(m12, m12.seq, {
      kind: 'cluster',
      id: 'cluster:m12',
      keys: m12.rows.map((r) => r.key),
    });
    const cm = inspectorModel(req(c), pEnv());
    expect(cm.members?.texts.shown).toHaveLength(8);
    expect(cm.members?.texts.labels).toHaveLength(8);
    expect(cm.members?.texts.count).toBe(12);
    expect(cm.members?.resolve).toEqual({ panelId: 'p1', runId: 'geo:cluster:m12' });
    expect(cm.announce).toBe('Inspector: Cluster of 12, near 10.0000, 10.0000');
    expect(resolveGeoMembers(c, 'geo:cluster:m12')?.texts).toHaveLength(12);
    expect(resolveGeoMembers(c, 'geo:cluster:m11')).toBeNull();
  });
});
