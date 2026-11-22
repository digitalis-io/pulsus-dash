/**
 * The windows of completion lookups (plan #66 Part A §3.6; T09-007): the request shapes PulsusDB
 * is tested with. Label names and values are asked over whole minutes (start floored, end ceiled,
 * one minute when they meet), PromQL series over whole seconds. Shared by the languages.
 */
export interface LookupWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

const MINUTE_MS = 60_000;
const SECOND_MS = 1_000;

function snapped(w: LookupWindow, unit: number, widen: boolean): LookupWindow {
  const fromMs = Math.floor(w.fromMs / unit) * unit;
  const toMs = Math.ceil(w.toMs / unit) * unit;
  return { fromMs, toMs: widen && toMs <= fromMs ? fromMs + unit : toMs };
}

/** Start floored and end ceiled to the minute; one minute when they meet. */
export function minuteWindow(w: LookupWindow): LookupWindow {
  return snapped(w, MINUTE_MS, true);
}

/** Start floored and end ceiled to the second, not widened. */
export function secondWindow(w: LookupWindow): LookupWindow {
  return snapped(w, SECOND_MS, false);
}
