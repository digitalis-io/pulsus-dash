/** The completion lookup windows (plan #66 Part A §3.6). Stub: not implemented yet. */
export interface LookupWindow {
  readonly fromMs: number;
  readonly toMs: number;
}

export function minuteWindow(_w: LookupWindow): LookupWindow {
  throw new Error('not implemented');
}

export function secondWindow(_w: LookupWindow): LookupWindow {
  throw new Error('not implemented');
}
