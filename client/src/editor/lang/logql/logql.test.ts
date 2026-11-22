import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../api/types';
import type { LogqlPlannedQuery } from '../../../data/decode';
import { t } from '../../../i18n/t';
import { logql } from './logql';

// Appendix A.5 of plan #66 Part A: every call maps with the identity and the raw text.
const TEXT = '{app="é"} x';
const T8 = '{app="é"} xy';
const U = t('explore.error.positionUnknown');
const wrap = (q: string) =>
  `sum by (level, detected_level) (count_over_time(${q}\n| drop __error__ [5s]))`;
const LP: LogqlPlannedQuery = { query: wrap(TEXT), expanded: TEXT, bytes: 84, stepMs: 5000 };
const LP8: LogqlPlannedQuery = { query: wrap(T8), expanded: T8, bytes: 85, stepMs: 5000 };
const of = (err: unknown, text = TEXT) => logql.diagnosticsOf(text, err, (i) => i, text);
const whole = (message: string, text = TEXT) => [
  { from: 0, to: text.length, message: message + U, positionKnown: false },
];

describe('unit:logql-diagnostics', () => {
  it('fixtures', () => {
    expect(TEXT).toHaveLength(11);
    expect(new TextEncoder().encode(TEXT).length).toBe(12);
    expect(T8).toHaveLength(12);
    expect(new TextEncoder().encode(T8).length).toBe(13);
    expect(LP8.query.indexOf(T8)).toBe(48);
  });

  it('D1: a byte offset underlines its code point', () => {
    const e = new ApiError('queryInvalid', 'parse error at byte 11', { detail: { position: 11 } });
    expect(of(e)).toEqual([
      { from: 10, to: 11, message: 'parse error at byte 11', positionKnown: true },
    ]);
  });

  it('D2: no position underlines the whole query', () => {
    expect(of(new ApiError('queryInvalid', 'm'))).toEqual(whole('m'));
  });

  it('D3: a position past the end underlines the whole query', () => {
    expect(of(new ApiError('queryInvalid', 'm', { detail: { position: 13 } }))).toEqual(whole('m'));
  });

  it('D4: a variable error underlines nothing', () => {
    const e = new ApiError('invalid', 'v', {
      fields: [{ pointer: '/vars/a', messageKey: 'variable.unrepresentable' }],
    });
    expect(of(e)).toEqual([]);
  });

  it('D5: a processing cap underlines nothing', () => {
    const e = new ApiError('queryTooLong', 'l', { detail: { hint: { reason: 'processing_cap' } } });
    expect(of(e)).toEqual([]);
  });

  it('D6: a planned query too long underlines nothing', () => {
    expect(of(new ApiError('queryTooLong', 'l', { detail: { planned: LP } }))).toEqual([]);
  });

  it('D7: other errors underline nothing', () => {
    expect(of(new ApiError('timeout', 't'))).toEqual([]);
    expect(of(new Error('x'))).toEqual([]);
  });

  it('D8: the offset counts in the raw text, never in planned.query', () => {
    const e = new ApiError('queryInvalid', 'parse error at byte 11', {
      detail: { position: 11, planned: LP8 },
    });
    expect(of(e, T8)).toEqual([
      { from: 10, to: 11, message: 'parse error at byte 11', positionKnown: true },
    ]);
  });

  it('D9: an empty text underlines nothing', () => {
    const e = new ApiError('queryInvalid', 'parse error at byte 11', { detail: { position: 11 } });
    expect(of(e, '')).toEqual([]);
  });
});
