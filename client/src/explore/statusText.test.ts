import { describe, expect, it } from 'vitest';
import { ApiError, type ApiErrorKind } from '../api/types';
import { promql } from '../editor/lang/promql/promql';
import { EMPTY_COMPLETENESS, fixture } from '../test/histogramFixtures';
import type { ExploreResult } from '../vis/autovis';
import { planRun } from './plan';
import { errorView, outcomeText, refusalText } from './statusText';
import type { RunOutcome } from './useExploreRun';

const plan = planRun('up', promql.shape('up'), {}, { rate: true, stepMs: 5000 });
const outcome = (result: ExploreResult): RunOutcome => ({
  text: 'up',
  plan,
  result,
  durationMs: 120,
});
const two = fixture([
  { labels: { job: 'a' }, values: [1, 2] },
  { labels: { job: 'b' }, values: [3, 4] },
]);

describe('statusText', () => {
  it.each([
    ['tooBroad', 'too many series', { text: 'too many series', narrow: true }],
    [
      'timeout',
      'x',
      { text: 'The query timed out. Narrow the time range or the query.', narrow: true },
    ],
    [
      'busy',
      'x',
      {
        text: 'Too many queries are running for this tenant. Try again in a moment.',
        narrow: false,
      },
    ],
    ['unavailable', 'down', { text: 'PulsusDB is unavailable: down', narrow: false }],
    ['network', 'x', { text: 'The server could not be reached.', narrow: false }],
    ['notFound', 'x', { text: 'This tenant no longer exists.', narrow: false }],
    ['badResponse', 'bad body', { text: 'The query failed: bad body', narrow: false }],
    ['unknown', 'odd', { text: 'The query failed: odd', narrow: false }],
  ] as [ApiErrorKind, string, unknown][])('%s', (kind, message, view) => {
    expect(errorView(new ApiError(kind, message), [])).toEqual(view);
  });

  it('queryInvalid takes the diagnostic, else the message', () => {
    const e = new ApiError('queryInvalid', 'bad', { detail: { position: 1 } });
    expect(
      errorView(e, [{ from: 0, to: 1, message: 'bad (position unknown)', positionKnown: false }]),
    ).toEqual({ text: 'bad (position unknown)', narrow: false });
    expect(errorView(e, [])).toEqual({ text: 'bad', narrow: false });
  });

  it('any other error is unknown; null and AbortError are not shown', () => {
    expect(errorView(new Error('boom'), [])).toEqual({
      text: 'The query failed: boom',
      narrow: false,
    });
    expect(errorView(null, [])).toBeNull();
    expect(errorView(new DOMException('aborted', 'AbortError'), [])).toBeNull();
  });

  it('outcome texts', () => {
    expect(
      outcomeText(
        outcome({
          kind: 'series',
          source: 'range',
          series: two,
          stepMs: 5000,
          completeness: EMPTY_COMPLETENESS,
        }),
      ),
    ).toBe('2 series · step 5 s · 120 ms');
    expect(
      outcomeText(
        outcome({
          kind: 'series',
          source: 'instant',
          series: two.slice(0, 1),
          stepMs: null,
          completeness: EMPTY_COMPLETENESS,
        }),
      ),
    ).toBe('1 series · 120 ms');
    expect(
      outcomeText(
        outcome({
          kind: 'scalar',
          scalar: { value: 1, timestampMs: 0 },
          completeness: EMPTY_COMPLETENESS,
        }),
      ),
    ).toBe('Scalar · 120 ms');
    expect(
      outcomeText(outcome({ kind: 'string', value: 'x', completeness: EMPTY_COMPLETENESS })),
    ).toBe('String · 120 ms');
  });

  it('refusal texts', () => {
    expect(refusalText('queryTooLarge')).toBe(
      'This query is over 128 KB. Completion is paused, and it cannot be run until it is shorter.',
    );
    expect(refusalText('tooLong')).toBe(
      'The query to send, with any rate applied, is over 64 KiB, the most the server accepts. Shorten it.',
    );
  });
});
