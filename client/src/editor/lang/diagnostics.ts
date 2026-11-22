/**
 * The run diagnostics shared by the query languages (plan #66 Part A §3.8, moved from
 * `promql.ts`; T09-009, ADR-0021 §3): the server reports a `queryInvalid` position as a UTF-8 byte
 * offset into the raw text, which becomes an underline at the code point holding that byte. Every
 * caller passes `toSource = (i) => i` and `sent = text`; `planned.query` never places an underline.
 */
import { isApiError } from '../../api/types';
import { t } from '../../i18n/t';
import type { Diagnostic } from './types';

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

function utf8Width(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) return 3; // lone surrogates too, as Part A's utf8Length
  return 4;
}

/**
 * UTF-16 index of the code point holding UTF-8 byte `byte` of `s`; `s.length` when `byte` is the
 * byte length; null when `byte` is not an integer, negative or past the end.
 */
export function utf8ToIndex(s: string, byte: number): number | null {
  if (!Number.isInteger(byte) || byte < 0) return null;
  let b = 0;
  let i = 0;
  while (i < s.length) {
    const cp = s.codePointAt(i) ?? 0;
    const n = utf8Width(cp);
    if (byte < b + n) return i;
    b += n;
    i += cp > 0xffff ? 2 : 1;
  }
  return byte === b ? s.length : null;
}

/** The start index of the last code point of a non-empty `s`. */
function lastCodePoint(s: string): number {
  const k = s.length - 1;
  return k > 0 && isLow(s.charCodeAt(k)) && isHigh(s.charCodeAt(k - 1)) ? k - 1 : k;
}

/**
 * The underline of a failed run (T09-009): PulsusDB's byte offset into `sent`, mapped to `text`
 * through `toSource`; the whole text, marked "position unknown", when there is no position, it is
 * out of range or inside text the planner added. Only `queryInvalid` errors place anything.
 */
export function positionDiagnostics(
  text: string,
  error: unknown,
  toSource: (sentIndex: number) => number | null,
  sent: string,
): Diagnostic[] {
  if (!isApiError(error, 'queryInvalid') || text === '') return [];
  const p = error.detail.position;
  const i = typeof p === 'number' ? utf8ToIndex(sent, p) : null;
  const j = i === null ? null : toSource(i);
  if (j !== null && j >= 0) {
    const from = j < text.length ? j : lastCodePoint(text);
    const pair = isHigh(text.charCodeAt(from)) && isLow(text.charCodeAt(from + 1));
    return [{ from, to: from + (pair ? 2 : 1), message: error.message, positionKnown: true }];
  }
  return [
    {
      from: 0,
      to: text.length,
      message: error.message + t('explore.error.positionUnknown'),
      positionKnown: false,
    },
  ];
}
