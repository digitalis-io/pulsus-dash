import { describe, expect, it } from 'vitest';
import { UNKNOWN_SHAPE, type QueryShape } from '../editor/lang/types';
import {
  formatDuration,
  MAX_QUERY_BYTES,
  metricType,
  planRun,
  toSourceIndex,
  utf8Length,
  type MetricTypes,
  type RunPlan,
} from './plan';

const vector = (metrics: readonly string[], o: Partial<QueryShape> = {}): QueryShape => ({
  bareSelector: null,
  metrics,
  hasHistogramQuantile: false,
  valueType: 'vector',
  ...o,
});
const bare = (metric: string, from: number, to: number): QueryShape =>
  vector([metric], { bareSelector: { metric, from, to } });

const RATE = { rate: true, stepMs: 5000 };
const NO_RATE = { rate: false, stepMs: 5000 };
const counter: MetricTypes = { requests: [{ type: 'counter' }] };
const gauge: MetricTypes = { node_memory_free_bytes: [{ type: 'gauge' }] };

type Row = [
  n: number,
  text: string,
  shape: QueryShape,
  meta: MetricTypes,
  o: { rate: boolean; stepMs: number | null },
  want: [
    kind: RunPlan['kind'],
    query: string | null,
    candidate: boolean,
    applied: boolean,
    histogram: boolean,
    sourceStart: number,
    sourceEnd: number,
    sentStart: number,
  ],
];

const HQ = 'histogram_quantile(0.9, sum by (le) (rate(h_bucket[5m])))';
const ROWS: Row[] = [
  [
    1,
    'http_requests_total',
    bare('http_requests_total', 0, 19),
    {},
    RATE,
    ['range', 'rate(http_requests_total[20s])', true, true, false, 0, 19, 5],
  ],
  [
    2,
    'http_requests_total',
    bare('http_requests_total', 0, 19),
    {},
    NO_RATE,
    ['range', 'http_requests_total', true, false, false, 0, 19, 0],
  ],
  [
    3,
    'requests{job="a"}',
    bare('requests', 0, 17),
    counter,
    RATE,
    ['range', 'rate(requests{job="a"}[20s])', true, true, false, 0, 17, 5],
  ],
  [
    4,
    'node_memory_free_bytes',
    bare('node_memory_free_bytes', 0, 22),
    gauge,
    RATE,
    ['range', 'node_memory_free_bytes', false, false, false, 0, 22, 0],
  ],
  [
    5,
    'rate(x_total[5m])',
    vector(['x_total']),
    {},
    RATE,
    ['range', null, false, false, false, 0, 17, 0],
  ],
  [
    6,
    'http_request_duration_seconds_bucket',
    bare('http_request_duration_seconds_bucket', 0, 36),
    {},
    RATE,
    [
      'range',
      'sum by (le) (rate(http_request_duration_seconds_bucket[20s]))',
      true,
      true,
      true,
      0,
      36,
      18,
    ],
  ],
  [
    7,
    'http_request_duration_seconds_bucket',
    bare('http_request_duration_seconds_bucket', 0, 36),
    {},
    NO_RATE,
    ['range', null, true, false, false, 0, 36, 0],
  ],
  [
    8,
    'sum by (le) (rate(h_bucket[5m]))',
    vector(['h_bucket']),
    {},
    RATE,
    ['range', null, false, false, true, 0, 32, 0],
  ],
  [
    9,
    HQ,
    vector(['h_bucket'], { hasHistogramQuantile: true }),
    {},
    RATE,
    ['range', null, false, false, false, 0, 57, 0],
  ],
  [
    10,
    'scalar(vector(1)) / 0',
    vector([], { valueType: 'scalar' }),
    {},
    RATE,
    ['instant', null, false, false, false, 0, 21, 0],
  ],
  [
    11,
    '"str"',
    vector([], { valueType: 'string' }),
    {},
    RATE,
    ['instant', null, false, false, false, 0, 5, 0],
  ],
  [12, 'up{', UNKNOWN_SHAPE, {}, RATE, ['range', 'up{', false, false, false, 0, 3, 0]],
  [
    13,
    'http_requests_total',
    bare('http_requests_total', 0, 19),
    {},
    { rate: true, stepMs: null },
    ['range', 'http_requests_total', true, false, false, 0, 19, 0],
  ],
];

describe('unit:explore-plan', () => {
  it.each(ROWS)('row %i: %s', (_n, text, shape, meta, o, want) => {
    const [kind, query, rateCandidate, rateApplied, histogram, sourceStart, sourceEnd, sentStart] =
      want;
    const sent = query ?? text;
    const expected: RunPlan = {
      kind,
      query: sent,
      bytes: utf8Length(sent),
      tooLong: false,
      rateCandidate,
      rateApplied,
      histogram,
      sourceStart,
      sourceEnd,
      sentStart,
    };
    expect(planRun(text, shape, meta, o)).toEqual(expected);
    expect(expected.bytes).toBe(sent.length);
  });

  const sized = (metric: string, text: string) =>
    vector([metric], { bareSelector: { metric, from: 0, to: text.length } });
  it.each([
    ['x_total', `x_total{a="${'b'.repeat(65_512)}"}`, RATE, 65_536, false],
    ['x_total', `x_total{a="${'b'.repeat(65_513)}"}`, RATE, 65_537, true],
    ['h_bucket', `h_bucket{a="${'b'.repeat(65_497)}"}`, RATE, 65_536, false],
    ['h_bucket', `h_bucket{a="${'b'.repeat(65_498)}"}`, RATE, 65_537, true],
    ['x_total', `x_total{a="${'é'.repeat(32_756)}"}`, RATE, 65_536, false],
    ['x_total', `x_total{a="${'é'.repeat(32_757)}"}`, RATE, 65_538, true],
    ['x_total', `x_total{a="${'b'.repeat(65_513)}"}`, NO_RATE, 65_526, false],
  ] as const)('sent-size boundary: %s, %#', (metric, text, o, bytes, tooLong) => {
    const p = planRun(text, sized(metric, text), {}, o);
    expect([p.bytes, p.tooLong]).toEqual([bytes, tooLong]);
    expect(MAX_QUERY_BYTES).toBe(65_536);
  });

  it('metric types', () => {
    expect(metricType('http_requests_total', { http_requests_total: [{ type: 'counter' }] })).toBe(
      'counter',
    );
    expect(metricType('foo_bucket', { foo: [{ type: 'histogram' }] })).toBe('histogram');
    expect(metricType('foo_count', { foo: [{ type: 'summary' }] })).toBe('counter');
    expect(metricType('c_bucket', { c: [{ type: 'counter' }] })).toBe('counter');
    expect(metricType('bar', {})).toBe('unknown');
    expect(metricType('bar', { bar: [{ type: 'stateset' }] })).toBe('unknown');
    // isHistogram false and isCounter true: a counter's `_bucket` is rated, not bucketed.
    const p = planRun('c_bucket', bare('c_bucket', 0, 8), { c: [{ type: 'counter' }] }, RATE);
    expect([p.query, p.histogram]).toEqual(['rate(c_bucket[20s])', false]);
  });

  it('durations', () => {
    expect(
      [4000, 20000, 60000, 240000, 3600000, 14400000, 86400000, 345600000].map(formatDuration),
    ).toEqual(['4s', '20s', '1m', '4m', '1h', '4h', '1d', '4d']);
  });

  it('source index', () => {
    const p = planRun('requests{job="a"}', bare('requests', 0, 17), counter, RATE);
    expect([5, 21, 22, 23, 0].map((i) => toSourceIndex(p, i))).toEqual([0, 16, 17, null, null]);
    const id = planRun('up', bare('up', 0, 2), {}, RATE);
    expect([0, 2, 3].map((i) => toSourceIndex(id, i))).toEqual([0, 2, null]);
  });

  it('byte length', () => {
    expect(['é'.repeat(32768), 'a'.repeat(65536), '😀', '\uD800'].map(utf8Length)).toEqual([
      65536, 65536, 4, 3,
    ]);
  });
});
