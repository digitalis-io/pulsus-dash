import { describe, expect, it } from 'vitest';
import counterRaw from '../../../wire/fixtures/json/promql-range-counter.json?raw';
import gaugeRaw from '../../../wire/fixtures/json/promql-instant-gauge.json?raw';
import scalarRaw from '../../../wire/fixtures/json/promql-instant-scalar.json?raw';
import {
  DecodeError,
  decodeInstant,
  decodeMetadata,
  decodeRange,
  decodeSeriesSet,
  decodeValue,
  decodeValues,
} from './decode';

type Json = Record<string, unknown>;

function counter(): Json {
  return JSON.parse(counterRaw) as Json;
}

function frame0(body: Json): Json {
  return (body['frames'] as Json[])[0] as Json;
}

function decodeErrorOf(f: () => unknown): DecodeError {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e;
    throw e;
  }
  throw new Error('no DecodeError');
}

describe('unit:decode-frames (T04-010, ADR-0014 §5)', () => {
  it('decodes the counter golden body onto the grid', () => {
    const r = decodeRange(counter());
    expect(r.stepMs).toBe(5000);
    expect(r.startMs).toBe(1767225600000);
    expect(r.endMs).toBe(1767229200000);
    expect(r.series).toHaveLength(2);
    for (const s of r.series) {
      expect(s.timestamps).toBeInstanceOf(Float64Array);
      expect(s.values).toBeInstanceOf(Float64Array);
      expect(s.timestamps).toHaveLength(721);
      s.timestamps.forEach((t, i) => {
        expect(t).toBe(1767225600000 + i * 5000);
      });
    }
    const v = r.series[0]?.values ?? new Float64Array(0);
    expect(v[0]).toBe(0.1);
    expect(v[1]).toBeNaN();
    expect(v[2]).toBe(Infinity);
    expect(v[3]).toBe(-Infinity);
    expect(v[4]).toBeNaN();
    expect(Object.is(v[5], -0)).toBe(true);
    expect(v[6]).toBe(5e-324);
    expect(v[7]).toBe(0.30000000000000004);
    for (let i = 8; i < 720; i++) expect(v[i]).toBeNaN();
    expect(v[720]).toBe(1e308);
    expect(r.series[0]?.key).toBe('47ad55f1f828d9ee');
    expect(r.series[0]?.labels).toEqual({ instance: 'a:9090', job: 'api' });
    expect(r.completeness).toEqual({
      truncated: false,
      warnings: [],
      infos: [],
      queryId: 'fake-counter-1',
      dataAgeMs: 30000,
      readCache: 'miss',
      readCacheThroughMs: null,
    });
  });

  it('decodes the instant golden bodies', () => {
    const g = decodeInstant(JSON.parse(gaugeRaw));
    expect(g.kind).toBe('series');
    if (g.kind !== 'series') return;
    expect(g.resultType).toBe('vector');
    expect(g.atMs).toBe(1767229200000);
    expect(g.series).toHaveLength(2);
    expect(g.series[0]?.values[0]).toBe(1.5e9);
    expect(g.series[1]?.values[0]).toBeNaN();
    expect(g.completeness.dataAgeMs).toBeNull();
    const s = decodeInstant(JSON.parse(scalarRaw));
    expect(s.kind).toBe('scalar');
    if (s.kind !== 'scalar') return;
    expect(s.scalar).toEqual({ value: Infinity, timestampMs: 1767229200000 });
  });

  it('decodes a string result', () => {
    const r = decodeInstant({
      result_type: 'string',
      at: 5,
      frames: [],
      string: { timestamp: 4, value: 'hello' },
      completeness: { truncated: false, warnings: [], infos: [] },
    });
    expect(r).toMatchObject({ kind: 'string', value: 'hello', timestampMs: 4, atMs: 5 });
  });

  it('maps value tokens', () => {
    expect(decodeValue(1.5, '/v')).toBe(1.5);
    expect(decodeValue('NaN', '/v')).toBeNaN();
    expect(decodeValue('+Inf', '/v')).toBe(Infinity);
    expect(decodeValue('-Inf', '/v')).toBe(-Infinity);
    expect(decodeValue(null, '/v')).toBeNaN();
    for (const bad of ['inf', 'Infinity', '1', true, {}, [], undefined]) {
      expect(decodeErrorOf(() => decodeValue(bad, '/v')).path).toBe('/v');
    }
  });

  it('reports the JSON pointer of the first bad element', () => {
    const short = counter();
    (frame0(short)['values'] as unknown[]).pop();
    expect(decodeErrorOf(() => decodeRange(short)).path).toBe('/frames/0/values');

    const inf = counter();
    (frame0(inf)['values'] as unknown[])[0] = 'inf';
    expect(decodeErrorOf(() => decodeRange(inf)).path).toBe('/frames/0/values/0');

    const key = counter();
    frame0(key)['key'] = 'ABC';
    expect(decodeErrorOf(() => decodeRange(key)).path).toBe('/frames/0/key');

    const order = counter();
    const ts = frame0(order)['timestamps'] as number[];
    ts[1] = (ts[0] ?? 0) - 1;
    expect(decodeErrorOf(() => decodeRange(order)).path).toBe('/frames/0/timestamps/1');

    const label = counter();
    frame0(label)['labels'] = { job: 1 };
    expect(decodeErrorOf(() => decodeRange(label)).path).toBe('/frames/0/labels/job');

    const noStep = counter();
    delete noStep['step'];
    expect(decodeErrorOf(() => decodeRange(noStep)).path).toBe('/step');

    const cache = counter();
    (cache['completeness'] as Json)['read_cache'] = 'warm';
    expect(decodeErrorOf(() => decodeRange(cache)).path).toBe('/completeness/read_cache');

    expect(decodeErrorOf(() => decodeRange(null)).path).toBe('');
    expect(decodeErrorOf(() => decodeInstant({ result_type: 'x' })).path).toBe('/result_type');
  });
});

/** The DecodeError path of `f`, or null when it does not throw one. */
function pathOf(f: () => unknown): string | null {
  try {
    f();
  } catch (e) {
    if (e instanceof DecodeError) return e.path;
    throw e;
  }
  return null;
}

describe('unit:decode-frames prom', () => {
  const C = {
    truncated: true,
    warnings: ['results truncated due to limit'],
    infos: [],
  };

  it('decodes values, series and metadata bodies', () => {
    const v = decodeValues({ values: ['a', 'b'], completeness: C });
    expect(v.values).toEqual(['a', 'b']);
    expect(v.completeness).toMatchObject({ truncated: true, queryId: null });
    expect(v.completeness.warnings).toEqual(['results truncated due to limit']);
    const s = decodeSeriesSet({
      series: [{ key: '0123456789abcdef', labels: { job: 'api' } }],
      completeness: C,
    });
    expect(s.series).toEqual([{ key: '0123456789abcdef', labels: { job: 'api' } }]);
    expect(s.completeness.truncated).toBe(true);
    const m = decodeMetadata({
      metrics: { up: [{ type: 'gauge', help: 'Target up.', unit: '' }] },
      completeness: C,
    });
    expect(m.metrics).toEqual({ up: [{ type: 'gauge', help: 'Target up.', unit: '' }] });
  });

  it('reports the JSON pointer of the first bad element', () => {
    expect(pathOf(() => decodeValues({ values: ['a', 1], completeness: C }))).toBe('/values/1');
    expect(
      pathOf(() => decodeSeriesSet({ series: [{ key: 'xyz', labels: {} }], completeness: C })),
    ).toBe('/series/0/key');
    expect(
      pathOf(() =>
        decodeMetadata({
          metrics: { up: [{ type: 'gauge', help: 1, unit: '' }] },
          completeness: C,
        }),
      ),
    ).toBe('/metrics/up/0/help');
  });
});

describe('decode planned (plan #112 §3.8)', () => {
  it('decodes planned from the regenerated goldens', () => {
    expect(decodeRange(counter()).planned).toEqual({
      query: 'sum by (job, instance) (rate(http_requests_total[5m]))',
      expanded: 'sum by (job, instance) (rate(http_requests_total[5m]))',
      bytes: 54,
      valueType: 'vector',
      rateCandidate: false,
      rateApplied: false,
      histogram: false,
      stepMs: 5000,
    });
    const gauge = decodeInstant(JSON.parse(gaugeRaw));
    expect(gauge.planned.query).toBe('node_memory_free_bytes');
    expect(gauge.planned.stepMs).toBeUndefined();
    expect(decodeInstant(JSON.parse(scalarRaw)).planned.valueType).toBe('scalar');
  });

  it('reports the pointer of a bad planned member', () => {
    const body = counter();
    (body['planned'] as Json)['bytes'] = '1';
    expect(decodeErrorOf(() => decodeRange(body)).path).toBe('/planned/bytes');
    const vt = counter();
    (vt['planned'] as Json)['value_type'] = 'histogram';
    expect(decodeErrorOf(() => decodeRange(vt)).path).toBe('/planned/value_type');
    const missing = counter();
    delete missing['planned'];
    expect(decodeErrorOf(() => decodeRange(missing)).path).toBe('/planned');
  });
});
