/**
 * The board's time on first open (plan #64 §3.12, §4.6, A.8; IA-002, IA-022): a link without a
 * time opens on the saved board time (or the default), and a board link applies the saved time over
 * the URL's. `boardTimeInit` is the one navigation the first-open effect makes; `isTimeReady` says
 * when the URL holds the target, which opens the board's time gate (no panel plans before it).
 */
import type { TimeRangeSpec } from '../api/types';
import { contextReducer } from '../state/contextReducer';
import {
  contextSearchString,
  normalisedSearch,
  readContextSearch,
  type ContextSearch,
} from '../state/contextSearch';

export interface TimeInit {
  /** The full search to navigate to (formatted as `normalisedSearch` does). */
  readonly search: string;
  /** The Context strings it carries. */
  readonly from: string;
  readonly to: string;
  /** `from` or `to` differ from the URL's parsed values. */
  readonly tick: boolean;
}

export type TimeTarget = TimeInit | 'url';

/** Pure. The one navigation the first-open effect makes, or null when the URL's time stands. */
export function boardTimeInit(a: {
  readonly search: string;
  readonly linkState: boolean;
  readonly saved: TimeRangeSpec | undefined;
  readonly nowMs: number;
  readonly timeZone: string;
}): TimeInit | null {
  const env = { nowMs: a.nowMs, timeZone: a.timeZone };
  const params = new URLSearchParams(a.search);
  const { search: parsed, rest } = readContextSearch(params, env);
  const withSaved = (saved: TimeRangeSpec): TimeInit => {
    // A saved time the reducer rejects leaves the parsed (or default) window as the target.
    const next = contextReducer(parsed, { type: 'setRange', from: saved.from, to: saved.to }, env);
    return {
      search: contextSearchString(next, rest),
      from: next.from,
      to: next.to,
      tick: next.from !== parsed.from || next.to !== parsed.to,
    };
  };
  if (!params.has('from') && !params.has('to')) {
    if (a.saved !== undefined) return withSaved(a.saved); // I1
    const n = normalisedSearch(a.search, env) ?? contextSearchString(parsed, rest); // I2
    const s = readContextSearch(new URLSearchParams(n), env).search;
    return { search: n, from: s.from, to: s.to, tick: false };
  }
  if (a.linkState && a.saved !== undefined) {
    const r = withSaved(a.saved); // I3
    return r.from === parsed.from && r.to === parsed.to ? null : r;
  }
  return null; // I4
}

/** The URL holds `from` and `to`, and they are the target's (always true for 'url'). */
export function isTimeReady(
  t: TimeTarget | undefined,
  params: URLSearchParams,
  search: ContextSearch,
): boolean {
  if (t === undefined) return false;
  if (t === 'url') return true;
  return params.has('from') && params.has('to') && search.from === t.from && search.to === t.to;
}
