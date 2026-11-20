export interface TimeTick {
  readonly ms: number;
  readonly x: number;
  readonly label: string;
  readonly major: boolean;
}

export const SUB_DAY_STEPS_S: readonly number[] = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200,
];
export const DAY_STEPS: readonly number[] = [1, 2, 7, 14];

export function timeTicks(_a: {
  fromMs: number;
  toMs: number;
  widthPx: number;
  timeZone: string;
  measure: (s: string) => number;
  minGapPx: number;
}): TimeTick[] {
  throw new Error('not implemented');
}
