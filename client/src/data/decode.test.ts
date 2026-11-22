import { describe, expect, it } from 'vitest';
import counterRaw from '../../../wire/fixtures/json/promql-range-counter.json?raw';
import gaugeRaw from '../../../wire/fixtures/json/promql-instant-gauge.json?raw';
import scalarRaw from '../../../wire/fixtures/json/promql-instant-scalar.json?raw';
import {
  DecodeError,
  decodeInstant,
  decodeLogs,
  decodeMetadata,
  decodeRange,
  decodeSeriesSet,
  decodeValue,
  decodeValues,
  decodeVolume,
  type LogsResult,
} from './decode';
import { keyHash } from '../dev/keyHash';
import { LOG_LEVELS } from './logFrame';

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
      planned: {
        query: '"hello"',
        expanded: '"hello"',
        bytes: 7,
        value_type: 'string',
        rate_candidate: false,
        rate_applied: false,
        histogram: false,
      },
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

/** The log goldens of plan #65 Part B B.3 (written by the BFF's `unit:logql-golden`). */
const LOG_GOLDENS = import.meta.glob<string>('../../../wire/fixtures/json/logql-*.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});

function logGolden(name: string): Json {
  const raw = LOG_GOLDENS[`../../../wire/fixtures/json/${name}`];
  expect(raw, `golden ${name}`).toBeTypeOf('string');
  return JSON.parse(raw ?? '{}') as Json;
}

interface WireEntry {
  ts_ns: string;
  line: string;
  level: string;
}
interface WireStream {
  key: string;
  labels: Record<string, string>;
  entries: WireEntry[];
}

/** A one-entry streams body to mutate. */
function streamsBody(): Json {
  return {
    kind: 'streams',
    start: 1767225600000,
    end: 1767229200000,
    step: 5000,
    direction: 'backward',
    streams: [
      {
        key: '0123456789abcdef',
        labels: { app: 'x', pod: 'a' },
        entries: [{ ts_ns: '1767229100000000500', line: 'a5', level: 'info' }],
      },
    ],
    completeness: { truncated: false, warnings: [], infos: [] },
  };
}

function streamsOf(b: Json): WireStream[] {
  return b['streams'] as WireStream[];
}

function streamsResult(r: LogsResult): Extract<LogsResult, { kind: 'streams' }> {
  expect(r.kind).toBe('streams');
  if (r.kind !== 'streams') throw new Error('not a streams result');
  return r;
}

describe('unit:decode-logs (plan #65 Part B §3.5, T04-010)', () => {
  it('keeps every timestamp exact as BigInt nanoseconds', () => {
    // A double cannot hold it: the exactness below is meaningful.
    expect(BigInt(Number('1767229100000000300')) !== 1767229100000000300n).toBe(true);
    for (const name of [
      'logql-streams-backward-1.json',
      'logql-streams-backward-2.json',
      'logql-streams-forward-1.json',
      'logql-streams-forward-2.json',
      'logql-streams-forward-3.json',
    ]) {
      const body = logGolden(name);
      const r = streamsResult(decodeLogs(body));
      expect(r.frame.tsNs).toBeInstanceOf(BigInt64Array);
      const want = streamsOf(body)
        .flatMap((s) => s.entries.map((e) => `${e.ts_ns} ${e.line}`))
        .sort();
      const got = Array.from(
        r.frame.tsNs,
        (t, i) => `${String(t)} ${r.frame.lines[i] ?? ''}`,
      ).sort();
      expect(got, name).toEqual(want);
      for (const s of streamsOf(body)) {
        for (const e of s.entries) expect(r.frame.tsNs).toContain(BigInt(e.ts_ns));
      }
    }
    const page2 = streamsResult(decodeLogs(logGolden('logql-streams-backward-2.json')));
    expect(Array.from(page2.frame.tsNs)).toEqual([
      1767229100000000300n,
      1767229100000000300n,
      1767229100000000300n,
      1767229100000000300n,
    ]);
  });

  it('merges the rows in page order and reads the levels and the cursor', () => {
    const p1 = streamsResult(decodeLogs(logGolden('logql-streams-backward-1.json')));
    expect(p1.frame.direction).toBe('backward');
    expect(p1.frame.lines).toEqual(['a5', 'b4']);
    expect(Array.from(p1.frame.tsNs)).toEqual([1767229100000000500n, 1767229100000000400n]);
    expect(typeof p1.cursor).toBe('string');
    expect(p1.fromMs).toBe(1767225600000);
    expect(p1.toMs).toBe(1767229200000);
    expect(p1.stepMs).toBe(5000);
    expect(p1.completeness.queryId).toBe('fake-logs-page-b1-1');

    const p2 = streamsResult(decodeLogs(logGolden('logql-streams-backward-2.json')));
    expect(p2.cursor).toBeNull();
    // One timestamp: rows follow the stream order, then each stream's entries.
    const idx = Array.from(p2.frame.streamIndex);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(p2.frame.streams).toHaveLength(3);
    const pods = idx.map((i) => p2.frame.streams[i]?.labels['pod']);
    const levelOf: Record<string, number> = { a: 3, b: 4, c: 5 };
    Array.from(p2.frame.levels).forEach((lv, i) => {
      expect(lv).toBe(levelOf[pods[i] ?? '']);
    });
    expect(LOG_LEVELS[3]).toBe('info');
    expect(pods.filter((p) => p === 'a')).toHaveLength(2);

    // Forward pages ascend; ties keep the stream order.
    for (const name of ['logql-streams-forward-1.json', 'logql-streams-forward-3.json']) {
      const f = streamsResult(decodeLogs(logGolden(name)));
      expect(f.frame.direction).toBe('forward');
      const ts = Array.from(f.frame.tsNs);
      for (let i = 1; i < ts.length; i++) {
        const prev = ts[i - 1] ?? 0n;
        const cur = ts[i] ?? 0n;
        expect(cur >= prev).toBe(true);
        if (cur === prev) {
          expect(f.frame.streamIndex[i] ?? 0).toBeGreaterThanOrEqual(
            f.frame.streamIndex[i - 1] ?? 0,
          );
        }
      }
    }
    expect(
      streamsResult(decodeLogs(logGolden('logql-streams-forward-3.json'))).frame.lines,
    ).toEqual(['b4', 'a5']);
  });

  it('merges streams k-way by ts, then stream, then entry', () => {
    const b = streamsBody();
    streamsOf(b)[0] = {
      key: '0000000000000001',
      labels: { pod: 'a' },
      entries: [
        { ts_ns: '1767229100000000500', line: 'a5', level: 'info' },
        { ts_ns: '1767229100000000300', line: 'a3', level: 'info' },
        { ts_ns: '1767229100000000300', line: 'a3b', level: 'info' },
      ],
    };
    streamsOf(b)[1] = {
      key: '0000000000000002',
      labels: { pod: 'b' },
      entries: [
        { ts_ns: '1767229100000000400', line: 'b4', level: 'warn' },
        { ts_ns: '1767229100000000300', line: 'b3', level: 'warn' },
      ],
    };
    const r = streamsResult(decodeLogs(b));
    expect(r.frame.lines).toEqual(['a5', 'b4', 'a3', 'a3b', 'b3']);
    expect(Array.from(r.frame.streamIndex)).toEqual([0, 1, 0, 0, 1]);
    expect(Array.from(r.frame.levels)).toEqual([3, 4, 3, 3, 4]);
  });

  it('reads structured metadata and parsed fields per row', () => {
    const p1 = streamsResult(decodeLogs(logGolden('logql-streams-backward-1.json')));
    expect(p1.frame.metadata[0]).toEqual({ detected_level: 'info' });
    expect(p1.frame.parsed[0]).toBeNull();
    expect(p1.frame.metadata[1]).toEqual({ detected_level: 'unknown' });
    expect(p1.frame.parsed[1]).toEqual({ level: 'WARNING' });
  });

  it('decodes a metric result as decodeRange does and the volume as five level frames', () => {
    const metric = logGolden('logql-metric.json');
    const r = decodeLogs(metric);
    expect(r.kind).toBe('series');
    const rest: Json = { ...metric };
    delete rest['kind'];
    expect(r).toEqual({ kind: 'series', ...decodeRange(rest) });
    const v = decodeVolume(logGolden('logql-volume.json'));
    expect(v.series.map((s) => s.labels['level'])).toEqual([
      'error',
      'warn',
      'info',
      'debug',
      'unknown',
    ]);
  });

  it('refuses bad bodies at the JSON pointer of the first bad element', () => {
    const at = (mutate: (b: Json) => void): string => {
      const b = streamsBody();
      mutate(b);
      return decodeErrorOf(() => decodeLogs(b)).path;
    };
    const entry = (b: Json): WireEntry => streamsOf(b)[0]?.entries[0] as WireEntry;
    const ts = '/streams/0/entries/0/ts_ns';
    expect(
      at((b) => {
        entry(b).ts_ns = '9223372036854775808';
      }),
    ).toBe(ts);
    expect(
      at((b) => {
        entry(b).ts_ns = '01';
      }),
    ).toBe(ts);
    expect(
      at((b) => {
        entry(b).ts_ns = '1767225600000000000';
      }),
    ).toBe(ts);
    expect(
      at((b) => {
        entry(b).ts_ns = '1767229200000000001';
      }),
    ).toBe(ts);
    expect(
      at((b) => {
        (entry(b) as unknown as Json)['ts_ns'] = 1767229100000;
      }),
    ).toBe(ts);
    expect(
      at((b) => {
        entry(b).level = 'fatal';
      }),
    ).toBe('/streams/0/entries/0/level');
    expect(
      at((b) => {
        streamsOf(b)[0]?.entries.push({ ts_ns: '1767229100000000600', line: 'up', level: 'info' });
      }),
    ).toBe('/streams/0/entries/1/ts_ns');
    expect(
      at((b) => {
        b['direction'] = 'sideways';
      }),
    ).toBe('/direction');
    expect(
      at((b) => {
        b['kind'] = 'other';
      }),
    ).toBe('/kind');
    expect(
      at((b) => {
        b['start'] = 1.5;
      }),
    ).toBe('/start');
    expect(
      at((b) => {
        b['cursor'] = '';
      }),
    ).toBe('/cursor');
    expect(
      at((b) => {
        const s = streamsOf(b)[0];
        if (s !== undefined) s.key = 'ABC';
      }),
    ).toBe('/streams/0/key');
    expect(
      at((b) => {
        (streamsOf(b)[0]?.labels as unknown as Json)['pod'] = 1;
      }),
    ).toBe('/streams/0/labels/pod');
    expect(
      at((b) => {
        (entry(b) as unknown as Json)['metadata'] = { k: 1 };
      }),
    ).toBe('/streams/0/entries/0/metadata/k');
    expect(
      at((b) => {
        b['completeness'] = {};
      }),
    ).toBe('/completeness/truncated');

    const vol = (labels: Record<string, string>): string => {
      const v = logGolden('logql-volume.json');
      const f = (v['frames'] as Json[])[0];
      if (f !== undefined) f['labels'] = labels;
      return decodeErrorOf(() => decodeVolume(v)).path;
    };
    expect(vol({ level: 'x' })).toBe('/frames/0/labels');
    expect(vol({ level: 'error', pod: 'a' })).toBe('/frames/0/labels');
    expect(vol({})).toBe('/frames/0/labels');
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

describe('planned is PromQL-only until logs.Plan (#116, T06-029 note)', () => {
  const frame = {
    key: keyHash({ level: 'error' }),
    labels: { level: 'error' },
    timestamps: [0, 1000],
    values: [1, null],
  };
  const completeness = { truncated: false, warnings: [], infos: [] };
  const grid = { start: 0, end: 1000, step: 1000, frames: [frame], completeness };

  it('decodes a LogQL series body without planned, and adds none', () => {
    const r = decodeLogs({ kind: 'series', ...grid });
    expect(r.kind).toBe('series');
    expect('planned' in r).toBe(false);
  });

  it('decodes a log volume body without planned, and adds none', () => {
    const r = decodeVolume(grid);
    expect(r.series).toHaveLength(1);
    expect('planned' in r).toBe(false);
  });

  it('still requires planned on a PromQL range body', () => {
    expect(decodeErrorOf(() => decodeRange(grid)).path).toBe('/planned');
  });
});
