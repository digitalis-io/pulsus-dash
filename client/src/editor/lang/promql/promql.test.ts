import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../api/types';
import { UNKNOWN_SHAPE, type QueryShape, type ValueType } from '../types';
import { analysePromQL, diagnosticsOf, utf8ToIndex } from './promql';

type Bare = QueryShape['bareSelector'];
const B = (metric: string, from: number, to: number): Bare => ({ metric, from, to });
const S = (
  bareSelector: Bare,
  metrics: string[],
  hasHistogramQuantile: boolean,
  valueType: ValueType,
): QueryShape => ({ bareSelector, metrics, hasHistogramQuantile, valueType });

// B.4.1 of plan #63 Part B.
const SHAPES: [number, string, QueryShape][] = [
  [
    1,
    'http_requests_total',
    S(B('http_requests_total', 0, 19), ['http_requests_total'], false, 'vector'),
  ],
  [
    2,
    'http_requests_total{job="a"}',
    S(B('http_requests_total', 0, 28), ['http_requests_total'], false, 'vector'),
  ],
  [3, ' up ', S(B('up', 1, 3), ['up'], false, 'vector')],
  [4, 'up # c', S(B('up', 0, 2), ['up'], false, 'vector')],
  [5, '# c\nup', S(B('up', 4, 6), ['up'], false, 'vector')],
  [6, '{job="a"}', S(null, [], false, 'vector')],
  [7, '(up)', S(null, ['up'], false, 'vector')],
  [8, 'rate(x[5m])', S(null, ['x'], false, 'vector')],
  [9, 'x[5m]', S(null, ['x'], false, 'matrix')],
  [10, 'x[5m:1m]', S(null, ['x'], false, 'matrix')],
  [11, 'x offset 5m', S(null, ['x'], false, 'vector')],
  [12, 'x[5m] offset 1m', S(null, ['x'], false, 'matrix')],
  [13, 'up + up', S(null, ['up'], false, 'vector')],
  [14, 'x and y', S(null, ['x', 'y'], false, 'vector')],
  [15, 'scalar(vector(1)) / 0', S(null, [], false, 'scalar')],
  [16, '1 + 2', S(null, [], false, 'scalar')],
  [17, '-1', S(null, [], false, 'scalar')],
  [18, 'time()', S(null, [], false, 'scalar')],
  [19, '"str"', S(null, [], false, 'string')],
  [
    20,
    'histogram_quantile(0.9, sum by (le) (rate(h_bucket[5m])))',
    S(null, ['h_bucket'], true, 'vector'),
  ],
];

describe('unit:promql-shape', () => {
  for (const [n, text, shape] of SHAPES) {
    it(`row ${String(n)}: ${JSON.stringify(text)}`, () => {
      expect(analysePromQL(text)).toEqual(shape);
    });
  }
  for (const [n, text] of [
    [21, 'up{'],
    [22, ''],
    [23, 'sum(up'],
  ] as const) {
    it(`row ${String(n)}: ${JSON.stringify(text)} is UNKNOWN_SHAPE`, () => {
      expect(analysePromQL(text)).toBe(UNKNOWN_SHAPE);
    });
  }
});

describe('unit:promql-diagnostics bytes', () => {
  it('maps UTF-8 bytes to UTF-16 indices of code points', () => {
    const s = 'aé😀';
    const rows: [number, number | null][] = [
      [0, 0],
      [1, 1],
      [2, 1],
      [3, 2],
      [6, 2],
      [7, 4],
      [8, null],
      [-1, null],
      [1.5, null],
    ];
    expect(rows.map(([b]) => utf8ToIndex(s, b))).toEqual(rows.map(([, i]) => i));
    const lone = '\uD800x';
    expect([0, 2, 3, 4].map((b) => utf8ToIndex(lone, b))).toEqual([0, 0, 1, 2]);
  });
});

const Q = 'rate(http_server_duration_bucket{service="checkout"[5m])';
const E = (m: string, p?: number) =>
  new ApiError('queryInvalid', m, p === undefined ? {} : { detail: { position: p } });
const id = (i: number) => i;
const D = (from: number, to: number, message: string, positionKnown: boolean) => ({
  from,
  to,
  message,
  positionKnown,
});

describe('unit:promql-diagnostics positions', () => {
  const D1 = '1:52: parse error: unexpected "[" in label matching, expected string';
  const rows: [string, string, unknown, ReturnType<typeof D>[]][] = [
    ['D1', Q, E(D1, 51), [D(51, 52, D1, true)]],
    ['D2', 'up{', E('m', 3), [D(2, 3, 'm', true)]],
    ['D3', 'é{', E('m', 2), [D(1, 2, 'm', true)]],
    ['D4', 'é{', E('m', 1), [D(0, 1, 'm', true)]],
    ['D5', 'x😀', E('m', 1), [D(1, 3, 'm', true)]],
    ['D6', 'x😀', E('m', 5), [D(1, 3, 'm', true)]],
    ['D7', 'up{', E('m'), [D(0, 3, 'm (position unknown)', false)]],
    ['D8', 'up{', E('m', 99), [D(0, 3, 'm (position unknown)', false)]],
    ['D9 timeout', 'up{', new ApiError('timeout', 'm'), []],
    ['D9 Error', 'up{', new Error('m'), []],
    ['D9 empty', '', E('m', 0), []],
  ];
  for (const [name, text, error, expected] of rows) {
    it(name, () => {
      expect(Q).toHaveLength(56);
      expect(diagnosticsOf(text, error, id, text)).toEqual(expected);
    });
  }
});

describe('unit:promql-diagnostics identity', () => {
  it('a position arrives in raw bytes: the identity mapping places it (plan #112, T09-009)', () => {
    const text = 'x_total{job="a"}';
    expect(
      diagnosticsOf(
        text,
        new ApiError('queryInvalid', 'm', { detail: { position: 14 } }),
        (i) => i,
        text,
      ),
    ).toEqual([D(14, 15, 'm', true)]);
  });
});
