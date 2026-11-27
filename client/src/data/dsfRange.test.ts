/**
 * `rangeFromDecoded` and `errorFromRow` (plan #68 D2 §3.4, §5): the engine's decoded message of each
 * D1 route fixture (`engine/fixtures/range-decoded/`, every f64 as its hex bits) assembles into the
 * `RangeResult` the JSON path decodes from the same request's JSON body; an `error/1` row rebuilds
 * the `ApiError` the JSON path gives the same class's envelope before the header.
 */
import createClient from 'openapi-fetch';
import { describe, expect, it } from 'vitest';
import type { paths } from '../api/gen/schema';
import { HttpApi } from '../api/HttpApi';
import type { DecodedRange } from '../api/rangeDecoder';
import { ApiError } from '../api/types';
import { errorView } from '../explore/statusText';
import { decodeRange } from './decode';
import { errorFromRow, rangeFromDecoded } from './dsfRange';
import { decodedMessage, failedMessage, NOW_MS, routeJson } from '../test/dsfFixtures';

const PAIRS = [
  'two-series',
  'gaps',
  'empty',
  'types-warning',
  'read-cache',
  'future-sample',
  'many',
] as const;
const CLASSES = [
  'query-invalid',
  'too-broad',
  'rate-limited',
  'timeout',
  'unavailable',
  'internal',
] as const;

const bits = (a: Float64Array): string[] =>
  Array.from(a, (x) => {
    if (Number.isNaN(x)) return 'NaN';
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, x);
    return dv.getBigUint64(0).toString(16);
  });

describe('range from decoded (plan #68 D2 §3.4)', () => {
  for (const name of PAIRS) {
    it(`range from decoded: ${name} equals the JSON path's result`, () => {
      const want = decodeRange(JSON.parse(routeJson(name)));
      const got = rangeFromDecoded(decodedMessage(name), NOW_MS);
      expect(got).toEqual(want);
      // f64 by bits (NaN by class), and one shared timestamps array.
      expect(got.series.length).toBe(want.series.length);
      got.series.forEach((s, i) => {
        const w = want.series[i];
        expect(bits(s.values)).toEqual(bits(w?.values ?? new Float64Array()));
        expect(bits(s.timestamps)).toEqual(bits(w?.timestamps ?? new Float64Array()));
        expect(s.timestamps).toBe(got.series[0]?.timestamps);
      });
    });
  }

  it('range from decoded: limits-many is truncated, the coverage reason in warnings', () => {
    const got = rangeFromDecoded(decodedMessage('limits-many'), NOW_MS);
    expect(got.completeness.truncated).toBe(true);
    expect(got.completeness.warnings).toContain('wire_limit');
    expect(got.series.length).toBeGreaterThan(0);
    expect(got.series.length).toBeLessThan(600);
  });
});

/** The `ApiError` the JSON path gives an envelope fixture (`err-<class>.json`), before the header. */
async function jsonError(file: string): Promise<ApiError> {
  const f = JSON.parse(routeJson(file)) as {
    status: number;
    retry_after: string | null;
    body: unknown;
  };
  const client = createClient<paths>({
    baseUrl: 'http://localhost',
    fetch: () =>
      Promise.resolve(
        new Response(JSON.stringify(f.body), {
          status: f.status,
          headers: {
            'Content-Type': 'application/json',
            ...(f.retry_after === null ? {} : { 'Retry-After': f.retry_after }),
          },
        }),
      ),
  });
  try {
    await new HttpApi(client).queryRange('demo', {
      query: 'x_total{job="a"}',
      fromMs: 1,
      toMs: 2,
      widthPx: 60,
    });
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('no error');
}

/** What an `ApiError` exposes (plan §3.4): no `ApiError` member carries a retry. */
const exposed = (e: ApiError) => ({
  kind: e.kind,
  message: e.message,
  fields: e.fields,
  position: e.detail.position,
  action: e.detail.hint?.['action'],
  queryId: e.detail.queryId,
  planned: e.detail.planned,
});

describe('error from row (plan #68 D2 §3.4)', () => {
  for (const c of CLASSES) {
    it(`error from row: ${c} equals the pre-header envelope's error`, async () => {
      const m = failedMessage(`mid-failure-${c}`);
      const got = errorFromRow(m.row, m.coverage, m.planned);
      const want = await jsonError(`err-${c}`);
      expect(got).toBeInstanceOf(ApiError);
      expect(exposed(got)).toEqual(exposed(want));
    });
  }

  it('error from row: query-invalid keeps the /query field and the position', () => {
    const m = failedMessage('mid-failure-query-invalid');
    const e = errorFromRow(m.row, m.coverage, m.planned);
    expect(e.kind).toBe('queryInvalid');
    expect(e.detail.position).toBe(7);
    expect(e.detail.queryId).toBe('fake-route-1');
  });

  it('error from row: the stream-level refusal is of class internal', () => {
    const m = failedMessage('refused-open-parts');
    const e = errorFromRow(m.row, m.coverage, m.planned);
    expect(m.row.code).toBe(8);
    expect(e.kind).toBe('unknown');
    expect(e.message).toBe('writer refused');
  });

  it('error from row: virtual stays the JSON envelope path, with its field and hint', async () => {
    const e = await jsonError('err-virtual');
    expect(e.kind).toBe('queryInvalid');
    expect(e.detail.hint).toEqual({ reserved: 'ALERTS' });
  });
});

describe('invalid planned (plan #68 D2 §3.4, r8)', () => {
  const base = () => decodedMessage('two-series');
  const planned = (p: string | null): DecodedRange => {
    const m = base();
    return { ...m, head: { ...m.head, planned: p } };
  };
  const validPlanned = (): Record<string, unknown> =>
    JSON.parse(base().head.planned ?? '{}') as Record<string, unknown>;

  for (const [what, p] of [
    ['missing', null],
    ['malformed', '{'],
    ['rejected', JSON.stringify({ ...validPlanned(), value_type: 7 })],
  ] as const) {
    it(`invalid planned: ${what} dash.planned is a DecodeError`, () => {
      expect(() => rangeFromDecoded(planned(p), NOW_MS)).toThrow();
    });
  }

  it('invalid planned: an internal ApiError renders the generic unknown text', () => {
    const v = errorView(new ApiError('internal', 'bad body'), []);
    expect(v?.text).toBe('The query failed: bad body');
  });
});

describe('absent masks from the validity bitmap (#304 §A.3)', () => {
  it('absent masks: the decoded message carries them and gaps equals the JSON path', () => {
    const m = decodedMessage('gaps');
    expect(m.absent).toBeDefined();
    const got = rangeFromDecoded(m, NOW_MS);
    const want = decodeRange(JSON.parse(routeJson('gaps')));
    expect(want.absent).toBeDefined();
    expect(got.absent).toEqual(want.absent);
  });

  it('absent masks: a message without absent slots has none', () => {
    const m: DecodedRange = { ...decodedMessage('two-series'), absent: [null, null] };
    expect(rangeFromDecoded(m, NOW_MS).absent).toBeUndefined();
  });
});
